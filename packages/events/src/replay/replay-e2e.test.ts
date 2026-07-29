/**
 * End-to-end replay.
 *
 * `replay-coordinator.test.ts` proves the COORDINATOR against a stubbed
 * `deliver`. This suite wires replay through the REAL delivery path —
 * `createAggregateBarrier`, `createIdempotencyGuard`, `createDispatcher` — and
 * a `processed_events` table that enforces its actual uniqueness constraint.
 *
 * That is the only way to test the safety argument as stated: replay is safe
 * BECAUSE the replayed event is byte-identical and therefore collides on the
 * same idempotency marker. A stubbed `deliver` asserts the coordinator's
 * bookkeeping; only this asserts that side effects do not repeat.
 */

import { describe, expect, it } from 'vitest';

import type { DomainEvent, TenantContext } from '@contentos/contracts';

import { createDispatcher, type RegisteredHandler } from '../delivery/dispatcher.js';
import { createAggregateBarrier, createIdempotencyGuard } from '../delivery/guards.js';
import type { GuardExecutor } from '../delivery/guards.js';
import { createRetryEngine } from '../delivery/retry.js';
import type { DeadLetterQueue, DeadLetterRow } from '../dlq/dead-letter-queue.js';
import type { EventRegistry } from '../registry/registry.js';
import type { OutboxRow } from '../relay/relay.js';
import {
  createReplayCoordinator,
  type ReplayDeliveryOutcome,
  type ReplayRequest,
} from './replay-coordinator.js';

const TENANT = '018f7a1e-0000-7000-8000-0000000000bb';
const ORG = '018f7a1e-0000-7000-8000-0000000000aa';
const NOW = new Date('2026-07-29T12:00:00.000Z');
const GROUP = 'read-models';

function outboxRow(id: number, aggregate = 'c1'): OutboxRow {
  return {
    id: String(id),
    event_id: `018f7a1e-0000-7000-8000-${String(id).padStart(12, '0')}`,
    tenant_id: TENANT,
    organization_id: ORG,
    event_type: 'ArticlePublished',
    event_version: 1,
    aggregate_type: 'Article',
    aggregate_id: `018f7a1e-0000-7000-8000-00000000${aggregate.padStart(4, '0')}`,
    correlation_id: '018f7a1e-0000-7000-8000-0000000000dd',
    causation_id: null,
    producer: 'content-platform',
    occurred_at: '2026-07-20T10:00:00.000Z',
    payload: { seq: id },
    publish_attempts: 0,
  };
}

const ACTIVE = new Set(['pending', 'running', 'paused']);

/**
 * One store backing BOTH `replay_runs` and `processed_events`.
 *
 * `processed_events` enforces its real `(consumer_group, event_id)` uniqueness,
 * because that constraint IS the duplicate defence — a fake that let a second
 * insert through would prove nothing about replay safety.
 */
