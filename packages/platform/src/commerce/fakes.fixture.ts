/**
 * In-memory stand-ins for the eight ports the facade is composed from.
 *
 * ── What they model, and why those things specifically ─────────────────────
 * A fake that accepted everything would let the facade pass while delegating
 * nowhere. These implement exactly the behaviours the facade's correctness
 * argument rests on, and nothing else:
 *
 *   - one billing account per organization, and one live subscription per
 *     organization — the two uniqueness rules `billing.md` names;
 *   - `UNIQUE (provider, provider_event_id)` on payment events, so a
 *     redelivery converges rather than appending twice;
 *   - `saveSubscription` refusing a stale version;
 *   - a call log, so a test can assert WHICH delegate was reached — the whole
 *     question for a layer that is supposed to only delegate.
 *
 * ── What they do NOT model ─────────────────────────────────────────────────
 * RLS, transactions, and real concurrency. Those are properties of a server,
 * and the components that need them already own them.
 */

import type { BillingAccount } from '../billing/account.js';
import { BillingError } from '../billing/errors.js';
import type {
  PaymentCustomer,
  PaymentEvent,
  PaymentProvider,
  PaymentProviderId,
  PaymentResult,
  PaymentSession,
  PaymentSubscriptionRef,
  WebhookOutcome,
} from '../billing/payments/provider.js';
import type {
  PaymentCustomerRepository,
  PaymentEventRepository,
  RecordEventOutcome,
} from '../billing/payments/repository.js';
import type { CommercialPlan, PlanCode } from '../billing/plan.js';
import type {
  BillingAccountRepository,
  PlanRepository,
  PlanSlice,
  SubscriptionRepository,
  SubscriptionSlice,
} from '../billing/repository.js';
import type { Subscription } from '../billing/subscription.js';
import type { LedgerBalance } from '../credits/aggregate.js';
import type { LedgerEntry } from '../credits/ledger.js';
import type { CreditLedgerRepository, LedgerSlice } from '../credits/repository.js';
import type { CreditReservation } from '../credits/reservation.js';
import type {
  CreditReservationRepository,
  ReservationSlice,
} from '../credits/reservation-repository.js';

export interface Fakes {
  /** Every delegate call, in order. What "delegation only" is asserted against. */
  readonly calls: string[];
  readonly accounts: BillingAccountRepository;
  readonly subscriptions: SubscriptionRepository;
  readonly plans: PlanRepository;
  readonly ledger: CreditLedgerRepository;
  readonly reservations: CreditReservationRepository;
  readonly provider: PaymentProvider;
  readonly paymentCustomers: PaymentCustomerRepository;
  readonly paymentEvents: PaymentEventRepository;
  /** The stores, for arranging and asserting. */
  readonly state: FakeState;
}

export interface FakeState {
  accounts: BillingAccount[];
  subscriptions: Subscription[];
  plans: CommercialPlan[];
  balance: LedgerBalance;
  reservations: CreditReservation[];
  customers: PaymentCustomer[];
  events: PaymentEvent[];
  /** What the provider answers with. Set per test. */
  providerSession: PaymentResult<PaymentSession> | null;
  providerCancel: PaymentResult<PaymentSubscriptionRef> | null;
  webhook: WebhookOutcome | null;
}

const ORG = '018f7a1e-0000-7000-8000-0000000000aa';

export function emptyBalance(organizationId = ORG): LedgerBalance {
  return Object.freeze({
    organizationId,
    currency: 'credits' as const,
    credited: '0.000000',
    debited: '0.000000',
    balance: '0.000000',
    entries: 0,
    throughAt: null,
    throughId: null,
  });
}

/**
 * A stored record's provider, as received.
 *
 * `PaymentProviderId` has one member today, so the type says a comparison
 * against it can only be true. It stops being true the moment the second
 * provider `stripe.md` plans is added — and per-provider scoping is exactly
 * what `UNIQUE (provider, provider_event_id)` exists for.
 */
const storedProvider = (record: { readonly providerId: PaymentProviderId }): string =>
  record.providerId;

