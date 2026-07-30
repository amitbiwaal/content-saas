/**
 * Workspace settings updates and their append-only history.
 *
 * Settings values are given deliberately distinctive strings, so "the event
 * carries keys, never values" can be asserted by searching the serialized
 * payload for them rather than by inspecting the shape and hoping.
 */
import { describe, expect, it } from 'vitest';

import type { DomainEvent, EventPublisher, Transaction } from '@contentos/contracts';
import { createPersistentAuditWriter } from '@contentos/security';

import { DEFAULT_WORKSPACE_SETTINGS } from '../workspaces/settings.js';
import {
  createWorkspaceSettingsService,
  SETTINGS_WRITABLE_STATUSES,
  WORKSPACE_SETTINGS_AUDIT_ACTION,
  WorkspaceSettingsError,
  type SettingsExecutor,
  type UpdateWorkspaceSettingsCommand,
  type WorkspaceSettingsService,
} from './workspace-settings.js';

const ORG = '018f7a1e-0000-7000-8000-0000000000aa';
const WS = '018f7a1e-0000-7000-8000-0000000000c1';
const ADMIN = '018f7a1e-0000-7000-8000-000000000001';
const EDITOR = '018f7a1e-0000-7000-8000-000000000002';
const OUTSIDER = '018f7a1e-0000-7000-8000-000000000009';
const CORRELATION = '018f7a1e-0000-7000-8000-0000000000dd';
const EVENT_ID = '018f7a1e-0000-7000-8000-0000000000ee';
const NOW = new Date('2026-07-30T12:00:00.000Z');

/** Distinctive enough that its presence anywhere is unambiguous. */
const VOICE = 'voice-profile-alpha-7731';
const LOCALE = 'en-GB-9924';

const A_TENANT = 1;
const A_ORG = 2;
const A_ACTION = 7;
const A_TARGET_KIND = 8;
const A_CONTEXT = 13;

interface HistoryRow {
  readonly tenantId: string;
  readonly organizationId: string;
  readonly changedKeys: readonly string[];
  readonly before: Record<string, unknown>;
  readonly after: Record<string, unknown>;
  readonly changedBy: string;
}

interface Db {
  readonly tx: SettingsExecutor;
  readonly sql: string[];
  readonly history: HistoryRow[];
  readonly auditRows: unknown[][];
  settings(): Record<string, unknown>;
  version(): number;
  setStatus(status: string): void;
  setMember(userId: string, role: string, status: string): void;
  bumpVersion(): void;
  failOn(needle: string, error: Error): void;
  auditContext(index: number): { detail?: Record<string, string> };
}

