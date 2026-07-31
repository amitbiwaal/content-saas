/**
 * Settlement, as a value: what a consumption is, and when one is allowed.
 *
 * ── Why this exists beside `recordConsumption` ─────────────────────────────
 * The frozen `credits-service.ts` already settles, and settles carefully: a row
 * lock serialises concurrent charges, an idempotency lookup converges a retry
 * BEFORE the bound is checked, the ledger's unique index decides whether the
 * charge is new, and `consumed` advances from the result rather than from the
 * request. All of that is SQL-shaped for good reasons and none of it is
 * abstracted away here.
 *
 * What it does not have is the pipeline stated as a function. "Which
 * reservations may be consumed" lives inside one 90-line method, so it cannot
 * be asked without a database, and the four refusals the increment names —
 * unknown, released, expired, already consumed — cannot be enumerated in a
 * test. `planConsumption` is those guards, and nothing else.
 *
 * ── It plans. It does not write ────────────────────────────────────────────
 * There is no append, no update and no transaction anywhere in this module. A
 * plan says what a settlement WOULD record; the frozen service is what records
 * it, atomically, which is the only way it can be done correctly.
 *
 * ── A consumption is a ledger entry, not a second record ───────────────────
 * `CreditConsumption` is a projection of one immutable `consumption` entry plus
 * the reservation it was charged against. There is no consumption table, no
 * second id and no second amount — the entry IS the financial fact, and this
 * only names its parts in the commercial vocabulary.
 *
 * ── One consumption does not close a reservation ───────────────────────────
 * A run charges per step and settles once at the end: `recordConsumption`
 * advances `consumed`, and `settle` closes the hold. The increment's pipeline
 * reads as one-charge-then-terminal, and for a single-step run it is — but a
 * multi-step workflow is the ordinary case here, and a model that closed the
 * reservation on the first charge could not express it.
 */

import { compareAmounts, formatAmount, parseAmount, subtractAmounts } from './amount.js';
import { assertFitsWithinHold, HoldError, remainingOf, type CreditHold } from './holds.js';
import type { LedgerEntry } from './ledger.js';
import type { LedgerReason } from './reason.js';
import {
  ACTIVE_RESERVATION_STATUS,
  canTransition,
  toCreditReservation,
  type CreditReservation,
  type ReservationId,
} from './reservation.js';

/**
 * A consumption's identity.
 *
 * The LEDGER ENTRY's id. A consumption has no identity of its own because it is
 * not a record of its own: the entry is the financial fact, and a second id
 * would be a second thing to reconcile against it.
 */
export type ConsumptionId = string;

/**
 * The reason a consumption records as.
 *
 * A narrowing of the S5.1 vocabulary, not a new one. There is exactly one
 * reason a consumption entry can carry, and expressing that as a type means a
 * projection cannot be built claiming a consumption that records a grant.
 */
export type ConsumptionReason = Extract<LedgerReason, 'CREDIT_CONSUMPTION'>;

export const CONSUMPTION_REASON: ConsumptionReason = 'CREDIT_CONSUMPTION';

/**
 * One consumption.
 *
 * Everything the increment names, taken from the entry and the reservation it
 * was charged against — and nothing invented. `reservationId` and `executionId`
 * come from the metadata the frozen service already writes onto every
 * consumption entry.
 */
