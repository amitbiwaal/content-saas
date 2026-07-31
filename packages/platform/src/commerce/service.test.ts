import { describe, expect, it } from 'vitest';

import type { Principal } from '@contentos/security';

import { createBillingAccount } from '../billing/account.js';
import { createPlan, UNSET_RATE_LIMITS, type CommercialPlan } from '../billing/plan.js';
import { applyTransition, createSubscription, type Subscription } from '../billing/subscription.js';
import { toCreditReservation } from '../credits/reservation.js';
import type { CreditHold } from '../credits/holds.js';
import { createFakes, emptyBalance, type Fakes, type FakeState } from './fakes.fixture.js';
import {
  COMMERCIAL_OPERATIONS,
  isCommercialOperation,
  type CommercialRequest,
  type CommercialResult,
  type CommercialSummary,
} from './model.js';
import {
  COMMERCIAL_ERROR_CODES,
  createCommercialService,
  isCommercialErrorCode,
  type CommercialService,
} from './service.js';

const ORG = '018f7a1e-0000-7000-8000-0000000000aa';
const OTHER = '018f7a1e-0000-7000-8000-0000000000ff';
const AT = '2026-03-01T00:00:00.000Z';

const principal: Principal = Object.freeze({
  subjectId: '018f7a1e-0000-7000-8000-000000000001',
  kind: 'user',
  organizationId: ORG,
  roles: Object.freeze([]),
  permissions: Object.freeze([]),
  sessionId: '018f7a1e-0000-7000-8000-000000000002',
}) as unknown as Principal;

const context = (overrides: Partial<CommercialRequest['context']> = {}) => ({
  principal,
  organizationId: ORG,
  requestId: 'req-1',
  correlationId: 'corr-1',
  at: AT,
  ...overrides,
});

const plan = (overrides: Partial<Parameters<typeof createPlan>[0]> = {}): CommercialPlan =>
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
    ...overrides,
  });

const account = (organizationId = ORG) =>
  createBillingAccount({ organizationId, currency: 'USD', status: 'active', createdAt: AT });

const subscription = (overrides: Partial<Parameters<typeof createSubscription>[0]> = {}) =>
  createSubscription({
    subscriptionId: 'sub-1',
    organizationId: ORG,
    plan: plan(),
    cycle: 'monthly',
    startedAt: AT,
    ...overrides,
  });

const activeSubscription = (over: Partial<Parameters<typeof createSubscription>[0]> = {}) =>
  applyTransition(subscription(over), 'activate', AT);

const hold = (overrides: Partial<CreditHold> = {}): CreditHold => ({
  id: 'hold-1',
  tenantId: ORG,
  organizationId: ORG,
  workspaceId: '018f7a1e-0000-7000-8000-0000000000bb',
  runId: 'run-1',
  amount: '10.000000',
  consumed: '0.000000',
  state: 'held',
  expiresAt: '2026-03-02T00:00:00.000Z',
  reason: 'a run',
  correlationId: 'corr-1',
  createdBy: null,
  metadata: {},
  createdAt: AT,
  settledAt: null,
  releasedAt: null,
  ...overrides,
});

const session = (id = 'cs_1') =>
  ({
    outcome: 'succeeded' as const,
    value: {
      providerId: 'stripe' as const,
      externalSessionId: id,
      kind: 'checkout' as const,
      organizationId: ORG,
      url: 'https://checkout.example/x',
      expiresAt: null,
      createdAt: AT,
    },
  }) as const;

const customer = () => ({
  providerId: 'stripe' as const,
  externalCustomerId: 'cus_1',
  organizationId: ORG,
  accountId: ORG,
  createdAt: AT,
});

function rig(state: Partial<FakeState> = {}): {
  service: CommercialService;
  fakes: Fakes;
} {
  const fakes = createFakes(state);
  return { service: createCommercialService(fakes), fakes };
}

const codeOf = (result: CommercialResult): string | null =>
  result.outcome === 'refused' ? result.code : null;

const summaryOf = (result: CommercialResult): CommercialSummary => {
  if (result.outcome !== 'ok' || result.data.kind !== 'summary') {
    throw new Error(`expected a summary, got ${JSON.stringify(result)}`);
  }
  return result.data.summary;
};

// ── The surface ─────────────────────────────────────────────────────────────

