/**
 * Organizations Service — provisioning and lifecycle.
 *
 * The fake below is an in-memory `organizations` / `organization_memberships` /
 * `audit_log`, driven by the SAME SQL the service issues in production. The
 * REAL persistent audit writer runs against it, so the chain, the context
 * payload and the read-back of a recorded prior status are exercised rather
 * than stubbed — reactivation restoring `past_due` is only meaningful if the
 * value genuinely round-trips through an audit row.
 */
import { describe, expect, it } from 'vitest';

import type { DomainEvent, EventPublisher, Transaction } from '@contentos/contracts';
import { createPersistentAuditWriter, GENESIS_HASH } from '@contentos/security';

import { OrganizationError, type OrganizationStatus } from './lifecycle.js';
import {
  createOrganizationService,
  ORGANIZATION_AUDIT_ACTIONS,
  type OrganizationExecutor,
  type OrganizationService,
  type ProvisionOrganizationCommand,
  type TransitionOrganizationCommand,
} from './service.js';

const OWNER = '018f7a1e-0000-7000-8000-000000000001';
const ACTOR = '018f7a1e-0000-7000-8000-000000000002';
const CORRELATION = '018f7a1e-0000-7000-8000-0000000000dd';
const EVENT_ID = '018f7a1e-0000-7000-8000-0000000000ee';
const ORG_ID = '018f7a1e-0000-7000-8000-0000000000aa';
const MEMBERSHIP_ID = '018f7a1e-0000-7000-8000-0000000000bb';
const NOW = new Date('2026-07-30T12:00:00.000Z');

/** audit_log INSERT column positions, from the persistent writer's statement. */
const A_TENANT = 1;
const A_ORG = 2;
const A_ACTOR = 3;
const A_ACTION = 7;
const A_TARGET_KIND = 8;
const A_TARGET_ID = 9;
const A_RESULT = 11;
const A_REASON = 12;
const A_CONTEXT = 13;
const A_PREVIOUS_HASH = 14;
const A_HASH = 15;

interface OrgRow {
  id: string;
  slug: string;
  name: string;
  status: string;
  version: number;
}

interface AuditContextJson {
  readonly detail?: Record<string, string>;
  readonly stepUpSatisfied?: boolean;
}

interface Fake {
  readonly tx: OrganizationExecutor;
  readonly sql: string[];
  readonly organizations: Map<string, OrgRow>;
  readonly memberships: { organizationId: string; userId: string }[];
  readonly auditRows: unknown[][];
  /** Force the next statement matching `needle` to reject. */
  failOn(needle: string, error: Error): void;
  /** Run `hook` immediately after the next statement matching `needle`. */
  afterQuery(needle: string, hook: () => void): void;
  auditActions(): string[];
  auditContext(index: number): AuditContextJson;
}

function uniqueViolation(constraint: string): Error {
  return Object.assign(new Error('duplicate key value violates unique constraint'), {
    code: '23505',
    constraint,
  });
}