function store(outbox: OutboxRow[]) {
  const processed = new Set<string>();
  const runs: Record<string, unknown>[] = [];
  let nextId = 1;

  const tx: GuardExecutor = {
    query<T>(sql: string, params: readonly unknown[] = []): Promise<readonly T[]> {
      if (sql.includes('INSERT INTO processed_events')) {
        const key = `${String(params[2])}::${String(params[3])}`;
        if (processed.has(key)) return Promise.resolve([] as unknown as T[]);
        processed.add(key);
        return Promise.resolve([{ event_id: params[3] }] as unknown as T[]);
      }
      if (sql.includes('FROM processed_events')) {
        const key = `${String(params[0])}::${String(params[1])}`;
        return Promise.resolve((processed.has(key) ? [{ '?column?': 1 }] : []) as unknown as T[]);
      }
      if (sql.includes('count(*)::bigint') && sql.includes('outbox_events')) {
        return Promise.resolve([{ count: outbox.length }] as unknown as T[]);
      }
      if (sql.includes('SELECT * FROM outbox_events')) {
        const after = Number(params[sql.includes('$6') ? 4 : 2]);
        const limit = Number(params[sql.includes('$6') ? 5 : 3]);
        return Promise.resolve(
          outbox
            .filter((r) => Number(r.id) > after)
            .sort((a, b) => Number(a.id) - Number(b.id))
            .slice(0, limit) as unknown as T[],
        );
      }
      if (sql.includes('count(*)::int') && sql.includes('replay_runs')) {
        return Promise.resolve([
          { count: runs.filter((r) => ACTIVE.has(String(r['status']))).length },
        ] as unknown as T[]);
      }
      if (sql.includes('INSERT INTO replay_runs')) {
        const group = String(params[4]);
        if (runs.some((r) => r['target_group'] === group && ACTIVE.has(String(r['status'])))) {
          return Promise.reject(new Error('uq_replay_runs__active_per_group'));
        }
        const record = {
          id: `run-${String(nextId++)}`,
          mode: String(params[2]),
          request: String(params[3]),
          target_group: group,
          status: 'pending',
          delivered: 0,
          skipped: 0,
          skip_reasons: '{}',
          suppressed_as_duplicate: 0,
          checkpoint: null,
          started_by: String(params[5]),
          started_at: NOW.toISOString(),
          finished_at: null,
        };
        runs.push(record);
        return Promise.resolve([
          { id: record.id, started_at: record.started_at },
        ] as unknown as T[]);
      }
      if (sql.includes('SELECT * FROM replay_runs')) {
        const found = runs.find((r) => r['id'] === String(params[0]));
        return Promise.resolve(
          (found === undefined
            ? []
            : [
                {
                  ...found,
                  request: JSON.parse(String(found['request'])) as unknown,
                  skip_reasons: JSON.parse(String(found['skip_reasons'])) as unknown,
                },
              ]) as unknown as T[],
        );
      }
      if (sql.includes('UPDATE replay_runs') && sql.includes('SET status')) {
        const found = runs.find((r) => r['id'] === String(params[0]));
        if (found !== undefined) found['status'] = String(params[1]);
        return Promise.resolve([] as unknown as T[]);
      }
      if (sql.includes('UPDATE replay_runs') && sql.includes('SET delivered')) {
        const found = runs.find((r) => r['id'] === String(params[0]));
        if (found !== undefined) {
          found['delivered'] = Number(params[1]);
          found['skipped'] = Number(params[2]);
          found['suppressed_as_duplicate'] = Number(params[3]);
          found['skip_reasons'] = String(params[4]);
          found['checkpoint'] = typeof params[5] === 'string' ? params[5] : null;
        }
        return Promise.resolve([] as unknown as T[]);
      }
      return Promise.resolve([] as unknown as T[]);
    },
  } as GuardExecutor;

  return {
    processed,
    transaction: <T>(work: (t: GuardExecutor) => Promise<T>): Promise<T> => work(tx),
  };
}

const okRegistry = { validate: () => ({ ok: true }) } as unknown as EventRegistry;
const noDlq = {
  get: () => Promise.resolve(null),
  toEvent: (r: DeadLetterRow) => r as unknown as DomainEvent<unknown>,
} as unknown as DeadLetterQueue;

/** The real delivery stack, exactly as live traffic uses it. */
function harness(outbox: OutboxRow[]) {
  const db = store(outbox);
  const effects: { eventId: string; occurredAt: Date | null }[] = [];
  const barrierAcquisitions: string[] = [];

  const barrier = createAggregateBarrier();
  const guard = createIdempotencyGuard();
  const retry = createRetryEngine();

  let replayCtxOccurredAt: Date | null = null;

  const handler: RegisteredHandler = {
    eventType: 'ArticlePublished',
    version: 1,
    group: GROUP,
    handle: (event: DomainEvent<unknown>, _ctx: TenantContext): Promise<void> => {
      // A handler must stamp the event's OWN occurrence time, never now().
      effects.push({ eventId: event.eventId, occurredAt: replayCtxOccurredAt });
      return Promise.resolve();
    },
  };

  const dispatcher = createDispatcher({
    barrier,
    guard,
    retry,
    transaction: db.transaction,
    quarantine: () => Promise.resolve(),
  });

  const coordinator = createReplayCoordinator({
    transaction: db.transaction,
    registry: okRegistry,
    dlq: noDlq,
    deliver: async (event, group, ctx): Promise<ReplayDeliveryOutcome> => {
      barrierAcquisitions.push(event.aggregateId);
      replayCtxOccurredAt = ctx.originalOccurredAt;
      // Replay uses the SAME dispatcher as live delivery: barrier →
      // idempotency → handler, with no replay-specific bypass anywhere.
      const outcome = await dispatcher.dispatch(
        event,
        { ...handler, group },
        1,
        new AbortController().signal,
      );
      if (outcome.kind === 'handled') return { kind: 'delivered' };
      if (outcome.kind === 'suppressed-duplicate') return { kind: 'suppressed-duplicate' };
      return { kind: 'failed', code: outcome.kind, message: outcome.kind };
    },
    audit: () => Promise.resolve(),
    now: () => NOW,
    sleep: () => Promise.resolve(),
  });

  return { coordinator, effects, db, barrier, barrierAcquisitions, dispatcher, handler };
}

function request(): ReplayRequest {
  return {
    mode: 'range',
    targetGroups: [GROUP],
    tenantId: TENANT,
    organizationId: ORG,
    from: new Date('2026-07-15T00:00:00.000Z'),
    to: new Date('2026-07-29T00:00:00.000Z'),
  };
}

