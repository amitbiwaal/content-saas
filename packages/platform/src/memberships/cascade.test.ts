/**
 * Organization → workspace revocation cascade.
 *
 * The fake here is a small multi-tenant cluster: several workspaces, each with
 * its own `workspace_memberships` and its own tenant-scoped transaction. That
 * shape is the point — a single transaction cannot reach across them, which is
 * why the cascade exists as a per-workspace walk and why idempotence is the
 * property it must have rather than atomicity.
 */
import { describe, expect, it } from 'vitest';

import type { DomainEvent, EventPublisher, Transaction } from '@contentos/contracts';
import { createPersistentAuditWriter } from '@contentos/security';

import { createMembershipCascade, type WorkspaceScopedRunner } from './cascade.js';
import type { MembershipExecutor } from './organization-memberships.js';
import { createWorkspaceMembershipService } from './workspace-memberships.js';

const ORG = '018f7a1e-0000-7000-8000-0000000000aa';
const WS_A = '018f7a1e-0000-7000-8000-0000000000c1';
const WS_B = '018f7a1e-0000-7000-8000-0000000000c2';
const WS_C = '018f7a1e-0000-7000-8000-0000000000c3';
const ADMIN = '018f7a1e-0000-7000-8000-000000000001';
const LEAVER = '018f7a1e-0000-7000-8000-000000000003';
const CORRELATION = '018f7a1e-0000-7000-8000-0000000000dd';
const CAUSATION = '018f7a1e-0000-7000-8000-0000000000ef';
const EVENT_ID = '018f7a1e-0000-7000-8000-0000000000ee';
const NOW = new Date('2026-07-30T12:00:00.000Z');

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

interface Cluster {
  readonly runner: WorkspaceScopedRunner;
  readonly rows: Map<string, Row>;
  readonly auditRows: unknown[][];
  seed(workspaceId: string, userId: string, role: string, status: string): void;
  failWorkspace(workspaceId: string, error: Error): void;
  rowFor(workspaceId: string, userId: string): Row | undefined;
}