export interface CreditConsumption {
  readonly consumptionId: ConsumptionId;
  readonly reservationId: ReservationId;
  /** The run this charge belongs to. */
  readonly executionId: string;
  readonly organizationId: string;
  /** Where the work happened. Consumption is always attributed. */
  readonly workspaceId: string;
  readonly amount: string;
  readonly reason: ConsumptionReason;
  /** What the caller said it was for. Free text, never interpreted. */
  readonly note: string;
  /** The key that makes a retried charge charge once. */
  readonly idempotencyKey: string | null;
  readonly correlationId: string;
  readonly createdAt: string;
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

const readString = (metadata: Readonly<Record<string, unknown>>, key: string): string | null => {
  const value = metadata[key];
  return typeof value === 'string' && value.trim() !== '' ? value : null;
};

/**
 * A ledger entry, read as the consumption it is.
 *
 * Refuses an entry of any other type. A projection that accepted a grant and
 * called it a consumption would put a credit in a debit report, and nothing
 * downstream would be able to tell.
 */
export function toCreditConsumption(entry: LedgerEntry): CreditConsumption {
  if (entry.entryType !== 'consumption') {
    throw new HoldError(
      'InvalidHoldState',
      `Entry '${entry.id}' is a '${entry.entryType}', not a consumption. Reading it as one would put a ${entry.direction} in a spend report.`,
    );
  }
  if (entry.workspaceId === null) {
    // The database CHECKs this too; a consumption without attribution cannot be
    // reported per client, which is the whole reason the column is on the row.
    throw new HoldError(
      'InvalidHoldState',
      `Consumption '${entry.id}' names no workspace. Attribution is what makes per-client reporting possible.`,
    );
  }

  const reservationId = readString(entry.metadata, 'holdId');
  const executionId = readString(entry.metadata, 'runId');

  if (reservationId === null || executionId === null) {
    throw new HoldError(
      'HoldNotFound',
      `Consumption '${entry.id}' does not record which reservation or run it was charged against. Every consumption is settled against a reservation.`,
    );
  }

  return deepFreeze({
    consumptionId: entry.id,
    reservationId,
    executionId,
    organizationId: entry.organizationId,
    workspaceId: entry.workspaceId,
    amount: entry.amount,
    reason: CONSUMPTION_REASON,
    note: entry.reason,
    idempotencyKey: entry.idempotencyKey,
    correlationId: entry.correlationId,
    createdAt: entry.createdAt,
  });
}

// ── The settlement pipeline, as guards ──────────────────────────────────────

/**
 * May this reservation be charged against at all?
 *
 * The four refusals the increment names, in one place. Unknown is the caller's
 * to check — this cannot refuse a reservation it was never given — so
 * `planConsumption` handles null and this handles the three states.
 */
export function assertConsumable(reservation: CreditReservation): void {
  if (reservation.status === ACTIVE_RESERVATION_STATUS) return;

  if (!canTransition(reservation.status, 'consume')) {
    throw new HoldError(
      'HoldNotOpen',
      `Reservation '${reservation.reservationId}' is ${reservation.status}; only an active reservation may be consumed, and a ${reservation.status} one is terminal. A charge arriving now is two deciders disagreeing, not a state change.`,
    );
  }
}

export interface ConsumptionCommand {
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly executionId: string;
  readonly reservationId: ReservationId;
  readonly amount: string;
  /**
   * Required. Derived from `(workflow, step, attempt-invariant)` so a retry of
   * one AI call converges instead of charging twice — an unkeyed consumption
   * has no way to converge, and the ledger has no UPDATE path to fix it after.
   */
  readonly idempotencyKey: string;
  readonly note: string;
}

/**
 * What a settlement would record, and whether it may.
 *
 * Pure. Every figure is derived from the command and the reservation, and
 * nothing here reads a clock, generates an id or touches a store.
 */
export interface SettlementPlan {
  readonly reservationId: ReservationId;
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly executionId: string;
  /** Exactly one entry, of exactly this type. */
  readonly reason: ConsumptionReason;
  readonly amount: string;
  readonly idempotencyKey: string;
  readonly note: string;
  /** The reservation's unspent balance after this charge. */
  readonly remainingAfter: string;
  /** True when this charge fills the reservation exactly. */
  readonly exhausts: boolean;
}

const requireField = (value: unknown, field: string, why: string): string => {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HoldError('ConsumptionMismatch', `'${field}' is required: ${why}`);
  }
  return value;
};

/**
 * Validate a settlement and say what it would record.
 *
 * The reservation is passed as the value it is, so the guards are checkable
 * without a database. Ordering matters and mirrors the frozen service's: the
 * reservation must exist, then be consumable, then the identifiers must agree,
 * then the amount must fit.
 */
