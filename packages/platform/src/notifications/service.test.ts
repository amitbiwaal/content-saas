/**
 * The Notification Service.
 *
 * The fake below enforces the two database rules the correctness turns on:
 * `UNIQUE (tenant_id, dedupe_key)` with `ON CONFLICT DO NOTHING`, and the
 * `status = 'pending'` predicate that makes both marks idempotent. A fake that
 * accepted every write would let this pass while notifying twice.
 *
 * Immutability itself is NOT asserted here. It is a column-level GRANT against
 * a real server (migration 0024), and a data structure cannot refuse a
 * privilege it was never given — CI step 5f asserts it against PostgreSQL 17.
 */
import { describe, expect, it } from 'vitest';

import type { Transaction } from '@contentos/contracts';
import type { AuditWriter, NewAuditRecord } from '@contentos/security';

import { createNotificationRegistry, NotificationError } from './registry.js';
import {
  createNotificationService,
  MAX_NOTIFICATION_PAGE,
  NOTIFICATION_AUDIT_ACTIONS,
  type CreateNotificationCommand,
  type NotificationExecutor,
  type NotificationService,
} from './service.js';

const ORG = '018f7a1e-0000-7000-8000-0000000000aa';
const WS = '018f7a1e-0000-7000-8000-0000000000bb';
const WS2 = '018f7a1e-0000-7000-8000-0000000000cc';
const ACTOR = '018f7a1e-0000-7000-8000-000000000001';
const CORRELATION = '018f7a1e-0000-7000-8000-0000000000dd';
const NOW = new Date('2026-07-30T12:00:00.000Z');

interface Row {
  id: string;
  tenantId: string;
  organizationId: string;
  workspaceId: string | null;
  type: string;
  payload: Record<string, unknown>;
  status: string;
  dedupeKey: string;
  correlationId: string;
  createdAt: string;
  deliveredAt: string | null;
  failedAt: string | null;
  failureReason: string | null;
}

interface Rig {
  readonly tx: NotificationExecutor;
  readonly service: NotificationService;
  readonly rows: Row[];
  readonly audits: NewAuditRecord[];
}

function rig(): Rig {
  const rows: Row[] = [];
  const audits: NewAuditRecord[] = [];
  let seq = 0;

  const tx = {
    query<T>(sql: string, params?: readonly unknown[]): Promise<readonly T[]> {
      const p = [...(params ?? [])] as (string | number | null)[];
      const tenant = String(p[0] ?? '');

      if (sql.includes('INSERT INTO notifications')) {
        const dedupeKey = String(p[5]);
        // The unique index.
        if (rows.some((r) => r.tenantId === tenant && r.dedupeKey === dedupeKey)) {
          return Promise.resolve([]); // ON CONFLICT DO NOTHING
        }
        seq += 1;
        const row: Row = {
          id: `018f7a1e-0000-7000-8000-${String(seq).padStart(12, '0')}`,
          tenantId: tenant,
          organizationId: String(p[1]),
          workspaceId: (p[2] as string | null) ?? null,
          type: String(p[3]),
          payload: JSON.parse(String(p[4])) as Record<string, unknown>,
          status: 'pending',
          dedupeKey,
          correlationId: String(p[6]),
          createdAt: new Date(NOW.getTime() + seq * 1000).toISOString(),
          deliveredAt: null,
          failedAt: null,
          failureReason: null,
        };
        rows.push(row);
        return Promise.resolve([row] as unknown as T[]);
      }

      if (sql.includes("SET status = 'delivered'")) {
        // The guarded transition: matches nothing once terminal.
        const row = rows.find(
          (r) => r.tenantId === tenant && r.id === p[1] && r.status === 'pending',
        );
        if (row === undefined) return Promise.resolve([]);
        row.status = 'delivered';
        row.deliveredAt = NOW.toISOString();
        return Promise.resolve([row] as unknown as T[]);
      }

      if (sql.includes("SET status = 'failed'")) {
        const row = rows.find(
          (r) => r.tenantId === tenant && r.id === p[1] && r.status === 'pending',
        );
        if (row === undefined) return Promise.resolve([]);
        row.status = 'failed';
        row.failedAt = NOW.toISOString();
        row.failureReason = String(p[2]);
        return Promise.resolve([row] as unknown as T[]);
      }

      if (sql.includes('dedupe_key = $2')) {
        return Promise.resolve(
          rows.filter((r) => r.tenantId === tenant && r.dedupeKey === p[1]) as unknown as T[],
        );
      }

      if (sql.includes('AND id = $2')) {
        return Promise.resolve(
          rows.filter((r) => r.tenantId === tenant && r.id === p[1]) as unknown as T[],
        );
      }

      if (sql.includes('ORDER BY created_at DESC')) {
        const [, workspaceId, status, cursorAt, cursorId, limit] = p as unknown as [
          string,
          string | null,
          string | null,
          string | null,
          string | null,
          number,
        ];
        const page = rows
          .filter((r) => r.tenantId === tenant)
          .filter((r) => workspaceId === null || r.workspaceId === workspaceId)
          .filter((r) => status === null || r.status === status)
          .filter(
            (r) =>
              cursorAt === null ||
              r.createdAt < cursorAt ||
              (r.createdAt === cursorAt && r.id < (cursorId ?? '')),
          )
          .sort((a, b) => (b.createdAt + b.id).localeCompare(a.createdAt + a.id))
          .slice(0, limit);
        return Promise.resolve(page as unknown as T[]);
      }

      throw new Error(`unexpected SQL: ${sql}`);
    },
  } as unknown as NotificationExecutor;

  const audit: AuditWriter = {
    record(_tx: Transaction, entry: NewAuditRecord): Promise<string> {
      audits.push(entry);
      return Promise.resolve('audit-id');
    },
  };

  return {
    tx,
    rows,
    audits,
    service: createNotificationService({ registry: createNotificationRegistry(), audit }),
  };
}

