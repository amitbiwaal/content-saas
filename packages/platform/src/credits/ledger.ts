/**
 * The credit ledger model — `04-platform/credits.md`, `03-database/tables.md` §8.
 *
 * The vocabulary and the rules about it. No persistence, no balance: this
 * module is what `service.ts` validates against before it writes, and what a
 * test can exercise without a database.
 *
 * ── Sign is carried by the type, never by the magnitude ─────────────────────
 * `CHECK (amount >= 0)` — "prevents a negative grant masquerading as a charge"
 * (tables.md §8). Four of the five entry types therefore determine their own
 * direction; `adjustment` does not, because support may add or remove, and that
 * is precisely why it is audited and carries a mandatory reason.
 *
 * ── Amounts are decimal STRINGS ─────────────────────────────────────────────
 * The column is `NUMERIC(20,6)`. Parsing that into a JS `number` loses exact
 * decimal values immediately (`0.1 + 0.2`) and integer precision past 2^53. A
 * ledger has no UPDATE path, so a rounding error written once is permanent —
 * the amount stays a string end to end and arithmetic on it belongs to the
 * balance engine, which this increment does not build.
 */

/** The fixed vocabulary. The database CHECKs the same five values. */
export const LEDGER_ENTRY_TYPES = [
  'grant',
  'consumption',
  'refund',
  'adjustment',
  'expiry',
] as const;

export type LedgerEntryType = (typeof LEDGER_ENTRY_TYPES)[number];

export const LEDGER_DIRECTIONS = ['credit', 'debit'] as const;

export type LedgerDirection = (typeof LEDGER_DIRECTIONS)[number];

export function isLedgerEntryType(value: string): value is LedgerEntryType {
  return (LEDGER_ENTRY_TYPES as readonly string[]).includes(value);
}

export function isLedgerDirection(value: string): value is LedgerDirection {
  return (LEDGER_DIRECTIONS as readonly string[]).includes(value);
}

/**
 * The direction each entry type implies, where it implies one.
 *
 * `adjustment` is absent rather than defaulted. A default would silently pick a
 * side for the one operation a human performs by hand, on an immutable row.
 */
export const IMPLIED_DIRECTION: Readonly<Partial<Record<LedgerEntryType, LedgerDirection>>> = {
  grant: 'credit',
  refund: 'credit',
  consumption: 'debit',
  expiry: 'debit',
};

export type LedgerErrorCode =
  | 'InvalidEntryType'
  | 'InvalidDirection'
  | 'DirectionContradictsType'
  | 'DirectionRequired'
  | 'InvalidAmount'
  | 'WorkspaceRequired'
  | 'WorkspaceNotAllowed'
  | 'ReasonRequired'
  | 'DuplicateIdempotencyKey'
  | 'EntryNotFound'
  // ── Added by the storage-agnostic ledger core ─────────────────────────────
  // One taxonomy for one module: a second error type beside `LedgerError` would
  // mean a caller catching two things to learn one fact.
  /** A commercial reason that is not a ledger row. See `reason.ts`. */
  | 'UnrepresentableReason'
  /** Two entries claim one transaction id. See `aggregate.ts`. */
  | 'DuplicateTransactionId'
  /** A running balance that `NUMERIC(20,6)` could not hold. */
  | 'BalanceOverflow'
  /** A recorded balance that the entries do not add up to. */
  | 'InconsistentBalance'
  /** An entry that belongs to a different organization's ledger. */
  | 'ForeignEntry';

export class LedgerError extends Error {
  readonly code: LedgerErrorCode;

  constructor(code: LedgerErrorCode, message: string) {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
  }
}

/**
 * Resolve the direction for an entry, rejecting a contradiction.
 *
 * A caller that passes `grant` with `debit` has a bug somewhere upstream, and
 * the row it would write is indistinguishable from a legitimate charge once
 * committed. It is refused rather than coerced.
 */
export function resolveDirection(
  entryType: LedgerEntryType,
  explicit?: LedgerDirection,
): LedgerDirection {
  const implied = IMPLIED_DIRECTION[entryType];

  if (implied === undefined) {
    if (explicit === undefined) {
      throw new LedgerError(
        'DirectionRequired',
        `Entry type '${entryType}' does not imply a direction; support may add or remove, so it must be stated.`,
      );
    }
    return explicit;
  }

  if (explicit !== undefined && explicit !== implied) {
    throw new LedgerError(
      'DirectionContradictsType',
      `Entry type '${entryType}' is always a ${implied}, but '${explicit}' was supplied.`,
    );
  }
  return implied;
}

/**
 * `NUMERIC(20,6)`, non-negative, as the database will accept it.
 *
 * Validated here as well as by the CHECK because a constraint violation arrives
 * as an opaque driver error mid-transaction, after the audit row has been
 * written. Rejecting up front gives the caller the field and the reason.
 */
const AMOUNT_PATTERN = /^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/;
const MAX_PRECISION = 20;
const MAX_SCALE = 6;

export function assertValidAmount(amount: string): void {
  if (!AMOUNT_PATTERN.test(amount)) {
    throw new LedgerError(
      'InvalidAmount',
      `Amount '${amount}' must be a non-negative decimal with at most ${String(MAX_SCALE)} decimal places, written without a sign, exponent or leading zeroes.`,
    );
  }
  const digits = amount.replace('.', '').replace(/^0+(?=\d)/, '').length;
  if (digits > MAX_PRECISION) {
    throw new LedgerError(
      'InvalidAmount',
      `Amount '${amount}' exceeds NUMERIC(${String(MAX_PRECISION)},${String(MAX_SCALE)}).`,
    );
  }
}

/** A row as it exists in `credit_ledger_entries`. */
export interface LedgerEntry {
  readonly id: string;
  readonly tenantId: string;
  readonly organizationId: string;
  /** Set for consumption, null for organization-level entries. */
  readonly workspaceId: string | null;
  readonly entryType: LedgerEntryType;
  readonly amount: string;
  readonly direction: LedgerDirection;
  readonly idempotencyKey: string | null;
  readonly referenceEntryId: string | null;
  readonly reason: string;
  readonly correlationId: string;
  readonly createdBy: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}
