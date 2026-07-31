/**
 * The ledger as a value: entries in, balance out.
 *
 * ── Why a pure fold, when PostgreSQL already sums exactly ──────────────────
 * `balance.ts` is the request path, and it is right to be: "computing balance
 * by aggregating a 10⁹-row ledger on every request is not viable". It reads a
 * projection, checks a watermark, and falls back to a SQL aggregate.
 *
 * This is the same arithmetic with no database in it. What that buys is not
 * speed — it is the ability to state the ledger's central invariant as a
 * function and test it:
 *
 *     balance = Σ credits − Σ debits
 *
 * A projection is a cache of that number. `reconcile` compares the two. Neither
 * can be checked against anything unless the number itself exists somewhere
 * that a test can compute without a server, and until now it did not.
 *
 * ── It refuses four things a sum would otherwise hide ──────────────────────
 * A duplicate transaction id, an amount the column would reject, a total the
 * column could not hold, and a recorded balance the entries do not produce.
 * Each is silent in a plain `reduce`, and each is permanent in a ledger with no
 * UPDATE path.
 *
 * Overflow is the one nothing checked before. `assertValidAmount` bounds every
 * ENTRY at `NUMERIC(20,6)`; nothing bounded the SUM. A balance past 10^14
 * credits cannot be written back to the projection column, and the failure
 * would arrive as a driver error inside somebody else's transaction.
 *
 * ── Credits are not money ──────────────────────────────────────────────────
 * One currency, named, and asserted. A ledger that carried a currency field
 * could be handed dollars, and the arithmetic here would add them to credits
 * without noticing.
 */

import {
  addAmounts,
  formatAmount,
  parseAmount,
  parseSigned,
  subtractAmounts,
  ZERO,
  type ScaledAmount,
} from './amount.js';
import { LedgerError, type LedgerEntry } from './ledger.js';
import { reasonFor, type LedgerReason } from './reason.js';

/**
 * The only currency a credit ledger holds.
 *
 * Credits, not money: they are bought with money and are not redeemable for it,
 * which is why no ISO 4217 code appears anywhere in this module.
 */
export const LEDGER_CURRENCY = 'credits';

export type LedgerCurrency = typeof LEDGER_CURRENCY;

/**
 * The largest magnitude `NUMERIC(20,6)` can hold, in scaled units.
 *
 * Precision 20, scale 6 — fourteen integer digits. `10^20` scaled units is the
 * first value that does not fit.
 */
export const MAX_SCALED_BALANCE = 10n ** 20n;

/**
 * One transaction: the entries written together, under one id.
 *
 * The transaction id IS the entry's `idempotencyKey`. That column is already
 * the thing that makes a retried AI call charge once, and it is already unique
 * per organization in the database — a second identity on a financial row would
 * be a second thing to keep in step and a second way for two writes to disagree
 * about whether they were the same write.
 *
 * Entries with no key are not transactions in this sense. A support adjustment
 * and a manual grant have no natural key, which is exactly why they are audited
 * instead.
 */
export interface LedgerTransaction {
  readonly transactionId: string;
  readonly organizationId: string;
  /** Every entry written under this id, in the order the ledger returned them. */
  readonly entries: readonly LedgerEntry[];
  /** The net effect: credits minus debits, across the transaction. */
  readonly net: string;
}

/**
 * What the entries add up to.
 *
 * Derived, never stored: `balance.ts` keeps a projection of this number and
 * checks its own staleness before trusting it. This type is the truth the
 * projection is a cache OF.
 */
export interface LedgerBalance {
  readonly organizationId: string;
  readonly currency: LedgerCurrency;
  /** Σ of every `credit` entry. */
  readonly credited: string;
  /** Σ of every `debit` entry. */
  readonly debited: string;
  /** `credited − debited`. May be negative if a correction lands out of order. */
  readonly balance: string;
  readonly entryCount: number;
  /** How many distinct transaction ids contributed. */
  readonly transactionCount: number;
}

/**
 * A credit ledger, as a value.
 *
 * `ledgerId` IS the organization id. The credit account is an organization-owned
 * aggregate (ADR-029) and the database CHECKs `tenant_id = organization_id`, so
 * a separate ledger identity would be a second name for one thing — and the
 * first time the two were written independently they would disagree.
 */