function create(over: Partial<CreateNotificationCommand> = {}): CreateNotificationCommand {
  return {
    organizationId: ORG,
    type: 'billing.credits_low',
    dedupeKey: 'billing.credits_low:event-1',
    correlationId: CORRELATION,
    ...over,
  };
}

describe('create records a notification', () => {
  it('persists it as pending', async () => {
    const r = rig();
    const result = await r.service.create(r.tx, create());

    expect(result.created).toBe(true);
    expect(result.notification).toMatchObject({
      tenantId: ORG,
      organizationId: ORG,
      workspaceId: null,
      type: 'billing.credits_low',
      status: 'pending',
      deliveredAt: null,
      failedAt: null,
    });
  });

  it('carries the payload through', async () => {
    const r = rig();
    const result = await r.service.create(
      r.tx,
      create({ payload: { organizationId: ORG, previousState: 'ok' } }),
    );
    expect(result.notification.payload).toEqual({ organizationId: ORG, previousState: 'ok' });
  });

  it('accepts an optional workspace', async () => {
    const r = rig();
    const result = await r.service.create(r.tx, create({ workspaceId: WS }));
    expect(result.notification.workspaceId).toBe(WS);
  });

  // The type must be declared: a notification nobody can explain is one nobody
  // can render, route, or decide a preference for.
  it('refuses an undeclared type', async () => {
    const r = rig();
    await expect(r.service.create(r.tx, create({ type: 'nope.nothing' }))).rejects.toThrow(
      NotificationError,
    );
    expect(r.rows).toHaveLength(0);
  });

  it('refuses an empty dedupe key', async () => {
    const r = rig();
    await expect(r.service.create(r.tx, create({ dedupeKey: '  ' }))).rejects.toThrow(
      /redelivered event produces a second copy/,
    );
  });
});

describe('creation is idempotent', () => {
  it('converges on the existing record for a repeated key', async () => {
    const r = rig();
    const first = await r.service.create(r.tx, create());
    const second = await r.service.create(r.tx, create());

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.notification.id).toBe(first.notification.id);
    expect(r.rows).toHaveLength(1);
  });

  // The retry's payload is discarded: the winner is the record.
  it('does not rewrite the record on convergence', async () => {
    const r = rig();
    await r.service.create(r.tx, create({ payload: { previousState: 'ok' } }));
    const retry = await r.service.create(r.tx, create({ payload: { previousState: 'low' } }));
    expect(retry.notification.payload).toEqual({ previousState: 'ok' });
  });

  it('ten redeliveries produce one notification', async () => {
    const r = rig();
    for (let i = 0; i < 10; i += 1) await r.service.create(r.tx, create());
    expect(r.rows).toHaveLength(1);
  });

  it('scopes the key to the tenant', async () => {
    const r = rig();
    const OTHER_ORG = '018f7a1e-0000-7000-8000-0000000000a9';
    await r.service.create(r.tx, create());
    const other = await r.service.create(r.tx, create({ organizationId: OTHER_ORG }));
    expect(other.created).toBe(true);
    expect(r.rows).toHaveLength(2);
  });

  it('treats a different type from one event as a different notification', async () => {
    const r = rig();
    await r.service.create(r.tx, create({ dedupeKey: 'billing.credits_low:event-1' }));
    const second = await r.service.create(
      r.tx,
      create({ type: 'billing.credits_exhausted', dedupeKey: 'billing.credits_exhausted:event-1' }),
    );
    expect(second.created).toBe(true);
    expect(r.rows).toHaveLength(2);
  });
});

