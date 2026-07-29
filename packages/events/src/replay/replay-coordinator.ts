/**
 * Replay coordinator — ADR-028.
 *
 * Spec: `13-event-platform/replay.md`.
 *
 * REPLAY RE-DELIVERS EVENTS; IT DOES NOT RE-EXECUTE EFFECTS. Every replayed
 * event passes through the same registry validation, the same tenant context,
 * and the same idempotency check as its original delivery. A correctly built
 * consumer cannot tell the difference — and that is the entire safety model.
 *
 * THIS MODULE ADDS NO DUPLICATE-SUPPRESSION MECHANISM. It relies entirely on
 * the one that already makes at-least-once delivery safe: the replayed event is
 * byte-identical to the original, so it derives the same idempotency key, so
 * the conflict fires on `processed_events`, so the handler does not run twice.
 * A replay-specific suppression path would be a second mechanism alongside
 * idempotency, and two mechanisms disagree eventually.
 *
 * READS FROM POSTGRESQL, NEVER FROM REDIS. The bus trims under pressure;
 * replaying from a trimmed stream produces a SILENTLY PARTIAL rebuild, which is
 * worse than no rebuild because it looks like it worked.
 */

import type { DomainEvent } from '@contentos/contracts';

import type { GuardExecutor } from '../delivery/guards.js';
import type { DeadLetterQueue, DeadLetterRow } from '../dlq/dead-letter-queue.js';
import type { EventRegistry } from '../registry/registry.js';
import { toEvent, type OutboxRow } from '../relay/relay.js';

/** `outbox_events` retains 30 days (`03-database/tables.md` §8). */
export const OUTBOX_RETENTION_DAYS = 30;
/** Bounds re-delivery after an interruption to at most this many events. */
export const DEFAULT_CHECKPOINT_INTERVAL = 1000;
/** Keeps replay from starving live delivery. */
export const DEFAULT_RATE_LIMIT_PER_SECOND = 500;
export const DEFAULT_BATCH_SIZE = 200;
/** Replay pauses when a target group's lag exceeds this. */
export const DEFAULT_LAG_THRESHOLD_SECONDS = 300;
/** Bounds total platform-wide replay load. */
export const MAX_CONCURRENT_RUNS = 2;
/** An unbounded request is rejected outright rather than truncated. */
export const DEFAULT_MAX_EVENTS = 5_000_000;

export type ReplayStatus = 'pending' | 'running' | 'paused' | 'completed' | 'aborted' | 'failed';
export type ReplayMode = 'range' | 'consumer' | 'targeted';

/**
 * A non-empty list, at the type level.
 *
 * `targetGroups` is required and NON-EMPTY in every variant, so an accidental
 * broadcast is a compile error rather than an operational one — the same
 * structural technique as the transaction-bound publisher and the two-variant
 * `RetryDecision`. There is no way to express "replay to everyone".
 */
export type NonEmpty<T> = readonly [T, ...T[]];

interface ReplayScope {
  readonly targetGroups: NonEmpty<string>;
  /**
   * Runs are recorded per tenant: `replay_runs.tenant_id` is NOT NULL and the
   * table carries the canonical FORCE-RLS policy, so a run is readable only
   * within the tenant context that created it.
   */
  readonly tenantId: string;
  readonly organizationId: string;
}

export type ReplayRequest =
  | (ReplayScope & {
      readonly mode: 'range';
      readonly from: Date;
      readonly to: Date;
      readonly eventTypes?: readonly string[];
    })
  | (ReplayScope & { readonly mode: 'consumer'; readonly fromPosition: 'earliest' | Date })
  | (ReplayScope & { readonly mode: 'targeted'; readonly deadLetterIds: NonEmpty<string> });

export interface ReplayEstimate {
  readonly eventCount: number;
  readonly targetGroups: readonly string[];
  readonly estimatedDurationMs: number;
  readonly withinBounds: boolean;
  readonly rejectionReason?: string;
}

export interface ReplayRun {
  readonly id: string;
  readonly mode: ReplayMode;
  readonly request: ReplayRequest;
  /** ONE group per run row — see the module note on the coordination token. */
  readonly targetGroup: string;
  readonly status: ReplayStatus;
  readonly delivered: number;
  readonly skipped: number;
  readonly skipReasons: Readonly<Record<string, number>>;
  readonly suppressedAsDuplicate: number;
  readonly checkpoint: string | null;
  readonly startedBy: string;
  readonly startedAt: Date;
  readonly completedAt: Date | null;
}