function db(): Db {
  const workspace = {
    id: WS,
    organization_id: ORG,
    status: 'active',
    settings: JSON.stringify(DEFAULT_WORKSPACE_SETTINGS),
    version: 1,
  };
  const members = new Map<string, { role: string; status: string }>([
    [ADMIN, { role: 'workspace_admin', status: 'active' }],
  ]);
  const history: HistoryRow[] = [];
  const auditRows: unknown[][] = [];
  const sql: string[] = [];
  const failures: { needle: string; error: Error }[] = [];
  let historySeq = 0;

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

      if (q.includes('FROM workspace_memberships')) {
        const member = members.get(String(params[1]));
        return Promise.resolve((member === undefined ? [] : [{ ...member }]) as readonly T[]);
      }
      if (q.includes('FROM workspaces')) {
        return Promise.resolve(
          (String(params[0]) === WS ? [{ ...workspace }] : []) as readonly T[],
        );
      }
      if (q.includes('UPDATE workspaces')) {
        if (workspace.version !== params[3]) return Promise.resolve([] as readonly T[]);
        workspace.settings = String(params[0]);
        workspace.version += 1;
        return Promise.resolve([{ version: workspace.version }] as readonly T[]);
      }
      if (q.includes('INSERT INTO workspace_settings_history')) {
        historySeq += 1;
        history.push({
          tenantId: String(params[0]),
          organizationId: String(params[1]),
          changedKeys: params[2] as string[],
          before: JSON.parse(String(params[3])) as Record<string, unknown>,
          after: JSON.parse(String(params[4])) as Record<string, unknown>,
          changedBy: String(params[5]),
        });
        return Promise.resolve([
          { id: `018f7a1e-0000-7000-8000-00000000f${String(historySeq).padStart(3, '0')}` },
        ] as readonly T[]);
      }
      if (q.includes('SELECT hash FROM audit_log')) {
        const last = auditRows.at(-1);
        return Promise.resolve((last === undefined ? [] : [{ hash: last[15] }]) as readonly T[]);
      }
      if (q.includes('INSERT INTO audit_log')) {
        auditRows.push(params);
        return Promise.resolve([] as readonly T[]);
      }
      throw new Error(`fake db received an unexpected statement: ${q}`);
    },
  } as SettingsExecutor;

  return {
    tx,
    sql,
    history,
    auditRows,
    settings: () => JSON.parse(workspace.settings) as Record<string, unknown>,
    version: () => workspace.version,
    setStatus: (status) => {
      workspace.status = status;
    },
    setMember: (userId, role, status) => {
      members.set(userId, { role, status });
    },
    bumpVersion: () => {
      workspace.version += 1;
    },
    failOn: (needle, error) => {
      failures.push({ needle, error });
    },
    auditContext: (index) =>
      JSON.parse(String(auditRows[index]?.[A_CONTEXT])) as { detail?: Record<string, string> },
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
  db: Db;
  publisher: EventPublisher & { events: DomainEvent<unknown>[] };
  service: WorkspaceSettingsService;
} {
  const database = db();
  const publisher = recordingPublisher();
  const service = createWorkspaceSettingsService({
    publisher,
    audit: createPersistentAuditWriter({ now: () => NOW, newId: () => EVENT_ID }),
    now: () => NOW,
    newEventId: () => EVENT_ID,
  });
  return { db: database, publisher, service };
}

function command(
  over: Partial<UpdateWorkspaceSettingsCommand> = {},
): UpdateWorkspaceSettingsCommand {
  return {
    workspaceId: WS,
    organizationId: ORG,
    patch: { brandVoice: VOICE },
    actor: { id: ADMIN, kind: 'user' },
    correlationId: CORRELATION,
    ...over,
  };
}

describe('settings update', () => {
  it('stores the patched layer and bumps the version', async () => {
    const h = harness();
    const result = await h.service.update(h.db.tx, command());

    expect(result.changed).toBe(true);
    expect(result.version).toBe(2);
    expect(h.db.settings()['brandVoice']).toBe(VOICE);
    expect(h.db.version()).toBe(2);
  });

  it('leaves keys the patch omits untouched', async () => {
    const h = harness();
    await h.service.update(h.db.tx, command({ patch: { locale: LOCALE } }));

    const stored = h.db.settings();
    expect(stored['locale']).toBe(LOCALE);
    expect(stored['brandVoice']).toBeNull();
    expect(stored['gateThresholds']).toEqual({});
    expect(Object.keys(stored).sort()).toEqual(Object.keys(DEFAULT_WORKSPACE_SETTINGS).sort());
  });

  it('reports exactly the keys that changed', async () => {
    const h = harness();
    const result = await h.service.update(
      h.db.tx,
      command({ patch: { brandVoice: VOICE, locale: LOCALE } }),
    );
    expect([...result.changedKeys].sort()).toEqual(['brandVoice', 'locale']);
  });

  it('writes everything on one handle and issues no COMMIT', async () => {
    const h = harness();
    await h.service.update(h.db.tx, command());
    for (const statement of h.db.sql) {
      expect(statement).not.toMatch(/\b(COMMIT|ROLLBACK|BEGIN)\b/);
    }
    expect(h.db.history).toHaveLength(1);
    expect(h.db.auditRows).toHaveLength(1);
    expect(h.publisher.events).toHaveLength(1);
  });

  it('answers an unknown workspace as absent', async () => {
    const h = harness();
    await expect(
      h.service.update(h.db.tx, command({ workspaceId: '018f7a1e-0000-7000-8000-00000000ffff' })),
    ).rejects.toMatchObject({ code: 'WorkspaceNotFound' });
  });
});

