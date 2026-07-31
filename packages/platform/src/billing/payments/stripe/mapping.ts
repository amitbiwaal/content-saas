/**
 * Stripe ⇄ domain translation. The adapter's whole job.
 *
 * ── One direction in, one direction out ────────────────────────────────────
 * `toStripe*` build the request bodies Stripe expects from Billing objects.
 * `fromStripe*` read Stripe's responses and webhooks into domain models. No
 * function here decides anything: no status is chosen, no state is written, no
 * credit is granted. `billing.md` — Billing decides; the adapter translates.
 *
 * ── The event-type map is total in one direction only ──────────────────────
 * Stripe sends dozens of types on one endpoint. The six this build maps are
 * named; everything else maps to null, and `receiveWebhook` turns that into an
 * `ignored` outcome. Refusing an unmapped type would fail on traffic Stripe is
 * correct to send, and Stripe would retry it for days.
 *
 * ── Status translation is where the two models actually differ ─────────────
 * Stripe has eight subscription statuses and we have six, and they do not line
 * up. The interesting one is `cancel_pending`: Stripe expresses it as
 * `status: 'active'` plus `cancel_at_period_end: true`, so reading the status
 * alone would report a cancelling customer as ordinarily active and renew them.
 */

import type { PlanId } from '../../plan.js';
import type { SubscriptionStatus } from '../../subscription.js';
import type {
  PaymentCustomer,
  PaymentEventType,
  PaymentSession,
  PaymentSubscriptionRef,
} from '../provider.js';
import { deepFreeze } from '../../immutable.js';
import {
  METADATA_ORGANIZATION_ID,
  METADATA_SUBSCRIPTION_ID,
  readBoolean,
  readInteger,
  readMetadata,
  readRef,
  readString,
  toInstant,
} from './wire.js';

/** The provider this module translates for. */
export const STRIPE_PROVIDER_ID = 'stripe';

// ── Event types ─────────────────────────────────────────────────────────────

/**
 * The six mappings the increment names, and no others.
 *
 * `customer.subscription.deleted` is Stripe's name for a subscription that has
 * ENDED, not one scheduled to end — a cancellation scheduled for period end
 * arrives as `.updated` with `cancel_at_period_end: true`.
 */
export const STRIPE_EVENT_TYPE_MAP: Readonly<Record<string, PaymentEventType>> = Object.freeze({
  'checkout.session.completed': 'checkout_completed',
  'customer.subscription.created': 'subscription_created',
  'customer.subscription.updated': 'subscription_updated',
  'customer.subscription.deleted': 'subscription_cancelled',
  'invoice.paid': 'invoice_paid',
  'invoice.payment_failed': 'invoice_payment_failed',
});

/**
 * The domain type for a Stripe event type, or null when we do not map it.
 *
 * `Object.hasOwn` rather than a bare lookup: the key comes off an untrusted
 * request body, and `'constructor'` or `'toString'` would otherwise resolve
 * through the prototype chain and return a FUNCTION where a type belongs.
 */
export function mapStripeEventType(providerEventType: string): PaymentEventType | null {
  return Object.hasOwn(STRIPE_EVENT_TYPE_MAP, providerEventType)
    ? (STRIPE_EVENT_TYPE_MAP[providerEventType] ?? null)
    : null;
}

// ── Subscription status ─────────────────────────────────────────────────────

/**
 * Stripe's subscription statuses, mapped onto ours.
 *
 * `unpaid` → `suspended`: Stripe reaches it when every dunning retry has been
 * exhausted, which is what `dunning_exhausted` means here.
 *
 * `incomplete` → `trialing`: the customer has started and not yet paid, and
 * nothing is entitled by it that a trial does not already entitle. Reporting it
 * as `active` would entitle an unpaid customer.
 *
 * `paused` → `suspended`: entitlement stops, and Organizations decides what
 * that means for the tenant.
 */