/**
 * Handed to the handler alongside the event.
 *
 * `isReplay` exists for OBSERVABILITY — separating replay load from live load —
 * and for the narrow class of handlers that legitimately suppress outbound
 * notifications during a rebuild. A handler that branches its BUSINESS LOGIC on
 * it has made replay unsafe, which is exactly what idempotency rules out.
 */
export interface ReplayContext {
  readonly isReplay: true;
  readonly replayRunId: string;
  /**
   * The event's own occurrence time. Handlers must use this, never `now()`:
   * stamping wall-clock while replaying three-week-old events writes a month of
   * history at today's timestamp, silently corrupting every time-series
   * projection the handler maintains.
   */
  readonly originalOccurredAt: Date;
}

export type ReplayDeliveryOutcome =
  | { readonly kind: 'delivered' }
  | { readonly kind: 'suppressed-duplicate' }
  | { readonly kind: 'failed'; readonly code: string; readonly message: string };

/** Why an event was not delivered. Recorded per run, never dropped quietly. */
export const SKIP_REASONS = Object.freeze({
  registryRejected: 'registry-rejected',
  tenantErased: 'tenant-erased',
  deliveryFailed: 'delivery-failed',
  notFound: 'not-found',
});

export interface ReplayAuditEntry {
  readonly action: 'estimate' | 'start' | 'pause' | 'resume' | 'abort' | 'complete' | 'fail';
  readonly actor: string;
  readonly runId: string | null;
  readonly mode: ReplayMode;
  readonly targetGroups: readonly string[];
  readonly detail: Readonly<Record<string, unknown>>;
}

export interface ReplayProgress {
  readonly runId: string;
  readonly targetGroup: string;
  readonly delivered: number;
  readonly skipped: number;
  readonly suppressedAsDuplicate: number;
  readonly checkpoint: string | null;
}

export interface ReplayDeps {
  readonly transaction: <T>(work: (tx: GuardExecutor) => Promise<T>) => Promise<T>;
  /** Re-validation is NEVER bypassed. */
  readonly registry: EventRegistry;
  readonly dlq: DeadLetterQueue;
  /**
   * Delivers ONE replayed event to ONE group.
   *
   * This is the seam to the live delivery path: the implementation composes
   * barrier → idempotency → handler exactly as `createDispatcher` does. Replay
   * does not reimplement delivery, and in particular does not bypass the
   * aggregate barrier — bypassing it would invert ordering precisely when the
   * platform is doing bulk work.
   */
  readonly deliver: (
    event: DomainEvent<unknown>,
    group: string,
    ctx: ReplayContext,
  ) => Promise<ReplayDeliveryOutcome>;
  /** Consumer lag for backpressure. Absent means no backpressure. */
  readonly lagSeconds?: (group: string) => Promise<number>;
  /**
   * Erased tenants are skipped. Replaying an event for an erased tenant would
   * resurrect data destroyed under a right-to-erasure request — a compliance
   * property, not an optimization.
   */
  readonly isTenantErased?: (tenantId: string) => Promise<boolean>;
  readonly audit: (entry: ReplayAuditEntry) => Promise<void>;
  readonly now?: () => Date;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly checkpointInterval?: number;
  readonly batchSize?: number;
  readonly rateLimitPerSecond?: number;
  readonly lagThresholdSeconds?: number;
  readonly maxEvents?: number;
  readonly onProgress?: (progress: ReplayProgress) => void;
  readonly onBackpressurePause?: (runId: string, group: string, lagSeconds: number) => void;
  readonly onSkip?: (runId: string, reason: string, eventId: string) => void;
}

const COUNT_RANGE_SQL = `
  SELECT count(*)::bigint AS count FROM outbox_events
   WHERE tenant_id = $1
     AND occurred_at >= $2 AND occurred_at <= $3
     AND ($4::text[] IS NULL OR event_type = ANY($4::text[]))`;

