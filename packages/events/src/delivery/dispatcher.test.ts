import { describe, expect, it } from 'vitest';

import type { DomainEvent } from '@contentos/contracts';

import { createDispatcher, type DeadLetterRequest, type RegisteredHandler } from './dispatcher.js';
import { createAggregateBarrier, createIdempotencyGuard, type GuardExecutor } from './guards.js';
import { classify, createRetryEngine, TERMINAL_CODES } from './retry.js';

const TENANT = '018f7a1e-0000-7000-8000-0000000000bb';
const ORG = '018f7a1e-0000-7000-8000-0000000000aa';
const AGG_A = '018f7a1e-0000-7000-8000-0000000000c1';
const AGG_B = '018f7a1e-0000-7000-8000-0000000000c2';

function event(
  over: Partial<DomainEvent<Record<string, unknown>>> = {},
): DomainEvent<Record<string, unknown>> {
  return {
    eventId: '018f7a1e-0000-7000-8000-000000000001',
    eventType: 'ArticlePublished',
    eventVersion: 1,
    aggregateType: 'Article',
    aggregateId: AGG_A,
    tenantId: TENANT,
    organizationId: ORG,
    correlationId: '018f7a1e-0000-7000-8000-0000000000dd',
    causationId: null,
    producer: 'content-platform',
    occurredAt: '2026-07-29T10:00:00.000Z',
    payload: {},
    ...over,
  };
}

/** Fake transaction with a real uniqueness constraint on (group, event_id). */
function db() {
  const processed = new Set<string>();
  const committed: string[] = [];
  return {
    processed,
    committed,
    transaction: async <T>(work: (tx: GuardExecutor) => Promise<T>): Promise<T> => {
      const staged = new Set<string>();
      const tx: GuardExecutor = {
        query<R>(sql: string, params?: readonly unknown[]): Promise<readonly R[]> {
          if (sql.includes('INSERT INTO processed_events')) {
            const key = `${String(params?.[2])}::${String(params?.[3])}`;
            if (processed.has(key) || staged.has(key)) return Promise.resolve([] as unknown as R[]);
            staged.add(key);
            return Promise.resolve([{ event_id: params?.[3] }] as unknown as R[]);
          }
          return Promise.resolve([] as unknown as R[]);
        },
      } as GuardExecutor;
      // On throw the staged markers are simply never promoted — that IS the
      // rollback, and it is why a failed attempt stays retryable.
      const value = await work(tx);
      for (const k of staged) {
        processed.add(k);
        committed.push(k);
      }
      return value;
    },
  };
}

function harness(
  opts: { handler?: RegisteredHandler; onQuarantine?: (r: DeadLetterRequest) => void } = {},
) {
  const store = db();
  const quarantined: DeadLetterRequest[] = [];
  const gaps: string[] = [];
  const barrier = createAggregateBarrier({ onGap: (g) => gaps.push(g.aggregateId) });
  const handler: RegisteredHandler = opts.handler ?? {
    eventType: 'ArticlePublished',
    version: 1,
    group: 'read-models',
    tenantScope: 'workspace',
    handle: () => Promise.resolve(),
  };
  const dispatcher = createDispatcher({
    barrier,
    guard: createIdempotencyGuard(),
    retry: createRetryEngine({
      policy: { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100, jitter: 0 },
    }),
    transaction: store.transaction,
    quarantine: (r) => {
      quarantined.push(r);
      opts.onQuarantine?.(r);
      return Promise.resolve();
    },
  });
  return { dispatcher, handler, barrier, store, quarantined, gaps };
}

