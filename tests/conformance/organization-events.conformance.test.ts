/**
 * Organization events against the REAL event platform.
 *
 * `packages/platform` cannot import `packages/events` — both are feature-tier,
 * and feature packages communicate via contracts
 * (`07-development-guide/project-structure.md` rule 4). That boundary is
 * correct, and it means the platform package's own suite necessarily publishes
 * through a fake.
 *
 * So the two halves are joined HERE, where cross-package wiring belongs: the
 * real registry, the real envelope validator and the real transactional outbox
 * publisher, fed by the real Organizations Service. Nothing in
 * `packages/events` is modified or re-implemented — this suite only asserts
 * that what the platform emits is something that platform accepts.
 *
 * What it would catch: an organization payload that trips a payload rule, an
 * envelope field the platform forgot, a `tenantId` that is not a UUID, or an
 * event type published without being registered.
 */

import { describe, expect, it } from 'vitest';

import type { DomainEvent, Transaction } from '@contentos/contracts';
import {
  createEventRegistry,
  createOutboxPublisher,
  validateEnvelope,
  type EventTypeDeclaration,
} from '@contentos/events';
import {
  createOrganizationService,
  ORGANIZATION_EVENT_TYPES,
  type OrganizationExecutor,
  type OrganizationTransition,
} from '@contentos/platform';
import { createPersistentAuditWriter } from '@contentos/security';

const OWNER = '018f7a1e-0000-7000-8000-000000000001';
const ACTOR = '018f7a1e-0000-7000-8000-000000000002';
const CORRELATION = '018f7a1e-0000-7000-8000-0000000000dd';
const EVENT_ID = '018f7a1e-0000-7000-8000-0000000000ee';
const ORG_ID = '018f7a1e-0000-7000-8000-0000000000aa';
const NOW = new Date('2026-07-30T12:00:00.000Z');

/** outbox_events INSERT column positions, from the publisher's statement. */
const O_EVENT_ID = 0;
const O_TENANT = 1;
const O_ORG = 2;
const O_TYPE = 3;
const O_VERSION = 4;
const O_AGGREGATE_TYPE = 5;
const O_AGGREGATE_ID = 6;
const O_CORRELATION = 7;
const O_PRODUCER = 9;
const O_PAYLOAD = 10;

/** Every organization event type, declared as the source-controlled registry would. */
const DECLARATIONS: readonly EventTypeDeclaration[] = ORGANIZATION_EVENT_TYPES.map((eventType) => ({
  eventType,
  version: 1,
  state: 'active' as const,
  stream: 'organization',
  consumers: [],
}));

interface Harness {
  readonly tx: OrganizationExecutor;
  readonly outbox: unknown[][];
  readonly statuses: Map<string, { status: string; version: number }>;
  run(...transitions: OrganizationTransition[]): Promise<void>;
  events(): DomainEvent<unknown>[];
}

