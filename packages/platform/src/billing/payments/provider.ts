/**
 * The `PaymentProvider` port — `09-integrations/stripe.md`, ADR-012.
 *
 * ```
 * Billing service --> Stripe adapter --> Stripe API
 *                                          |
 *                                       webhooks
 *                                          v
 *                              Webhook handler --> ledger + entitlements
 * ```
 *
 * This file is the PORT and its models. Concrete adapters live in
 * `./stripe/`, which the eslint config ALREADY names as the only place a
 * Stripe SDK may be imported — configured in Sprint 0, "even though no such
 * code exists yet: adding the rule after the first `fetch` lands means auditing
 * every call site." This is that code.
 *
 * ── The provider never owns commercial state ───────────────────────────────
 * `billing.md`: "Stripe is the source of truth for money; we are the source of
 * truth for entitlement." Nothing here changes a subscription's status, grants
 * a credit, or writes a ledger entry. A provider REPORTS what happened at the
 * provider; Billing decides what that means, and does so in a later increment.
 *
 * ── An external id is not our id ───────────────────────────────────────────
 * Every identifier a provider gives back is carried under an `external` name
 * and never used as one of ours. A `cus_…` that became an organization id
 * would make the provider the authority on tenancy.
 *
 * ── Failure is a value; malformation is not ────────────────────────────────
 * A declined card and a 502 are ordinary outcomes of asking an external system
 * for something — they are `PaymentResult` failures, so a caller must handle
 * them to read the value. A provider id we do not know, or a command whose
 * organization does not match its account, is a programming error and throws
 * `BillingError`. Two different kinds of wrong, answered two different ways.
 */

import type { BillingAccountId } from '../account.js';
import { BillingError } from '../errors.js';
import { deepFreeze } from '../immutable.js';
import type { SubscriptionId, SubscriptionStatus } from '../subscription.js';

/**
 * The providers this build knows.
 *
 * `stripe.md`: "Stripe is the v1 payment provider; Razorpay (India) is a
 * tracked future gateway" — behind this same interface.
 */
export const PAYMENT_PROVIDER_IDS = ['stripe'] as const;

export type PaymentProviderId = (typeof PAYMENT_PROVIDER_IDS)[number];

export function isPaymentProviderId(value: unknown): value is PaymentProviderId {
  return typeof value === 'string' && (PAYMENT_PROVIDER_IDS as readonly string[]).includes(value);
}

export function assertPaymentProviderId(value: unknown): PaymentProviderId {
  if (isPaymentProviderId(value)) return value;
  throw new BillingError(
    'UnknownProvider',
    `'${String(value)}' is not a payment provider this build knows. Available: ${PAYMENT_PROVIDER_IDS.join(', ')}.`,
  );
}

/** A customer at the provider, tied to one billing account. */
export interface PaymentCustomer {
  readonly providerId: PaymentProviderId;
  /** The provider's id for this customer. Never used as one of ours. */
  readonly externalCustomerId: string;
  readonly organizationId: string;
  readonly accountId: BillingAccountId;
  readonly createdAt: string;
}

/**
 * The two hosted surfaces.
 *
 * `billing.md`: "Plan changes go through provider-hosted checkout and portal
 * sessions, so card entry happens on Stripe's surface. This is the single
 * largest PCI-scope reduction available and is non-negotiable."
 */
export const PAYMENT_SESSION_KINDS = ['checkout', 'portal'] as const;

export type PaymentSessionKind = (typeof PAYMENT_SESSION_KINDS)[number];

export interface PaymentSession {
  readonly providerId: PaymentProviderId;
  readonly externalSessionId: string;
  readonly kind: PaymentSessionKind;
  readonly organizationId: string;
  /**
   * Where to send the customer. Provider-hosted and short-lived —
   * `billing.md` requires these are "generated per request; never stored or
   * emailed as permanent links".
   */
  readonly url: string;
  readonly expiresAt: string | null;
  readonly createdAt: string;
}

/**
 * What the provider knows about a subscription.
 *
 * A REPORT, not our `Subscription`. `status` is the provider's state
 * translated into our vocabulary so a caller can compare the two — comparing
 * is Billing's job, and disagreeing is what reconciliation is for.
 */
export interface PaymentSubscriptionRef {
  readonly providerId: PaymentProviderId;
  readonly externalSubscriptionId: string;
  readonly externalCustomerId: string;
  readonly organizationId: string;
  /** Our vocabulary. Translated in the adapter, never Stripe's string. */
  readonly status: SubscriptionStatus;
  readonly cancelAtPeriodEnd: boolean;
  readonly currentPeriodStart: string;
  readonly currentPeriodEnd: string;
}

