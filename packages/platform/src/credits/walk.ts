/**
 * Reading a whole ledger through the port.
 *
 * ── Never a request path ───────────────────────────────────────────────────
 * This walks every entry an organization has. `balance.ts` exists precisely so
 * that a request never does that — "computing balance by aggregating a 10⁹-row
 * ledger on every request is not viable". What this is for is the work that
 * genuinely needs the whole history: a reconciliation, a restore check, an
 * export, an import.
 *
 * ── It is bounded, and says when the bound was reached ─────────────────────
 * A ledger grows without limit, so a loop over one needs a stated end. Hitting
 * it is not an error and is not silent: `truncated` is on the result, because a
 * balance computed from a truncated walk is a partial sum wearing the name of a
 * total, and that is exactly the mistake this makes impossible to make quietly.
 *
 * ── Keyset, never offset ───────────────────────────────────────────────────
 * The ledger is append-only, so new entries land at the end while a walk is in
 * progress. An offset would skip an entry every time one did.
 */

import {
  calculateBalance,
  toCreditLedger,
  type CreditLedger,
  type LedgerBalance,
} from './aggregate.js';
import { LedgerError, type LedgerEntry } from './ledger.js';
import type { CreditLedgerRepository } from './repository.js';

export const DEFAULT_LEDGER_PAGE_SIZE = 200;

/**
 * How far a walk goes before it stops and says so.
 *
 * A number, not `Infinity`: a job that would read ten million rows should be a
 * decision somebody made, not the default.
 */
export const DEFAULT_MAX_LEDGER_ENTRIES = 100_000;

export interface LoadWholeLedgerOptions {
  readonly repository: CreditLedgerRepository;
  readonly organizationId: string;
  readonly pageSize?: number;
  readonly maxEntries?: number;
}

export interface WholeLedger {
  readonly ledger: CreditLedger;
  /** True when `maxEntries` stopped the walk before the ledger ran out. */
  readonly truncated: boolean;
}

export async function loadWholeLedger(options: LoadWholeLedgerOptions): Promise<WholeLedger> {
  const pageSize = options.pageSize ?? DEFAULT_LEDGER_PAGE_SIZE;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_LEDGER_ENTRIES;

  const entries: LedgerEntry[] = [];
  let after: { createdAt: string; entryId: string } | null = null;
  let truncated = false;

  for (;;) {
    const slice = await options.repository.loadLedger({
      organizationId: options.organizationId,
      workspaceId: null,
      createdAfter: null,
      createdBefore: null,
      after,
      limit: pageSize,
    });

    if (slice.entries.length === 0) break;
    entries.push(...slice.entries);

    if (entries.length >= maxEntries) {
      truncated = true;
      entries.length = maxEntries;
      break;
    }

    // A short page means the store had no more. Asking again would be one
    // round trip per walk, forever, for nothing.
    if (slice.entries.length < pageSize) break;

    const last = slice.entries[slice.entries.length - 1] as LedgerEntry;
    after = { createdAt: last.createdAt, entryId: last.id };
  }

  return Object.freeze({
    ledger: toCreditLedger({ organizationId: options.organizationId, entries }),
    truncated,
  });
}

/**
 * The balance of a whole ledger, computed from its entries.
 *
 * Refuses a truncated walk rather than returning the sum of what it managed to
 * read: a partial balance is worse than no balance, because it looks like one.
 */
export async function calculateLedgerBalance(
  options: LoadWholeLedgerOptions,
): Promise<LedgerBalance> {
  const whole = await loadWholeLedger(options);

  if (whole.truncated) {
    throw new LedgerError(
      'InconsistentBalance',
      `Organization '${options.organizationId}' has more entries than the walk's bound, so any total from it would be partial. Raise maxEntries or read the balance through the projection.`,
    );
  }

  return calculateBalance({
    organizationId: options.organizationId,
    entries: whole.ledger.entries,
  });
}