describe('markDelivered', () => {
  const deliver = (id: string) => ({
    organizationId: ORG,
    notificationId: id,
    channel: 'in_app' as const,
  });

  it('moves a pending notification to delivered', async () => {
    const r = rig();
    const created = await r.service.create(r.tx, create());
    const result = await r.service.markDelivered(r.tx, deliver(created.notification.id));

    expect(result.converged).toBe(false);
    expect(result.notification.status).toBe('delivered');
    expect(result.notification.deliveredAt).toBe(NOW.toISOString());
  });

  it('is idempotent — a repeated callback converges', async () => {
    const r = rig();
    const created = await r.service.create(r.tx, create());
    await r.service.markDelivered(r.tx, deliver(created.notification.id));
    const retry = await r.service.markDelivered(r.tx, deliver(created.notification.id));

    expect(retry.converged).toBe(true);
    expect(retry.notification.status).toBe('delivered');
  });

  it('refuses a notification that does not exist', async () => {
    const r = rig();
    await expect(
      r.service.markDelivered(r.tx, deliver('018f7a1e-0000-7000-8000-00000000ffff')),
    ).rejects.toThrow(/does not exist/);
  });

  // Overwriting a recorded failure with a late delivery would erase the
  // evidence of the failure.
  it('does not overwrite a recorded failure', async () => {
    const r = rig();
    const created = await r.service.create(r.tx, create());
    await r.service.markFailed(r.tx, {
      organizationId: ORG,
      notificationId: created.notification.id,
      channel: 'email',
      reason: 'mailbox full',
      actor: { id: ACTOR, kind: 'service' },
      correlationId: CORRELATION,
    });

    const late = await r.service.markDelivered(r.tx, deliver(created.notification.id));
    expect(late.converged).toBe(true);
    expect(late.notification.status).toBe('failed');
    expect(late.notification.failureReason).toBe('mailbox full');
  });

  it('does not audit a success', async () => {
    const r = rig();
    const created = await r.service.create(r.tx, create());
    await r.service.markDelivered(r.tx, deliver(created.notification.id));
    expect(r.audits).toHaveLength(0);
  });
});

describe('markFailed', () => {
  const fail = (id: string, over: Record<string, unknown> = {}) => ({
    organizationId: ORG,
    notificationId: id,
    channel: 'email' as const,
    reason: 'hard bounce',
    actor: { id: ACTOR, kind: 'service' as const },
    correlationId: CORRELATION,
    ...over,
  });

  it('moves a pending notification to failed, with its reason', async () => {
    const r = rig();
    const created = await r.service.create(r.tx, create());
    const result = await r.service.markFailed(r.tx, fail(created.notification.id));

    expect(result.notification.status).toBe('failed');
    expect(result.notification.failedAt).toBe(NOW.toISOString());
    expect(result.notification.failureReason).toBe('hard bounce');
  });

  // "Delivery records are audit evidence for 'were they told?'" — and an
  // undelivered MANDATORY class is exactly what someone will reconstruct.
  it('audits the failure, recording the class and whether it was mandatory', async () => {
    const r = rig();
    const created = await r.service.create(r.tx, create());
    await r.service.markFailed(r.tx, fail(created.notification.id));

    expect(r.audits).toHaveLength(1);
    expect(r.audits[0]).toMatchObject({
      action: NOTIFICATION_AUDIT_ACTIONS.delivery_failed,
      tenantId: ORG,
      organizationId: ORG,
      result: 'failure',
      reason: 'hard bounce',
    });
    expect(r.audits[0]?.context.detail).toMatchObject({
      notificationType: 'billing.credits_low',
      channel: 'email',
      mandatory: 'true',
    });
  });

  it('targets the notification itself', async () => {
    const r = rig();
    const created = await r.service.create(r.tx, create());
    await r.service.markFailed(r.tx, fail(created.notification.id));
    expect(r.audits[0]?.target).toEqual({
      kind: 'notification',
      id: created.notification.id,
      tenantId: ORG,
    });
  });

  it('is idempotent, and audits once', async () => {
    const r = rig();
    const created = await r.service.create(r.tx, create());
    await r.service.markFailed(r.tx, fail(created.notification.id));
    const retry = await r.service.markFailed(r.tx, fail(created.notification.id));

    expect(retry.converged).toBe(true);
    expect(r.audits).toHaveLength(1);
  });

  // A failure nobody wrote a reason for cannot be acted on.
  it('refuses an empty reason', async () => {
    const r = rig();
    const created = await r.service.create(r.tx, create());
    await expect(
      r.service.markFailed(r.tx, fail(created.notification.id, { reason: '   ' })),
    ).rejects.toThrow(/carries a reason/);
    expect(r.rows[0]?.status).toBe('pending');
  });

  it('records a non-mandatory class as such', async () => {
    const r = rig();
    const created = await r.service.create(
      r.tx,
      create({ type: 'system.settings_changed', dedupeKey: 'system.settings_changed:e1' }),
    );
    await r.service.markFailed(r.tx, fail(created.notification.id));
    expect(r.audits[0]?.context.detail).toMatchObject({ mandatory: 'false' });
  });
});

