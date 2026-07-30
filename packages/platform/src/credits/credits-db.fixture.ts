/**
 * An in-memory stand-in for the three credits tables, shared by the unit and
 * concurrency suites.
 *
 * ── What it models, and why those things specifically ───────────────────────
 * A fake that accepts every statement would let the service pass while
 * double-charging. This one implements exactly the mechanisms the correctness
 * argument rests on, and nothing else:
 *
 *   - `pg_advisory_xact_lock` as a real queue, released at transaction end.
 *     Without it two concurrent authorizations both read the same available
 *     balance. With it they serialise, which is the whole point.
 *   - `SELECT ... FOR UPDATE` as a per-row queue, likewise. A second
 *     consumption against one hold waits and then re-reads the COMMITTED row,
 *     so it sees `consumed` already advanced.
 *   - `UNIQUE (tenant_id, run_id)` and `UNIQUE (tenant_id, idempotency_key)`
 *     with `ON CONFLICT DO NOTHING` semantics.
 *   - `CHECK (consumed <= amount)`, which throws exactly as PostgreSQL would.
 *   - Guarded state transitions: `WHERE ... AND state = 'held'` matches nothing
 *     once the hold is closed.
 *
 * ── What it does NOT model ──────────────────────────────────────────────────
 * RLS, privileges, and real parallelism. Those are properties of a server, not
 * of a data structure, and they are asserted at CI step 5c against PostgreSQL
 * 17 — including a genuinely parallel authorize race across separate
 * connections. A mock cannot refuse a privilege it was never granted, and
 * interleaving promises is not the same as interleaving backends.
 */

import {
  addAmounts,
  compareAmounts,
  formatAmount,
  parseAmount,
  parseSigned,
  subtractAmounts,
  ZERO,
  type ScaledAmount,
} from './amount.js';
import type { CreditsExecutor } from './credits-service.js';

interface HoldRecord {
  id: string;
  tenantId: string;
  organizationId: string;
  workspaceId: string;
  runId: string;
  amount: string;
  consumed: string;
  state: string;
  expiresAt: string;
  reason: string;
  correlationId: string;
  createdBy: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  settledAt: string | null;
  releasedAt: string | null;
}

interface EntryRecord {
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

interface BalanceRecord {
  tenantId: string;
  credited: string;
  debited: string;
  entriesProjected: number;
  throughAt: string | null;
  throughId: string | null;
  thresholdState: string;
}

/** A FIFO queue standing in for one lock. */
class Lock {
  private tail: Promise<void> = Promise.resolve();

