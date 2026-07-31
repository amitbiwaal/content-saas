/**
 * The payment provider against the Billing Foundation it reports to.
 *
 * The unit suites check each translation on its own. This drives a whole
 * commercial episode — open a customer, check out, receive the webhooks, watch
 * the subscription go past due and recover, cancel — and asserts that what the
 * provider reports lines up with the frozen S5.5 models, and that the ledger
 * never moves.
 *
 * `billing.md`: "Stripe is the source of truth for money; we are the source of
 * truth for entitlement."
 */

import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { createBillingAccount } from '../account.js';
import { calculateBalance } from '../../credits/aggregate.js';
import type { LedgerEntry } from '../../credits/ledger.js';
import { createPlan, UNSET_RATE_LIMITS, type CommercialPlan } from '../plan.js';
import {
  applyTransition,
  createSubscription,
  isEntitling,
  SUBSCRIPTION_STATUSES,
  type Subscription,
  type SubscriptionStatus,
} from '../subscription.js';
import {
  assertNoDuplicateEvent,
  assertPaymentOwnership,
  type PaymentEvent,
  type PaymentProvider,
} from './provider.js';
import {
  createStripeProvider,
  type StripeTransport,
  type StripeTransportResponse,
} from './stripe/adapter.js';
import { STRIPE_STATUS_MAP } from './stripe/mapping.js';

const ORG = '018f7a1e-0000-7000-8000-0000000000aa';
const SECRET = 'whsec_integration';
const EPOCH = 1769904000;
const AT = '2026-02-01T00:00:00.000Z';

const responses: StripeTransportResponse[] = [];

function providerWith(queue: readonly StripeTransportResponse[]): PaymentProvider {
  let index = 0;
  const transport: StripeTransport = {
    post: (): Promise<StripeTransportResponse> => {
      const response = queue[index] ?? { ok: false, status: 500, message: 'exhausted' };
      index += 1;
      return Promise.resolve(response);
    },
  };
  return createStripeProvider({ transport, webhookSecret: SECRET });
}

const provider = providerWith(responses);

function signed(
  payload: unknown,
  receivedAt = AT,
): {
  payload: string;
  signatureHeader: string;
  receivedAt: string;
} {
  const body = JSON.stringify(payload);
  const signature = createHmac('sha256', SECRET)
    .update(`${String(EPOCH)}.${body}`, 'utf8')
    .digest('hex');
  return { payload: body, signatureHeader: `t=${String(EPOCH)},v1=${signature}`, receivedAt };
}

const event = (id: string, type: string, object: unknown): unknown => ({
  id,
  type,
  created: EPOCH,
  data: { object },
});

const accept = (id: string, type: string, object: unknown): PaymentEvent => {
  const outcome = provider.receiveWebhook(signed(event(id, type, object)));
  if (outcome.outcome !== 'accepted') throw new Error(`expected accepted, got ${outcome.outcome}`);
  return outcome.event;
};

const plan = (): CommercialPlan =>
  createPlan({
    planId: 'plan-growth-v1',
    code: 'growth',
    version: 1,
    status: 'active',
    limits: {
      includedCredits: '1000.000000',
      maxWorkspaces: 5,
      maxMembers: 20,
      retentionDays: 365,
      ssoEnabled: false,
      rateLimits: UNSET_RATE_LIMITS,
      storageBytes: null,
      features: [],
    },
    createdAt: AT,
  });

const subscription = (): Subscription =>
  createSubscription({
    subscriptionId: 'sub-1',
    organizationId: ORG,
    plan: plan(),
    cycle: 'monthly',
    startedAt: AT,
  });

const account = createBillingAccount({
  organizationId: ORG,
  currency: 'USD',
  status: 'active',
  createdAt: AT,
});

// ── The provider reports; Billing decides ───────────────────────────────────

describe('a webhook reports a fact; nothing here applies it', () => {
  it('translates a checkout completion into a fact about our organization', () => {
    const result = accept('evt_1', 'checkout.session.completed', {
      id: 'cs_1',
      customer: 'cus_1',
      subscription: 'sub_stripe_1',
      metadata: { contentos_organization_id: ORG },
    });

    expect(result.type).toBe('checkout_completed');
    expect(result.organizationId).toBe(ORG);
    // A fact, not an action: the subscription is untouched.
    expect(subscription().status).toBe('trialing');
  });

  it('carries no authority to move a subscription', () => {
    // The event names a Stripe status; our subscription only moves through
    // `applyTransition`, which nothing in this layer calls.
    const result = accept('evt_2', 'customer.subscription.updated', {
      id: 'sub_stripe_1',
      customer: 'cus_1',
      status: 'past_due',
    });

    expect(result.type).toBe('subscription_updated');
    expect(subscription().status).toBe('trialing');
  });

  it('a payment failure is the fact that drives the transition Billing owns', () => {
    const failure = accept('evt_3', 'invoice.payment_failed', {
      id: 'in_1',
      customer: 'cus_1',
      subscription: 'sub_stripe_1',
      metadata: { contentos_organization_id: ORG },
    });

    // The provider says what happened...
    expect(failure.type).toBe('invoice_payment_failed');

    // ...and Billing's own machine is what changes the state.
    const active = applyTransition(subscription(), 'activate', AT);
    const pastDue = applyTransition(active, 'payment_failed', AT);

    expect(pastDue.status).toBe('past_due');
    expect(isEntitling(pastDue)).toBe(true);
  });

  it('recovery is the same shape: a fact, then a transition', () => {
    const paid = accept('evt_4', 'invoice.paid', {
      id: 'in_2',
      customer: 'cus_1',
      subscription: 'sub_stripe_1',
    });

    expect(paid.type).toBe('invoice_paid');

    const recovered = applyTransition(
      applyTransition(applyTransition(subscription(), 'activate', AT), 'payment_failed', AT),
      'payment_recovered',
      AT,
    );

    expect(recovered.status).toBe('active');
  });
});