export const STRIPE_STATUS_MAP: Readonly<Record<string, SubscriptionStatus>> = Object.freeze({
  trialing: 'trialing',
  active: 'active',
  past_due: 'past_due',
  canceled: 'expired',
  unpaid: 'suspended',
  incomplete: 'trialing',
  incomplete_expired: 'expired',
  paused: 'suspended',
});

/**
 * Stripe's status, plus the flag that changes what it means.
 *
 * `active` with `cancel_at_period_end` is a customer who has cancelled and is
 * running out their paid time. Reading the status alone would renew them.
 */
export function mapStripeSubscriptionStatus(
  stripeStatus: string,
  cancelAtPeriodEnd: boolean,
): SubscriptionStatus | null {
  // Own-property only: the status comes off an untrusted body, and a bare
  // lookup of `'constructor'` returns a function that would then be reported as
  // a subscription status.
  if (!Object.hasOwn(STRIPE_STATUS_MAP, stripeStatus)) return null;
  const mapped = STRIPE_STATUS_MAP[stripeStatus];
  if (mapped === undefined) return null;
  return cancelAtPeriodEnd && mapped === 'active' ? 'cancel_pending' : mapped;
}

// ── Billing objects → Stripe request bodies ─────────────────────────────────

/** What a request body looks like. Plain JSON; nothing provider-typed. */
export type StripeRequestBody = Readonly<Record<string, unknown>>;

/**
 * Our identifiers, in Stripe's metadata.
 *
 * So an event can be attributed without a second API call — `stripe.md`
 * relies on webhooks as the source of truth rather than polling.
 */
function toStripeMetadata(input: {
  readonly organizationId: string;
  readonly subscriptionId?: string | null;
}): StripeRequestBody {
  const metadata: Record<string, string> = {
    [METADATA_ORGANIZATION_ID]: input.organizationId,
  };
  if (input.subscriptionId !== undefined && input.subscriptionId !== null) {
    metadata[METADATA_SUBSCRIPTION_ID] = input.subscriptionId;
  }
  return deepFreeze(metadata);
}

export function toStripeCustomerBody(input: {
  readonly organizationId: string;
  readonly email: string;
  readonly name: string;
}): StripeRequestBody {
  return deepFreeze({
    email: input.email,
    name: input.name,
    metadata: toStripeMetadata({ organizationId: input.organizationId }),
  });
}

export function toStripeCheckoutBody(input: {
  readonly organizationId: string;
  readonly externalCustomerId: string;
  readonly externalPriceId: string;
  readonly successUrl: string;
  readonly cancelUrl: string;
}): StripeRequestBody {
  return deepFreeze({
    mode: 'subscription',
    customer: input.externalCustomerId,
    line_items: [{ price: input.externalPriceId, quantity: 1 }],
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    metadata: toStripeMetadata({ organizationId: input.organizationId }),
    // Metadata on the subscription too: the subscription's own events do not
    // carry the session's, and an unattributed subscription event is one
    // nobody can bill.
    subscription_data: { metadata: toStripeMetadata({ organizationId: input.organizationId }) },
  });
}

export function toStripePortalBody(input: {
  readonly externalCustomerId: string;
  readonly returnUrl: string;
}): StripeRequestBody {
  return deepFreeze({ customer: input.externalCustomerId, return_url: input.returnUrl });
}

export function toStripeSubscriptionBody(input: {
  readonly organizationId: string;
  readonly externalCustomerId: string;
  readonly externalPriceId: string;
  readonly planId?: PlanId | null;
}): StripeRequestBody {
  return deepFreeze({
    customer: input.externalCustomerId,
    items: [{ price: input.externalPriceId }],
    metadata: toStripeMetadata({
      organizationId: input.organizationId,
      subscriptionId: input.planId ?? null,
    }),
  });
}

/**
 * Cancelling.
 *
 * At period end, Stripe expects an UPDATE setting `cancel_at_period_end`, not
 * a delete — a delete ends it immediately and takes away time the customer paid
 * for.
 */
