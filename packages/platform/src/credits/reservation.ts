/**
 * The reservation lifecycle, as data — and the commercial name for a hold.
 *
 * ── Why this exists beside `holds.ts` ──────────────────────────────────────
 * `holds.ts` names the four states and says which are terminal. What it does
 * NOT have is the transition itself: `authorizeSpend`, `settle`, `release` and
 * the TTL sweep each enforce the rules inline, so "which moves are legal" is a
 * fact spread across four functions rather than one table anybody can read.
 *
 * A table is worth having for the same reason the run and draft machines have
 * one: an illegal move becomes a refusal with a name instead of a condition
 * somebody forgot to write, and the whole machine is checkable in one test.
 *
 * ── One reservation, two vocabularies ──────────────────────────────────────
 * The database stores `held | settled | released | expired`. The commercial
 * platform says ACTIVE, CONSUMED, RELEASED, EXPIRED. The mapping is stated
 * once, here, and round-trips — the same discipline `reason.ts` applies to
 * entry types, and for the same reason: a mismatch of names must never be the
 * excuse for a second reservation system.
 *
 * ── CREATED is a moment, not a row ─────────────────────────────────────────
 * A hold is born `held`; there is no `created` value in the table and this
 * increment adds none. CREATED is the state a reservation is in before it
 * exists — the machine's entry point, which every state machine has and no
 * store persists. `activate` is therefore the only edge out of it, and
 * `statusToHoldState` refuses it by name rather than inventing a row.
 *
 * ── Reserving is arithmetic, so leaving ACTIVE needs no compensating write ──
 * Available balance is `ledger balance − unspent ACTIVE reservations`. A
 * reservation that stops being active stops being subtracted, in the same
 * instant, with nothing to forget. That is why there is no edge back INTO
 * `active`: re-entering it would reserve credits a second time from a
 * reservation that had already been accounted for.
 */

import { formatAmount } from './amount.js';
import {
  HoldError,
  OPEN_HOLD_STATE,
  remainingOf,
  type CreditHold,
  type HoldState,
} from './holds.js';

export const RESERVATION_STATUSES = [
  'created',
  'active',
  'consumed',
  'released',
  'expired',
] as const;

export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

export function isReservationStatus(value: unknown): value is ReservationStatus {
  return typeof value === 'string' && (RESERVATION_STATUSES as readonly string[]).includes(value);
}

/** The state a reservation is in before it exists. No row ever carries it. */
export const INITIAL_RESERVATION_STATUS: ReservationStatus = 'created';

/** The only status that reserves credits. Mirrors `OPEN_HOLD_STATE`. */
export const ACTIVE_RESERVATION_STATUS: ReservationStatus = 'active';

export const TERMINAL_RESERVATION_STATUSES: readonly ReservationStatus[] = Object.freeze([
  'consumed',
  'released',
  'expired',
]);

export function isTerminalReservationStatus(status: ReservationStatus): boolean {
  return TERMINAL_RESERVATION_STATUSES.includes(status);
}

export const RESERVATION_TRANSITIONS = ['activate', 'consume', 'release', 'expire'] as const;

export type ReservationTransition = (typeof RESERVATION_TRANSITIONS)[number];

export interface ReservationTransitionRule {
  readonly from: ReservationStatus;
  readonly transition: ReservationTransition;
  readonly to: ReservationStatus;
}

/**
 * The whole machine.
 *
 * Four edges, and every one of them leaves `created` or `active`. Nothing
 * returns to `active` and nothing leaves a terminal state — a settle arriving
 * after a release is not a state change, it is two deciders disagreeing, and
 * answering it by overwriting would make the disagreement invisible.
 */
export const RESERVATION_TRANSITION_RULES: readonly ReservationTransitionRule[] = Object.freeze([
  { from: 'created', transition: 'activate', to: 'active' },
  { from: 'active', transition: 'consume', to: 'consumed' },
  { from: 'active', transition: 'release', to: 'released' },
  { from: 'active', transition: 'expire', to: 'expired' },
]);