/**
 * The webhook events this build maps.
 *
 * Exactly the six the increment names. Stripe sends dozens more; an event that
 * is not one of these is IGNORED rather than refused — see `WebhookOutcome`.
 */
export const PAYMENT_EVENT_TYPES = [
  'checkout_completed',
  'subscription_created',
  'subscription_updated',
  'subscription_cancelled',
  'invoice_paid',
  'invoice_payment_failed',
] as const;

export type PaymentEventType = (typeof PAYMENT_EVENT_TYPES)[number];

export function isPaymentEventType(value: unknown): value is PaymentEventType {
  return typeof value === 'string' && (PAYMENT_EVENT_TYPES as readonly string[]).includes(value);
}

/**
 * One webhook, translated.
 *
 * `eventId` is the PROVIDER's event id, and it is what deduplication keys on:
 * `stripe.md` — "Stripe redelivers at-least-once — handler is idempotent,
 * deduplicating by `event.id`". `billing.md` gives the table
 * `UNIQUE (provider, provider_event_id)` for exactly this.
 */
export interface PaymentEvent {
  readonly providerId: PaymentProviderId;
  readonly eventId: string;
  readonly type: PaymentEventType;
  /** The provider's own type string, kept for the audit trail. */
  readonly providerEventType: string;
  /** When the provider says it happened. Never when we read it. */
  readonly occurredAt: string;
  readonly externalCustomerId: string | null;
  readonly externalSubscriptionId: string | null;
  /**
   * Read from the provider's metadata, where we put it when we created the
   * object. Null when the event carries none — a customer created in the
   * provider's dashboard has no organization, and guessing one would attribute
   * a payment to the wrong tenant.
   */
  readonly organizationId: string | null;
  readonly subscriptionId: SubscriptionId | null;
}

/**
 * Why a provider call did not succeed.
 *
 * The four signals `stripe.md` §Error handling names, and no others. Each has
 * a documented behaviour there, so a fifth would be a case nobody decided.
 */
export const PAYMENT_FAILURE_REASONS = [
  /** Card declined / payment failed. Downgrade per grace policy, never delete. */
  'PaymentFailed',
  /** Signature mismatch. Reject and alert — a possible spoof. */
  'WebhookInvalid',
  /** API 429/5xx. Backoff and retry with the same idempotency key. */
  'ProviderUnavailable',
  /** Amount/ledger mismatch. Freeze and escalate to a human. */
  'ReconciliationError',
] as const;

export type PaymentFailureReason = (typeof PAYMENT_FAILURE_REASONS)[number];

export function isPaymentFailureReason(value: unknown): value is PaymentFailureReason {
  return (
    typeof value === 'string' && (PAYMENT_FAILURE_REASONS as readonly string[]).includes(value)
  );
}

/** Which failures a caller may retry with the same idempotency key. */
export const RETRYABLE_FAILURE_REASONS: readonly PaymentFailureReason[] = Object.freeze([
  'ProviderUnavailable',
]);

export interface PaymentFailure {
  readonly reason: PaymentFailureReason;
  /** What the provider said. Never a raw provider object. */
  readonly detail: string;
  readonly retryable: boolean;
}

/**
 * The outcome of asking a provider for something.
 *
 * A value rather than a throw: a declined card is not an exception, it is the
 * answer. Making a caller destructure the outcome is what stops one being
 * treated as a success.
 */
export type PaymentResult<T> =
  | { readonly outcome: 'succeeded'; readonly value: T }
  | { readonly outcome: 'failed'; readonly failure: PaymentFailure };

export function succeeded<T>(value: T): PaymentResult<T> {
  return deepFreeze({ outcome: 'succeeded' as const, value });
}

export function failed<T>(reason: PaymentFailureReason, detail: string): PaymentResult<T> {
  return deepFreeze({
    outcome: 'failed' as const,
    failure: { reason, detail, retryable: RETRYABLE_FAILURE_REASONS.includes(reason) },
  });
}

/**
 * What receiving a webhook produced.
 *
 * Three arms, and the middle one matters most. Stripe sends dozens of event
 * types on one endpoint; refusing the ones we do not map would make the
 * endpoint fail on traffic Stripe is correct to send, and Stripe would then
 * retry it forever. `ignored` is a successful no-op with a name.
 */
export type WebhookOutcome =
  | { readonly outcome: 'accepted'; readonly event: PaymentEvent }
  | {
      readonly outcome: 'ignored';
      readonly providerId: PaymentProviderId;
      readonly eventId: string;
      readonly providerEventType: string;
    }
  | { readonly outcome: 'rejected'; readonly failure: PaymentFailure };

/** A webhook exactly as it arrived. Raw bytes, because a signature covers bytes. */
export interface WebhookDelivery {
  /** The request body, byte-for-byte. Re-serialising it invalidates the signature. */
  readonly payload: string;
  readonly signatureHeader: string;
  /** Supplied, never read from a clock — a replay window must be assertable. */
  readonly receivedAt: string;
}