function fakeDb(): Fake {
  const organizations = new Map<string, OrgRow>();
  const memberships: { organizationId: string; userId: string }[] = [];
  const auditRows: unknown[][] = [];
  const sql: string[] = [];
  const failures: { needle: string; error: Error }[] = [];
  const hooks: { needle: string; hook: () => void }[] = [];
  let orgSeq = 0;
  let membershipSeq = 0;

  const runHooks = (q: string): void => {
    for (let i = hooks.length - 1; i >= 0; i -= 1) {
      const entry = hooks[i];
      if (entry !== undefined && q.includes(entry.needle)) {
        hooks.splice(i, 1);
        entry.hook();
      }
    }
  };

  function execute(q: string, params: unknown[]): unknown[] {
    if (q.includes('INSERT INTO organizations')) {
      const slug = String(params[0]);
      for (const existing of organizations.values()) {
        if (existing.slug === slug) throw uniqueViolation('uq_organizations__slug');
      }
      orgSeq += 1;
      const id = orgSeq === 1 ? ORG_ID : `018f7a1e-0000-7000-8000-0000000000a${String(orgSeq)}`;
      organizations.set(id, {
        id,
        slug,
        name: String(params[1]),
        status: String(params[2]),
        version: 1,
      });
      return [{ id, version: 1 }];
    }

    if (q.includes('INSERT INTO organization_memberships')) {
      membershipSeq += 1;
      const id =
        membershipSeq === 1
          ? MEMBERSHIP_ID
          : `018f7a1e-0000-7000-8000-0000000000b${String(membershipSeq)}`;
      memberships.push({ organizationId: String(params[0]), userId: String(params[1]) });
      return [{ id }];
    }

    if (q.includes('FROM organizations')) {
      const row = organizations.get(String(params[0]));
      return row === undefined ? [] : [{ ...row }];
    }

    if (q.includes('UPDATE organizations')) {
      const row = organizations.get(String(params[2]));
      if (row === undefined || row.version !== params[3]) return [];
      row.status = String(params[0]);
      row.version += 1;
      return [{ version: row.version }];
    }

    if (q.includes('SELECT hash FROM audit_log')) {
      const matching = auditRows.filter((r) => r[A_TENANT] === params[0]);
      const last = matching.at(-1);
      return last === undefined ? [] : [{ hash: last[A_HASH] }];
    }

    if (q.includes('INSERT INTO audit_log')) {
      auditRows.push(params);
      return [];
    }

    if (q.includes("context -> 'detail'")) {
      const matching = auditRows.filter(
        (r) =>
          r[A_ORG] === params[0] &&
          r[A_TARGET_KIND] === 'organization' &&
          r[A_TARGET_ID] === params[1] &&
          r[A_ACTION] === params[2],
      );
      const last = matching.at(-1);
      if (last === undefined) return [];
      const context = JSON.parse(String(last[A_CONTEXT])) as AuditContextJson;
      return [{ previous_status: context.detail?.['previousStatus'] ?? null }];
    }

    throw new Error(`fake db received an unexpected statement: ${q}`);
  }

  const tx = {
    query<T>(q: string, p?: readonly unknown[]): Promise<readonly T[]> {
      sql.push(q);
      const params = [...(p ?? [])];

      for (let i = failures.length - 1; i >= 0; i -= 1) {
        const entry = failures[i];
        if (entry !== undefined && q.includes(entry.needle)) {
          failures.splice(i, 1);
          return Promise.reject(entry.error);
        }
      }

      let rows: unknown[];
      try {
        rows = execute(q, params);
      } catch (error: unknown) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
      runHooks(q);
      return Promise.resolve(rows as readonly T[]);
    },
  } as OrganizationExecutor;

  return {
    tx,
    sql,
    organizations,
    memberships,
    auditRows,
    failOn(needle, error) {
      failures.push({ needle, error });
    },
    afterQuery(needle, hook) {
      hooks.push({ needle, hook });
    },
    auditActions() {
      return auditRows.map((r) => String(r[A_ACTION]));
    },
    auditContext(index) {
      return JSON.parse(String(auditRows[index]?.[A_CONTEXT])) as AuditContextJson;
    },
  };
}

function recordingPublisher(): EventPublisher & { events: DomainEvent<unknown>[] } {
  const events: DomainEvent<unknown>[] = [];
  return {
    events,
    publish<T>(_tx: Transaction, event: DomainEvent<T>): Promise<void> {
      events.push(event as DomainEvent<unknown>);
      return Promise.resolve();
    },
  };
}

function harness(): {
  db: Fake;
  publisher: EventPublisher & { events: DomainEvent<unknown>[] };
  service: OrganizationService;
} {
  const db = fakeDb();
  const publisher = recordingPublisher();
  const service = createOrganizationService({
    publisher,
    audit: createPersistentAuditWriter({ now: () => NOW, newId: () => EVENT_ID }),
    now: () => NOW,
    newEventId: () => EVENT_ID,
  });
  return { db, publisher, service };
}

