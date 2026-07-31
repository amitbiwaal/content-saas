/**
 * The facade against the real components it coordinates.
 *
 * The unit suite checks routing with every delegate faked. This wires the
 * REAL Stripe adapter (over a fake transport), the REAL Billing lifecycle and
 * the REAL S5.2 availability calculation behind the facade, and drives a whole
 * commercial episode: open an account, subscribe, upgrade, take a webhook,
 * cancel, read the summary.
 *
 * What it proves is the thing a facade can get wrong: that the answer the
 * customer sees is the one the owning component produced, unchanged.
 */

import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { Principal } from '@contentos/security';

import {
  createStripeProvider,
  type StripeTransportResponse,
} from '../billing/payments/stripe/adapter.js';
import { createPlan, UNSET_RATE_LIMITS, type CommercialPlan } from '../billing/plan.js';
import { toCreditReservation } from '../credits/reservation.js';
import type { CreditHold } from '../credits/holds.js';
import { createFakes, emptyBalance, type FakeState } from './fakes.fixture.js';
import type { CommercialRequest, CommercialResult, CommercialSummary } from './model.js';
import { createCommercialService, type CommercialService } from './service.js';

const ORG = '018f7a1e-0000-7000-8000-0000000000aa';
const WS = '018f7a1e-0000-7000-8000-0000000000bb';
const SECRET = 'whsec_facade';
const EPOCH = 1772323200;
const AT = '2026-03-01T00:00:00.000Z';

const principal = Object.freeze({
  subjectId: '018f7a1e-0000-7000-8000-000000000001',
  kind: 'user',
  organizationId: ORG,
  roles: Object.freeze([]),
  permissions: Object.freeze([]),
  sessionId: '018f7a1e-0000-7000-8000-000000000002',
}) as unknown as Principal;

const context = (): CommercialRequest['context'] => ({
  principal,
  organizationId: ORG,
  requestId: 'req-1',
  correlationId: 'corr-1',
  at: AT,
});

const plan = (over: Partial<Parameters<typeof createPlan>[0]> = {}): CommercialPlan =>
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
    ...over,
  });

const enterprise = plan({ planId: 'plan-ent-v1', code: 'enterprise' });

const hold = (over: Partial<CreditHold> = {}): CreditHold => ({
  id: 'hold-1',
  tenantId: ORG,
  organizationId: ORG,
  workspaceId: WS,
  runId: 'run-1',
  amount: '25.000000',
  consumed: '5.000000',
  state: 'held',
  expiresAt: '2026-03-02T00:00:00.000Z',
  reason: 'a content run',
  correlationId: 'corr-1',
  createdBy: null,
  metadata: {},
  createdAt: AT,
  settledAt: null,
  releasedAt: null,
  ...over,
});

/** A correctly signed webhook, exactly as Stripe would send it. */
function signedWebhook(payload: unknown): { payload: string; signatureHeader: string } {
  const body = JSON.stringify(payload);
  const signature = createHmac('sha256', SECRET)
    .update(`${String(EPOCH)}.${body}`, 'utf8')
    .digest('hex');
  return { payload: body, signatureHeader: `t=${String(EPOCH)},v1=${signature}` };
}

/**
 * The facade, with the REAL Stripe adapter behind it.
 *
 * Only the transport and the stores are faked — everything that translates,
 * verifies or decides is the component that owns it.
 */
function rig(
  queue: readonly StripeTransportResponse[] = [],
  state: Partial<FakeState> = {},
): { service: CommercialService; fakes: ReturnType<typeof createFakes> } {
  let index = 0;
  const provider = createStripeProvider({
    transport: {
      post: (): Promise<StripeTransportResponse> => {
        const response = queue[index] ?? { ok: false, status: 500, message: 'exhausted' };
        index += 1;
        return Promise.resolve(response);
      },
    },
    webhookSecret: SECRET,
  });

  const fakes = createFakes(state);
  return { service: createCommercialService({ ...fakes, provider }), fakes };
}

const summaryOf = (result: CommercialResult): CommercialSummary => {
  if (result.outcome !== 'ok' || result.data.kind !== 'summary') {
    throw new Error(`expected a summary, got ${JSON.stringify(result)}`);
  }
  return result.data.summary;
};

// ── A whole commercial episode ──────────────────────────────────────────────

