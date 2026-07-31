/**
 * Closing a reservation, as a value: what a settlement is, and when one is
 * allowed.
 *
 * ── Why this exists beside `settle()` ──────────────────────────────────────
 * The frozen `credits-service.ts` already settles, and settles carefully. Its
 * `SETTLE_HOLD_SQL` carries `AND state = 'held'` in the WHERE, so the guard and
 * the write are one statement and two concurrent closes cannot both win. When
 * the update matches nothing it distinguishes a hold that never existed from
 * one that is already terminal, and converges on the second rather than
 * restamping it. It publishes `CreditSettled` carrying `amount − consumed` on
 * the same transaction handle. None of that is abstracted away here.
 *
 * What it does not have is the settlement stated as a value. `released` is
 * computed inline, in a callback, inside a SQL-shaped method, and thrown
 * straight into an event envelope — so "what did this reservation actually
 * cost, and how much came back" cannot be asked without a database, and the
 * refusals the increment names cannot be enumerated in a test.
 *
 * ── Settlement records nothing. That is the point ──────────────────────────
 * A settlement appends no ledger entry. It writes no refund. The credits that
 * were never spent were never deducted — available balance is
 * `ledger balance − unspent ACTIVE reservations`, so a reservation that stops
 * being active stops being subtracted, in the same instant, with nothing to
 * compensate for and no window in which the credits are counted twice.
 *
 * `released` is therefore a REPORT, not a movement. It says how much the
 * reservation stopped holding down. Nothing anywhere needs to post it.
 *
 * ── SETTLED is `consumed`, not a fifth status ──────────────────────────────
 * The database stores `held | settled | released | expired`. S5.2 named those
 * commercially: ACTIVE, CONSUMED, RELEASED, EXPIRED. This increment's SETTLED
 * is that CONSUMED — the state a reservation reaches when execution finished
 * and the hold closed. `SettlementStatus` is therefore a NARROWING of the S5.2
 * vocabulary, not a third naming of the same four facts.
 *
 * ── A settlement is not a second record ────────────────────────────────────
 * `SettlementId` is the reservation's id. There is no settlement table, no
 * second amount and no second lifecycle: the closed reservation IS the
 * settlement, and this only reads it in the vocabulary the increment asks for.
 */

import {
  addAmounts,
  compareAmounts,
  formatAmount,
  parseAmount,
  subtractAmounts,
  ZERO,
  type ScaledAmount,
} from './amount.js';
import { HoldError, OPEN_HOLD_STATE, type CreditHold } from './holds.js';
import {
  ACTIVE_RESERVATION_STATUS,
  canTransition,
  RESERVATION_TRANSITIONS,
  statusOf,
  type CreditReservation,
  type ReservationId,
  type ReservationStatus,
} from './reservation.js';

/**
 * A settlement's identity.
 *
 * The RESERVATION's id. A settlement has no identity of its own because it is
 * not a record of its own: the closed reservation is the fact, and a second id
 * would be a second thing to reconcile against it.
 */
export type SettlementId = ReservationId;

/**
 * How a reservation was finalized.
 *
 * A narrowing of the S5.2 vocabulary to its terminal members, not a new one —
 * the same discipline `ConsumptionReason` applies to entry types. `consumed` is
 * what this increment calls SETTLED: execution finished and the hold closed.
 * `released` and `expired` are the other two ways a reservation stops holding
 * credits down, and a settlement report that could not describe them would send
 * every reader back to the hold table.
 */
export type SettlementStatus = Extract<ReservationStatus, 'consumed' | 'released' | 'expired'>;

/**
 * The three, in order of how a reader thinks about them.
 *
 * Asserted against `TERMINAL_RESERVATION_STATUSES` in the conformance test, so
 * a status added to the machine cannot silently go unreported here.
 */
export const SETTLEMENT_STATUSES: readonly SettlementStatus[] = Object.freeze([
  'consumed',
  'released',
  'expired',
]);

/** The status this increment's SETTLED means, in the S5.2 vocabulary. */
export const SETTLED_STATUS: SettlementStatus = 'consumed';

