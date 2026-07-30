/**
 * The cascade workers, end to end.
 *
 * Everything below the fake bus and the fake connection is REAL: the composed
 * registry and its startup validation, the dispatcher with its barrier,
 * idempotency guard and retry engine, the two cascade libraries, the real
 * workspace and membership services, and the ports bound to a
 * `TenantScopedConnection`.
 *
 * That matters because this increment writes no cascade logic. What it can get
 * wrong is the wiring — which event reaches which cascade, what is acked, what
 * is retried, and whether the two idempotency layers still both apply. So the
 * wiring is what is exercised, against the real parts on either side of it.
 */

import { describe, expect, it } from 'vitest';

import type { DomainEvent } from '@contentos/contracts';
import {
  createAggregateBarrier,
  createIdempotencyGuard,
  createRetryEngine,
  type DeadLetterQueue,
  type DeliveredEvent,
  type EventBus,
  type GuardExecutor,
  type NewDeadLetterEntry,
} from '@contentos/events';
import type { TenantContext, TenantScopedConnection, Transaction } from '@contentos/database';
import { createPersistentAuditWriter, type AuditWriter } from '@contentos/security';
import {
  createWorkspaceMembershipService,
  createWorkspaceService,
  ORGANIZATION_LIFECYCLE_CASCADE_GROUP,
  ORGANIZATION_MEMBERSHIP_CASCADE_GROUP,
  ORGANIZATION_STREAM,
} from '@contentos/platform';
import { composeCascadeWorker, subscriptionsFor } from '@contentos/worker-host';

const ORG = '018f7a1e-0000-7000-8000-0000000000aa';
const WS_A = '018f7a1e-0000-7000-8000-0000000000c1';
const WS_B = '018f7a1e-0000-7000-8000-0000000000c2';
const LEAVER = '018f7a1e-0000-7000-8000-000000000003';
const ADMIN = '018f7a1e-0000-7000-8000-000000000001';
const NOW = new Date('2026-07-30T12:00:00.000Z');
const EVENT_ID = '018f7a1e-0000-7000-8000-0000000000ee';

// ── A tiny multi-tenant cluster behind TenantScopedConnection ────────────────

interface Cluster {
  readonly connection: TenantScopedConnection;
  readonly processed: Set<string>;
  readonly transaction: <T>(work: (tx: GuardExecutor) => Promise<T>) => Promise<T>;
  readonly audit: AuditWriter;
  status(workspaceId: string): string | undefined;
  membership(workspaceId: string): string | undefined;
  seedWorkspace(workspaceId: string, status: string): void;
  seedMembership(workspaceId: string, userId: string, role: string, status: string): void;
  failWorkspace(workspaceId: string | null): void;
}