describe('one organization, from nothing to a cancelled subscription', () => {
  it('runs the whole sequence through the one entry point', async () => {
    const { service, fakes } = rig(
      [
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
      ],
      { plans: [plan(), enterprise] },
    );

    // 1 · Open the account.
    const opened = await service.execute({
      operation: 'createBillingAccount',
      context: context(),
      payload: { currency: 'USD' },
    });
    expect(opened.outcome).toBe('ok');

    // 2 · Subscribe.
    const subscribed = await service.execute({
      operation: 'createSubscription',
      context: context(),
      payload: { subscriptionId: 'sub-1', planCode: 'growth', cycle: 'monthly' },
    });
    if (subscribed.outcome !== 'ok' || subscribed.data.kind !== 'subscription') {
      throw new Error('expected a subscription');
    }
    expect(subscribed.data.subscription.status).toBe('trialing');

    // 3 · Activate it — Billing's own machine, reached through the store.
    const active = { ...subscribed.data.subscription, status: 'active' as const, version: 2 };
    fakes.state.subscriptions = [{ ...active, providerRef: 'sub_stripe_1' }];

    // 4 · Upgrade.
    const upgraded = await service.execute({
      operation: 'changePlan',
      context: context(),
      payload: { subscriptionId: 'sub-1', planCode: 'enterprise' },
    });
    if (upgraded.outcome !== 'ok' || upgraded.data.kind !== 'subscription') {
      throw new Error('expected a subscription');
    }
    expect(upgraded.data.subscription.planId).toBe('plan-ent-v1');

    // 5 · Cancel — through the real adapter, then the real transition.
    const cancelled = await service.execute({
      operation: 'cancelSubscription',
      context: context(),
      payload: { subscriptionId: 'sub-1', idempotencyKey: 'key-cancel' },
    });
    if (cancelled.outcome !== 'ok' || cancelled.data.kind !== 'subscription') {
      throw new Error(`expected a subscription, got ${JSON.stringify(cancelled)}`);
    }
    expect(cancelled.data.subscription.status).toBe('cancel_pending');
    // The customer keeps what they paid for.
    expect(cancelled.data.subscription.currentPeriod.end).toBe('2026-04-01T00:00:00.000Z');
  });
});

// ── The real adapter, behind the facade ─────────────────────────────────────

describe('the facade delegates webhook verification to the real adapter', () => {
  const event = (type: string, object: unknown, id = 'evt_1'): unknown => ({
    id,
    type,
    created: EPOCH,
    data: { object },
  });

  it('accepts a correctly signed webhook and appends it once', async () => {
    const { service, fakes } = rig();
    const request: CommercialRequest = {
      operation: 'receiveWebhook',
      context: context(),
      payload: signedWebhook(
        event('invoice.paid', { id: 'in_1', customer: 'cus_1', subscription: 'sub_1' }),
      ),
    };

    const first = await service.execute(request);
    const second = await service.execute(request);

    if (first.outcome !== 'ok' || first.data.kind !== 'webhook') throw new Error('expected ok');
    if (second.outcome !== 'ok' || second.data.kind !== 'webhook') throw new Error('expected ok');

    expect(first.data.recorded).toBe(true);
    // The provider redelivers at least once; the second converges.
    expect(second.data.recorded).toBe(false);
    expect(fakes.state.events).toHaveLength(1);
  });

  it('refuses a forged signature, and stores nothing', async () => {
    const { service, fakes } = rig();
    const body = JSON.stringify(event('invoice.paid', { id: 'in_1' }));
    const forged = createHmac('sha256', 'whsec_attacker')
      .update(`${String(EPOCH)}.${body}`, 'utf8')
      .digest('hex');

    const result = await service.execute({
      operation: 'receiveWebhook',
      context: context(),
      payload: { payload: body, signatureHeader: `t=${String(EPOCH)},v1=${forged}` },
    });

    expect(result.outcome).toBe('refused');
    if (result.outcome === 'refused') expect(result.code).toBe('MalformedWebhook');
    expect(fakes.state.events).toHaveLength(0);
  });

  it('accepts an event type the adapter does not map, and stores nothing', async () => {
    const { service, fakes } = rig();
    const result = await service.execute({
      operation: 'receiveWebhook',
      context: context(),
      payload: signedWebhook(event('charge.refunded', { id: 'ch_1' })),
    });

    if (result.outcome !== 'ok' || result.data.kind !== 'webhook') throw new Error('expected ok');
    expect(result.data.accepted).toBe(false);
    expect(fakes.state.events).toHaveLength(0);
  });

  it('translates the type into OUR vocabulary, never the provider’s', async () => {
    const { service } = rig();
    const result = await service.execute({
      operation: 'receiveWebhook',
      context: context(),
      payload: signedWebhook(
        event('customer.subscription.deleted', { id: 'sub_1', customer: 'cus_1' }),
      ),
    });

    if (result.outcome !== 'ok' || result.data.kind !== 'webhook') throw new Error('expected ok');
    expect(result.data.eventType).toBe('subscription_cancelled');
  });

  it('applies nothing a webhook reports', async () => {
    // "Do not mutate Billing state." The subscription is untouched.
    const { service, fakes } = rig([], { subscriptions: [], plans: [plan()] });

    await service.execute({
      operation: 'receiveWebhook',
      context: context(),
      payload: signedWebhook(
        event('customer.subscription.updated', {
          id: 'sub_1',
          customer: 'cus_1',
          status: 'past_due',
        }),
      ),
    });

    expect(fakes.calls).not.toContain('subscriptions.saveSubscription');
    expect(fakes.calls).not.toContain('ledger.appendEntry');
  });
});

// ── The summary is the components' own answers ──────────────────────────────