/**
 * Keyset pagination on `id`, never OFFSET.
 *
 * `OFFSET` on a multi-million-row scan degrades quadratically, so a large
 * replay would start fast and finish never — a failure mode that looks like a
 * hang rather than an error.
 *
 * `ORDER BY id` is what preserves ORIGINAL PER-AGGREGATE ORDER: `id` is the
 * BIGSERIAL that defined publication order in the first place.
 */
const READ_RANGE_SQL = `
  SELECT * FROM outbox_events
   WHERE tenant_id = $1
     AND occurred_at >= $2 AND occurred_at <= $3
     AND ($4::text[] IS NULL OR event_type = ANY($4::text[]))
     AND id > $5::bigint
   ORDER BY id
   LIMIT $6`;

const COUNT_CONSUMER_SQL = `
  SELECT count(*)::bigint AS count FROM outbox_events
   WHERE tenant_id = $1 AND occurred_at >= $2`;

const READ_CONSUMER_SQL = `
  SELECT * FROM outbox_events
   WHERE tenant_id = $1 AND occurred_at >= $2 AND id > $3::bigint
   ORDER BY id
   LIMIT $4`;

const ACTIVE_RUN_COUNT_SQL = `
  SELECT count(*)::int AS count FROM replay_runs
   WHERE status IN ('pending','running','paused')`;

/**
 * Acquiring the coordination token IS inserting the row.
 *
 * The partial unique index `uq_replay_runs__active_per_group` rejects a second
 * active run for the same target group. Enforced by the database rather than by
 * an application check, which would have a race window between check and insert.
 */
const INSERT_RUN_SQL = `
  INSERT INTO replay_runs (
    tenant_id, organization_id, mode, request, target_group, status, started_by
  ) VALUES ($1,$2,$3,$4,$5,'pending',$6)
  RETURNING id, started_at`;

const GET_RUN_SQL = `SELECT * FROM replay_runs WHERE id = $1`;

const SET_STATUS_SQL = `
  UPDATE replay_runs
     SET status = $2,
         finished_at = CASE WHEN $2 IN ('completed','aborted','failed') THEN now() ELSE finished_at END
   WHERE id = $1
   RETURNING id`;

const SAVE_PROGRESS_SQL = `
  UPDATE replay_runs
     SET delivered = $2, skipped = $3, suppressed_as_duplicate = $4,
         skip_reasons = $5::jsonb, checkpoint = $6
   WHERE id = $1`;

interface RunRow {
  readonly id: string;
  readonly mode: ReplayMode;
  readonly request: unknown;
  readonly target_group: string;
  readonly status: ReplayStatus;
  readonly delivered: string | number;
  readonly skipped: string | number;
  readonly skip_reasons: unknown;
  readonly suppressed_as_duplicate: string | number;
  readonly checkpoint: string | null;
  readonly started_by: string;
  readonly started_at: string;
  readonly finished_at: string | null;
}

/** BIGINT arrives as a string from most drivers; coerce without losing zero. */
function num(value: string | number): number {
  return typeof value === 'number' ? value : Number(value);
}

function counts(value: unknown): Record<string, number> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'number') out[k] = v;
  }
  return out;
}

function reviveRequest(raw: unknown): ReplayRequest {
  const r = raw as Record<string, unknown>;
  const base = {
    targetGroups: r['targetGroups'] as NonEmpty<string>,
    tenantId: String(r['tenantId']),
    organizationId: String(r['organizationId']),
  };
  if (r['mode'] === 'range') {
    return {
      ...base,
      mode: 'range',
      from: new Date(String(r['from'])),
      to: new Date(String(r['to'])),
      ...(r['eventTypes'] === undefined ? {} : { eventTypes: r['eventTypes'] as string[] }),
    };
  }
  if (r['mode'] === 'consumer') {
    const p = r['fromPosition'];
    return {
      ...base,
      mode: 'consumer',
      fromPosition: p === 'earliest' ? 'earliest' : new Date(String(p)),
    };
  }
  return { ...base, mode: 'targeted', deadLetterIds: r['deadLetterIds'] as NonEmpty<string> };
}