export function isSettlementStatus(value: unknown): value is SettlementStatus {
  return typeof value === 'string' && (SETTLEMENT_STATUSES as readonly string[]).includes(value);
}

/**
 * How much of the reservation the execution actually needed.
 *
 * The three cases the increment names, as one fact rather than three amount
 * comparisons a caller has to get right.
 */
export type SettlementUsage = 'unused' | 'partial' | 'exhausted';

/**
 * The settlement arithmetic, and nothing else.
 *
 *     released = reserved − consumed
 *
 * All three are carried rather than just the difference: an operator looking at
 * a run that reserved 100 and released 99 needs to see both figures to know the
 * estimate was wrong, and `released` alone cannot tell them.
 */
export interface SettlementSummary {
  /** The reserved maximum — the bound the execution was admitted against. */
  readonly reserved: string;
  /** What became immutable ledger debits. Never given back. */
  readonly consumed: string;
  /** `reserved − consumed`. Available again by arithmetic; never posted. */
  readonly released: string;
  readonly usage: SettlementUsage;
}

/**
 * One settled reservation.
 *
 * A projection of a closed hold in the commercial vocabulary. Extends the
 * summary rather than nesting it, so the amounts read flat at the call site and
 * there is still exactly one type that means "the settlement arithmetic".
 */
export interface ReservationSettlement extends SettlementSummary {
  readonly settlementId: SettlementId;
  /** The same value. Both names exist because both are asked for. */
  readonly reservationId: ReservationId;
  /** The run this reservation was taken for. */
  readonly executionId: string;
  readonly organizationId: string;
  /** Where the work happened. Attribution, as on a consumption entry. */
  readonly workspaceId: string;
  readonly status: SettlementStatus;
  /** When the reservation closed. Supplied, never read from a clock. */
  readonly settledAt: string;
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

function usageOf(consumed: ScaledAmount, released: ScaledAmount): SettlementUsage {
  // Zero consumption first: a reservation of nothing, consumed for nothing, is
  // unused rather than exhausted. Nothing was spent either way.
  if (compareAmounts(consumed, ZERO) === 0) return 'unused';
  return compareAmounts(released, ZERO) === 0 ? 'exhausted' : 'partial';
}

/**
 * `released = reserved − consumed`, refusing the impossible.
 *
 * Pure, and total over its refusals. The database CHECKs `consumed <= amount`
 * and `assertFitsWithinHold` guards every charge, so a negative release should
 * be unreachable — but "should be unreachable" is exactly the arithmetic worth
 * asserting, because the figure it produces is what a customer is told came
 * back to them.
 */
export function computeSettlement(input: {
  readonly reserved: string;
  readonly consumed: string;
}): SettlementSummary {
  const reserved = parseAmount(input.reserved);
  const consumed = parseAmount(input.consumed);

  if (compareAmounts(consumed, reserved) === 1) {
    throw new HoldError(
      'HoldExceeded',
      `A reservation of ${input.reserved} cannot have consumed ${input.consumed}. Settling it would report a negative release, which would tell the customer credits came back that were never held.`,
    );
  }

  const released = subtractAmounts(reserved, consumed);

  return deepFreeze({
    reserved: formatAmount(reserved),
    consumed: formatAmount(consumed),
    released: formatAmount(released),
    usage: usageOf(consumed, released),
  });
}

// ── The settlement pipeline, as guards ──────────────────────────────────────

/**
 * May this reservation be settled at all?
 *
 * The refusals the increment names, in one place. Unknown is the caller's to
 * check — this cannot refuse a reservation it was never given — so
 * `planSettlement` handles null and this handles the three terminal states.
 *
 * A settle arriving for a released or expired reservation is not a late
 * success. It is two deciders disagreeing about how a run ended, and answering
 * it by closing the reservation a second way would make the disagreement
 * invisible.
 */
export function assertSettleable(reservation: CreditReservation): void {
  if (reservation.status === ACTIVE_RESERVATION_STATUS) return;

  if (!canTransition(reservation.status, 'consume')) {
    throw new HoldError(
      'HoldNotOpen',
      reservation.status === SETTLED_STATUS
        ? `Reservation '${reservation.reservationId}' is already settled. Settling it again would restamp a closed reservation and report its release a second time.`
        : `Reservation '${reservation.reservationId}' is ${reservation.status}; only an active reservation may be settled, and a ${reservation.status} one is terminal.`,
    );
  }
}

export interface SettlementCommand {
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly executionId: string;
  readonly reservationId: ReservationId;
  /**
   * When the reservation closes. Supplied, never read from a clock here — a
   * settlement a store timestamped itself could not be asserted on, and two
   * readers would disagree about which billing period it fell in.
   */
  readonly settledAt: string;
}

const requireField = (value: unknown, field: string, why: string): string => {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HoldError('SettlementMismatch', `'${field}' is required: ${why}`);
  }
  return value;
};