export interface CreditLedger {
  readonly ledgerId: string;
  readonly organizationId: string;
  readonly currency: LedgerCurrency;
  /** Append-only. Nothing in this module returns a ledger with fewer. */
  readonly entries: readonly LedgerEntry[];
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.getOwnPropertyNames(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

/** Guard the running total, at the point it crosses. */
function guardOverflow(total: ScaledAmount, organizationId: string): void {
  const magnitude = total < 0n ? 0n - total : (total as bigint);
  if (magnitude >= MAX_SCALED_BALANCE) {
    throw new LedgerError(
      'BalanceOverflow',
      `The balance for organization '${organizationId}' exceeds NUMERIC(20,6). A total this large cannot be written back to the projection, and the failure would surface as a driver error inside an unrelated transaction.`,
    );
  }
}

export interface CalculateBalanceOptions {
  readonly organizationId: string;
  readonly entries: readonly LedgerEntry[];
}

/**
 * The invariant, computed.
 *
 * Deterministic: the same entries in any order produce the same balance,
 * because addition is commutative and every amount is exact. Order affects
 * nothing here, which is what makes it safe to compare against a projection
 * built by a consumer that saw them in a different order.
 */
export function calculateBalance(options: CalculateBalanceOptions): LedgerBalance {
  const { organizationId, entries } = options;

  let credited: ScaledAmount = ZERO;
  let debited: ScaledAmount = ZERO;
  const transactions = new Set<string>();

  for (const entry of entries) {
    if (entry.organizationId !== organizationId) {
      // A foreign row in an organization's ledger is a tenancy failure, and
      // summing it would move credits between customers.
      throw new LedgerError(
        'ForeignEntry',
        `Entry '${entry.id}' belongs to organization '${entry.organizationId}', not '${organizationId}'.`,
      );
    }

    if (entry.idempotencyKey !== null) {
      if (transactions.has(entry.idempotencyKey)) {
        // Two rows claiming one transaction means a retry was charged twice.
        // Summing them would make the double charge the balance.
        throw new LedgerError(
          'DuplicateTransactionId',
          `Transaction '${entry.idempotencyKey}' appears more than once in organization '${organizationId}'. A retried call must charge once.`,
        );
      }
      transactions.add(entry.idempotencyKey);
    }

    // Reuses the ledger's own grammar. A value this accepted and the column
    // refused would be a balance nobody could write back.
    const amount = parseAmount(entry.amount);

    if (entry.direction === 'credit') {
      credited = addAmounts(credited, amount);
    } else {
      debited = addAmounts(debited, amount);
    }

    guardOverflow(credited, organizationId);
    guardOverflow(debited, organizationId);
  }

  const balance = subtractAmounts(credited, debited);
  guardOverflow(balance, organizationId);

  return deepFreeze({
    organizationId,
    currency: LEDGER_CURRENCY,
    credited: formatAmount(credited),
    debited: formatAmount(debited),
    balance: formatAmount(balance),
    entryCount: entries.length,
    transactionCount: transactions.size,
  });
}

/**
 * Check a balance somebody else computed.
 *
 * What reconciliation is FOR: a projection, a report or a restored backup says
 * a number, and the entries say another. Throwing names both, because "the
 * balance is wrong" without the two figures is a page nobody can act on.
 */
export function assertBalanceConsistent(
  options: CalculateBalanceOptions & { readonly claimed: string },
): LedgerBalance {
  const computed = calculateBalance(options);
  const claimed = parseSigned(options.claimed);
  const actual = parseSigned(computed.balance);

  if (claimed !== actual) {
    throw new LedgerError(
      'InconsistentBalance',
      `Organization '${options.organizationId}' records a balance of ${options.claimed} and its ${String(options.entries.length)} entries sum to ${computed.balance}.`,
    );
  }

  return computed;
}

/**
 * Group entries into the transactions that wrote them.
 *
 * Entries with no idempotency key are not returned: they are not transactions
 * (see `LedgerTransaction`), and inventing an id for them would make a manual
 * adjustment look like a machine write that could be retried.
 */
export function groupTransactions(options: CalculateBalanceOptions): readonly LedgerTransaction[] {
  const byKey = new Map<string, LedgerEntry[]>();

  for (const entry of options.entries) {
    if (entry.organizationId !== options.organizationId) {
      throw new LedgerError(
        'ForeignEntry',
        `Entry '${entry.id}' belongs to organization '${entry.organizationId}', not '${options.organizationId}'.`,
      );
    }
    if (entry.idempotencyKey === null) continue;
    const group = byKey.get(entry.idempotencyKey);
    if (group === undefined) byKey.set(entry.idempotencyKey, [entry]);
    else group.push(entry);
  }

  return deepFreeze(
    [...byKey.entries()].map(([transactionId, group]) => {
      let net: ScaledAmount = ZERO;
      for (const entry of group) {
        const amount = parseAmount(entry.amount);
        net = entry.direction === 'credit' ? addAmounts(net, amount) : subtractAmounts(net, amount);
      }
      return {
        transactionId,
        organizationId: options.organizationId,
        entries: [...group],
        net: formatAmount(net),
      };
    }),
  );
}

/** The commercial reasons present in a ledger, in entry order. */
export function reasonsOf(entries: readonly LedgerEntry[]): readonly LedgerReason[] {
  return Object.freeze(entries.map((entry) => reasonFor(entry.entryType)));
}

/** A ledger value from its entries. Adds nothing and drops nothing. */
export function toCreditLedger(options: CalculateBalanceOptions): CreditLedger {
  return deepFreeze({
    ledgerId: options.organizationId,
    organizationId: options.organizationId,
    currency: LEDGER_CURRENCY,
    entries: [...options.entries],
  });
}
