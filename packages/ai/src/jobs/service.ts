/**
 * The Job Service — create, start, complete, fail, cancel, read.
 *
 * No retry, no scheduling, no provider execution. A job here is a record of
 * intent and a lifecycle; what eventually runs inside `running` is every later
 * increment's business.
 *
 * ── Atomicity ───────────────────────────────────────────────────────────────
 * Every operation takes ONE transaction handle. There is no commit in this
 * module and no second connection, so a job that was published but not written
 * — or moved without its event — cannot exist (ADR-020).
 *
 * ── Illegal transitions are refused twice, on purpose ───────────────────────
 * The state machine refuses the MOVE before any SQL runs, so the caller gets a
 * message naming what would have been legal. The UPDATE then carries the
 * expected state in its own predicate, so a job that moved under a concurrent
 * caller matches nothing rather than being dragged backwards.
 *
 * The first is a better error; the second is the guarantee. Only the predicate
 * survives two callers racing, and only the machine can explain itself.
 *
 * ── Connection context ──────────────────────────────────────────────────────
 * `jobs.tenant_id` is the workspace and the database CHECKs it, so every call
 * runs under `withTenant({ tenantId: workspaceId, organizationId })` (ADR-017).
 * Under an organization tenant every write here is rejected by WITH CHECK,
 * which is the intended outcome: a job belongs to the workspace it runs in.
 */

import type { DomainEvent, EventPublisher, Transaction } from '@contentos/contracts';
import type { AuditActorKind, AuditContext, AuditWriter } from '@contentos/security';
import { secureId } from '@contentos/security';

import {
  EVENT_FOR_TRANSITION,
  jobCancelled,
  jobCompleted,
  jobFailed,
  jobQueued,
  jobStarted,
  type JobEventContext,
} from './events.js';
import {
  assertReasonPresent,
  assertTransitionAllowed,
  isJobStatus,
  JOB_TRANSITION_RULES,
  JobError,
  type Job,
  type JobStatus,
  type JobTransition,
} from './job.js';

export interface JobExecutor extends Transaction {
  query<T>(sql: string, params?: readonly unknown[]): Promise<readonly T[]>;
}

export interface JobActor {
  readonly id: string;
  readonly kind: AuditActorKind;
}

/** Audit actions are enumerated constants, never free text. */
export const JOB_AUDIT_ACTIONS = {
  cancel: 'ai.job.cancelled',
} as const;

/** The largest page the job list will serve. */
export const MAX_JOB_PAGE = 200;
export const DEFAULT_JOB_PAGE = 50;

const COLUMNS = `
  id,
  tenant_id       AS "tenantId",
  workspace_id    AS "workspaceId",
  organization_id AS "organizationId",
  job_type        AS "jobType",
  status,
  correlation_id  AS "correlationId",
  causation_id    AS "causationId",
  payload,
  reason,
  created_at      AS "createdAt",
  updated_at      AS "updatedAt",
  started_at      AS "startedAt",
  completed_at    AS "completedAt"`;

const INSERT_SQL = `
  INSERT INTO jobs (
    tenant_id, workspace_id, organization_id, job_type, status,
    correlation_id, causation_id, payload
  ) VALUES ($1,$1,$2,$3,'queued',$4,$5,$6::jsonb)
  RETURNING ${COLUMNS}`;

const SELECT_BY_ID_SQL = `
  SELECT ${COLUMNS} FROM jobs WHERE tenant_id = $1 AND id = $2`;

/**
 * The guarded transition.
 *
 * `status = $3` is the whole concurrency story: two callers racing to start one
 * job produce one winner and one no-op, with no lock taken and nothing to
 * release. `started_at` and `completed_at` are set from the target state rather
 * than passed in, so the row cannot end up in a shape the CHECKs forbid.
 */
const TRANSITION_SQL = `
  UPDATE jobs
     SET status       = $4,
         reason       = $5,
         updated_at   = now(),
         started_at   = CASE WHEN $4 = 'running' THEN now() ELSE started_at END,
         completed_at = CASE WHEN $4 IN ('completed','failed','cancelled')
                             THEN now() ELSE completed_at END
   WHERE tenant_id = $1 AND id = $2 AND status = $3
  RETURNING ${COLUMNS}`;

/**
 * Keyset pagination on `(created_at, id)`.
 *
 * OFFSET skips or repeats rows as earlier pages shift, and a job list is
 * written to while it is read. `id` is a uuidv7, so the pair is a total order
 * even when two jobs share a timestamp.
 */
const SELECT_PAGE_SQL = `
  SELECT ${COLUMNS}
    FROM jobs
   WHERE tenant_id = $1
     AND ($2::text IS NULL OR status = $2::text)
     AND ($3::text IS NULL OR job_type = $3::text)
     AND ($4::timestamptz IS NULL
          OR (created_at, id) < ($4::timestamptz, $5::uuid))
   ORDER BY created_at DESC, id DESC
   LIMIT $6`;