/** Where a transition leads, or null when it is not allowed from here. */
export function targetOf(
  from: ReservationStatus,
  transition: ReservationTransition,
): ReservationStatus | null {
  return (
    RESERVATION_TRANSITION_RULES.find(
      (rule) => rule.from === from && rule.transition === transition,
    )?.to ?? null
  );
}

export function canTransition(from: ReservationStatus, transition: ReservationTransition): boolean {
  return targetOf(from, transition) !== null;
}

/** Every transition available from a status. For an error message and a test. */
export function transitionsFrom(from: ReservationStatus): readonly ReservationTransition[] {
  return Object.freeze(
    RESERVATION_TRANSITION_RULES.filter((rule) => rule.from === from).map(
      (rule) => rule.transition,
    ),
  );
}

/**
 * Assert and resolve.
 *
 * Throws `HoldError` — the module's own type, so a caller catches one thing to
 * learn one fact. `InvalidHoldState` is the existing code for exactly this.
 */
export function assertTransitionAllowed(
  from: ReservationStatus,
  transition: ReservationTransition,
): ReservationStatus {
  const to = targetOf(from, transition);
  if (to === null) {
    const available = transitionsFrom(from);
    throw new HoldError(
      'InvalidHoldState',
      `A reservation in '${from}' cannot '${transition}'. ${
        available.length === 0 ? `'${from}' is terminal.` : `Available: ${available.join(', ')}.`
      }`,
    );
  }
  return to;
}

// ── The two vocabularies ────────────────────────────────────────────────────

/** Every status that IS a stored hold state. `created` is not one. */
export const STATUS_TO_HOLD_STATE: Readonly<Partial<Record<ReservationStatus, HoldState>>> =
  Object.freeze({
    active: OPEN_HOLD_STATE,
    consumed: 'settled',
    released: 'released',
    expired: 'expired',
  });

/** Total: every stored state has a commercial name. */
export const HOLD_STATE_TO_STATUS: Readonly<Record<HoldState, ReservationStatus>> = Object.freeze({
  held: 'active',
  settled: 'consumed',
  released: 'released',
  expired: 'expired',
});

/**
 * The stored state a status corresponds to.
 *
 * Refuses `created`, because no row carries it. Returning a hold state for it
 * would mean writing a row for a reservation that does not exist yet.
 */
export function statusToHoldState(status: ReservationStatus): HoldState {
  const state = STATUS_TO_HOLD_STATE[status];
  if (state !== undefined) return state;

  const asked: unknown = status;
  if (!isReservationStatus(asked)) {
    throw new HoldError(
      'InvalidHoldState',
      `'${String(status)}' is not a reservation status. Available: ${RESERVATION_STATUSES.join(', ')}.`,
    );
  }

  throw new HoldError(
    'InvalidHoldState',
    "'created' is the state a reservation is in before it exists; no row carries it. A reservation becomes storable when it is activated.",
  );
}

/** The commercial name a stored hold carries. Total — see the table. */
export function statusOf(state: HoldState): ReservationStatus {
  const status: ReservationStatus | undefined = HOLD_STATE_TO_STATUS[state] as
    | ReservationStatus
    | undefined;
  if (status === undefined) {
    throw new HoldError(
      'InvalidHoldState',
      `'${String(state)}' is not a hold state this build knows.`,
    );
  }
  return status;
}

// ── The reservation, as the commercial platform sees it ─────────────────────

/**
 * A reservation's identity.
 *
 * The hold's id, not a second one. An alias rather than a brand: every existing
 * call site already passes the hold id as a string, and a brand would buy
 * nothing but casts at each of them.
 */
export type ReservationId = string;

