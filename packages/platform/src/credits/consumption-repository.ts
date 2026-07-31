/**
 * The consumption port — interfaces, and nothing else.
 *
 * ── Why this exists beside `recordConsumption` ─────────────────────────────
 * The frozen `credits-service.ts` settles atomically, and must: the ledger
 * entry, the reservation's advanced `consumed`, the outbox event and the
 * balance projection land on ONE transaction handle, and a row lock is what
 * makes two concurrent charges against one reservation serialise. None of that
 * is abstracted here.
 *
 * What has no answer is reading consumption back with no database in the room:
 * a cost report, a reconciliation, an invoice run that needs to know what was
 * spent, a test. Each of those either grows its own SQL — a second place a
 * consumption's shape is written down — or it gets a port.
 *
 * ── `recordConsumption` here is the same operation, not a second one ───────
 * It takes a plan the pure guards produced and returns what happened. An
 * implementation is expected to be the frozen service, or something that
 * upholds the same contract: exactly one ledger entry, idempotent on the key,
 * and the reservation advanced from the result rather than from the request.
 *
 * ── It appends. It never amends ────────────────────────────────────────────
 * There is no update, no delete, no correction and no refund on this
 * interface — and no way to add one without changing the file. A ledger has no
 * UPDATE path; a mistake is corrected by a compensating entry, which is a
 * different operation belonging to a different increment.
 *
 * ── No database, no clock, no ids ─────────────────────────────────────────
 * No driver, no SQL, no transaction handle. The consumption id is the ledger
 * entry's, and the store assigns nothing it was not given.
 */

import type {
  SettlementPlan,
  SettlementResult,
  ConsumptionId,
  CreditConsumption,
} from './consumption.js';
import type { ReservationId } from './reservation.js';

/** Where a page of consumption history continues from. Keyset, never offset. */
export interface ConsumptionPosition {
  readonly createdAt: string;
  readonly consumptionId: ConsumptionId;
}

/**
 * What a consumption listing narrows by.
 *
 * Explicit nulls rather than optionals: an implementer sees every dimension it
 * must handle. A filter quietly ignored here is one client's spend reported
 * against another's account.
 */
export interface ConsumptionQuery {
  /** Required. Spend is an organization-level question. */
  readonly organizationId: string;
  /** Where the work happened. Null reads the whole organization. */
  readonly workspaceId: string | null;
  readonly executionId: string | null;
  readonly reservationId: ReservationId | null;
  /** Inclusive. */
  readonly createdAfter: string | null;
  /** Exclusive, so adjacent windows never count one charge twice. */
  readonly createdBefore: string | null;
  readonly after: ConsumptionPosition | null;
  readonly limit: number;
}

export interface ConsumptionSlice {
  /** Oldest first: spend is read forwards, because it is a history. */
  readonly consumptions: readonly CreditConsumption[];
}

export interface ConsumptionRepository {
  /**
   * Settle a plan.
   *
   * Atomic, or nothing: the ledger entry and the reservation's advanced
   * `consumed` are one write. An implementation that cannot do both together
   * must refuse rather than leave a charge recorded against a reservation that
   * does not know about it.
   *
   * Idempotent on the plan's key. A retry returns `converged` with the charge
   * that already exists — not an error, and not a second entry.
   */
  recordConsumption(plan: SettlementPlan): Promise<SettlementResult>;

  /** One consumption, or null when the organization has no such charge. */
  loadConsumption(
    organizationId: string,
    consumptionId: ConsumptionId,
  ): Promise<CreditConsumption | null>;

  listConsumption(query: ConsumptionQuery): Promise<ConsumptionSlice>;
}