function toRun(row: RunRow): ReplayRun {
  return {
    id: row.id,
    mode: row.mode,
    request: reviveRequest(row.request),
    targetGroup: row.target_group,
    status: row.status,
    delivered: num(row.delivered),
    skipped: num(row.skipped),
    skipReasons: counts(row.skip_reasons),
    suppressedAsDuplicate: num(row.suppressed_as_duplicate),
    checkpoint: row.checkpoint,
    startedBy: row.started_by,
    startedAt: new Date(row.started_at),
    completedAt: row.finished_at === null ? null : new Date(row.finished_at),
  };
}

export class ReplayRejectedError extends Error {
  readonly code = 'ReplayRejected';
  constructor(message: string) {
    super(message);
    this.name = 'ReplayRejectedError';
  }
}

export interface ReplayCoordinator {
  estimate(request: ReplayRequest, actor: string): Promise<ReplayEstimate>;
  /**
   * Returns ONE RUN PER TARGET GROUP.
   *
   * `replay_runs` carries a single `target_group` column and the coordination
   * token is a partial unique index over it, so a run row is scoped to exactly
   * one group. A multi-group request therefore fans out into one run per group,
   * each holding its own token and each independently resumable. All rows are
   * inserted in ONE transaction, so a request naming a group that already has
   * an active run starts nothing at all rather than starting partially.
   */
  start(request: ReplayRequest, actor: string): Promise<readonly ReplayRun[]>;
  status(runId: string): Promise<ReplayRun | null>;
  pause(runId: string, actor: string): Promise<void>;
  resume(runId: string, actor: string): Promise<void>;
  abort(runId: string, actor: string, reason: string): Promise<void>;
  /** Drives one run to a terminal or paused state. Resumable and cancellable. */
  execute(runId: string, signal?: AbortSignal): Promise<ReplayRun>;
}