describe('the commercial surface', () => {
  it('names the eight operations the increment lists', () => {
    expect(COMMERCIAL_OPERATIONS).toEqual([
      'createBillingAccount',
      'createSubscription',
      'changePlan',
      'cancelSubscription',
      'createCheckoutSession',
      'createPortalSession',
      'receiveWebhook',
      'loadCommercialSummary',
    ]);
  });

  it('rejects anything else as an operation', () => {
    expect(isCommercialOperation('deleteEverything')).toBe(false);
    expect(isCommercialOperation(null)).toBe(false);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(rig().service)).toBe(true);
  });

  it('contributes the codes of the layers it delegates to', () => {
    // Spread in rather than restated: a caller branching on a billing failure
    // sees the code billing gave it.
    for (const code of ['PlanNotFound', 'IncompatiblePlan', 'InvalidTransition', 'StaleVersion']) {
      expect(isCommercialErrorCode(code)).toBe(true);
    }
    expect(isCommercialErrorCode('SomethingElse')).toBe(false);
  });

  it('has no duplicate codes', () => {
    expect(new Set(COMMERCIAL_ERROR_CODES).size).toBe(COMMERCIAL_ERROR_CODES.length);
  });
});

// ── Validation ──────────────────────────────────────────────────────────────

describe('request completeness', () => {
  it('refuses a request with no organization', async () => {
    const { service } = rig();
    const result = await service.loadCommercialSummary({
      operation: 'loadCommercialSummary',
      context: context({ organizationId: '' }),
      payload: {},
    });

    expect(codeOf(result)).toBe('MissingIdentifier');
  });

  it('refuses a request with no trace', async () => {
    const { service } = rig();
    const result = await service.loadCommercialSummary({
      operation: 'loadCommercialSummary',
      context: context({ requestId: '', correlationId: '' }),
      payload: {},
    });

    expect(codeOf(result)).toBe('MissingIdentifier');
  });

  it('refuses a request with no instant', async () => {
    // Every downstream model takes its instant from the request.
    const { service } = rig();
    const result = await service.createBillingAccount({
      operation: 'createBillingAccount',
      context: context({ at: '' }),
      payload: { currency: 'USD' },
    });

    expect(codeOf(result)).toBe('MissingIdentifier');
  });

  it('names the fields that were wrong', async () => {
    const { service } = rig();
    const result = await service.createSubscription({
      operation: 'createSubscription',
      context: context(),
      payload: { subscriptionId: '', planCode: 'nope' as 'growth', cycle: 'weekly' as 'monthly' },
    });

    if (result.outcome !== 'refused') throw new Error('expected a refusal');
    const fields = result.issues.map((issue) => issue.field);
    expect(fields).toContain('payload.subscriptionId');
    expect(fields).toContain('payload.planCode');
    expect(fields).toContain('payload.cycle');
  });

  it('reaches no delegate when the request is incomplete', async () => {
    // A malformed request must not cost a database read.
    const { service, fakes } = rig();
    await service.changePlan({
      operation: 'changePlan',
      context: context(),
      payload: { subscriptionId: '', planCode: 'growth' },
    });

    expect(fakes.calls).toEqual([]);
  });

  it('refuses an unsupported operation through execute', async () => {
    const { service } = rig();
    const result = await service.execute({
      operation: 'mintCredits',
      context: context(),
      payload: {},
    } as unknown as CommercialRequest);

    expect(codeOf(result)).toBe('InvalidOperation');
  });

  it('echoes the operation it was asked for, even when it does not exist', async () => {
    const { service } = rig();
    const result = await service.execute({
      operation: 'mintCredits',
      context: context(),
      payload: {},
    } as unknown as CommercialRequest);

    expect(result.operation).toBe('mintCredits');
  });
});

// ── createBillingAccount ────────────────────────────────────────────────────

