/**
 * The Commercial Service Facade — one way in.
 *
 *   request → validate → delegate to the ONE component that owns it → respond
 *
 * ── It coordinates. It decides nothing ─────────────────────────────────────
 * Every operation is a routing decision and a shape change. An account goes to
 * Billing's `createBillingAccount`, a plan change to its `changePlan`, a
 * checkout to the `PaymentProvider`, a balance to the ledger repository. There
 * is no lifecycle rule, no arithmetic, no signature check and no plan
 * validation here — all of those have owners, and a second copy in the entry
 * point would be the copy every caller actually hit.
 *
 * The two places that might look like logic are not:
 *   - `calculateAvailability` is CALLED, not reimplemented. It is the frozen
 *     S5.2 function, and the summary asking it is the same as any other caller
 *     asking it.
 *   - `changePlan` and `createSubscription` call Billing's own pure functions
 *     and hand the result to the repository. The rule about which plans and
 *     which transitions are legal stays inside those functions.
 *
 * ── It holds services and ports, never their insides ───────────────────────
 * No Stripe client, no database handle, no transport, no HTTP. Everything
 * arrives as an interface through `createCommercialService`, and the file
 * constructs none of them: there is no `new`, no factory call and no default
 * anywhere below, which is what "no service locator, no globals" means when it
 * is structural rather than a promise.
 *
 * ── Nothing throws ─────────────────────────────────────────────────────────
 * Every operation returns a success or a refusal, including when a delegate
 * throws: an entry point that could throw would make every caller wrap it, and
 * the first one that forgot would turn a service fault into a 500 with no code.
 *
 * A `BillingError` from a delegate keeps ITS code — the taxonomy already says
 * what went wrong, and re-labelling it `ServiceFailed` would lose that.
 *
 * ── No clock, no id generator, no identity ─────────────────────────────────
 * Every timestamp, id and principal this layer passes on came in with the
 * request. That is what "never create synthetic identity" means when it is
 * structural.
 *
 * ── Provider first, then our record ────────────────────────────────────────
 * `cancelSubscription` asks the provider before it writes. `billing.md`:
 * "Stripe is the source of truth for money; we are the source of truth for
 * entitlement." A record written first and a provider call that then failed
 * would stop billing a customer who is still being charged — the expensive way
 * round. The other way, reconciliation repairs it.
 */

import type { BillingAccount } from '../billing/account.js';
import { createBillingAccount } from '../billing/account.js';
import { BillingError, type BillingErrorCode } from '../billing/errors.js';
import type {
  PaymentEvent,
  PaymentProvider,
  PaymentSession,
} from '../billing/payments/provider.js';
import type {
  PaymentCustomerRepository,
  PaymentEventRepository,
} from '../billing/payments/repository.js';
import type { CommercialPlan } from '../billing/plan.js';
import type {
  BillingAccountRepository,
  PlanRepository,
  SubscriptionRepository,
} from '../billing/repository.js';
import type { Subscription } from '../billing/subscription.js';
import { applyTransition, changePlan, createSubscription } from '../billing/subscription.js';
import { calculateAvailability } from '../credits/availability.js';
import type { CreditLedgerRepository } from '../credits/repository.js';
import type { CreditReservationRepository } from '../credits/reservation-repository.js';
import {
  COMMERCIAL_OPERATIONS,
  isCommercialOperation,
  type CommercialContext,
  type CommercialData,
  type CommercialOperation,
  type CommercialRefusal,
  type CommercialRequest,
  type CommercialResult,
  type CommercialSummary,
  type CommercialTrace,
} from './model.js';
import { ownershipIssue, validateCommercialRequest, type RequestIssue } from './validation.js';

/**
 * Every code this surface can return.
 *
 * Contributed by the layers it delegates to, spread in rather than restated,
 * plus the four things only an entry point can refuse.
 */
const BILLING_CODES: readonly BillingErrorCode[] = [
  'InvalidTransition',
  'DuplicateSubscription',
  'SubscriptionConflict',
  'SubscriptionNotFound',
  'PlanNotFound',
  'IncompatiblePlan',
  'InvalidBillingCycle',
  'InvalidBillingPeriod',
  'InvalidDeclaration',
  'ImmutableFieldChanged',
  'OwnershipMismatch',
  'StaleVersion',
  'UnknownProvider',
  'MalformedWebhook',
  'DuplicateWebhook',
];

