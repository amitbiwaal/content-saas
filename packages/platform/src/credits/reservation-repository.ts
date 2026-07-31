/**
 * The reservation port — interfaces, and nothing else.
 *
 * ── Why this exists beside `credits-service.ts` ────────────────────────────
 * `authorizeSpend`, `settle`, `release` and the TTL sweep are SQL-shaped on
 * purpose: a reservation, its audit record and its outbox event land on ONE
 * transaction handle, and `SELECT … FOR UPDATE` is what makes two concurrent
 * runs unable to reserve the same credits. None of that should be abstracted
 * away, and this does not try to.
 *
 * What has no answer today is everything that wants to READ reservations with
 * no database in the room: a sweep planner deciding what to expire, a
 * reconciliation checking that available matches the ledger, a test, a report.
 * Each of those either grows its own SQL — a second place a reservation's shape
 * is written down — or it gets a port.
 *
 * ── It never touches the ledger ────────────────────────────────────────────
 * There is no entry, no amount posted and no balance written anywhere on this
 * interface. A reservation is operational state; the money is the ledger's, and
 * an interface that could do both would eventually be used to do both.
 *
 * ── It never consumes ──────────────────────────────────────────────────────
 * There is deliberately no `consumeReservation` and no `recordConsumption`.
 * Consumption writes a ledger debit, which is the one thing this layer must not
 * do — and the frozen `credits-service.ts` already owns it, atomically, which
 * is the only way it can be done correctly.
 *
 * ── No database, no clock ──────────────────────────────────────────────────
 * No driver, no SQL, no transaction handle. `expireReservation` takes the
 * instant it should record, because a store that read its own clock would make
 * a sweep and a reader disagree about whether a reservation had expired.
 */

import type { CreditReservation, ReservationId, ReservationStatus } from './reservation.js';

/** Where a page of reservations continues from. Keyset, never an offset. */
export interface ReservationPosition {
  readonly createdAt: string;
  readonly reservationId: ReservationId;
}

/**
 * What a reservation listing narrows by.
 *
 * Explicit nulls rather than optionals: an implementer sees every dimension it
 * must handle, including the ones that are off. A filter quietly ignored here
 * is one organization's availability computed from another's reservations.
 */
export interface ReservationQuery {
  /** Required. Availability is an organization-level question. */
  readonly organizationId: string;
  /** Attribution. Null lists the whole organization. */
  readonly workspaceId: string | null;
  /** The run a reservation belongs to. */
  readonly executionId: string | null;
  /** Match any. Null lists every status. Never an empty array. */
  readonly statuses: readonly ReservationStatus[] | null;
  /**
   * Only reservations already past their TTL at this instant.
   *
   * What a sweep asks for. Null means "whatever their TTL says".
   */
  readonly expiredAt: string | null;
  readonly after: ReservationPosition | null;
  readonly limit: number;
}

export interface ReservationSlice {
  /** Oldest first. A sweep works through the longest-held first. */
  readonly reservations: readonly CreditReservation[];
}

/** What it takes to reserve. The store assigns nothing it was not given. */
export interface NewReservation {
  readonly reservationId: ReservationId;
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly executionId: string;
  /** The reserved maximum — the bound on worst-case spend. */
  readonly amount: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly reason: string;
  readonly correlationId: string;
  readonly createdBy: string | null;
  readonly attributes: Readonly<Record<string, unknown>>;
}

export interface CloseReservationInput {
  readonly organizationId: string;
  readonly reservationId: ReservationId;
  /** Supplied, never read from a clock here. */
  readonly at: string;
}

export interface CreditReservationRepository {
  /**
   * Take a reservation.
   *
   * Idempotent on `executionId` within an organization: a retried run must
   * reserve once, and returning the reservation that already exists is what
   * makes the retry converge rather than double-reserve.
   *
   * A store that cannot check availability atomically with the insert must
   * refuse rather than over-commit — two concurrent runs reserving the last
   * credits is precisely what this layer exists to prevent.
   */
  createReservation(reservation: NewReservation): Promise<CreditReservation>;

  /** One reservation, or null when the organization has no such row. */
  loadReservation(
    organizationId: string,
    reservationId: ReservationId,
  ): Promise<CreditReservation | null>;

  /**
   * Give the credits back.
   *
   * By arithmetic: the reservation stops being ACTIVE, so it stops being
   * subtracted. There is no compensating write, and no window in which the
   * credits are counted twice.
   */
  releaseReservation(input: CloseReservationInput): Promise<CreditReservation>;

  /**
   * Reclaim one whose TTL has elapsed.
   *
   * Separate from release because they mean different things to an operator: a
   * release is a run that ended, and an expiry is usually a run that was lost.
   * A store must refuse a second expiry rather than restamping the first.
   */
  expireReservation(input: CloseReservationInput): Promise<CreditReservation>;

  listReservations(query: ReservationQuery): Promise<ReservationSlice>;
}