describe('unchanged values are ignored', () => {
  // The CHECK constraint would refuse a history row with no keys; a no-op edit
  // is not an entry in the history.
  it('is a complete no-op when the patch changes nothing', async () => {
    const h = harness();
    const result = await h.service.update(
      h.db.tx,
      command({ patch: { brandVoice: null, gateThresholds: {} } }),
    );

    expect(result.changed).toBe(false);
    expect(result.changedKeys).toEqual([]);
    expect(result.historyId).toBeNull();
    expect(result.event).toBeNull();
    expect(h.db.history).toHaveLength(0);
    expect(h.db.auditRows).toHaveLength(0);
    expect(h.publisher.events).toHaveLength(0);
    expect(h.db.version()).toBe(1);
  });

  it('is a no-op when re-applying a value already stored', async () => {
    const h = harness();
    await h.service.update(h.db.tx, command());
    const second = await h.service.update(h.db.tx, command());

    expect(second.changed).toBe(false);
    expect(h.db.history).toHaveLength(1);
    expect(h.publisher.events).toHaveLength(1);
  });

  it('records only the changed key when a patch touches several but alters one', async () => {
    const h = harness();
    await h.service.update(h.db.tx, command({ patch: { brandVoice: VOICE } }));

    const result = await h.service.update(
      h.db.tx,
      command({ patch: { brandVoice: VOICE, locale: LOCALE } }),
    );
    expect(result.changedKeys).toEqual(['locale']);
    expect(h.db.history[1]?.changedKeys).toEqual(['locale']);
  });
});

describe('append-only settings history', () => {
  it('records the change with before and after', async () => {
    const h = harness();
    await h.service.update(h.db.tx, command());

    expect(h.db.history).toHaveLength(1);
    expect(h.db.history[0]).toMatchObject({
      tenantId: WS,
      organizationId: ORG,
      changedKeys: ['brandVoice'],
      before: { brandVoice: null },
      after: { brandVoice: VOICE },
      changedBy: ADMIN,
    });
  });

  // Never store unchanged values: an untouched setting is not copied forward
  // into every subsequent history row.
  it('carries ONLY the changed keys in before and after', async () => {
    const h = harness();
    await h.service.update(h.db.tx, command({ patch: { locale: LOCALE } }));

    const entry = h.db.history[0];
    expect(Object.keys(entry?.before ?? {})).toEqual(['locale']);
    expect(Object.keys(entry?.after ?? {})).toEqual(['locale']);
    expect(JSON.stringify(entry)).not.toContain('gateThresholds');
  });

  it('appends rather than amending — one row per change', async () => {
    const h = harness();
    await h.service.update(h.db.tx, command({ patch: { brandVoice: VOICE } }));
    await h.service.update(h.db.tx, command({ patch: { locale: LOCALE } }));

    expect(h.db.history).toHaveLength(2);
    expect(h.db.history[0]?.changedKeys).toEqual(['brandVoice']);
    expect(h.db.history[1]?.changedKeys).toEqual(['locale']);
  });

  // UPDATE and DELETE are revoked on this table at the role level; no code
  // path here could issue one.
  it('never updates or deletes a history row', async () => {
    const h = harness();
    await h.service.update(h.db.tx, command());
    await h.service.update(h.db.tx, command({ patch: { locale: LOCALE } }));

    for (const statement of h.db.sql) {
      if (statement.includes('workspace_settings_history')) {
        expect(statement).toContain('INSERT INTO');
        expect(statement).not.toMatch(/\b(UPDATE|DELETE)\b/);
      }
    }
  });

  it('always names at least one changed key, as the CHECK constraint requires', async () => {
    const h = harness();
    await h.service.update(h.db.tx, command());
    for (const entry of h.db.history) {
      expect(entry.changedKeys.length).toBeGreaterThan(0);
    }
  });
});

