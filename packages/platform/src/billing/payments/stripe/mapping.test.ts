import { describe, expect, it } from 'vitest';

import {
  fromStripeCustomer,
  fromStripeSession,
  fromStripeSubscription,
  identifiersOf,
  mapStripeEventType,
  mapStripeSubscriptionStatus,
  STRIPE_EVENT_TYPE_MAP,
  STRIPE_STATUS_MAP,
  toStripeCancelBody,
  toStripeCheckoutBody,
  toStripeCustomerBody,
  toStripePortalBody,
  toStripeSubscriptionBody,
} from './mapping.js';
import { METADATA_ORGANIZATION_ID, readRef, readString, toInstant } from './wire.js';

const ORG = '018f7a1e-0000-7000-8000-0000000000aa';
const AT = '2026-02-01T00:00:00.000Z';

/** 2026-02-01T00:00:00Z in Unix seconds. */
const EPOCH = 1769904000;
const EPOCH_ISO = '2026-02-01T00:00:00.000Z';

// ── Event types ─────────────────────────────────────────────────────────────

describe('mapStripeEventType', () => {
  it('maps the six the increment names', () => {
    expect(mapStripeEventType('checkout.session.completed')).toBe('checkout_completed');
    expect(mapStripeEventType('customer.subscription.created')).toBe('subscription_created');
    expect(mapStripeEventType('customer.subscription.updated')).toBe('subscription_updated');
    expect(mapStripeEventType('customer.subscription.deleted')).toBe('subscription_cancelled');
    expect(mapStripeEventType('invoice.paid')).toBe('invoice_paid');
    expect(mapStripeEventType('invoice.payment_failed')).toBe('invoice_payment_failed');
  });

  it('maps exactly six and no more', () => {
    expect(Object.keys(STRIPE_EVENT_TYPE_MAP)).toHaveLength(6);
  });

  it('returns null for a type it does not map', () => {
    // Not an error: Stripe sends dozens of types to one endpoint.
    expect(mapStripeEventType('customer.created')).toBeNull();
    expect(mapStripeEventType('charge.refunded')).toBeNull();
    expect(mapStripeEventType('payment_intent.succeeded')).toBeNull();
  });

  it('is not fooled by a prototype key', () => {
    expect(mapStripeEventType('constructor')).toBeNull();
    expect(mapStripeEventType('toString')).toBeNull();
  });

  it('is frozen', () => {
    expect(Object.isFrozen(STRIPE_EVENT_TYPE_MAP)).toBe(true);
  });
});

// ── Subscription status ─────────────────────────────────────────────────────

describe('mapStripeSubscriptionStatus', () => {
  it('maps every Stripe status', () => {
    expect(mapStripeSubscriptionStatus('trialing', false)).toBe('trialing');
    expect(mapStripeSubscriptionStatus('active', false)).toBe('active');
    expect(mapStripeSubscriptionStatus('past_due', false)).toBe('past_due');
    expect(mapStripeSubscriptionStatus('canceled', false)).toBe('expired');
    expect(mapStripeSubscriptionStatus('unpaid', false)).toBe('suspended');
    expect(mapStripeSubscriptionStatus('incomplete', false)).toBe('trialing');
    expect(mapStripeSubscriptionStatus('incomplete_expired', false)).toBe('expired');
    expect(mapStripeSubscriptionStatus('paused', false)).toBe('suspended');
  });

  it('reads cancel_at_period_end as cancel_pending', () => {
    // Stripe has no `cancel_pending`: it is `active` plus a flag. Reading the
    // status alone would renew a customer who has cancelled.
    expect(mapStripeSubscriptionStatus('active', true)).toBe('cancel_pending');
  });

  it('does not turn a past_due subscription into cancel_pending', () => {
    // The flag only qualifies `active`. A past_due subscription scheduled to
    // cancel still owes money, and reporting it as merely cancelling would
    // hide that.
    expect(mapStripeSubscriptionStatus('past_due', true)).toBe('past_due');
  });

  it('does not resurrect a cancelled subscription', () => {
    expect(mapStripeSubscriptionStatus('canceled', true)).toBe('expired');
  });

  it('returns null for a status it does not know', () => {
    // Reporting an unknown status as `active` would entitle a customer on the
    // strength of a string nobody has read.
    expect(mapStripeSubscriptionStatus('something_new', false)).toBeNull();
    expect(mapStripeSubscriptionStatus('', false)).toBeNull();
  });

  it('is not fooled by a prototype key', () => {
    expect(mapStripeSubscriptionStatus('constructor', false)).toBeNull();
  });

  it('maps every entry to a status our vocabulary has', () => {
    const OURS = [
      'trialing',
      'active',
      'past_due',
      'cancel_pending',
      'suspended',
      'expired',
    ] as const;
    for (const mapped of Object.values(STRIPE_STATUS_MAP)) {
      expect(OURS).toContain(mapped);
    }
  });
});