function cluster(): Cluster {
  const workspaces = new Map<string, { status: string; version: number }>();
  const memberships = new Map<string, { role: string; status: string; version: number }>();
  const auditRows: unknown[][] = [];
  const processed = new Set<string>();
  let failing: string | null = null;

  const mk = (ws: string, user: string): string => `${ws}:${user}`;

  function executor(tenantId: string): Transaction {
    return {
      query<T>(q: string, p?: readonly unknown[]): Promise<readonly T[]> {
        const params = [...(p ?? [])];
        if (failing !== null && tenantId === failing) {
          return Promise.reject(new Error('connection reset'));
        }
        if (q.includes('pg_advisory_xact_lock')) return Promise.resolve([] as readonly T[]);

        // Listing runs under the organization as tenant (ADR-029), reaching
        // the read-only workspaces_org_read policy.
        if (q.includes('FROM workspaces') && q.includes('organization_id = $1')) {
          return Promise.resolve(
            [...workspaces.entries()].map(([id, w]) => ({
              id,
              status: w.status,
            })) as readonly T[],
          );
        }
        if (q.includes('count(*)::int')) {
          const count = [...memberships.entries()].filter(
            ([k, m]) =>
              k.startsWith(`${tenantId}:`) && m.role === params[1] && m.status === 'active',
          ).length;
          return Promise.resolve([{ count }] as readonly T[]);
        }
        if (q.includes("context -> 'detail'")) {
          const match = auditRows.filter((r) => r[1] === params[0] && r[7] === params[2]).at(-1);
          if (match === undefined) return Promise.resolve([] as readonly T[]);
          const ctx = JSON.parse(String(match[13])) as { detail?: Record<string, string> };
          return Promise.resolve([
            {
              cascade_of: ctx.detail?.['organizationCascade'] ?? null,
              previous_status: ctx.detail?.['previousStatus'] ?? null,
            },
          ] as readonly T[]);
        }
        if (q.includes('FROM workspaces')) {
          const w = workspaces.get(String(params[0]));
          return Promise.resolve(
            (w === undefined
              ? []
              : [
                  {
                    id: params[0],
                    organization_id: ORG,
                    slug: 'ws',
                    name: 'W',
                    status: w.status,
                    version: w.version,
                  },
                ]) as readonly T[],
          );
        }
        if (q.includes('UPDATE workspaces')) {
          const w = workspaces.get(String(params[2]));
          if (w === undefined || w.version !== params[3])
            return Promise.resolve([] as readonly T[]);
          w.status = String(params[0]);
          w.version += 1;
          return Promise.resolve([{ version: w.version }] as readonly T[]);
        }
        if (q.includes('FROM workspace_memberships')) {
          const m = memberships.get(mk(tenantId, String(params[1])));
          return Promise.resolve(
            (m === undefined
              ? []
              : [
                  {
                    id: `m-${tenantId}`,
                    tenant_id: tenantId,
                    organization_id: ORG,
                    user_id: params[1],
                    role: m.role,
                    status: m.status,
                    expires_at: null,
                    invited_by: ADMIN,
                    version: m.version,
                  },
                ]) as readonly T[],
          );
        }
        if (q.includes("SET status = 'revoked'")) {
          const entry = [...memberships.entries()].find(([k]) => k === mk(tenantId, LEAVER));
          if (entry === undefined || entry[1].version !== params[2]) {
            return Promise.resolve([] as readonly T[]);
          }
          entry[1].status = 'revoked';
          entry[1].version += 1;
          return Promise.resolve([{ version: entry[1].version }] as readonly T[]);
        }
        if (q.includes('SELECT hash FROM audit_log')) {
          const last = auditRows.filter((r) => r[1] === params[0]).at(-1);
          return Promise.resolve((last === undefined ? [] : [{ hash: last[15] }]) as readonly T[]);
        }
        if (q.includes('INSERT INTO audit_log')) {
          auditRows.push(params);
          return Promise.resolve([] as readonly T[]);
        }
        if (q.includes('INSERT INTO processed_events')) {
          const key = `${String(params[2])}::${String(params[3])}`;
          if (processed.has(key)) return Promise.resolve([] as readonly T[]);
          processed.add(key);
          return Promise.resolve([{ event_id: params[3] }] as readonly T[]);
        }
        throw new Error(`unexpected statement: ${q}`);
      },
    };
  }

  return {
    processed,
    audit: createPersistentAuditWriter({ now: () => NOW, newId: () => EVENT_ID }),
    connection: {
      withTenant: <T>(ctx: TenantContext, work: (tx: Transaction) => Promise<T>): Promise<T> =>
        work(executor(ctx.tenantId)),
      withoutTenant: <T>(_r: never, work: (tx: Transaction) => Promise<T>): Promise<T> =>
        work(executor('none')),
    } as unknown as TenantScopedConnection,
    // The dispatcher's transaction: markers roll back on throw, which is what
    // makes a failed cascade retryable.
    transaction: async <T>(work: (tx: GuardExecutor) => Promise<T>): Promise<T> => {
      const staged = new Set<string>();
      const tx = {
        query<R>(sql: string, p?: readonly unknown[]): Promise<readonly R[]> {
          if (sql.includes('INSERT INTO processed_events')) {
            const key = `${String(p?.[2])}::${String(p?.[3])}`;
            if (processed.has(key) || staged.has(key)) {
              return Promise.resolve([] as unknown as R[]);
            }
            staged.add(key);
            return Promise.resolve([{ event_id: p?.[3] }] as unknown as R[]);
          }
          return Promise.resolve([] as unknown as R[]);
        },
      } as GuardExecutor;
      const value = await work(tx);
      for (const k of staged) processed.add(k);
      return value;
    },
    status: (workspaceId) => workspaces.get(workspaceId)?.status,
    membership: (workspaceId) => memberships.get(mk(workspaceId, LEAVER))?.status,
    seedWorkspace(workspaceId, status) {
      workspaces.set(workspaceId, { status, version: 1 });
    },
    seedMembership(workspaceId, userId, role, status) {
      memberships.set(mk(workspaceId, userId), { role, status, version: 1 });
    },
    failWorkspace(workspaceId) {
      failing = workspaceId;
    },
  };
}