function provisionCommand(
  over: Partial<ProvisionOrganizationCommand> = {},
): ProvisionOrganizationCommand {
  return {
    slug: 'acme-media',
    name: 'Acme Media',
    ownerUserId: OWNER,
    actor: { id: ACTOR, kind: 'user' },
    correlationId: CORRELATION,
    ...over,
  };
}

function transitionCommand(
  over: Partial<TransitionOrganizationCommand> = {},
): TransitionOrganizationCommand {
  return {
    organizationId: ORG_ID,
    transition: 'suspend',
    reason: 'Payment grace period elapsed.',
    actor: { id: ACTOR, kind: 'user' },
    correlationId: CORRELATION,
    ...over,
  };
}

/** Provision, then walk the organization to `target` through valid transitions. */
async function at(
  h: ReturnType<typeof harness>,
  ...transitions: TransitionOrganizationCommand['transition'][]
): Promise<void> {
  await h.service.provision(h.db.tx, provisionCommand());
  for (const transition of transitions) {
    await h.service.transition(h.db.tx, transitionCommand({ transition }));
  }
}

describe('organization creation', () => {
  it('inserts the organization as active and returns its id and version', async () => {
    const h = harness();
    const result = await h.service.provision(h.db.tx, provisionCommand());

    expect(result.organizationId).toBe(ORG_ID);
    expect(result.status).toBe('active');
    expect(result.version).toBe(1);
    expect(h.db.organizations.get(ORG_ID)).toMatchObject({
      slug: 'acme-media',
      name: 'Acme Media',
      status: 'active',
    });
  });

  // Organization, owner, audit and event on ONE handle, in this order.
  it('writes organization, owner, audit and outbox event in one transaction', async () => {
    const h = harness();
    await h.service.provision(h.db.tx, provisionCommand());

    const order = h.db.sql.map((s) => {
      if (s.includes('INSERT INTO organizations')) return 'organization';
      if (s.includes('INSERT INTO organization_memberships')) return 'owner';
      if (s.includes('INSERT INTO audit_log')) return 'audit';
      return 'other';
    });
    expect(order.filter((o) => o !== 'other')).toEqual(['organization', 'owner', 'audit']);
    expect(h.publisher.events).toHaveLength(1);
  });

  // The service is handed a transaction; it does not own one.
  it('never issues its own COMMIT or ROLLBACK', async () => {
    const h = harness();
    await h.service.provision(h.db.tx, provisionCommand());
    for (const statement of h.db.sql) {
      expect(statement).not.toMatch(/\b(COMMIT|ROLLBACK|BEGIN)\b/);
    }
  });

  it('records the actor as created_by and updated_by', async () => {
    const h = harness();
    await h.service.provision(h.db.tx, provisionCommand());
    const insert = h.db.sql.find((s) => s.includes('INSERT INTO organizations'));
    expect(insert).toContain('created_by, updated_by');
    expect(insert).toContain('$4,$4');
  });
});

describe('first owner guarantee', () => {
  it('creates exactly one membership, for the nominated owner', async () => {
    const h = harness();
    const result = await h.service.provision(h.db.tx, provisionCommand());

    expect(h.db.memberships).toEqual([{ organizationId: ORG_ID, userId: OWNER }]);
    expect(result.ownerMembershipId).toBe(MEMBERSHIP_ID);
    expect(result.ownerUserId).toBe(OWNER);
  });

  // An organization whose only owner is still `invited` has no active owner —
  // the state last-owner protection exists to make impossible.
  it('makes that membership org_owner and active, not invited', async () => {
    const h = harness();
    await h.service.provision(h.db.tx, provisionCommand());

    const insert = h.db.sql.find((s) => s.includes('INSERT INTO organization_memberships'));
    expect(insert).toContain("'org_owner'");
    expect(insert).toContain("'active'");
    expect(insert).not.toContain("'invited'");
  });

  it('refuses to finish if the owner insert produced no row', async () => {
    const h = harness();
    h.db.failOn(
      'INSERT INTO organization_memberships',
      new Error('membership insert produced nothing'),
    );

    await expect(h.service.provision(h.db.tx, provisionCommand())).rejects.toThrow(
      'membership insert produced nothing',
    );
    expect(h.publisher.events).toHaveLength(0);
  });
});

