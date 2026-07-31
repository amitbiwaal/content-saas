import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { BillingError } from '../../errors.js';
import type { PaymentProvider, PaymentResult } from '../provider.js';
import {
  createStripeProvider,
  type StripeTransport,
  type StripeTransportResponse,
} from './adapter.js';
import type { StripeRequestBody } from './mapping.js';

const ORG = '018f7a1e-0000-7000-8000-0000000000aa';
const SECRET = 'whsec_test_secret';
const EPOCH = 1769904000;
const EPOCH_ISO = '2026-02-01T00:00:00.000Z';

interface Call {
  readonly path: string;
  readonly body: StripeRequestBody;
  readonly idempotencyKey: string;
}

interface Rig {
  readonly provider: PaymentProvider;
  readonly calls: Call[];
}

/** A transport that answers with whatever the test hands it. */
function rig(responses: readonly StripeTransportResponse[]): Rig {
  const calls: Call[] = [];
  let index = 0;

  const transport: StripeTransport = {
    post(path, body, idempotencyKey): Promise<StripeTransportResponse> {
      calls.push({ path, body, idempotencyKey });
      const response = responses[index] ?? responses[responses.length - 1];
      index += 1;
      return Promise.resolve(response ?? { ok: false, status: 500, message: 'no response' });
    },
  };

  return { provider: createStripeProvider({ transport, webhookSecret: SECRET }), calls };
}

const ok = (body: unknown): StripeTransportResponse => ({ ok: true, body });

const CUSTOMER = { id: 'cus_1', created: EPOCH };
const SESSION = { id: 'cs_1', url: 'https://checkout.stripe.com/x', created: EPOCH };
const SUBSCRIPTION = {
  id: 'sub_1',
  customer: 'cus_1',
  status: 'active',
  cancel_at_period_end: false,
  current_period_start: EPOCH,
  current_period_end: EPOCH + 2_592_000,
};

/** A correctly signed delivery, exactly as Stripe would send it. */
function signed(
  payload: unknown,
  options: { secret?: string; timestamp?: number; receivedAt?: string } = {},
): { payload: string; signatureHeader: string; receivedAt: string } {
  const body = JSON.stringify(payload);
  const timestamp = options.timestamp ?? EPOCH;
  const signature = createHmac('sha256', options.secret ?? SECRET)
    .update(`${String(timestamp)}.${body}`, 'utf8')
    .digest('hex');

  return {
    payload: body,
    signatureHeader: `t=${String(timestamp)},v1=${signature}`,
    receivedAt: options.receivedAt ?? EPOCH_ISO,
  };
}

const event = (type: string, object: unknown, id = 'evt_1'): unknown => ({
  id,
  type,
  created: EPOCH,
  data: { object },
});

const valueOf = <T>(result: PaymentResult<T>): T => {
  if (result.outcome !== 'succeeded') {
    throw new Error(`expected success, got ${result.failure.reason}: ${result.failure.detail}`);
  }
  return result.value;
};

// ── The provider surface ────────────────────────────────────────────────────

describe('the adapter is a PaymentProvider', () => {
  it('names itself stripe', () => {
    expect(rig([ok({})]).provider.providerId).toBe('stripe');
  });

  it('refuses to be built without a webhook secret', () => {
    // An adapter with no secret cannot verify anything, and would accept a
    // forged webhook the first time one arrived.
    const transport: StripeTransport = {
      post: () => Promise.resolve(ok({})),
    };

    expect(() => createStripeProvider({ transport, webhookSecret: '' })).toThrow(BillingError);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(rig([ok({})]).provider)).toBe(true);
  });
});

// ── Mutating calls ──────────────────────────────────────────────────────────