// ── A bus that hands out queued deliveries ───────────────────────────────────

interface Bus {
  readonly bus: EventBus;
  /** Acks recorded per group — each group acks independently, as Redis does. */
  ackedBy(group: string): readonly string[];
  queue(event: DomainEvent<unknown>, deliveryCount?: number): void;
}

/**
 * A stream fans out to EVERY consumer group.
 *
 * Modelled per group rather than as one shared queue, because that is what
 * Redis does and the difference is load-bearing here: both cascade groups read
 * the same organization stream, and each must see every entry so it can handle
 * the types it owns and ack away the ones it does not.
 */
function fakeBus(groups: readonly string[]): Bus {
  const pending = new Map<string, DeliveredEvent[]>(groups.map((g) => [g, []]));
  const acked = new Map<string, string[]>(groups.map((g) => [g, []]));
  let entry = 0;

  return {
    ackedBy: (group) => acked.get(group) ?? [],
    bus: {
      readGroup: (o: { group: string }): Promise<readonly DeliveredEvent[]> => {
        const queue = pending.get(o.group) ?? [];
        return Promise.resolve(queue.splice(0, queue.length));
      },
      ack: (_s: string, group: string, id: string): Promise<number> => {
        acked.get(group)?.push(id);
        return Promise.resolve(1);
      },
    } as unknown as EventBus,
    queue(event, deliveryCount = 1) {
      entry += 1;
      for (const group of groups) {
        pending.get(group)?.push({
          entryId: `${String(entry)}-0`,
          event,
          deliveryCount,
          stream: ORGANIZATION_STREAM,
        });
      }
    },
  };
}

function event(eventType: string, over: Partial<DomainEvent<unknown>> = {}): DomainEvent<unknown> {
  return {
    eventId: '018f7a1e-0000-7000-8000-0000000000e1',
    eventType,
    eventVersion: 1,
    aggregateType: eventType.startsWith('OrgMembership')
      ? 'OrganizationMembership'
      : 'Organization',
    aggregateId: ORG,
    tenantId: ORG,
    organizationId: ORG,
    correlationId: '018f7a1e-0000-7000-8000-0000000000dd',
    causationId: null,
    producer: 'platform.organizations',
    occurredAt: NOW.toISOString(),
    payload: { organizationId: ORG },
    ...over,
  };
}

