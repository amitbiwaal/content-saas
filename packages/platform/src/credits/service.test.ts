/**
 * The Credit Ledger Service.
 *
 * The fake below enforces the ONE database rule the service's correctness turns
 * on — the unique index over `(tenant_id, idempotency_key)`, including the
 * `ON CONFLICT DO NOTHING` no-op. A fake that accepted every insert would let
 * the convergence path pass without ever converging on anything.
 *
 * The privilege-level guarantees — UPDATE and DELETE revoked, RLS isolation —
 * are NOT asserted here. They are properties of a role against a real server,
 * and `scripts/db/verify-ledger.sql` asserts them at CI step 5b. A mock cannot
 * refuse a privilege it was never granted.
 */
import { describe, expect, it, vi } from 'vitest';

import type { DomainEvent, EventPublisher, Transaction } from '@contentos/contracts';
import type { AuditWriter, NewAuditRecord } from '@contentos/security';

import { LedgerError } from './ledger.js';
import {
  CREDIT_AUDIT_ACTIONS,
  createCreditLedgerService,
  MAX_LEDGER_PAGE,
  type AppendEntryCommand,
  type LedgerExecutor,
} from './service.js';

const ORG = '018f7a1e-0000-7000-8000-0000000000aa';
const WS = '018f7a1e-0000-7000-8000-0000000000bb';
const OTHER_WS = '018f7a1e-0000-7000-8000-0000000000cc';
const ACTOR = '018f7a1e-0000-7000-8000-000000000001';
const CORRELATION = '018f7a1e-0000-7000-8000-0000000000dd';
const EVENT_ID = '018f7a1e-0000-7000-8000-0000000000ee';
const NOW = new Date('2026-07-30T12:00:00.000Z');