// ── The commands ────────────────────────────────────────────────────────────

export interface CreateCustomerCommand {
  readonly organizationId: string;
  readonly accountId: BillingAccountId;
  /** Where receipts go. Carried through; never stored by this layer. */
  readonly email: string;
  readonly name: string;
  /** Makes a retried call return the customer already created. */
  readonly idempotencyKey: string;
}

export interface CreateCheckoutSessionCommand {
  readonly organizationId: string;
  readonly externalCustomerId: string;
  /** The provider's identifier for what is being bought. Opaque here. */
  readonly externalPriceId: string;
  readonly successUrl: string;
  readonly cancelUrl: string;
  readonly idempotencyKey: string;
}

export interface CreatePortalSessionCommand {
  readonly organizationId: string;
  readonly externalCustomerId: string;
  readonly returnUrl: string;
}

export interface CreateSubscriptionCommand {
  readonly organizationId: string;
  readonly externalCustomerId: string;
  readonly externalPriceId: string;
  readonly idempotencyKey: string;
}

export interface CancelSubscriptionCommand {
  readonly organizationId: string;
  readonly externalSubscriptionId: string;
  /**
   * Cancel at period end rather than immediately.
   *
   * Defaults to true at every call site in `billing.md` — "cancel at period
   * end", so a customer keeps what they paid for.
   */
  readonly atPeriodEnd: boolean;
  readonly idempotencyKey: string;
}

/**
 * Every payment provider, behind one interface.
 *
 * `receiveWebhook` is SYNCHRONOUS and pure: verification and translation, no
 * I/O and no state. That is the code expression of "Mapping only. Do not mutate
 * Billing state" — a method that returned a promise would invite a store call
 * inside it.
 */
export interface PaymentProvider {
  readonly providerId: PaymentProviderId;

  createCustomer(command: CreateCustomerCommand): Promise<PaymentResult<PaymentCustomer>>;

  createCheckoutSession(
    command: CreateCheckoutSessionCommand,
  ): Promise<PaymentResult<PaymentSession>>;

  createPortalSession(command: CreatePortalSessionCommand): Promise<PaymentResult<PaymentSession>>;

  createSubscription(
    command: CreateSubscriptionCommand,
  ): Promise<PaymentResult<PaymentSubscriptionRef>>;

  cancelSubscription(
    command: CancelSubscriptionCommand,
  ): Promise<PaymentResult<PaymentSubscriptionRef>>;

  receiveWebhook(delivery: WebhookDelivery): WebhookOutcome;
}

// ── Ownership ───────────────────────────────────────────────────────────────

/**
 * Refuse a provider record that belongs to another organization.
 *
 * The failure it prevents is one customer's checkout session opened against
 * another's account — which, at a payment provider, charges the wrong card.
 */
export function assertPaymentOwnership(
  expected: { readonly organizationId: string; readonly accountId: BillingAccountId },
  record: { readonly organizationId: string },
  what: string,
): void {
  if (record.organizationId !== expected.organizationId) {
    throw new BillingError(
      'OwnershipMismatch',
      `${what} belongs to organization '${record.organizationId}', not '${expected.organizationId}'.`,
    );
  }
  if (expected.accountId !== expected.organizationId) {
    // The billing account IS the organization (S5.5). If those two ever
    // disagree, an ownership check comparing only one of them proves nothing.
    throw new BillingError(
      'OwnershipMismatch',
      `Billing account '${expected.accountId}' is not organization '${expected.organizationId}'. A billing account is its organization.`,
    );
  }
}

/**
 * Refuse a webhook already recorded.
 *
 * `stripe.md`: Stripe redelivers at-least-once, so the handler deduplicates by
 * `event.id`. This is that rule where a test can reach it; the store's
 * `UNIQUE (provider, provider_event_id)` is the backstop for anything that
 * bypasses this path.
 */
export function assertNoDuplicateEvent(
  existing: readonly PaymentEvent[],
  incoming: PaymentEvent,
): void {
  for (const event of existing) {
    // Compared as received: `PaymentProviderId` has one member today, so the
    // type says this can only be true. It stops being true the moment the
    // second provider `stripe.md` plans is added, and by then an event id
    // colliding across providers would be charging the wrong customer.
    const recordedProvider: string = event.providerId;

    if (recordedProvider === incoming.providerId && event.eventId === incoming.eventId) {
      throw new BillingError(
        'DuplicateWebhook',
        `Event '${incoming.eventId}' from '${incoming.providerId}' has already been recorded. The provider redelivers at least once; processing it twice would apply it twice.`,
      );
    }
  }
}