interface Row {
  readonly id: string;
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly organizationId: string;
  readonly jobType: string;
  readonly status: string;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly payload: Readonly<Record<string, unknown>> | null;
  readonly reason: string | null;
  readonly createdAt: string | Date;
  readonly updatedAt: string | Date;
  readonly startedAt: string | Date | null;
  readonly completedAt: string | Date | null;
}

const iso = (value: string | Date): string => (value instanceof Date ? value.toISOString() : value);
const isoOrNull = (value: string | Date | null): string | null =>
  value === null ? null : iso(value);

function toJob(row: Row): Job {
  if (!isJobStatus(row.status)) {
    throw new JobError(
      'InvalidJobState',
      `Job ${row.id} holds unknown status '${row.status}'; the schema and this module have diverged.`,
    );
  }
  return {
    id: row.id,
    tenantId: row.tenantId,
    workspaceId: row.workspaceId,
    organizationId: row.organizationId,
    jobType: row.jobType,
    status: row.status,
    correlationId: row.correlationId,
    causationId: row.causationId,
    payload: row.payload ?? {},
    reason: row.reason,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    startedAt: isoOrNull(row.startedAt),
    completedAt: isoOrNull(row.completedAt),
  };
}

export interface CreateJobCommand {
  readonly workspaceId: string;
  readonly organizationId: string;
  readonly jobType: string;
  /** What to do. Identifiers and scalars — never model output. */
  readonly payload?: Readonly<Record<string, unknown>>;
  readonly correlationId: string;
  readonly causationId?: string | null;
}

export interface TransitionJobCommand {
  readonly workspaceId: string;
  readonly jobId: string;
  /** Mandatory for `fail` and `cancel`; refused for the others. */
  readonly reason?: string | null;
  readonly correlationId: string;
  readonly causationId?: string | null;
}

export interface CancelJobCommand extends TransitionJobCommand {
  readonly reason: string;
  readonly actor: JobActor;
  readonly context?: AuditContext;
}

export interface FailJobCommand extends TransitionJobCommand {
  readonly reason: string;
}

export interface JobResult {
  readonly job: Job;
  readonly event: DomainEvent<unknown>;
}

export interface JobPageQuery {
  readonly workspaceId: string;
  readonly status?: JobStatus | null;
  readonly jobType?: string | null;
  readonly limit?: number;
  readonly cursor?: JobCursor | null;
}

/** Position in a `(created_at DESC, id DESC)` scan. */
export interface JobCursor {
  readonly createdAt: string;
  readonly id: string;
}

export interface JobPage {
  readonly jobs: readonly Job[];
  /** Null when the page was not full — there is nothing after it. */
  readonly nextCursor: JobCursor | null;
}

export interface JobServiceOptions {
  readonly publisher: EventPublisher;
  readonly audit: AuditWriter;
  /** Server clock. Never client-supplied. */
  readonly now?: () => Date;
  readonly newEventId?: () => string;
}

export interface JobService {
  create(tx: JobExecutor, command: CreateJobCommand): Promise<JobResult>;
  start(tx: JobExecutor, command: TransitionJobCommand): Promise<JobResult>;
  complete(tx: JobExecutor, command: TransitionJobCommand): Promise<JobResult>;
  fail(tx: JobExecutor, command: FailJobCommand): Promise<JobResult>;
  cancel(tx: JobExecutor, command: CancelJobCommand): Promise<JobResult>;
  read(tx: JobExecutor, query: JobPageQuery): Promise<JobPage>;
  findById(tx: JobExecutor, workspaceId: string, jobId: string): Promise<Job | null>;
}

const EMPTY_CONTEXT: AuditContext = {
  ipAddress: null,
  userAgent: null,
  sessionId: null,
  stepUpSatisfied: false,
};