describe('the summary reports what each owner said, unchanged', () => {
  it('carries the ledger balance through verbatim', async () => {
    const { service } = rig([], {
      balance: {
        ...emptyBalance(),
        credited: '250.000000',
        debited: '30.000000',
        balance: '220.000000',
        entries: 4,
      },
    });

    const summary = summaryOf(
      await service.execute({
        operation: 'loadCommercialSummary',
        context: context(),
        payload: {},
      }),
    );

    expect(summary.balance.balance).toBe('220.000000');
    expect(summary.balance.credited).toBe('250.000000');
    expect(summary.balance.debited).toBe('30.000000');
  });

  it('computes availability with the S5.2 rule, including − consumed', async () => {
    // 220 in the ledger; one open reservation of 25 with 5 already spent, so
    // 20 is still held down. A layer that subtracted the whole reservation
    // would take the spent 5 twice and show the customer 195.
    const { service } = rig([], {
      balance: {
        ...emptyBalance(),
        credited: '250.000000',
        debited: '30.000000',
        balance: '220.000000',
      },
      reservations: [toCreditReservation(hold())],
    });

    const summary = summaryOf(
      await service.execute({
        operation: 'loadCommercialSummary',
        context: context(),
        payload: {},
      }),
    );

    expect(summary.available.reserved).toBe('20.000000');
    expect(summary.available.available).toBe('200.000000');
  });

  it('counts a closed reservation as holding nothing', async () => {
    const { service } = rig([], {
      balance: { ...emptyBalance(), credited: '100.000000', balance: '100.000000' },
      reservations: [
        toCreditReservation(hold({ id: 'h1' })),
        toCreditReservation(hold({ id: 'h2', state: 'settled', settledAt: AT })),
      ],
    });

    const summary = summaryOf(
      await service.execute({
        operation: 'loadCommercialSummary',
        context: context(),
        payload: {},
      }),
    );

    expect(summary.activeReservations).toHaveLength(1);
    expect(summary.available.activeReservations).toBe(1);
  });

  it('reports the plan the subscription is actually on', async () => {
    const { service, fakes } = rig([], { plans: [plan(), enterprise] });

    await service.execute({
      operation: 'createBillingAccount',
      context: context(),
      payload: { currency: 'USD' },
    });
    const subscribed = await service.execute({
      operation: 'createSubscription',
      context: context(),
      payload: { subscriptionId: 'sub-1', planCode: 'enterprise', cycle: 'annual' },
    });
    if (subscribed.outcome !== 'ok') throw new Error('expected ok');

    const summary = summaryOf(
      await service.execute({
        operation: 'loadCommercialSummary',
        context: context(),
        payload: {},
      }),
    );

    expect(summary.plan?.code).toBe('enterprise');
    expect(summary.subscription?.currentPeriod.cycle).toBe('annual');
    expect(fakes.state.subscriptions).toHaveLength(1);
  });

  it('reports an organization with nothing as nulls and a zero balance', async () => {
    const { service } = rig();
    const summary = summaryOf(
      await service.execute({
        operation: 'loadCommercialSummary',
        context: context(),
        payload: {},
      }),
    );

    expect(summary.account).toBeNull();
    expect(summary.subscription).toBeNull();
    expect(summary.plan).toBeNull();
    expect(summary.balance.balance).toBe('0.000000');
    expect(summary.available.available).toBe('0.000000');
  });
});

// ── Tenancy ─────────────────────────────────────────────────────────────────

describe('one organization cannot reach another’s commercial state', () => {
  it('refuses a subscription id belonging to someone else', async () => {
    const other = '018f7a1e-0000-7000-8000-0000000000ff';
    const { service } = rig([], {
      plans: [plan(), enterprise],
      subscriptions: [
        {
          subscriptionId: 'sub-theirs',
          organizationId: other,
          planId: 'plan-growth-v1',
          status: 'active',
          currentPeriod: { start: AT, end: '2026-04-01T00:00:00.000Z', cycle: 'monthly' },
          startedAt: AT,
          renewsAt: '2026-04-01T00:00:00.000Z',
          cancelledAt: null,
          providerRef: null,
          version: 2,
          updatedAt: AT,
        },
      ],
    });

    const result = await service.execute({
      operation: 'changePlan',
      context: context(),
      payload: { subscriptionId: 'sub-theirs', planCode: 'enterprise' },
    });

    expect(result.outcome).toBe('refused');
    if (result.outcome === 'refused') expect(result.code).toBe('OwnershipMismatch');
  });

  it('reads the summary for the context’s organization only', async () => {
    const other = '018f7a1e-0000-7000-8000-0000000000ff';
    const { service } = rig([], {
      accounts: [],
      reservations: [toCreditReservation({ ...hold(), organizationId: other, tenantId: other })],
      balance: { ...emptyBalance(), credited: '100.000000', balance: '100.000000' },
    });

    const summary = summaryOf(
      await service.execute({
        operation: 'loadCommercialSummary',
        context: context(),
        payload: {},
      }),
    );

    // The other organization's reservation holds nothing down here.
    expect(summary.activeReservations).toHaveLength(0);
    expect(summary.available.available).toBe('100.000000');
  });
});
