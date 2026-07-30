/**
 * Workspace memberships — invite, accept, role change, revoke.
 *
 * Concurrency here is optimistic on `version`, which
 * `workspace_memberships` has and `organization_memberships` does not. The
 * advisory lock is still taken, for last-admin protection.
 */
import { describe, expect, it } from 'vitest';

import type { DomainEvent, EventPublisher, Transaction } from '@contentos/contracts';
import { createPersistentAuditWriter } from '@contentos/security';

import { MembershipError } from './membership.js';
import type { MembershipExecutor } from './organization-memberships.js';
import {
  createWorkspaceMembershipService,
  workspaceMembershipBinding,
  WORKSPACE_MEMBERSHIP_AUDIT_ACTIONS,
  type WorkspaceMembershipService,
} from './workspace-memberships.js';

const ORG = '018f7a1e-0000-7000-8000-0000000000aa';
const WS = '018f7a1e-0000-7000-8000-0000000000c1';
const ADMIN = '018f7a1e-0000-7000-8000-000000000001';
const ADMIN2 = '018f7a1e-0000-7000-8000-000000000005';
const EDITOR = '018f7a1e-0000-7000-8000-000000000002';
const INVITEE = '018f7a1e-0000-7000-8000-000000000003';
const OUTSIDER = '018f7a1e-0000-7000-8000-000000000009';
const CORRELATION = '018f7a1e-0000-7000-8000-0000000000dd';
const EVENT_ID = '018f7a1e-0000-7000-8000-0000000000ee';
const NOW = new Date('2026-07-30T12:00:00.000Z');
const EXPIRY = '2026-08-13T12:00:00.000Z';

const A_TENANT = 1;
const A_ORG = 2;
const A_ACTION = 7;
const A_TARGET_KIND = 8;
const A_CONTEXT = 13;

interface Row {
  id: string;
  tenant_id: string;
  organization_id: string;
  user_id: string;
  role: string;
  status: string;
  expires_at: string | null;
  invited_by: string | null;
  version: number;
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
  seedOrgMember(userId: string, status: string): void;
  auditActions(): string[];
  auditContext(index: number): { detail?: Record<string, string> };
}