describe('createCustomer', () => {
  it('posts to the customers endpoint and reads the result', async () => {
    const r = rig([ok(CUSTOMER)]);
    const result = await r.provider.createCustomer({
      organizationId: ORG,
      accountId: ORG,
      email: 'a@b.co',
      name: 'Acme',
      idempotencyKey: 'key-1',
    });

    expect(r.calls[0]?.path).toBe('/v1/customers');
    expect(valueOf(result).externalCustomerId).toBe('cus_1');
    expect(valueOf(result).organizationId).toBe(ORG);
  });

  it('sends the idempotency key on the mutating call', async () => {
    // stripe.md: "the adapter uses Stripe idempotency keys on every mutating
    // call so retries are safe".
    const r = rig([ok(CUSTOMER)]);
    await r.provider.createCustomer({
      organizationId: ORG,
      accountId: ORG,
      email: 'a@b.co',
      name: 'Acme',
      idempotencyKey: 'key-1',
    });

    expect(r.calls[0]?.idempotencyKey).toBe('key-1');
  });

  it('refuses a command whose account is not its organization', async () => {
    const r = rig([ok(CUSTOMER)]);

    await expect(
      r.provider.createCustomer({
        organizationId: ORG,
        accountId: 'someone-else',
        email: 'a@b.co',
        name: 'Acme',
        idempotencyKey: 'key-1',
      }),
    ).rejects.toBeInstanceOf(BillingError);
  });

  it('refuses an empty idempotency key', async () => {
    const r = rig([ok(CUSTOMER)]);

    await expect(
      r.provider.createCustomer({
        organizationId: ORG,
        accountId: ORG,
        email: 'a@b.co',
        name: 'Acme',
        idempotencyKey: '',
      }),
    ).rejects.toBeInstanceOf(BillingError);
  });
});

describe('createCheckoutSession', () => {
  it('returns a provider-hosted URL', async () => {
    const r = rig([ok(SESSION)]);
    const result = await r.provider.createCheckoutSession({
      organizationId: ORG,
      externalCustomerId: 'cus_1',
      externalPriceId: 'price_1',
      successUrl: 'https://app/ok',
      cancelUrl: 'https://app/no',
      idempotencyKey: 'key-1',
    });

    expect(r.calls[0]?.path).toBe('/v1/checkout/sessions');
    expect(valueOf(result).url).toBe('https://checkout.stripe.com/x');
    expect(valueOf(result).kind).toBe('checkout');
  });
});

describe('createPortalSession', () => {
  it('marks the session a portal', async () => {
    const r = rig([ok(SESSION)]);
    const result = await r.provider.createPortalSession({
      organizationId: ORG,
      externalCustomerId: 'cus_1',
      returnUrl: 'https://app',
    });

    expect(r.calls[0]?.path).toBe('/v1/billing_portal/sessions');
    expect(valueOf(result).kind).toBe('portal');
  });
});

describe('createSubscription', () => {
  it('reads the subscription into our vocabulary', async () => {
    const r = rig([ok(SUBSCRIPTION)]);
    const result = await r.provider.createSubscription({
      organizationId: ORG,
      externalCustomerId: 'cus_1',
      externalPriceId: 'price_1',
      idempotencyKey: 'key-1',
    });

    expect(r.calls[0]?.path).toBe('/v1/subscriptions');
    expect(valueOf(result).status).toBe('active');
    expect(valueOf(result).externalSubscriptionId).toBe('sub_1');
  });
});

describe('cancelSubscription', () => {
  it('updates the subscription rather than deleting it', async () => {
    // A delete ends it now and takes away time the customer paid for.
    const r = rig([ok({ ...SUBSCRIPTION, cancel_at_period_end: true })]);
    const result = await r.provider.cancelSubscription({
      organizationId: ORG,
      externalSubscriptionId: 'sub_1',
      atPeriodEnd: true,
      idempotencyKey: 'key-1',
    });

    expect(r.calls[0]?.path).toBe('/v1/subscriptions/sub_1');
    expect(r.calls[0]?.body['cancel_at_period_end']).toBe(true);
    expect(valueOf(result).status).toBe('cancel_pending');
  });
});

// ── Failure translation ─────────────────────────────────────────────────────