describe('createBillingAccount', () => {
  it('delegates to Billing and the repository, and nothing else', async () => {
    const { service, fakes } = rig();
    const result = await service.createBillingAccount({
      operation: 'createBillingAccount',
      context: context(),
      payload: { currency: 'USD' },
    });

    expect(result.outcome).toBe('ok');
    expect(fakes.calls).toEqual(['accounts.findAccountForOrganization', 'accounts.createAccount']);
  });

  it('takes the organization from the CONTEXT, never a payload', async () => {
    // A payload naming an organization is how a caller subscribes somebody else.
    const { service } = rig();
    const result = await service.createBillingAccount({
      operation: 'createBillingAccount',
      context: context(),
      payload: { currency: 'USD', organizationId: OTHER } as never,
    });

    if (result.outcome !== 'ok' || result.data.kind !== 'account') throw new Error('expected ok');
    expect(result.data.account.organizationId).toBe(ORG);
  });

  it('refuses a second account for one organization', async () => {
    const { service } = rig({ accounts: [account()] });
    const result = await service.createBillingAccount({
      operation: 'createBillingAccount',
      context: context(),
      payload: { currency: 'USD' },
    });

    expect(codeOf(result)).toBe('OwnershipMismatch');
  });

  it('lets Billing refuse a bad currency, with Billing’s own code', async () => {
    const { service } = rig();
    const result = await service.createBillingAccount({
      operation: 'createBillingAccount',
      context: context(),
      payload: { currency: 'dollars' },
    });

    expect(codeOf(result)).toBe('InvalidDeclaration');
  });

  it('carries the workspace through as attribution', async () => {
    const { service } = rig();
    const result = await service.createBillingAccount({
      operation: 'createBillingAccount',
      context: context(),
      payload: { currency: 'USD', workspaceId: 'ws-1' },
    });

    if (result.outcome !== 'ok' || result.data.kind !== 'account') throw new Error('expected ok');
    expect(result.data.account.workspaceId).toBe('ws-1');
    // And it is still the organization's account.
    expect(result.data.account.accountId).toBe(ORG);
  });
});

// ── createSubscription ──────────────────────────────────────────────────────

describe('createSubscription', () => {
  it('resolves the plan and delegates to Billing', async () => {
    const { service, fakes } = rig({ accounts: [account()], plans: [plan()] });
    const result = await service.createSubscription({
      operation: 'createSubscription',
      context: context(),
      payload: { subscriptionId: 'sub-1', planCode: 'growth', cycle: 'monthly' },
    });

    expect(result.outcome).toBe('ok');
    expect(fakes.calls).toEqual([
      'accounts.findAccountForOrganization',
      'plans.findCurrentPlan',
      'subscriptions.createSubscription',
    ]);
  });

  it('starts the subscription trialing, as Billing decides', async () => {
    const { service } = rig({ accounts: [account()], plans: [plan()] });
    const result = await service.createSubscription({
      operation: 'createSubscription',
      context: context(),
      payload: { subscriptionId: 'sub-1', planCode: 'growth', cycle: 'monthly' },
    });

    if (result.outcome !== 'ok' || result.data.kind !== 'subscription') {
      throw new Error('expected ok');
    }
    expect(result.data.subscription.status).toBe('trialing');
    expect(result.data.subscription.organizationId).toBe(ORG);
  });

  it('refuses when the organization has no billing account', async () => {
    const { service } = rig({ plans: [plan()] });
    const result = await service.createSubscription({
      operation: 'createSubscription',
      context: context(),
      payload: { subscriptionId: 'sub-1', planCode: 'growth', cycle: 'monthly' },
    });

    expect(codeOf(result)).toBe('AccountNotFound');
  });

  it('refuses when the catalogue has no current plan for the code', async () => {
    const { service } = rig({ accounts: [account()] });
    const result = await service.createSubscription({
      operation: 'createSubscription',
      context: context(),
      payload: { subscriptionId: 'sub-1', planCode: 'growth', cycle: 'monthly' },
    });

    expect(codeOf(result)).toBe('PlanNotFound');
  });

  it('lets Billing refuse a retired plan, with Billing’s own code', async () => {
    // The facade does not know what "subscribable" means; the plan does.
    const { service } = rig({
      accounts: [account()],
      plans: [plan({ status: 'retired' })],
    });
    const result = await service.createSubscription({
      operation: 'createSubscription',
      context: context(),
      payload: { subscriptionId: 'sub-1', planCode: 'growth', cycle: 'monthly' },
    });

    // A retired plan is never the CURRENT one, so the catalogue answers first.
    expect(codeOf(result)).toBe('PlanNotFound');
  });

  it('lets the store refuse a second live subscription', async () => {
    const { service } = rig({
      accounts: [account()],
      plans: [plan()],
      subscriptions: [activeSubscription()],
    });
    const result = await service.createSubscription({
      operation: 'createSubscription',
      context: context(),
      payload: { subscriptionId: 'sub-2', planCode: 'growth', cycle: 'monthly' },
    });

    expect(codeOf(result)).toBe('SubscriptionConflict');
  });
});