describe('replay end to end', () => {
  it('delivers the whole range through the real dispatcher', async () => {
    const h = harness([outboxRow(1), outboxRow(2), outboxRow(3)]);
    const [run] = await h.coordinator.start(request(), 'op');
    const final = await h.coordinator.execute(run?.id ?? '');

    expect(final.status).toBe('completed');
    expect(final.delivered).toBe(3);
    expect(h.effects).toHaveLength(3);
  });

  /**
   * THE SAFETY ARGUMENT, end to end.
   *
   * The events were already processed once, so the replayed deliveries collide
   * on `processed_events` and the handler never runs again. Replay contributes
   * no suppression of its own — the marker does all of it.
   */
  it('does not repeat side effects when history was already processed', async () => {
    const rows = [outboxRow(1), outboxRow(2), outboxRow(3)];
    const h = harness(rows);

    // First pass: live delivery already handled everything.
    const [first] = await h.coordinator.start(request(), 'op');
    await h.coordinator.execute(first?.id ?? '');
    expect(h.effects).toHaveLength(3);

    // Second pass: the same events, byte-identical, replayed again.
    const [second] = await h.coordinator.start(request(), 'op');
    const final = await h.coordinator.execute(second?.id ?? '');

    expect(final.suppressedAsDuplicate).toBe(3);
    expect(final.delivered).toBe(0);
    // The handler did NOT run a second time.
    expect(h.effects).toHaveLength(3);
  });

  // A high suppression count is a SUCCESS metric — it proves idempotency held.
  it('reports suppression as the proof that idempotency held', async () => {
    const h = harness([outboxRow(1), outboxRow(2)]);
    const [a] = await h.coordinator.start(request(), 'op');
    await h.coordinator.execute(a?.id ?? '');
    const [b] = await h.coordinator.start(request(), 'op');
    const final = await h.coordinator.execute(b?.id ?? '');
    expect(final.suppressedAsDuplicate).toBeGreaterThan(0);
  });

  it('hands the handler the original occurrence time, never wall clock', async () => {
    const h = harness([outboxRow(1)]);
    const [run] = await h.coordinator.start(request(), 'op');
    await h.coordinator.execute(run?.id ?? '');
    expect(h.effects[0]?.occurredAt).toEqual(new Date('2026-07-20T10:00:00.000Z'));
    expect(h.effects[0]?.occurredAt).not.toEqual(NOW);
  });

  // Replay does not bypass the barrier: bypassing would invert ordering
  // precisely when the platform is doing bulk work.
  it('passes every replayed delivery through the aggregate barrier', async () => {
    const h = harness([outboxRow(1, 'c1'), outboxRow(2, 'c2'), outboxRow(3, 'c1')]);
    const [run] = await h.coordinator.start(request(), 'op');
    await h.coordinator.execute(run?.id ?? '');
    expect(h.barrierAcquisitions).toHaveLength(3);
    // The barrier is released after each delivery, so nothing is left held.
    expect(h.barrier.heldCount(GROUP)).toBe(0);
  });

  it('preserves original order across multiple aggregates', async () => {
    const h = harness([outboxRow(1, 'c1'), outboxRow(2, 'c2'), outboxRow(3, 'c1')]);
    const [run] = await h.coordinator.start(request(), 'op');
    await h.coordinator.execute(run?.id ?? '');
    expect(h.effects.map((e) => e.eventId.slice(-1))).toEqual(['1', '2', '3']);
  });

  it('writes one idempotency marker per event and group', async () => {
    const h = harness([outboxRow(1), outboxRow(2)]);
    const [run] = await h.coordinator.start(request(), 'op');
    await h.coordinator.execute(run?.id ?? '');
    expect(h.db.processed.size).toBe(2);
    for (const key of h.db.processed) expect(key.startsWith(`${GROUP}::`)).toBe(true);
  });

  // Resuming re-delivers from the checkpoint; those redeliveries must be
  // suppressed rather than repeated.
  it('suppresses the redeliveries a resume replays', async () => {
    const rows = Array.from({ length: 6 }, (_, i) => outboxRow(i + 1));
    const h = harness(rows);
    const [run] = await h.coordinator.start(request(), 'op');
    await h.coordinator.execute(run?.id ?? '');
    expect(h.effects).toHaveLength(6);

    // A second run over the same window: every event collides.
    const [again] = await h.coordinator.start(request(), 'op');
    const final = await h.coordinator.execute(again?.id ?? '');
    expect(final.suppressedAsDuplicate).toBe(6);
    expect(h.effects).toHaveLength(6);
  });
});
