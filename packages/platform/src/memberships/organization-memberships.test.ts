/**
 * Organization memberships — invite, accept, role change, revoke.
 *
 * The fake models transactions and a real keyed mutex, because last-owner
 * protection is a count-then-act and the property under test is that two
 * concurrent revocations cannot both pass it. That race is run in both
 * directions: with the advisory lock enforced exactly one succeeds, and with it
 * ignored an organization is left with NO active owner.
 *
 * The real persistent audit writer runs against the fake `audit_log`.
 */
import { describe, expect, it } from 'vitest';

import type { DomainEvent, EventPublisher, Transaction } from '@contentos/contracts';
import { createPersistentAuditWriter, GENESIS_HASH } from '@contentos/security';

import { MembershipError } from './membership.js';
import {
  createOrganizationMembershipService,
  ORGANIZATION_MEMBERSHIP_AUDIT_ACTIONS,
  organizationMembershipBinding,
  type MembershipExecutor,
  type OrganizationMembershipService,
} from './organization-memberships.js';

const ORG = '018f7a1e-0000-7000-8000-0000000000aa';
const OWNER = '018f7a1e-0000-7000-8000-000000000001';
const OWNER2 = '018f7a1e-0000-7000-8000-000000000005';
const ADMIN = '018f7a1e-0000-7000-8000-000000000002';
const INVITEE = '018f7a1e-0000-7000-8000-000000000003';
const CORRELATION = '018f7a1e-0000-7000-8000-0000000000dd';
const EVENT_ID = '018f7a1e-0000-7000-8000-0000000000ee';
const NOW = new Date('2026-07-30T12:00:00.000Z');
const EXPIRY = '2026-08-13T12:00:00.000Z';

const A_TENANT = 1;
const A_ACTION = 7;
const A_TARGET_KIND = 8;
const A_TARGET_ID = 9;
const A_CONTEXT = 13;
const A_PREVIOUS_HASH = 14;
const A_HASH = 15;

interface Row {
  id: string;
  organization_id: string;
  user_id: string;
  role: string;
  status: string;
  expires_at: string | null;
  created_by: string;
}

function keyedMutex(): { acquire(key: string): Promise<() => void> } {
  const chains = new Map<string, Promise<void>>();
  return {
    async acquire(key: string): Promise<() => void> {
      const previous = chains.get(key) ?? Promise.resolve();
      let release!: () => void;
      const current = new Promise<void>((resolve) => {
        release = resolve;
      });
      chains.set(
        key,
        previous.then(() => current),
      );
      await previous;
      return release;
    },
  };
}

interface Db {
  readonly rows: Map<string, Row>;
  readonly auditRows: unknown[][];
  readonly sql: string[];
  readonly lockKeys: string[];
  transaction<T>(work: (tx: MembershipExecutor) => Promise<T>): Promise<T>;
  failOn(needle: string, error: Error): void;
  seed(userId: string, role: string, status: string, expiresAt?: string | null): string;
  auditActions(): string[];
  auditContext(index: number): { detail?: Record<string, string> };
}