// ── changePlan ──────────────────────────────────────────────────────────────

describe('changePlan', () => {
  const enterprise = plan({ planId: 'plan-ent-v1', code: 'enterprise' });

  it('delegates to Billing’s changePlan and saves the result', async () => {
    const { service, fakes } = rig({
      subscriptions: [activeSubscription()],
      plans: [plan(), enterprise],
    });
    const result = await service.changePlan({
      operation: 'changePlan',
      context: context(),
      payload: { subscriptionId: 'sub-1', planCode: 'enterprise' },
    });

    if (result.outcome !== 'ok' || result.data.kind !== 'subscription') {
      throw new Error('expected ok');
    }
    expect(result.data.subscription.planId).toBe('plan-ent-v1');
    expect(fakes.calls).toEqual([
      'subscriptions.loadSubscription',
      'plans.findCurrentPlan',
      'subscriptions.saveSubscription',
    ]);
  });

  it('advances the version, so a stale write is detectable', async () => {
    const before = activeSubscription();
    const { service } = rig({ subscriptions: [before], plans: [plan(), enterprise] });
    const result = await service.changePlan({
      operation: 'changePlan',
      context: context(),
      payload: { subscriptionId: 'sub-1', planCode: 'enterprise' },
    });

    if (result.outcome !== 'ok' || result.data.kind !== 'subscription') {
      throw new Error('expected ok');
    }
    expect(result.data.subscription.version).toBe(before.version + 1);
  });

  it('refuses a subscription belonging to another organization', async () => {
    const theirs = createSubscription({
      subscriptionId: 'sub-9',
      organizationId: OTHER,
      plan: plan(),
      cycle: 'monthly',
      startedAt: AT,
    });
    const { service } = rig({ subscriptions: [theirs], plans: [plan(), enterprise] });
    const result = await service.changePlan({
      operation: 'changePlan',
      context: context(),
      payload: { subscriptionId: 'sub-9', planCode: 'enterprise' },
    });

    expect(codeOf(result)).toBe('OwnershipMismatch');
  });

  it('does not echo the other organization’s id back', async () => {
    // A caller that guessed an id should not learn whose it was.
    const theirs = createSubscription({
      subscriptionId: 'sub-9',
      organizationId: OTHER,
      plan: plan(),
      cycle: 'monthly',
      startedAt: AT,
    });
    const { service } = rig({ subscriptions: [theirs], plans: [plan(), enterprise] });
    const result = await service.changePlan({
      operation: 'changePlan',
      context: context(),
      payload: { subscriptionId: 'sub-9', planCode: 'enterprise' },
    });

    if (result.outcome !== 'refused') throw new Error('expected a refusal');
    expect(JSON.stringify(result)).not.toContain(OTHER);
  });

  it('refuses an unknown subscription', async () => {
    const { service } = rig({ plans: [plan(), enterprise] });
    const result = await service.changePlan({
      operation: 'changePlan',
      context: context(),
      payload: { subscriptionId: 'nope', planCode: 'enterprise' },
    });

    expect(codeOf(result)).toBe('SubscriptionNotFound');
  });

  it('lets Billing refuse a change to the plan it is already on', async () => {
    const { service } = rig({ subscriptions: [activeSubscription()], plans: [plan()] });
    const result = await service.changePlan({
      operation: 'changePlan',
      context: context(),
      payload: { subscriptionId: 'sub-1', planCode: 'growth' },
    });

    expect(codeOf(result)).toBe('IncompatiblePlan');
  });

  it('never writes when Billing refuses', async () => {
    const { service, fakes } = rig({ subscriptions: [activeSubscription()], plans: [plan()] });
    await service.changePlan({
      operation: 'changePlan',
      context: context(),
      payload: { subscriptionId: 'sub-1', planCode: 'growth' },
    });

    expect(fakes.calls).not.toContain('subscriptions.saveSubscription');
  });
});

// ── cancelSubscription ──────────────────────────────────────────────────────