export function createFakes(overrides: Partial<FakeState> = {}): Fakes {
  const calls: string[] = [];

  const state: FakeState = {
    accounts: [],
    subscriptions: [],
    plans: [],
    balance: emptyBalance(),
    reservations: [],
    customers: [],
    events: [],
    providerSession: null,
    providerCancel: null,
    webhook: null,
    ...overrides,
  };

  const accounts: BillingAccountRepository = {
    createAccount(account) {
      calls.push('accounts.createAccount');
      if (state.accounts.some((a) => a.organizationId === account.organizationId)) {
        throw new BillingError('OwnershipMismatch', 'That organization already has an account.');
      }
      state.accounts.push(account);
      return Promise.resolve(account);
    },
    loadAccount(accountId) {
      calls.push('accounts.loadAccount');
      return Promise.resolve(state.accounts.find((a) => a.accountId === accountId) ?? null);
    },
    findAccountForOrganization(organizationId) {
      calls.push('accounts.findAccountForOrganization');
      return Promise.resolve(
        state.accounts.find((a) => a.organizationId === organizationId) ?? null,
      );
    },
  };

  const subscriptions: SubscriptionRepository = {
    createSubscription(subscription) {
      calls.push('subscriptions.createSubscription');
      if (state.subscriptions.some((s) => s.subscriptionId === subscription.subscriptionId)) {
        throw new BillingError('DuplicateSubscription', 'That subscription id already exists.');
      }
      if (
        state.subscriptions.some(
          (s) => s.organizationId === subscription.organizationId && s.status !== 'expired',
        )
      ) {
        throw new BillingError('SubscriptionConflict', 'That organization is already subscribed.');
      }
      state.subscriptions.push(subscription);
      return Promise.resolve(subscription);
    },
    loadSubscription(subscriptionId) {
      calls.push('subscriptions.loadSubscription');
      return Promise.resolve(
        state.subscriptions.find((s) => s.subscriptionId === subscriptionId) ?? null,
      );
    },
    findLiveSubscription(organizationId) {
      calls.push('subscriptions.findLiveSubscription');
      return Promise.resolve(
        state.subscriptions.find(
          (s) => s.organizationId === organizationId && s.status !== 'expired',
        ) ?? null,
      );
    },
    saveSubscription(subscription) {
      calls.push('subscriptions.saveSubscription');
      const index = state.subscriptions.findIndex(
        (s) => s.subscriptionId === subscription.subscriptionId,
      );
      if (index === -1) {
        throw new BillingError('SubscriptionNotFound', 'No such subscription.');
      }
      const current = state.subscriptions[index];
      if (current !== undefined && subscription.version <= current.version) {
        throw new BillingError('StaleVersion', 'That version arrived after a newer one.');
      }
      state.subscriptions[index] = subscription;
      return Promise.resolve(subscription);
    },
    listSubscriptions(): Promise<SubscriptionSlice> {
      calls.push('subscriptions.listSubscriptions');
      return Promise.resolve({ subscriptions: [...state.subscriptions] });
    },
  };

  const plans: PlanRepository = {
    loadPlan(planId) {
      calls.push('plans.loadPlan');
      return Promise.resolve(state.plans.find((p) => p.planId === planId) ?? null);
    },
    findCurrentPlan(code: PlanCode) {
      calls.push('plans.findCurrentPlan');
      const matching = state.plans.filter((p) => p.code === code && p.status === 'active');
      const newest = matching.reduce<CommercialPlan | null>(
        (best, plan) => (best === null || plan.version > best.version ? plan : best),
        null,
      );
      return Promise.resolve(newest);
    },
    listPlans(): Promise<PlanSlice> {
      calls.push('plans.listPlans');
      return Promise.resolve({ plans: [...state.plans] });
    },
  };

  const ledger: CreditLedgerRepository = {
    appendEntry(): Promise<void> {
      calls.push('ledger.appendEntry');
      return Promise.resolve();
    },
    loadEntry(): Promise<LedgerEntry | null> {
      calls.push('ledger.loadEntry');
      return Promise.resolve(null);
    },
    loadLedger(): Promise<LedgerSlice> {
      calls.push('ledger.loadLedger');
      return Promise.resolve({ entries: [], next: null });
    },
    calculateBalance(organizationId) {
      calls.push('ledger.calculateBalance');
      return Promise.resolve({ ...state.balance, organizationId });
    },
  };

  const reservations: CreditReservationRepository = {
    createReservation(reservation) {
      calls.push('reservations.createReservation');
      return Promise.resolve(reservation);
    },
    loadReservation() {
      calls.push('reservations.loadReservation');
      return Promise.resolve(null);
    },
    releaseReservation() {
      calls.push('reservations.releaseReservation');
      throw new BillingError('InvalidDeclaration', 'not modelled');
    },
    expireReservation() {
      calls.push('reservations.expireReservation');
      throw new BillingError('InvalidDeclaration', 'not modelled');
    },
    listReservations(query): Promise<ReservationSlice> {
      calls.push('reservations.listReservations');
      const statuses = query.statuses;
      const matching = state.reservations.filter(
        (r) =>
          r.organizationId === query.organizationId &&
          (statuses === null || statuses.includes(r.status)),
      );
      return Promise.resolve({ reservations: matching });
    },
  };

  const providerId: PaymentProviderId = 'stripe';

  const provider: PaymentProvider = {
    providerId,
    createCustomer(): Promise<PaymentResult<PaymentCustomer>> {
      calls.push('provider.createCustomer');
      throw new BillingError('InvalidDeclaration', 'not modelled');
    },
    createCheckoutSession(): Promise<PaymentResult<PaymentSession>> {
      calls.push('provider.createCheckoutSession');
      if (state.providerSession === null) throw new Error('no session response arranged');
      return Promise.resolve(state.providerSession);
    },
    createPortalSession(): Promise<PaymentResult<PaymentSession>> {
      calls.push('provider.createPortalSession');
      if (state.providerSession === null) throw new Error('no session response arranged');
      return Promise.resolve(state.providerSession);
    },
    createSubscription(): Promise<PaymentResult<PaymentSubscriptionRef>> {
      calls.push('provider.createSubscription');
      throw new BillingError('InvalidDeclaration', 'not modelled');
    },
    cancelSubscription(): Promise<PaymentResult<PaymentSubscriptionRef>> {
      calls.push('provider.cancelSubscription');
      if (state.providerCancel === null) throw new Error('no cancel response arranged');
      return Promise.resolve(state.providerCancel);
    },
    receiveWebhook(): WebhookOutcome {
      calls.push('provider.receiveWebhook');
      if (state.webhook === null) throw new Error('no webhook outcome arranged');
      return state.webhook;
    },
  };

  const paymentCustomers: PaymentCustomerRepository = {
    recordCustomer(customer) {
      calls.push('paymentCustomers.recordCustomer');
      state.customers.push(customer);
      return Promise.resolve(customer);
    },
    findCustomer(provider_, organizationId) {
      calls.push('paymentCustomers.findCustomer');
      return Promise.resolve(
        state.customers.find(
          (c) => storedProvider(c) === provider_ && c.organizationId === organizationId,
        ) ?? null,
      );
    },
    findCustomerByExternalId(provider_, externalCustomerId) {
      calls.push('paymentCustomers.findCustomerByExternalId');
      return Promise.resolve(
        state.customers.find(
          (c) => storedProvider(c) === provider_ && c.externalCustomerId === externalCustomerId,
        ) ?? null,
      );
    },
  };

  const paymentEvents: PaymentEventRepository = {
    recordEvent(event): Promise<RecordEventOutcome> {
      calls.push('paymentEvents.recordEvent');
      // `UNIQUE (provider, provider_event_id)` — a redelivery converges.
      const existing = state.events.find(
        (e) => storedProvider(e) === event.providerId && e.eventId === event.eventId,
      );
      if (existing !== undefined) {
        return Promise.resolve({ outcome: 'converged', event: existing });
      }
      state.events.push(event);
      return Promise.resolve({ outcome: 'recorded', event });
    },
    loadEvent(provider_, eventId) {
      calls.push('paymentEvents.loadEvent');
      return Promise.resolve(
        state.events.find((e) => storedProvider(e) === provider_ && e.eventId === eventId) ?? null,
      );
    },
    hasEvent(provider_, eventId) {
      calls.push('paymentEvents.hasEvent');
      return Promise.resolve(
        state.events.some((e) => storedProvider(e) === provider_ && e.eventId === eventId),
      );
    },
    listEvents() {
      calls.push('paymentEvents.listEvents');
      return Promise.resolve({ events: [...state.events] });
    },
  };

  return {
    calls,
    accounts,
    subscriptions,
    plans,
    ledger,
    reservations,
    provider,
    paymentCustomers,
    paymentEvents,
    state,
  };
}