/**
 * Validate a settlement and say what closing this reservation means.
 *
 * The reservation is passed as the value it is, so the guards are checkable
 * without a database. Ordering mirrors `planConsumption`'s and the frozen
 * service's: the reservation must exist, then be settleable, then the
 * identifiers must agree, then the arithmetic must hold.
 *
 * Identity before money, for the same reason as in consumption: a settlement
 * filed against the right reservation but the wrong workspace credits the
 * release back to the wrong client's report.
 */
export function planSettlement(options: {
  readonly command: SettlementCommand;
  /** Null when the store had no such reservation. */
  readonly reservation: CreditReservation | null;
}): ReservationSettlement {
  const { command, reservation } = options;

  requireField(
    command.settledAt,
    'settledAt',
    'a settlement records when the reservation closed, and a store that timestamped it would make two readers disagree about the billing period.',
  );

  if (reservation === null) {
    throw new HoldError(
      'HoldNotFound',
      `Reservation '${command.reservationId}' does not exist. A run that spent credits held a reservation; one that did not has nothing to settle.`,
    );
  }

  assertSettleable(reservation);

  if (reservation.organizationId !== command.organizationId) {
    throw new HoldError(
      'SettlementMismatch',
      `Reservation '${reservation.reservationId}' belongs to organization '${reservation.organizationId}', not '${command.organizationId}'.`,
    );
  }
  if (reservation.workspaceId !== command.workspaceId) {
    throw new HoldError(
      'SettlementMismatch',
      `Reservation '${reservation.reservationId}' is attributed to workspace '${reservation.workspaceId}', not '${command.workspaceId}'. A release credited to the wrong workspace reports against the wrong client.`,
    );
  }
  if (reservation.executionId !== command.executionId) {
    throw new HoldError(
      'SettlementMismatch',
      `Reservation '${reservation.reservationId}' is for run '${reservation.executionId}', not '${command.executionId}'.`,
    );
  }
  if (reservation.reservationId !== command.reservationId) {
    throw new HoldError(
      'SettlementMismatch',
      `The command names reservation '${command.reservationId}' and the reservation supplied is '${reservation.reservationId}'.`,
    );
  }

  const summary = computeSettlement({
    reserved: reservation.amount,
    consumed: reservation.consumed,
  });

  return deepFreeze({
    ...summary,
    settlementId: reservation.reservationId,
    reservationId: reservation.reservationId,
    executionId: reservation.executionId,
    organizationId: reservation.organizationId,
    workspaceId: reservation.workspaceId,
    // A settled reservation is `consumed` in the S5.2 vocabulary. `planSettlement`
    // is the settle path, so this is the only status it can produce; a release
    // and an expiry reach `toReservationSettlement` from their own closed rows.
    status: SETTLED_STATUS,
    settledAt: command.settledAt,
  });
}

/**
 * A closed hold, read as the settlement it is.
 *
 * Refuses an OPEN hold. A settlement report built from a reservation still in
 * flight would show credits as released while a run is still entitled to spend
 * them, and the same reservation would then be reported closed a second time.
 */