export function createJobService(options: JobServiceOptions): JobService {
  const now = options.now ?? ((): Date => new Date());
  const newEventId = options.newEventId ?? secureId;
  const { publisher, audit } = options;

  function eventContext(command: {
    readonly correlationId: string;
    readonly causationId?: string | null;
  }): JobEventContext {
    return {
      eventId: newEventId(),
      correlationId: command.correlationId,
      causationId: command.causationId ?? null,
      occurredAt: now().toISOString(),
    };
  }

  const BUILDERS = {
    JobStarted: jobStarted,
    JobCompleted: jobCompleted,
    JobFailed: jobFailed,
    JobCancelled: jobCancelled,
  } as const;

  async function findById(
    tx: JobExecutor,
    workspaceId: string,
    jobId: string,
  ): Promise<Job | null> {
    const rows = await tx.query<Row>(SELECT_BY_ID_SQL, [workspaceId, jobId]);
    const row = rows[0];
    return row === undefined ? null : toJob(row);
  }

  /**
   * One guarded transition, shared by all four moves.
   *
   * Reads the job first so the state machine can explain an illegal move; the
   * UPDATE then carries the expected state, so the read being stale costs a
   * clean failure rather than a wrong write.
   */
  async function transition(
    tx: JobExecutor,
    transitionName: JobTransition,
    command: TransitionJobCommand,
  ): Promise<JobResult> {
    const rule = JOB_TRANSITION_RULES[transitionName];
    const reason = command.reason ?? null;
    assertReasonPresent(transitionName, reason);

    const current = await findById(tx, command.workspaceId, command.jobId);
    if (current === null) {
      throw new JobError('JobNotFound', `Job '${command.jobId}' does not exist.`);
    }
    assertTransitionAllowed(current.status, transitionName);

    const rows = await tx.query<Row>(TRANSITION_SQL, [
      command.workspaceId,
      command.jobId,
      rule.from,
      rule.to,
      // `reason` is null for start and complete, which is what the CHECK
      // requires: only a failure or a cancellation explains itself.
      rule.requiresReason ? reason : null,
    ]);

    const row = rows[0];
    if (row === undefined) {
      // The job moved between the read and the write. The predicate refused it,
      // which is the point — a concurrent caller already took this transition.
      const raced = await findById(tx, command.workspaceId, command.jobId);
      throw new JobError(
        'IllegalTransition',
        `Job '${command.jobId}' was ${raced?.status ?? 'removed'} by a concurrent caller; ${transitionName} expected '${rule.from}'.`,
      );
    }

    const job = toJob(row);
    const event = BUILDERS[EVENT_FOR_TRANSITION[transitionName]](eventContext(command), {
      jobId: job.id,
      jobType: job.jobType,
      workspaceId: job.workspaceId,
      organizationId: job.organizationId,
    });
    // Last, so that envelope and registry validation — which run inside
    // `publish`, before commit — roll the transition back with them.
    await publisher.publish(tx, event);

    return { job, event };
  }

  return {
    async create(tx, command) {
      if (command.jobType.trim() === '') {
        throw new JobError(
          'JobTypeRequired',
          'A job must declare its type; a runner routes on it and nothing else says what the work is.',
        );
      }

      const rows = await tx.query<Row>(INSERT_SQL, [
        // tenant_id AND workspace_id from one parameter: the database CHECKs
        // they are equal, so there is no way to pass two different values.
        command.workspaceId,
        command.organizationId,
        command.jobType,
        command.correlationId,
        command.causationId ?? null,
        JSON.stringify(command.payload ?? {}),
      ]);
      const row = rows[0];
      if (row === undefined) {
        throw new JobError(
          'JobNotFound',
          'The job insert returned no row; creation cannot continue.',
        );
      }

      const job = toJob(row);
      const event = jobQueued(eventContext(command), {
        jobId: job.id,
        jobType: job.jobType,
        workspaceId: job.workspaceId,
        organizationId: job.organizationId,
      });
      await publisher.publish(tx, event);

      return { job, event };
    },

    start(tx, command) {
      return transition(tx, 'start', command);
    },

    complete(tx, command) {
      return transition(tx, 'complete', command);
    },

    fail(tx, command) {
      return transition(tx, 'fail', command);
    },

    async cancel(tx, command) {
      const result = await transition(tx, 'cancel', command);

      // Cancellation is audited and the other three moves are not: it is the
      // only one an actor DECIDES rather than the work reaching an outcome.
      // Auditing start and complete would record, at every job's volume, that
      // the machine did what it was asked.
      await audit.record(tx, {
        tenantId: result.job.tenantId,
        organizationId: result.job.organizationId,
        actorId: command.actor.id,
        actorKind: command.actor.kind,
        correlationId: command.correlationId,
        action: JOB_AUDIT_ACTIONS.cancel,
        target: { kind: 'job', id: result.job.id, tenantId: result.job.tenantId },
        result: 'success',
        reason: command.reason,
        context: {
          ...(command.context ?? EMPTY_CONTEXT),
          detail: {
            ...(command.context ?? EMPTY_CONTEXT).detail,
            jobType: result.job.jobType,
          },
        },
      });

      return result;
    },

    async read(tx, query) {
      // Clamped rather than rejected: the caller asked for more than a page,
      // and a page is what the list promises.
      const requested = query.limit ?? DEFAULT_JOB_PAGE;
      const limit = Math.max(1, Math.min(requested, MAX_JOB_PAGE));

      const rows = await tx.query<Row>(SELECT_PAGE_SQL, [
        query.workspaceId,
        query.status ?? null,
        query.jobType ?? null,
        query.cursor?.createdAt ?? null,
        query.cursor?.id ?? null,
        limit,
      ]);

      const jobs = rows.map(toJob);
      const last = jobs.at(-1);
      return {
        jobs,
        nextCursor:
          jobs.length === limit && last !== undefined
            ? { createdAt: last.createdAt, id: last.id }
            : null,
      };
    },

    findById(tx, workspaceId, jobId) {
      return findById(tx, workspaceId, jobId);
    },
  };
}
