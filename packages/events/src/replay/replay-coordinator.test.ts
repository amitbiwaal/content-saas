import { describe, expect, it } from 'vitest';

import type { DomainEvent } from '@contentos/contracts';

import type { GuardExecutor } from '../delivery/guards.js';
import type { DeadLetterQueue, DeadLetterRow } from '../dlq/dead-letter-queue.js';
import type { EventRegistry } from '../registry/registry.js';
import type { OutboxRow } from '../relay/relay.js';
import {
  createReplayCoordinator,
  MAX_CONCURRENT_RUNS,
  OUTBOX_RETENTION_DAYS,
  ReplayRejectedError,
  SKIP_REASONS,
  type ReplayAuditEntry,
  type ReplayContext,
  type ReplayDeliveryOutcome,
  type ReplayDeps,
  type ReplayRequest,
} from './replay-coordinator.js';

const TENANT = '018f7a1e-0000-7000-8000-0000000000bb';
const ORG = '018f7a1e-0000-7000-8000-0000000000aa';
const NOW = new Date('2026-07-29T12:00:00.000Z');

function row(id: number, over: Partial<OutboxRow> = {}): OutboxRow {
  return {
    id: String(id),
    event_id: `018f7a1e-0000-7000-8000-${String(id).padStart(12, '0')}`,
    tenant_id: TENANT,
    organization_id: ORG,
    event_type: 'ArticlePublished',
    event_version: 1,
    aggregate_type: 'Article',
    aggregate_id: '018f7a1e-0000-7000-8000-0000000000c1',
    correlation_id: '018f7a1e-0000-7000-8000-0000000000dd',
    causation_id: null,
    producer: 'content-platform',
    occurred_at: '2026-07-20T10:00:00.000Z',
    payload: { seq: id },
    publish_attempts: 0,
    ...over,
  };
}

interface RunRecord {
  id: string;
  mode: string;
  request: string;
  target_group: string;
  status: string;
  delivered: number;
  skipped: number;
  skip_reasons: string;
  suppressed_as_duplicate: number;
  checkpoint: string | null;
  started_by: string;
  started_at: string;
  finished_at: string | null;
}

const ACTIVE = new Set(['pending', 'running', 'paused']);

/**
 * In-memory stand-in for `replay_runs` and `outbox_events`.
 *
 * It models the PARTIAL UNIQUE INDEX, because that constraint is the whole
 * coordination token: a fake that let two active runs coexist for one group
 * would assert the test's assumptions rather than the schema's.
 */
