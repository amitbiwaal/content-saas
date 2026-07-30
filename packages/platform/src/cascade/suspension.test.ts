/**
 * Organization → workspace suspension cascade.
 *
 * The REAL `WorkspaceService` from Increment B runs against the fake cluster
 * below, so the state machine, the audit chain, the recorded-prior-status
 * lookup and the emitted events are all genuine. The cascade is only being
 * asked to choose which workspaces to drive and to survive the ones that fail.
 *
 * Each workspace gets its own executor, and a workspace's rows are visible only
 * through it — the shape RLS enforces, and the reason the cascade is a
 * per-workspace walk rather than one statement.
 */
import { describe, expect, it } from 'vitest';

import type { DomainEvent, EventPublisher, Transaction } from '@contentos/contracts';
import { createPersistentAuditWriter } from '@contentos/security';

import { createWorkspaceService, type WorkspaceExecutor } from '../workspaces/service.js';
import {
  createSuspensionCascade,
  ORGANIZATION_CASCADE_KEY,
  type OrganizationWorkspace,
  type OrganizationWorkspaceRunner,
  type SuspensionCascade,
  type SuspensionCascadeRequest,
} from './suspension.js';

const ORG = '018f7a1e-0000-7000-8000-0000000000aa';
const OTHER_ORG = '018f7a1e-0000-7000-8000-0000000000ab';
const WS_A = '018f7a1e-0000-7000-8000-0000000000c1';
const WS_B = '018f7a1e-0000-7000-8000-0000000000c2';
const WS_C = '018f7a1e-0000-7000-8000-0000000000c3';
const ACTOR = 'organizations';
const CORRELATION = '018f7a1e-0000-7000-8000-0000000000dd';
const CAUSATION = '018f7a1e-0000-7000-8000-0000000000ef';
const EVENT_ID = '018f7a1e-0000-7000-8000-0000000000ee';
const NOW = new Date('2026-07-30T12:00:00.000Z');

const A_TENANT = 1;
const A_ACTION = 7;
const A_TARGET_ID = 9;
const A_CONTEXT = 13;
const A_HASH = 15;

interface WsRow {
  id: string;
  status: string;
  version: number;
}

interface Cluster {
  readonly runner: OrganizationWorkspaceRunner;
  readonly auditRows: unknown[][];
  status(workspaceId: string): string | undefined;
  seed(workspaceId: string, status: string): void;
  /** Simulate a suspension that this cascade did not cause. */
  seedIndependentSuspension(workspaceId: string): void;
  /** Simulate a suspension caused by a different organization's cascade. */
  seedForeignCascadeSuspension(workspaceId: string): void;
  failWorkspace(workspaceId: string, error: Error): void;
  clearFailures(): void;
  markOf(workspaceId: string): string | null;
}