function db(options: { advisoryLocks?: 'enforced' | 'ignored' } = {}): Db {
  const mode = options.advisoryLocks ?? 'enforced';
  const mutex = keyedMutex();
  const rows = new Map<string, Row>();
  const auditRows: unknown[][] = [];
  const sql: string[] = [];
  const lockKeys: string[] = [];
  const failures: { needle: string; error: Error }[] = [];
  let seq = 0;

  const key = (organizationId: string, userId: string): string => `${organizationId}:${userId}`;
  const byId = (id: string): Row | undefined => [...rows.values()].find((r) => r.id === id);

  async function execute(
    q: string,
    params: unknown[],
    session: { held: (() => void)[] },
  ): Promise<unknown[]> {
    if (q.includes('pg_advisory_xact_lock')) {
      lockKeys.push(String(params[0]));
      if (mode === 'enforced') session.held.push(await mutex.acquire(String(params[0])));
      return [];
    }

    if (q.includes('count(*)::int')) {
      const count = [...rows.values()].filter(
        (r) => r.organization_id === params[0] && r.role === params[1] && r.status === 'active',
      ).length;
      return [{ count }];
    }

    if (q.includes('FROM organization_memberships')) {
      const row = rows.get(key(String(params[0]), String(params[1])));
      return row === undefined ? [] : [{ ...row }];
    }

    if (q.includes('INSERT INTO organization_memberships')) {
      seq += 1;
      const id = `018f7a1e-0000-7000-8000-00000000e${String(seq).padStart(3, '0')}`;
      const row: Row = {
        id,
        organization_id: String(params[0]),
        user_id: String(params[1]),
        role: String(params[2]),
        status: 'invited',
        expires_at: typeof params[3] === 'string' ? params[3] : null,
        created_by: String(params[4]),
      };
      rows.set(key(row.organization_id, row.user_id), row);
      return [{ id, created_at: NOW }];
    }

    if (q.includes('UPDATE organization_memberships')) {
      // Matched on the SET clause, not the WHERE: `ACCEPT_SQL` also mentions
      // `status = 'invited'`, in its predicate.
      // Re-invite: [role, expiresAt, actor, id, expectedStatus]
      if (q.includes("SET role = $1, status = 'invited'")) {
        const row = byId(String(params[3]));
        if (row === undefined || row.status !== params[4]) return [];
        row.role = String(params[0]);
        row.status = 'invited';
        row.expires_at = String(params[1]);
        return [{ id: row.id }];
      }
      // Accept: [actor, id] — CAS on status = 'invited'
      if (q.includes("SET status = 'active'")) {
        const row = byId(String(params[1]));
        if (row === undefined || row.status !== 'invited') return [];
        row.status = 'active';
        row.expires_at = null;
        return [{ id: row.id }];
      }
      // Revoke: [actor, id, priorStatus]
      if (q.includes("SET status = 'revoked'")) {
        const row = byId(String(params[1]));
        if (row === undefined || row.status !== params[2]) return [];
        row.status = 'revoked';
        return [{ id: row.id }];
      }
      // Change role: [role, actor, id, previousRole]
      const row = byId(String(params[2]));
      if (row === undefined || row.role !== params[3] || row.status !== 'active') return [];
      row.role = String(params[0]);
      return [{ id: row.id }];
    }

    if (q.includes('SELECT hash FROM audit_log')) {
      const last = auditRows.filter((r) => r[A_TENANT] === params[0]).at(-1);
      return last === undefined ? [] : [{ hash: last[A_HASH] }];
    }
    if (q.includes('INSERT INTO audit_log')) {
      auditRows.push(params);
      return [];
    }

    throw new Error(`fake db received an unexpected statement: ${q}`);
  }

  return {
    rows,
    auditRows,
    sql,
    lockKeys,
    async transaction(work) {
      const session = { held: [] as (() => void)[] };
      const tx = {
        async query<T>(q: string, p?: readonly unknown[]): Promise<readonly T[]> {
          sql.push(q);
          const params = [...(p ?? [])];
          for (let i = failures.length - 1; i >= 0; i -= 1) {
            const entry = failures[i];
            if (entry !== undefined && q.includes(entry.needle)) {
              failures.splice(i, 1);
              throw entry.error;
            }
          }
          return (await execute(q, params, session)) as readonly T[];
        },
      } as MembershipExecutor;
      try {
        return await work(tx);
      } finally {
        for (const release of session.held) release();
      }
    },
    failOn(needle, error) {
      failures.push({ needle, error });
    },
    seed(userId, role, status, expiresAt = null) {
      seq += 1;
      const id = `018f7a1e-0000-7000-8000-00000000f${String(seq).padStart(3, '0')}`;
      rows.set(key(ORG, userId), {
        id,
        organization_id: ORG,
        user_id: userId,
        role,
        status,
        expires_at: expiresAt,
        created_by: OWNER,
      });
      return id;
    },
    auditActions() {
      return auditRows.map((r) => String(r[A_ACTION]));
    },
    auditContext(index) {
      return JSON.parse(String(auditRows[index]?.[A_CONTEXT])) as {
        detail?: Record<string, string>;
      };
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

interface Harness {
  db: Db;
  publisher: EventPublisher & { events: DomainEvent<unknown>[] };
  service: OrganizationMembershipService;
}

function harness(options: { advisoryLocks?: 'enforced' | 'ignored' } = {}): Harness {
  const database = db(options);
  const publisher = recordingPublisher();
  const service = createOrganizationMembershipService({
    publisher,
    audit: createPersistentAuditWriter({ now: () => NOW, newId: () => EVENT_ID }),
    now: () => NOW,
    newEventId: () => EVENT_ID,
  });
  // Every organization starts with an owner, as provisioning guarantees.
  database.seed(OWNER, 'org_owner', 'active');
  return { db: database, publisher, service };
}

const base = {
  organizationId: ORG,
  actor: { id: OWNER, kind: 'user' as const },
  correlationId: CORRELATION,
};

describe('organization invite', () => {
  it('creates an invited membership with a 14-day expiry', async () => {
    const h = harness();
    const result = await h.db.transaction((tx) =>
      h.service.invite(tx, { ...base, userId: INVITEE, role: 'org_member' }),
    );

    expect(result.membership).toMatchObject({
      organizationId: ORG,
      userId: INVITEE,
      role: 'org_member',
      status: 'invited',
    });
    expect(result.membership.expiresAt?.toISOString()).toBe(EXPIRY);
    expect(h.db.rows.get(`${ORG}:${INVITEE}`)).toMatchObject({ status: 'invited' });
  });

  it('writes membership, audit and event on one handle, issuing no COMMIT', async () => {
    const h = harness();
    await h.db.transaction((tx) =>
      h.service.invite(tx, { ...base, userId: INVITEE, role: 'org_member' }),
    );

    expect(h.db.auditActions()).toEqual([ORGANIZATION_MEMBERSHIP_AUDIT_ACTIONS.invited]);
    expect(h.publisher.events).toHaveLength(1);
    for (const statement of h.db.sql) {
      expect(statement).not.toMatch(/\b(COMMIT|ROLLBACK|BEGIN)\b/);
    }
  });

  // Rule 3: org_admin may not create an org_owner.
  it('refuses a role the actor may not grant', async () => {
    const h = harness();
    h.db.seed(ADMIN, 'org_admin', 'active');

    const rejected = h.db.transaction((tx) =>
      h.service.invite(tx, {
        ...base,
        actor: { id: ADMIN, kind: 'user' },
        userId: INVITEE,
        role: 'org_owner',
      }),
    );
    await expect(rejected).rejects.toBeInstanceOf(MembershipError);
    await expect(rejected).rejects.toMatchObject({ code: 'RoleGrantNotPermitted' });
  });

  it('refuses an actor who is not an active member', async () => {
    const h = harness();
    const rejected = h.db.transaction((tx) =>
      h.service.invite(tx, {
        ...base,
        actor: { id: INVITEE, kind: 'user' },
        userId: ADMIN,
        role: 'org_member',
      }),
    );
    await expect(rejected).rejects.toMatchObject({ code: 'ActorNotMember' });
  });

  // A service actor holds no membership by construction.
  it('does not apply the grant matrix to a service actor', async () => {
    const h = harness();
    const result = await h.db.transaction((tx) =>
      h.service.invite(tx, {
        ...base,
        actor: { id: 'relay', kind: 'service' },
        userId: INVITEE,
        role: 'org_admin',
      }),
    );
    expect(result.membership.status).toBe('invited');
  });
});

describe('duplicate and repeat invitations', () => {
  it('rejects a second invitation while one is pending', async () => {
    const h = harness();
    await h.db.transaction((tx) =>
      h.service.invite(tx, { ...base, userId: INVITEE, role: 'org_member' }),
    );

    const duplicate = h.db.transaction((tx) =>
      h.service.invite(tx, { ...base, userId: INVITEE, role: 'org_member' }),
    );
    await expect(duplicate).rejects.toMatchObject({ code: 'DuplicateInvitation' });
  });

  it('rejects inviting someone who is already an active member', async () => {
    const h = harness();
    h.db.seed(ADMIN, 'org_admin', 'active');

    const rejected = h.db.transaction((tx) =>
      h.service.invite(tx, { ...base, userId: ADMIN, role: 'org_member' }),
    );
    await expect(rejected).rejects.toMatchObject({ code: 'AlreadyMember' });
  });

  // "An expired invitation cannot be accepted and must be reissued."
  it('reissues an expired invitation on the same row', async () => {
    const h = harness();
    h.db.seed(INVITEE, 'org_member', 'invited', '2026-07-01T00:00:00.000Z');
    const before = h.db.rows.size;

    const result = await h.db.transaction((tx) =>
      h.service.invite(tx, { ...base, userId: INVITEE, role: 'org_admin' }),
    );

    expect(h.db.rows.size).toBe(before);
    expect(result.membership.role).toBe('org_admin');
    expect(h.db.rows.get(`${ORG}:${INVITEE}`)?.expires_at).toBe(EXPIRY);
    expect(h.db.auditContext(0).detail).toMatchObject({ reissued: 'true' });
  });

  it('re-invites a revoked member on the same row', async () => {
    const h = harness();
    h.db.seed(INVITEE, 'org_member', 'revoked');
    const before = h.db.rows.size;

    const result = await h.db.transaction((tx) =>
      h.service.invite(tx, { ...base, userId: INVITEE, role: 'org_member' }),
    );
    expect(h.db.rows.size).toBe(before);
    expect(result.membership.status).toBe('invited');
  });
});

describe('invitation acceptance', () => {
  it('moves the invitation to active and clears the expiry', async () => {
    const h = harness();
    h.db.seed(INVITEE, 'org_member', 'invited', EXPIRY);

    const result = await h.db.transaction((tx) =>
      h.service.accept(tx, { ...base, actor: { id: INVITEE, kind: 'user' }, userId: INVITEE }),
    );

    expect(result.membership.status).toBe('active');
    expect(result.membership.expiresAt).toBeNull();
    const row = h.db.rows.get(`${ORG}:${INVITEE}`);
    expect(row?.status).toBe('active');
    expect(row?.expires_at).toBeNull();
  });

  it('refuses an expired invitation', async () => {
    const h = harness();
    h.db.seed(INVITEE, 'org_member', 'invited', '2026-07-01T00:00:00.000Z');

    const rejected = h.db.transaction((tx) =>
      h.service.accept(tx, { ...base, actor: { id: INVITEE, kind: 'user' }, userId: INVITEE }),
    );
    await expect(rejected).rejects.toMatchObject({ code: 'InvitationExpired' });
    expect(h.db.rows.get(`${ORG}:${INVITEE}`)?.status).toBe('invited');
  });

  it('refuses at the exact expiry instant', async () => {
    const h = harness();
    h.db.seed(INVITEE, 'org_member', 'invited', NOW.toISOString());

    await expect(
      h.db.transaction((tx) =>
        h.service.accept(tx, { ...base, actor: { id: INVITEE, kind: 'user' }, userId: INVITEE }),
      ),
    ).rejects.toMatchObject({ code: 'InvitationExpired' });
  });

  it('refuses to accept a membership that is not a pending invitation', async () => {
    const h = harness();
    h.db.seed(INVITEE, 'org_member', 'active');
    await expect(
      h.db.transaction((tx) => h.service.accept(tx, { ...base, userId: INVITEE })),
    ).rejects.toMatchObject({ code: 'InvitationNotPending' });
  });

  it('reports an absent invitation as not found', async () => {
    const h = harness();
    await expect(
      h.db.transaction((tx) => h.service.accept(tx, { ...base, userId: INVITEE })),
    ).rejects.toMatchObject({ code: 'MembershipNotFound' });
  });

  it('lets exactly one of two concurrent accepts win', async () => {
    const h = harness();
    h.db.seed(INVITEE, 'org_member', 'invited', EXPIRY);

    const results = await Promise.allSettled([
      h.db.transaction((tx) => h.service.accept(tx, { ...base, userId: INVITEE })),
      h.db.transaction((tx) => h.service.accept(tx, { ...base, userId: INVITEE })),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      (results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason,
    ).toMatchObject({ code: 'ConcurrentModification' });
  });
});

describe('role change', () => {
  it('changes an active member’s role and reports both ends', async () => {
    const h = harness();
    h.db.seed(ADMIN, 'org_member', 'active');

    const result = await h.db.transaction((tx) =>
      h.service.changeRole(tx, { ...base, userId: ADMIN, role: 'org_admin' }),
    );

    expect(result.changed).toBe(true);
    expect(result.membership.role).toBe('org_admin');
    expect(h.db.auditContext(0).detail).toMatchObject({
      previousRole: 'org_member',
      role: 'org_admin',
    });
  });

  it('is a no-op when the role already matches', async () => {
    const h = harness();
    h.db.seed(ADMIN, 'org_admin', 'active');

    const result = await h.db.transaction((tx) =>
      h.service.changeRole(tx, { ...base, userId: ADMIN, role: 'org_admin' }),
    );
    expect(result.changed).toBe(false);
    expect(result.event).toBeNull();
    expect(h.db.auditRows).toHaveLength(0);
    expect(h.publisher.events).toHaveLength(0);
  });

  // The actor must be permitted to act on BOTH the current and the new role.
  it('refuses an org_admin demoting an org_owner', async () => {
    const h = harness();
    h.db.seed(ADMIN, 'org_admin', 'active');
    h.db.seed(OWNER2, 'org_owner', 'active');

    const rejected = h.db.transaction((tx) =>
      h.service.changeRole(tx, {
        ...base,
        actor: { id: ADMIN, kind: 'user' },
        userId: OWNER2,
        role: 'org_member',
      }),
    );
    await expect(rejected).rejects.toMatchObject({ code: 'RoleGrantNotPermitted' });
  });

  it('refuses to change the role of a non-active membership', async () => {
    const h = harness();
    h.db.seed(INVITEE, 'org_member', 'invited', EXPIRY);
    await expect(
      h.db.transaction((tx) =>
        h.service.changeRole(tx, { ...base, userId: INVITEE, role: 'org_admin' }),
      ),
    ).rejects.toMatchObject({ code: 'InvitationNotPending' });
  });
});

describe('last org_owner protection', () => {
  it('refuses to demote the only active owner', async () => {
    const h = harness();
    const rejected = h.db.transaction((tx) =>
      h.service.changeRole(tx, { ...base, userId: OWNER, role: 'org_admin' }),
    );
    await expect(rejected).rejects.toBeInstanceOf(MembershipError);
    await expect(rejected).rejects.toMatchObject({ code: 'LastOwnerProtected' });
    expect(h.db.rows.get(`${ORG}:${OWNER}`)?.role).toBe('org_owner');
  });

  it('refuses to revoke or remove the only active owner', async () => {
    const h = harness();
    const rejected = h.db.transaction((tx) => h.service.revoke(tx, { ...base, userId: OWNER }));
    await expect(rejected).rejects.toMatchObject({ code: 'LastOwnerProtected' });
    expect(h.db.rows.get(`${ORG}:${OWNER}`)?.status).toBe('active');
  });

  it('permits it once a second owner exists', async () => {
    const h = harness();
    h.db.seed(OWNER2, 'org_owner', 'active');

    const result = await h.db.transaction((tx) =>
      h.service.changeRole(tx, { ...base, userId: OWNER2, role: 'org_admin' }),
    );
    expect(result.membership.role).toBe('org_admin');
  });

  // An invited or revoked owner is not holding the position open.
  it('does not count an invited owner as the last owner', async () => {
    const h = harness();
    h.db.seed(OWNER2, 'org_owner', 'invited', EXPIRY);

    await expect(
      h.db.transaction((tx) => h.service.revoke(tx, { ...base, userId: OWNER2 })),
    ).resolves.toMatchObject({ changed: true });
  });

  // The reason the advisory lock is taken: a count-then-act is a race.
  //
  // A service actor drives both, so that neither revocation removes the actor's
  // own authority — otherwise the second call fails as `ActorNotMember` and the
  // protection itself is never reached.
  const SUPPORT = { id: 'support', kind: 'service' as const };

  it('lets only one of two concurrent owner revocations succeed', async () => {
    const h = harness();
    h.db.seed(OWNER2, 'org_owner', 'active');

    const results = await Promise.allSettled([
      h.db.transaction((tx) => h.service.revoke(tx, { ...base, actor: SUPPORT, userId: OWNER })),
      h.db.transaction((tx) => h.service.revoke(tx, { ...base, actor: SUPPORT, userId: OWNER2 })),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      (results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason,
    ).toMatchObject({ code: 'LastOwnerProtected' });
    const owners = [...h.db.rows.values()].filter(
      (r) => r.role === 'org_owner' && r.status === 'active',
    );
    expect(owners).toHaveLength(1);
  });

  // The control: without the lock both read a count of two and the
  // organization is left with no active owner at all.
  it('LEAVES NO OWNER when the lock is not taken, proving it is load-bearing', async () => {
    const h = harness({ advisoryLocks: 'ignored' });
    h.db.seed(OWNER2, 'org_owner', 'active');

    const results = await Promise.allSettled([
      h.db.transaction((tx) => h.service.revoke(tx, { ...base, actor: SUPPORT, userId: OWNER })),
      h.db.transaction((tx) => h.service.revoke(tx, { ...base, actor: SUPPORT, userId: OWNER2 })),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    const owners = [...h.db.rows.values()].filter(
      (r) => r.role === 'org_owner' && r.status === 'active',
    );
    expect(owners).toHaveLength(0);
  });
});

describe('revocation and member removal', () => {
  it('revokes a pending invitation and audits it as such', async () => {
    const h = harness();
    h.db.seed(INVITEE, 'org_member', 'invited', EXPIRY);

    const result = await h.db.transaction((tx) =>
      h.service.revoke(tx, { ...base, userId: INVITEE }),
    );
    expect(result.membership.status).toBe('revoked');
    expect(h.db.auditActions()).toEqual([ORGANIZATION_MEMBERSHIP_AUDIT_ACTIONS.invitationRevoked]);
  });

  // The membership row survives as `revoked` so authorship and audit survive.
  it('removes an active member without deleting the row', async () => {
    const h = harness();
    h.db.seed(ADMIN, 'org_admin', 'active');

    await h.db.transaction((tx) => h.service.revoke(tx, { ...base, userId: ADMIN }));
    expect(h.db.rows.get(`${ORG}:${ADMIN}`)).toMatchObject({ status: 'revoked' });
    expect(h.db.auditActions()).toEqual([ORGANIZATION_MEMBERSHIP_AUDIT_ACTIONS.revoked]);
  });

  it('is idempotent — revoking twice publishes once', async () => {
    const h = harness();
    h.db.seed(ADMIN, 'org_admin', 'active');

    const first = await h.db.transaction((tx) => h.service.revoke(tx, { ...base, userId: ADMIN }));
    const second = await h.db.transaction((tx) => h.service.revoke(tx, { ...base, userId: ADMIN }));

    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect(second.event).toBeNull();
    expect(h.publisher.events).toHaveLength(1);
    expect(h.db.auditRows).toHaveLength(1);
  });

  it('reports an unknown membership as not found', async () => {
    const h = harness();
    await expect(
      h.db.transaction((tx) => h.service.revoke(tx, { ...base, userId: INVITEE })),
    ).rejects.toMatchObject({ code: 'MembershipNotFound' });
  });
});

describe('audit generation', () => {
  it('scopes every record to the organization and names the membership', async () => {
    const h = harness();
    await h.db.transaction((tx) =>
      h.service.invite(tx, { ...base, userId: INVITEE, role: 'org_member' }),
    );

    const row = h.db.auditRows[0];
    expect(row?.[A_TENANT]).toBe(ORG);
    expect(row?.[A_TARGET_KIND]).toBe('organization_membership');
    expect(row?.[A_TARGET_ID]).toBe(h.db.rows.get(`${ORG}:${INVITEE}`)?.id);
    expect(h.db.auditContext(0).detail).toMatchObject({
      subjectUserId: INVITEE,
      role: 'org_member',
      expiresAt: EXPIRY,
    });
  });

  it('chains records', async () => {
    const h = harness();
    h.db.seed(INVITEE, 'org_member', 'invited', EXPIRY);
    await h.db.transaction((tx) => h.service.accept(tx, { ...base, userId: INVITEE }));
    await h.db.transaction((tx) =>
      h.service.changeRole(tx, { ...base, userId: INVITEE, role: 'org_admin' }),
    );

    expect(h.db.auditRows[0]?.[A_PREVIOUS_HASH]).toBe(GENESIS_HASH);
    expect(h.db.auditRows[1]?.[A_PREVIOUS_HASH]).toBe(h.db.auditRows[0]?.[A_HASH]);
  });
});

describe('outbox generation', () => {
  it('publishes OrgMembershipInvited with a userId, never an email', async () => {
    const h = harness();
    await h.db.transaction((tx) =>
      h.service.invite(tx, { ...base, userId: INVITEE, role: 'org_member' }),
    );

    const event = h.publisher.events[0];
    expect(event).toMatchObject({
      eventType: 'OrgMembershipInvited',
      aggregateType: 'OrganizationMembership',
      tenantId: ORG,
      organizationId: ORG,
      producer: 'platform.memberships',
      payload: {
        organizationId: ORG,
        userId: INVITEE,
        role: 'org_member',
        invitedBy: OWNER,
        expiresAt: EXPIRY,
      },
    });
    expect(JSON.stringify(event?.payload)).not.toContain('@');
  });

  it('partitions on the membership, so one person’s events stay ordered', async () => {
    const h = harness();
    h.db.seed(INVITEE, 'org_member', 'invited', EXPIRY);
    await h.db.transaction((tx) => h.service.accept(tx, { ...base, userId: INVITEE }));
    await h.db.transaction((tx) =>
      h.service.changeRole(tx, { ...base, userId: INVITEE, role: 'org_admin' }),
    );

    const membershipId = h.db.rows.get(`${ORG}:${INVITEE}`)?.id;
    for (const event of h.publisher.events) {
      expect(event.aggregateId).toBe(membershipId);
    }
  });

  it('publishes accepted, role-changed and revoked with their documented payloads', async () => {
    const h = harness();
    h.db.seed(INVITEE, 'org_member', 'invited', EXPIRY);

    await h.db.transaction((tx) => h.service.accept(tx, { ...base, userId: INVITEE }));
    await h.db.transaction((tx) =>
      h.service.changeRole(tx, { ...base, userId: INVITEE, role: 'org_admin' }),
    );
    await h.db.transaction((tx) => h.service.revoke(tx, { ...base, userId: INVITEE }));

    expect(h.publisher.events.map((e) => e.eventType)).toEqual([
      'OrgMembershipAccepted',
      'OrgMembershipRoleChanged',
      'OrgMembershipRevoked',
    ]);
    expect(h.publisher.events[1]?.payload).toMatchObject({
      previousRole: 'org_member',
      role: 'org_admin',
      changedBy: OWNER,
    });
    expect(h.publisher.events[2]?.payload).toMatchObject({ userId: INVITEE, revokedBy: OWNER });
  });
});

describe('rollback', () => {
  const FAILURES: readonly (readonly [string, string])[] = [
    ['membership write', 'INSERT INTO organization_memberships'],
    ['audit', 'INSERT INTO audit_log'],
  ];

  for (const [label, needle] of FAILURES) {
    it(`propagates a ${label} failure and publishes nothing`, async () => {
      const h = harness();
      h.db.failOn(needle, new Error('deadlock detected'));

      await expect(
        h.db.transaction((tx) =>
          h.service.invite(tx, { ...base, userId: INVITEE, role: 'org_member' }),
        ),
      ).rejects.toThrow('deadlock detected');
      expect(h.publisher.events).toHaveLength(0);
    });
  }

  it('propagates a publish failure so the membership write rolls back with it', async () => {
    const database = db();
    database.seed(OWNER, 'org_owner', 'active');
    const service = createOrganizationMembershipService({
      publisher: { publish: (): Promise<void> => Promise.reject(new Error('UnknownEventType')) },
      audit: createPersistentAuditWriter({ now: () => NOW, newId: () => EVENT_ID }),
      now: () => NOW,
      newEventId: () => EVENT_ID,
    });

    await expect(
      database.transaction((tx) =>
        service.invite(tx, { ...base, userId: INVITEE, role: 'org_member' }),
      ),
    ).rejects.toThrow('UnknownEventType');
  });
});

describe('role bindings', () => {
  it('projects an accepted membership into an active organization binding', async () => {
    const h = harness();
    h.db.seed(INVITEE, 'org_admin', 'invited', EXPIRY);
    const result = await h.db.transaction((tx) =>
      h.service.accept(tx, { ...base, userId: INVITEE }),
    );

    const binding = organizationMembershipBinding(result.membership, OWNER, NOW);
    expect(binding).toMatchObject({
      subjectId: INVITEE,
      role: 'org_admin',
      tier: 'organization',
      workspaceId: null,
      status: 'active',
    });
  });

  it('projects nothing from a revoked membership', async () => {
    const h = harness();
    h.db.seed(ADMIN, 'org_admin', 'active');
    const result = await h.db.transaction((tx) => h.service.revoke(tx, { ...base, userId: ADMIN }));
    expect(organizationMembershipBinding(result.membership, OWNER, NOW)).toBeNull();
  });
});