describe('audit generation', () => {
  it('records the change against the workspace as tenant', async () => {
    const h = harness();
    await h.service.update(h.db.tx, command());

    const row = h.db.auditRows[0];
    expect(row?.[A_ACTION]).toBe(WORKSPACE_SETTINGS_AUDIT_ACTION);
    expect(row?.[A_TENANT]).toBe(WS);
    expect(row?.[A_ORG]).toBe(ORG);
    expect(row?.[A_TARGET_KIND]).toBe('workspace_settings');
  });

  it('names the changed keys and points at the history entry', async () => {
    const h = harness();
    const result = await h.service.update(
      h.db.tx,
      command({ patch: { brandVoice: VOICE, locale: LOCALE } }),
    );

    expect(h.db.auditContext(0).detail).toMatchObject({
      changedKeys: 'brandVoice,locale',
      settingsHistoryId: result.historyId ?? '',
    });
  });

  // The audit trail is read far more widely than the settings row; the values
  // live in the history entry, under the same RLS as the settings themselves.
  it('records no setting values in the audit trail', async () => {
    const h = harness();
    await h.service.update(h.db.tx, command({ patch: { brandVoice: VOICE, locale: LOCALE } }));

    const serialized = JSON.stringify(h.db.auditRows[0]);
    expect(serialized).not.toContain(VOICE);
    expect(serialized).not.toContain(LOCALE);
  });
});

describe('outbox generation — keys only, never values', () => {
  it('publishes WorkspaceSettingsUpdated with the documented payload', async () => {
    const h = harness();
    await h.service.update(h.db.tx, command({ patch: { brandVoice: VOICE, locale: LOCALE } }));

    expect(h.publisher.events[0]).toMatchObject({
      eventType: 'WorkspaceSettingsUpdated',
      aggregateType: 'Workspace',
      aggregateId: WS,
      tenantId: WS,
      organizationId: ORG,
      producer: 'platform.workspaces',
      payload: { workspaceId: WS, changedBy: ADMIN },
    });
    const payload = h.publisher.events[0]?.payload as { changedKeys: string[] };
    expect([...payload.changedKeys].sort()).toEqual(['brandVoice', 'locale']);
  });

  // Settings can include competitively sensitive configuration, and an event
  // reaches consumers with weaker controls than the row does.
  it('carries no setting value in the payload', async () => {
    const h = harness();
    await h.service.update(h.db.tx, command({ patch: { brandVoice: VOICE, locale: LOCALE } }));

    const serialized = JSON.stringify(h.publisher.events[0]?.payload);
    expect(serialized).not.toContain(VOICE);
    expect(serialized).not.toContain(LOCALE);
    expect(serialized).toContain('brandVoice');
    expect(serialized).toContain('locale');
  });

  it('carries a causation id when the change reacted to another event', async () => {
    const h = harness();
    const causation = '018f7a1e-0000-7000-8000-0000000000cc';
    await h.service.update(h.db.tx, command({ causationId: causation }));
    expect(h.publisher.events[0]?.causationId).toBe(causation);
  });
});

describe('who may change settings', () => {
  // Rule 15, expressed through the existing permission catalogue rather than a
  // second list of roles.
  it('refuses a role without workspace:update', async () => {
    const h = harness();
    h.db.setMember(EDITOR, 'editor', 'active');

    const rejected = h.service.update(h.db.tx, command({ actor: { id: EDITOR, kind: 'user' } }));
    await expect(rejected).rejects.toBeInstanceOf(WorkspaceSettingsError);
    await expect(rejected).rejects.toMatchObject({ code: 'NotPermitted' });
    expect(h.db.history).toHaveLength(0);
  });

  it('refuses an actor who is not an active member', async () => {
    const h = harness();
    await expect(
      h.service.update(h.db.tx, command({ actor: { id: OUTSIDER, kind: 'user' } })),
    ).rejects.toMatchObject({ code: 'ActorNotMember' });
  });

  it('refuses a member whose membership is only invited', async () => {
    const h = harness();
    h.db.setMember(OUTSIDER, 'workspace_admin', 'invited');
    await expect(
      h.service.update(h.db.tx, command({ actor: { id: OUTSIDER, kind: 'user' } })),
    ).rejects.toMatchObject({ code: 'ActorNotMember' });
  });

  it('does not require a membership of a service actor', async () => {
    const h = harness();
    const result = await h.service.update(
      h.db.tx,
      command({ actor: { id: 'settings-sync', kind: 'service' } }),
    );
    expect(result.changed).toBe(true);
  });
});