function harness(options: { maxAttempts?: number } = {}) {
  const db = cluster();
  const bus = fakeBus([
    ORGANIZATION_LIFECYCLE_CASCADE_GROUP,
    ORGANIZATION_MEMBERSHIP_CASCADE_GROUP,
  ]);
  const quarantined: NewDeadLetterEntry[] = [];

  const composition = composeCascadeWorker({
    connection: db.connection,
    bus: bus.bus,
    deadLetters: {
      quarantine: (_tx: GuardExecutor, entry: NewDeadLetterEntry): Promise<string | null> => {
        quarantined.push(entry);
        return Promise.resolve('dlq-1');
      },
    } as unknown as DeadLetterQueue,
    barrier: createAggregateBarrier(),
    guard: createIdempotencyGuard(),
    retry: createRetryEngine({
      policy: {
        maxAttempts: options.maxAttempts ?? 3,
        baseDelayMs: 1,
        maxDelayMs: 2,
        jitter: 0,
      },
    }),
    workspaces: createWorkspaceService({
      publisher: { publish: (): Promise<void> => Promise.resolve() },
      audit: db.audit,
      now: () => NOW,
      newEventId: () => EVENT_ID,
    }),
    workspaceMemberships: createWorkspaceMembershipService({
      publisher: { publish: (): Promise<void> => Promise.resolve() },
      audit: db.audit,
      now: () => NOW,
      newEventId: () => EVENT_ID,
    }),
    transaction: db.transaction,
    consumerName: 'worker-1',
    now: () => NOW,
  });

  return { db, bus, quarantined, ...composition };
}

describe('startup validation', () => {
  it('composes both cascade groups and refuses nothing valid', () => {
    expect(() => harness()).not.toThrow();
  });

  it('hosts exactly the two declared cascade groups and no others', () => {
    const h = harness();
    expect(h.subscriptions.map((s) => s.group).sort()).toEqual(
      [ORGANIZATION_LIFECYCLE_CASCADE_GROUP, ORGANIZATION_MEMBERSHIP_CASCADE_GROUP].sort(),
    );
    for (const s of h.subscriptions) expect(s.stream).toBe(ORGANIZATION_STREAM);
  });

  it('subscribes to exactly the three declared event types', () => {
    const h = harness();
    expect(h.handlers.map((x) => x.eventType).sort()).toEqual([
      'OrgMembershipRevoked',
      'OrganizationReactivated',
      'OrganizationSuspended',
    ]);
  });

  // A group reading the wrong stream starts cleanly and receives nothing.
  it('refuses a subscription on the wrong stream', async () => {
    const h = harness();
    const { assertSubscriptionsMatchRegistry } = await import('@contentos/worker-host');
    expect(() => {
      assertSubscriptionsMatchRegistry(h.registry, subscriptionsFor(h.handlers, 'workspace'));
    }).toThrow(/would receive nothing/);
  });

  // Subscribing to a group and handling only some of its types silently
  // discards the rest.
  it('refuses a hosted group missing one of its declared handlers', async () => {
    const h = harness();
    const { assertSubscriptionsMatchRegistry } = await import('@contentos/worker-host');
    const partial = h.handlers.filter((x) => x.eventType !== 'OrganizationReactivated');
    expect(() => {
      assertSubscriptionsMatchRegistry(h.registry, subscriptionsFor(partial, ORGANIZATION_STREAM));
    }).toThrow(/registers no handler/);
  });
});

describe('OrganizationSuspended triggers the suspension cascade', () => {
  it('suspends every active workspace and acks', async () => {
    const h = harness();
    h.db.seedWorkspace(WS_A, 'active');
    h.db.seedWorkspace(WS_B, 'active');
    h.bus.queue(event('OrganizationSuspended'));

    await h.worker.runCycle();

    expect(h.db.status(WS_A)).toBe('suspended');
    expect(h.db.status(WS_B)).toBe('suspended');
    expect(h.bus.ackedBy(ORGANIZATION_LIFECYCLE_CASCADE_GROUP)).toEqual(['1-0']);
  });

  // The state machine has no arrow from archived, so the cascade cannot touch
  // it even by accident.
  it('leaves an archived workspace archived', async () => {
    const h = harness();
    h.db.seedWorkspace(WS_A, 'active');
    h.db.seedWorkspace(WS_B, 'archived');
    h.bus.queue(event('OrganizationSuspended'));

    await h.worker.runCycle();
    expect(h.db.status(WS_B)).toBe('archived');
  });
});

