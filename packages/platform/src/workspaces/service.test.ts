/**
 * Workspaces Service — provisioning, quota and lifecycle.
 *
 * The fake below models TRANSACTIONS, not just statements, because the
 * behaviour under test needs them: `pg_advisory_xact_lock` is released at
 * transaction end, and the quota race it closes only exists between two
 * overlapping transactions. So the fake implements a real keyed mutex and
 * releases it in a `finally`.
 *
 * That buys a test worth having — the same race is run with locking enforced
 * and with it ignored, and the second one BREACHES the quota. The advisory lock
 * is shown to be load-bearing rather than merely present in a string.
 *
 * The real persistent audit writer runs against the fake `audit_log`, so a
 * restored prior status genuinely round-trips through an audit row.
 */
import { describe, expect, it } from 'vitest';

import type { DomainEvent, EventPublisher, Transaction } from '@contentos/contracts';
import { createPersistentAuditWriter, GENESIS_HASH } from '@contentos/security';

import { WorkspaceError, type WorkspaceStatus, type WorkspaceTransition } from './lifecycle.js';
import { DEFAULT_WORKSPACE_SETTINGS, WORKSPACE_SETTINGS_KEYS } from './settings.js';
import {
  createWorkspaceService,
  WORKSPACE_AUDIT_ACTIONS,
  type ProvisionWorkspaceCommand,
  type TransitionWorkspaceCommand,
  type WorkspaceExecutor,
  type WorkspaceService,
} from './service.js';

const ORG = '018f7a1e-0000-7000-8000-0000000000aa';
const WS = '018f7a1e-0000-7000-8000-0000000000c1';
const WS2 = '018f7a1e-0000-7000-8000-0000000000c2';
const ADMIN = '018f7a1e-0000-7000-8000-000000000001';
const ACTOR = '018f7a1e-0000-7000-8000-000000000002';
const CORRELATION = '018f7a1e-0000-7000-8000-0000000000dd';
const EVENT_ID = '018f7a1e-0000-7000-8000-0000000000ee';
const NOW = new Date('2026-07-30T12:00:00.000Z');

/** audit_log INSERT column positions, from the persistent writer's statement. */
const A_TENANT = 1;
const A_ORG = 2;
const A_ACTION = 7;
const A_TARGET_KIND = 8;
const A_TARGET_ID = 9;
const A_REASON = 12;
const A_CONTEXT = 13;
const A_PREVIOUS_HASH = 14;
const A_HASH = 15;

interface WsRow {
  id: string;
  organization_id: string;
  slug: string;
  name: string;
  status: string;
  settings: string;
  version: number;
  deleted: boolean;
}

interface OrgRow {
  id: string;
  status: string;
  plan_limits: unknown;
}

interface AuditContextJson {
  readonly detail?: Record<string, string>;
}

interface SettingsHistoryRow {
  readonly tenantId: string;
  readonly organizationId: string;
  readonly changedKeys: readonly string[];
  readonly before: unknown;
  readonly after: unknown;
  readonly changedBy: string;
}

/** Chained per-key mutex — the fake's stand-in for a transaction-scoped advisory lock. */
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

function uniqueViolation(constraint: string): Error {
  return Object.assign(new Error('duplicate key value violates unique constraint'), {
    code: '23505',
    constraint,
  });
}

interface ClusterOptions {
  /** 'ignored' makes the lock a no-op, exposing the race it exists to close. */
  readonly advisoryLocks?: 'enforced' | 'ignored';
  readonly maxWorkspaces?: number | null;
  readonly organizationStatus?: string;
}

interface Cluster {
  readonly workspaces: Map<string, WsRow>;
  readonly memberships: { tenantId: string; organizationId: string; userId: string }[];
  readonly settingsHistory: SettingsHistoryRow[];
  readonly auditRows: unknown[][];
  readonly sql: string[];
  readonly lockKeys: string[];
  transaction<T>(tenantId: string | null, work: (tx: WorkspaceExecutor) => Promise<T>): Promise<T>;
  failOn(needle: string, error: Error): void;
  auditActions(): string[];
  auditContext(index: number): AuditContextJson;
  setOrganization(status: string, maxWorkspaces?: number | null): void;
}