describe('a partial organization cannot exist', () => {
  // Each failure point aborts before the event is published, so the caller's
  // transaction rolls the organization row back with it.
  it('propagates an owner-insert failure and publishes nothing', async () => {
    const h = harness();
    h.db.failOn('INSERT INTO organization_memberships', new Error('deadlock detected'));

    await expect(h.service.provision(h.db.tx, provisionCommand())).rejects.toThrow(
      'deadlock detected',
    );
    expect(h.db.auditRows).toHaveLength(0);
    expect(h.publisher.events).toHaveLength(0);
  });

  // A failed audit write fails the action it describes — the opposite of logging.
  it('propagates an audit failure and publishes nothing', async () => {
    const h = harness();
    h.db.failOn('INSERT INTO audit_log', new Error('audit_log unavailable'));

    await expect(h.service.provision(h.db.tx, provisionCommand())).rejects.toThrow(
      'audit_log unavailable',
    );
    expect(h.publisher.events).toHaveLength(0);
  });

  // Envelope and registry validation run inside publish, before commit.
  it('propagates a publish failure so the whole provision rolls back', async () => {
    const db = fakeDb();
    const service = createOrganizationService({
      publisher: {
        publish: (): Promise<void> => Promise.reject(new Error('UnknownEventType')),
      },
      audit: createPersistentAuditWriter({ now: () => NOW, newId: () => EVENT_ID }),
      now: () => NOW,
      newEventId: () => EVENT_ID,
    });

    await expect(service.provision(db.tx, provisionCommand())).rejects.toThrow('UnknownEventType');
  });

  it('propagates a transition publish failure', async () => {
    const h = harness();
    await h.service.provision(h.db.tx, provisionCommand());

    const failing = createOrganizationService({
      publisher: { publish: (): Promise<void> => Promise.reject(new Error('bus contract broken')) },
      audit: createPersistentAuditWriter({ now: () => NOW, newId: () => EVENT_ID }),
      now: () => NOW,
      newEventId: () => EVENT_ID,
    });

    await expect(failing.transition(h.db.tx, transitionCommand())).rejects.toThrow(
      'bus contract broken',
    );
  });
});

describe('slug uniqueness is decided by the database', () => {
  it('reports a taken slug as a typed SlugAlreadyTaken', async () => {
    const h = harness();
    await h.service.provision(h.db.tx, provisionCommand());

    const conflict = h.service.provision(h.db.tx, provisionCommand());
    await expect(conflict).rejects.toBeInstanceOf(OrganizationError);
    await expect(conflict).rejects.toMatchObject({ code: 'SlugAlreadyTaken' });
  });

  // Two provisions racing on the same slug: no prior SELECT could separate
  // them, because both would pass a check-then-act.
  it('lets exactly one of two concurrent provisions win', async () => {
    const h = harness();
    const results = await Promise.allSettled([
      h.service.provision(h.db.tx, provisionCommand({ slug: 'contested' })),
      h.service.provision(h.db.tx, provisionCommand({ slug: 'contested' })),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: 'SlugAlreadyTaken',
    });
  });

  it('does not disguise an unrelated database error as a slug conflict', async () => {
    const h = harness();
    h.db.failOn('INSERT INTO organizations', new Error('connection reset'));

    await expect(h.service.provision(h.db.tx, provisionCommand())).rejects.toThrow(
      'connection reset',
    );
  });
});