function db(outbox: OutboxRow[] = []) {
  const runs: RunRecord[] = [];
  let nextId = 1;

  const tx: GuardExecutor = {
    query<T>(sql: string, params: readonly unknown[] = []): Promise<readonly T[]> {
      if (sql.includes('count(*)::bigint') && sql.includes('outbox_events')) {
        return Promise.resolve([{ count: outbox.length }] as unknown as T[]);
      }
      if (sql.includes('SELECT * FROM outbox_events')) {
        const after = String(params[sql.includes('$6') ? 4 : 2]);
        const limit = Number(params[sql.includes('$6') ? 5 : 3]);
        const page = outbox
          .filter((r) => Number(r.id) > Number(after))
          .sort((a, b) => Number(a.id) - Number(b.id))
          .slice(0, limit);
        return Promise.resolve(page as unknown as T[]);
      }
      if (sql.includes('count(*)::int') && sql.includes('replay_runs')) {
        return Promise.resolve([
          { count: runs.filter((r) => ACTIVE.has(r.status)).length },
        ] as unknown as T[]);
      }
      if (sql.includes('INSERT INTO replay_runs')) {
        const group = String(params[4]);
        // The partial unique index.
        if (runs.some((r) => r.target_group === group && ACTIVE.has(r.status))) {
          return Promise.reject(
            new Error(
              'duplicate key value violates unique constraint "uq_replay_runs__active_per_group"',
            ),
          );
        }
        const record: RunRecord = {
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
        const found = runs.find((r) => r.id === String(params[0]));
        // A real driver hands back JSONB already parsed.
        return Promise.resolve(
          (found === undefined
            ? []
            : [
                {
                  ...found,
                  request: JSON.parse(found.request) as unknown,
                  skip_reasons: JSON.parse(found.skip_reasons) as unknown,
                },
              ]) as unknown as T[],
        );
      }
      if (sql.includes('UPDATE replay_runs') && sql.includes('SET status')) {
        const found = runs.find((r) => r.id === String(params[0]));
        if (found !== undefined) {
          found.status = String(params[1]);
          if (['completed', 'aborted', 'failed'].includes(found.status)) {
            found.finished_at = NOW.toISOString();
          }
        }
        return Promise.resolve([] as unknown as T[]);
      }
      if (sql.includes('UPDATE replay_runs') && sql.includes('SET delivered')) {
        const found = runs.find((r) => r.id === String(params[0]));
        if (found !== undefined) {
          found.delivered = Number(params[1]);
          found.skipped = Number(params[2]);
          found.suppressed_as_duplicate = Number(params[3]);
          found.skip_reasons = String(params[4]);
          found.checkpoint = typeof params[5] === 'string' ? params[5] : null;
        }
        return Promise.resolve([] as unknown as T[]);
      }
      return Promise.resolve([] as unknown as T[]);
    },
  } as GuardExecutor;

  return {
    runs,
    transaction: <T>(work: (t: GuardExecutor) => Promise<T>): Promise<T> => work(tx),
  };
}

const okRegistry: EventRegistry = {
  validate: () => ({ ok: true }),
} as unknown as EventRegistry;

const noDlq = {
  get: () => Promise.resolve(null),
  toEvent: (r: DeadLetterRow) => r as unknown as DomainEvent<unknown>,
} as unknown as DeadLetterQueue;

function coordinator(over: Partial<ReplayDeps> = {}, outbox: OutboxRow[] = []) {
  const store = db(outbox);
  const audits: ReplayAuditEntry[] = [];
  const delivered: { eventId: string; group: string; ctx: ReplayContext }[] = [];
  const deps: ReplayDeps = {
    transaction: store.transaction,
    registry: okRegistry,
    dlq: noDlq,
    deliver: (event, group, ctx): Promise<ReplayDeliveryOutcome> => {
      delivered.push({ eventId: event.eventId, group, ctx });
      return Promise.resolve({ kind: 'delivered' });
    },
    audit: (e) => {
      audits.push(e);
      return Promise.resolve();
    },
    now: () => NOW,
    sleep: () => Promise.resolve(),
    ...over,
  };
  return { instance: createReplayCoordinator(deps), store, audits, delivered };
}

/** A second coordinator over an EXISTING store — models a replacement worker. */
function createCoordinatorOver(
  existing: ReturnType<typeof coordinator>,
  over: Partial<ReplayDeps>,
): ReturnType<typeof createReplayCoordinator> {
  return createReplayCoordinator({
    transaction: existing.store.transaction,
    registry: okRegistry,
    dlq: noDlq,
    deliver: () => Promise.resolve({ kind: 'delivered' }),
    audit: () => Promise.resolve(),
    now: () => NOW,
    sleep: () => Promise.resolve(),
    ...over,
  });
}

function request(over: Partial<ReplayRequest> = {}): ReplayRequest {
  return {
    mode: 'range',
    targetGroups: ['read-models'],
    tenantId: TENANT,
    organizationId: ORG,
    from: new Date('2026-07-15T00:00:00.000Z'),
    to: new Date('2026-07-29T00:00:00.000Z'),
    ...over,
  } as ReplayRequest;
}

describe('estimation precedes execution', () => {
  it('counts the scope before anything is delivered', async () => {
    const c = coordinator({}, [row(1), row(2), row(3)]);
    const estimate = await c.instance.estimate(request(), 'op');
    expect(estimate.eventCount).toBe(3);
    expect(estimate.withinBounds).toBe(true);
    expect(c.delivered).toHaveLength(0);
  });

  // Beyond retention the source rows no longer exist. A partial set that looks
  // like a completed rebuild is worse than an explicit rejection.
  it('rejects a range reaching past outbox retention', async () => {
    const c = coordinator();
    const tooOld = new Date(NOW.getTime() - (OUTBOX_RETENTION_DAYS + 1) * 86_400_000);
    const estimate = await c.instance.estimate(request({ from: tooOld }), 'op');
    expect(estimate.withinBounds).toBe(false);
    expect(estimate.rejectionReason).toMatch(/retention/i);
  });

  it('rejects an inverted range', async () => {
    const c = coordinator();
    const estimate = await c.instance.estimate(
      request({ from: new Date('2026-07-20'), to: new Date('2026-07-10') }),
      'op',
    );
    expect(estimate.withinBounds).toBe(false);
  });

  it('rejects a scope beyond the bound', async () => {
    const c = coordinator({ maxEvents: 2 }, [row(1), row(2), row(3)]);
    const estimate = await c.instance.estimate(request(), 'op');
    expect(estimate.withinBounds).toBe(false);
    expect(estimate.rejectionReason).toMatch(/exceeds the bound/);
  });

  it('refuses to start a rejected scope', async () => {
    const c = coordinator({ maxEvents: 1 }, [row(1), row(2)]);
    await expect(c.instance.start(request(), 'op')).rejects.toBeInstanceOf(ReplayRejectedError);
  });

  it('audits every estimate', async () => {
    const c = coordinator({}, [row(1)]);
    await c.instance.estimate(request(), 'operator-a');
    expect(c.audits[0]?.action).toBe('estimate');
    expect(c.audits[0]?.actor).toBe('operator-a');
  });
});

describe('coordination token', () => {
  it('creates one run per target group', async () => {
    const c = coordinator({}, [row(1)]);
    const runs = await c.instance.start(request({ targetGroups: ['a', 'b'] }), 'op');
    expect(runs.map((r) => r.targetGroup)).toEqual(['a', 'b']);
  });

  // Two concurrent rebuilds of one projection interleave writes and produce a
  // corrupt result that passes every superficial check.
  it('refuses a second run against a group that already has one', async () => {
    const c = coordinator({}, [row(1)]);
    await c.instance.start(request({ targetGroups: ['a'] }), 'op');
    await expect(c.instance.start(request({ targetGroups: ['a'] }), 'op')).rejects.toThrow(
      /uq_replay_runs__active_per_group/,
    );
  });

  // All rows insert in one transaction, so a partially-started replay — some
  // groups running, others rejected — is not a reachable state.
  it('starts nothing when one group of several is already active', async () => {
    const c = coordinator({}, [row(1)]);
    await c.instance.start(request({ targetGroups: ['a'] }), 'op');
    await expect(
      c.instance.start(request({ targetGroups: ['b', 'a'] }), 'op'),
    ).rejects.toBeInstanceOf(Error);
    expect(c.store.runs.filter((r) => r.target_group === 'b')).toHaveLength(0);
  });

  it('bounds platform-wide concurrency', async () => {
    const c = coordinator({}, [row(1)]);
    const groups = Array.from({ length: MAX_CONCURRENT_RUNS + 1 }, (_, i) => `g${String(i)}`);
    await expect(
      c.instance.start(request({ targetGroups: groups as [string, ...string[]] }), 'op'),
    ).rejects.toThrow(/concurrent replays/);
  });

  it('releases the token on a terminal status', async () => {
    const c = coordinator({}, [row(1)]);
    const [run] = await c.instance.start(request({ targetGroups: ['a'] }), 'op');
    await c.instance.abort(run?.id ?? '', 'op', 'no longer needed');
    // The group is free again.
    await expect(c.instance.start(request({ targetGroups: ['a'] }), 'op')).resolves.toHaveLength(1);
  });
});

describe('delivery', () => {
  it('delivers every event in the scope to the target group', async () => {
    const c = coordinator({}, [row(1), row(2), row(3)]);
    const [run] = await c.instance.start(request(), 'op');
    const final = await c.instance.execute(run?.id ?? '');
    expect(final.delivered).toBe(3);
    expect(final.status).toBe('completed');
    expect(c.delivered.map((d) => d.group)).toEqual(['read-models', 'read-models', 'read-models']);
  });

  // Selection is by `outbox_events.id` — the sequence that DEFINED publication
  // order — so the original per-aggregate order is preserved by construction.
  it('preserves original publication order', async () => {
    const shuffled = [row(3), row(1), row(2)];
    const c = coordinator({}, shuffled);
    const [run] = await c.instance.start(request(), 'op');
    await c.instance.execute(run?.id ?? '');
    expect(
      c.delivered.map((d) => (d.eventId.endsWith('1') ? 1 : d.eventId.endsWith('2') ? 2 : 3)),
    ).toEqual([1, 2, 3]);
  });

  it('pages through a scope larger than one batch, without repeating', async () => {
    const rows = Array.from({ length: 25 }, (_, i) => row(i + 1));
    const c = coordinator({ batchSize: 10 }, rows);
    const [run] = await c.instance.start(request(), 'op');
    const final = await c.instance.execute(run?.id ?? '');
    expect(final.delivered).toBe(25);
    expect(new Set(c.delivered.map((d) => d.eventId)).size).toBe(25);
  });

  it('hands the handler the ORIGINAL occurrence time, never now()', async () => {
    const c = coordinator({}, [row(1, { occurred_at: '2026-07-01T08:00:00.000Z' })]);
    const [run] = await c.instance.start(request(), 'op');
    await c.instance.execute(run?.id ?? '');
    expect(c.delivered[0]?.ctx.originalOccurredAt).toEqual(new Date('2026-07-01T08:00:00.000Z'));
    expect(c.delivered[0]?.ctx.originalOccurredAt).not.toEqual(NOW);
  });

  it('marks the delivery as a replay and names the run', async () => {
    const c = coordinator({}, [row(1)]);
    const [run] = await c.instance.start(request(), 'op');
    await c.instance.execute(run?.id ?? '');
    expect(c.delivered[0]?.ctx.isReplay).toBe(true);
    expect(c.delivered[0]?.ctx.replayRunId).toBe(run?.id);
  });

  it('audits completion with the full counters', async () => {
    const c = coordinator({}, [row(1), row(2)]);
    const [run] = await c.instance.start(request(), 'op');
    await c.instance.execute(run?.id ?? '');
    const complete = c.audits.find((a) => a.action === 'complete');
    expect(complete?.detail['delivered']).toBe(2);
    expect(complete?.targetGroups).toEqual(['read-models']);
  });
});

describe('idempotency is the sole duplicate defence', () => {
  // Replay adds no suppression of its own; it counts what the guard suppressed.
  it('counts suppressed duplicates rather than suppressing them itself', async () => {
    const c = coordinator({ deliver: () => Promise.resolve({ kind: 'suppressed-duplicate' }) }, [
      row(1),
      row(2),
    ]);
    const [run] = await c.instance.start(request(), 'op');
    const final = await c.instance.execute(run?.id ?? '');
    expect(final.suppressedAsDuplicate).toBe(2);
    expect(final.delivered).toBe(0);
  });

  it('reports a mix of delivered and suppressed', async () => {
    let n = 0;
    const c = coordinator(
      {
        deliver: () => {
          n += 1;
          return Promise.resolve(
            n % 2 === 0
              ? ({ kind: 'suppressed-duplicate' } as const)
              : ({ kind: 'delivered' } as const),
          );
        },
      },
      [row(1), row(2), row(3), row(4)],
    );
    const [run] = await c.instance.start(request(), 'op');
    const final = await c.instance.execute(run?.id ?? '');
    expect(final.delivered).toBe(2);
    expect(final.suppressedAsDuplicate).toBe(2);
  });

  // Re-delivering after a crash is safe AND EXPECTED — the suppression count
  // is the proof idempotency held.
  it('re-delivers from the checkpoint after an interruption, and duplicates are suppressed', async () => {
    const rows = Array.from({ length: 6 }, (_, i) => row(i + 1));
    let seen = 0;
    const c = coordinator(
      {
        batchSize: 3,
        checkpointInterval: 3,
        deliver: () => {
          seen += 1;
          // Crash partway through the second batch.
          if (seen === 5) throw new Error('worker died');
          return Promise.resolve({ kind: 'delivered' });
        },
      },
      rows,
    );
    const [run] = await c.instance.start(request(), 'op');
    await expect(c.instance.execute(run?.id ?? '')).rejects.toThrow('worker died');

    const failed = await c.instance.status(run?.id ?? '');
    expect(failed?.status).toBe('failed');
    // Event 4 was delivered before event 5 threw, so the cursor legitimately
    // includes it; event 5 is not recorded and is re-delivered on resume.
    expect(failed?.checkpoint).toBe('4');
  });

  // A failed run persists exactly what SUCCEEDED, so a replacement worker
  // continues rather than restarting. (The "at most 1,000 re-delivered" bound
  // in ADR-028 covers process death, where no catch runs and only the last
  // periodic checkpoint survives; that path cannot be driven through this seam,
  // and it is bounded structurally by `checkpointInterval`.)
  it('resumes from the last successful event after a failure, without restarting', async () => {
    const rows = Array.from({ length: 10 }, (_, i) => row(i + 1));
    let seen = 0;
    const first = coordinator(
      {
        batchSize: 10,
        checkpointInterval: 4,
        deliver: () => {
          seen += 1;
          if (seen > 7) return Promise.reject(new Error('worker died'));
          return Promise.resolve({ kind: 'delivered' as const });
        },
      },
      rows,
    );
    const [run] = await first.instance.start(request(), 'op');
    const runId = run?.id ?? '';
    await expect(first.instance.execute(runId)).rejects.toThrow('worker died');

    const after = await first.instance.status(runId);
    expect(after?.status).toBe('failed');
    expect(after?.checkpoint).toBe('7');
    expect(after?.delivered).toBe(7);

    // A replacement worker picks up at 8 — it does not redo 1-7.
    const replayed: string[] = [];
    const replacement = createCoordinatorOver(first, {
      batchSize: 10,
      deliver: (event) => {
        replayed.push(event.eventId);
        return Promise.resolve({ kind: 'delivered' });
      },
    });
    const resumed = await replacement.execute(runId);
    expect(resumed.status).toBe('completed');
    expect(replayed).toHaveLength(3);
    expect(resumed.delivered).toBe(10);
  });
});

describe('validation is never bypassed', () => {
  it('skips and records an event the registry rejects', async () => {
    const registry = {
      validate: (e: DomainEvent<unknown>) =>
        e.eventId.endsWith('2') ? { ok: false, error: new Error('retired') } : { ok: true },
    } as unknown as EventRegistry;
    const c = coordinator({ registry }, [row(1), row(2), row(3)]);
    const [run] = await c.instance.start(request(), 'op');
    const final = await c.instance.execute(run?.id ?? '');

    expect(final.delivered).toBe(2);
    expect(final.skipped).toBe(1);
    expect(final.skipReasons[SKIP_REASONS.registryRejected]).toBe(1);
    // Skipped means NOT DELIVERED, not merely counted.
    expect(c.delivered.map((d) => d.eventId)).not.toContain(row(2).event_id);
  });

  // Replaying an event for an erased tenant would resurrect data destroyed
  // under a right-to-erasure request.
  it('skips events belonging to an erased tenant', async () => {
    const c = coordinator({ isTenantErased: () => Promise.resolve(true) }, [row(1), row(2)]);
    const [run] = await c.instance.start(request(), 'op');
    const final = await c.instance.execute(run?.id ?? '');
    expect(final.delivered).toBe(0);
    expect(final.skipReasons[SKIP_REASONS.tenantErased]).toBe(2);
    expect(c.delivered).toHaveLength(0);
  });

  it('records a delivery failure as a skip with its own reason', async () => {
    const c = coordinator(
      { deliver: () => Promise.resolve({ kind: 'failed', code: 'HandlerError', message: 'boom' }) },
      [row(1)],
    );
    const [run] = await c.instance.start(request(), 'op');
    const final = await c.instance.execute(run?.id ?? '');
    expect(final.skipReasons[SKIP_REASONS.deliveryFailed]).toBe(1);
  });

  it('reports skips per reason so an operator learns what was missed', async () => {
    const registry = {
      validate: (e: DomainEvent<unknown>) =>
        e.eventId.endsWith('1') ? { ok: false, error: new Error('x') } : { ok: true },
    } as unknown as EventRegistry;
    const c = coordinator(
      {
        registry,
        isTenantErased: (t: string) => Promise.resolve(t === TENANT),
      },
      [row(1), row(2)],
    );
    const [run] = await c.instance.start(request(), 'op');
    const final = await c.instance.execute(run?.id ?? '');
    expect(final.skipReasons).toEqual({
      [SKIP_REASONS.registryRejected]: 1,
      [SKIP_REASONS.tenantErased]: 1,
    });
  });
});

describe('cancellation and interruption', () => {
  it('pauses without losing the checkpoint, then resumes from it', async () => {
    const rows = Array.from({ length: 6 }, (_, i) => row(i + 1));
    const c = coordinator({ batchSize: 2, checkpointInterval: 1 }, rows);
    void c;
    const controller = new AbortController();
    let count = 0;
    const c2 = coordinator(
      {
        batchSize: 2,
        checkpointInterval: 1,
        deliver: () => {
          count += 1;
          if (count === 2) controller.abort();
          return Promise.resolve({ kind: 'delivered' });
        },
      },
      rows,
    );
    const [r2] = await c2.instance.start(request(), 'op');
    const afterPause = await c2.instance.execute(r2?.id ?? '', controller.signal);
    expect(afterPause.status).toBe('paused');
    expect(afterPause.delivered).toBe(2);
    expect(afterPause.checkpoint).toBe('2');

    await c2.instance.resume(r2?.id ?? '', 'op');
    const final = await c2.instance.execute(r2?.id ?? '');
    // Resumes from the checkpoint rather than restarting.
    expect(final.delivered).toBe(6);
    expect(final.status).toBe('completed');
  });

  it('stops when the run is aborted mid-flight', async () => {
    const rows = Array.from({ length: 10 }, (_, i) => row(i + 1));
    let runId = '';
    const c: ReturnType<typeof coordinator> = coordinator(
      {
        batchSize: 2,
        deliver: () => {
          void (async (): Promise<void> => {
            await c.instance.abort(runId, 'op', 'operator stopped it');
          })();
          return Promise.resolve({ kind: 'delivered' });
        },
      },
      rows,
    );
    const [run] = await c.instance.start(request(), 'op');
    runId = run?.id ?? '';
    const final = await c.instance.execute(runId);
    expect(final.status).toBe('aborted');
    // Abort does NOT roll back what was already delivered.
    expect(final.delivered).toBeGreaterThan(0);
    expect(final.delivered).toBeLessThan(10);
  });

  it('refuses to resume a run that is not paused', async () => {
    const c = coordinator({}, [row(1)]);
    const [run] = await c.instance.start(request(), 'op');
    await expect(c.instance.resume(run?.id ?? '', 'op')).rejects.toThrow(/not paused/);
  });

  it('audits pause, resume and abort with the actor', async () => {
    const c = coordinator({}, [row(1)]);
    const [run] = await c.instance.start(request(), 'op');
    const id = run?.id ?? '';
    await c.instance.pause(id, 'op-1');
    await c.instance.resume(id, 'op-2');
    await c.instance.abort(id, 'op-3', 'done');
    const actions = c.audits.map((a) => `${a.action}:${a.actor}`);
    expect(actions).toContain('pause:op-1');
    expect(actions).toContain('resume:op-2');
    expect(actions).toContain('abort:op-3');
  });

  it('records the abort reason and how far it got', async () => {
    const c = coordinator({}, [row(1)]);
    const [run] = await c.instance.start(request(), 'op');
    await c.instance.abort(run?.id ?? '', 'op', 'wrong window');
    const abort = c.audits.find((a) => a.action === 'abort');
    expect(abort?.detail['reason']).toBe('wrong window');
    expect(abort?.detail).toHaveProperty('delivered');
  });

  it('marks a crashed run failed so its token is released', async () => {
    const c = coordinator({ deliver: () => Promise.reject(new Error('db down')) }, [row(1)]);
    const [run] = await c.instance.start(request(), 'op');
    await expect(c.instance.execute(run?.id ?? '')).rejects.toThrow('db down');
    const after = await c.instance.status(run?.id ?? '');
    expect(after?.status).toBe('failed');
    // Token released: the group can be replayed again.
    await expect(c.instance.start(request(), 'op')).resolves.toHaveLength(1);
  });

  it('is a no-op on an already-completed run', async () => {
    const c = coordinator({}, [row(1)]);
    const [run] = await c.instance.start(request(), 'op');
    await c.instance.execute(run?.id ?? '');
    const again = await c.instance.execute(run?.id ?? '');
    expect(again.status).toBe('completed');
    expect(c.delivered).toHaveLength(1);
  });
});

describe('backpressure', () => {
  // Replay yields; it never competes. A rebuild pushing a group past its SLO
  // has converted maintenance into a customer-visible incident.
  it('pauses when the target group is lagging', async () => {
    const paused: number[] = [];
    const c = coordinator(
      {
        lagSeconds: () => Promise.resolve(600),
        lagThresholdSeconds: 300,
        onBackpressurePause: (_r, _g, lag) => paused.push(lag),
      },
      [row(1), row(2)],
    );
    const [run] = await c.instance.start(request(), 'op');
    const final = await c.instance.execute(run?.id ?? '');
    expect(final.status).toBe('paused');
    expect(paused).toEqual([600]);
    expect(c.delivered).toHaveLength(0);
  });

  it('proceeds when lag is within threshold', async () => {
    const c = coordinator({ lagSeconds: () => Promise.resolve(5), lagThresholdSeconds: 300 }, [
      row(1),
    ]);
    const [run] = await c.instance.start(request(), 'op');
    const final = await c.instance.execute(run?.id ?? '');
    expect(final.status).toBe('completed');
  });
});

describe('request shape', () => {
  it('rejects a request with no target groups', async () => {
    const c = coordinator();
    const bad = { ...request(), targetGroups: [] } as unknown as ReplayRequest;
    await expect(c.instance.estimate(bad, 'op')).rejects.toBeInstanceOf(ReplayRejectedError);
  });

  it('estimates a targeted replay from its dead-letter ids', async () => {
    const c = coordinator();
    const estimate = await c.instance.estimate(
      request({ mode: 'targeted', deadLetterIds: ['d1', 'd2'] } as Partial<ReplayRequest>),
      'op',
    );
    expect(estimate.eventCount).toBe(2);
  });

  it('reports status for an unknown run as null', async () => {
    const c = coordinator();
    expect(await c.instance.status('nope')).toBeNull();
  });
});