export function createReplayCoordinator(deps: ReplayDeps): ReplayCoordinator {
  const now = deps.now ?? ((): Date => new Date());
  const sleep =
    deps.sleep ?? ((ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)));
  const checkpointInterval = deps.checkpointInterval ?? DEFAULT_CHECKPOINT_INTERVAL;
  const batchSize = deps.batchSize ?? DEFAULT_BATCH_SIZE;
  const rateLimit = deps.rateLimitPerSecond ?? DEFAULT_RATE_LIMIT_PER_SECOND;
  const lagThreshold = deps.lagThresholdSeconds ?? DEFAULT_LAG_THRESHOLD_SECONDS;
  const maxEvents = deps.maxEvents ?? DEFAULT_MAX_EVENTS;

  function assertNonEmptyTargets(request: ReplayRequest): void {
    // Belt and braces: the type makes this unrepresentable, but a request
    // arriving as JSON from an operator API has not been through the compiler.
    if (request.targetGroups.length === 0) {
      throw new ReplayRejectedError(
        'A replay request must name at least one target group. There is no broadcast default.',
      );
    }
  }

  /** Rejects a window that reaches past the outbox retention bound. */
  function retentionFloor(): Date {
    return new Date(now().getTime() - OUTBOX_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  }

  async function countFor(tx: GuardExecutor, request: ReplayRequest): Promise<number> {
    if (request.mode === 'targeted') return request.deadLetterIds.length;
    if (request.mode === 'range') {
      const rows = await tx.query<{ count: string | number }>(COUNT_RANGE_SQL, [
        request.tenantId,
        request.from.toISOString(),
        request.to.toISOString(),
        request.eventTypes ?? null,
      ]);
      return num(rows[0]?.count ?? 0);
    }
    const from = request.fromPosition === 'earliest' ? retentionFloor() : request.fromPosition;
    const rows = await tx.query<{ count: string | number }>(COUNT_CONSUMER_SQL, [
      request.tenantId,
      from.toISOString(),
    ]);
    return num(rows[0]?.count ?? 0);
  }

  async function readBatch(
    tx: GuardExecutor,
    request: ReplayRequest,
    afterId: string,
  ): Promise<readonly { readonly key: string; readonly event: DomainEvent<unknown> }[]> {
    if (request.mode === 'targeted') {
      // Out of order BY DEFINITION — an isolated event delivered after later
      // ones. Read deterministically so a resumed run repeats the same
      // sequence, but make no ordering claim beyond that.
      const remaining = request.deadLetterIds.filter((id) => id > afterId).sort();
      const out: { key: string; event: DomainEvent<unknown> }[] = [];
      for (const id of remaining.slice(0, batchSize)) {
        const row: DeadLetterRow | null = await deps.dlq.get(tx, id);
        if (row === null) continue;
        out.push({ key: id, event: deps.dlq.toEvent(row) });
      }
      return out;
    }

    const rows =
      request.mode === 'range'
        ? await tx.query<OutboxRow>(READ_RANGE_SQL, [
            request.tenantId,
            request.from.toISOString(),
            request.to.toISOString(),
            request.eventTypes ?? null,
            afterId,
            batchSize,
          ])
        : await tx.query<OutboxRow>(READ_CONSUMER_SQL, [
            request.tenantId,
            (request.fromPosition === 'earliest'
              ? retentionFloor()
              : request.fromPosition
            ).toISOString(),
            afterId,
            batchSize,
          ]);

    return rows.map((row) => ({ key: String(row.id), event: toEvent(row) }));
  }

  async function loadRun(runId: string): Promise<ReplayRun | null> {
    const rows = await deps.transaction((tx) => tx.query<RunRow>(GET_RUN_SQL, [runId]));
    const row = rows[0];
    return row === undefined ? null : toRun(row);
  }

  async function setStatus(runId: string, status: ReplayStatus): Promise<void> {
    await deps.transaction((tx) => tx.query(SET_STATUS_SQL, [runId, status]));
  }

  return {
    /**
     * Estimation precedes execution and is enforced.
     *
     * An operator seeing "2.4 million events across 6 groups" reconsiders; one
     * who typed a date range a year too wide and pressed go does not get the
     * chance.
     */
    async estimate(request, actor): Promise<ReplayEstimate> {
      assertNonEmptyTargets(request);
      const targetGroups = [...request.targetGroups];

      const reject = async (reason: string): Promise<ReplayEstimate> => {
        const result: ReplayEstimate = {
          eventCount: 0,
          targetGroups,
          estimatedDurationMs: 0,
          withinBounds: false,
          rejectionReason: reason,
        };
        await deps.audit({
          action: 'estimate',
          actor,
          runId: null,
          mode: request.mode,
          targetGroups,
          detail: { withinBounds: false, rejectionReason: reason },
        });
        return result;
      };

      // Beyond retention the source rows no longer exist. Rejecting explicitly
      // is the difference between "cannot be replayed" and a silently partial
      // set that looks like a completed rebuild.
      if (request.mode === 'range' && request.from < retentionFloor()) {
        return reject(
          `Range starts before the ${String(OUTBOX_RETENTION_DAYS)}-day outbox retention window; those events no longer exist.`,
        );
      }
      if (request.mode === 'range' && request.to < request.from) {
        return reject('Range end precedes its start.');
      }

      const eventCount = await deps.transaction((tx) => countFor(tx, request));
      if (eventCount > maxEvents) {
        return reject(
          `Scope of ${String(eventCount)} events exceeds the bound of ${String(maxEvents)}.`,
        );
      }

      // Per group, since each group's run delivers the full set independently.
      const perGroupMs = (eventCount / rateLimit) * 1000;
      const estimate: ReplayEstimate = {
        eventCount,
        targetGroups,
        estimatedDurationMs: Math.round(perGroupMs),
        withinBounds: true,
      };
      await deps.audit({
        action: 'estimate',
        actor,
        runId: null,
        mode: request.mode,
        targetGroups,
        detail: { eventCount, withinBounds: true },
      });
      return estimate;
    },

    async start(request, actor): Promise<readonly ReplayRun[]> {
      assertNonEmptyTargets(request);
      const targetGroups = [...request.targetGroups];

      const estimate = await this.estimate(request, actor);
      if (!estimate.withinBounds) {
        throw new ReplayRejectedError(
          estimate.rejectionReason ?? 'Replay request rejected by estimation.',
        );
      }

      const runs = await deps.transaction(async (tx) => {
        const activeRows = await tx.query<{ count: number }>(ACTIVE_RUN_COUNT_SQL);
        const active = activeRows[0]?.count ?? 0;
        if (active + targetGroups.length > MAX_CONCURRENT_RUNS) {
          throw new ReplayRejectedError(
            `Starting ${String(targetGroups.length)} run(s) would exceed the platform limit of ${String(MAX_CONCURRENT_RUNS)} concurrent replays (${String(active)} already active).`,
          );
        }

        const created: ReplayRun[] = [];
        for (const group of targetGroups) {
          // The insert IS the token acquisition. A group with an active run
          // fails here on the partial unique index, and because every group is
          // inserted in ONE transaction, the whole start rolls back.
          const rows = await tx.query<{ id: string; started_at: string }>(INSERT_RUN_SQL, [
            request.tenantId,
            request.organizationId,
            request.mode,
            JSON.stringify(request),
            group,
            actor,
          ]);
          const row = rows[0];
          if (row === undefined) {
            throw new ReplayRejectedError(`Could not acquire a replay token for group '${group}'.`);
          }
          created.push({
            id: row.id,
            mode: request.mode,
            request,
            targetGroup: group,
            status: 'pending',
            delivered: 0,
            skipped: 0,
            skipReasons: {},
            suppressedAsDuplicate: 0,
            checkpoint: null,
            startedBy: actor,
            startedAt: new Date(row.started_at),
            completedAt: null,
          });
        }
        return created;
      });

      // Target groups are audited EXPLICITLY: "which consumers received this" is
      // the question asked after an unintended replay, and it is unanswerable
      // afterwards if only the mode and window were recorded.
      await deps.audit({
        action: 'start',
        actor,
        runId: runs[0]?.id ?? null,
        mode: request.mode,
        targetGroups,
        detail: {
          estimatedCount: estimate.eventCount,
          runIds: runs.map((r) => r.id),
          scope: request,
        },
      });
      return runs;
    },

    status(runId): Promise<ReplayRun | null> {
      return loadRun(runId);
    },

    /** Pause RETAINS the token, so a paused run cannot be overtaken. */
    async pause(runId, actor): Promise<void> {
      const run = await loadRun(runId);
      if (run === null) throw new ReplayRejectedError(`No replay run '${runId}'.`);
      await setStatus(runId, 'paused');
      await deps.audit({
        action: 'pause',
        actor,
        runId,
        mode: run.mode,
        targetGroups: [run.targetGroup],
        detail: { delivered: run.delivered },
      });
    },

    async resume(runId, actor): Promise<void> {
      const run = await loadRun(runId);
      if (run === null) throw new ReplayRejectedError(`No replay run '${runId}'.`);
      if (run.status !== 'paused') {
        throw new ReplayRejectedError(`Run '${runId}' is '${run.status}', not paused.`);
      }
      await setStatus(runId, 'running');
      await deps.audit({
        action: 'resume',
        actor,
        runId,
        mode: run.mode,
        targetGroups: [run.targetGroup],
        detail: { checkpoint: run.checkpoint },
      });
    },

    /**
     * Abort is terminal and RELEASES the token. Already-delivered events are
     * NOT rolled back: handlers committed their effects, and a compensating
     * replay would be a second uncontrolled operation. `delivered` records
     * exactly how far it got.
     */
    async abort(runId, actor, reason): Promise<void> {
      const run = await loadRun(runId);
      if (run === null) throw new ReplayRejectedError(`No replay run '${runId}'.`);
      await setStatus(runId, 'aborted');
      await deps.audit({
        action: 'abort',
        actor,
        runId,
        mode: run.mode,
        targetGroups: [run.targetGroup],
        detail: { reason, delivered: run.delivered },
      });
    },

    async execute(runId, signal): Promise<ReplayRun> {
      const initial = await loadRun(runId);
      if (initial === null) throw new ReplayRejectedError(`No replay run '${runId}'.`);
      if (initial.status === 'completed' || initial.status === 'aborted') return initial;

      const request = initial.request;
      const group = initial.targetGroup;

      let delivered = initial.delivered;
      let skipped = initial.skipped;
      let suppressed = initial.suppressedAsDuplicate;
      const skipReasons: Record<string, number> = { ...initial.skipReasons };
      // Resume from the checkpoint: at most `checkpointInterval` events are
      // re-delivered after an interruption, and idempotency suppresses them.
      let cursor = initial.checkpoint ?? '0';
      let sinceCheckpoint = 0;

      const recordSkip = (reason: string, eventId: string): void => {
        skipped += 1;
        skipReasons[reason] = (skipReasons[reason] ?? 0) + 1;
        deps.onSkip?.(runId, reason, eventId);
      };

      const persist = async (): Promise<void> => {
        await deps.transaction((tx) =>
          tx.query(SAVE_PROGRESS_SQL, [
            runId,
            delivered,
            skipped,
            suppressed,
            JSON.stringify(skipReasons),
            cursor,
          ]),
        );
        deps.onProgress?.({
          runId,
          targetGroup: group,
          delivered,
          skipped,
          suppressedAsDuplicate: suppressed,
          checkpoint: cursor,
        });
      };

      await setStatus(runId, 'running');

      try {
        for (;;) {
          if (signal?.aborted === true) {
            await persist();
            await setStatus(runId, 'paused');
            return (await loadRun(runId)) ?? initial;
          }

          // Status is re-read each batch so pause and abort take effect
          // without needing to reach into the loop.
          const current = await loadRun(runId);
          if (current === null) throw new ReplayRejectedError(`Run '${runId}' vanished.`);
          if (current.status === 'paused' || current.status === 'aborted') {
            await persist();
            return (await loadRun(runId)) ?? current;
          }

          // BACKPRESSURE: replay yields to live traffic. A rebuild that pushes
          // a consumer past its SLO has converted maintenance into a
          // customer-visible incident.
          if (deps.lagSeconds !== undefined) {
            const lag = await deps.lagSeconds(group);
            if (lag > lagThreshold) {
              deps.onBackpressurePause?.(runId, group, lag);
              await persist();
              await setStatus(runId, 'paused');
              return (await loadRun(runId)) ?? current;
            }
          }

          const batch = await deps.transaction((tx) => readBatch(tx, request, cursor));
          if (batch.length === 0) break;

          const batchStarted = now().getTime();

          for (const { key, event } of batch) {
            // REGISTRY VALIDATION IS NEVER BYPASSED. A three-week-old event may
            // reference a version since retired or a schema since narrowed;
            // validating on the way back in is what stops replay becoming a
            // channel that injects payloads no current consumer accepts.
            const validation = deps.registry.validate(event);
            if (!validation.ok) {
              recordSkip(SKIP_REASONS.registryRejected, event.eventId);
              cursor = key;
              sinceCheckpoint += 1;
              continue;
            }

            if (deps.isTenantErased !== undefined && (await deps.isTenantErased(event.tenantId))) {
              recordSkip(SKIP_REASONS.tenantErased, event.eventId);
              cursor = key;
              sinceCheckpoint += 1;
              continue;
            }

            const ctx: ReplayContext = {
              isReplay: true,
              replayRunId: runId,
              originalOccurredAt: new Date(event.occurredAt),
            };

            const outcome = await deps.deliver(event, group, ctx);
            if (outcome.kind === 'delivered') delivered += 1;
            else if (outcome.kind === 'suppressed-duplicate') suppressed += 1;
            else recordSkip(SKIP_REASONS.deliveryFailed, event.eventId);

            cursor = key;
            sinceCheckpoint += 1;

            if (sinceCheckpoint >= checkpointInterval) {
              await persist();
              sinceCheckpoint = 0;
            }
          }

          // Rate limit: hold the run to `rateLimit` events per second so replay
          // never competes with live delivery for the same capacity.
          const elapsed = now().getTime() - batchStarted;
          const minMs = (batch.length / rateLimit) * 1000;
          if (minMs > elapsed) await sleep(Math.ceil(minMs - elapsed));
        }

        await persist();
        await setStatus(runId, 'completed');
        await deps.audit({
          action: 'complete',
          actor: initial.startedBy,
          runId,
          mode: request.mode,
          targetGroups: [group],
          detail: { delivered, skipped, suppressedAsDuplicate: suppressed, skipReasons },
        });
      } catch (error) {
        // The token is released by reaching a terminal status, so a crashed run
        // does not block the group forever.
        await persist();
        await setStatus(runId, 'failed');
        await deps.audit({
          action: 'fail',
          actor: initial.startedBy,
          runId,
          mode: request.mode,
          targetGroups: [group],
          detail: {
            delivered,
            skipped,
            error: error instanceof Error ? error.message : String(error),
          },
        });
        throw error;
      }

      return (await loadRun(runId)) ?? initial;
    },
  };
}