describe('lifecycle transitions', () => {
  const CASES: readonly {
    readonly transition: TransitionOrganizationCommand['transition'];
    readonly path: TransitionOrganizationCommand['transition'][];
    readonly expected: OrganizationStatus;
  }[] = [
    { transition: 'payment_failed', path: [], expected: 'past_due' },
    { transition: 'payment_recovered', path: ['payment_failed'], expected: 'active' },
    { transition: 'suspend', path: [], expected: 'suspended' },
    { transition: 'request_closure', path: [], expected: 'pending_closure' },
    { transition: 'close', path: ['request_closure'], expected: 'closed' },
  ];

  for (const { transition, path, expected } of CASES) {
    it(`moves the organization to '${expected}' on '${transition}'`, async () => {
      const h = harness();
      await at(h, ...path);
      const result = await h.service.transition(h.db.tx, transitionCommand({ transition }));

      expect(result.status).toBe(expected);
      expect(h.db.organizations.get(ORG_ID)?.status).toBe(expected);
    });
  }

  it('reports the status it moved away from', async () => {
    const h = harness();
    await at(h, 'payment_failed');
    const result = await h.service.transition(
      h.db.tx,
      transitionCommand({ transition: 'suspend' }),
    );

    expect(result.previousStatus).toBe('past_due');
    expect(result.status).toBe('suspended');
  });

  it('bumps the version on every transition', async () => {
    const h = harness();
    await h.service.provision(h.db.tx, provisionCommand());

    const first = await h.service.transition(
      h.db.tx,
      transitionCommand({ transition: 'payment_failed' }),
    );
    const second = await h.service.transition(
      h.db.tx,
      transitionCommand({ transition: 'suspend' }),
    );
    expect(first.version).toBe(2);
    expect(second.version).toBe(3);
  });

  it('refuses a transition the state machine does not permit, before any write', async () => {
    const h = harness();
    await at(h, 'request_closure', 'close');
    const before = h.db.sql.length;

    const rejected = h.service.transition(h.db.tx, transitionCommand({ transition: 'reactivate' }));
    await expect(rejected).rejects.toMatchObject({ code: 'InvalidTransition' });

    // Only the state read happened; no UPDATE, no audit, no event.
    expect(h.db.sql.slice(before).filter((s) => s.includes('UPDATE organizations'))).toHaveLength(
      0,
    );
    expect(h.db.organizations.get(ORG_ID)?.status).toBe('closed');
  });

  it('answers an unknown organization as absent', async () => {
    const h = harness();
    const missing = h.service.transition(
      h.db.tx,
      transitionCommand({ organizationId: '018f7a1e-0000-7000-8000-00000000ffff' }),
    );
    await expect(missing).rejects.toMatchObject({ code: 'OrganizationNotFound' });
  });
});