describe('read is bounded and paginates by keyset', () => {
  async function seed(r: Rig, count: number, over: Partial<CreateNotificationCommand> = {}) {
    for (let i = 1; i <= count; i += 1) {
      await r.service.create(r.tx, create({ dedupeKey: `key-${String(i)}`, ...over }));
    }
  }

  it('returns newest first', async () => {
    const r = rig();
    await seed(r, 3);
    const page = await r.service.read(r.tx, { organizationId: ORG });
    expect(page.notifications.map((n) => n.dedupeKey)).toEqual(['key-3', 'key-2', 'key-1']);
  });

  it('walks the whole inbox through the cursor without repeating a row', async () => {
    const r = rig();
    await seed(r, 5);

    const seen: string[] = [];
    let cursor = null as Awaited<ReturnType<typeof r.service.read>>['nextCursor'];
    for (let guard = 0; guard < 10; guard += 1) {
      const page = await r.service.read(r.tx, { organizationId: ORG, limit: 2, cursor });
      seen.push(...page.notifications.map((n) => n.id));
      cursor = page.nextCursor;
      if (cursor === null) break;
    }

    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
  });

  it('reports no cursor once the page is short', async () => {
    const r = rig();
    await seed(r, 3);
    const page = await r.service.read(r.tx, { organizationId: ORG, limit: 10 });
    expect(page.nextCursor).toBeNull();
  });

  it('clamps a request for the whole inbox to one page', async () => {
    const r = rig();
    await seed(r, 3);
    const page = await r.service.read(r.tx, { organizationId: ORG, limit: 100_000 });
    expect(page.notifications.length).toBeLessThanOrEqual(MAX_NOTIFICATION_PAGE);
  });

  it('filters by workspace', async () => {
    const r = rig();
    await r.service.create(r.tx, create({ dedupeKey: 'a', workspaceId: WS }));
    await r.service.create(r.tx, create({ dedupeKey: 'b', workspaceId: WS2 }));
    await r.service.create(r.tx, create({ dedupeKey: 'c' }));

    const page = await r.service.read(r.tx, { organizationId: ORG, workspaceId: WS });
    expect(page.notifications).toHaveLength(1);
    expect(page.notifications[0]?.workspaceId).toBe(WS);
  });

  it('filters by status', async () => {
    const r = rig();
    await seed(r, 3);
    const first = r.rows[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    await r.service.markDelivered(r.tx, {
      organizationId: ORG,
      notificationId: first.id,
      channel: 'in_app',
    });

    const pending = await r.service.read(r.tx, { organizationId: ORG, status: 'pending' });
    const delivered = await r.service.read(r.tx, { organizationId: ORG, status: 'delivered' });
    expect(pending.notifications).toHaveLength(2);
    expect(delivered.notifications).toHaveLength(1);
  });
});

describe('lookup', () => {
  it('finds a notification by id and by dedupe key', async () => {
    const r = rig();
    const created = await r.service.create(r.tx, create());

    expect((await r.service.findById(r.tx, ORG, created.notification.id))?.id).toBe(
      created.notification.id,
    );
    expect((await r.service.findByDedupeKey(r.tx, ORG, created.notification.dedupeKey))?.id).toBe(
      created.notification.id,
    );
  });

  it('returns null across organizations', async () => {
    const r = rig();
    const created = await r.service.create(r.tx, create());
    const OTHER_ORG = '018f7a1e-0000-7000-8000-0000000000a9';
    expect(await r.service.findById(r.tx, OTHER_ORG, created.notification.id)).toBeNull();
  });

  it('returns null for a key nothing holds', async () => {
    const r = rig();
    expect(await r.service.findByDedupeKey(r.tx, ORG, 'never-used')).toBeNull();
  });
});
