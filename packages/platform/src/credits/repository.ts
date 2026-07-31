/**
 * The ledger port — interfaces, and nothing else.
 *
 * ── Why this exists beside a working SQL service ───────────────────────────
 * `service.ts` is the ledger's writer, and it is deliberately SQL-shaped: it
 * takes a `LedgerExecutor` because the row, its audit record and its outbox
 * event must land on ONE transaction handle (ADR-020). That coupling is the
 * point of it and is not something to abstract away.
 *
 * What it leaves without an answer is everything that wants to READ or REPLAY a
 * ledger with no database in the room: a reconciliation job, a restore check, a
 * test, an importer, a future service in another process. Each of those either
 * grows its own SQL — a second place the ledger's shape is written down — or it
 * gets a port. This is the port.
 *
 * ── It is not a second ledger ──────────────────────────────────────────────
 * There is one store, one table, one set of rows. An implementation of this
 * interface is a VIEW onto them; the SQL service remains the only writer that
 * can keep the outbox and the audit trail atomic with the row, and
 * `appendEntry` here is for a caller that has already decided how it will do
 * that. Nothing in this file can write anything.
 *
 * ── No database, no clock, no ids ──────────────────────────────────────────
 * No driver, no SQL, no `Transaction`. Timestamps and ids arrive on the values
 * a caller passes, because a repository that minted either would make two reads
 * of one fact differ.
 */

import type { LedgerEntry } from './ledger.js';
import type { LedgerBalance } from './aggregate.js';

/** Where a page of ledger history continues from. Keyset, never an offset. */
export interface LedgerPosition {
  /** The `createdAt` of the last entry read. */
  readonly createdAt: string;
  /** Its id — the tiebreak that makes the position exact. */
  readonly entryId: string;
}

/**
 * What a ledger read narrows by.
 *
 * Explicit nulls rather than optionals, the same discipline every other port in
 * this codebase uses: an implementer sees every dimension it must handle,
 * including the ones that are off. A filter an implementation quietly ignores
 * is, here, one organization's balance built from another's rows.
 */
export interface LedgerQuery {
  /** Required. There is no such thing as reading "the ledger" across tenants. */
  readonly organizationId: string;
  /** Attribution, not ownership. Null reads the whole organization. */
  readonly workspaceId: string | null;
  /** Inclusive. */
  readonly createdAfter: string | null;
  /** Exclusive, so adjacent windows never count one entry twice. */
  readonly createdBefore: string | null;
  readonly after: LedgerPosition | null;
  /** At most this many. Bounded by the caller, never unbounded here. */
  readonly limit: number;
}

export interface LedgerSlice {
  /** Oldest first: a ledger is read forwards, because it is a history. */
  readonly entries: readonly LedgerEntry[];
}

/**
 * A read-and-append view of one credit ledger.
 *
 * `calculateBalance` is on the port rather than left to callers because a store
 * that can sum exactly — PostgreSQL can — should, and one that cannot may fall
 * back to `aggregate.calculateBalance` over what `loadLedger` returns. Either
 * way the answer is the same number, which is the whole reason the pure fold
 * exists.
 */
export interface CreditLedgerRepository {
  /**
   * Record an entry.
   *
   * Idempotent on `idempotencyKey` within an organization: a retried call must
   * charge once, and the store already holds the unique index that says so. An
   * implementation that cannot honour that must refuse rather than duplicate.
   *
   * Append-only. There is no update and no delete on this interface, and there
   * is no ledger operation that would need one — a mistake is corrected by a
   * compensating entry, which is itself a row.
   */
  appendEntry(entry: LedgerEntry): Promise<void>;

  /** One entry, or null when the organization has no such row. */
  loadEntry(organizationId: string, entryId: string): Promise<LedgerEntry | null>;

  /** A page of history. */
  loadLedger(query: LedgerQuery): Promise<LedgerSlice>;

  /**
   * What the entries add up to.
   *
   * The whole ledger, not a page: a balance from a page is a partial sum
   * wearing the name of a total.
   */
  calculateBalance(organizationId: string): Promise<LedgerBalance>;
}