// ── Billing objects → Stripe request bodies ─────────────────────────────────

describe('request bodies carry our identifiers in metadata', () => {
  it('stamps the organization on a customer', () => {
    // So an event can be attributed without a second API call.
    const body = toStripeCustomerBody({ organizationId: ORG, email: 'a@b.co', name: 'Acme' });

    expect(readString(body['metadata'], METADATA_ORGANIZATION_ID)).toBe(ORG);
    expect(body['email']).toBe('a@b.co');
  });

  it('stamps it on a checkout session AND on the subscription it creates', () => {
    // A subscription's own events do not carry the session's metadata; an
    // unattributed subscription event is one nobody can bill.
    const body = toStripeCheckoutBody({
      organizationId: ORG,
      externalCustomerId: 'cus_1',
      externalPriceId: 'price_1',
      successUrl: 'https://app/ok',
      cancelUrl: 'https://app/no',
    });

    expect(readString(body['metadata'], METADATA_ORGANIZATION_ID)).toBe(ORG);
    expect(
      readString(
        (body['subscription_data'] as { metadata?: unknown }).metadata,
        METADATA_ORGANIZATION_ID,
      ),
    ).toBe(ORG);
  });

  it('creates a subscription-mode checkout, not a one-off payment', () => {
    const body = toStripeCheckoutBody({
      organizationId: ORG,
      externalCustomerId: 'cus_1',
      externalPriceId: 'price_1',
      successUrl: 'https://app/ok',
      cancelUrl: 'https://app/no',
    });

    expect(body['mode']).toBe('subscription');
  });

  it('sends a portal session back where it came from', () => {
    const body = toStripePortalBody({ externalCustomerId: 'cus_1', returnUrl: 'https://app' });

    expect(body['customer']).toBe('cus_1');
    expect(body['return_url']).toBe('https://app');
  });

  it('stamps the organization on a subscription', () => {
    const body = toStripeSubscriptionBody({
      organizationId: ORG,
      externalCustomerId: 'cus_1',
      externalPriceId: 'price_1',
    });

    expect(readString(body['metadata'], METADATA_ORGANIZATION_ID)).toBe(ORG);
  });

  it('cancels at period end with an update, never a delete', () => {
    // A delete ends it immediately and takes away time the customer paid for.
    expect(toStripeCancelBody({ atPeriodEnd: true })['cancel_at_period_end']).toBe(true);
    expect(toStripeCancelBody({ atPeriodEnd: false })['cancel_at_period_end']).toBe(false);
  });

  it('carries no price, no amount and no tax', () => {
    const body = toStripeCheckoutBody({
      organizationId: ORG,
      externalCustomerId: 'cus_1',
      externalPriceId: 'price_1',
      successUrl: 'https://app/ok',
      cancelUrl: 'https://app/no',
    });

    // The provider's price id is opaque here; what it costs is Stripe's.
    expect(Object.keys(body)).not.toContain('amount');
    expect(Object.keys(body)).not.toContain('tax_rates');
  });

  it('freezes every body', () => {
    expect(
      Object.isFrozen(toStripeCustomerBody({ organizationId: ORG, email: 'a@b.co', name: 'A' })),
    ).toBe(true);
    expect(Object.isFrozen(toStripeCancelBody({ atPeriodEnd: true }))).toBe(true);
  });
});