describe('OrganizationReactivated triggers the reactivation cascade', () => {
  it('restores what the cascade suspended', async () => {
    const h = harness();
    h.db.seedWorkspace(WS_A, 'active');
    h.bus.queue(event('OrganizationSuspended'));
    await h.worker.runCycle();
    expect(h.db.status(WS_A)).toBe('suspended');

    h.bus.queue(
      event('OrganizationReactivated', { eventId: '018f7a1e-0000-7000-8000-0000000000e2' }),
    );
    await h.worker.runCycle();
    expect(h.db.status(WS_A)).toBe('active');
  });
});

describe('OrgMembershipRevoked triggers the membership cascade', () => {
  it('revokes the leaver in every workspace of the organization', async () => {
    const h = harness();
    h.db.seedWorkspace(WS_A, 'active');
    h.db.seedWorkspace(WS_B, 'active');
    h.db.seedMembership(WS_A, LEAVER, 'editor', 'active');
    h.db.seedMembership(WS_B, LEAVER, 'viewer', 'active');
    h.bus.queue(
      event('OrgMembershipRevoked', {
        payload: { organizationId: ORG, userId: LEAVER, revokedBy: ADMIN },
      }),
    );

    await h.worker.runCycle();
    expect(h.db.membership(WS_A)).toBe('revoked');
    expect(h.db.membership(WS_B)).toBe('revoked');
  });

  // A malformed payload is a contract violation, not a transient fault.
  it('dead-letters an event with no userId rather than retrying it', async () => {
    const h = harness();
    h.db.seedWorkspace(WS_A, 'active');
    h.bus.queue(event('OrgMembershipRevoked', { payload: { organizationId: ORG } }));

    await h.worker.runCycle();
    expect(h.quarantined).toHaveLength(1);
    expect(h.quarantined[0]?.failureCode).toBe('SchemaViolation');
  });
});

describe('idempotency — two layers, neither replacing the other', () => {
  // Layer 1: processed_events suppresses a redelivery of a handled event.
  it('suppresses a duplicate delivery without re-running the cascade', async () => {
    const h = harness();
    h.db.seedWorkspace(WS_A, 'active');
    const e = event('OrganizationSuspended');

    h.bus.queue(e);
    await h.worker.runCycle();
    expect(h.db.status(WS_A)).toBe('suspended');

    // Same eventId delivered again.
    h.bus.queue(e, 2);
    await h.worker.runCycle();

    const group = h.worker
      .health()
      .groups.find((g) => g.group === ORGANIZATION_LIFECYCLE_CASCADE_GROUP);
    expect(group?.suppressed).toBe(1);
    expect(h.bus.ackedBy(ORGANIZATION_LIFECYCLE_CASCADE_GROUP)).toEqual(['1-0', '2-0']);
  });

  it('records the marker per (group, event)', async () => {
    const h = harness();
    h.db.seedWorkspace(WS_A, 'active');
    h.bus.queue(event('OrganizationSuspended'));
    await h.worker.runCycle();

    expect([...h.db.processed]).toEqual([
      `${ORGANIZATION_LIFECYCLE_CASCADE_GROUP}::018f7a1e-0000-7000-8000-0000000000e1`,
    ]);
  });
});