describe('provider failures become values, not throws', () => {
  it('reads a 402 as a payment failure, not an outage', async () => {
    // Retrying a declined card declines again.
    const r = rig([{ ok: false, status: 402, message: 'Your card was declined.' }]);
    const result = await r.provider.createSubscription({
      organizationId: ORG,
      externalCustomerId: 'cus_1',
      externalPriceId: 'price_1',
      idempotencyKey: 'key-1',
    });

    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      expect(result.failure.reason).toBe('PaymentFailed');
      expect(result.failure.retryable).toBe(false);
    }
  });

  it('reads a 5xx as retryable', async () => {
    const r = rig([{ ok: false, status: 503, message: 'upstream' }]);
    const result = await r.provider.createSubscription({
      organizationId: ORG,
      externalCustomerId: 'cus_1',
      externalPriceId: 'price_1',
      idempotencyKey: 'key-1',
    });

    if (result.outcome === 'failed') {
      expect(result.failure.reason).toBe('ProviderUnavailable');
      expect(result.failure.retryable).toBe(true);
    }
  });

  it('reads a 429 as retryable', async () => {
    const r = rig([{ ok: false, status: 429, message: 'slow down' }]);
    const result = await r.provider.createCustomer({
      organizationId: ORG,
      accountId: ORG,
      email: 'a@b.co',
      name: 'A',
      idempotencyKey: 'key-1',
    });

    if (result.outcome === 'failed') expect(result.failure.reason).toBe('ProviderUnavailable');
  });

  it('reads a 400 as a payment failure, because retrying will not fix it', async () => {
    const r = rig([{ ok: false, status: 400, message: 'no such price' }]);
    const result = await r.provider.createSubscription({
      organizationId: ORG,
      externalCustomerId: 'cus_1',
      externalPriceId: 'price_bad',
      idempotencyKey: 'key-1',
    });

    if (result.outcome === 'failed') expect(result.failure.retryable).toBe(false);
  });

  it('reads a transport with no status as an outage', async () => {
    const r = rig([{ ok: false, status: null, message: 'ECONNRESET' }]);
    const result = await r.provider.createCustomer({
      organizationId: ORG,
      accountId: ORG,
      email: 'a@b.co',
      name: 'A',
      idempotencyKey: 'key-1',
    });

    if (result.outcome === 'failed') expect(result.failure.reason).toBe('ProviderUnavailable');
  });

  it('reports an unreadable success as a reconciliation error', async () => {
    // Stripe accepted it and we cannot read the answer: reporting success would
    // store a half-built record, and reporting an outage would retry a call
    // that already worked.
    const r = rig([ok({ nothing: 'useful' })]);
    const result = await r.provider.createSubscription({
      organizationId: ORG,
      externalCustomerId: 'cus_1',
      externalPriceId: 'price_1',
      idempotencyKey: 'key-1',
    });

    if (result.outcome === 'failed') {
      expect(result.failure.reason).toBe('ReconciliationError');
      expect(result.failure.retryable).toBe(false);
    }
  });
});

// ── Webhooks: signature ─────────────────────────────────────────────────────