describe('cancelSubscription', () => {
  const withProvider = (): Subscription => ({
    ...activeSubscription(),
    providerRef: 'sub_stripe_1',
  });

  const cancelled = {
    outcome: 'succeeded' as const,
    value: {
      providerId: 'stripe' as const,
      externalSubscriptionId: 'sub_stripe_1',
      externalCustomerId: 'cus_1',
      status: 'cancel_pending' as const,
      cancelAtPeriodEnd: true,
      currentPeriodStart: AT,
      currentPeriodEnd: '2026-04-01T00:00:00.000Z',
    },
  };

  it('asks the provider BEFORE it writes', async () => {
    // Writing first and then failing at the provider would stop billing a
    // customer the provider is still charging.
    const { service, fakes } = rig({
      subscriptions: [withProvider()],
      providerCancel: cancelled,
    });
    await service.cancelSubscription({
      operation: 'cancelSubscription',
      context: context(),
      payload: { subscriptionId: 'sub-1', idempotencyKey: 'key-1' },
    });

    expect(fakes.calls).toEqual([
      'subscriptions.loadSubscription',
      'provider.cancelSubscription',
      'subscriptions.saveSubscription',
    ]);
  });

  it('moves the subscription to cancel_pending, as Billing decides', async () => {
    const { service } = rig({ subscriptions: [withProvider()], providerCancel: cancelled });
    const result = await service.cancelSubscription({
      operation: 'cancelSubscription',
      context: context(),
      payload: { subscriptionId: 'sub-1', idempotencyKey: 'key-1' },
    });

    if (result.outcome !== 'ok' || result.data.kind !== 'subscription') {
      throw new Error('expected ok');
    }
    expect(result.data.subscription.status).toBe('cancel_pending');
    expect(result.data.subscription.cancelledAt).toBe(AT);
  });

  it('does not write when the provider refuses', async () => {
    const { service, fakes } = rig({
      subscriptions: [withProvider()],
      providerCancel: {
        outcome: 'failed',
        failure: { reason: 'ProviderUnavailable', detail: 'HTTP 503', retryable: true },
      },
    });
    const result = await service.cancelSubscription({
      operation: 'cancelSubscription',
      context: context(),
      payload: { subscriptionId: 'sub-1', idempotencyKey: 'key-1' },
    });

    expect(codeOf(result)).toBe('ServiceFailed');
    expect(fakes.calls).not.toContain('subscriptions.saveSubscription');
  });

  it('skips the provider for a subscription it never created there', async () => {
    const { service, fakes } = rig({ subscriptions: [activeSubscription()] });
    const result = await service.cancelSubscription({
      operation: 'cancelSubscription',
      context: context(),
      payload: { subscriptionId: 'sub-1', idempotencyKey: 'key-1' },
    });

    expect(result.outcome).toBe('ok');
    expect(fakes.calls).not.toContain('provider.cancelSubscription');
  });

  it('requires an idempotency key, because the provider has no undo', async () => {
    const { service } = rig({ subscriptions: [withProvider()] });
    const result = await service.cancelSubscription({
      operation: 'cancelSubscription',
      context: context(),
      payload: { subscriptionId: 'sub-1', idempotencyKey: '' },
    });

    expect(codeOf(result)).toBe('MissingIdentifier');
  });

  it('lets Billing refuse cancelling a trialing subscription', async () => {
    const { service } = rig({ subscriptions: [subscription()] });
    const result = await service.cancelSubscription({
      operation: 'cancelSubscription',
      context: context(),
      payload: { subscriptionId: 'sub-1', idempotencyKey: 'key-1' },
    });

    expect(codeOf(result)).toBe('InvalidTransition');
  });
});

// ── Sessions ────────────────────────────────────────────────────────────────