describe('retry convergence', () => {
  // The whole cascade is retried; workspaces already done take the library's
  // skip path, which is why re-running converges rather than repeating.
  it('retries the whole cascade and converges once the fault clears', async () => {
    const h = harness();
    h.db.seedWorkspace(WS_A, 'active');
    h.db.seedWorkspace(WS_B, 'active');
    h.db.failWorkspace(WS_B);

    h.bus.queue(event('OrganizationSuspended'));
    await h.worker.runCycle();

    // A partial cascade must not be marked processed, or redelivery would be
    // suppressed and WS_B would never be suspended.
    expect(h.db.status(WS_A)).toBe('suspended');
    expect(h.db.status(WS_B)).toBe('active');
    expect(h.db.processed.size).toBe(0);
    expect(h.bus.ackedBy(ORGANIZATION_LIFECYCLE_CASCADE_GROUP)).toEqual([]);

    h.db.failWorkspace(null);
    h.bus.queue(event('OrganizationSuspended'), 2);
    await h.worker.runCycle();

    expect(h.db.status(WS_B)).toBe('suspended');
    expect(h.db.processed.size).toBe(1);
    expect(h.bus.ackedBy(ORGANIZATION_LIFECYCLE_CASCADE_GROUP)).toEqual(['2-0']);
  });

  it('leaves a retrying event pending rather than acking it', async () => {
    const h = harness();
    h.db.seedWorkspace(WS_A, 'active');
    h.db.failWorkspace(WS_A);
    h.bus.queue(event('OrganizationSuspended'));

    await h.worker.runCycle();
    expect(h.bus.ackedBy(ORGANIZATION_LIFECYCLE_CASCADE_GROUP)).toEqual([]);
    const group = h.worker
      .health()
      .groups.find((g) => g.group === ORGANIZATION_LIFECYCLE_CASCADE_GROUP);
    expect(group?.retried).toBe(1);
  });
});

describe('DLQ routing', () => {
  it('quarantines once attempts are exhausted, with full context', async () => {
    const h = harness({ maxAttempts: 1 });
    h.db.seedWorkspace(WS_A, 'active');
    h.db.failWorkspace(WS_A);
    h.bus.queue(event('OrganizationSuspended'));

    await h.worker.runCycle();

    expect(h.quarantined).toHaveLength(1);
    const entry = h.quarantined[0];
    expect(entry).toMatchObject({
      source: 'delivery',
      consumerGroup: ORGANIZATION_LIFECYCLE_CASCADE_GROUP,
      failureCode: 'CascadeIncomplete',
      reason: 'attempts-exhausted',
    });
    // Event id, correlation id, causation id and producer travel on the
    // envelope, so the entry is self-contained.
    expect(entry?.event.eventId).toBe('018f7a1e-0000-7000-8000-0000000000e1');
    expect(entry?.event.correlationId).toBe('018f7a1e-0000-7000-8000-0000000000dd');
    expect(entry?.event.producer).toBe('platform.organizations');
    expect(entry?.retryHistory).toBeDefined();
  });

  it('acks a dead-lettered event — it will not be processed again', async () => {
    const h = harness({ maxAttempts: 1 });
    h.db.seedWorkspace(WS_A, 'active');
    h.db.failWorkspace(WS_A);
    h.bus.queue(event('OrganizationSuspended'));

    await h.worker.runCycle();
    expect(h.bus.ackedBy(ORGANIZATION_LIFECYCLE_CASCADE_GROUP)).toEqual(['1-0']);
  });
});

describe('heartbeat', () => {
  it('exposes one per hosted consumer group', async () => {
    const h = harness();
    await h.worker.runCycle();

    const health = h.worker.health();
    expect(health.groups.map((g) => g.group).sort()).toEqual(
      [ORGANIZATION_LIFECYCLE_CASCADE_GROUP, ORGANIZATION_MEMBERSHIP_CASCADE_GROUP].sort(),
    );
    for (const group of health.groups) {
      expect(group.lastHeartbeatAt, group.group).toEqual(NOW);
    }
  });
});

describe('events the groups do not handle', () => {
  // The organization stream carries all nine organization-scoped types.
  it('acks and ignores an unrelated type on the same stream', async () => {
    const h = harness();
    h.bus.queue(event('OrganizationCreated'));

    await h.worker.runCycle();
    expect(h.bus.ackedBy(ORGANIZATION_LIFECYCLE_CASCADE_GROUP)).toEqual(['1-0']);
    const ignored = h.worker.health().groups.reduce((n, g) => n + g.ignored, 0);
    expect(ignored).toBeGreaterThan(0);
    expect(h.quarantined).toHaveLength(0);
  });
});