function harness(): Harness {
  const outbox: unknown[][] = [];
  const auditRows: unknown[][] = [];
  const statuses = new Map<string, { status: string; version: number }>();

  const tx = {
    query<T>(q: string, p?: readonly unknown[]): Promise<readonly T[]> {
      const params = [...(p ?? [])];

      if (q.includes('INSERT INTO organizations')) {
        statuses.set(ORG_ID, { status: String(params[2]), version: 1 });
        return Promise.resolve([{ id: ORG_ID, version: 1 }] as readonly T[]);
      }
      if (q.includes('INSERT INTO organization_memberships')) {
        return Promise.resolve([{ id: '018f7a1e-0000-7000-8000-0000000000bb' }] as readonly T[]);
      }
      if (q.includes('FROM organizations')) {
        const row = statuses.get(String(params[0]));
        return Promise.resolve(
          (row === undefined
            ? []
            : [{ id: ORG_ID, slug: 'acme', name: 'Acme', ...row }]) as readonly T[],
        );
      }
      if (q.includes('UPDATE organizations')) {
        const row = statuses.get(String(params[2]));
        if (row === undefined || row.version !== params[3])
          return Promise.resolve([] as readonly T[]);
        row.status = String(params[0]);
        row.version += 1;
        return Promise.resolve([{ version: row.version }] as readonly T[]);
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
  } as OrganizationExecutor;

  const service = createOrganizationService({
    publisher: createOutboxPublisher({ registry: createEventRegistry([...DECLARATIONS]) }),
    audit: createPersistentAuditWriter({ now: () => NOW, newId: () => EVENT_ID }),
    now: () => NOW,
    newEventId: () => EVENT_ID,
  });

  return {
    tx,
    outbox,
    statuses,
    async run(...transitions) {
      await service.provision(tx, {
        slug: 'acme',
        name: 'Acme',
        ownerUserId: OWNER,
        actor: { id: ACTOR, kind: 'user' },
        correlationId: CORRELATION,
      });
      for (const transition of transitions) {
        await service.transition(tx, {
          organizationId: ORG_ID,
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
            eventId: row[O_EVENT_ID],
            eventType: row[O_TYPE],
            eventVersion: row[O_VERSION],
            aggregateType: row[O_AGGREGATE_TYPE],
            aggregateId: row[O_AGGREGATE_ID],
            tenantId: row[O_TENANT],
            organizationId: row[O_ORG],
            correlationId: row[O_CORRELATION],
            causationId: row[8],
            producer: row[O_PRODUCER],
            occurredAt: row[11],
            payload: JSON.parse(String(row[O_PAYLOAD])) as unknown,
          }) as DomainEvent<unknown>,
      );
    },
  };
}

describe('organization events reach the real transactional outbox', () => {
  it('writes OrganizationCreated to outbox_events on provisioning', async () => {
    const h = harness();
    await h.run();

    expect(h.outbox).toHaveLength(1);
    expect(h.outbox[0]?.[O_TYPE]).toBe('OrganizationCreated');
    expect(h.outbox[0]?.[O_AGGREGATE_TYPE]).toBe('Organization');
    expect(h.outbox[0]?.[O_PRODUCER]).toBe('platform.organizations');
  });

  it('writes one row per lifecycle event, in order', async () => {
    const h = harness();
    await h.run('suspend', 'reactivate', 'request_closure', 'close');

    expect(h.outbox.map((r) => r[O_TYPE])).toEqual([
      'OrganizationCreated',
      'OrganizationSuspended',
      'OrganizationReactivated',
      'OrganizationClosureRequested',
      'OrganizationClosed',
    ]);
  });

  // ADR-020: the event is a row in the SAME transaction as the state change.
  it('publishes on the same handle that wrote the organization', async () => {
    const h = harness();
    await h.run('suspend');
    // Nothing above committed anything: every write went through one `tx`, and
    // the outbox rows are present because that handle accepted them.
    expect(h.outbox.length).toBeGreaterThan(0);
    expect(h.statuses.get(ORG_ID)?.status).toBe('suspended');
  });
});

describe('organization envelopes satisfy the frozen envelope contract', () => {
  it('validates every emitted event against the real validator', async () => {
    const h = harness();
    await h.run('suspend', 'reactivate', 'request_closure', 'close');

    const emitted = h.events();
    expect(emitted).toHaveLength(5);
    for (const event of emitted) {
      const result = validateEnvelope(event);
      expect(result.ok, `${String(event.eventType)}: ${JSON.stringify(result)}`).toBe(true);
    }
  });

  // Payload rules reject credentials, content and personal data. An
  // organization name is none of those; this pins that it stays that way.
  it('emits payloads that carry identifiers and immutable values only', async () => {
    const h = harness();
    await h.run('suspend');

    for (const event of h.events()) {
      expect(validateEnvelope(event).ok).toBe(true);
      expect(JSON.stringify(event.payload)).toContain('organizationId');
    }
  });

  it('partitions every organization event on the organization', async () => {
    const h = harness();
    await h.run('suspend', 'reactivate');

    for (const row of h.outbox) {
      expect(row[O_AGGREGATE_ID]).toBe(ORG_ID);
      expect(row[O_ORG]).toBe(ORG_ID);
      expect(row[O_TENANT]).toBe(ORG_ID);
    }
  });
});

describe('the registry gates what may be published', () => {
  it('registers every organization event type the service can emit', () => {
    const registry = createEventRegistry([...DECLARATIONS]);
    for (const eventType of ORGANIZATION_EVENT_TYPES) {
      expect(registry.isRegistered(eventType, 1)).toBe(true);
    }
  });

  // Validation runs inside publish, before commit, so an unregistered type
  // rolls the state change back rather than reaching the outbox.
  it('refuses to provision when the event type is not registered', async () => {
    const h = harness();
    const service = createOrganizationService({
      publisher: createOutboxPublisher({ registry: createEventRegistry([]) }),
      audit: createPersistentAuditWriter({ now: () => NOW, newId: () => EVENT_ID }),
      now: () => NOW,
      newEventId: () => EVENT_ID,
    });

    await expect(
      service.provision(h.tx, {
        slug: 'acme',
        name: 'Acme',
        ownerUserId: OWNER,
        actor: { id: ACTOR, kind: 'user' },
        correlationId: CORRELATION,
      }),
    ).rejects.toMatchObject({ code: 'UnknownEventType' });
    expect(h.outbox).toHaveLength(0);
  });

  it('requires a live transaction handle to publish at all', async () => {
    const publisher = createOutboxPublisher({ registry: createEventRegistry([...DECLARATIONS]) });
    const notATransaction = {} as Transaction;

    await expect(
      publisher.publish(notATransaction, {
        eventId: EVENT_ID,
        eventType: 'OrganizationCreated',
        eventVersion: 1,
        aggregateType: 'Organization',
        aggregateId: ORG_ID,
        tenantId: ORG_ID,
        organizationId: ORG_ID,
        correlationId: CORRELATION,
        causationId: null,
        producer: 'platform.organizations',
        occurredAt: NOW.toISOString(),
        payload: { organizationId: ORG_ID },
      }),
    ).rejects.toThrow(TypeError);
  });
});