function cluster(options: ClusterOptions = {}): Cluster {
  const mode = options.advisoryLocks ?? 'enforced';
  const mutex = keyedMutex();

  const organizations = new Map<string, OrgRow>();
  organizations.set(ORG, {
    id: ORG,
    status: options.organizationStatus ?? 'active',
    plan_limits:
      options.maxWorkspaces === undefined || options.maxWorkspaces === null
        ? {}
        : { maxWorkspaces: options.maxWorkspaces },
  });

  const workspaces = new Map<string, WsRow>();
  const memberships: { tenantId: string; organizationId: string; userId: string }[] = [];
  const settingsHistory: SettingsHistoryRow[] = [];
  const auditRows: unknown[][] = [];
  const sql: string[] = [];
  const lockKeys: string[] = [];
  const failures: { needle: string; error: Error }[] = [];
  let membershipSeq = 0;
  let historySeq = 0;

  async function execute(
    q: string,
    params: unknown[],
    session: { tenantId: string | null; held: (() => void)[] },
  ): Promise<unknown[]> {
    if (q.includes('pg_advisory_xact_lock')) {
      const key = String(params[0]);
      lockKeys.push(key);
      if (mode === 'enforced') {
        session.held.push(await mutex.acquire(key));
      }
      return [{ pg_advisory_xact_lock: null }];
    }

    if (q.includes("current_setting('app.tenant_id'")) {
      return [{ tenant_id: session.tenantId }];
    }

    if (q.includes('FROM organizations')) {
      const row = organizations.get(String(params[0]));
      return row === undefined ? [] : [{ ...row }];
    }

    // Must precede the single-row workspace select: both read FROM workspaces.
    if (q.includes('count(*)::int')) {
      const statuses = params[1] as string[];
      const count = [...workspaces.values()].filter(
        (w) => w.organization_id === params[0] && !w.deleted && statuses.includes(w.status),
      ).length;
      return [{ count }];
    }

    if (q.includes('INSERT INTO workspaces')) {
      const [id, organizationId, slug, name, status, settings] = params;
      for (const existing of workspaces.values()) {
        if (existing.organization_id === organizationId && existing.slug === slug) {
          throw uniqueViolation('uq_workspaces__org_slug');
        }
      }
      workspaces.set(String(id), {
        id: String(id),
        organization_id: String(organizationId),
        slug: String(slug),
        name: String(name),
        status: String(status),
        settings: String(settings),
        version: 1,
        deleted: false,
      });
      return [{ id, version: 1 }];
    }

    if (q.includes('INSERT INTO workspace_memberships')) {
      membershipSeq += 1;
      memberships.push({
        tenantId: String(params[0]),
        organizationId: String(params[1]),
        userId: String(params[2]),
      });
      return [{ id: `018f7a1e-0000-7000-8000-0000000000d${String(membershipSeq)}` }];
    }

    if (q.includes('INSERT INTO workspace_settings_history')) {
      historySeq += 1;
      settingsHistory.push({
        tenantId: String(params[0]),
        organizationId: String(params[1]),
        changedKeys: params[2] as string[],
        before: JSON.parse(String(params[3])) as unknown,
        after: JSON.parse(String(params[4])) as unknown,
        changedBy: String(params[5]),
      });
      return [{ id: `018f7a1e-0000-7000-8000-0000000000f${String(historySeq)}` }];
    }

    if (q.includes('UPDATE workspaces')) {
      const row = workspaces.get(String(params[2]));
      if (row === undefined || row.deleted || row.version !== params[3]) return [];
      row.status = String(params[0]);
      row.version += 1;
      return [{ version: row.version }];
    }

    if (q.includes('FROM workspaces')) {
      const row = workspaces.get(String(params[0]));
      return row === undefined || row.deleted ? [] : [{ ...row }];
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
          r[A_TENANT] === params[0] &&
          r[A_TARGET_KIND] === 'workspace' &&
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

  return {
    workspaces,
    memberships,
    settingsHistory,
    auditRows,
    sql,
    lockKeys,
    async transaction(tenantId, work) {
      const session = { tenantId, held: [] as (() => void)[] };
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
      } as WorkspaceExecutor;

      try {
        return await work(tx);
      } finally {
        // Transaction-scoped: released on commit AND on rollback.
        for (const release of session.held) release();
      }
    },
    failOn(needle, error) {
      failures.push({ needle, error });
    },
    auditActions() {
      return auditRows.map((r) => String(r[A_ACTION]));
    },
    auditContext(index) {
      return JSON.parse(String(auditRows[index]?.[A_CONTEXT])) as AuditContextJson;
    },
    setOrganization(status, maxWorkspaces) {
      organizations.set(ORG, {
        id: ORG,
        status,
        plan_limits: maxWorkspaces === undefined || maxWorkspaces === null ? {} : { maxWorkspaces },
      });
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
  db: Cluster;
  publisher: EventPublisher & { events: DomainEvent<unknown>[] };
  service: WorkspaceService;
  quotaRejections: string[];
}

function harness(options: ClusterOptions = {}): Harness {
  const db = cluster(options);
  const publisher = recordingPublisher();
  const quotaRejections: string[] = [];
  const service = createWorkspaceService({
    publisher,
    audit: createPersistentAuditWriter({ now: () => NOW, newId: () => EVENT_ID }),
    now: () => NOW,
    newEventId: () => EVENT_ID,
    onQuotaRejected: (organizationId) => quotaRejections.push(organizationId),
  });
  return { db, publisher, service, quotaRejections };
}

function provisionCommand(
  over: Partial<ProvisionWorkspaceCommand> = {},
): ProvisionWorkspaceCommand {
  return {
    workspaceId: WS,
    organizationId: ORG,
    slug: 'acme-brand',
    name: 'Acme Brand',
    adminUserId: ADMIN,
    actor: { id: ACTOR, kind: 'user' },
    correlationId: CORRELATION,
    ...over,
  };
}

function transitionCommand(
  over: Partial<TransitionWorkspaceCommand> = {},
): TransitionWorkspaceCommand {
  return {
    workspaceId: WS,
    transition: 'suspend',
    reason: 'Organization suspended.',
    actor: { id: ACTOR, kind: 'user' },
    correlationId: CORRELATION,
    ...over,
  };
}

/** Provision, then walk the workspace through valid transitions. */
async function at(h: Harness, ...transitions: WorkspaceTransition[]): Promise<void> {
  await h.db.transaction(WS, (tx) => h.service.provision(tx, provisionCommand()));
  for (const transition of transitions) {
    await h.db.transaction(WS, (tx) => h.service.transition(tx, transitionCommand({ transition })));
  }
}

describe('workspace creation', () => {
  it('inserts the workspace as active and returns its identifiers', async () => {
    const h = harness();
    const result = await h.db.transaction(WS, (tx) => h.service.provision(tx, provisionCommand()));

    expect(result).toMatchObject({
      workspaceId: WS,
      organizationId: ORG,
      adminUserId: ADMIN,
      status: 'active',
      version: 1,
    });
    expect(h.db.workspaces.get(WS)).toMatchObject({
      slug: 'acme-brand',
      name: 'Acme Brand',
      status: 'active',
    });
  });

  // Workspace, admin, settings, audit and event on ONE handle, in this order.
  it('writes workspace, admin, settings history, audit and event in one transaction', async () => {
    const h = harness();
    await h.db.transaction(WS, (tx) => h.service.provision(tx, provisionCommand()));

    const order = h.db.sql
      .map((s) => {
        if (s.includes('INSERT INTO workspaces')) return 'workspace';
        if (s.includes('INSERT INTO workspace_memberships')) return 'admin';
        if (s.includes('INSERT INTO workspace_settings_history')) return 'settings';
        if (s.includes('INSERT INTO audit_log')) return 'audit';
        return null;
      })
      .filter((s): s is string => s !== null);

    expect(order).toEqual(['workspace', 'admin', 'settings', 'audit']);
    expect(h.publisher.events).toHaveLength(1);
  });

  it('never issues its own COMMIT or ROLLBACK', async () => {
    const h = harness();
    await h.db.transaction(WS, (tx) => h.service.provision(tx, provisionCommand()));
    for (const statement of h.db.sql) {
      expect(statement).not.toMatch(/\b(COMMIT|ROLLBACK|BEGIN)\b/);
    }
  });

  it('stores the neutral default settings layer', async () => {
    const h = harness();
    await h.db.transaction(WS, (tx) => h.service.provision(tx, provisionCommand()));
    expect(JSON.parse(h.db.workspaces.get(WS)?.settings ?? '{}')).toEqual(
      DEFAULT_WORKSPACE_SETTINGS,
    );
  });

  // The history row satisfies `cardinality(changed_keys) > 0` and gives the
  // configuration a first entry rather than appearing configured by nobody.
  it('records the initial settings layer in the append-only history', async () => {
    const h = harness();
    const result = await h.db.transaction(WS, (tx) => h.service.provision(tx, provisionCommand()));

    expect(h.db.settingsHistory).toHaveLength(1);
    expect(h.db.settingsHistory[0]).toMatchObject({
      tenantId: WS,
      organizationId: ORG,
      before: {},
      after: DEFAULT_WORKSPACE_SETTINGS,
      changedBy: ACTOR,
    });
    expect(h.db.settingsHistory[0]?.changedKeys).toEqual([...WORKSPACE_SETTINGS_KEYS]);
    expect(h.db.settingsHistory[0]?.changedKeys.length).toBeGreaterThan(0);
    expect(result.settingsHistoryId).toBeDefined();
  });
});

describe('first workspace_admin membership', () => {
  it('creates exactly one membership, for the nominated admin', async () => {
    const h = harness();
    const result = await h.db.transaction(WS, (tx) => h.service.provision(tx, provisionCommand()));

    expect(h.db.memberships).toEqual([{ tenantId: WS, organizationId: ORG, userId: ADMIN }]);
    expect(result.adminMembershipId).toBeDefined();
  });

  // A workspace with no active administrator is unadministrable and its data
  // unreachable through normal paths.
  it('makes that membership workspace_admin and active, not invited', async () => {
    const h = harness();
    await h.db.transaction(WS, (tx) => h.service.provision(tx, provisionCommand()));

    const insert = h.db.sql.find((s) => s.includes('INSERT INTO workspace_memberships'));
    expect(insert).toContain("'workspace_admin'");
    expect(insert).toContain("'active'");
    expect(insert).not.toContain("'invited'");
  });
});

describe('no partial workspace', () => {
  const FAILURE_POINTS: readonly (readonly [string, string])[] = [
    ['admin membership', 'INSERT INTO workspace_memberships'],
    ['settings history', 'INSERT INTO workspace_settings_history'],
    ['audit', 'INSERT INTO audit_log'],
  ];

  for (const [label, needle] of FAILURE_POINTS) {
    it(`propagates a ${label} failure and publishes nothing`, async () => {
      const h = harness();
      h.db.failOn(needle, new Error('deadlock detected'));

      await expect(
        h.db.transaction(WS, (tx) => h.service.provision(tx, provisionCommand())),
      ).rejects.toThrow('deadlock detected');
      expect(h.publisher.events).toHaveLength(0);
    });
  }

  it('propagates a publish failure so the whole provision rolls back', async () => {
    const db = cluster();
    const service = createWorkspaceService({
      publisher: { publish: (): Promise<void> => Promise.reject(new Error('UnknownEventType')) },
      audit: createPersistentAuditWriter({ now: () => NOW, newId: () => EVENT_ID }),
      now: () => NOW,
      newEventId: () => EVENT_ID,
    });

    await expect(
      db.transaction(WS, (tx) => service.provision(tx, provisionCommand())),
    ).rejects.toThrow('UnknownEventType');
  });

  it('refuses when the transaction is not running under the workspace being created', async () => {
    const h = harness();
    const wrong = h.db.transaction(ORG, (tx) => h.service.provision(tx, provisionCommand()));

    await expect(wrong).rejects.toBeInstanceOf(WorkspaceError);
    await expect(wrong).rejects.toMatchObject({ code: 'TenantContextMismatch' });
    expect(h.db.workspaces.size).toBe(0);
  });
});

describe('advisory locking', () => {
  it('takes a lock keyed on the organization', async () => {
    const h = harness();
    await h.db.transaction(WS, (tx) => h.service.provision(tx, provisionCommand()));
    expect(h.db.lockKeys).toEqual([ORG]);
  });

  // Transaction-scoped: released on commit AND rollback, so a failed provision
  // cannot strand it and there is no unlock path to forget.
  it('uses a transaction-scoped lock, not a session lock', async () => {
    const h = harness();
    await h.db.transaction(WS, (tx) => h.service.provision(tx, provisionCommand()));

    const lock = h.db.sql.find((s) => s.includes('pg_advisory'));
    expect(lock).toContain('pg_advisory_xact_lock');
    expect(lock).not.toMatch(/pg_advisory_lock\b/);
  });

  // Namespaced, so it cannot collide with an unrelated advisory lock elsewhere.
  it('namespaces the lock key by purpose', async () => {
    const h = harness();
    await h.db.transaction(WS, (tx) => h.service.provision(tx, provisionCommand()));
    expect(h.db.sql.find((s) => s.includes('pg_advisory'))).toContain(
      "hashtext('workspace_quota')",
    );
  });

  // Taking it after the count would leave exactly the race it exists to close.
  it('takes the lock BEFORE reading the count', async () => {
    const h = harness();
    await h.db.transaction(WS, (tx) => h.service.provision(tx, provisionCommand()));

    const lockAt = h.db.sql.findIndex((s) => s.includes('pg_advisory_xact_lock'));
    const countAt = h.db.sql.findIndex((s) => s.includes('count(*)::int'));
    expect(lockAt).toBeGreaterThanOrEqual(0);
    expect(countAt).toBeGreaterThan(lockAt);
  });

  it('also guards a standalone quota check', async () => {
    const h = harness({ maxWorkspaces: 3 });
    const quota = await h.db.transaction(null, (tx) => h.service.checkQuota(tx, ORG));

    expect(quota).toEqual({ organizationId: ORG, used: 0, limit: 3, allowed: true });
    expect(h.db.lockKeys).toEqual([ORG]);
  });

  it('releases the lock even when the transaction fails', async () => {
    const h = harness({ maxWorkspaces: 5 });
    h.db.failOn('INSERT INTO workspaces', new Error('boom'));

    await expect(
      h.db.transaction(WS, (tx) => h.service.provision(tx, provisionCommand())),
    ).rejects.toThrow('boom');

    // A stranded lock would deadlock this second transaction.
    const quota = await h.db.transaction(null, (tx) => h.service.checkQuota(tx, ORG));
    expect(quota.used).toBe(0);
  });
});

describe('quota enforcement', () => {
  it('refuses a workspace that would exceed the plan cap', async () => {
    const h = harness({ maxWorkspaces: 1 });
    await h.db.transaction(WS, (tx) => h.service.provision(tx, provisionCommand()));

    const over = h.db.transaction(WS2, (tx) =>
      h.service.provision(tx, provisionCommand({ workspaceId: WS2, slug: 'second' })),
    );
    await expect(over).rejects.toBeInstanceOf(WorkspaceError);
    await expect(over).rejects.toMatchObject({ code: 'QuotaExceeded' });
    expect(h.quotaRejections).toEqual([ORG]);
  });

  it('refuses everything at a cap of zero', async () => {
    const h = harness({ maxWorkspaces: 0 });
    await expect(
      h.db.transaction(WS, (tx) => h.service.provision(tx, provisionCommand())),
    ).rejects.toMatchObject({ code: 'QuotaExceeded' });
  });

  // An archived workspace is retained but frees its slot; that is what makes
  // archiving a usable alternative to deletion.
  it('does not count archived or pending_deletion workspaces', async () => {
    const h = harness({ maxWorkspaces: 1 });
    await at(h, 'archive');

    const second = await h.db.transaction(WS2, (tx) =>
      h.service.provision(tx, provisionCommand({ workspaceId: WS2, slug: 'second' })),
    );
    expect(second.workspaceId).toBe(WS2);
  });

  it('counts a suspended workspace, which still occupies its slot', async () => {
    const h = harness({ maxWorkspaces: 1 });
    await at(h, 'suspend');

    await expect(
      h.db.transaction(WS2, (tx) =>
        h.service.provision(tx, provisionCommand({ workspaceId: WS2, slug: 'second' })),
      ),
    ).rejects.toMatchObject({ code: 'QuotaExceeded' });
  });

  // `plan_limits` defaults to `{}` and is Commerce's to author. Refusing every
  // creation until `SubscriptionChanged` arrives would make a new organization
  // unusable at the moment it is created.
  it('does not enforce a cap Commerce has not projected yet', async () => {
    const h = harness({ maxWorkspaces: null });
    const quota = await h.db.transaction(null, (tx) => h.service.checkQuota(tx, ORG));
    expect(quota.limit).toBeNull();
    expect(quota.allowed).toBe(true);

    const created = await h.db.transaction(WS, (tx) => h.service.provision(tx, provisionCommand()));
    expect(created.status).toBe('active');
  });

  it('reports usage against the cap', async () => {
    const h = harness({ maxWorkspaces: 2 });
    await h.db.transaction(WS, (tx) => h.service.provision(tx, provisionCommand()));

    const quota = await h.db.transaction(null, (tx) => h.service.checkQuota(tx, ORG));
    expect(quota).toEqual({ organizationId: ORG, used: 1, limit: 2, allowed: true });
  });
});

describe('the quota race the advisory lock closes', () => {
  // Two overlapping provisions against a cap of one.
  it('lets exactly one of two concurrent provisions win', async () => {
    const h = harness({ maxWorkspaces: 1 });

    const results = await Promise.allSettled([
      h.db.transaction(WS, (tx) => h.service.provision(tx, provisionCommand())),
      h.db.transaction(WS2, (tx) =>
        h.service.provision(tx, provisionCommand({ workspaceId: WS2, slug: 'second' })),
      ),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected');
    expect((rejected as PromiseRejectedResult).reason).toMatchObject({ code: 'QuotaExceeded' });
    expect(h.db.workspaces.size).toBe(1);
  });

  // The control. With the lock a no-op, both read a count of zero before either
  // inserts, and the cap is breached — which is precisely the failure the
  // advisory lock exists to prevent, demonstrated rather than asserted.
  it('BREACHES the cap when the lock is not taken, proving the lock is load-bearing', async () => {
    const h = harness({ maxWorkspaces: 1, advisoryLocks: 'ignored' });

    const results = await Promise.allSettled([
      h.db.transaction(WS, (tx) => h.service.provision(tx, provisionCommand())),
      h.db.transaction(WS2, (tx) =>
        h.service.provision(tx, provisionCommand({ workspaceId: WS2, slug: 'second' })),
      ),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    expect(h.db.workspaces.size).toBe(2);
  });

  it('serialises three concurrent provisions against a cap of two', async () => {
    const h = harness({ maxWorkspaces: 2 });
    const ids = [WS, WS2, '018f7a1e-0000-7000-8000-0000000000c3'];

    const results = await Promise.allSettled(
      ids.map((id, i) =>
        h.db.transaction(id, (tx) =>
          h.service.provision(
            tx,
            provisionCommand({ workspaceId: id, slug: `brand-${String(i)}` }),
          ),
        ),
      ),
    );

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(h.db.workspaces.size).toBe(2);
  });
});

describe('the organization gates creation', () => {
  // Organizations rule 13: past_due is "full function ... no new workspaces".
  const REFUSED = ['past_due', 'suspended', 'pending_closure', 'closed'];

  for (const status of REFUSED) {
    it(`refuses to create a workspace in a '${status}' organization`, async () => {
      const h = harness();
      h.db.setOrganization(status);

      const rejected = h.db.transaction(WS, (tx) => h.service.provision(tx, provisionCommand()));
      await expect(rejected).rejects.toMatchObject({ code: 'OrganizationNotActive' });
      expect(h.db.workspaces.size).toBe(0);
    });
  }

  it('answers an unknown organization as absent', async () => {
    const h = harness();
    const missing = h.db.transaction(WS, (tx) =>
      h.service.provision(
        tx,
        provisionCommand({ organizationId: '018f7a1e-0000-7000-8000-00000000ffff' }),
      ),
    );
    await expect(missing).rejects.toMatchObject({ code: 'OrganizationNotFound' });
  });
});

describe('slug uniqueness is decided by the database', () => {
  it('reports a taken slug as a typed SlugAlreadyTaken', async () => {
    const h = harness();
    await h.db.transaction(WS, (tx) => h.service.provision(tx, provisionCommand()));

    const conflict = h.db.transaction(WS2, (tx) =>
      h.service.provision(tx, provisionCommand({ workspaceId: WS2 })),
    );
    await expect(conflict).rejects.toMatchObject({ code: 'SlugAlreadyTaken' });
  });

  it('does not disguise an unrelated database error as a slug conflict', async () => {
    const h = harness();
    h.db.failOn('INSERT INTO workspaces', new Error('connection reset'));
    await expect(
      h.db.transaction(WS, (tx) => h.service.provision(tx, provisionCommand())),
    ).rejects.toThrow('connection reset');
  });
});

describe('lifecycle transitions', () => {
  const CASES: readonly {
    readonly transition: WorkspaceTransition;
    readonly path: WorkspaceTransition[];
    readonly expected: WorkspaceStatus;
  }[] = [
    { transition: 'suspend', path: [], expected: 'suspended' },
    { transition: 'reactivate', path: ['suspend'], expected: 'active' },
    { transition: 'archive', path: [], expected: 'archived' },
    { transition: 'restore', path: ['archive'], expected: 'active' },
    { transition: 'request_deletion', path: [], expected: 'pending_deletion' },
    { transition: 'cancel_deletion', path: ['request_deletion'], expected: 'active' },
  ];

  for (const { transition, path, expected } of CASES) {
    it(`moves the workspace to '${expected}' on '${transition}'`, async () => {
      const h = harness();
      await at(h, ...path);
      const result = await h.db.transaction(WS, (tx) =>
        h.service.transition(tx, transitionCommand({ transition })),
      );

      expect(result.status).toBe(expected);
      expect(h.db.workspaces.get(WS)?.status).toBe(expected);
    });
  }

  it('bumps the version on every transition', async () => {
    const h = harness();
    await at(h);
    const first = await h.db.transaction(WS, (tx) =>
      h.service.transition(tx, transitionCommand({ transition: 'suspend' })),
    );
    const second = await h.db.transaction(WS, (tx) =>
      h.service.transition(tx, transitionCommand({ transition: 'archive' })),
    );
    expect(first.version).toBe(2);
    expect(second.version).toBe(3);
  });

  it('reports the organization the workspace belongs to', async () => {
    const h = harness();
    await at(h);
    const result = await h.db.transaction(WS, (tx) =>
      h.service.transition(tx, transitionCommand({ transition: 'suspend' })),
    );
    expect(result.organizationId).toBe(ORG);
  });

  it('refuses a transition the state machine does not permit, before any write', async () => {
    const h = harness();
    await at(h, 'request_deletion');
    const before = h.db.sql.length;

    const rejected = h.db.transaction(WS, (tx) =>
      h.service.transition(tx, transitionCommand({ transition: 'suspend' })),
    );
    await expect(rejected).rejects.toMatchObject({ code: 'InvalidTransition' });

    expect(h.db.sql.slice(before).filter((s) => s.includes('UPDATE workspaces'))).toHaveLength(0);
    expect(h.db.workspaces.get(WS)?.status).toBe('pending_deletion');
  });

  // Cross-workspace access returns 404, never 403.
  it('answers an unknown workspace as absent', async () => {
    const h = harness();
    const missing = h.db.transaction(WS2, (tx) =>
      h.service.transition(tx, transitionCommand({ workspaceId: WS2 })),
    );
    await expect(missing).rejects.toMatchObject({ code: 'WorkspaceNotFound' });
  });
});

describe('reactivation restores the previous recorded state', () => {
  it('reactivates a suspended workspace to active', async () => {
    const h = harness();
    await at(h, 'suspend');
    const result = await h.db.transaction(WS, (tx) =>
      h.service.transition(tx, transitionCommand({ transition: 'reactivate' })),
    );
    expect(result.status).toBe('active');
  });

  // Un-archiving is not a pardon.
  it('returns a workspace archived while suspended to suspended, not active', async () => {
    const h = harness();
    await at(h, 'suspend', 'archive');
    expect(h.db.workspaces.get(WS)?.status).toBe('archived');

    const result = await h.db.transaction(WS, (tx) =>
      h.service.transition(tx, transitionCommand({ transition: 'restore' })),
    );
    expect(result.status).toBe('suspended');
    expect(h.db.workspaces.get(WS)?.status).toBe('suspended');
  });

  it('returns a workspace archived while active to active', async () => {
    const h = harness();
    await at(h, 'archive');
    const result = await h.db.transaction(WS, (tx) =>
      h.service.transition(tx, transitionCommand({ transition: 'restore' })),
    );
    expect(result.status).toBe('active');
  });

  // Cancelling a deletion request must not silently un-archive.
  it('returns a cancelled deletion to the archived state it was requested from', async () => {
    const h = harness();
    await at(h, 'archive', 'request_deletion');

    const result = await h.db.transaction(WS, (tx) =>
      h.service.transition(tx, transitionCommand({ transition: 'cancel_deletion' })),
    );
    expect(result.status).toBe('archived');
  });

  it('reads the MOST RECENT archive, not the first', async () => {
    const h = harness();
    await at(h, 'archive', 'restore', 'suspend', 'archive');

    const result = await h.db.transaction(WS, (tx) =>
      h.service.transition(tx, transitionCommand({ transition: 'restore' })),
    );
    expect(result.status).toBe('suspended');
  });

  it('falls back to active when nothing was recorded', async () => {
    const h = harness();
    await at(h);
    const row = h.db.workspaces.get(WS);
    if (row !== undefined) row.status = 'archived';

    const result = await h.db.transaction(WS, (tx) =>
      h.service.transition(tx, transitionCommand({ transition: 'restore' })),
    );
    expect(result.status).toBe('active');
  });

  it('does not consult the audit trail for a non-restoring transition', async () => {
    const h = harness();
    await at(h);
    const before = h.db.sql.length;

    await h.db.transaction(WS, (tx) =>
      h.service.transition(tx, transitionCommand({ transition: 'suspend' })),
    );
    expect(h.db.sql.slice(before).filter((s) => s.includes("context -> 'detail'"))).toHaveLength(0);
  });
});

describe('audit generation', () => {
  it('records workspace.created on provisioning, scoped to the workspace as tenant', async () => {
    const h = harness({ maxWorkspaces: 4 });
    await h.db.transaction(WS, (tx) => h.service.provision(tx, provisionCommand()));

    expect(h.db.auditActions()).toEqual([WORKSPACE_AUDIT_ACTIONS.provision]);
    const row = h.db.auditRows[0];
    expect(row?.[A_TENANT]).toBe(WS);
    expect(row?.[A_ORG]).toBe(ORG);
    expect(row?.[A_TARGET_KIND]).toBe('workspace');
    expect(row?.[A_TARGET_ID]).toBe(WS);
    expect(h.db.auditContext(0).detail).toMatchObject({
      status: 'active',
      adminUserId: ADMIN,
      quotaUsed: '0',
      quotaLimit: '4',
    });
  });

  it('records an enumerated action for every transition', async () => {
    const h = harness();
    await at(h, 'suspend', 'reactivate', 'archive', 'restore', 'request_deletion');

    expect(h.db.auditActions()).toEqual([
      WORKSPACE_AUDIT_ACTIONS.provision,
      WORKSPACE_AUDIT_ACTIONS.suspend,
      WORKSPACE_AUDIT_ACTIONS.reactivate,
      WORKSPACE_AUDIT_ACTIONS.archive,
      WORKSPACE_AUDIT_ACTIONS.restore,
      WORKSPACE_AUDIT_ACTIONS.request_deletion,
    ]);
  });

  // This detail is what a later restore reads back.
  it('records the status each transition moved away from', async () => {
    const h = harness();
    await at(h, 'suspend', 'archive');

    expect(h.db.auditContext(1).detail).toMatchObject({
      previousStatus: 'active',
      status: 'suspended',
      transition: 'suspend',
    });
    expect(h.db.auditContext(2).detail).toMatchObject({
      previousStatus: 'suspended',
      status: 'archived',
    });
  });

  it('carries the mandatory reason', async () => {
    const h = harness();
    await at(h);
    await h.db.transaction(WS, (tx) =>
      h.service.transition(
        tx,
        transitionCommand({ transition: 'suspend', reason: 'Abuse report #91 upheld.' }),
      ),
    );
    expect(h.db.auditRows[1]?.[A_REASON]).toBe('Abuse report #91 upheld.');
  });

  it('chains each record to the one before it', async () => {
    const h = harness();
    await at(h, 'suspend');
    expect(h.db.auditRows[0]?.[A_PREVIOUS_HASH]).toBe(GENESIS_HASH);
    expect(h.db.auditRows[1]?.[A_PREVIOUS_HASH]).toBe(h.db.auditRows[0]?.[A_HASH]);
  });
});

describe('outbox generation', () => {
  it('publishes WorkspaceCreated with the documented payload', async () => {
    const h = harness();
    await h.db.transaction(WS, (tx) => h.service.provision(tx, provisionCommand()));

    expect(h.publisher.events[0]).toMatchObject({
      eventId: EVENT_ID,
      eventType: 'WorkspaceCreated',
      eventVersion: 1,
      aggregateType: 'Workspace',
      aggregateId: WS,
      tenantId: WS,
      organizationId: ORG,
      correlationId: CORRELATION,
      causationId: null,
      producer: 'platform.workspaces',
      occurredAt: '2026-07-30T12:00:00.000Z',
      payload: {
        workspaceId: WS,
        organizationId: ORG,
        name: 'Acme Brand',
        slug: 'acme-brand',
        createdBy: ADMIN,
      },
    });
  });

  // A cascade from OrganizationSuspended sets this, which is what makes an
  // incident reconstructable across the organization/workspace seam.
  it('carries a causation id when the action reacted to another event', async () => {
    const h = harness();
    const causation = '018f7a1e-0000-7000-8000-0000000000cc';
    await h.db.transaction(WS, (tx) =>
      h.service.provision(tx, provisionCommand({ causationId: causation })),
    );
    expect(h.publisher.events[0]?.causationId).toBe(causation);
  });

  it('publishes WorkspaceSuspended with the reason and timestamp', async () => {
    const h = harness();
    await at(h);
    await h.db.transaction(WS, (tx) =>
      h.service.transition(
        tx,
        transitionCommand({ transition: 'suspend', reason: 'Org suspended.' }),
      ),
    );

    expect(h.publisher.events[1]).toMatchObject({
      eventType: 'WorkspaceSuspended',
      payload: {
        workspaceId: WS,
        reason: 'Org suspended.',
        suspendedAt: '2026-07-30T12:00:00.000Z',
      },
    });
  });

  it('publishes WorkspaceArchived naming the actor', async () => {
    const h = harness();
    await at(h);
    await h.db.transaction(WS, (tx) =>
      h.service.transition(tx, transitionCommand({ transition: 'archive' })),
    );
    expect(h.publisher.events[1]).toMatchObject({
      eventType: 'WorkspaceArchived',
      payload: { workspaceId: WS, archivedBy: ACTOR },
    });
  });

  it('publishes WorkspaceDeletionRequested with a purge date 30 days out', async () => {
    const h = harness();
    await at(h);
    await h.db.transaction(WS, (tx) =>
      h.service.transition(tx, transitionCommand({ transition: 'request_deletion' })),
    );
    expect(h.publisher.events[1]).toMatchObject({
      eventType: 'WorkspaceDeletionRequested',
      payload: { workspaceId: WS, purgeAfter: '2026-08-29T12:00:00.000Z' },
    });
  });

  // All three restoring transitions publish it; its payload is shaped for them.
  const RESTORING: readonly (readonly [WorkspaceTransition, WorkspaceTransition[], string])[] = [
    ['reactivate', ['suspend'], 'suspended'],
    ['restore', ['archive'], 'archived'],
    ['cancel_deletion', ['request_deletion'], 'pending_deletion'],
  ];

  for (const [transition, path, previousStatus] of RESTORING) {
    it(`publishes WorkspaceReactivated on '${transition}', carrying previousStatus`, async () => {
      const h = harness();
      await at(h, ...path);
      await h.db.transaction(WS, (tx) =>
        h.service.transition(tx, transitionCommand({ transition })),
      );

      expect(h.publisher.events.at(-1)).toMatchObject({
        eventType: 'WorkspaceReactivated',
        payload: { workspaceId: WS, previousStatus },
      });
    });
  }

  it('publishes an event for every transition — none is audited but silent', async () => {
    const h = harness();
    await at(h, 'suspend', 'reactivate', 'archive', 'restore', 'request_deletion');
    // provision + five transitions
    expect(h.publisher.events).toHaveLength(6);
  });

  it('publishes every workspace event under the workspace as tenant', async () => {
    const h = harness();
    await at(h, 'suspend', 'reactivate');
    for (const event of h.publisher.events) {
      expect(event.tenantId).toBe(WS);
      expect(event.aggregateId).toBe(WS);
      expect(event.organizationId).toBe(ORG);
    }
  });
});

describe('concurrency', () => {
  it('refuses a transition whose expected version is stale', async () => {
    const h = harness();
    await at(h);

    const stale = h.db.transaction(WS, (tx) =>
      h.service.transition(tx, transitionCommand({ transition: 'suspend', expectedVersion: 99 })),
    );
    await expect(stale).rejects.toBeInstanceOf(WorkspaceError);
    await expect(stale).rejects.toMatchObject({ code: 'ConcurrentModification' });
    expect(h.db.workspaces.get(WS)?.status).toBe('active');
  });

  it('leaves no audit record or event behind when it loses the race', async () => {
    const h = harness();
    await at(h);
    const auditBefore = h.db.auditRows.length;
    const eventsBefore = h.publisher.events.length;

    await expect(
      h.db.transaction(WS, (tx) =>
        h.service.transition(tx, transitionCommand({ expectedVersion: 42 })),
      ),
    ).rejects.toMatchObject({ code: 'ConcurrentModification' });

    expect(h.db.auditRows).toHaveLength(auditBefore);
    expect(h.publisher.events).toHaveLength(eventsBefore);
  });

  it('lets exactly one of two concurrent transitions win', async () => {
    const h = harness();
    await at(h);

    const results = await Promise.allSettled([
      h.db.transaction(WS, (tx) =>
        h.service.transition(tx, transitionCommand({ transition: 'suspend' })),
      ),
      h.db.transaction(WS, (tx) =>
        h.service.transition(tx, transitionCommand({ transition: 'archive' })),
      ),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      (results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason,
    ).toMatchObject({
      code: 'ConcurrentModification',
    });
  });

  it('accepts an explicit expected version that is current', async () => {
    const h = harness();
    await at(h);
    const result = await h.db.transaction(WS, (tx) =>
      h.service.transition(tx, transitionCommand({ transition: 'suspend', expectedVersion: 1 })),
    );
    expect(result.version).toBe(2);
  });
});
