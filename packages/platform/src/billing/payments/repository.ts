/**
 * The payment ports — interfaces, and nothing else.
 *
 * ── Append-only, both of them ──────────────────────────────────────────────
 * There is no update, no delete and no reprocess on either interface, and no
 * way to add one without changing this file. A payment customer's provider id
 * is assigned once by the provider; a webhook is a historical fact about what
 * an external system told us. Editing either would make the record disagree
 * with the provider, and `billing.md` is clear about who wins: "Stripe is the
 * source of truth for money."
 *
 * ── The dedupe guarantee lives here ────────────────────────────────────────
 * `billing.md` gives `provider_webhook_events` the constraint
 * `UNIQUE (provider, provider_event_id)` and calls it "the webhook dedupe
 * guarantee". `recordEvent` is that constraint expressed as a method: it
 * reports whether the event was new, and a redelivery converges rather than
 * failing — Stripe redelivers at least once, and an endpoint that errored on a
 * duplicate would make it retry for days.
 *
 * ── Nothing here touches the ledger ────────────────────────────────────────
 * No entry, no grant, no balance. `stripe.md` has a webhook eventually causing
 * a ledger credit, but that is a consumer of these records and a different
 * increment: "Do NOT grant credits. Do NOT mutate the ledger."
 *
 * ── No database, no clock, no ids ─────────────────────────────────────────
 * No driver, no SQL, no transaction handle. Every instant is on the record
 * already, put there by the provider.
 */

import type {
  PaymentCustomer,
  PaymentEvent,
  PaymentEventType,
  PaymentProviderId,
} from './provider.js';

// ── Payment customers ───────────────────────────────────────────────────────

export interface PaymentCustomerRepository {
  /**
   * Record the customer a provider created.
   *
   * Must refuse a second customer for one organization at one provider: two
   * would split a customer's payment history, and a charge would land on
   * whichever the caller happened to read.
   */
  recordCustomer(customer: PaymentCustomer): Promise<PaymentCustomer>;

  /** The customer for an organization at a provider, or null. */
  findCustomer(
    providerId: PaymentProviderId,
    organizationId: string,
  ): Promise<PaymentCustomer | null>;

  /**
   * The organization behind a provider's customer id.
   *
   * The direction a webhook needs: an event carries `cus_…` and the handler has
   * to know whose it is. Null when the provider knows a customer we do not —
   * one created in the provider's dashboard belongs to nobody here, and
   * guessing would attribute a payment to the wrong tenant.
   */
  findCustomerByExternalId(
    providerId: PaymentProviderId,
    externalCustomerId: string,
  ): Promise<PaymentCustomer | null>;
}

// ── Payment events ──────────────────────────────────────────────────────────

/** Where a page of events continues from. Keyset, never an offset. */
export interface PaymentEventPosition {
  readonly occurredAt: string;
  readonly eventId: string;
}

export interface PaymentEventQuery {
  readonly providerId: PaymentProviderId;
  /** Null reads across organizations — an operator view, not a customer one. */
  readonly organizationId: string | null;
  /** Match any. Null lists every type. Never an empty array. */
  readonly types: readonly PaymentEventType[] | null;
  readonly externalSubscriptionId: string | null;
  /** Inclusive. */
  readonly occurredAfter: string | null;
  /** Exclusive, so adjacent windows never count one event twice. */
  readonly occurredBefore: string | null;
  readonly after: PaymentEventPosition | null;
  readonly limit: number;
}

export interface PaymentEventSlice {
  /** Oldest first: an event log is read forwards. */
  readonly events: readonly PaymentEvent[];
}

/**
 * What recording an event did.
 *
 * `converged` is not a failure. The provider redelivers at least once, so
 * finding the event already recorded is the ordinary case for a retry, and the
 * caller's answer is the same either way: acknowledge it.
 */
export type RecordEventOutcome =
  | { readonly outcome: 'recorded'; readonly event: PaymentEvent }
  | { readonly outcome: 'converged'; readonly event: PaymentEvent };

export interface PaymentEventRepository {
  /**
   * Append one webhook.
   *
   * Idempotent on `(providerId, eventId)` — the store's unique constraint
   * decides, not a read-then-write, because two deliveries of one event can be
   * in flight at once.
   *
   * Appends only. There is no path here that updates an event, marks one
   * processed, or reprocesses it; those belong to whatever consumes this log.
   */
  recordEvent(event: PaymentEvent): Promise<RecordEventOutcome>;

  /** One event, or null when this provider has sent us no such id. */
  loadEvent(providerId: PaymentProviderId, eventId: string): Promise<PaymentEvent | null>;

  /** Has this event already been recorded? The dedupe question, asked directly. */
  hasEvent(providerId: PaymentProviderId, eventId: string): Promise<boolean>;

  listEvents(query: PaymentEventQuery): Promise<PaymentEventSlice>;
}