export function toReservationSettlement(hold: CreditHold): ReservationSettlement {
  if (hold.state === OPEN_HOLD_STATE) {
    throw new HoldError(
      'HoldNotOpen',
      `Reservation '${hold.id}' is still open. A settlement describes a reservation that has stopped holding credits down; this one has not.`,
    );
  }

  const status = statusOf(hold.state);
  if (!isSettlementStatus(status)) {
    // Unreachable while the machine has one open state, and worth asserting: a
    // second open state added later must not be reported as a settlement.
    throw new HoldError(
      'InvalidHoldState',
      `Reservation '${hold.id}' is '${status}', which is not a way a reservation closes.`,
    );
  }

  // `settled_at` for a settle, `released_at` for a release or an expiry — the
  // frozen service stamps exactly one of them, per closure.
  const closedAt = hold.settledAt ?? hold.releasedAt;
  if (closedAt === null) {
    throw new HoldError(
      'InvalidHoldState',
      `Reservation '${hold.id}' is ${hold.state} but records no instant at which it closed. A settlement with no time cannot be placed in a billing period.`,
    );
  }

  const summary = computeSettlement({ reserved: hold.amount, consumed: hold.consumed });

  return deepFreeze({
    ...summary,
    settlementId: hold.id,
    reservationId: hold.id,
    executionId: hold.runId,
    organizationId: hold.organizationId,
    workspaceId: hold.workspaceId,
    status,
    settledAt: closedAt,
  });
}

// ── The outcome ─────────────────────────────────────────────────────────────

/**
 * What settling did.
 *
 * `converged` is not a failure: an orchestrator retrying its end-of-run settle
 * finds the reservation already closed the same way, and nothing moves.
 *
 * `diverged` is the case the frozen service's comment worries about and cannot
 * currently name — the reservation is closed, but as a RELEASE or an EXPIRY.
 * Something decided the run failed, or the TTL sweep reclaimed it, while this
 * caller believed it succeeded. The credits are correct either way; what is
 * wrong is that two deciders disagreed, and reporting it as an ordinary retry
 * would hide that.
 */
export type SettlementClosure =
  | { readonly outcome: 'settled'; readonly settlement: ReservationSettlement }
  | { readonly outcome: 'converged'; readonly settlement: ReservationSettlement }
  | { readonly outcome: 'diverged'; readonly settlement: ReservationSettlement };

/**
 * The frozen service's `HoldClosureResult`, in the commercial vocabulary.
 *
 * A projection, so the two can never disagree about what happened: `converged`
 * and the hold's own state are the only things that decide the outcome.
 */
export function toSettlementClosure(result: {
  readonly hold: CreditHold;
  readonly converged: boolean;
}): SettlementClosure {
  const settlement = toReservationSettlement(result.hold);

  if (!result.converged) {
    return Object.freeze({ outcome: 'settled' as const, settlement });
  }

  return Object.freeze({
    outcome: settlement.status === SETTLED_STATUS ? ('converged' as const) : ('diverged' as const),
    settlement,
  });
}

/**
 * What a set of settlements released in total.
 *
 * A report, and the reason `SettlementSummary` is its own type: a billing
 * period asks the same three questions of many reservations that one
 * reservation answers about itself.
 */
export function summarizeSettlements(
  settlements: readonly ReservationSettlement[],
): SettlementSummary {
  let reserved: ScaledAmount = ZERO;
  let consumed: ScaledAmount = ZERO;

  for (const settlement of settlements) {
    reserved = addAmounts(reserved, parseAmount(settlement.reserved));
    consumed = addAmounts(consumed, parseAmount(settlement.consumed));
  }

  return computeSettlement({
    reserved: formatAmount(reserved),
    consumed: formatAmount(consumed),
  });
}

/** What a reservation would release if it were settled now. For a caller's UI. */
export function releasableOf(reservation: CreditReservation): string {
  return computeSettlement({ reserved: reservation.amount, consumed: reservation.consumed })
    .released;
}

/**
 * Does settling this reservation close it for good?
 *
 * Always true, and stated as a function because the increment asks for it: the
 * transition table has no edge back into `active`, so a settled reservation can
 * never reserve, consume or release again.
 */
export function closesPermanently(status: SettlementStatus): boolean {
  return RESERVATION_TRANSITIONS.every((transition) => !canTransition(status, transition));
}