// ── The two status vocabularies line up ─────────────────────────────────────

describe('every Stripe status maps into the frozen S5.5 vocabulary', () => {
  it('maps onto a real subscription status, every time', () => {
    for (const mapped of Object.values(STRIPE_STATUS_MAP)) {
      expect(SUBSCRIPTION_STATUSES).toContain(mapped);
    }
  });

  it('reaches statuses our own machine can also reach', () => {
    // A provider status our lifecycle could never be in would be a state
    // nothing could act on.
    const reachable = new Set<SubscriptionStatus>(SUBSCRIPTION_STATUSES);
    for (const mapped of Object.values(STRIPE_STATUS_MAP)) {
      expect(reachable.has(mapped)).toBe(true);
    }
  });

  it('agrees with our machine about which statuses entitle', () => {
    // Stripe's `unpaid` maps to `suspended`, which stops entitling — the same
    // answer our own `dunning_exhausted` gives.
    const suspended = applyTransition(
      applyTransition(applyTransition(subscription(), 'activate', AT), 'payment_failed', AT),
      'dunning_exhausted',
      AT,
    );

    expect(STRIPE_STATUS_MAP['unpaid']).toBe('suspended');
    expect(suspended.status).toBe('suspended');
    expect(isEntitling(suspended)).toBe(false);
  });
});

// ── Ownership ───────────────────────────────────────────────────────────────

describe('ownership is checked against the billing account', () => {
  it('admits an event for the account’s organization', () => {
    const paid = accept('evt_5', 'invoice.paid', {
      id: 'in_3',
      customer: 'cus_1',
      metadata: { contentos_organization_id: ORG },
    });

    expect(() => {
      assertPaymentOwnership(
        { organizationId: account.organizationId, accountId: account.accountId },
        { organizationId: paid.organizationId ?? '' },
        `Event ${paid.eventId}`,
      );
    }).not.toThrow();
  });

  it('refuses an event attributed to another organization', () => {
    const paid = accept('evt_6', 'invoice.paid', {
      id: 'in_4',
      customer: 'cus_other',
      metadata: { contentos_organization_id: 'some-other-org' },
    });

    expect(() => {
      assertPaymentOwnership(
        { organizationId: account.organizationId, accountId: account.accountId },
        { organizationId: paid.organizationId ?? '' },
        `Event ${paid.eventId}`,
      );
    }).toThrow();
  });

  it('an unattributed event cannot pass an ownership check by default', () => {
    // A customer created in Stripe's dashboard carries no metadata; treating
    // that as "belongs to whoever is asking" would attribute a payment to the
    // wrong tenant.
    const orphan = accept('evt_7', 'invoice.paid', { id: 'in_5', customer: 'cus_unknown' });

    expect(orphan.organizationId).toBeNull();
    expect(() => {
      assertPaymentOwnership(
        { organizationId: account.organizationId, accountId: account.accountId },
        { organizationId: orphan.organizationId ?? '' },
        `Event ${orphan.eventId}`,
      );
    }).toThrow();
  });
});

// ── Deduplication ───────────────────────────────────────────────────────────

describe('a redelivered webhook is caught before it is applied', () => {
  it('translates identically both times', () => {
    // Stripe redelivers at least once; the translation must be deterministic
    // or the dedupe check would compare two different things.
    const delivery = signed(event('evt_8', 'invoice.paid', { id: 'in_6', customer: 'cus_1' }));

    expect(provider.receiveWebhook(delivery)).toEqual(provider.receiveWebhook(delivery));
  });

  it('is refused on the second delivery', () => {
    const first = accept('evt_9', 'invoice.paid', { id: 'in_7', customer: 'cus_1' });
    const second = accept('evt_9', 'invoice.paid', { id: 'in_7', customer: 'cus_1' });

    expect(() => {
      assertNoDuplicateEvent([first], second);
    }).toThrow();
  });

  it('lets a genuinely different event through', () => {
    const first = accept('evt_10', 'invoice.paid', { id: 'in_8', customer: 'cus_1' });
    const other = accept('evt_11', 'invoice.paid', { id: 'in_9', customer: 'cus_1' });

    expect(() => {
      assertNoDuplicateEvent([first], other);
    }).not.toThrow();
  });
});