  acquire(): { readonly held: Promise<void>; readonly release: () => void } {
    let release = (): void => {};
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held = this.tail;
    this.tail = held.then(() => next);
    return { held, release };
  }
}

export interface CreditsDb {
  /** One transaction. Locks it takes are released when `work` settles. */
  transaction<T>(work: (tx: CreditsExecutor) => Promise<T>): Promise<T>;
  readonly holds: HoldRecord[];
  readonly entries: EntryRecord[];
  readonly balances: Map<string, BalanceRecord>;
  /** Ordered log of statement kinds, for asserting sequence. */
  readonly calls: string[];
  seedGrant(organizationId: string, amount: string, at?: string): EntryRecord;
  ledgerBalance(organizationId: string): string;
  openHoldTotal(organizationId: string): string;
}

const CHECK_VIOLATION = { code: '23514' };

interface CreditsDbOptions {
  readonly now?: () => Date;
  /**
   * Turn the advisory lock into a no-op.
   *
   * Exists so a test can DEMONSTRATE the race the lock prevents, rather than
   * asserting an invariant that might hold for some unrelated reason. A
   * concurrency test that has never seen the failure it guards against is not
   * evidence of anything.
   */
  readonly disableAdvisoryLock?: boolean;
}

export function createCreditsDb(options: CreditsDbOptions = {}): CreditsDb {
  const now = options.now ?? ((): Date => new Date());
  const holds: HoldRecord[] = [];
  const entries: EntryRecord[] = [];
  const balances = new Map<string, BalanceRecord>();
  const calls: string[] = [];

  const advisory = new Map<string, Lock>();
  const rowLocks = new Map<string, Lock>();
  let seq = 0;

  const nextId = (prefix: string): string => {
    seq += 1;
    return `018f7a1e-0000-7000-${prefix}-${String(seq).padStart(12, '0')}`;
  };

  function lockFor(registry: Map<string, Lock>, key: string): Lock {
    const existing = registry.get(key);
    if (existing !== undefined) return existing;
    const created = new Lock();
    registry.set(key, created);
    return created;
  }

  const sumScaled = (values: readonly string[]): ScaledAmount =>
    values.reduce<ScaledAmount>((total, v) => addAmounts(total, parseAmount(v)), ZERO);

  function makeTx(release: (fn: () => void) => void): CreditsExecutor {
    const held = new Set<string>();

    return {
      async query<T>(sql: string, params?: readonly unknown[]): Promise<readonly T[]> {
        const p = [...(params ?? [])] as (string | number | null)[];
        const tenant = String(p[0] ?? '');

        // ── advisory lock ─────────────────────────────────────────────────
        if (sql.includes('pg_advisory_xact_lock')) {
          calls.push('advisory-lock');
          if (options.disableAdvisoryLock === true) return [] as unknown as T[];
          const key = `advisory:${tenant}`;
          if (held.has(key)) return [] as unknown as T[]; // re-entrant, as PostgreSQL is
          held.add(key);
          const handle = lockFor(advisory, key).acquire();
          release(handle.release);
          await handle.held;
          return [] as unknown as T[];
        }

        // ── credit_holds ──────────────────────────────────────────────────
        if (sql.includes('INSERT INTO credit_holds')) {
          calls.push('insert-hold');
          const [, workspaceId, runId, amount, expiresAt, reason, correlationId, createdBy, meta] =
            p as string[];
          if (holds.some((h) => h.tenantId === tenant && h.runId === runId)) {
            return [] as unknown as T[]; // ON CONFLICT DO NOTHING
          }
          const record: HoldRecord = {
            id: nextId('7001'),
            tenantId: tenant,
            organizationId: tenant,
            workspaceId: workspaceId ?? '',
            runId: runId ?? '',
            amount: formatAmount(parseAmount(amount ?? '0')),
            consumed: '0.000000',
            state: 'held',
            expiresAt: expiresAt ?? '',
            reason: reason ?? '',
            correlationId: correlationId ?? '',
            createdBy: createdBy ?? null,
            metadata: JSON.parse(meta ?? '{}') as Record<string, unknown>,
            createdAt: now().toISOString(),
            settledAt: null,
            releasedAt: null,
          };
          holds.push(record);
          return [record] as unknown as T[];
        }

        if (sql.includes('SET consumed = consumed +')) {
          calls.push('advance-consumed');
          const hold = holds.find(
            (h) => h.tenantId === tenant && h.id === p[1] && h.state === 'held',
          );
          if (hold === undefined) return [] as unknown as T[];
          const next = addAmounts(parseAmount(hold.consumed), parseAmount(String(p[2])));
          // The database's own backstop on the reservation bound.
          if (compareAmounts(next, parseAmount(hold.amount)) === 1) {
            throw Object.assign(
              new Error('new row for relation "credit_holds" violates check constraint'),
              CHECK_VIOLATION,
            );
          }
          hold.consumed = formatAmount(next);
          return [hold] as unknown as T[];
        }

        if (sql.includes("SET state = 'settled'")) {
          calls.push('settle');
          const hold = holds.find(
            (h) => h.tenantId === tenant && h.id === p[1] && h.state === 'held',
          );
          if (hold === undefined) return [] as unknown as T[];
          hold.state = 'settled';
          hold.settledAt = now().toISOString();
          return [hold] as unknown as T[];
        }

        if (sql.includes("SET state = 'expired'")) {
          calls.push('expire');
          const cutoff = String(p[1]);
          const matched = holds.filter(
            (h) => h.tenantId === tenant && h.state === 'held' && h.expiresAt <= cutoff,
          );
          for (const h of matched) {
            h.state = 'expired';
            h.releasedAt = now().toISOString();
          }
          return matched as unknown as T[];
        }

        if (sql.includes("SET state = 'released'")) {
          const byId = sql.includes('AND id = $2');
          calls.push(byId ? 'release' : 'release-open');
          const matched = holds.filter((h) => {
            if (h.tenantId !== tenant || h.state !== 'held') return false;
            if (byId) return h.id === p[1];
            return p[1] === null || h.workspaceId === p[1];
          });
          for (const h of matched) {
            h.state = 'released';
            h.releasedAt = now().toISOString();
          }
          return matched as unknown as T[];
        }

        if (sql.includes('FROM credit_holds WHERE tenant_id = $1 AND run_id = $2')) {
          calls.push('select-hold-by-run');
          return holds.filter((h) => h.tenantId === tenant && h.runId === p[1]) as unknown as T[];
        }

        if (sql.includes('FROM credit_holds WHERE tenant_id = $1 AND id = $2')) {
          if (sql.includes('FOR UPDATE')) {
            calls.push('select-hold-for-update');
            const key = `row:${String(p[1])}`;
            if (!held.has(key)) {
              held.add(key);
              const handle = lockFor(rowLocks, key).acquire();
              release(handle.release);
              await handle.held;
            }
          } else {
            calls.push('select-hold');
          }
          return holds.filter((h) => h.tenantId === tenant && h.id === p[1]) as unknown as T[];
        }

        if (sql.includes('AS held')) {
          calls.push('sum-open-holds');
          return [
            {
              held: formatAmount(
                sumScaled(
                  holds
                    .filter((h) => h.tenantId === tenant && h.state === 'held')
                    .map((h) => h.amount),
                ),
              ),
            },
          ] as unknown as T[];
        }

        // ── credit_ledger_entries ─────────────────────────────────────────
        if (sql.includes('INSERT INTO credit_ledger_entries')) {
          calls.push('insert-entry');
          const key = p[5] as string | null;
          if (
            key !== null &&
            entries.some((e) => e.tenantId === tenant && e.idempotencyKey === key)
          ) {
            return [] as unknown as T[]; // ON CONFLICT DO NOTHING
          }
          const record: EntryRecord = {
            id: nextId('7002'),
            tenantId: tenant,
            organizationId: tenant,
            workspaceId: (p[1] as string | null) ?? null,
            entryType: String(p[2]),
            amount: formatAmount(parseAmount(String(p[3]))),
            direction: String(p[4]),
            idempotencyKey: key,
            referenceEntryId: (p[6] as string | null) ?? null,
            reason: String(p[7]),
            correlationId: String(p[8]),
            createdBy: (p[9] as string | null) ?? null,
            metadata: JSON.parse(String(p[10])) as Record<string, unknown>,
            createdAt: now().toISOString(),
          };
          entries.push(record);
          return [record] as unknown as T[];
        }

        if (sql.includes('idempotency_key = $2')) {
          calls.push('select-entry-by-key');
          return entries.filter(
            (e) => e.tenantId === tenant && e.idempotencyKey === p[1],
          ) as unknown as T[];
        }

        if (sql.includes('AS stale')) {
          calls.push('staleness-probe');
          const throughAt = p[1] as string | null;
          const throughId = p[2] as string | null;
          const behind = entries.some(
            (e) =>
              e.tenantId === tenant &&
              (throughAt === null ||
                e.createdAt > throughAt ||
                (e.createdAt === throughAt && e.id > (throughId ?? ''))),
          );
          return [{ stale: behind }] as unknown as T[];
        }

        if (sql.includes("FILTER (WHERE direction = 'credit')")) {
          calls.push('aggregate-ledger');
          const mine = entries.filter((e) => e.tenantId === tenant);
          // The watermark comes back with the sums, from one snapshot — the
          // production query reads them in a single statement for exactly that
          // reason, so the fake must not hand them out separately either.
          const last = [...mine].sort((a, b) =>
            (b.createdAt + b.id).localeCompare(a.createdAt + a.id),
          )[0];
          return [
            {
              credited: formatAmount(
                sumScaled(mine.filter((e) => e.direction === 'credit').map((e) => e.amount)),
              ),
              debited: formatAmount(
                sumScaled(mine.filter((e) => e.direction === 'debit').map((e) => e.amount)),
              ),
              entries: mine.length,
              throughAt: last?.createdAt ?? null,
              throughId: last?.id ?? null,
            },
          ] as unknown as T[];
        }

        if (sql.includes('ORDER BY created_at DESC, id DESC')) {
          calls.push('last-entry');
          const mine = entries
            .filter((e) => e.tenantId === tenant)
            .sort((a, b) => (b.createdAt + b.id).localeCompare(a.createdAt + a.id));
          const last = mine[0];
          return (last === undefined
            ? []
            : [{ throughAt: last.createdAt, throughId: last.id }]) as unknown as T[];
        }

        // ── credit_balances ───────────────────────────────────────────────
        if (sql.includes('INSERT INTO credit_balances')) {
          calls.push('upsert-balance');
          const existing = balances.get(tenant);
          const record: BalanceRecord = {
            tenantId: tenant,
            credited: String(p[1]),
            debited: String(p[2]),
            entriesProjected: Number(p[3]),
            throughAt: (p[4] as string | null) ?? null,
            throughId: (p[5] as string | null) ?? null,
            // ON CONFLICT DO UPDATE leaves threshold_state alone, so RETURNING
            // yields the value that was already there.
            thresholdState: existing?.thresholdState ?? 'ok',
          };
          balances.set(tenant, record);
          return [{ thresholdState: record.thresholdState }] as unknown as T[];
        }

        if (sql.includes('SET threshold_state = $2')) {
          calls.push('update-threshold');
          const row = balances.get(tenant);
          if (row !== undefined) row.thresholdState = String(p[1]);
          return [] as unknown as T[];
        }

        if (sql.includes('FROM credit_balances')) {
          calls.push('select-balance');
          const row = balances.get(tenant);
          return (row === undefined ? [] : [row]) as unknown as T[];
        }

        throw new Error(`unexpected SQL: ${sql}`);
      },
    } as unknown as CreditsExecutor;
  }

  return {
    async transaction<T>(work: (tx: CreditsExecutor) => Promise<T>): Promise<T> {
      const releases: (() => void)[] = [];
      const tx = makeTx((fn) => releases.push(fn));
      try {
        return await work(tx);
      } finally {
        // Transaction-scoped: released on commit OR rollback, in reverse order.
        for (const fn of releases.reverse()) fn();
      }
    },
    holds,
    entries,
    balances,
    calls,
    seedGrant(organizationId, amount, at) {
      seq += 1;
      const record: EntryRecord = {
        id: `018f7a1e-0000-7000-7002-${String(seq).padStart(12, '0')}`,
        tenantId: organizationId,
        organizationId,
        workspaceId: null,
        entryType: 'grant',
        amount: formatAmount(parseAmount(amount)),
        direction: 'credit',
        idempotencyKey: null,
        referenceEntryId: null,
        reason: 'seeded grant',
        correlationId: '018f7a1e-0000-7000-8000-0000000000dd',
        createdBy: null,
        metadata: {},
        createdAt: at ?? now().toISOString(),
      };
      entries.push(record);
      return record;
    },
    ledgerBalance(organizationId) {
      const mine = entries.filter((e) => e.tenantId === organizationId);
      return formatAmount(
        subtractAmounts(
          sumScaled(mine.filter((e) => e.direction === 'credit').map((e) => e.amount)),
          sumScaled(mine.filter((e) => e.direction === 'debit').map((e) => e.amount)),
        ),
      );
    },
    openHoldTotal(organizationId) {
      return formatAmount(
        sumScaled(
          holds
            .filter((h) => h.tenantId === organizationId && h.state === 'held')
            .map((h) => h.amount),
        ),
      );
    },
  };
}

/**
 * Available = ledger balance − the UNSPENT part of open holds.
 *
 * Mirrors `SUM(amount - consumed)` in `balance.ts`, and for the same reason:
 * what has been consumed is already a ledger debit, so counting the whole
 * reservation would subtract it twice.
 */
export function availableOf(db: CreditsDb, organizationId: string): string {
  const outstanding = db.holds
    .filter((h) => h.tenantId === organizationId && h.state === 'held')
    .reduce<ScaledAmount>(
      (total, h) =>
        addAmounts(total, subtractAmounts(parseAmount(h.amount), parseAmount(h.consumed))),
      ZERO,
    );
  return formatAmount(subtractAmounts(parseSigned(db.ledgerBalance(organizationId)), outstanding));
}