describe('createCheckoutSession', () => {
  it('resolves the customer and delegates to the provider', async () => {
    const { service, fakes } = rig({
      accounts: [account()],
      customers: [customer()],
      providerSession: session(),
    });
    const result = await service.createCheckoutSession({
      operation: 'createCheckoutSession',
      context: context(),
      payload: {
        externalPriceId: 'price_1',
        successUrl: 'https://a/ok',
        cancelUrl: 'https://a/no',
        idempotencyKey: 'key-1',
      },
    });

    expect(result.outcome).toBe('ok');
    expect(fakes.calls).toEqual([
      'accounts.findAccountForOrganization',
      'paymentCustomers.findCustomer',
      'provider.createCheckoutSession',
    ]);
  });

  it('returns the provider-hosted URL', async () => {
    const { service } = rig({
      accounts: [account()],
      customers: [customer()],
      providerSession: session(),
    });
    const result = await service.createCheckoutSession({
      operation: 'createCheckoutSession',
      context: context(),
      payload: {
        externalPriceId: 'price_1',
        successUrl: 'https://a/ok',
        cancelUrl: 'https://a/no',
        idempotencyKey: 'key-1',
      },
    });

    if (result.outcome !== 'ok' || result.data.kind !== 'session') throw new Error('expected ok');
    expect(result.data.session.url).toBe('https://checkout.example/x');
  });

  it('refuses when there is no customer at the provider', async () => {
    const { service } = rig({ accounts: [account()], providerSession: session() });
    const result = await service.createCheckoutSession({
      operation: 'createCheckoutSession',
      context: context(),
      payload: {
        externalPriceId: 'price_1',
        successUrl: 'https://a/ok',
        cancelUrl: 'https://a/no',
        idempotencyKey: 'key-1',
      },
    });

    expect(codeOf(result)).toBe('AccountNotFound');
  });

  it('reports a provider failure as a refusal, not a throw', async () => {
    const { service } = rig({
      accounts: [account()],
      customers: [customer()],
      providerSession: {
        outcome: 'failed',
        failure: { reason: 'PaymentFailed', detail: 'declined', retryable: false },
      },
    });
    const result = await service.createCheckoutSession({
      operation: 'createCheckoutSession',
      context: context(),
      payload: {
        externalPriceId: 'price_1',
        successUrl: 'https://a/ok',
        cancelUrl: 'https://a/no',
        idempotencyKey: 'key-1',
      },
    });

    expect(codeOf(result)).toBe('ServiceFailed');
  });
});

describe('createPortalSession', () => {
  it('delegates to the provider', async () => {
    const { service, fakes } = rig({
      accounts: [account()],
      customers: [customer()],
      providerSession: session('bps_1'),
    });
    const result = await service.createPortalSession({
      operation: 'createPortalSession',
      context: context(),
      payload: { returnUrl: 'https://a' },
    });

    expect(result.outcome).toBe('ok');
    expect(fakes.calls).toContain('provider.createPortalSession');
  });

  it('requires a return URL', async () => {
    const { service } = rig({ accounts: [account()], customers: [customer()] });
    const result = await service.createPortalSession({
      operation: 'createPortalSession',
      context: context(),
      payload: { returnUrl: '' },
    });

    expect(codeOf(result)).toBe('MissingIdentifier');
  });
});

// ── receiveWebhook ──────────────────────────────────────────────────────────

describe('receiveWebhook', () => {
  const event = {
    providerId: 'stripe' as const,
    eventId: 'evt_1',
    type: 'invoice_paid' as const,
    providerEventType: 'invoice.paid',
    occurredAt: AT,
    externalCustomerId: 'cus_1',
    externalSubscriptionId: 'sub_1',
    organizationId: ORG,
    subscriptionId: null,
  };

  it('delegates verification to the provider and appends the result', async () => {
    const { service, fakes } = rig({ webhook: { outcome: 'accepted', event } });
    const result = await service.receiveWebhook({
      operation: 'receiveWebhook',
      context: context(),
      payload: { payload: '{}', signatureHeader: 't=1,v1=x' },
    });

    expect(result.outcome).toBe('ok');
    expect(fakes.calls).toEqual(['provider.receiveWebhook', 'paymentEvents.recordEvent']);
  });

  it('reports a redelivery as recorded: false, still a success', async () => {
    // The provider redelivers at least once; failing would make it retry.
    const { service } = rig({ webhook: { outcome: 'accepted', event }, events: [event] });
    const result = await service.receiveWebhook({
      operation: 'receiveWebhook',
      context: context(),
      payload: { payload: '{}', signatureHeader: 't=1,v1=x' },
    });

    if (result.outcome !== 'ok' || result.data.kind !== 'webhook') throw new Error('expected ok');
    expect(result.data.recorded).toBe(false);
    expect(result.data.accepted).toBe(true);
  });

  it('reports an unmapped event type as a success that stored nothing', async () => {
    const { service, fakes } = rig({
      webhook: {
        outcome: 'ignored',
        providerId: 'stripe',
        eventId: 'evt_2',
        providerEventType: 'charge.refunded',
      },
    });
    const result = await service.receiveWebhook({
      operation: 'receiveWebhook',
      context: context(),
      payload: { payload: '{}', signatureHeader: 't=1,v1=x' },
    });

    if (result.outcome !== 'ok' || result.data.kind !== 'webhook') throw new Error('expected ok');
    expect(result.data.accepted).toBe(false);
    expect(result.data.eventType).toBeNull();
    expect(fakes.calls).not.toContain('paymentEvents.recordEvent');
  });

  it('refuses a rejected signature', async () => {
    const { service, fakes } = rig({
      webhook: {
        outcome: 'rejected',
        failure: { reason: 'WebhookInvalid', detail: 'bad signature', retryable: false },
      },
    });
    const result = await service.receiveWebhook({
      operation: 'receiveWebhook',
      context: context(),
      payload: { payload: '{}', signatureHeader: 't=1,v1=wrong' },
    });

    expect(codeOf(result)).toBe('MalformedWebhook');
    expect(fakes.calls).not.toContain('paymentEvents.recordEvent');
  });

  it('refuses an unsigned delivery before the provider is reached', async () => {
    const { service, fakes } = rig();
    const result = await service.receiveWebhook({
      operation: 'receiveWebhook',
      context: context(),
      payload: { payload: '{}', signatureHeader: '' },
    });

    expect(codeOf(result)).toBe('MissingIdentifier');
    expect(fakes.calls).toEqual([]);
  });

  it('applies nothing: no subscription and no ledger call', async () => {
    // "Do not mutate Billing state" — appending is not applying.
    const { service, fakes } = rig({ webhook: { outcome: 'accepted', event } });
    await service.receiveWebhook({
      operation: 'receiveWebhook',
      context: context(),
      payload: { payload: '{}', signatureHeader: 't=1,v1=x' },
    });

    expect(fakes.calls).not.toContain('subscriptions.saveSubscription');
    expect(fakes.calls).not.toContain('ledger.appendEntry');
  });
});