describe('which statuses accept a settings change', () => {
  it('accepts active and suspended', async () => {
    expect([...SETTINGS_WRITABLE_STATUSES]).toEqual(['active', 'suspended']);

    for (const status of SETTINGS_WRITABLE_STATUSES) {
      const h = harness();
      h.db.setStatus(status);
      const result = await h.service.update(h.db.tx, command());
      expect(result.changed, status).toBe(true);
    }
  });

  // archived is read-only permanently; pending_deletion is a read-only window.
  it('refuses archived and pending_deletion', async () => {
    for (const status of ['archived', 'pending_deletion']) {
      const h = harness();
      h.db.setStatus(status);
      await expect(h.service.update(h.db.tx, command())).rejects.toMatchObject({
        code: 'SettingsNotWritable',
      });
      expect(h.db.history).toHaveLength(0);
    }
  });

  it('refuses a workspace holding an unknown status', async () => {
    const h = harness();
    h.db.setStatus('nonsense');
    await expect(h.service.update(h.db.tx, command())).rejects.toMatchObject({
      code: 'SettingsNotWritable',
    });
  });
});

describe('concurrency', () => {
  // Concurrent settings edits fail the loser rather than silently overwriting.
  it('refuses a stale expected version', async () => {
    const h = harness();
    await expect(h.service.update(h.db.tx, command({ expectedVersion: 99 }))).rejects.toMatchObject(
      { code: 'ConcurrentModification' },
    );
    expect(h.db.history).toHaveLength(0);
    expect(h.publisher.events).toHaveLength(0);
  });

  it('refuses when another writer commits between the read and the update', async () => {
    const h = harness();
    const service = createWorkspaceSettingsService({
      publisher: h.publisher,
      audit: createPersistentAuditWriter({ now: () => NOW, newId: () => EVENT_ID }),
      now: () => NOW,
      newEventId: () => EVENT_ID,
    });

    // A competing edit lands after this one read the row.
    const tx = {
      query<T>(q: string, p?: readonly unknown[]): Promise<readonly T[]> {
        const result = h.db.tx.query<T>(q, p);
        if (q.includes('FROM workspaces')) h.db.bumpVersion();
        return result;
      },
    } as SettingsExecutor;

    await expect(service.update(tx, command())).rejects.toMatchObject({
      code: 'ConcurrentModification',
    });
  });
});

describe('rollback', () => {
  const FAILURES: readonly (readonly [string, string])[] = [
    ['settings write', 'UPDATE workspaces'],
    ['history', 'INSERT INTO workspace_settings_history'],
    ['audit', 'INSERT INTO audit_log'],
  ];

  for (const [label, needle] of FAILURES) {
    it(`propagates a ${label} failure and publishes nothing`, async () => {
      const h = harness();
      h.db.failOn(needle, new Error('deadlock detected'));

      await expect(h.service.update(h.db.tx, command())).rejects.toThrow('deadlock detected');
      expect(h.publisher.events).toHaveLength(0);
    });
  }

  it('propagates a publish failure so the settings write rolls back with it', async () => {
    const database = db();
    const service = createWorkspaceSettingsService({
      publisher: { publish: (): Promise<void> => Promise.reject(new Error('UnknownEventType')) },
      audit: createPersistentAuditWriter({ now: () => NOW, newId: () => EVENT_ID }),
      now: () => NOW,
      newEventId: () => EVENT_ID,
    });

    await expect(service.update(database.tx, command())).rejects.toThrow('UnknownEventType');
  });
});