interface Row {
  id: string;
  tenantId: string;
  organizationId: string;
  workspaceId: string | null;
  entryType: string;
  amount: string;
  direction: string;
  idempotencyKey: string | null;
  referenceEntryId: string | null;
  reason: string;
  correlationId: string;
  createdBy: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

interface Harness {
  readonly tx: LedgerExecutor;
  readonly rows: Row[];
  readonly audits: NewAuditRecord[];
  readonly published: DomainEvent<unknown>[];
  /** Ordered record of what the service did, for asserting sequence. */
  readonly calls: string[];
  seed(row: Partial<Row> & { id: string }): void;
}

function harness(): Harness {
  const rows: Row[] = [];
  const audits: NewAuditRecord[] = [];
  const published: DomainEvent<unknown>[] = [];
  const calls: string[] = [];
  let seq = 0;

  const tx = {
    query<T>(sql: string, params?: readonly unknown[]): Promise<readonly T[]> {
      const p = [...(params ?? [])] as (string | null)[];

      if (sql.includes('INSERT INTO credit_ledger_entries')) {
        calls.push('insert');
        const [tenantId, workspaceId, entryType, amount, direction, key] = p;
        // The unique index. NULLs are distinct, so keyless entries never clash.
        if (
          key !== null &&
          key !== undefined &&
          rows.some((r) => r.tenantId === tenantId && r.idempotencyKey === key)
        ) {
          return Promise.resolve([]); // ON CONFLICT DO NOTHING
        }
        seq += 1;
        const row: Row = {
          id: `018f7a1e-0000-7000-8000-${String(seq).padStart(12, '0')}`,
          tenantId: tenantId ?? '',
          organizationId: tenantId ?? '',
          workspaceId: workspaceId ?? null,
          entryType: entryType ?? '',
          amount: amount ?? '',
          direction: direction ?? '',
          idempotencyKey: key ?? null,
          referenceEntryId: p[6] ?? null,
          reason: p[7] ?? '',
          correlationId: p[8] ?? '',
          createdBy: p[9] ?? null,
          metadata: JSON.parse(p[10] ?? '{}') as Record<string, unknown>,
          createdAt: new Date(NOW.getTime() + seq * 1000).toISOString(),
        };
        rows.push(row);
        return Promise.resolve([row] as unknown as T[]);
      }

      if (sql.includes('idempotency_key = $2')) {
        calls.push('select:key');
        return Promise.resolve(
          rows.filter((r) => r.tenantId === p[0] && r.idempotencyKey === p[1]) as unknown as T[],
        );
      }

      if (sql.includes('AND id = $2')) {
        calls.push('select:id');
        return Promise.resolve(
          rows.filter((r) => r.tenantId === p[0] && r.id === p[1]) as unknown as T[],
        );
      }

      if (sql.includes('ORDER BY created_at DESC')) {
        calls.push('select:page');
        const [tenantId, workspaceId, cursorAt, cursorId, limit] = p as unknown as [
          string,
          string | null,
          string | null,
          string | null,
          number,
        ];
        const page = rows
          .filter((r) => r.tenantId === tenantId)
          .filter((r) => workspaceId === null || r.workspaceId === workspaceId)
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
  } as unknown as LedgerExecutor;

  return {
    tx,
    rows,
    audits,
    published,
    calls,
    seed(row) {
      rows.push({
        tenantId: ORG,
        organizationId: ORG,
        workspaceId: null,
        entryType: 'grant',
        amount: '1.000000',
        direction: 'credit',
        idempotencyKey: null,
        referenceEntryId: null,
        reason: 'seeded',
        correlationId: CORRELATION,
        createdBy: ACTOR,
        metadata: {},
        createdAt: NOW.toISOString(),
        ...row,
      });
    },
  };
}

function service(h: Harness, options: { publishFails?: Error } = {}) {
  const publisher: EventPublisher = {
    publish<T>(_tx: Transaction, event: DomainEvent<T>): Promise<void> {
      h.calls.push('publish');
      if (options.publishFails !== undefined) return Promise.reject(options.publishFails);
      h.published.push(event as DomainEvent<unknown>);
      return Promise.resolve();
    },
  };
  const audit: AuditWriter = {
    record(_tx: Transaction, entry: NewAuditRecord): Promise<string> {
      h.calls.push('audit');
      h.audits.push(entry);
      return Promise.resolve('audit-id');
    },
  };
  return createCreditLedgerService({
    publisher,
    audit,
    now: () => NOW,
    newEventId: () => EVENT_ID,
  });
}

function grant(over: Partial<AppendEntryCommand> = {}): AppendEntryCommand {
  return {
    organizationId: ORG,
    entryType: 'grant',
    amount: '100.000000',
    reason: 'Credit pack purchased.',
    actor: { id: ACTOR, kind: 'service' },
    correlationId: CORRELATION,
    ...over,
  };
}

describe('append writes the entry, its event, and nothing else', () => {
  it('persists the row and returns it', async () => {
    const h = harness();
    const result = await service(h).append(h.tx, grant());

    expect(result.created).toBe(true);
    expect(h.rows).toHaveLength(1);
    expect(result.entry).toMatchObject({
      organizationId: ORG,
      tenantId: ORG,
      entryType: 'grant',
      amount: '100.000000',
      direction: 'credit',
      workspaceId: null,
    });
  });

  it('publishes exactly one event, matching the entry', async () => {
    const h = harness();
    const result = await service(h).append(h.tx, grant());

    expect(h.published).toHaveLength(1);
    expect(h.published[0]).toMatchObject({
      eventType: 'CreditGranted',
      aggregateId: ORG,
      tenantId: ORG,
    });
    expect(result.event?.eventType).toBe('CreditGranted');
  });

  // Envelope and registry validation run inside publish, before commit, so an
  // event the registry rejects must take the ledger row down with it.
  it('publishes AFTER the insert, so a rejected event rolls the row back', async () => {
    const h = harness();
    await service(h).append(h.tx, grant());
    expect(h.calls).toEqual(['insert', 'publish']);
  });

  it('propagates a publish failure rather than swallowing it', async () => {
    const h = harness();
    const boom = new Error('registry rejected the envelope');
    await expect(service(h, { publishFails: boom }).append(h.tx, grant())).rejects.toThrow(boom);
  });

  const TYPE_TO_EVENT = [
    ['grant', 'CreditGranted', {}],
    ['refund', 'CreditRefunded', {}],
    ['expiry', 'CreditExpired', {}],
    ['consumption', 'CreditConsumed', { workspaceId: WS }],
    ['adjustment', 'CreditAdjusted', { direction: 'debit' as const }],
  ] as const;

  for (const [entryType, eventType, extra] of TYPE_TO_EVENT) {
    it(`emits ${eventType} for a ${entryType} entry`, async () => {
      const h = harness();
      await service(h).append(h.tx, grant({ entryType, ...extra }));
      expect(h.published[0]?.eventType).toBe(eventType);
    });
  }

  it('carries the metadata onto the row', async () => {
    const h = harness();
    const result = await service(h).append(
      h.tx,
      grant({ metadata: { invoiceId: 'inv-4471', packSize: 500 } }),
    );
    expect(result.entry.metadata).toEqual({ invoiceId: 'inv-4471', packSize: 500 });
  });
});

describe('auditing follows the specification, not habit', () => {
  // "Adjustments ... produce both a ledger row and an audit row in one
  // transaction" — credits.md §Security.
  it('audits an adjustment, before publishing it', async () => {
    const h = harness();
    await service(h).append(
      h.tx,
      grant({ entryType: 'adjustment', direction: 'credit', reason: 'Goodwill after incident.' }),
    );

    expect(h.audits).toHaveLength(1);
    expect(h.audits[0]).toMatchObject({
      action: CREDIT_AUDIT_ACTIONS.adjustment,
      tenantId: ORG,
      organizationId: ORG,
      actorId: ACTOR,
      result: 'success',
      reason: 'Goodwill after incident.',
    });
    expect(h.calls).toEqual(['insert', 'audit', 'publish']);
  });

  it('records the movement on the audit context', async () => {
    const h = harness();
    await service(h).append(
      h.tx,
      grant({ entryType: 'adjustment', direction: 'debit', amount: '7.500000' }),
    );
    expect(h.audits[0]?.context.detail).toMatchObject({
      entryType: 'adjustment',
      direction: 'debit',
      amount: '7.500000',
    });
  });

  it('targets the ledger entry itself', async () => {
    const h = harness();
    const result = await service(h).append(
      h.tx,
      grant({ entryType: 'adjustment', direction: 'credit' }),
    );
    expect(h.audits[0]?.target).toEqual({
      kind: 'credit_ledger_entry',
      id: result.entry.id,
      tenantId: ORG,
    });
  });

  // Duplicating every consumption into audit_log would double the write volume
  // of the platform's highest-volume path to restate what the immutable row
  // beside it already says.
  for (const entryType of ['grant', 'consumption', 'refund', 'expiry'] as const) {
    it(`does NOT audit a ${entryType}`, async () => {
      const h = harness();
      await service(h).append(
        h.tx,
        grant({ entryType, ...(entryType === 'consumption' ? { workspaceId: WS } : {}) }),
      );
      expect(h.audits).toHaveLength(0);
    });
  }
});

describe('a duplicate idempotency key converges', () => {
  const KEY = 'run-4471:step-write:call-2';

  it('returns the original entry without writing a second row', async () => {
    const h = harness();
    const svc = service(h);

    const first = await svc.append(h.tx, grant({ idempotencyKey: KEY }));
    const second = await svc.append(h.tx, grant({ idempotencyKey: KEY, amount: '999.000000' }));

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.entry.id).toBe(first.entry.id);
    // The retry's amount is discarded: the winner is the record.
    expect(second.entry.amount).toBe('100.000000');
    expect(h.rows).toHaveLength(1);
  });

  it('publishes no second event', async () => {
    const h = harness();
    const svc = service(h);
    await svc.append(h.tx, grant({ idempotencyKey: KEY }));
    await svc.append(h.tx, grant({ idempotencyKey: KEY }));

    expect(h.published).toHaveLength(1);
  });

  it('writes no second audit record', async () => {
    const h = harness();
    const svc = service(h);
    const adjustment = grant({
      entryType: 'adjustment',
      direction: 'credit',
      idempotencyKey: KEY,
    });
    await svc.append(h.tx, adjustment);
    await svc.append(h.tx, adjustment);

    expect(h.audits).toHaveLength(1);
  });

  // The insert decides, not a prior read: a check-then-act would let two
  // concurrent retries of the same AI call both pass the check and charge twice.
  it('does not read before inserting', async () => {
    const h = harness();
    await service(h).append(h.tx, grant({ idempotencyKey: KEY }));
    expect(h.calls[0]).toBe('insert');
    expect(h.calls).not.toContain('select:key');
  });

  it('reads the winner only after the conflict', async () => {
    const h = harness();
    const svc = service(h);
    await svc.append(h.tx, grant({ idempotencyKey: KEY }));
    h.calls.length = 0;
    await svc.append(h.tx, grant({ idempotencyKey: KEY }));
    expect(h.calls).toEqual(['insert', 'select:key']);
  });

  it('keeps keyless entries independent of each other', async () => {
    const h = harness();
    const svc = service(h);
    await svc.append(h.tx, grant());
    await svc.append(h.tx, grant());
    expect(h.rows).toHaveLength(2);
  });

  it('scopes the key to the tenant', async () => {
    const h = harness();
    const svc = service(h);
    const OTHER_ORG = '018f7a1e-0000-7000-8000-0000000000a9';
    await svc.append(h.tx, grant({ idempotencyKey: KEY }));
    const other = await svc.append(h.tx, grant({ organizationId: OTHER_ORG, idempotencyKey: KEY }));
    expect(other.created).toBe(true);
    expect(h.rows).toHaveLength(2);
  });
});

describe('validation refuses a bad entry before anything is written', () => {
  const CASES: [string, Partial<AppendEntryCommand>, string][] = [
    ['a negative amount', { amount: '-1' }, 'InvalidAmount'],
    ['an amount as scientific notation', { amount: '1e3' }, 'InvalidAmount'],
    ['an empty reason', { reason: '   ' }, 'ReasonRequired'],
    ['a grant recorded as a debit', { direction: 'debit' }, 'DirectionContradictsType'],
    ['an adjustment with no direction', { entryType: 'adjustment' }, 'DirectionRequired'],
    ['a consumption with no workspace', { entryType: 'consumption' }, 'WorkspaceRequired'],
    ['a grant attributed to a workspace', { workspaceId: WS }, 'WorkspaceNotAllowed'],
  ];

  for (const [what, over, code] of CASES) {
    it(`rejects ${what} with ${code}`, async () => {
      const h = harness();
      await expect(service(h).append(h.tx, grant(over))).rejects.toThrow(LedgerError);
      try {
        await service(h).append(h.tx, grant(over));
      } catch (error) {
        expect((error as LedgerError).code).toBe(code);
      }
      expect(h.rows).toHaveLength(0);
      expect(h.published).toHaveLength(0);
      expect(h.audits).toHaveLength(0);
    });
  }

  it('accepts a consumption that names its workspace', async () => {
    const h = harness();
    const result = await service(h).append(
      h.tx,
      grant({ entryType: 'consumption', workspaceId: WS, amount: '0.000001' }),
    );
    expect(result.entry.workspaceId).toBe(WS);
    expect(result.entry.direction).toBe('debit');
  });
});

describe('read is bounded and paginates by keyset', () => {
  function seedEntries(h: Harness, count: number, workspaceId: string | null = null): void {
    for (let i = 1; i <= count; i += 1) {
      h.seed({
        id: `018f7a1e-0000-7000-8000-${String(i).padStart(12, '0')}`,
        workspaceId,
        entryType: workspaceId === null ? 'grant' : 'consumption',
        direction: workspaceId === null ? 'credit' : 'debit',
        createdAt: new Date(NOW.getTime() + i * 1000).toISOString(),
      });
    }
  }

  it('returns newest first', async () => {
    const h = harness();
    seedEntries(h, 3);
    const page = await service(h).read(h.tx, { organizationId: ORG });
    expect(page.entries.map((e) => e.createdAt)).toEqual([
      new Date(NOW.getTime() + 3000).toISOString(),
      new Date(NOW.getTime() + 2000).toISOString(),
      new Date(NOW.getTime() + 1000).toISOString(),
    ]);
  });

  it('walks the whole ledger through the cursor without repeating a row', async () => {
    const h = harness();
    seedEntries(h, 5);
    const svc = service(h);

    const seen: string[] = [];
    let cursor = null as Awaited<ReturnType<typeof svc.read>>['nextCursor'];
    for (let guard = 0; guard < 10; guard += 1) {
      const page = await svc.read(h.tx, { organizationId: ORG, limit: 2, cursor });
      seen.push(...page.entries.map((e) => e.id));
      cursor = page.nextCursor;
      if (cursor === null) break;
    }

    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
  });

  it('reports no cursor once the page is short', async () => {
    const h = harness();
    seedEntries(h, 3);
    const page = await service(h).read(h.tx, { organizationId: ORG, limit: 10 });
    expect(page.nextCursor).toBeNull();
  });

  // "An unbounded history request is refused rather than served slowly."
  it('clamps a request for the whole ledger to one page', async () => {
    const h = harness();
    const spy = vi.spyOn(h.tx, 'query');
    await service(h).read(h.tx, { organizationId: ORG, limit: 100_000 });
    expect(spy.mock.calls[0]?.[1]?.at(-1)).toBe(MAX_LEDGER_PAGE);
  });

  it('clamps a nonsensical limit up to one row rather than returning none', async () => {
    const h = harness();
    const spy = vi.spyOn(h.tx, 'query');
    await service(h).read(h.tx, { organizationId: ORG, limit: 0 });
    expect(spy.mock.calls[0]?.[1]?.at(-1)).toBe(1);
  });

  it('filters to one workspace for per-client attribution', async () => {
    const h = harness();
    seedEntries(h, 2, WS);
    h.seed({
      id: '018f7a1e-0000-7000-8000-000000000099',
      workspaceId: OTHER_WS,
      entryType: 'consumption',
      direction: 'debit',
    });

    const page = await service(h).read(h.tx, { organizationId: ORG, workspaceId: WS });
    expect(page.entries).toHaveLength(2);
    expect(page.entries.every((e) => e.workspaceId === WS)).toBe(true);
  });

  it('reads the organization ledger under the organization tenant', async () => {
    const h = harness();
    const spy = vi.spyOn(h.tx, 'query');
    await service(h).read(h.tx, { organizationId: ORG });
    expect(spy.mock.calls[0]?.[1]?.[0]).toBe(ORG);
  });
});

describe('lookup', () => {
  it('finds an entry by its idempotency key', async () => {
    const h = harness();
    const svc = service(h);
    const appended = await svc.append(h.tx, grant({ idempotencyKey: 'run-1:step-1' }));

    const found = await svc.findByIdempotencyKey(h.tx, ORG, 'run-1:step-1');
    expect(found?.id).toBe(appended.entry.id);
  });

  it('returns null for a key nothing holds', async () => {
    const h = harness();
    expect(await service(h).findByIdempotencyKey(h.tx, ORG, 'never-used')).toBeNull();
  });

  it('finds an entry by id, and returns null across organizations', async () => {
    const h = harness();
    const svc = service(h);
    const appended = await svc.append(h.tx, grant());

    expect((await svc.findById(h.tx, ORG, appended.entry.id))?.id).toBe(appended.entry.id);
    const OTHER_ORG = '018f7a1e-0000-7000-8000-0000000000a9';
    expect(await svc.findById(h.tx, OTHER_ORG, appended.entry.id)).toBeNull();
  });

  // A value outside the CHECK vocabulary means the schema and this module have
  // diverged; widening the type to absorb it would hide that.
  it('refuses to return a row holding an unknown entry type', async () => {
    const h = harness();
    h.seed({ id: '018f7a1e-0000-7000-8000-0000000000f1', entryType: 'chargeback' });
    await expect(
      service(h).findById(h.tx, ORG, '018f7a1e-0000-7000-8000-0000000000f1'),
    ).rejects.toThrow(/unknown entry type/);
  });

  it('refuses to return a row holding an unknown direction', async () => {
    const h = harness();
    h.seed({ id: '018f7a1e-0000-7000-8000-0000000000f2', direction: 'sideways' });
    await expect(
      service(h).findById(h.tx, ORG, '018f7a1e-0000-7000-8000-0000000000f2'),
    ).rejects.toThrow(/unknown direction/);
  });
});