// ── Stripe responses → domain models ────────────────────────────────────────

describe('fromStripeCustomer', () => {
  it('reads a customer', () => {
    const customer = fromStripeCustomer({ id: 'cus_1' }, { organizationId: ORG, createdAt: AT });

    expect(customer?.providerId).toBe('stripe');
    expect(customer?.externalCustomerId).toBe('cus_1');
    expect(customer?.organizationId).toBe(ORG);
  });

  it('gives the account the organization’s id', () => {
    // A billing account IS its organization (S5.5).
    const customer = fromStripeCustomer({ id: 'cus_1' }, { organizationId: ORG, createdAt: AT });

    expect(customer?.accountId).toBe(ORG);
  });

  it('returns null without an id', () => {
    expect(fromStripeCustomer({}, { organizationId: ORG, createdAt: AT })).toBeNull();
    expect(fromStripeCustomer(null, { organizationId: ORG, createdAt: AT })).toBeNull();
    expect(fromStripeCustomer('cus_1', { organizationId: ORG, createdAt: AT })).toBeNull();
  });

  it('is frozen', () => {
    expect(
      Object.isFrozen(fromStripeCustomer({ id: 'cus_1' }, { organizationId: ORG, createdAt: AT })),
    ).toBe(true);
  });
});

describe('fromStripeSession', () => {
  const context = { organizationId: ORG, kind: 'checkout' as const, createdAt: AT };

  it('reads a session', () => {
    const session = fromStripeSession(
      { id: 'cs_1', url: 'https://checkout.stripe.com/x', expires_at: EPOCH },
      context,
    );

    expect(session?.externalSessionId).toBe('cs_1');
    expect(session?.url).toBe('https://checkout.stripe.com/x');
    expect(session?.expiresAt).toBe(EPOCH_ISO);
    expect(session?.kind).toBe('checkout');
  });

  it('returns null without a URL', () => {
    // There would be nowhere to send the customer, and a checkout button would
    // render an empty link.
    expect(fromStripeSession({ id: 'cs_1' }, context)).toBeNull();
  });

  it('returns null without an id', () => {
    expect(fromStripeSession({ url: 'https://x' }, context)).toBeNull();
  });

  it('tolerates a missing expiry', () => {
    expect(fromStripeSession({ id: 'cs_1', url: 'https://x' }, context)?.expiresAt).toBeNull();
  });
});

describe('fromStripeSubscription', () => {
  const wire = {
    id: 'sub_1',
    customer: 'cus_1',
    status: 'active',
    cancel_at_period_end: false,
    current_period_start: EPOCH,
    current_period_end: EPOCH + 86400,
  };

  it('reads a subscription into our vocabulary', () => {
    const ref = fromStripeSubscription(wire, { organizationId: ORG });

    expect(ref?.externalSubscriptionId).toBe('sub_1');
    expect(ref?.externalCustomerId).toBe('cus_1');
    expect(ref?.status).toBe('active');
    expect(ref?.currentPeriodStart).toBe(EPOCH_ISO);
  });

  it('reads an expanded customer object', () => {
    // Stripe sends `"customer": {...}` when the field is expanded; reading only
    // the string form would drop it.
    const ref = fromStripeSubscription(
      { ...wire, customer: { id: 'cus_1', object: 'customer' } },
      { organizationId: ORG },
    );

    expect(ref?.externalCustomerId).toBe('cus_1');
  });

  it('reports a scheduled cancellation as cancel_pending', () => {
    const ref = fromStripeSubscription(
      { ...wire, cancel_at_period_end: true },
      { organizationId: ORG },
    );

    expect(ref?.status).toBe('cancel_pending');
    expect(ref?.cancelAtPeriodEnd).toBe(true);
  });

  it('returns null for a status it cannot name', () => {
    expect(
      fromStripeSubscription({ ...wire, status: 'something_new' }, { organizationId: ORG }),
    ).toBeNull();
  });

  it('returns null when the period cannot be placed', () => {
    // A subscription whose period we cannot read cannot be billed against one.
    expect(
      fromStripeSubscription({ ...wire, current_period_end: null }, { organizationId: ORG }),
    ).toBeNull();
  });

  it('returns null without ids', () => {
    expect(fromStripeSubscription({ ...wire, id: undefined }, { organizationId: ORG })).toBeNull();
    expect(
      fromStripeSubscription({ ...wire, customer: undefined }, { organizationId: ORG }),
    ).toBeNull();
  });

  it('defaults cancel_at_period_end to false rather than guessing', () => {
    const ref = fromStripeSubscription(
      { ...wire, cancel_at_period_end: undefined },
      { organizationId: ORG },
    );

    expect(ref?.cancelAtPeriodEnd).toBe(false);
    expect(ref?.status).toBe('active');
  });
});

