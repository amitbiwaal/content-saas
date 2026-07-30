/**
 * Workspace events against the REAL event platform.
 *
 * Same reasoning as `organization-events.conformance.test.ts`:
 * `packages/platform` cannot import `packages/events` (both are feature-tier),
 * so the real registry, the real envelope validator and the real transactional
 * outbox publisher are joined to the real Workspaces Service here.
 *
 * The property this suite exists for is the one workspaces make load-bearing:
 * `workspaces.id` IS `tenant_id`, so every emitted envelope must carry the
 * workspace as its tenant. A regression there is a cross-tenant defect, and it
 * would be invisible to a test that published through a fake.
 */

import { describe, expect, it } from 'vitest';

import type { DomainEvent } from '@contentos/contracts';
import {
  createEventRegistry,
  createOutboxPublisher,
  validateEnvelope,
  type EventTypeDeclaration,
} from '@contentos/events';
import {
  createWorkspaceService,
  WORKSPACE_EVENT_TYPES,
  type WorkspaceExecutor,
  type WorkspaceTransition,
} from '@contentos/platform';
import { createPersistentAuditWriter } from '@contentos/security';

const ORG = '018f7a1e-0000-7000-8000-0000000000aa';
const WS = '018f7a1e-0000-7000-8000-0000000000c1';
const ADMIN = '018f7a1e-0000-7000-8000-000000000001';
const ACTOR = '018f7a1e-0000-7000-8000-000000000002';
const CORRELATION = '018f7a1e-0000-7000-8000-0000000000dd';
const EVENT_ID = '018f7a1e-0000-7000-8000-0000000000ee';
const NOW = new Date('2026-07-30T12:00:00.000Z');

/** outbox_events INSERT column positions, from the publisher's statement. */
const O_TENANT = 1;
const O_ORG = 2;
const O_TYPE = 3;
const O_VERSION = 4;
const O_AGGREGATE_TYPE = 5;
const O_AGGREGATE_ID = 6;
const O_PRODUCER = 9;
const O_PAYLOAD = 10;

const DECLARATIONS: readonly EventTypeDeclaration[] = WORKSPACE_EVENT_TYPES.map((eventType) => ({
  eventType,
  version: 1,
  state: 'active' as const,
  stream: 'workspace',
  consumers: [],
}));

interface Harness {
  readonly outbox: unknown[][];
  readonly status: () => string | undefined;
  run(...transitions: WorkspaceTransition[]): Promise<void>;
  events(): DomainEvent<unknown>[];
}

function harness(declarations: readonly EventTypeDeclaration[] = DECLARATIONS): Harness {
  const outbox: unknown[][] = [];
  const auditRows: unknown[][] = [];
  const rows = new Map<string, { status: string; version: number }>();

  const tx = {
    query<T>(q: string, p?: readonly unknown[]): Promise<readonly T[]> {
      const params = [...(p ?? [])];

      if (q.includes('pg_advisory_xact_lock')) return Promise.resolve([] as readonly T[]);
      if (q.includes("current_setting('app.tenant_id'")) {
        return Promise.resolve([{ tenant_id: WS }] as readonly T[]);
      }
      if (q.includes('FROM organizations')) {
        return Promise.resolve([{ id: ORG, status: 'active', plan_limits: {} }] as readonly T[]);
      }
      if (q.includes('count(*)::int')) return Promise.resolve([{ count: 0 }] as readonly T[]);
      if (q.includes('INSERT INTO workspaces')) {
        rows.set(WS, { status: String(params[4]), version: 1 });
        return Promise.resolve([{ id: WS, version: 1 }] as readonly T[]);
      }
      if (q.includes('INSERT INTO workspace_memberships')) {
        return Promise.resolve([{ id: '018f7a1e-0000-7000-8000-0000000000d1' }] as readonly T[]);
      }
      if (q.includes('INSERT INTO workspace_settings_history')) {
        return Promise.resolve([{ id: '018f7a1e-0000-7000-8000-0000000000f1' }] as readonly T[]);
      }
      if (q.includes('UPDATE workspaces')) {
        const row = rows.get(String(params[2]));
        if (row === undefined || row.version !== params[3]) {
          return Promise.resolve([] as readonly T[]);
        }
        row.status = String(params[0]);
        row.version += 1;
        return Promise.resolve([{ version: row.version }] as readonly T[]);
      }
      if (q.includes('FROM workspaces')) {
        const row = rows.get(String(params[0]));
        return Promise.resolve(
          (row === undefined
            ? []
            : [
                {
                  id: WS,
                  organization_id: ORG,
                  slug: 'acme',
                  name: 'Acme',
                  status: row.status,
                  version: row.version,
                },
              ]) as readonly T[],
        );
      }
      if (q.includes('SELECT hash FROM audit_log')) {
        const last = auditRows.at(-1);
        return Promise.resolve((last === undefined ? [] : [{ hash: last[15] }]) as readonly T[]);
      }
      if (q.includes('INSERT INTO audit_log')) {
        auditRows.push(params);
        return Promise.resolve([] as readonly T[]);
      }
      if (q.includes("context -> 'detail'")) {
        const matching = auditRows.filter((r) => r[7] === params[2]);
        const last = matching.at(-1);
        if (last === undefined) return Promise.resolve([] as readonly T[]);
        const context = JSON.parse(String(last[13])) as { detail?: Record<string, string> };
        return Promise.resolve([
          { previous_status: context.detail?.['previousStatus'] ?? null },
        ] as readonly T[]);
      }
      if (q.includes('INSERT INTO outbox_events')) {
        outbox.push(params);
        return Promise.resolve([] as readonly T[]);
      }
      throw new Error(`unexpected statement: ${q}`);
    },
  } as WorkspaceExecutor;

  const service = createWorkspaceService({
    publisher: createOutboxPublisher({ registry: createEventRegistry([...declarations]) }),
    audit: createPersistentAuditWriter({ now: () => NOW, newId: () => EVENT_ID }),
    now: () => NOW,
    newEventId: () => EVENT_ID,
  });

  return {
    outbox,
    status: () => rows.get(WS)?.status,
    async run(...transitions) {
      await service.provision(tx, {
        workspaceId: WS,
        organizationId: ORG,
        slug: 'acme',
        name: 'Acme',
        adminUserId: ADMIN,
        actor: { id: ACTOR, kind: 'user' },
        correlationId: CORRELATION,
      });
      for (const transition of transitions) {
        await service.transition(tx, {
          workspaceId: WS,
          transition,
          reason: 'conformance',
          actor: { id: ACTOR, kind: 'user' },
          correlationId: CORRELATION,
        });
      }
    },
    events() {
      return outbox.map(
        (row) =>
          ({
            eventId: row[0],
            eventType: row[O_TYPE],
            eventVersion: row[O_VERSION],
            aggregateType: row[O_AGGREGATE_TYPE],
            aggregateId: row[O_AGGREGATE_ID],
            tenantId: row[O_TENANT],
            organizationId: row[O_ORG],
            correlationId: row[7],
            causationId: row[8],
            producer: row[O_PRODUCER],
            occurredAt: row[11],
            payload: JSON.parse(String(row[O_PAYLOAD])) as unknown,
          }) as DomainEvent<unknown>,
      );
    },
  };
}