/** What a reservation carries that is not money or lifecycle. */
export interface ReservationMetadata {
  /** Why it was taken. Free text, never interpreted. */
  readonly reason: string;
  /** The customer action this reservation belongs to. */
  readonly correlationId: string;
  /** Who took it, where a person did. Null for machine reservations. */
  readonly createdBy: string | null;
  /** Carried and never read. */
  readonly attributes: Readonly<Record<string, unknown>>;
}

/**
 * One reservation.
 *
 * A projection of `CreditHold` in the commercial vocabulary — not a second
 * record. `remaining` is what the reservation still holds down: the amount
 * minus what has already become a ledger debit, which is the `− consumed` that
 * keeps a charge from being subtracted twice.
 */
export interface CreditReservation {
  readonly reservationId: ReservationId;
  readonly organizationId: string;
  /** Where the work happens. Attribution, as on a consumption entry. */
  readonly workspaceId: string;
  /** The run this reservation is for. Its idempotency key, in effect. */
  readonly executionId: string;
  readonly status: ReservationStatus;
  /** The reserved maximum — the bound on worst-case spend. */
  readonly amount: string;
  /** Already spent against it, and already a ledger debit. */
  readonly consumed: string;
  /** `amount − consumed` while active; zero once it is not. */
  readonly remaining: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly metadata: ReservationMetadata;
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

/**
 * A stored hold, as the commercial platform reads it. Adds nothing.
 *
 * `remaining` comes from the frozen `remainingOf`, which already encodes the
 * two rules that matter: subtract what has been consumed, and count nothing at
 * all once the hold has closed. A second implementation of that arithmetic is
 * the one thing here that could quietly disagree with the balance engine.
 */
export function toCreditReservation(hold: CreditHold): CreditReservation {
  return deepFreeze({
    reservationId: hold.id,
    organizationId: hold.organizationId,
    workspaceId: hold.workspaceId,
    executionId: hold.runId,
    status: statusOf(hold.state),
    amount: hold.amount,
    consumed: hold.consumed,
    remaining: formatAmount(remainingOf(hold)),
    createdAt: hold.createdAt,
    expiresAt: hold.expiresAt,
    metadata: {
      reason: hold.reason,
      correlationId: hold.correlationId,
      createdBy: hold.createdBy,
      attributes: { ...hold.metadata },
    },
  });
}

// ── Expiration ──────────────────────────────────────────────────────────────

/**
 * Has this reservation's TTL elapsed?
 *
 * Deterministic: `now` is supplied, never read. A predicate that read a clock
 * could not be asserted on, and a sweep that disagreed with a reader about
 * whether a reservation was expired would hold a customer's balance down
 * invisibly.
 *
 * Only an ACTIVE reservation can expire. A terminal one has already stopped
 * being subtracted, and calling it expired afterwards would rewrite why it
 * closed.
 */
export function isExpired(reservation: CreditReservation, now: string): boolean {
  return reservation.status === ACTIVE_RESERVATION_STATUS && reservation.expiresAt <= now;
}

/** Every reservation a sweep at `now` would reclaim. In the order given. */
export function expiredAmong(
  reservations: readonly CreditReservation[],
  now: string,
): readonly CreditReservation[] {
  return Object.freeze(reservations.filter((reservation) => isExpired(reservation, now)));
}

/**
 * Move a reservation to expired, refusing a second attempt.
 *
 * The transition table already forbids it; this is the call site that names the
 * reservation, because "invalid transition" without an id is a page nobody can
 * act on.
 */
export function assertExpirable(reservation: CreditReservation, now: string): void {
  if (reservation.status !== ACTIVE_RESERVATION_STATUS) {
    throw new HoldError(
      'InvalidHoldState',
      `Reservation '${reservation.reservationId}' is ${reservation.status}; only an active reservation expires, and one that has already closed cannot become active again.`,
    );
  }
  if (reservation.expiresAt > now) {
    throw new HoldError(
      'InvalidHoldState',
      `Reservation '${reservation.reservationId}' expires at ${reservation.expiresAt}, which is after ${now}. Expiring it early would release credits a live run is still counting on.`,
    );
  }
}