function cluster(workspaceIds: readonly string[]): Cluster {
  const rows = new Map<string, Row>();
  const auditRows: unknown[][] = [];
  const failures = new Map<string, Error>();
  let seq = 0;

  const key = (workspaceId: string, userId: string): string => `${workspaceId}:${userId}`;
  const byId = (id: string): Row | undefined => [...rows.values()].find((r) => r.id === id);

  function executor(workspaceId: string): MembershipExecutor {
    return {
      query<T>(q: string, p?: readonly unknown[]): Promise<readonly T[]> {
        const params = [...(p ?? [])];
        const failure = failures.get(workspaceId);
        if (failure !== undefined) return Promise.reject(failure);

        if (q.includes('pg_advisory_xact_lock')) return Promise.resolve([] as readonly T[]);

        if (q.includes('count(*)::int')) {
          const count = [...rows.values()].filter(
            (r) => r.tenant_id === params[0] && r.role === params[1] && r.status === 'active',
          ).length;
          return Promise.resolve([{ count }] as readonly T[]);
        }

        if (q.includes('FROM workspace_memberships')) {
          // Tenant-scoped: only this workspace's rows are visible, exactly as
          // the RLS policy would enforce.
          const row = rows.get(key(workspaceId, String(params[1])));
          return Promise.resolve((row === undefined ? [] : [{ ...row }]) as readonly T[]);
        }

        if (q.includes("SET status = 'revoked'")) {
          const row = byId(String(params[1]));
          if (row === undefined || row.version !== params[2]) {
            return Promise.resolve([] as readonly T[]);
          }
          row.status = 'revoked';
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

        throw new Error(`unexpected statement: ${q}`);
      },
    } as MembershipExecutor;
  }

  return {
    runner: {
      listWorkspaceIds: () => Promise.resolve(workspaceIds),
      withWorkspace: (workspaceId, _organizationId, work) => work(executor(workspaceId)),
    },
    rows,
    auditRows,
    seed(workspaceId, userId, role, status) {
      seq += 1;
      rows.set(key(workspaceId, userId), {
        id: `018f7a1e-0000-7000-8000-00000000f${String(seq).padStart(3, '0')}`,
        tenant_id: workspaceId,
        organization_id: ORG,
        user_id: userId,
        role,
        status,
        expires_at: null,
        invited_by: ADMIN,
        version: 1,
      });
    },
    failWorkspace(workspaceId, error) {
      failures.set(workspaceId, error);
    },
    rowFor(workspaceId, userId) {
      return rows.get(key(workspaceId, userId));
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

function harness(workspaceIds: readonly string[]): {
  db: Cluster;
  publisher: EventPublisher & { events: DomainEvent<unknown>[] };
  cascade: ReturnType<typeof createMembershipCascade>;
} {
  const db = cluster(workspaceIds);
  const publisher = recordingPublisher();
  const workspaces = createWorkspaceMembershipService({
    publisher,
    audit: createPersistentAuditWriter({ now: () => NOW, newId: () => EVENT_ID }),
    now: () => NOW,
    newEventId: () => EVENT_ID,
  });
  return { db, publisher, cascade: createMembershipCascade({ workspaces, runner: db.runner }) };
}

const request = {
  organizationId: ORG,
  userId: LEAVER,
  actor: { id: 'organizations', kind: 'service' as const },
  correlationId: CORRELATION,
  causationId: CAUSATION,
};

describe('organization membership revocation cascade', () => {
  it('revokes the user in every workspace they belong to', async () => {
    const h = harness([WS_A, WS_B]);
    h.db.seed(WS_A, LEAVER, 'editor', 'active');
    h.db.seed(WS_B, LEAVER, 'viewer', 'active');

    const result = await h.cascade.revokeAcrossWorkspaces(request);

    expect(result.revoked).toEqual([WS_A, WS_B]);
    expect(result.complete).toBe(true);
    expect(h.db.rowFor(WS_A, LEAVER)?.status).toBe('revoked');
    expect(h.db.rowFor(WS_B, LEAVER)?.status).toBe('revoked');
  });

  // The cascade walks workspaces, not memberships, so not being a member is an
  // ordinary outcome.
  it('skips workspaces the user never joined', async () => {
    const h = harness([WS_A, WS_B, WS_C]);
    h.db.seed(WS_A, LEAVER, 'editor', 'active');

    const result = await h.cascade.revokeAcrossWorkspaces(request);

    expect(result.revoked).toEqual([WS_A]);
    expect(result.notMember).toEqual([WS_B, WS_C]);
    expect(result.workspacesVisited).toBe(3);
    expect(result.complete).toBe(true);
  });

  it('leaves other users untouched', async () => {
    const h = harness([WS_A]);
    h.db.seed(WS_A, LEAVER, 'editor', 'active');
    h.db.seed(WS_A, ADMIN, 'workspace_admin', 'active');

    await h.cascade.revokeAcrossWorkspaces(request);
    expect(h.db.rowFor(WS_A, ADMIN)?.status).toBe('active');
  });

  // The requirement the design is shaped around: a retried handler converges.
  it('is idempotent — a second run revokes nothing further', async () => {
    const h = harness([WS_A, WS_B]);
    h.db.seed(WS_A, LEAVER, 'editor', 'active');
    h.db.seed(WS_B, LEAVER, 'viewer', 'active');

    const first = await h.cascade.revokeAcrossWorkspaces(request);
    const second = await h.cascade.revokeAcrossWorkspaces(request);

    expect(first.revoked).toEqual([WS_A, WS_B]);
    expect(second.revoked).toEqual([]);
    expect(second.alreadyRevoked).toEqual([WS_A, WS_B]);
    expect(second.complete).toBe(true);
    // And nothing is published twice.
    expect(h.publisher.events).toHaveLength(2);
    expect(h.db.auditRows).toHaveLength(2);
  });

  it('is idempotent over a membership that was already revoked by hand', async () => {
    const h = harness([WS_A]);
    h.db.seed(WS_A, LEAVER, 'editor', 'revoked');

    const result = await h.cascade.revokeAcrossWorkspaces(request);
    expect(result.revoked).toEqual([]);
    expect(result.alreadyRevoked).toEqual([WS_A]);
    expect(h.publisher.events).toHaveLength(0);
  });

  // Two documented rules collide; security decides it, and the override is
  // recorded rather than silent.
  it('revokes even where the leaver is the last workspace_admin', async () => {
    const h = harness([WS_A]);
    h.db.seed(WS_A, LEAVER, 'workspace_admin', 'active');

    const result = await h.cascade.revokeAcrossWorkspaces(request);

    expect(result.revoked).toEqual([WS_A]);
    expect(h.db.rowFor(WS_A, LEAVER)?.status).toBe('revoked');
    const context = JSON.parse(String(h.db.auditRows[0]?.[13])) as {
      detail?: Record<string, string>;
    };
    expect(context.detail).toMatchObject({ lastAdminProtectionOverridden: 'true' });
  });

  it('ties each workspace revocation to the organization decision that caused it', async () => {
    const h = harness([WS_A, WS_B]);
    h.db.seed(WS_A, LEAVER, 'editor', 'active');
    h.db.seed(WS_B, LEAVER, 'viewer', 'active');

    await h.cascade.revokeAcrossWorkspaces(request);

    expect(h.publisher.events).toHaveLength(2);
    for (const event of h.publisher.events) {
      expect(event.eventType).toBe('MembershipRevoked');
      expect(event.causationId).toBe(CAUSATION);
      expect(event.correlationId).toBe(CORRELATION);
      expect(event.organizationId).toBe(ORG);
    }
    expect(h.publisher.events.map((e) => e.tenantId)).toEqual([WS_A, WS_B]);
  });

  it('records a service actor, keeping the action attributable', async () => {
    const h = harness([WS_A]);
    h.db.seed(WS_A, LEAVER, 'editor', 'active');
    await h.cascade.revokeAcrossWorkspaces(request);

    expect(h.db.auditRows[0]?.[4]).toBe('service');
    expect(h.db.auditRows[0]?.[3]).toBe('organizations');
  });
});

describe('a failing workspace does not strand the rest', () => {
  it('continues past a failure and reports it', async () => {
    const h = harness([WS_A, WS_B, WS_C]);
    h.db.seed(WS_A, LEAVER, 'editor', 'active');
    h.db.seed(WS_B, LEAVER, 'editor', 'active');
    h.db.seed(WS_C, LEAVER, 'editor', 'active');
    h.db.failWorkspace(WS_B, new Error('connection reset'));

    const result = await h.cascade.revokeAcrossWorkspaces(request);

    expect(result.revoked).toEqual([WS_A, WS_C]);
    expect(result.failed.map((f) => f.workspaceId)).toEqual([WS_B]);
    expect(result.complete).toBe(false);
    expect(h.db.rowFor(WS_B, LEAVER)?.status).toBe('active');
  });

  it('reports the failure through the alerting hook', async () => {
    const db = cluster([WS_A]);
    db.seed(WS_A, LEAVER, 'editor', 'active');
    db.failWorkspace(WS_A, new Error('connection reset'));

    const failures: string[] = [];
    const cascade = createMembershipCascade({
      workspaces: createWorkspaceMembershipService({
        publisher: recordingPublisher(),
        audit: createPersistentAuditWriter({ now: () => NOW, newId: () => EVENT_ID }),
        now: () => NOW,
        newEventId: () => EVENT_ID,
      }),
      runner: db.runner,
      onWorkspaceFailed: (workspaceId) => failures.push(workspaceId),
    });

    const result = await cascade.revokeAcrossWorkspaces(request);
    expect(failures).toEqual([WS_A]);
    expect(result.complete).toBe(false);
  });

  // Retrying after a failure converges: the workspaces already done take the
  // idempotent path and only the failed one is revoked.
  it('converges when retried after a transient failure', async () => {
    const h = harness([WS_A, WS_B]);
    h.db.seed(WS_A, LEAVER, 'editor', 'active');
    h.db.seed(WS_B, LEAVER, 'editor', 'active');
    h.db.failWorkspace(WS_B, new Error('connection reset'));

    const first = await h.cascade.revokeAcrossWorkspaces(request);
    expect(first.complete).toBe(false);

    // The transient failure clears.
    const retry = harness([WS_A, WS_B]);
    retry.db.rows.set(`${WS_A}:${LEAVER}`, {
      ...(h.db.rowFor(WS_A, LEAVER) as Row),
    });
    retry.db.rows.set(`${WS_B}:${LEAVER}`, {
      ...(h.db.rowFor(WS_B, LEAVER) as Row),
    });

    const second = await retry.cascade.revokeAcrossWorkspaces(request);
    expect(second.complete).toBe(true);
    expect(second.revoked).toEqual([WS_B]);
    expect(second.alreadyRevoked).toEqual([WS_A]);
  });
});

describe('an organization with no workspaces', () => {
  it('completes without doing anything', async () => {
    const h = harness([]);
    const result = await h.cascade.revokeAcrossWorkspaces(request);

    expect(result).toMatchObject({
      workspacesVisited: 0,
      revoked: [],
      alreadyRevoked: [],
      notMember: [],
      complete: true,
    });
    expect(h.publisher.events).toHaveLength(0);
  });
});
