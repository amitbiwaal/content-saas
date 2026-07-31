/**
 * What a new reservation may draw on.
 *
 *     available = ledger balance − unspent ACTIVE reservations
 *
 * ── The ledger is the money; reservations are operational state ────────────
 * Nothing here reads, writes or derives a ledger entry. The balance arrives as
 * a `LedgerBalance` that something else computed, and reservations only ever
 * SUBTRACT from it. A reservation that could change the balance would make
 * operational state financial state, and the ledger would stop being the
 * source of truth the moment the two disagreed.
 *
 * ── Why `− consumed`, and not the whole reservation ────────────────────────
 * What has already been spent is a ledger DEBIT: the balance has come down
 * already. Subtracting the whole reservation on top of that would take the same
 * credits twice and show a customer less than they have. Only the UNSPENT part
 * of an open reservation is still holding anything down.
 *
 * `remainingOf` — frozen, in `holds.ts` — already encodes that rule, and this
 * reuses it rather than restating it. A second implementation of the one
 * subtraction that decides whether a customer can run anything is the thing
 * most worth not having twice.
 *
 * ── The pure twin of the SQL path ──────────────────────────────────────────
 * `balance.ts` computes this in PostgreSQL, on the request path, where it
 * belongs. This computes the same number from values, so that the SQL has
 * something a test can check it against — the same reason `aggregate.ts`
 * exists beside the SQL aggregate.
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
import { LEDGER_CURRENCY, type LedgerBalance, type LedgerCurrency } from './aggregate.js';
import { InsufficientCreditsError } from './holds.js';
import { ACTIVE_RESERVATION_STATUS, type CreditReservation } from './reservation.js';

/**
 * The figure a request is admitted against.
 *
 * `balance` and `reserved` are both carried, not just their difference: an
 * operator looking at a refusal needs to know whether the customer is out of
 * credits or merely has them all committed to runs in flight, and those call
 * for opposite actions.
 */
export interface AvailabilityReading {
  readonly organizationId: string;
  readonly currency: LedgerCurrency;
  /** From the ledger. Never derived from reservations. */
  readonly balance: string;
  /** The unspent part of every ACTIVE reservation. */
  readonly reserved: string;
  /** `balance − reserved` — what a new reservation may draw on. */
  readonly available: string;
  readonly activeReservations: number;
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

export interface AvailabilityOptions {
  /** What the ledger says. Computed elsewhere; never computed from holds. */
  readonly balance: LedgerBalance;
  /** Every reservation for this organization. Non-active ones are ignored. */
  readonly reservations: readonly CreditReservation[];
}

/**
 * The unspent total of the ACTIVE reservations.
 *
 * Terminal reservations contribute nothing: one that has been released,
 * expired or consumed has already stopped holding credits down, and counting it
 * would keep a customer below their real balance forever.
 */
export function reservedAmount(reservations: readonly CreditReservation[]): ScaledAmount {
  let total: ScaledAmount = ZERO;
  for (const reservation of reservations) {
    if (reservation.status !== ACTIVE_RESERVATION_STATUS) continue;
    total = addAmounts(total, parseAmount(reservation.remaining));
  }
  return total;
}

/**
 * Balance minus what is committed.
 *
 * Deterministic: the same balance and the same reservations, in any order,
 * produce the same figure. Order affects nothing, which is what makes it safe
 * to compare against a SQL aggregate that saw them differently.
 */
export function calculateAvailability(options: AvailabilityOptions): AvailabilityReading {
  const { balance, reservations } = options;

  const mine = reservations.filter(
    (reservation) => reservation.organizationId === balance.organizationId,
  );

  const ledger = parseSigned(balance.balance);
  const reserved = reservedAmount(mine);
  const available = subtractAmounts(ledger, reserved);

  return deepFreeze({
    organizationId: balance.organizationId,
    currency: LEDGER_CURRENCY,
    balance: balance.balance,
    reserved: formatAmount(reserved),
    available: formatAmount(available),
    activeReservations: mine.filter(
      (reservation) => reservation.status === ACTIVE_RESERVATION_STATUS,
    ).length,
  });
}

/**
 * Can this organization commit to spending `required` more?
 *
 * A predicate, so a caller can ask without catching. `assertSufficient` is the
 * same question for callers about to act on the answer.
 */
export function hasSufficient(availability: AvailabilityReading, required: string): boolean {
  return compareAmounts(parseSigned(availability.available), parseAmount(required)) >= 0;
}

/**
 * Refuse a reservation the balance cannot cover.
 *
 * Throws the FROZEN `InsufficientCreditsError`, which already carries the three
 * figures a caller needs and already says "no provider call was made" — the
 * whole point of checking before execution rather than after. A second error
 * for the same refusal would mean two things to catch and two messages to keep
 * true.
 */
export function assertSufficient(availability: AvailabilityReading, required: string): void {
  if (hasSufficient(availability, required)) return;

  const shortfall = subtractAmounts(parseAmount(required), parseSigned(availability.available));

  throw new InsufficientCreditsError(availability.available, required, formatAmount(shortfall));
}