// ── Identifier extraction ───────────────────────────────────────────────────

describe('identifiersOf', () => {
  it('reads a subscription event’s own id as the subscription', () => {
    const ids = identifiersOf('customer.subscription.updated', {
      id: 'sub_1',
      customer: 'cus_1',
    });

    expect(ids.externalSubscriptionId).toBe('sub_1');
    expect(ids.externalCustomerId).toBe('cus_1');
  });

  it('reads an invoice’s subscription reference', () => {
    const ids = identifiersOf('invoice.paid', {
      id: 'in_1',
      customer: 'cus_1',
      subscription: 'sub_1',
    });

    // NOT `in_1` — the invoice is not the subscription.
    expect(ids.externalSubscriptionId).toBe('sub_1');
  });

  it('reads a checkout session’s subscription reference', () => {
    const ids = identifiersOf('checkout.session.completed', {
      id: 'cs_1',
      customer: 'cus_1',
      subscription: 'sub_1',
    });

    expect(ids.externalSubscriptionId).toBe('sub_1');
  });

  it('reads our organization out of metadata', () => {
    const ids = identifiersOf('invoice.paid', {
      customer: 'cus_1',
      metadata: { [METADATA_ORGANIZATION_ID]: ORG },
    });

    expect(ids.organizationId).toBe(ORG);
  });

  it('attributes to nothing when metadata is absent', () => {
    // A customer created in Stripe's dashboard belongs to nobody here, and
    // guessing would attribute a payment to the wrong tenant.
    expect(identifiersOf('invoice.paid', { customer: 'cus_1' }).organizationId).toBeNull();
  });

  it('tolerates an object with nothing on it', () => {
    const ids = identifiersOf('invoice.paid', {});

    expect(ids.externalCustomerId).toBeNull();
    expect(ids.externalSubscriptionId).toBeNull();
    expect(ids.organizationId).toBeNull();
  });

  it('is frozen', () => {
    expect(Object.isFrozen(identifiersOf('invoice.paid', { customer: 'cus_1' }))).toBe(true);
  });
});

// ── The readers ─────────────────────────────────────────────────────────────

describe('the wire readers treat everything as untrusted', () => {
  it('reject a non-string where a string belongs', () => {
    expect(readString({ id: 42 }, 'id')).toBeNull();
    expect(readString({ id: null }, 'id')).toBeNull();
    expect(readString({ id: '  ' }, 'id')).toBeNull();
  });

  it('reject a non-object source', () => {
    expect(readString(null, 'id')).toBeNull();
    expect(readString('a string', 'id')).toBeNull();
    expect(readRef(undefined, 'customer')).toBeNull();
  });

  it('read a reference in either form', () => {
    expect(readRef({ customer: 'cus_1' }, 'customer')).toBe('cus_1');
    expect(readRef({ customer: { id: 'cus_1' } }, 'customer')).toBe('cus_1');
    expect(readRef({ customer: { object: 'customer' } }, 'customer')).toBeNull();
  });

  it('refuse an epoch that is not a real instant', () => {
    expect(toInstant(null)).toBeNull();
    expect(toInstant(0)).toBeNull();
    expect(toInstant(-1)).toBeNull();
  });

  it('convert Unix seconds to a UTC instant', () => {
    expect(toInstant(EPOCH)).toBe(EPOCH_ISO);
  });
});