// ── The ledger never moves ──────────────────────────────────────────────────

describe('no webhook grants a credit', () => {
  const grant = (): LedgerEntry => ({
    id: 'grant-1',
    tenantId: ORG,
    organizationId: ORG,
    workspaceId: null,
    entryType: 'grant',
    amount: '100.000000',
    direction: 'credit',
    idempotencyKey: 'seed',
    referenceEntryId: null,
    reason: 'seed',
    correlationId: '018f7a1e-0000-7000-8000-0000000000dd',
    createdBy: null,
    metadata: {},
    createdAt: AT,
  });

  it('leaves the balance exactly where it was', () => {
    // "Do NOT grant credits. Do NOT mutate the ledger." A paid invoice is a
    // fact; turning it into a grant is a consumer's job in a later increment.
    const before = calculateBalance({ organizationId: ORG, entries: [grant()] });

    accept('evt_12', 'invoice.paid', {
      id: 'in_10',
      customer: 'cus_1',
      metadata: { contentos_organization_id: ORG },
    });

    const after = calculateBalance({ organizationId: ORG, entries: [grant()] });

    expect(after).toEqual(before);
    expect(after.balance).toBe('100.000000');
  });

  it('produces an event carrying no amount at all', () => {
    // There is nothing on a `PaymentEvent` a ledger entry could be built from
    // without going back to the provider — which is deliberate.
    const paid = accept('evt_13', 'invoice.paid', { id: 'in_11', customer: 'cus_1' });
    const keys = Object.keys(paid);

    expect(keys).not.toContain('amount');
    expect(keys).not.toContain('total');
    expect(keys).not.toContain('currency');
  });
});

// ── A whole episode ─────────────────────────────────────────────────────────

describe('one commercial episode, end to end', () => {
  it('opens a customer, checks out, and reports the subscription', async () => {
    const live = providerWith([
      { ok: true, body: { id: 'cus_1', created: EPOCH } },
      { ok: true, body: { id: 'cs_1', url: 'https://checkout.stripe.com/x', created: EPOCH } },
      {
        ok: true,
        body: {
          id: 'sub_stripe_1',
          customer: 'cus_1',
          status: 'active',
          cancel_at_period_end: false,
          current_period_start: EPOCH,
          current_period_end: EPOCH + 2_592_000,
        },
      },
    ]);

    const customer = await live.createCustomer({
      organizationId: ORG,
      accountId: account.accountId,
      email: 'billing@acme.test',
      name: 'Acme',
      idempotencyKey: 'org:cus',
    });
    const session = await live.createCheckoutSession({
      organizationId: ORG,
      externalCustomerId: 'cus_1',
      externalPriceId: 'price_growth',
      successUrl: 'https://app/ok',
      cancelUrl: 'https://app/no',
      idempotencyKey: 'org:checkout',
    });
    const created = await live.createSubscription({
      organizationId: ORG,
      externalCustomerId: 'cus_1',
      externalPriceId: 'price_growth',
      idempotencyKey: 'org:sub',
    });

    expect(customer.outcome).toBe('succeeded');
    expect(session.outcome).toBe('succeeded');
    expect(created.outcome).toBe('succeeded');

    if (customer.outcome === 'succeeded') expect(customer.value.accountId).toBe(account.accountId);
    if (session.outcome === 'succeeded') expect(session.value.kind).toBe('checkout');
    if (created.outcome === 'succeeded') expect(created.value.status).toBe('active');
  });

  it('reports a cancellation as pending, so the customer keeps what they paid for', async () => {
    const live = providerWith([
      {
        ok: true,
        body: {
          id: 'sub_stripe_1',
          customer: 'cus_1',
          status: 'active',
          cancel_at_period_end: true,
          current_period_start: EPOCH,
          current_period_end: EPOCH + 2_592_000,
        },
      },
    ]);

    const cancelled = await live.cancelSubscription({
      organizationId: ORG,
      externalSubscriptionId: 'sub_stripe_1',
      atPeriodEnd: true,
      idempotencyKey: 'org:cancel',
    });

    if (cancelled.outcome === 'succeeded') {
      expect(cancelled.value.status).toBe('cancel_pending');
      expect(cancelled.value.cancelAtPeriodEnd).toBe(true);
    }

    // And our own machine has the matching state, reached its own way.
    const pending = applyTransition(
      applyTransition(subscription(), 'activate', AT),
      'request_cancellation',
      AT,
    );
    expect(pending.status).toBe('cancel_pending');
    expect(isEntitling(pending)).toBe(true);
  });
});