const CONTRIBUTED = [
  ...BILLING_CODES,
  'InvalidOperation',
  'MissingIdentifier',
  'InvalidRequest',
  /** A dependency this operation needs was not composed in. */
  'MissingDependency',
  /** The organization has no billing account, and this operation needs one. */
  'AccountNotFound',
  /**
   * A delegate threw.
   *
   * Nothing in the existing taxonomy means this, and something has to: a
   * service that raises rather than refusing is a fault, not an answer, and a
   * caller told `InvalidRequest` would go looking for its own mistake.
   */
  'ServiceFailed',
] as const;

export type CommercialErrorCode = (typeof CONTRIBUTED)[number];

export const COMMERCIAL_ERROR_CODES: readonly CommercialErrorCode[] = Object.freeze([
  ...new Set(CONTRIBUTED),
]);

export function isCommercialErrorCode(value: unknown): value is CommercialErrorCode {
  return typeof value === 'string' && (COMMERCIAL_ERROR_CODES as readonly string[]).includes(value);
}

/**
 * What the facade is composed from. Interfaces, every one.
 *
 * `provider` is a `PaymentProvider`, not a Stripe adapter: this file has no way
 * to know which provider it holds, which is what keeps Stripe an implementation
 * detail. The repositories are ports; nothing here can reach a database.
 */
export interface CommercialServiceOptions {
  readonly accounts: BillingAccountRepository;
  readonly subscriptions: SubscriptionRepository;
  readonly plans: PlanRepository;
  readonly ledger: CreditLedgerRepository;
  readonly reservations: CreditReservationRepository;
  readonly provider: PaymentProvider;
  readonly paymentCustomers: PaymentCustomerRepository;
  readonly paymentEvents: PaymentEventRepository;
}

export interface CommercialService {
  createBillingAccount(
    request: Extract<CommercialRequest, { operation: 'createBillingAccount' }>,
  ): Promise<CommercialResult>;
  createSubscription(
    request: Extract<CommercialRequest, { operation: 'createSubscription' }>,
  ): Promise<CommercialResult>;
  changePlan(
    request: Extract<CommercialRequest, { operation: 'changePlan' }>,
  ): Promise<CommercialResult>;
  cancelSubscription(
    request: Extract<CommercialRequest, { operation: 'cancelSubscription' }>,
  ): Promise<CommercialResult>;
  createCheckoutSession(
    request: Extract<CommercialRequest, { operation: 'createCheckoutSession' }>,
  ): Promise<CommercialResult>;
  createPortalSession(
    request: Extract<CommercialRequest, { operation: 'createPortalSession' }>,
  ): Promise<CommercialResult>;
  receiveWebhook(
    request: Extract<CommercialRequest, { operation: 'receiveWebhook' }>,
  ): Promise<CommercialResult>;
  loadCommercialSummary(
    request: Extract<CommercialRequest, { operation: 'loadCommercialSummary' }>,
  ): Promise<CommercialResult>;
  /**
   * One entry for all eight.
   *
   * What a handler calls once it has parsed a body: it dispatches on
   * `operation` to the method above, so the two surfaces cannot answer
   * differently.
   */
  execute(request: CommercialRequest): Promise<CommercialResult>;
}

/**
 * How many active reservations a summary reads.
 *
 * Bounded rather than unbounded: a summary is a page a customer looks at, and
 * an organization with ten thousand reservations in flight should produce a
 * slow answer rather than an unbounded one. The availability figure it feeds is
 * the store's to compute exactly when precision matters.
 */
const ACTIVE_RESERVATION_PAGE = 200;

const traceOf = (context: CommercialContext): CommercialTrace =>
  Object.freeze({ requestId: context.requestId, correlationId: context.correlationId });