describe('receiveWebhook verifies before it reads', () => {
  const provider = rig([ok({})]).provider;

  it('accepts a correctly signed delivery', () => {
    const outcome = provider.receiveWebhook(
      signed(event('invoice.paid', { id: 'in_1', customer: 'cus_1', subscription: 'sub_1' })),
    );

    expect(outcome.outcome).toBe('accepted');
  });

  it('rejects a wrong signature', () => {
    const outcome = provider.receiveWebhook(
      signed(event('invoice.paid', { id: 'in_1' }), { secret: 'whsec_attacker' }),
    );

    expect(outcome.outcome).toBe('rejected');
    if (outcome.outcome === 'rejected') expect(outcome.failure.reason).toBe('WebhookInvalid');
  });

  it('rejects a tampered body under a valid signature', () => {
    const delivery = signed(event('invoice.paid', { id: 'in_1' }));
    const tampered = { ...delivery, payload: delivery.payload.replace('in_1', 'in_evil') };

    expect(provider.receiveWebhook(tampered).outcome).toBe('rejected');
  });

  it('rejects a replay outside the tolerance', () => {
    // A captured request stays validly signed forever; the signature alone does
    // not make it fresh.
    const outcome = provider.receiveWebhook(
      signed(event('invoice.paid', { id: 'in_1' }), {
        timestamp: EPOCH,
        receivedAt: '2026-02-01T01:00:00.000Z',
      }),
    );

    expect(outcome.outcome).toBe('rejected');
    if (outcome.outcome === 'rejected') expect(outcome.failure.detail).toContain('replay');
  });

  it('accepts one inside the tolerance', () => {
    expect(
      provider.receiveWebhook(
        signed(event('invoice.paid', { id: 'in_1' }), {
          timestamp: EPOCH,
          receivedAt: '2026-02-01T00:04:00.000Z',
        }),
      ).outcome,
    ).toBe('accepted');
  });

  it('accepts a signature from a rotation, where more than one v1 is sent', () => {
    const delivery = signed(event('invoice.paid', { id: 'in_1' }));
    const withOld = {
      ...delivery,
      signatureHeader: `${delivery.signatureHeader},v1=${'0'.repeat(64)}`,
    };

    expect(provider.receiveWebhook(withOld).outcome).toBe('accepted');
  });

  it('rejects a header with no timestamp', () => {
    expect(
      provider.receiveWebhook({
        payload: '{}',
        signatureHeader: 'v1=abc',
        receivedAt: EPOCH_ISO,
      }).outcome,
    ).toBe('rejected');
  });

  it('rejects a header with no signature', () => {
    expect(
      provider.receiveWebhook({
        payload: '{}',
        signatureHeader: `t=${String(EPOCH)}`,
        receivedAt: EPOCH_ISO,
      }).outcome,
    ).toBe('rejected');
  });

  it('rejects an empty header', () => {
    expect(
      provider.receiveWebhook({ payload: '{}', signatureHeader: '', receivedAt: EPOCH_ISO })
        .outcome,
    ).toBe('rejected');
  });

  it('rejects a body that is signed but not JSON', () => {
    const payload = 'not json at all';
    const signature = createHmac('sha256', SECRET)
      .update(`${String(EPOCH)}.${payload}`, 'utf8')
      .digest('hex');

    expect(
      provider.receiveWebhook({
        payload,
        signatureHeader: `t=${String(EPOCH)},v1=${signature}`,
        receivedAt: EPOCH_ISO,
      }).outcome,
    ).toBe('rejected');
  });

  it('rejects a delivery with an unreadable receivedAt', () => {
    const delivery = signed(event('invoice.paid', { id: 'in_1' }));

    expect(provider.receiveWebhook({ ...delivery, receivedAt: 'whenever' }).outcome).toBe(
      'rejected',
    );
  });
});

// ── Webhooks: translation ───────────────────────────────────────────────────