// ── loadCommercialSummary ───────────────────────────────────────────────────

describe('loadCommercialSummary', () => {
  const arranged = () =>
    rig({
      accounts: [account()],
      subscriptions: [activeSubscription()],
      plans: [plan()],
      balance: { ...emptyBalance(), credited: '100.000000', balance: '100.000000', entries: 1 },
      reservations: [toCreditReservation(hold())],
    });

  it('assembles all six parts from their owners', async () => {
    const { service, fakes } = arranged();
    const result = await service.loadCommercialSummary({
      operation: 'loadCommercialSummary',
      context: context(),
      payload: {},
    });

    const summary = summaryOf(result);
    expect(summary.account?.organizationId).toBe(ORG);
    expect(summary.subscription?.subscriptionId).toBe('sub-1');
    expect(summary.plan?.planId).toBe('plan-growth-v1');
    expect(summary.balance.balance).toBe('100.000000');
    expect(summary.activeReservations).toHaveLength(1);

    expect(fakes.calls).toEqual([
      'accounts.findAccountForOrganization',
      'subscriptions.findLiveSubscription',
      'plans.loadPlan',
      'ledger.calculateBalance',
      'reservations.listReservations',
    ]);
  });

  it('takes the balance from the ledger, never recomputing it', async () => {
    const { service, fakes } = arranged();
    await service.loadCommercialSummary({
      operation: 'loadCommercialSummary',
      context: context(),
      payload: {},
    });

    expect(fakes.calls).toContain('ledger.calculateBalance');
    expect(fakes.calls).not.toContain('ledger.loadLedger');
  });

  it('computes availability with the frozen S5.2 calculation', async () => {
    // 100 in the ledger, 10 reserved and unspent → 90 available.
    const { service } = arranged();
    const summary = summaryOf(
      await service.loadCommercialSummary({
        operation: 'loadCommercialSummary',
        context: context(),
        payload: {},
      }),
    );

    expect(summary.available.reserved).toBe('10.000000');
    expect(summary.available.available).toBe('90.000000');
  });

  it('asks for active reservations only', async () => {
    const { service } = rig({
      accounts: [account()],
      balance: { ...emptyBalance(), credited: '100.000000', balance: '100.000000' },
      reservations: [
        toCreditReservation(hold()),
        toCreditReservation(hold({ id: 'hold-2', state: 'settled', settledAt: AT })),
      ],
    });
    const summary = summaryOf(
      await service.loadCommercialSummary({
        operation: 'loadCommercialSummary',
        context: context(),
        payload: {},
      }),
    );

    expect(summary.activeReservations).toHaveLength(1);
  });

  it('returns nulls rather than inventing an account that does not exist', async () => {
    const { service } = rig();
    const summary = summaryOf(
      await service.loadCommercialSummary({
        operation: 'loadCommercialSummary',
        context: context(),
        payload: {},
      }),
    );

    expect(summary.account).toBeNull();
    expect(summary.subscription).toBeNull();
    expect(summary.plan).toBeNull();
  });

  it('skips the plan lookup when there is no subscription', async () => {
    const { service, fakes } = rig({ accounts: [account()] });
    await service.loadCommercialSummary({
      operation: 'loadCommercialSummary',
      context: context(),
      payload: {},
    });

    expect(fakes.calls).not.toContain('plans.loadPlan');
  });

  it('is frozen through', async () => {
    const { service } = arranged();
    const result = await service.loadCommercialSummary({
      operation: 'loadCommercialSummary',
      context: context(),
      payload: {},
    });

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(summaryOf(result))).toBe(true);
  });
});