function db(): Db {
  const mutex = keyedMutex();
  const rows = new Map<string, Row>();
  const orgMembers = new Map<string, string>();
  const auditRows: unknown[][] = [];
  const sql: string[] = [];
  const lockKeys: string[] = [];
  const failures: { needle: string; error: Error }[] = [];
  let seq = 0;

  const byId = (id: string): Row | undefined => [...rows.values()].find((r) => r.id === id);

  async function execute(
    q: string,
    params: unknown[],
    session: { held: (() => void)[] },
  ): Promise<unknown[]> {
    if (q.includes('pg_advisory_xact_lock')) {
      lockKeys.push(String(params[0]));
      session.held.push(await mutex.acquire(String(params[0])));
      return [];
    }

    if (q.includes('FROM organization_memberships')) {
      const status = orgMembers.get(String(params[1]));
      return status === undefined ? [] : [{ role: 'org_member', status }];
    }

    if (q.includes('count(*)::int')) {
      const count = [...rows.values()].filter(
        (r) => r.tenant_id === params[0] && r.role === params[1] && r.status === 'active',
      ).length;
      return [{ count }];
    }

    if (q.includes('FROM workspace_memberships')) {
      const row = rows.get(String(params[1]));
      return row === undefined ? [] : [{ ...row }];
    }

    if (q.includes('INSERT INTO workspace_memberships')) {
      seq += 1;
      const id = `018f7a1e-0000-7000-8000-00000000e${String(seq).padStart(3, '0')}`;
      const row: Row = {
        id,
        tenant_id: String(params[0]),
        organization_id: String(params[1]),
        user_id: String(params[2]),
        role: String(params[3]),
        status: 'invited',
        expires_at: String(params[4]),
        invited_by: String(params[5]),
        version: 1,
      };
      rows.set(row.user_id, row);
      return [{ id, version: 1 }];
    }

    if (q.includes('UPDATE workspace_memberships')) {
      // Matched on the SET clause: several predicates mention the same statuses.
      if (q.includes("SET role = $1, status = 'invited'")) {
        const row = byId(String(params[3]));
        if (row === undefined || row.version !== params[4]) return [];
        row.role = String(params[0]);
        row.status = 'invited';
        row.expires_at = String(params[1]);
        row.invited_by = String(params[2]);
        row.version += 1;
        return [{ version: row.version }];
      }
      if (q.includes("SET status = 'active'")) {
        const row = byId(String(params[1]));
        if (row === undefined || row.version !== params[2] || row.status !== 'invited') return [];
        row.status = 'active';
        row.expires_at = null;
        row.version += 1;
        return [{ version: row.version }];
      }
      if (q.includes("SET status = 'revoked'")) {
        const row = byId(String(params[1]));
        if (row === undefined || row.version !== params[2]) return [];
        row.status = 'revoked';
        row.version += 1;
        return [{ version: row.version }];
      }
      const row = byId(String(params[2]));
      if (row === undefined || row.version !== params[3] || row.status !== 'active') return [];
      row.role = String(params[0]);
      row.version += 1;
      return [{ version: row.version }];
    }

    if (q.includes('SELECT hash FROM audit_log')) {
      const last = auditRows.at(-1);
      return last === undefined ? [] : [{ hash: last[15] }];
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
      rows.set(userId, {
        id,
        tenant_id: WS,
        organization_id: ORG,
        user_id: userId,
        role,
        status,
        expires_at: expiresAt,
        invited_by: ADMIN,
        version: 1,
      });
      orgMembers.set(userId, 'active');
      return id;
    },
    seedOrgMember(userId, status) {
      orgMembers.set(userId, status);
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
  service: WorkspaceMembershipService;
}

function harness(): Harness {
  const database = db();
  const publisher = recordingPublisher();
  const service = createWorkspaceMembershipService({
    publisher,
    audit: createPersistentAuditWriter({ now: () => NOW, newId: () => EVENT_ID }),
    now: () => NOW,
    newEventId: () => EVENT_ID,
  });
  // Provisioning guarantees a first workspace_admin.
  database.seed(ADMIN, 'workspace_admin', 'active');
  database.seedOrgMember(INVITEE, 'active');
  return { db: database, publisher, service };
}

const base = {
  workspaceId: WS,
  organizationId: ORG,
  actor: { id: ADMIN, kind: 'user' as const },
  correlationId: CORRELATION,
};

describe('workspace invite', () => {
  it('creates an invited membership with a 14-day expiry', async () => {
    const h = harness();
    const result = await h.db.transaction((tx) =>
      h.service.invite(tx, { ...base, userId: INVITEE, role: 'editor' }),
    );

    expect(result.membership).toMatchObject({
      workspaceId: WS,
      organizationId: ORG,
      userId: INVITEE,
      role: 'editor',
      status: 'invited',
    });
    expect(result.membership.expiresAt?.toISOString()).toBe(EXPIRY);
    expect(h.db.rows.get(INVITEE)?.invited_by).toBe(ADMIN);
  });

  // Rule 9. Without it the invitee holds workspace access inside an
  // organization they do not belong to.
  it('refuses an invitee with no active organization membership', async () => {
    const h = harness();
    const rejected = h.db.transaction((tx) =>
      h.service.invite(tx, { ...base, userId: OUTSIDER, role: 'editor' }),
    );
    await expect(rejected).rejects.toBeInstanceOf(MembershipError);
    await expect(rejected).rejects.toMatchObject({ code: 'OrganizationMembershipRequired' });
  });

  it('refuses an invitee whose organization membership is only invited', async () => {
    const h = harness();
    h.db.seedOrgMember(OUTSIDER, 'invited');
    await expect(
      h.db.transaction((tx) => h.service.invite(tx, { ...base, userId: OUTSIDER, role: 'viewer' })),
    ).rejects.toMatchObject({ code: 'OrganizationMembershipRequired' });
  });

  // Rule 6: editor, contributor and viewer manage nobody.
  it('refuses an actor whose role carries no membership authority', async () => {
    const h = harness();
    h.db.seed(EDITOR, 'editor', 'active');

    const rejected = h.db.transaction((tx) =>
      h.service.invite(tx, {
        ...base,
        actor: { id: EDITOR, kind: 'user' },
        userId: INVITEE,
        role: 'viewer',
      }),
    );
    await expect(rejected).rejects.toMatchObject({ code: 'RoleGrantNotPermitted' });
  });

  it('refuses an actor who is not a member of the workspace', async () => {
    const h = harness();
    await expect(
      h.db.transaction((tx) =>
        h.service.invite(tx, {
          ...base,
          actor: { id: OUTSIDER, kind: 'user' },
          userId: INVITEE,
          role: 'viewer',
        }),
      ),
    ).rejects.toMatchObject({ code: 'ActorNotMember' });
  });

  it('rejects a second invitation while one is pending', async () => {
    const h = harness();
    await h.db.transaction((tx) =>
      h.service.invite(tx, { ...base, userId: INVITEE, role: 'editor' }),
    );
    await expect(
      h.db.transaction((tx) => h.service.invite(tx, { ...base, userId: INVITEE, role: 'editor' })),
    ).rejects.toMatchObject({ code: 'DuplicateInvitation' });
  });

  it('rejects inviting an existing active member', async () => {
    const h = harness();
    h.db.seed(EDITOR, 'editor', 'active');
    await expect(
      h.db.transaction((tx) => h.service.invite(tx, { ...base, userId: EDITOR, role: 'viewer' })),
    ).rejects.toMatchObject({ code: 'AlreadyMember' });
  });

  it('reissues an expired invitation on the same row', async () => {
    const h = harness();
    h.db.seed(INVITEE, 'viewer', 'invited', '2026-07-01T00:00:00.000Z');
    const before = h.db.rows.size;

    const result = await h.db.transaction((tx) =>
      h.service.invite(tx, { ...base, userId: INVITEE, role: 'editor' }),
    );
    expect(h.db.rows.size).toBe(before);
    expect(result.membership.role).toBe('editor');
    expect(h.db.rows.get(INVITEE)?.expires_at).toBe(EXPIRY);
  });

  it('re-invites a revoked member on the same row', async () => {
    const h = harness();
    h.db.seed(INVITEE, 'viewer', 'revoked');
    const result = await h.db.transaction((tx) =>
      h.service.invite(tx, { ...base, userId: INVITEE, role: 'viewer' }),
    );
    expect(result.membership.status).toBe('invited');
  });
});

describe('workspace invitation acceptance', () => {
  it('moves the invitation to active and clears the expiry', async () => {
    const h = harness();
    h.db.seed(INVITEE, 'editor', 'invited', EXPIRY);

    const result = await h.db.transaction((tx) =>
      h.service.accept(tx, { ...base, actor: { id: INVITEE, kind: 'user' }, userId: INVITEE }),
    );
    expect(result.membership.status).toBe('active');
    expect(result.membership.expiresAt).toBeNull();
    expect(h.db.rows.get(INVITEE)).toMatchObject({ status: 'active', expires_at: null });
  });

  it('refuses an expired invitation', async () => {
    const h = harness();
    h.db.seed(INVITEE, 'editor', 'invited', '2026-07-01T00:00:00.000Z');
    await expect(
      h.db.transaction((tx) => h.service.accept(tx, { ...base, userId: INVITEE })),
    ).rejects.toMatchObject({ code: 'InvitationExpired' });
  });

  it('refuses a membership that is not a pending invitation', async () => {
    const h = harness();
    h.db.seed(EDITOR, 'editor', 'active');
    await expect(
      h.db.transaction((tx) => h.service.accept(tx, { ...base, userId: EDITOR })),
    ).rejects.toMatchObject({ code: 'InvitationNotPending' });
  });
});

describe('workspace role change', () => {
  it('changes an active member’s role', async () => {
    const h = harness();
    h.db.seed(EDITOR, 'viewer', 'active');

    const result = await h.db.transaction((tx) =>
      h.service.changeRole(tx, { ...base, userId: EDITOR, role: 'editor' }),
    );
    expect(result.membership.role).toBe('editor');
    expect(result.membership.version).toBe(2);
  });

  it('is a no-op when the role already matches', async () => {
    const h = harness();
    h.db.seed(EDITOR, 'editor', 'active');
    const result = await h.db.transaction((tx) =>
      h.service.changeRole(tx, { ...base, userId: EDITOR, role: 'editor' }),
    );
    expect(result.changed).toBe(false);
    expect(h.publisher.events).toHaveLength(0);
  });

  it('refuses a non-admin actor', async () => {
    const h = harness();
    h.db.seed(EDITOR, 'editor', 'active');
    await expect(
      h.db.transaction((tx) =>
        h.service.changeRole(tx, {
          ...base,
          actor: { id: EDITOR, kind: 'user' },
          userId: ADMIN,
          role: 'viewer',
        }),
      ),
    ).rejects.toMatchObject({ code: 'RoleGrantNotPermitted' });
  });
});

describe('last workspace_admin protection', () => {
  // Rule 5, and a security control: a workspace with no administrator is
  // unadministrable and its data unreachable through normal paths.
  it('refuses to demote the only active admin', async () => {
    const h = harness();
    await expect(
      h.db.transaction((tx) =>
        h.service.changeRole(tx, { ...base, userId: ADMIN, role: 'editor' }),
      ),
    ).rejects.toMatchObject({ code: 'LastOwnerProtected' });
    expect(h.db.rows.get(ADMIN)?.role).toBe('workspace_admin');
  });

  it('refuses to remove the only active admin', async () => {
    const h = harness();
    await expect(
      h.db.transaction((tx) => h.service.revoke(tx, { ...base, userId: ADMIN })),
    ).rejects.toMatchObject({ code: 'LastOwnerProtected' });
  });

  it('permits it once a second admin exists', async () => {
    const h = harness();
    h.db.seed(ADMIN2, 'workspace_admin', 'active');
    const result = await h.db.transaction((tx) =>
      h.service.revoke(tx, { ...base, userId: ADMIN2 }),
    );
    expect(result.membership.status).toBe('revoked');
  });

  // The documented, audited override — set only by the revocation cascade.
  it('yields to an explicit override, and records that it did', async () => {
    const h = harness();
    const result = await h.db.transaction((tx) =>
      h.service.revoke(tx, {
        ...base,
        actor: { id: 'cascade', kind: 'service' },
        userId: ADMIN,
        overrideLastAdminProtection: true,
      }),
    );

    expect(result.membership.status).toBe('revoked');
    expect(h.db.auditContext(0).detail).toMatchObject({
      lastAdminProtectionOverridden: 'true',
    });
  });

  it('records when the override was NOT used', async () => {
    const h = harness();
    h.db.seed(ADMIN2, 'workspace_admin', 'active');
    await h.db.transaction((tx) => h.service.revoke(tx, { ...base, userId: ADMIN2 }));
    expect(h.db.auditContext(0).detail).toMatchObject({
      lastAdminProtectionOverridden: 'false',
    });
  });
});

describe('workspace revocation and removal', () => {
  it('revokes a pending invitation and audits it as such', async () => {
    const h = harness();
    h.db.seed(INVITEE, 'editor', 'invited', EXPIRY);
    await h.db.transaction((tx) => h.service.revoke(tx, { ...base, userId: INVITEE }));
    expect(h.db.auditActions()).toEqual([WORKSPACE_MEMBERSHIP_AUDIT_ACTIONS.invitationRevoked]);
  });

  it('removes an active member without deleting the row', async () => {
    const h = harness();
    h.db.seed(EDITOR, 'editor', 'active');
    await h.db.transaction((tx) => h.service.revoke(tx, { ...base, userId: EDITOR }));
    expect(h.db.rows.get(EDITOR)).toMatchObject({ status: 'revoked' });
    expect(h.db.auditActions()).toEqual([WORKSPACE_MEMBERSHIP_AUDIT_ACTIONS.revoked]);
  });

  it('is idempotent — revoking twice publishes once', async () => {
    const h = harness();
    h.db.seed(EDITOR, 'editor', 'active');
    const first = await h.db.transaction((tx) => h.service.revoke(tx, { ...base, userId: EDITOR }));
    const second = await h.db.transaction((tx) =>
      h.service.revoke(tx, { ...base, userId: EDITOR }),
    );

    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect(h.publisher.events).toHaveLength(1);
  });
});

describe('workspace membership concurrency', () => {
  it('refuses a stale expected version', async () => {
    const h = harness();
    h.db.seed(EDITOR, 'viewer', 'active');
    await expect(
      h.db.transaction((tx) =>
        h.service.changeRole(tx, {
          ...base,
          userId: EDITOR,
          role: 'editor',
          expectedVersion: 99,
        }),
      ),
    ).rejects.toMatchObject({ code: 'ConcurrentModification' });
  });

  // `changeRole` takes the advisory lock, so two concurrent changes SERIALISE
  // rather than collide: the second reads the first's committed result and
  // applies on top of it. Neither update is lost and the row is never left in
  // a state nobody asked for.
  it('serialises two concurrent role changes without losing either', async () => {
    const h = harness();
    h.db.seed(EDITOR, 'viewer', 'active');

    const results = await Promise.allSettled([
      h.db.transaction((tx) =>
        h.service.changeRole(tx, { ...base, userId: EDITOR, role: 'editor' }),
      ),
      h.db.transaction((tx) =>
        h.service.changeRole(tx, { ...base, userId: EDITOR, role: 'contributor' }),
      ),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    const row = h.db.rows.get(EDITOR);
    // One increment per change: no lost update.
    expect(row?.version).toBe(3);
    expect(['editor', 'contributor']).toContain(row?.role);
  });

  // "Fail the loser rather than silently overwrite" is what an explicit
  // expected version buys. Two callers that both read version 1 and then
  // submit: the second is told its view was stale instead of clobbering a
  // decision it never saw.
  it('fails the loser when both callers submit the version they read', async () => {
    const h = harness();
    h.db.seed(EDITOR, 'viewer', 'active');

    const first = await h.db.transaction((tx) =>
      h.service.changeRole(tx, { ...base, userId: EDITOR, role: 'editor', expectedVersion: 1 }),
    );
    expect(first.membership.version).toBe(2);

    await expect(
      h.db.transaction((tx) =>
        h.service.changeRole(tx, {
          ...base,
          userId: EDITOR,
          role: 'contributor',
          expectedVersion: 1,
        }),
      ),
    ).rejects.toMatchObject({ code: 'ConcurrentModification' });
    expect(h.db.rows.get(EDITOR)?.role).toBe('editor');
  });

  it('lets exactly one of two concurrent accepts win', async () => {
    const h = harness();
    h.db.seed(INVITEE, 'editor', 'invited', EXPIRY);

    const results = await Promise.allSettled([
      h.db.transaction((tx) => h.service.accept(tx, { ...base, userId: INVITEE })),
      h.db.transaction((tx) => h.service.accept(tx, { ...base, userId: INVITEE })),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });
});

describe('workspace membership audit and outbox', () => {
  it('scopes audit to the workspace as tenant', async () => {
    const h = harness();
    await h.db.transaction((tx) =>
      h.service.invite(tx, { ...base, userId: INVITEE, role: 'editor' }),
    );
    const row = h.db.auditRows[0];
    expect(row?.[A_TENANT]).toBe(WS);
    expect(row?.[A_ORG]).toBe(ORG);
    expect(row?.[A_TARGET_KIND]).toBe('workspace_membership');
  });

  it('publishes MembershipInvited with a userId, never an email', async () => {
    const h = harness();
    await h.db.transaction((tx) =>
      h.service.invite(tx, { ...base, userId: INVITEE, role: 'editor' }),
    );

    const event = h.publisher.events[0];
    expect(event).toMatchObject({
      eventType: 'MembershipInvited',
      aggregateType: 'WorkspaceMembership',
      tenantId: WS,
      organizationId: ORG,
      producer: 'platform.memberships',
      payload: { workspaceId: WS, userId: INVITEE, role: 'editor', invitedBy: ADMIN },
    });
    expect(JSON.stringify(event?.payload)).not.toContain('@');
  });

  it('publishes accepted, role-changed and revoked in order', async () => {
    const h = harness();
    h.db.seed(INVITEE, 'viewer', 'invited', EXPIRY);

    await h.db.transaction((tx) => h.service.accept(tx, { ...base, userId: INVITEE }));
    await h.db.transaction((tx) =>
      h.service.changeRole(tx, { ...base, userId: INVITEE, role: 'editor' }),
    );
    await h.db.transaction((tx) => h.service.revoke(tx, { ...base, userId: INVITEE }));

    expect(h.publisher.events.map((e) => e.eventType)).toEqual([
      'MembershipAccepted',
      'MembershipRoleChanged',
      'MembershipRevoked',
    ]);
    for (const event of h.publisher.events) {
      expect(event.tenantId).toBe(WS);
      expect(event.aggregateId).toBe(h.db.rows.get(INVITEE)?.id);
    }
  });
});

describe('workspace membership rollback', () => {
  const FAILURES: readonly (readonly [string, string])[] = [
    ['membership write', 'INSERT INTO workspace_memberships'],
    ['audit', 'INSERT INTO audit_log'],
  ];

  for (const [label, needle] of FAILURES) {
    it(`propagates a ${label} failure and publishes nothing`, async () => {
      const h = harness();
      h.db.failOn(needle, new Error('deadlock detected'));
      await expect(
        h.db.transaction((tx) =>
          h.service.invite(tx, { ...base, userId: INVITEE, role: 'editor' }),
        ),
      ).rejects.toThrow('deadlock detected');
      expect(h.publisher.events).toHaveLength(0);
    });
  }

  it('propagates a publish failure', async () => {
    const database = db();
    database.seed(ADMIN, 'workspace_admin', 'active');
    database.seedOrgMember(INVITEE, 'active');
    const service = createWorkspaceMembershipService({
      publisher: { publish: (): Promise<void> => Promise.reject(new Error('UnknownEventType')) },
      audit: createPersistentAuditWriter({ now: () => NOW, newId: () => EVENT_ID }),
      now: () => NOW,
      newEventId: () => EVENT_ID,
    });

    await expect(
      database.transaction((tx) =>
        service.invite(tx, { ...base, userId: INVITEE, role: 'editor' }),
      ),
    ).rejects.toThrow('UnknownEventType');
  });
});

describe('workspace role bindings', () => {
  it('projects an accepted membership into a workspace-tier binding', async () => {
    const h = harness();
    h.db.seed(INVITEE, 'editor', 'invited', EXPIRY);
    const result = await h.db.transaction((tx) =>
      h.service.accept(tx, { ...base, userId: INVITEE }),
    );

    expect(workspaceMembershipBinding(result.membership, ADMIN, NOW)).toMatchObject({
      subjectId: INVITEE,
      role: 'editor',
      tier: 'workspace',
      workspaceId: WS,
      organizationId: ORG,
      status: 'active',
    });
  });

  it('projects nothing from an invitation', async () => {
    const h = harness();
    const result = await h.db.transaction((tx) =>
      h.service.invite(tx, { ...base, userId: INVITEE, role: 'editor' }),
    );
    expect(workspaceMembershipBinding(result.membership, ADMIN, NOW)).toBeNull();
  });
});