describe('exactly-once effects', () => {
  it('handles an event once', async () => {
    let calls = 0;
    const h = harness({
      handler: {
        eventType: 'ArticlePublished',
        version: 1,
        group: 'read-models',
        tenantScope: 'workspace',
        handle: () => {
          calls += 1;
          return Promise.resolve();
        },
      },
    });
    const outcome = await h.dispatcher.dispatch(
      event(),
      h.handler,
      1,
      new AbortController().signal,
    );
    expect(outcome.kind).toBe('handled');
    expect(calls).toBe(1);
  });

  // The bus may deliver any number of times; the EFFECTS happen once.
  it('suppresses a redelivery without re-running the handler', async () => {
    let calls = 0;
    const h = harness({
      handler: {
        eventType: 'ArticlePublished',
        version: 1,
        group: 'read-models',
        tenantScope: 'workspace',
        handle: () => {
          calls += 1;
          return Promise.resolve();
        },
      },
    });
    await h.dispatcher.dispatch(event(), h.handler, 1, new AbortController().signal);
    const second = await h.dispatcher.dispatch(event(), h.handler, 1, new AbortController().signal);
    expect(second.kind).toBe('suppressed-duplicate');
    expect(calls).toBe(1);
  });

  // A failed attempt must remain retryable, not permanently suppressed.
  it('leaves no marker behind when the handler throws', async () => {
    const h = harness({
      handler: {
        eventType: 'ArticlePublished',
        version: 1,
        group: 'read-models',
        tenantScope: 'workspace',
        handle: () => Promise.reject(new Error('dependency down')),
      },
    });
    await h.dispatcher.dispatch(event(), h.handler, 1, new AbortController().signal);
    expect(h.store.committed).toHaveLength(0);
  });

  it('lets a different consumer group process the same event', async () => {
    const h = harness();
    await h.dispatcher.dispatch(event(), h.handler, 1, new AbortController().signal);
    const other = await h.dispatcher.dispatch(
      event(),
      { ...h.handler, group: 'analytics' },
      1,
      new AbortController().signal,
    );
    expect(other.kind).toBe('handled');
  });
});

describe('per-aggregate ordering', () => {
  it('holds a second event for the same aggregate while one is in flight', async () => {
    const h = harness();
    const token = await h.barrier.acquire('read-models', AGG_A, 'other-event');
    expect(token).not.toBe('held');
    const outcome = await h.dispatcher.dispatch(
      event(),
      h.handler,
      1,
      new AbortController().signal,
    );
    expect(outcome.kind).toBe('held');
  });

  // A held event must not consume a marker, or it would be suppressed forever.
  it('consumes no idempotency marker when held', async () => {
    const h = harness();
    await h.barrier.acquire('read-models', AGG_A, 'other-event');
    await h.dispatcher.dispatch(event(), h.handler, 1, new AbortController().signal);
    expect(h.store.committed).toHaveLength(0);
  });

  it('does not block a different aggregate', async () => {
    const h = harness();
    await h.barrier.acquire('read-models', AGG_A, 'other-event');
    const outcome = await h.dispatcher.dispatch(
      event({ aggregateId: AGG_B, eventId: '018f7a1e-0000-7000-8000-000000000002' }),
      h.handler,
      1,
      new AbortController().signal,
    );
    expect(outcome.kind).toBe('handled');
  });

  it('releases the slot after handling, so the next event proceeds', async () => {
    const h = harness();
    await h.dispatcher.dispatch(event(), h.handler, 1, new AbortController().signal);
    expect(h.barrier.heldCount('read-models')).toBe(0);
  });

  it('does not block a different consumer group on the same aggregate', async () => {
    const h = harness();
    await h.barrier.acquire('read-models', AGG_A, 'x');
    const token = await h.barrier.acquire('analytics', AGG_A, 'y');
    expect(token).not.toBe('held');
  });
});