describe('reactivation restores the previous recorded state', () => {
  // The headline rule: a debt is not forgiven by lifting a suspension.
  it('returns a past_due organization to past_due, not active', async () => {
    const h = harness();
    await at(h, 'payment_failed', 'suspend');
    expect(h.db.organizations.get(ORG_ID)?.status).toBe('suspended');

    const result = await h.service.transition(
      h.db.tx,
      transitionCommand({ transition: 'reactivate' }),
    );
    expect(result.status).toBe('past_due');
    expect(h.db.organizations.get(ORG_ID)?.status).toBe('past_due');
  });

  it('returns an active organization to active', async () => {
    const h = harness();
    await at(h, 'suspend');
    const result = await h.service.transition(
      h.db.tx,
      transitionCommand({ transition: 'reactivate' }),
    );
    expect(result.status).toBe('active');
  });

  it('reads the MOST RECENT suspension, not the first', async () => {
    const h = harness();
    await at(h, 'suspend', 'reactivate', 'payment_failed', 'suspend');

    const result = await h.service.transition(
      h.db.tx,
      transitionCommand({ transition: 'reactivate' }),
    );
    expect(result.status).toBe('past_due');
  });

  it('falls back to active when no suspension was ever recorded', async () => {
    const h = harness();
    await h.service.provision(h.db.tx, provisionCommand());
    // Move to suspended without leaving an audit trail the restore can read.
    const row = h.db.organizations.get(ORG_ID);
    if (row !== undefined) row.status = 'suspended';

    const result = await h.service.transition(
      h.db.tx,
      transitionCommand({ transition: 'reactivate' }),
    );
    expect(result.status).toBe('active');
  });

  // Cancelling a closure must not quietly lift a suspension.
  it('returns a cancelled closure to the suspension it was requested under', async () => {
    const h = harness();
    await at(h, 'suspend', 'request_closure');

    const result = await h.service.transition(
      h.db.tx,
      transitionCommand({ transition: 'cancel_closure' }),
    );
    expect(result.status).toBe('suspended');
  });

  it('returns a cancelled closure to active when it was requested from active', async () => {
    const h = harness();
    await at(h, 'request_closure');
    const result = await h.service.transition(
      h.db.tx,
      transitionCommand({ transition: 'cancel_closure' }),
    );
    expect(result.status).toBe('active');
  });

  it('does not consult the audit trail for a non-restoring transition', async () => {
    const h = harness();
    await h.service.provision(h.db.tx, provisionCommand());
    const before = h.db.sql.length;

    await h.service.transition(h.db.tx, transitionCommand({ transition: 'suspend' }));
    expect(h.db.sql.slice(before).filter((s) => s.includes("context -> 'detail'"))).toHaveLength(0);
  });
});

describe('audit generation', () => {
  it('records organization.created on provisioning', async () => {
    const h = harness();
    await h.service.provision(h.db.tx, provisionCommand());

    expect(h.db.auditActions()).toEqual([ORGANIZATION_AUDIT_ACTIONS.provision]);
    const row = h.db.auditRows[0];
    expect(row?.[A_ORG]).toBe(ORG_ID);
    expect(row?.[A_ACTOR]).toBe(ACTOR);
    expect(row?.[A_TARGET_KIND]).toBe('organization');
    expect(row?.[A_TARGET_ID]).toBe(ORG_ID);
    expect(row?.[A_RESULT]).toBe('success');
  });

  it('records an enumerated action for every transition', async () => {
    const h = harness();
    await at(h, 'payment_failed', 'suspend', 'reactivate', 'request_closure', 'cancel_closure');

    expect(h.db.auditActions()).toEqual([
      ORGANIZATION_AUDIT_ACTIONS.provision,
      ORGANIZATION_AUDIT_ACTIONS.payment_failed,
      ORGANIZATION_AUDIT_ACTIONS.suspend,
      ORGANIZATION_AUDIT_ACTIONS.reactivate,
      ORGANIZATION_AUDIT_ACTIONS.request_closure,
      ORGANIZATION_AUDIT_ACTIONS.cancel_closure,
    ]);
  });

  // This detail is not decoration: it is what a later restore reads back.
  it('records the status the transition moved away from', async () => {
    const h = harness();
    await at(h, 'payment_failed', 'suspend');

    expect(h.db.auditContext(1).detail).toMatchObject({
      previousStatus: 'active',
      status: 'past_due',
      transition: 'payment_failed',
    });
    expect(h.db.auditContext(2).detail).toMatchObject({
      previousStatus: 'past_due',
      status: 'suspended',
    });
  });

  it('carries the mandatory reason, including on success', async () => {
    const h = harness();
    await at(h);
    await h.service.transition(
      h.db.tx,
      transitionCommand({ transition: 'suspend', reason: 'Abuse report #4821 upheld.' }),
    );
    expect(h.db.auditRows[1]?.[A_REASON]).toBe('Abuse report #4821 upheld.');
  });

  it('preserves caller-supplied request context alongside the domain detail', async () => {
    const h = harness();
    await at(h);
    await h.service.transition(
      h.db.tx,
      transitionCommand({
        transition: 'suspend',
        context: {
          ipAddress: '198.51.100.7',
          userAgent: 'console/1.0',
          sessionId: 'sess-1',
          stepUpSatisfied: true,
        },
      }),
    );

    const context = h.db.auditContext(1);
    expect(context.stepUpSatisfied).toBe(true);
    expect(context.detail).toMatchObject({ previousStatus: 'active' });
  });

  // The chain is what makes the trail tamper-evident.
  it('chains each record to the one before it', async () => {
    const h = harness();
    await at(h, 'suspend');

    expect(h.db.auditRows[0]?.[A_PREVIOUS_HASH]).toBe(GENESIS_HASH);
    expect(h.db.auditRows[1]?.[A_PREVIOUS_HASH]).toBe(h.db.auditRows[0]?.[A_HASH]);
  });

  it('scopes the record to the organization so it is readable back', async () => {
    const h = harness();
    await h.service.provision(h.db.tx, provisionCommand());
    expect(h.db.auditRows[0]?.[A_TENANT]).toBe(ORG_ID);
  });
});