function cluster(): Cluster {
  const rows = new Map<string, WsRow>();
  const auditRows: unknown[][] = [];
  const failures = new Map<string, Error>();
  let auditSeq = 0;

  function pushAudit(workspaceId: string, action: string, detail: Record<string, string>): void {
    auditSeq += 1;
    const params: unknown[] = new Array<unknown>(16).fill(null);
    params[A_TENANT] = workspaceId;
    params[A_ACTION] = action;
    params[8] = 'workspace';
    params[A_TARGET_ID] = workspaceId;
    params[A_CONTEXT] = JSON.stringify({ stepUpSatisfied: false, detail });
    params[A_HASH] = String(auditSeq).padStart(64, '0');
    auditRows.push(params);
  }

  function executor(workspaceId: string): WorkspaceExecutor {
    return {
      query<T>(q: string, p?: readonly unknown[]): Promise<readonly T[]> {
        const params = [...(p ?? [])];
        const failure = failures.get(workspaceId);
        if (failure !== undefined) return Promise.reject(failure);

        // The cascade's own mark lookup and the workspace service's
        // prior-status lookup both read `context -> 'detail'`; they are told
        // apart by the key each extracts.
        if (q.includes(`'${ORGANIZATION_CASCADE_KEY}'`)) {
          const match = auditRows
            .filter(
              (r) =>
                r[A_TENANT] === params[0] &&
                r[A_TARGET_ID] === params[1] &&
                r[A_ACTION] === params[2],
            )
            .at(-1);
          if (match === undefined) return Promise.resolve([] as readonly T[]);
          const context = JSON.parse(String(match[A_CONTEXT])) as {
            detail?: Record<string, string>;
          };
          return Promise.resolve([
            { cascade_of: context.detail?.[ORGANIZATION_CASCADE_KEY] ?? null },
          ] as readonly T[]);
        }

        if (q.includes("'previousStatus'")) {
          const match = auditRows
            .filter(
              (r) =>
                r[A_TENANT] === params[0] &&
                r[A_TARGET_ID] === params[1] &&
                r[A_ACTION] === params[2],
            )
            .at(-1);
          if (match === undefined) return Promise.resolve([] as readonly T[]);
          const context = JSON.parse(String(match[A_CONTEXT])) as {
            detail?: Record<string, string>;
          };
          return Promise.resolve([
            { previous_status: context.detail?.['previousStatus'] ?? null },
          ] as readonly T[]);
        }

        if (q.includes('FROM workspaces')) {
          const row = rows.get(String(params[0]));
          return Promise.resolve(
            (row === undefined
              ? []
              : [
                  {
                    id: row.id,
                    organization_id: ORG,
                    slug: 'ws',
                    name: 'Workspace',
                    status: row.status,
                    version: row.version,
                  },
                ]) as readonly T[],
          );
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

        if (q.includes('SELECT hash FROM audit_log')) {
          const last = auditRows.filter((r) => r[A_TENANT] === params[0]).at(-1);
          return Promise.resolve(
            (last === undefined ? [] : [{ hash: last[A_HASH] }]) as readonly T[],
          );
        }
        if (q.includes('INSERT INTO audit_log')) {
          auditRows.push(params);
          return Promise.resolve([] as readonly T[]);
        }

        throw new Error(`unexpected statement: ${q}`);
      },
    } as WorkspaceExecutor;
  }

  return {
    runner: {
      listWorkspaces: (): Promise<readonly OrganizationWorkspace[]> =>
        Promise.resolve([...rows.values()].map((r) => ({ workspaceId: r.id, status: r.status }))),
      withWorkspace: (workspaceId, _organizationId, work) => work(executor(workspaceId)),
    },
    auditRows,
    status: (workspaceId) => rows.get(workspaceId)?.status,
    seed(workspaceId, status) {
      rows.set(workspaceId, { id: workspaceId, status, version: 1 });
    },
    seedIndependentSuspension(workspaceId) {
      rows.set(workspaceId, { id: workspaceId, status: 'suspended', version: 2 });
      // A policy suspension: recorded, but carrying no cascade mark.
      pushAudit(workspaceId, 'workspace.suspended', {
        previousStatus: 'active',
        status: 'suspended',
        transition: 'suspend',
      });
    },
    seedForeignCascadeSuspension(workspaceId) {
      rows.set(workspaceId, { id: workspaceId, status: 'suspended', version: 2 });
      pushAudit(workspaceId, 'workspace.suspended', {
        previousStatus: 'active',
        status: 'suspended',
        transition: 'suspend',
        [ORGANIZATION_CASCADE_KEY]: OTHER_ORG,
      });
    },
    failWorkspace(workspaceId, error) {
      failures.set(workspaceId, error);
    },
    clearFailures() {
      failures.clear();
    },
    markOf(workspaceId) {
      const match = auditRows
        .filter((r) => r[A_TENANT] === workspaceId && r[A_ACTION] === 'workspace.suspended')
        .at(-1);
      if (match === undefined) return null;
      const context = JSON.parse(String(match[A_CONTEXT])) as { detail?: Record<string, string> };
      return context.detail?.[ORGANIZATION_CASCADE_KEY] ?? null;
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
  db: Cluster;
  publisher: EventPublisher & { events: DomainEvent<unknown>[] };
  cascade: SuspensionCascade;
  failures: string[];
} {
  const db = cluster();
  const publisher = recordingPublisher();
  const failures: string[] = [];
  const workspaces = createWorkspaceService({
    publisher,
    audit: createPersistentAuditWriter({ now: () => NOW, newId: () => EVENT_ID }),
    now: () => NOW,
    newEventId: () => EVENT_ID,
  });
  return {
    db,
    publisher,
    failures,
    cascade: createSuspensionCascade({
      workspaces,
      runner: db.runner,
      onWorkspaceFailed: (workspaceId) => failures.push(workspaceId),
    }),
  };
}

const request: SuspensionCascadeRequest = {
  organizationId: ORG,
  actor: { id: ACTOR, kind: 'service' },
  correlationId: CORRELATION,
  causationId: CAUSATION,
};

describe('suspension cascade', () => {
  it('suspends every active workspace the organization owns', async () => {
    const h = harness();
    h.db.seed(WS_A, 'active');
    h.db.seed(WS_B, 'active');

    const result = await h.cascade.suspend(request);

    expect(result.applied).toEqual([WS_A, WS_B]);
    expect(result.complete).toBe(true);
    expect(h.db.status(WS_A)).toBe('suspended');
    expect(h.db.status(WS_B)).toBe('suspended');
  });

  // "A workspace archived before an organization suspension stays archived."
  // There is no arrow from `archived` to `suspended`, so the cascade cannot
  // touch it even by accident.
  it('leaves archived and pending_deletion workspaces alone', async () => {
    const h = harness();
    h.db.seed(WS_A, 'active');
    h.db.seed(WS_B, 'archived');
    h.db.seed(WS_C, 'pending_deletion');

    const result = await h.cascade.suspend(request);

    expect(result.applied).toEqual([WS_A]);
    expect(result.skipped).toEqual([
      { workspaceId: WS_B, reason: 'not-applicable' },
      { workspaceId: WS_C, reason: 'not-applicable' },
    ]);
    expect(h.db.status(WS_B)).toBe('archived');
    expect(h.db.status(WS_C)).toBe('pending_deletion');
  });

  it('skips a workspace already suspended, creating no duplicate event', async () => {
    const h = harness();
    h.db.seed(WS_A, 'suspended');

    const result = await h.cascade.suspend(request);
    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual([{ workspaceId: WS_A, reason: 'not-applicable' }]);
    expect(h.publisher.events).toHaveLength(0);
  });

  it('publishes one WorkspaceSuspended per workspace it suspended', async () => {
    const h = harness();
    h.db.seed(WS_A, 'active');
    h.db.seed(WS_B, 'active');

    await h.cascade.suspend(request);

    expect(h.publisher.events).toHaveLength(2);
    for (const event of h.publisher.events) {
      expect(event.eventType).toBe('WorkspaceSuspended');
      expect(event.causationId).toBe(CAUSATION);
      expect(event.correlationId).toBe(CORRELATION);
    }
    expect(h.publisher.events.map((e) => e.tenantId)).toEqual([WS_A, WS_B]);
  });

  // The mark is what lets reactivation tell its own work from a policy action.
  it('marks each suspension as this organization’s cascade', async () => {
    const h = harness();
    h.db.seed(WS_A, 'active');
    await h.cascade.suspend(request);

    expect(h.db.markOf(WS_A)).toBe(ORG);
  });

  it('completes without doing anything for an organization with no workspaces', async () => {
    const h = harness();
    const result = await h.cascade.suspend(request);
    expect(result).toMatchObject({ workspacesVisited: 0, applied: [], complete: true });
    expect(h.publisher.events).toHaveLength(0);
  });
});

describe('reactivation cascade', () => {
  it('restores the workspaces this cascade suspended', async () => {
    const h = harness();
    h.db.seed(WS_A, 'active');
    h.db.seed(WS_B, 'active');
    await h.cascade.suspend(request);

    const result = await h.cascade.reactivate(request);

    expect(result.applied).toEqual([WS_A, WS_B]);
    expect(h.db.status(WS_A)).toBe('active');
    expect(h.db.status(WS_B)).toBe('active');
  });

  // A policy suspension is a different decision and must survive an unrelated
  // organization reactivation. This is what "not blindly active" means.
  it('does NOT lift a suspension it did not cause', async () => {
    const h = harness();
    h.db.seed(WS_A, 'active');
    h.db.seedIndependentSuspension(WS_B);

    await h.cascade.suspend(request);
    const result = await h.cascade.reactivate(request);

    expect(result.applied).toEqual([WS_A]);
    expect(result.skipped).toEqual([{ workspaceId: WS_B, reason: 'suspended-independently' }]);
    expect(h.db.status(WS_B)).toBe('suspended');
  });

  // The mark carries the organization id, so one organization's mark is not
  // authority for another.
  it('does not lift a suspension caused by a different organization', async () => {
    const h = harness();
    h.db.seedForeignCascadeSuspension(WS_A);

    const result = await h.cascade.reactivate(request);
    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual([{ workspaceId: WS_A, reason: 'suspended-independently' }]);
    expect(h.db.status(WS_A)).toBe('suspended');
  });

  it('skips a workspace that is not suspended at all', async () => {
    const h = harness();
    h.db.seed(WS_A, 'active');
    const result = await h.cascade.reactivate(request);
    expect(result.skipped).toEqual([{ workspaceId: WS_A, reason: 'not-applicable' }]);
    expect(h.publisher.events).toHaveLength(0);
  });

  it('publishes one WorkspaceReactivated per restored workspace', async () => {
    const h = harness();
    h.db.seed(WS_A, 'active');
    await h.cascade.suspend(request);
    h.publisher.events.length = 0;

    await h.cascade.reactivate(request);
    expect(h.publisher.events).toHaveLength(1);
    expect(h.publisher.events[0]).toMatchObject({
      eventType: 'WorkspaceReactivated',
      tenantId: WS_A,
      payload: { workspaceId: WS_A, previousStatus: 'suspended' },
    });
  });
});

describe('a full suspend and reactivate cycle', () => {
  // The headline property: every workspace ends where it started.
  it('returns every workspace to the state it held before the suspension', async () => {
    const h = harness();
    h.db.seed(WS_A, 'active');
    h.db.seed(WS_B, 'archived');
    h.db.seedIndependentSuspension(WS_C);

    await h.cascade.suspend(request);
    expect(h.db.status(WS_A)).toBe('suspended');
    expect(h.db.status(WS_B)).toBe('archived');
    expect(h.db.status(WS_C)).toBe('suspended');

    await h.cascade.reactivate(request);
    expect(h.db.status(WS_A)).toBe('active');
    expect(h.db.status(WS_B)).toBe('archived');
    expect(h.db.status(WS_C)).toBe('suspended');
  });
});

describe('idempotence and retry safety', () => {
  it('does nothing on a second suspend run', async () => {
    const h = harness();
    h.db.seed(WS_A, 'active');
    h.db.seed(WS_B, 'active');

    const first = await h.cascade.suspend(request);
    const second = await h.cascade.suspend(request);

    expect(first.applied).toEqual([WS_A, WS_B]);
    expect(second.applied).toEqual([]);
    expect(second.skipped.map((s) => s.reason)).toEqual(['not-applicable', 'not-applicable']);
    expect(second.complete).toBe(true);
    // NO DUPLICATE EVENTS.
    expect(h.publisher.events).toHaveLength(2);
  });

  it('does nothing on a second reactivate run', async () => {
    const h = harness();
    h.db.seed(WS_A, 'active');
    await h.cascade.suspend(request);
    await h.cascade.reactivate(request);
    const again = await h.cascade.reactivate(request);

    expect(again.applied).toEqual([]);
    expect(again.complete).toBe(true);
    // suspend + reactivate, and nothing more.
    expect(h.publisher.events).toHaveLength(2);
  });

  it('tolerates a partial failure and reports it', async () => {
    const h = harness();
    h.db.seed(WS_A, 'active');
    h.db.seed(WS_B, 'active');
    h.db.seed(WS_C, 'active');
    h.db.failWorkspace(WS_B, new Error('connection reset'));

    const result = await h.cascade.suspend(request);

    expect(result.applied).toEqual([WS_A, WS_C]);
    expect(result.failed.map((f) => f.workspaceId)).toEqual([WS_B]);
    expect(result.complete).toBe(false);
    expect(h.failures).toEqual([WS_B]);
    expect(h.db.status(WS_B)).toBe('active');
  });

  // Converge under retry: the workspaces already done take the skip path and
  // only the one that failed is acted on.
  it('converges when retried after a transient failure', async () => {
    const h = harness();
    h.db.seed(WS_A, 'active');
    h.db.seed(WS_B, 'active');
    h.db.failWorkspace(WS_B, new Error('connection reset'));

    const first = await h.cascade.suspend(request);
    expect(first.complete).toBe(false);

    h.db.clearFailures();
    const second = await h.cascade.suspend(request);

    expect(second.applied).toEqual([WS_B]);
    expect(second.skipped).toEqual([{ workspaceId: WS_A, reason: 'not-applicable' }]);
    expect(second.complete).toBe(true);
    expect(h.db.status(WS_A)).toBe('suspended');
    expect(h.db.status(WS_B)).toBe('suspended');
    // One event per workspace across both runs.
    expect(h.publisher.events).toHaveLength(2);
  });

  it('a failed workspace publishes nothing, so a retry cannot duplicate', async () => {
    const h = harness();
    h.db.seed(WS_A, 'active');
    h.db.failWorkspace(WS_A, new Error('audit_log unavailable'));

    const result = await h.cascade.suspend(request);
    expect(result.failed).toHaveLength(1);
    expect(h.publisher.events).toHaveLength(0);
  });
});

describe('concurrency', () => {
  // Two cascade runs overlapping — a redelivery of the same event, say. The
  // workspace's version predicate serialises them and the loser is reported as
  // retryable rather than silently applied twice.
  it('never suspends the same workspace twice when two runs overlap', async () => {
    const h = harness();
    h.db.seed(WS_A, 'active');
    h.db.seed(WS_B, 'active');

    const [first, second] = await Promise.all([
      h.cascade.suspend(request),
      h.cascade.suspend(request),
    ]);

    const appliedTotal = first.applied.length + second.applied.length;
    expect(appliedTotal).toBe(2);
    expect(h.publisher.events).toHaveLength(2);
    expect(h.db.status(WS_A)).toBe('suspended');
    expect(h.db.status(WS_B)).toBe('suspended');
  });

  it('converges after an overlapping run reported a conflict', async () => {
    const h = harness();
    h.db.seed(WS_A, 'active');

    await Promise.all([h.cascade.suspend(request), h.cascade.suspend(request)]);
    const settled = await h.cascade.suspend(request);

    expect(settled.applied).toEqual([]);
    expect(settled.complete).toBe(true);
    expect(h.publisher.events).toHaveLength(1);
    expect(h.db.status(WS_A)).toBe('suspended');
  });
});