export function toStripeCancelBody(input: { readonly atPeriodEnd: boolean }): StripeRequestBody {
  return deepFreeze({ cancel_at_period_end: input.atPeriodEnd });
}

// ── Stripe responses → domain models ────────────────────────────────────────

export function fromStripeCustomer(
  wire: unknown,
  context: { readonly organizationId: string; readonly createdAt: string },
): PaymentCustomer | null {
  const externalCustomerId = readString(wire, 'id');
  if (externalCustomerId === null) return null;

  return deepFreeze({
    providerId: STRIPE_PROVIDER_ID,
    externalCustomerId,
    organizationId: context.organizationId,
    // The billing account IS the organization (S5.5).
    accountId: context.organizationId,
    createdAt: context.createdAt,
  });
}

export function fromStripeSession(
  wire: unknown,
  context: {
    readonly organizationId: string;
    readonly kind: PaymentSession['kind'];
    readonly createdAt: string;
  },
): PaymentSession | null {
  const externalSessionId = readString(wire, 'id');
  const url = readString(wire, 'url');
  // A session with no URL is useless: there is nowhere to send the customer,
  // and returning one would surface an empty link on a checkout button.
  if (externalSessionId === null || url === null) return null;

  return deepFreeze({
    providerId: STRIPE_PROVIDER_ID,
    externalSessionId,
    kind: context.kind,
    organizationId: context.organizationId,
    url,
    expiresAt: toInstant(readInteger(wire, 'expires_at')),
    createdAt: context.createdAt,
  });
}

export function fromStripeSubscription(
  wire: unknown,
  context: { readonly organizationId: string },
): PaymentSubscriptionRef | null {
  const externalSubscriptionId = readString(wire, 'id');
  const externalCustomerId = readRef(wire, 'customer');
  const stripeStatus = readString(wire, 'status');
  if (externalSubscriptionId === null || externalCustomerId === null || stripeStatus === null) {
    return null;
  }

  const cancelAtPeriodEnd = readBoolean(wire, 'cancel_at_period_end') ?? false;
  const status = mapStripeSubscriptionStatus(stripeStatus, cancelAtPeriodEnd);
  const currentPeriodStart = toInstant(readInteger(wire, 'current_period_start'));
  const currentPeriodEnd = toInstant(readInteger(wire, 'current_period_end'));

  // A status we cannot name, or a period we cannot place, is not translated
  // into a guess. Reporting an unknown Stripe status as `active` would entitle
  // a customer on the strength of a string nobody has read.
  if (status === null || currentPeriodStart === null || currentPeriodEnd === null) return null;

  return deepFreeze({
    providerId: STRIPE_PROVIDER_ID,
    externalSubscriptionId,
    externalCustomerId,
    organizationId: context.organizationId,
    status,
    cancelAtPeriodEnd,
    currentPeriodStart,
    currentPeriodEnd,
  });
}

/**
 * The identifiers an event's object carries.
 *
 * One reader for all four shapes, because they name the same things
 * differently: a checkout session and an invoice both point at a subscription,
 * while a subscription event IS the subscription.
 */
export function identifiersOf(
  providerEventType: string,
  object: unknown,
): {
  readonly externalCustomerId: string | null;
  readonly externalSubscriptionId: string | null;
  readonly organizationId: string | null;
  readonly subscriptionId: string | null;
} {
  const isSubscriptionEvent = providerEventType.startsWith('customer.subscription.');

  return deepFreeze({
    externalCustomerId: readRef(object, 'customer'),
    externalSubscriptionId: isSubscriptionEvent
      ? readString(object, 'id')
      : readRef(object, 'subscription'),
    organizationId: readMetadata(object, METADATA_ORGANIZATION_ID),
    subscriptionId: readMetadata(object, METADATA_SUBSCRIPTION_ID),
  });
}