describe('outbox generation', () => {
  it('publishes OrganizationCreated with the documented payload', async () => {
    const h = harness();
    await h.service.provision(h.db.tx, provisionCommand());

    const [event] = h.publisher.events;
    expect(event).toMatchObject({
      eventId: EVENT_ID,
      eventType: 'OrganizationCreated',
      eventVersion: 1,
      aggregateType: 'Organization',
      aggregateId: ORG_ID,
      organizationId: ORG_ID,
      correlationId: CORRELATION,
      causationId: null,
      producer: 'platform.organizations',
      occurredAt: '2026-07-30T12:00:00.000Z',
      payload: {
        organizationId: ORG_ID,
        name: 'Acme Media',
        slug: 'acme-media',
        createdBy: OWNER,
      },
    });
  });

  it('carries a causation id when the action reacted to another event', async () => {
    const h = harness();
    const causation = '018f7a1e-0000-7000-8000-0000000000cc';
    await h.service.provision(h.db.tx, provisionCommand({ causationId: causation }));
    expect(h.publisher.events[0]?.causationId).toBe(causation);
  });

  it('publishes OrganizationSuspended with the reason and timestamp', async () => {
    const h = harness();
    await at(h);
    await h.service.transition(
      h.db.tx,
      transitionCommand({ transition: 'suspend', reason: 'Grace period elapsed.' }),
    );

    expect(h.publisher.events[1]).toMatchObject({
      eventType: 'OrganizationSuspended',
      payload: {
        organizationId: ORG_ID,
        reason: 'Grace period elapsed.',
        suspendedAt: '2026-07-30T12:00:00.000Z',
      },
    });
  });

  it('publishes OrganizationReactivated', async () => {
    const h = harness();
    await at(h, 'suspend');
    await h.service.transition(h.db.tx, transitionCommand({ transition: 'reactivate' }));

    expect(h.publisher.events.at(-1)).toMatchObject({
      eventType: 'OrganizationReactivated',
      payload: { organizationId: ORG_ID },
    });
  });

  it('publishes OrganizationClosureRequested with a purge date 30 days out', async () => {
    const h = harness();
    await at(h);
    await h.service.transition(h.db.tx, transitionCommand({ transition: 'request_closure' }));

    expect(h.publisher.events[1]).toMatchObject({
      eventType: 'OrganizationClosureRequested',
      payload: { organizationId: ORG_ID, purgeAfter: '2026-08-29T12:00:00.000Z' },
    });
  });

  it('publishes OrganizationClosed', async () => {
    const h = harness();
    await at(h, 'request_closure');
    await h.service.transition(h.db.tx, transitionCommand({ transition: 'close' }));

    expect(h.publisher.events.at(-1)).toMatchObject({
      eventType: 'OrganizationClosed',
      payload: { organizationId: ORG_ID, closedAt: '2026-07-30T12:00:00.000Z' },
    });
  });

  // Payment transitions are REACTIONS to Commerce events; the contract defines
  // no emitted event for them, and re-emitting would echo Commerce back at
  // itself. They are audited all the same.
  it('publishes nothing for transitions the contract defines no event for', async () => {
    const h = harness();
    await at(h);
    const before = h.publisher.events.length;

    for (const transition of ['payment_failed', 'payment_recovered'] as const) {
      const result = await h.service.transition(h.db.tx, transitionCommand({ transition }));
      expect(result.event).toBeNull();
    }
    expect(h.publisher.events).toHaveLength(before);
    expect(h.db.auditActions()).toHaveLength(3);
  });

  it('publishes every organization event under the organization as tenant', async () => {
    const h = harness();
    await at(h, 'suspend');
    expect(h.publisher.events).not.toHaveLength(0);
    for (const event of h.publisher.events) {
      expect(event.tenantId).toBe(ORG_ID);
      expect(event.organizationId).toBe(ORG_ID);
      expect(event.aggregateId).toBe(ORG_ID);
    }
  });
});

