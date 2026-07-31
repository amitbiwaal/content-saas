/**
 * The commercial vocabulary for ledger entries.
 *
 * ── Why a second set of names, and not a second ledger ─────────────────────
 * `LedgerEntryType` is what the database CHECKs and what every row already
 * carries. `LedgerReason` is the name the commercial platform uses for the same
 * facts. Rather than let the two drift — or worse, let a mismatch of names
 * justify a second ledger — this module states the mapping ONCE, totally, and
 * makes it round-trip.
 *
 * Nothing here is a new record. `entryTypeFor` produces a value the frozen
 * service already accepts; `reasonFor` names a row that already exists.
 *
 * ── Two reasons have no entry type, and are refused rather than fudged ─────
 * `CREDIT_PURCHASE` and `CREDIT_RESERVATION` are both real commercial concepts
 * and neither is a ledger row today.
 *
 * A PURCHASE is not a grant. Money changed hands, which decides revenue
 * recognition, refund eligibility and tax; a grant decides none of those.
 * Mapping it onto `grant` would make "how many credits were paid for?"
 * unanswerable from the ledger for exactly as long as the mapping survived —
 * and a ledger has no UPDATE path to fix it in afterwards. Representing it
 * properly means growing a CHECK constraint on a financial table and the event
 * vocabulary alongside it, which belongs with the increment that adds a payment
 * path. Until then it is refused, by name.
 *
 * A RESERVATION is not a ledger row BY DESIGN. `holds.ts` reserves credits by
 * arithmetic — `available = balance − unspent holds` — precisely so that
 * releasing one is a state change and never a compensating write. A reservation
 * entry would let the same credits be subtracted twice: once as a hold and
 * again as a row. It is refused, and the refusal names where reservations
 * actually live.
 *
 * ── `CREDIT_EXPIRY` is here although nothing asked for it ──────────────────
 * `expiry` is in the frozen enum and rows carry it. A vocabulary that could not
 * name an entry type that exists would be a vocabulary that silently loses
 * rows on the way out.
 */

import { LedgerError, type LedgerEntryType } from './ledger.js';

/**
 * The commercial names, in the platform's own spelling.
 *
 * Screaming case rather than the entry types' lower case, deliberately: the two
 * vocabularies are never interchangeable at a glance, and a value that reads
 * like the wrong one is a value somebody will pass to the wrong function.
 */
export const LEDGER_REASONS = [
  'CREDIT_GRANT',
  'CREDIT_PURCHASE',
  'CREDIT_RESERVATION',
  'CREDIT_CONSUMPTION',
  'CREDIT_REFUND',
  'CREDIT_ADJUSTMENT',
  'CREDIT_EXPIRY',
] as const;

export type LedgerReason = (typeof LEDGER_REASONS)[number];

export function isLedgerReason(value: unknown): value is LedgerReason {
  return typeof value === 'string' && (LEDGER_REASONS as readonly string[]).includes(value);
}

/**
 * Every reason that IS a ledger entry, and which one.
 *
 * Partial on purpose. A total record would need a value for the two that have
 * none, and every value available would be wrong.
 */
export const REASON_TO_ENTRY_TYPE: Readonly<Partial<Record<LedgerReason, LedgerEntryType>>> =
  Object.freeze({
    CREDIT_GRANT: 'grant',
    CREDIT_CONSUMPTION: 'consumption',
    CREDIT_REFUND: 'refund',
    CREDIT_ADJUSTMENT: 'adjustment',
    CREDIT_EXPIRY: 'expiry',
  });

/**
 * The reverse, and it is TOTAL: every entry type has a name.
 *
 * Totality here is what makes reading the ledger safe. The forward direction
 * may refuse, because a caller can ask for something that is not a row; the
 * reverse cannot, because the row is already there.
 */
export const ENTRY_TYPE_TO_REASON: Readonly<Record<LedgerEntryType, LedgerReason>> = Object.freeze({
  grant: 'CREDIT_GRANT',
  consumption: 'CREDIT_CONSUMPTION',
  refund: 'CREDIT_REFUND',
  adjustment: 'CREDIT_ADJUSTMENT',
  expiry: 'CREDIT_EXPIRY',
});

/** Which reasons are ledger entries at all. */
export const RECORDABLE_REASONS: readonly LedgerReason[] = Object.freeze(
  LEDGER_REASONS.filter((reason) => REASON_TO_ENTRY_TYPE[reason] !== undefined),
);

export function isRecordableReason(reason: LedgerReason): boolean {
  return REASON_TO_ENTRY_TYPE[reason] !== undefined;
}

/** Why a reason cannot become a row, in words a caller can act on. */
const UNREPRESENTABLE: Readonly<Partial<Record<LedgerReason, string>>> = Object.freeze({
  CREDIT_PURCHASE:
    "A purchase is not a grant: money changed hands, and that decides revenue recognition, refund eligibility and tax. Recording it as 'grant' would make 'how many credits were paid for?' unanswerable from the ledger, permanently, because a ledger has no UPDATE path. It needs its own entry type, which is a migration on a financial table and belongs with the payment path that will write one.",
  CREDIT_RESERVATION:
    'A reservation is not a ledger entry by design: holds reserve by arithmetic (available = balance − unspent holds), so that releasing one is a state change and never a compensating write. A reservation row would let the same credits be subtracted twice. Use the hold API.',
});

/**
 * The entry type a reason records as.
 *
 * Throws `LedgerError` rather than returning null, and with the module's own
 * error type: a caller about to write a financial row that cannot be
 * represented has a bug, and returning a null it might not check would put the
 * bug in the database.
 */
export function entryTypeFor(reason: LedgerReason): LedgerEntryType {
  const entryType = REASON_TO_ENTRY_TYPE[reason];
  if (entryType !== undefined) return entryType;

  // Read loosely on purpose: the declared type says this is always a reason,
  // and a value that arrived from a request body says nothing of the kind.
  const asked: unknown = reason;
  if (!isLedgerReason(asked)) {
    throw new LedgerError(
      'InvalidEntryType',
      `'${String(reason)}' is not a credit reason. Available: ${LEDGER_REASONS.join(', ')}.`,
    );
  }

  throw new LedgerError(
    'UnrepresentableReason',
    `${reason} cannot be recorded as a ledger entry. ${UNREPRESENTABLE[reason] ?? ''}`,
  );
}

/** The reason a row carries. Total — see `ENTRY_TYPE_TO_REASON`. */
export function reasonFor(entryType: LedgerEntryType): LedgerReason {
  const reason: LedgerReason | undefined = ENTRY_TYPE_TO_REASON[entryType] as
    | LedgerReason
    | undefined;
  if (reason === undefined) {
    throw new LedgerError(
      'InvalidEntryType',
      `'${String(entryType)}' is not a ledger entry type this build knows.`,
    );
  }
  return reason;
}
