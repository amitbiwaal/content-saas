/**
 * The cascade workers over REAL Redis Streams, fed by the REAL relay.
 *
 * `consumer-worker.test.ts` proves the loop with stubs and
 * `tests/conformance/cascade-workers.conformance.test.ts` proves the wiring
 * with a fake bus. Neither proves the part only a server can: that the two
 * groups really are independent consumer groups on one stream, that each sees
 * every entry, and that an unacked entry really does stay pending.
 *
 * The path exercised is the whole one — outbox row → existing relay → real
 * stream → consumer worker → existing registry → cascade.
 *
 * Requires `REDIS_URL`; skips loudly without it and fails under `CI`, so the
 * gate cannot rot into a silent pass.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DomainEvent } from '@contentos/contracts';
import {
  createAggregateBarrier,
  createDispatcher,
  createIdempotencyGuard,
  createRedisClient,
  createRedisStreamsBus,
  createRelay,
  createRetryEngine,
  type EventBus,
  type GuardExecutor,
  type ManagedRedisClient,
  type OutboxRow,
  type RegisteredHandler,
} from '@contentos/events';
import {
  ORGANIZATION_LIFECYCLE_CASCADE_GROUP,
  ORGANIZATION_MEMBERSHIP_CASCADE_GROUP,
  ORGANIZATION_STREAM,
} from '@contentos/platform';

import { createWorkerEventRegistry } from '../events/registry.js';
import {
  assertSubscriptionsMatchRegistry,
  createConsumerWorker,
  type ConsumerSubscription,
} from './consumer-worker.js';

const REDIS_URL = process.env['REDIS_URL'];
const canRun = REDIS_URL !== undefined && REDIS_URL !== '';

if (!canRun) {
  console.warn('[cascade-worker.integration] SKIPPED — REDIS_URL is not set.');
}

describe('live Redis gate', () => {
  it('is satisfied whenever CI runs', () => {
    if (process.env['CI'] !== undefined && process.env['CI'] !== 'false') {
      expect(canRun, 'CI must provide REDIS_URL for the cascade worker suite').toBe(true);
    }
  });
});

const describeLive = canRun ? describe : describe.skip;

const ORG = '018f7a1e-0000-7000-8000-0000000000aa';

function outboxRow(seq: number, eventType: string): OutboxRow {
  return {
    id: String(seq),
    event_id: `018f7a1e-0000-7000-8000-${String(seq).padStart(12, '0')}`,
    tenant_id: ORG,
    organization_id: ORG,
    event_type: eventType,
    event_version: 1,
    aggregate_type: 'Organization',
    aggregate_id: ORG,
    correlation_id: '018f7a1e-0000-7000-8000-0000000000dd',
    causation_id: null,
    producer: 'platform.organizations',
    occurred_at: '2026-07-30T12:00:00.000Z',
    payload: { organizationId: ORG, userId: '018f7a1e-0000-7000-8000-000000000003' },
    publish_attempts: 0,
  };
}

/** Records what each handler saw, so delivery can be asserted per group. */
function recordingHandler(eventType: string, group: string, seen: string[]): RegisteredHandler {
  return {
    eventType,
    version: 1,
    group,
    tenantScope: 'organization',
    handle: (event: DomainEvent<unknown>): Promise<void> => {
      seen.push(`${group}:${event.eventType}:${event.eventId}`);
      return Promise.resolve();
    },
  };
}

