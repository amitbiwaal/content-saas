/**
 * The job runner handler — ORCHESTRATION ONLY.
 *
 * It does exactly one thing: move a queued job to `running`. There is no AI
 * work behind it, no provider call, and no dispatch. What eventually happens
 * inside `running` is every later increment's business; this establishes that
 * the event reaches a runner and the runner owns the transition.
 *
 * ── The transition runs on the DISPATCHER'S transaction ─────────────────────
 * `JobQueued` is workspace-scoped and a job is keyed on its workspace, so the
 * dispatcher's handle already carries the right tenant. The state change, the
 * `JobStarted` outbox row and the `processed_events` marker therefore commit
 * together: a redelivery cannot start a job twice, and a marker cannot exist
 * for a job that never moved.
 *
 * That is why there is no port here. Opening a second transaction would give up
 * exactly that, and buy nothing — unlike the cascade and credit-release
 * handlers, which need a tenant the event does not carry.
 *
 * ── A job already running is not an error ───────────────────────────────────
 * The service's predicate refuses the second start, and this treats that as
 * success. A redelivered `JobQueued` for a job someone already claimed is the
 * bus doing its job, not a fault to dead-letter.
 */

import type { DomainEvent, TenantContext } from '@contentos/contracts';
import { JOB_RUNNER_GROUP, JobError, type JobExecutor, type JobService } from '@contentos/ai';
import type { GuardExecutor, RegisteredHandler } from '@contentos/events';

/**
 * A start that could not be completed.
 *
 * Deliberately NOT terminal, so the retry engine classifies it transient. A
 * queued job nobody started is work a customer asked for and never got.
 */
export const JOB_START_FAILED = 'JobStartFailed';

export class JobStartFailedError extends Error {
  readonly code = JOB_START_FAILED;

  constructor(jobId: string, cause: unknown) {
    super(
      `Starting job '${jobId}' failed: ${cause instanceof Error ? cause.message : String(cause)}. Retrying re-runs the transition; a job already running is left alone.`,
    );
    this.name = 'JobStartFailedError';
  }
}

/** The actor recorded on every transition this handler drives. */
export const JOB_RUNNER_ACTOR = { id: 'workers.host.jobs', kind: 'service' as const };

export interface JobHandlerDeps {
  readonly jobs: JobService;
}

interface QueuedPayload {
  readonly jobId?: unknown;
  readonly workspaceId?: unknown;
}

function requireString(value: unknown, field: string, eventId: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    // A malformed payload is a contract violation, not a transient fault. The
    // code is terminal so it dead-letters rather than retrying forever.
    throw Object.assign(new Error(`Event '${eventId}' has no '${field}' in its payload.`), {
      code: 'SchemaViolation',
    });
  }
  return value;
}

export function createJobHandlers(deps: JobHandlerDeps): readonly RegisteredHandler[] {
  const jobQueued: RegisteredHandler = {
    eventType: 'JobQueued',
    version: 1,
    group: JOB_RUNNER_GROUP,
    // `workspaces.id` IS `tenant_id` (ADR-017), and the job is keyed the same
    // way — which is what lets the transition run on this handle.
    tenantScope: 'workspace',
    handle: async (
      event: DomainEvent<unknown>,
      _ctx: TenantContext,
      tx: GuardExecutor,
      _signal: AbortSignal,
    ): Promise<void> => {
      const payload = event.payload as QueuedPayload;
      const jobId = requireString(payload.jobId, 'jobId', event.eventId);
      const workspaceId = requireString(
        payload.workspaceId ?? event.tenantId,
        'workspaceId',
        event.eventId,
      );

      try {
        await deps.jobs.start(tx as JobExecutor, {
          workspaceId,
          jobId,
          correlationId: event.correlationId,
          // The queueing is what caused the start, which is what ties the two
          // together in a trace.
          causationId: event.eventId,
        });
      } catch (error: unknown) {
        // A job that is no longer queued was claimed by someone else — the
        // predicate did its work. Redelivery is the bus behaving correctly.
        if (error instanceof JobError && error.code === 'IllegalTransition') return;
        throw new JobStartFailedError(jobId, error);
      }
    },
  };

  return [jobQueued];
}