export function planConsumption(options: {
  readonly command: ConsumptionCommand;
  /** Null when the store had no such reservation. */
  readonly reservation: CreditReservation | null;
}): SettlementPlan {
  const { command, reservation } = options;

  requireField(
    command.idempotencyKey,
    'idempotencyKey',
    'a retried AI call must converge rather than charge twice, and the ledger has no UPDATE path to correct a double charge.',
  );
  requireField(command.note, 'note', 'every ledger entry says why it exists.');

  if (reservation === null) {
    throw new HoldError(
      'HoldNotFound',
      `Reservation '${command.reservationId}' does not exist. Every code path that spends must hold a valid reservation.`,
    );
  }

  assertConsumable(reservation);

  // Identity, before money. A charge recorded against the right reservation but
  // the wrong workspace is attributed to the wrong client, permanently.
  if (reservation.organizationId !== command.organizationId) {
    throw new HoldError(
      'ConsumptionMismatch',
      `Reservation '${reservation.reservationId}' belongs to organization '${reservation.organizationId}', not '${command.organizationId}'.`,
    );
  }
  if (reservation.workspaceId !== command.workspaceId) {
    throw new HoldError(
      'ConsumptionMismatch',
      `Reservation '${reservation.reservationId}' is attributed to workspace '${reservation.workspaceId}', not '${command.workspaceId}'. A charge filed under the wrong workspace bills the wrong client.`,
    );
  }
  if (reservation.executionId !== command.executionId) {
    throw new HoldError(
      'ConsumptionMismatch',
      `Reservation '${reservation.reservationId}' is for run '${reservation.executionId}', not '${command.executionId}'.`,
    );
  }
  if (reservation.reservationId !== command.reservationId) {
    throw new HoldError(
      'ConsumptionMismatch',
      `The command names reservation '${command.reservationId}' and the reservation supplied is '${reservation.reservationId}'.`,
    );
  }

  const amount = parseAmount(command.amount);

  // The frozen bound: a consumption must fit inside its reservation, which is
  // what makes the reservation a real ceiling on worst-case spend.
  assertFitsWithinHold(asHold(reservation), amount);

  const remainingAfter = subtractAmounts(parseAmount(reservation.remaining), amount);

  return deepFreeze({
    reservationId: reservation.reservationId,
    organizationId: reservation.organizationId,
    workspaceId: reservation.workspaceId,
    executionId: reservation.executionId,
    reason: CONSUMPTION_REASON,
    amount: command.amount,
    idempotencyKey: command.idempotencyKey,
    note: command.note,
    remainingAfter: formatAmount(remainingAfter),
    exhausts: compareAmounts(remainingAfter, parseAmount('0')) === 0,
  });
}

/**
 * The shape `assertFitsWithinHold` expects.
 *
 * The frozen guard takes a hold, and a reservation is a projection of one. This
 * rebuilds only the three fields it reads, so the bound stays the frozen rule
 * rather than a copy of it — a second implementation of "does this charge fit"
 * is the one thing here worth not having twice.
 */
function asHold(reservation: CreditReservation): CreditHold {
  return {
    id: reservation.reservationId,
    tenantId: reservation.organizationId,
    organizationId: reservation.organizationId,
    workspaceId: reservation.workspaceId,
    runId: reservation.executionId,
    amount: reservation.amount,
    consumed: reservation.consumed,
    state: 'held',
    expiresAt: reservation.expiresAt,
    reason: reservation.metadata.reason,
    correlationId: reservation.metadata.correlationId,
    createdBy: reservation.metadata.createdBy,
    metadata: reservation.metadata.attributes,
    createdAt: reservation.createdAt,
    settledAt: null,
    releasedAt: null,
  };
}

// ── The outcome ─────────────────────────────────────────────────────────────

/**
 * What a settlement did.
 *
 * `converged` is not a failure: a retried AI call that finds its charge already
 * recorded has succeeded, and nothing moves — no second entry, no second event,
 * and `consumed` stays where the winning call left it. Reporting that as an
 * error would turn every Temporal retry into an incident.
 *
 * Named `SettlementResult` rather than `ConsumptionResult`, which the frozen
 * service already exports for its own richer shape. See the conformance
 * deviation.
 */
export type SettlementResult =
  | {
      readonly outcome: 'recorded';
      readonly consumption: CreditConsumption;
      readonly reservation: CreditReservation;
    }
  | {
      readonly outcome: 'converged';
      readonly consumption: CreditConsumption;
      readonly reservation: CreditReservation;
    };

/**
 * The frozen service's result, in the commercial vocabulary.
 *
 * A projection, so the two can never disagree about what happened — `created`
 * is the only thing that decides which outcome this is.
 */
export function toSettlementResult(result: {
  readonly entry: LedgerEntry;
  readonly hold: CreditHold;
  readonly created: boolean;
}): SettlementResult {
  return Object.freeze({
    outcome: result.created ? ('recorded' as const) : ('converged' as const),
    consumption: toCreditConsumption(result.entry),
    reservation: toCreditReservation(result.hold),
  });
}

/** What is left of a reservation after a plan is applied. For a caller's UI. */
export function remainingAfter(reservation: CreditReservation, amount: string): string {
  return formatAmount(subtractAmounts(remainingOf(asHold(reservation)), parseAmount(amount)));
}