describe('receiveWebhook translates the six mapped types', () => {
  const provider = rig([ok({})]).provider;

  const accept = (type: string, object: unknown, id = 'evt_1') => {
    const outcome = provider.receiveWebhook(signed(event(type, object, id)));
    if (outcome.outcome !== 'accepted') {
      throw new Error(`expected accepted, got ${outcome.outcome}`);
    }
    return outcome.event;
  };

  it('translates a completed checkout', () => {
    const result = accept('checkout.session.completed', {
      id: 'cs_1',
      customer: 'cus_1',
      subscription: 'sub_1',
      metadata: { contentos_organization_id: ORG },
    });

    expect(result.type).toBe('checkout_completed');
    expect(result.externalSubscriptionId).toBe('sub_1');
    expect(result.organizationId).toBe(ORG);
  });

  it('translates each subscription lifecycle event', () => {
    const object = { id: 'sub_1', customer: 'cus_1' };

    expect(accept('customer.subscription.created', object).type).toBe('subscription_created');
    expect(accept('customer.subscription.updated', object).type).toBe('subscription_updated');
    expect(accept('customer.subscription.deleted', object).type).toBe('subscription_cancelled');
  });

  it('translates both invoice outcomes', () => {
    const object = { id: 'in_1', customer: 'cus_1', subscription: 'sub_1' };

    expect(accept('invoice.paid', object).type).toBe('invoice_paid');
    expect(accept('invoice.payment_failed', object).type).toBe('invoice_payment_failed');
  });

  it('keeps the provider’s own type for the audit trail', () => {
    expect(accept('invoice.paid', { id: 'in_1' }).providerEventType).toBe('invoice.paid');
  });

  it('takes the instant from the provider, not from us', () => {
    expect(accept('invoice.paid', { id: 'in_1' }).occurredAt).toBe(EPOCH_ISO);
  });

  it('reads a subscription event’s own id as the subscription', () => {
    expect(
      accept('customer.subscription.updated', { id: 'sub_1', customer: 'cus_1' })
        .externalSubscriptionId,
    ).toBe('sub_1');
  });

  it('attributes to nothing when metadata is absent', () => {
    expect(accept('invoice.paid', { id: 'in_1', customer: 'cus_1' }).organizationId).toBeNull();
  });

  it('freezes the event', () => {
    expect(Object.isFrozen(accept('invoice.paid', { id: 'in_1' }))).toBe(true);
  });

  it('ignores an event type it does not map', () => {
    // Stripe sends dozens to one endpoint; failing would make it retry for days.
    const outcome = provider.receiveWebhook(signed(event('charge.refunded', { id: 'ch_1' })));

    expect(outcome.outcome).toBe('ignored');
    if (outcome.outcome === 'ignored') {
      expect(outcome.providerEventType).toBe('charge.refunded');
      expect(outcome.eventId).toBe('evt_1');
    }
  });

  it('ignores rather than rejects, so the endpoint acknowledges it', () => {
    for (const type of ['customer.created', 'payment_intent.succeeded', 'ping']) {
      expect(provider.receiveWebhook(signed(event(type, { id: 'x' }))).outcome).toBe('ignored');
    }
  });

  it('rejects an envelope with no id or type', () => {
    expect(provider.receiveWebhook(signed({ created: EPOCH })).outcome).toBe('rejected');
    expect(provider.receiveWebhook(signed({ id: 'evt_1', created: EPOCH })).outcome).toBe(
      'rejected',
    );
  });

  it('rejects a mapped event carrying no object', () => {
    expect(
      provider.receiveWebhook(signed({ id: 'evt_1', type: 'invoice.paid', created: EPOCH }))
        .outcome,
    ).toBe('rejected');
  });

  it('rejects an envelope with no created timestamp', () => {
    expect(
      provider.receiveWebhook(
        signed({ id: 'evt_1', type: 'invoice.paid', data: { object: { id: 'in_1' } } }),
      ).outcome,
    ).toBe('rejected');
  });

  it('is not fooled by a prototype key as the event type', () => {
    // A bare map lookup would return a function here.
    expect(provider.receiveWebhook(signed(event('constructor', { id: 'x' }))).outcome).toBe(
      'ignored',
    );
  });

  it('does the same work twice for the same delivery', () => {
    const delivery = signed(event('invoice.paid', { id: 'in_1', customer: 'cus_1' }));

    expect(provider.receiveWebhook(delivery)).toEqual(provider.receiveWebhook(delivery));
  });
});

// ── The boundary ────────────────────────────────────────────────────────────

describe('nothing Stripe-shaped escapes', () => {
  it('returns domain models with no provider fields on them', async () => {
    const r = rig([ok(SUBSCRIPTION)]);
    const result = await r.provider.createSubscription({
      organizationId: ORG,
      externalCustomerId: 'cus_1',
      externalPriceId: 'price_1',
      idempotencyKey: 'key-1',
    });

    const keys = Object.keys(valueOf(result));
    for (const stripeKey of ['object', 'livemode', 'cancel_at_period_end', 'current_period_end']) {
      expect(keys).not.toContain(stripeKey);
    }
  });

  it('returns an event with no data envelope on it', () => {
    const outcome = rig([ok({})]).provider.receiveWebhook(
      signed(event('invoice.paid', { id: 'in_1', customer: 'cus_1', livemode: true })),
    );

    if (outcome.outcome === 'accepted') {
      expect(Object.keys(outcome.event)).not.toContain('data');
      expect(Object.keys(outcome.event)).not.toContain('livemode');
      expect(Object.keys(outcome.event)).not.toContain('payload');
    }
  });

  it('never writes anything: the transport is the only side effect', async () => {
    const r = rig([ok(CUSTOMER)]);
    await r.provider.createCustomer({
      organizationId: ORG,
      accountId: ORG,
      email: 'a@b.co',
      name: 'A',
      idempotencyKey: 'key-1',
    });

    expect(r.calls).toHaveLength(1);
  });

  it('makes no call at all when receiving a webhook', () => {
    // "Mapping only. Do not mutate Billing state." — and no I/O to do it with.
    const r = rig([ok({})]);
    r.provider.receiveWebhook(signed(event('invoice.paid', { id: 'in_1' })));

    expect(r.calls).toHaveLength(0);
  });
});