describe('concurrency', () => {
  // The version predicate is what serialises interleaved transitions.
  it('refuses a transition whose expected version is stale', async () => {
    const h = harness();
    await h.service.provision(h.db.tx, provisionCommand());

    const stale = h.service.transition(
      h.db.tx,
      transitionCommand({ transition: 'suspend', expectedVersion: 99 }),
    );
    await expect(stale).rejects.toBeInstanceOf(OrganizationError);
    await expect(stale).rejects.toMatchObject({ code: 'ConcurrentModification' });
    expect(h.db.organizations.get(ORG_ID)?.status).toBe('active');
  });

  it('refuses when another writer commits between the read and the update', async () => {
    const h = harness();
    await h.service.provision(h.db.tx, provisionCommand());

    // A competing transition lands after this one has read the state.
    h.db.afterQuery('FROM organizations', () => {
      const row = h.db.organizations.get(ORG_ID);
      if (row !== undefined) row.version += 1;
    });

    const loser = h.service.transition(h.db.tx, transitionCommand({ transition: 'suspend' }));
    await expect(loser).rejects.toMatchObject({ code: 'ConcurrentModification' });
  });

  it('leaves no audit record or event behind when it loses the race', async () => {
    const h = harness();
    await h.service.provision(h.db.tx, provisionCommand());
    const auditBefore = h.db.auditRows.length;
    const eventsBefore = h.publisher.events.length;

    await expect(
      h.service.transition(h.db.tx, transitionCommand({ expectedVersion: 42 })),
    ).rejects.toMatchObject({ code: 'ConcurrentModification' });

    expect(h.db.auditRows).toHaveLength(auditBefore);
    expect(h.publisher.events).toHaveLength(eventsBefore);
  });

  it('lets exactly one of two concurrent transitions win', async () => {
    const h = harness();
    await h.service.provision(h.db.tx, provisionCommand());

    const results = await Promise.allSettled([
      h.service.transition(h.db.tx, transitionCommand({ transition: 'suspend' })),
      h.service.transition(h.db.tx, transitionCommand({ transition: 'payment_failed' })),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected');
    expect((rejected as PromiseRejectedResult).reason).toMatchObject({
      code: 'ConcurrentModification',
    });
  });

  it('accepts an explicit expected version that is current', async () => {
    const h = harness();
    await h.service.provision(h.db.tx, provisionCommand());

    const result = await h.service.transition(
      h.db.tx,
      transitionCommand({ transition: 'suspend', expectedVersion: 1 }),
    );
    expect(result.version).toBe(2);
  });
});