describeLive('cascade workers over real Redis', () => {
  let client: ManagedRedisClient;
  let bus: EventBus;
  let stream: string;
  let lifecycleGroup: string;
  let membershipGroup: string;
  const streams: string[] = [];
  let counter = 0;

  beforeAll(async () => {
    client = createRedisClient({ url: REDIS_URL ?? '', connectionName: 'cascade-integration' });
    await client.waitUntilReady();
    bus = createRedisStreamsBus({ client });
  });

  afterAll(async () => {
    if (streams.length > 0) await client.raw.del(...streams);
    await bus.shutdown();
  });

  async function freshStream(): Promise<void> {
    counter += 1;
    // Unique per test so groups and offsets never bleed between them.
    stream = `${ORGANIZATION_STREAM}-t32-${String(Date.now())}-${String(counter)}`;
    lifecycleGroup = `${ORGANIZATION_LIFECYCLE_CASCADE_GROUP}-${String(counter)}`;
    membershipGroup = `${ORGANIZATION_MEMBERSHIP_CASCADE_GROUP}-${String(counter)}`;
    streams.push(stream);
    await bus.ensureGroup(stream, lifecycleGroup);
    await bus.ensureGroup(stream, membershipGroup);
  }

  function worker(subscriptions: readonly ConsumerSubscription[], onOutcome?: () => void) {
    return createConsumerWorker({
      bus,
      dispatcher: createDispatcher({
        barrier: createAggregateBarrier(),
        guard: createIdempotencyGuard(),
        retry: createRetryEngine({
          policy: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 2, jitter: 0 },
        }),
        transaction: <T>(work: (tx: GuardExecutor) => Promise<T>): Promise<T> => {
          const claimed = new Set<string>();
          return work({
            query<R>(sql: string, p?: readonly unknown[]): Promise<readonly R[]> {
              if (sql.includes('INSERT INTO processed_events')) {
                const k = `${String(p?.[2])}::${String(p?.[3])}`;
                if (claimed.has(k)) return Promise.resolve([] as unknown as R[]);
                claimed.add(k);
                return Promise.resolve([{ event_id: p?.[3] }] as unknown as R[]);
              }
              return Promise.resolve([] as unknown as R[]);
            },
          } as GuardExecutor);
        },
        quarantine: (): Promise<void> => {
          onOutcome?.();
          return Promise.resolve();
        },
      }),
      subscriptions,
      consumerName: 'integration-worker',
      blockMs: 50,
      sleep: () => Promise.resolve(),
    });
  }

  /** The existing relay, publishing outbox rows into the real stream. */
  function relayFor(rows: OutboxRow[]) {
    let claimed = false;
    return createRelay({
      transaction: <T>(work: (tx: GuardExecutor) => Promise<T>): Promise<T> =>
        work({
          query<R>(sql: string): Promise<readonly R[]> {
            if (sql.includes('FROM outbox_events') && !claimed) {
              claimed = true;
              return Promise.resolve(rows as unknown as R[]);
            }
            return Promise.resolve([] as unknown as R[]);
          },
        } as GuardExecutor),
      append: async (event) => {
        await bus.append(stream, event);
        return { ok: true };
      },
      quarantine: (): Promise<void> => Promise.resolve(),
    });
  }

  it('delivers a relayed event to the group that handles it', async () => {
    await freshStream();
    const seen: string[] = [];
    const subscriptions: ConsumerSubscription[] = [
      {
        stream,
        group: lifecycleGroup,
        handlers: [recordingHandler('OrganizationSuspended', lifecycleGroup, seen)],
      },
    ];

    await relayFor([outboxRow(1, 'OrganizationSuspended')]).drainOnce();
    await worker(subscriptions).runCycle();

    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('OrganizationSuspended');
  });

  // The property only a server proves: one stream, two independent groups,
  // each seeing every entry.
  it('gives every consumer group its own view of the stream', async () => {
    await freshStream();
    const lifecycleSeen: string[] = [];
    const membershipSeen: string[] = [];

    await relayFor([
      outboxRow(2, 'OrganizationSuspended'),
      outboxRow(3, 'OrgMembershipRevoked'),
    ]).drainOnce();

    await worker([
      {
        stream,
        group: lifecycleGroup,
        handlers: [recordingHandler('OrganizationSuspended', lifecycleGroup, lifecycleSeen)],
      },
      {
        stream,
        group: membershipGroup,
        handlers: [recordingHandler('OrgMembershipRevoked', membershipGroup, membershipSeen)],
      },
    ]).runCycle();

    // Each group handled its own type and acked away the other's.
    expect(lifecycleSeen).toHaveLength(1);
    expect(membershipSeen).toHaveLength(1);
    expect(await bus.pendingCount(stream, lifecycleGroup)).toBe(0);
    expect(await bus.pendingCount(stream, membershipGroup)).toBe(0);
  });

  // processed_events is per (group, event), so both groups act on one event.
  it('lets two groups each handle the same event once', async () => {
    await freshStream();
    const a: string[] = [];
    const b: string[] = [];

    await relayFor([outboxRow(4, 'OrganizationSuspended')]).drainOnce();
    await worker([
      {
        stream,
        group: lifecycleGroup,
        handlers: [recordingHandler('OrganizationSuspended', lifecycleGroup, a)],
      },
      {
        stream,
        group: membershipGroup,
        handlers: [recordingHandler('OrganizationSuspended', membershipGroup, b)],
      },
    ]).runCycle();

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  // Acking a retryable event is how events are lost; the entry must stay
  // pending so XAUTOCLAIM can reclaim it.
  it('leaves a failing event pending on the real stream', async () => {
    await freshStream();
    const failing: RegisteredHandler = {
      eventType: 'OrganizationSuspended',
      version: 1,
      group: lifecycleGroup,
      tenantScope: 'organization',
      handle: (): Promise<void> => Promise.reject(new Error('connection reset')),
    };

    await relayFor([outboxRow(5, 'OrganizationSuspended')]).drainOnce();
    await worker([{ stream, group: lifecycleGroup, handlers: [failing] }]).runCycle();

    expect(await bus.pendingCount(stream, lifecycleGroup)).toBe(1);
  });

  it('acks an event no handler in the group owns', async () => {
    await freshStream();
    const seen: string[] = [];

    await relayFor([outboxRow(6, 'OrganizationCreated')]).drainOnce();
    await worker([
      {
        stream,
        group: lifecycleGroup,
        handlers: [recordingHandler('OrganizationSuspended', lifecycleGroup, seen)],
      },
    ]).runCycle();

    expect(seen).toHaveLength(0);
    expect(await bus.pendingCount(stream, lifecycleGroup)).toBe(0);
  });

  it('validates its subscriptions against the existing registry', async () => {
    await freshStream();
    const registry = createWorkerEventRegistry();

    // The declared stream is `organization`; this suite uses a unique one per
    // test, so the check must reject it.
    expect(() => {
      assertSubscriptionsMatchRegistry(registry, [
        {
          stream,
          group: ORGANIZATION_LIFECYCLE_CASCADE_GROUP,
          handlers: [
            recordingHandler('OrganizationSuspended', ORGANIZATION_LIFECYCLE_CASCADE_GROUP, []),
          ],
        },
      ]);
    }).toThrow(/would receive nothing/);
  });
});