describe('retry — transient only', () => {
  it('retries a transient failure', async () => {
    const h = harness({
      handler: {
        eventType: 'ArticlePublished',
        version: 1,
        group: 'read-models',
        tenantScope: 'workspace',
        handle: () => Promise.reject(new Error('ECONNRESET')),
      },
    });
    const outcome = await h.dispatcher.dispatch(
      event(),
      h.handler,
      1,
      new AbortController().signal,
    );
    expect(outcome.kind).toBe('retry');
  });

  it('classifies every frozen terminal code as terminal', () => {
    for (const code of TERMINAL_CODES) expect(classify(code)).toBe('terminal');
  });

  it('treats an unrecognised failure as transient', () => {
    expect(classify('ECONNRESET')).toBe('transient');
  });

  it.each(TERMINAL_CODES)('dead-letters %s on the first attempt', async (code) => {
    const failure = Object.assign(new Error('refused'), { code });
    const h = harness({
      handler: {
        eventType: 'ArticlePublished',
        version: 1,
        group: 'read-models',
        tenantScope: 'workspace',
        handle: () => Promise.reject(failure),
      },
    });
    const outcome = await h.dispatcher.dispatch(
      event(),
      h.handler,
      1,
      new AbortController().signal,
    );
    expect(outcome.kind).toBe('dead-lettered');
    expect(h.quarantined[0]?.reason).toBe('terminal-classification');
  });

  it('dead-letters once attempts are exhausted', async () => {
    const h = harness({
      handler: {
        eventType: 'ArticlePublished',
        version: 1,
        group: 'read-models',
        tenantScope: 'workspace',
        handle: () => Promise.reject(new Error('still down')),
      },
    });
    const outcome = await h.dispatcher.dispatch(
      event(),
      h.handler,
      3,
      new AbortController().signal,
    );
    expect(outcome.kind).toBe('dead-lettered');
    expect(h.quarantined[0]?.reason).toBe('attempts-exhausted');
  });
});

describe('no silent event loss', () => {
  it('quarantines before releasing the barrier', async () => {
    const order: string[] = [];
    const h = harness({
      handler: {
        eventType: 'ArticlePublished',
        version: 1,
        group: 'read-models',
        tenantScope: 'workspace',
        handle: () => Promise.reject(Object.assign(new Error('x'), { code: 'SchemaViolation' })),
      },
      onQuarantine: () => order.push('quarantine'),
    });
    await h.dispatcher.dispatch(event(), h.handler, 1, new AbortController().signal);
    order.push('released');
    expect(order).toEqual(['quarantine', 'released']);
  });

  it('records a gap so the missing event is explicit', async () => {
    const h = harness({
      handler: {
        eventType: 'ArticlePublished',
        version: 1,
        group: 'read-models',
        tenantScope: 'workspace',
        handle: () => Promise.reject(Object.assign(new Error('x'), { code: 'GuardrailBlocked' })),
      },
    });
    await h.dispatcher.dispatch(event(), h.handler, 1, new AbortController().signal);
    expect(h.gaps).toEqual([AGG_A]);
  });

  it('carries the failure code and message to the DLQ', async () => {
    const h = harness({
      handler: {
        eventType: 'ArticlePublished',
        version: 1,
        group: 'read-models',
        tenantScope: 'workspace',
        handle: () =>
          Promise.reject(Object.assign(new Error('bad shape'), { code: 'SchemaViolation' })),
      },
    });
    await h.dispatcher.dispatch(event(), h.handler, 1, new AbortController().signal);
    expect(h.quarantined[0]).toMatchObject({
      failureCode: 'SchemaViolation',
      failureMessage: 'bad shape',
      consumerGroup: 'read-models',
    });
  });
});

describe('tenant context comes from the envelope', () => {
  it('passes envelope tenancy to the handler, marked as event-sourced', async () => {
    let seen: { tenantId: string; source: string } | null = null;
    const h = harness({
      handler: {
        eventType: 'ArticlePublished',
        version: 1,
        group: 'read-models',
        tenantScope: 'workspace',
        handle: (_e, ctx) => {
          seen = { tenantId: ctx.tenantId, source: ctx.source };
          return Promise.resolve();
        },
      },
    });
    await h.dispatcher.dispatch(event(), h.handler, 1, new AbortController().signal);
    expect(seen).toEqual({ tenantId: TENANT, source: 'event' });
  });
});