function frozen<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.getOwnPropertyNames(value)) {
      frozen((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

const ok = (
  operation: CommercialOperation,
  context: CommercialContext,
  data: CommercialData,
): CommercialResult =>
  Object.freeze({
    outcome: 'ok' as const,
    operation,
    trace: traceOf(context),
    data: frozen(data),
  });

const refuse = (
  operation: string,
  context: CommercialContext,
  code: CommercialErrorCode,
  reason: string,
  issues: readonly RequestIssue[] = [],
): CommercialRefusal =>
  Object.freeze({
    outcome: 'refused' as const,
    operation,
    trace: traceOf(context),
    code,
    reason,
    issues: frozen([...issues]),
  });

export function createCommercialService(options: CommercialServiceOptions): CommercialService {
  const {
    accounts,
    subscriptions,
    plans,
    ledger,
    reservations,
    provider,
    paymentCustomers,
    paymentEvents,
  } = options;

  /**
   * Run a delegate, turning anything it throws into a refusal.
   *
   * A `BillingError` keeps its own code: the taxonomy already says what went
   * wrong, and flattening it would send an operator looking in the wrong place.
   */
  async function attempt(
    operation: CommercialOperation,
    context: CommercialContext,
    work: () => Promise<CommercialResult>,
  ): Promise<CommercialResult> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof BillingError) {
        return refuse(operation, context, error.code, error.message);
      }
      return refuse(
        operation,
        context,
        'ServiceFailed',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  /** Validate, then run. The shape every operation shares. */
  async function guarded(
    request: CommercialRequest,
    work: () => Promise<CommercialResult>,
  ): Promise<CommercialResult> {
    const issues = validateCommercialRequest(request);
    if (issues.length > 0) {
      const code = issues.some((issue) => issue.code === 'MissingIdentifier')
        ? 'MissingIdentifier'
        : 'InvalidRequest';
      return refuse(
        request.operation,
        request.context,
        code,
        'The request is not complete enough to be served.',
        issues,
      );
    }
    return attempt(request.operation, request.context, work);
  }

  /** The account for this request's organization, refusing when there is none. */
  async function requireAccount(
    operation: CommercialOperation,
    context: CommercialContext,
  ): Promise<BillingAccount | CommercialRefusal> {
    const account = await accounts.findAccountForOrganization(context.organizationId);
    if (account === null) {
      return refuse(
        operation,
        context,
        'AccountNotFound',
        `Organization '${context.organizationId}' has no billing account.`,
      );
    }
    return account;
  }

  /** The subscription a payload names, checked against the caller's organization. */
  async function requireSubscription(
    operation: CommercialOperation,
    context: CommercialContext,
    subscriptionId: string,
  ): Promise<Subscription | CommercialRefusal> {
    const subscription = await subscriptions.loadSubscription(subscriptionId);
    if (subscription === null) {
      return refuse(
        operation,
        context,
        'SubscriptionNotFound',
        `Subscription '${subscriptionId}' does not exist.`,
      );
    }

    const issue = ownershipIssue(
      context,
      subscription,
      'That subscription',
      'payload.subscriptionId',
    );
    if (issue !== null) {
      return refuse(operation, context, 'OwnershipMismatch', issue.detail, [issue]);
    }
    return subscription;
  }

  /** The current version of a plan code, refusing when the catalogue has none. */
  async function requirePlan(
    operation: CommercialOperation,
    context: CommercialContext,
    planCode: CommercialPlan['code'],
  ): Promise<CommercialPlan | CommercialRefusal> {
    const plan = await plans.findCurrentPlan(planCode);
    if (plan === null) {
      return refuse(operation, context, 'PlanNotFound', `No current plan for code '${planCode}'.`);
    }
    return plan;
  }

  const isRefusal = (value: unknown): value is CommercialRefusal =>
    typeof value === 'object' &&
    value !== null &&
    (value as { outcome?: unknown }).outcome === 'refused';

  /** The provider customer for this organization, refusing when there is none. */
  async function requirePaymentCustomer(
    operation: CommercialOperation,
    context: CommercialContext,
  ): Promise<string | CommercialRefusal> {
    const customer = await paymentCustomers.findCustomer(
      provider.providerId,
      context.organizationId,
    );
    if (customer === null) {
      return refuse(
        operation,
        context,
        'AccountNotFound',
        `Organization '${context.organizationId}' has no customer at provider '${provider.providerId}'.`,
      );
    }
    const issue = ownershipIssue(
      context,
      customer,
      'That payment customer',
      'context.organizationId',
    );
    if (issue !== null) {
      return refuse(operation, context, 'OwnershipMismatch', issue.detail, [issue]);
    }
    return customer.externalCustomerId;
  }

  /** A provider result, as a facade answer. A declined card is a served request. */
  const sessionResult = (
    operation: CommercialOperation,
    context: CommercialContext,
    result: Awaited<ReturnType<PaymentProvider['createPortalSession']>>,
  ): CommercialResult => {
    if (result.outcome === 'failed') {
      return refuse(
        operation,
        context,
        'ServiceFailed',
        `The payment provider refused: ${result.failure.reason} — ${result.failure.detail}`,
      );
    }
    const session: PaymentSession = result.value;
    return ok(operation, context, { kind: 'session', session });
  };

  const service: CommercialService = {
    createBillingAccount(request) {
      return guarded(request, async () => {
        const { context, payload } = request;

        const existing = await accounts.findAccountForOrganization(context.organizationId);
        if (existing !== null) {
          return refuse(
            'createBillingAccount',
            context,
            'OwnershipMismatch',
            `Organization '${context.organizationId}' already has a billing account. The invoice is singular.`,
          );
        }

        // Built by Billing, from the CONTEXT's organization — never the payload's.
        const account = createBillingAccount({
          organizationId: context.organizationId,
          workspaceId: payload.workspaceId ?? null,
          currency: payload.currency,
          status: 'active',
          providerRef: payload.providerRef ?? null,
          createdAt: context.at,
        });

        return ok('createBillingAccount', context, {
          kind: 'account',
          account: await accounts.createAccount(account),
        });
      });
    },

    createSubscription(request) {
      return guarded(request, async () => {
        const { context, payload } = request;

        const account = await requireAccount('createSubscription', context);
        if (isRefusal(account)) return account;

        const plan = await requirePlan('createSubscription', context, payload.planCode);
        if (isRefusal(plan)) return plan;

        // Billing decides whether this is legal — the plan must be subscribable,
        // the cycle real, the period computable. None of that is repeated here.
        const subscription = createSubscription({
          subscriptionId: payload.subscriptionId,
          organizationId: account.organizationId,
          plan,
          cycle: payload.cycle,
          startedAt: context.at,
          providerRef: payload.providerRef ?? null,
        });

        return ok('createSubscription', context, {
          kind: 'subscription',
          subscription: await subscriptions.createSubscription(subscription),
        });
      });
    },

    changePlan(request) {
      return guarded(request, async () => {
        const { context, payload } = request;

        const subscription = await requireSubscription(
          'changePlan',
          context,
          payload.subscriptionId,
        );
        if (isRefusal(subscription)) return subscription;

        const plan = await requirePlan('changePlan', context, payload.planCode);
        if (isRefusal(plan)) return plan;

        // Billing's own function: it refuses a retired plan, a terminal
        // subscription and a change to the plan it is already on.
        const changed = changePlan(subscription, plan, context.at);

        return ok('changePlan', context, {
          kind: 'subscription',
          subscription: await subscriptions.saveSubscription(changed),
        });
      });
    },

    cancelSubscription(request) {
      return guarded(request, async () => {
        const { context, payload } = request;

        const subscription = await requireSubscription(
          'cancelSubscription',
          context,
          payload.subscriptionId,
        );
        if (isRefusal(subscription)) return subscription;

        // The provider is asked FIRST — see the file header. Writing our record
        // first and then failing here would stop billing a customer the
        // provider is still charging.
        if (subscription.providerRef !== null) {
          const result = await provider.cancelSubscription({
            organizationId: context.organizationId,
            externalSubscriptionId: subscription.providerRef,
            atPeriodEnd: payload.atPeriodEnd ?? true,
            idempotencyKey: payload.idempotencyKey,
          });

          if (result.outcome === 'failed') {
            return refuse(
              'cancelSubscription',
              context,
              'ServiceFailed',
              `The payment provider refused: ${result.failure.reason} — ${result.failure.detail}`,
            );
          }
        }

        // `request_cancellation` — at period end, so the customer keeps what
        // they paid for. Billing's table refuses it from anywhere but `active`,
        // and that refusal travels back with its own code rather than being
        // pre-empted here.
        const cancelled = applyTransition(subscription, 'request_cancellation', context.at);

        return ok('cancelSubscription', context, {
          kind: 'subscription',
          subscription: await subscriptions.saveSubscription(cancelled),
        });
      });
    },

    createCheckoutSession(request) {
      return guarded(request, async () => {
        const { context, payload } = request;

        const account = await requireAccount('createCheckoutSession', context);
        if (isRefusal(account)) return account;

        const customerId = await requirePaymentCustomer('createCheckoutSession', context);
        if (isRefusal(customerId)) return customerId;

        return sessionResult(
          'createCheckoutSession',
          context,
          await provider.createCheckoutSession({
            organizationId: context.organizationId,
            externalCustomerId: customerId,
            externalPriceId: payload.externalPriceId,
            successUrl: payload.successUrl,
            cancelUrl: payload.cancelUrl,
            idempotencyKey: payload.idempotencyKey,
          }),
        );
      });
    },

    createPortalSession(request) {
      return guarded(request, async () => {
        const { context, payload } = request;

        const account = await requireAccount('createPortalSession', context);
        if (isRefusal(account)) return account;

        const customerId = await requirePaymentCustomer('createPortalSession', context);
        if (isRefusal(customerId)) return customerId;

        return sessionResult(
          'createPortalSession',
          context,
          await provider.createPortalSession({
            organizationId: context.organizationId,
            externalCustomerId: customerId,
            returnUrl: payload.returnUrl,
          }),
        );
      });
    },

    receiveWebhook(request) {
      return guarded(request, async () => {
        const { context, payload } = request;

        // Verification and translation are the provider's. This layer does not
        // read a byte of the body.
        const outcome = provider.receiveWebhook({
          payload: payload.payload,
          signatureHeader: payload.signatureHeader,
          receivedAt: context.at,
        });

        if (outcome.outcome === 'rejected') {
          return refuse(
            'receiveWebhook',
            context,
            'MalformedWebhook',
            `The webhook was refused: ${outcome.failure.detail}`,
          );
        }

        if (outcome.outcome === 'ignored') {
          // A success. The provider sends types this build does not map, and
          // refusing them would make it redeliver for days.
          return ok('receiveWebhook', context, {
            kind: 'webhook',
            accepted: false,
            eventId: outcome.eventId,
            eventType: null,
            recorded: false,
          });
        }

        // Appended, not applied. Turning an event into a subscription change or
        // a credit grant is a consumer's job and a later increment's.
        const event: PaymentEvent = outcome.event;
        const stored = await paymentEvents.recordEvent(event);

        return ok('receiveWebhook', context, {
          kind: 'webhook',
          accepted: true,
          eventId: event.eventId,
          eventType: event.type,
          recorded: stored.outcome === 'recorded',
        });
      });
    },

    loadCommercialSummary(request) {
      return guarded(request, async () => {
        const { context } = request;
        const organizationId = context.organizationId;

        const account = await accounts.findAccountForOrganization(organizationId);
        const subscription = await subscriptions.findLiveSubscription(organizationId);
        const plan = subscription === null ? null : await plans.loadPlan(subscription.planId);

        // From the ledger's own repository — never recomputed here.
        const balance = await ledger.calculateBalance(organizationId);

        const slice = await reservations.listReservations({
          organizationId,
          workspaceId: null,
          executionId: null,
          statuses: ['active'],
          expiredAt: null,
          after: null,
          limit: ACTIVE_RESERVATION_PAGE,
        });

        // The frozen S5.2 calculation, called rather than copied.
        const available = calculateAvailability({
          balance,
          reservations: slice.reservations,
        });

        const summary: CommercialSummary = {
          organizationId,
          account,
          subscription,
          plan,
          balance,
          available,
          activeReservations: slice.reservations,
        };

        return ok('loadCommercialSummary', context, { kind: 'summary', summary });
      });
    },

    execute(request) {
      if (!isCommercialOperation(request.operation)) {
        return Promise.resolve(
          refuse(
            String(request.operation),
            request.context,
            'InvalidOperation',
            `'${String(request.operation)}' is not a commercial operation. Available: ${COMMERCIAL_OPERATIONS.join(', ')}.`,
          ),
        );
      }

      switch (request.operation) {
        case 'createBillingAccount':
          return service.createBillingAccount(request);
        case 'createSubscription':
          return service.createSubscription(request);
        case 'changePlan':
          return service.changePlan(request);
        case 'cancelSubscription':
          return service.cancelSubscription(request);
        case 'createCheckoutSession':
          return service.createCheckoutSession(request);
        case 'createPortalSession':
          return service.createPortalSession(request);
        case 'receiveWebhook':
          return service.receiveWebhook(request);
        case 'loadCommercialSummary':
          return service.loadCommercialSummary(request);
      }
    },
  };

  return Object.freeze(service);
}
