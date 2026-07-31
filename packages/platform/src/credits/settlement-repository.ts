/**
 * The settlement port — interfaces, and nothing else.
 *
 * ── Why this exists beside `settle()` ──────────────────────────────────────
 * The frozen `credits-service.ts` closes reservations atomically, and must:
 * the state change and its outbox event land on ONE transaction handle, and
 * `AND state = 'held'` inside the UPDATE is what makes the guard and the write
 * a single statement two concurrent closes cannot both win. None of that is
 * abstracted here.
 *
 * What has no answer is reading settlements back with no database in the room:
 * a billing period asking what was reserved and what came back, a
 * reconciliation checking that available matches the ledger, a cost report, a
 * test. Each of those either grows its own SQL — a second place a settlement's
 * shape is written down — or it gets a port.
 *
 * ── It closes. It never posts ──────────────────────────────────────────────
 * There is no entry, no amount posted, no refund and no balance written
 * anywhere on this interface. Settlement gives credits back BY ARITHMETIC: a
 * reservation that stops being active stops being subtracted. An interface that
 * could post a compensating entry would eventually be used to, and the same
 * credits would be returned twice.
 *
 * ── It closes once ─────────────────────────────────────────────────────────
 * There is no update, no delete and no reopen, and no way to add one without
 * changing the file. A closed reservation is terminal in the S5.2 machine;
 * an interface that could move it back would be a second reservation model.
 *
 * ── No database, no clock, no ids ─────────────────────────────────────────
 * No driver, no SQL, no transaction handle. `settleReservation` takes a
 * `ReservationSettlement` the pure guards already produced — including the
 * instant it closed — so a store cannot be handed a settlement the guards would
 * have refused, and cannot stamp one with a clock a reader disagrees with.
 */

import type {
  ReservationSettlement,
  SettlementClosure,
  SettlementId,
  SettlementStatus,
} from './settlement.js';

/** Where a page of settlements continues from. Keyset, never an offset. */
export interface SettlementPosition {
  readonly settledAt: string;
  readonly settlementId: SettlementId;
}

/**
 * What a settlement listing narrows by.
 *
 * Explicit nulls rather than optionals: an implementer sees every dimension it
 * must handle, including the ones that are off. A filter quietly ignored here
 * reports one client's released credits against another's account.
 */
export interface SettlementQuery {
  /** Required. Credits are an organization-level question. */
  readonly organizationId: string;
  /** Attribution. Null reads the whole organization. */
  readonly workspaceId: string | null;
  readonly executionId: string | null;
  /** Match any. Null lists every closure. Never an empty array. */
  readonly statuses: readonly SettlementStatus[] | null;
  /** Inclusive. */
  readonly settledAfter: string | null;
  /** Exclusive, so adjacent billing periods never count one release twice. */
  readonly settledBefore: string | null;
  readonly after: SettlementPosition | null;
  readonly limit: number;
}

export interface SettlementSlice {
  /** Oldest first: a billing period is read forwards. */
  readonly settlements: readonly ReservationSettlement[];
}

export interface SettlementRepository {
  /**
   * Close a reservation.
   *
   * Atomic, or nothing: the state change and whatever the store publishes about
   * it are one write. A store that cannot do both together must refuse rather
   * than close a reservation nothing downstream learns about.
   *
   * Guarded, not checked-then-written: the transition must be conditional on the
   * reservation still being ACTIVE, so two concurrent closes cannot both
   * succeed. The one that loses reports `converged` — or `diverged`, when it
   * finds the reservation closed some other way — and neither is an error.
   *
   * Appends nothing. The unspent credits were never deducted; they become
   * available again because the reservation stops being subtracted.
   */
  settleReservation(settlement: ReservationSettlement): Promise<SettlementClosure>;

  /** One settlement, or null when the organization has no such closed reservation. */
  loadSettlement(
    organizationId: string,
    settlementId: SettlementId,
  ): Promise<ReservationSettlement | null>;

  listSettlements(query: SettlementQuery): Promise<SettlementSlice>;
}
