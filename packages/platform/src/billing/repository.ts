/**
 * The Commerce ports — interfaces, and nothing else.
 *
 * ── Why ports and no implementation ────────────────────────────────────────
 * `billing.md` puts these tables in a migration that has not been written, and
 * "Database implementation" is out of scope for this increment. The model still
 * has to be usable and testable, and everything that will read it — a quota
 * check, an entitlement resolver, a renewal job — either grows its own SQL or
 * gets a port.
 *
 * ── They follow the shapes already established here ────────────────────────
 * Keyset positions, never offsets. Explicit nulls on every query dimension
 * rather than optionals, so an implementer sees what it must handle. Instants
 * supplied, never read from a clock. The same decisions `ReservationQuery`,
 * `ConsumptionQuery` and `SettlementQuery` made, for the same reasons.
 *
 * ── No payments, no invoices, no webhooks ──────────────────────────────────
 * There is no charge, no invoice, no payment method and no webhook event
 * anywhere on these interfaces, and no way to add one without changing this
 * file. `billing.md` has all four; they are out of scope, and an interface that
 * could reach a provider would eventually be used to.
 *
 * ── Plans are reference data ───────────────────────────────────────────────
 * `PlanRepository` has no organization on any method. A plan is "seeded,
 * versioned, and identical for every customer" — a per-organization plan lookup
 * would be the bespoke row `billing.md` explicitly rules out.
 */

import type { BillingAccount, BillingAccountId } from './account.js';
import type { CommercialPlan, PlanCode, PlanId, PlanStatus } from './plan.js';
import type { Subscription, SubscriptionId, SubscriptionStatus } from './subscription.js';

// ── Billing accounts ────────────────────────────────────────────────────────

export interface BillingAccountRepository {
  /**
   * Open an account for an organization.
   *
   * Must refuse a second account for one organization — the invoice is
   * singular. A store that cannot enforce that must refuse rather than let two
   * exist, because the customer would then be billed twice and neither record
   * would be wrong on its own.
   */
  createAccount(account: BillingAccount): Promise<BillingAccount>;

  /** One account, or null when the organization has none. */
  loadAccount(accountId: BillingAccountId): Promise<BillingAccount | null>;

  /**
   * The account for an organization.
   *
   * Separate from `loadAccount` even though the ids are the same value today:
   * a caller holding an organization id should not have to know that, and the
   * two questions read differently at a call site.
   */
  findAccountForOrganization(organizationId: string): Promise<BillingAccount | null>;
}

// ── Subscriptions ───────────────────────────────────────────────────────────

/** Where a page of subscriptions continues from. Keyset, never an offset. */
export interface SubscriptionPosition {
  readonly startedAt: string;
  readonly subscriptionId: SubscriptionId;
}

export interface SubscriptionQuery {
  /** Null lists across organizations — an operator view, not a customer one. */
  readonly organizationId: string | null;
  readonly planId: PlanId | null;
  /** Match any. Null lists every status. Never an empty array. */
  readonly statuses: readonly SubscriptionStatus[] | null;
  /**
   * Only subscriptions whose current period has elapsed at this instant.
   *
   * What the renewal job asks for. Supplied, so the job and a reader cannot
   * disagree about which subscriptions are due.
   */
  readonly dueAt: string | null;
  readonly after: SubscriptionPosition | null;
  readonly limit: number;
}

export interface SubscriptionSlice {
  /** Oldest first. A renewal sweep works through the longest-overdue first. */
  readonly subscriptions: readonly Subscription[];
}

export interface SubscriptionRepository {
  /**
   * Start a subscription.
   *
   * Must refuse a duplicate id and a second live subscription for one
   * organization — `UNIQUE (organization_id) WHERE status <> 'expired'`.
   */
  createSubscription(subscription: Subscription): Promise<Subscription>;

  loadSubscription(subscriptionId: SubscriptionId): Promise<Subscription | null>;

  /** The one live subscription, or null. Terminal ones are not live. */
  findLiveSubscription(organizationId: string): Promise<Subscription | null>;

  /**
   * Store a new state of a subscription.
   *
   * Conditional on the version: an update carrying a version at or below the
   * stored one is a stale delivery and must be ignored, not applied. The caller
   * produced the new state with `applyTransition`, `renew` or `changePlan`, so
   * the store never decides a lifecycle question itself.
   */
  saveSubscription(subscription: Subscription): Promise<Subscription>;

  listSubscriptions(query: SubscriptionQuery): Promise<SubscriptionSlice>;
}

// ── Plans ───────────────────────────────────────────────────────────────────

export interface PlanQuery {
  readonly codes: readonly PlanCode[] | null;
  readonly statuses: readonly PlanStatus[] | null;
}

export interface PlanSlice {
  readonly plans: readonly CommercialPlan[];
}

export interface PlanRepository {
  /** One plan by id, including a retired one — subscriptions on it still resolve. */
  loadPlan(planId: PlanId): Promise<CommercialPlan | null>;

  /**
   * The current version of a plan code.
   *
   * "A changed entitlement is a new version, never an edit", so a store holds
   * several versions of one code and this is the newest.
   */
  findCurrentPlan(code: PlanCode): Promise<CommercialPlan | null>;

  /** The catalogue. No organization dimension: plans are reference data. */
  listPlans(query: PlanQuery): Promise<PlanSlice>;
}