// ── Nothing throws ──────────────────────────────────────────────────────────

describe('the facade never throws', () => {
  it('turns a delegate fault into a refusal with a code', async () => {
    const fakes = createFakes({ accounts: [] });
    const broken = createCommercialService({
      ...fakes,
      accounts: {
        createAccount: () => Promise.reject(new Error('the database is on fire')),
        loadAccount: () => Promise.resolve(null),
        findAccountForOrganization: () => Promise.resolve(null),
      },
    });

    const result = await broken.createBillingAccount({
      operation: 'createBillingAccount',
      context: context(),
      payload: { currency: 'USD' },
    });

    expect(codeOf(result)).toBe('ServiceFailed');
  });

  it('keeps a BillingError’s own code rather than flattening it', async () => {
    // Flattening would send an operator looking in the wrong place.
    const { service } = rig({ accounts: [account()] });
    const result = await service.createBillingAccount({
      operation: 'createBillingAccount',
      context: context(),
      payload: { currency: 'USD' },
    });

    expect(codeOf(result)).toBe('OwnershipMismatch');
  });

  it('answers every operation without throwing, however wrong the request', async () => {
    const { service } = rig();
    for (const operation of COMMERCIAL_OPERATIONS) {
      const result = await service.execute({
        operation,
        context: context(),
        payload: {},
      } as unknown as CommercialRequest);

      expect(['ok', 'refused']).toContain(result.outcome);
    }
  });
});

// ── The trace ───────────────────────────────────────────────────────────────

describe('the trace comes back on every answer', () => {
  it('on a success', async () => {
    const { service } = rig();
    const result = await service.loadCommercialSummary({
      operation: 'loadCommercialSummary',
      context: context(),
      payload: {},
    });

    expect(result.trace).toEqual({ requestId: 'req-1', correlationId: 'corr-1' });
  });

  it('on a refusal', async () => {
    const { service } = rig();
    const result = await service.changePlan({
      operation: 'changePlan',
      context: context(),
      payload: { subscriptionId: 'nope', planCode: 'growth' },
    });

    expect(result.trace).toEqual({ requestId: 'req-1', correlationId: 'corr-1' });
  });

  it('carries no principal back down the wire', async () => {
    const { service } = rig();
    const result = await service.loadCommercialSummary({
      operation: 'loadCommercialSummary',
      context: context(),
      payload: {},
    });

    expect(Object.keys(result.trace)).toEqual(['requestId', 'correlationId']);
    expect(JSON.stringify(result)).not.toContain(principal.subjectId);
  });
});

// ── execute dispatches to the same code ─────────────────────────────────────

describe('execute and the named methods cannot answer differently', () => {
  it('routes each operation to its method', async () => {
    const direct = rig({ accounts: [account()] });
    const viaExecute = rig({ accounts: [account()] });

    const request: CommercialRequest = {
      operation: 'loadCommercialSummary',
      context: context(),
      payload: {},
    };

    expect(await viaExecute.service.execute(request)).toEqual(
      await direct.service.loadCommercialSummary(request),
    );
  });

  it('reaches the same delegates either way', async () => {
    const direct = rig({ accounts: [account()] });
    const viaExecute = rig({ accounts: [account()] });

    const request: CommercialRequest = {
      operation: 'createBillingAccount',
      context: context(),
      payload: { currency: 'EUR' },
    };

    await direct.service.createBillingAccount(request);
    await viaExecute.service.execute(request);

    expect(viaExecute.fakes.calls).toEqual(direct.fakes.calls);
  });
});