describe('workspace events reach the real transactional outbox', () => {
  it('writes WorkspaceCreated to outbox_events on provisioning', async () => {
    const h = harness();
    await h.run();

    expect(h.outbox).toHaveLength(1);
    expect(h.outbox[0]?.[O_TYPE]).toBe('WorkspaceCreated');
    expect(h.outbox[0]?.[O_AGGREGATE_TYPE]).toBe('Workspace');
    expect(h.outbox[0]?.[O_PRODUCER]).toBe('platform.workspaces');
  });

  it('writes one row per lifecycle event, in order', async () => {
    const h = harness();
    await h.run('suspend', 'reactivate', 'archive', 'restore', 'request_deletion');

    expect(h.outbox.map((r) => r[O_TYPE])).toEqual([
      'WorkspaceCreated',
      'WorkspaceSuspended',
      'WorkspaceReactivated',
      'WorkspaceArchived',
      'WorkspaceReactivated',
      'WorkspaceDeletionRequested',
    ]);
    expect(h.status()).toBe('pending_deletion');
  });
});

describe('workspace envelopes satisfy the frozen envelope contract', () => {
  it('validates every emitted event against the real validator', async () => {
    const h = harness();
    await h.run('suspend', 'reactivate', 'archive', 'restore', 'request_deletion');

    const emitted = h.events();
    expect(emitted).toHaveLength(6);
    for (const event of emitted) {
      const result = validateEnvelope(event);
      expect(result.ok, `${String(event.eventType)}: ${JSON.stringify(result)}`).toBe(true);
    }
  });

  // ADR-017: workspaces.id IS tenant_id. A regression here is cross-tenant.
  it('carries the workspace as tenant on every event', async () => {
    const h = harness();
    await h.run('suspend', 'reactivate');

    expect(h.outbox.length).toBeGreaterThan(0);
    for (const row of h.outbox) {
      expect(row[O_TENANT]).toBe(WS);
      expect(row[O_AGGREGATE_ID]).toBe(WS);
      expect(row[O_ORG]).toBe(ORG);
    }
  });

  // Settings can include competitively sensitive configuration, and an event
  // reaches more consumers than the row does.
  it('emits no settings values in any payload', async () => {
    const h = harness();
    await h.run('suspend', 'archive');

    for (const event of h.events()) {
      const payload = JSON.stringify(event.payload);
      for (const key of ['gateThresholds', 'routing', 'brandVoice', 'approval', 'retention']) {
        expect(payload).not.toContain(key);
      }
    }
  });
});

describe('the registry gates what may be published', () => {
  it('registers every workspace event type the service can emit', () => {
    const registry = createEventRegistry([...DECLARATIONS]);
    for (const eventType of WORKSPACE_EVENT_TYPES) {
      expect(registry.isRegistered(eventType, 1)).toBe(true);
    }
  });

  // Validation runs inside publish, before commit, so an unregistered type
  // rolls the whole provision back rather than reaching the outbox.
  it('refuses to provision when the event type is not registered', async () => {
    const h = harness([]);

    await expect(h.run()).rejects.toMatchObject({ code: 'UnknownEventType' });
    expect(h.outbox).toHaveLength(0);
  });

  it('refuses a transition whose event type is not registered', async () => {
    // Only WorkspaceCreated is declared, so provisioning succeeds and the
    // suspension is refused at the publish step.
    const h = harness(DECLARATIONS.filter((d) => d.eventType === 'WorkspaceCreated'));
    await h.run();
    expect(h.outbox).toHaveLength(1);

    await expect(h.run('suspend')).rejects.toMatchObject({ code: 'UnknownEventType' });
  });
});
