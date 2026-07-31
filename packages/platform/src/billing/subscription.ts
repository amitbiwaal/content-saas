/**
 * The subscription lifecycle — `04-platform/billing.md` §Subscription lifecycle.
 *
 * Transcribed from the state diagram, not designed here:
 *
 * ```
 * [*]           --> trialing      : trial started
 * trialing      --> active        : payment method added + first charge
 * trialing      --> expired       : trial ended, no payment
 * active        --> past_due      : payment failed
 * past_due      --> active        : payment recovered
 * past_due      --> suspended     : dunning exhausted (grace elapsed)
 * active        --> cancel_pending: cancel at period end
 * cancel_pending--> active        : cancellation revoked
 * cancel_pending--> expired       : period ended
 * suspended     --> active        : payment recovered
 * suspended     --> expired       : closure
 * ```
 *
 * ── This machine is NOT the organization's ─────────────────────────────────
 * `organizations/lifecycle.ts` has its own `past_due` and `suspended`, and they
 * are a different fact about a different aggregate. `billing.md`: "Billing
 * never suspends anything itself. It reports commercial facts; organizations.md
 * decides and executes the cascade." So a subscription reaching `past_due` does
 * not move the organization — a `PaymentFailed` event does, and Organizations
 * decides. Nothing in this module transitions an organization, and there is no
 * function here that could.
 *
 * ── Transitions are NAMED ──────────────────────────────────────────────────
 * The same reasoning as `organizations/lifecycle.ts`: two causes can produce
 * one (from, to) pair — `cancel_pending → expired` is a period ending, and
 * `suspended → expired` is a closure — and they carry different reasons and
 * different audit actions. Naming the transition keeps the cause in the type
 * system instead of in a comment.
 *
 * ── No payment, no provider ────────────────────────────────────────────────
 * `providerRef` is a string this module never interprets. Nothing here talks to
 * a payment provider, charges anything, or knows what a charge is; a
 * transition is applied because something else reported that a charge
 * succeeded or failed.
 */

import { BillingError } from './errors.js';
import { deepFreeze } from './immutable.js';
import {
  createBillingPeriod,
  firstPeriod,
  hasPeriodElapsed,
  type BillingCycle,
  type BillingPeriod,
} from './period.js';
import { assertSubscribable, type CommercialPlan, type PlanId } from './plan.js';

export type SubscriptionId = string;

/** Ordered as the lifecycle diagram reads, not alphabetically. */
export const SUBSCRIPTION_STATUSES = [
  'trialing',
  'active',
  'past_due',
  'cancel_pending',
  'suspended',
  'expired',
] as const;

export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export function isSubscriptionStatus(value: unknown): value is SubscriptionStatus {
  return typeof value === 'string' && (SUBSCRIPTION_STATUSES as readonly string[]).includes(value);
}

/** The status a subscription is created in. `billing.md`: trial first. */
export const INITIAL_SUBSCRIPTION_STATUS: SubscriptionStatus = 'trialing';

/**
 * The one terminal status.
 *
 * `expired` appears in no `from` list below. Terminality is expressed by
 * absence rather than by a guard somebody could forget at one call site — the
 * same technique `organizations/lifecycle.ts` uses for `closed`.
 */
export const TERMINAL_SUBSCRIPTION_STATUS: SubscriptionStatus = 'expired';

/**
 * The statuses that entitle. `billing.md` §Failure handling: "a provider outage
 * must never suspend a paying customer", so `past_due` still entitles — dunning
 * is a grace period, and Organizations decides when it has run out.
 */
export const ENTITLING_SUBSCRIPTION_STATUSES: readonly SubscriptionStatus[] = Object.freeze([
  'trialing',
  'active',
  'past_due',
  'cancel_pending',
]);

export const SUBSCRIPTION_TRANSITIONS = [
  'activate',
  'trial_expired',
  'payment_failed',
  'payment_recovered',
  'dunning_exhausted',
  'request_cancellation',
  'revoke_cancellation',
  'period_ended',
  'close',
] as const;

export type SubscriptionTransition = (typeof SUBSCRIPTION_TRANSITIONS)[number];

export interface SubscriptionTransitionRule {
  readonly from: readonly SubscriptionStatus[];
  readonly to: SubscriptionStatus;
}

export const SUBSCRIPTION_TRANSITION_RULES: Readonly<
  Record<SubscriptionTransition, SubscriptionTransitionRule>
> = Object.freeze({
  activate: { from: ['trialing'], to: 'active' },
  trial_expired: { from: ['trialing'], to: 'expired' },
  payment_failed: { from: ['active'], to: 'past_due' },
  // From `suspended` too: "Suspended --> Active: payment recovered".
  payment_recovered: { from: ['past_due', 'suspended'], to: 'active' },
  dunning_exhausted: { from: ['past_due'], to: 'suspended' },
  request_cancellation: { from: ['active'], to: 'cancel_pending' },
  revoke_cancellation: { from: ['cancel_pending'], to: 'active' },
  period_ended: { from: ['cancel_pending'], to: 'expired' },
  close: { from: ['suspended'], to: 'expired' },
});

export function canTransition(
  from: SubscriptionStatus,
  transition: SubscriptionTransition,
): boolean {
  return SUBSCRIPTION_TRANSITION_RULES[transition].from.includes(from);
}

/** Every transition permitted out of a status. Empty for `expired`. */
export function transitionsFrom(status: SubscriptionStatus): readonly SubscriptionTransition[] {
  return Object.freeze(SUBSCRIPTION_TRANSITIONS.filter((t) => canTransition(status, t)));
}

export function assertTransitionAllowed(
  from: SubscriptionStatus,
  transition: SubscriptionTransition,
): SubscriptionStatus {
  if (!canTransition(from, transition)) {
    const allowed = SUBSCRIPTION_TRANSITION_RULES[transition].from.join(', ');
    throw new BillingError(
      'InvalidTransition',
      `Cannot '${transition}' a subscription in status '${from}'; permitted from: ${allowed}. ${
        from === TERMINAL_SUBSCRIPTION_STATUS
          ? "'expired' is terminal — a subscription that ended is reopened by starting a new one."
          : `Available from '${from}': ${transitionsFrom(from).join(', ') || '(none)'}.`
      }`,
    );
  }
  return SUBSCRIPTION_TRANSITION_RULES[transition].to;
}

/**
 * One subscription.
 *
 * Organization-scoped, never workspace-scoped: `billing.md` resolves at the
 * organization level and "a workspace is never billed".
 */
export interface Subscription {
  readonly subscriptionId: SubscriptionId;
  readonly organizationId: string;
  readonly planId: PlanId;
  readonly status: SubscriptionStatus;
  readonly currentPeriod: BillingPeriod;
  readonly startedAt: string;
  /**
   * When the current period ends and the next begins. Null once terminal —
   * an expired subscription does not renew.
   */
  readonly renewsAt: string | null;
  /**
   * When cancellation was REQUESTED, not when it takes effect. It takes effect
   * at `currentPeriod.end`: "cancel at period end", so a customer keeps what
   * they paid for.
   */
  readonly cancelledAt: string | null;
  /**
   * The payment provider's identifier for this subscription. Carried, never
   * interpreted, and never used to reach a provider from here.
   */
  readonly providerRef: string | null;
  /**
   * Monotonic. `billing.md`: "Every `SubscriptionChanged` payload carries a
   * monotonic subscription version, so an out-of-order delivery is ignored
   * rather than applied."
   */
  readonly version: number;
  readonly updatedAt: string;
}

const requireField = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new BillingError('InvalidDeclaration', `'${field}' is required and must be non-empty.`);
  }
  return value;
};

/**
 * Start a subscription.
 *
 * Trialing, on an active plan, with its first period computed from the cycle.
 * The plan is passed whole rather than by id so compatibility is checked here
 * and cannot be skipped by a caller that only had the id.
 */
export function createSubscription(input: {
  readonly subscriptionId: SubscriptionId;
  readonly organizationId: string;
  readonly plan: CommercialPlan;
  readonly cycle: BillingCycle;
  readonly startedAt: string;
  readonly providerRef?: string | null;
}): Subscription {
  requireField(input.subscriptionId, 'subscriptionId');
  requireField(input.organizationId, 'organizationId');
  requireField(input.startedAt, 'startedAt');

  assertSubscribable(input.plan);

  const currentPeriod = firstPeriod(input.startedAt, input.cycle);

  return deepFreeze({
    subscriptionId: input.subscriptionId,
    organizationId: input.organizationId,
    planId: input.plan.planId,
    status: INITIAL_SUBSCRIPTION_STATUS,
    currentPeriod,
    startedAt: input.startedAt,
    renewsAt: currentPeriod.end,
    cancelledAt: null,
    providerRef: input.providerRef ?? null,
    version: 1,
    updatedAt: input.startedAt,
  });
}

/**
 * Apply a transition.
 *
 * Returns a new subscription — nothing is mutated, and the version advances so
 * a consumer can order two of them. `at` is supplied, never read from a clock:
 * a lifecycle that timestamped itself could not be asserted on.
 */
export function applyTransition(
  subscription: Subscription,
  transition: SubscriptionTransition,
  at: string,
): Subscription {
  requireField(at, 'at');
  const status = assertTransitionAllowed(subscription.status, transition);
  const terminal = status === TERMINAL_SUBSCRIPTION_STATUS;

  return deepFreeze({
    ...subscription,
    status,
    // Requested now; effective at period end. Revoking clears it, so a revoked
    // cancellation leaves no trace that would expire the subscription later.
    cancelledAt:
      transition === 'request_cancellation'
        ? at
        : transition === 'revoke_cancellation'
          ? null
          : subscription.cancelledAt,
    renewsAt: terminal ? null : subscription.currentPeriod.end,
    version: subscription.version + 1,
    updatedAt: at,
  });
}

/**
 * Roll into the next period.
 *
 * Separate from a transition because renewal is not a status change: an active
 * subscription stays active across a period boundary. `billing.md` drives this
 * from our own timers, "not by provider callbacks alone — relying solely on
 * webhooks means a missed webhook silently extends a trial forever".
 */
export function renew(subscription: Subscription, next: BillingPeriod, at: string): Subscription {
  requireField(at, 'at');

  if (subscription.status === TERMINAL_SUBSCRIPTION_STATUS) {
    throw new BillingError(
      'InvalidTransition',
      `Subscription '${subscription.subscriptionId}' is expired and does not renew. Starting again is a new subscription.`,
    );
  }
  if (subscription.cancelledAt !== null) {
    throw new BillingError(
      'InvalidTransition',
      `Subscription '${subscription.subscriptionId}' is cancelled effective ${subscription.currentPeriod.end}; renewing it would bill a customer who asked to stop.`,
    );
  }
  if (next.start !== subscription.currentPeriod.end) {
    throw new BillingError(
      'InvalidBillingPeriod',
      `The next period must begin where the current one ends (${subscription.currentPeriod.end}); got ${next.start}. A gap or an overlap bills usage twice or not at all.`,
    );
  }

  return deepFreeze({
    ...subscription,
    currentPeriod: createBillingPeriod(next),
    renewsAt: next.end,
    version: subscription.version + 1,
    updatedAt: at,
  });
}

/** Does this subscription entitle its organization right now? */
export function isEntitling(subscription: Subscription): boolean {
  return ENTITLING_SUBSCRIPTION_STATUSES.includes(subscription.status);
}

/** Is this subscription over? `billing.md`: one live subscription per organization. */
export function isTerminal(subscription: Subscription): boolean {
  return subscription.status === TERMINAL_SUBSCRIPTION_STATUS;
}

/** Is it past its period end at this instant, and therefore due to roll? */
export function isDueForRenewal(subscription: Subscription, at: string): boolean {
  return !isTerminal(subscription) && hasPeriodElapsed(subscription.currentPeriod, at);
}

/**
 * The identifiers that must never change.
 *
 * A subscription that changed organization would move a customer's spend to
 * another account, and one that changed id would break every reference to it.
 * The plan CAN change — that is what an upgrade is — so it is not here.
 */
export function assertIdentityUnchanged(before: Subscription, after: Subscription): void {
  if (before.subscriptionId !== after.subscriptionId) {
    throw new BillingError(
      'ImmutableFieldChanged',
      `A subscription's id is assigned once; '${before.subscriptionId}' cannot become '${after.subscriptionId}'.`,
    );
  }
  if (before.organizationId !== after.organizationId) {
    throw new BillingError(
      'ImmutableFieldChanged',
      `Subscription '${before.subscriptionId}' belongs to organization '${before.organizationId}'; moving it to '${after.organizationId}' would move a customer's commercial history to another account.`,
    );
  }
  if (before.startedAt !== after.startedAt) {
    throw new BillingError(
      'ImmutableFieldChanged',
      `Subscription '${before.subscriptionId}' started at ${before.startedAt}; that is a historical fact.`,
    );
  }
}

/**
 * Refuse an out-of-order update.
 *
 * `billing.md` failure handling: "Webhook arrives out of order → subscription
 * version comparison; stale events ignored."
 */
export function assertNotStale(current: Subscription, incoming: Subscription): void {
  assertIdentityUnchanged(current, incoming);
  if (incoming.version <= current.version) {
    throw new BillingError(
      'StaleVersion',
      `Subscription '${current.subscriptionId}' is at version ${String(current.version)}; version ${String(incoming.version)} arrived after it and is ignored.`,
    );
  }
}

/**
 * Change plan.
 *
 * An upgrade or a downgrade, applied to the subscription only. `billing.md`
 * rule: "Downgrade puts organization over quota → over-quota workspaces become
 * read-only; never deleted" — that is Organizations' decision, reached through
 * the event, and nothing here does it.
 */
export function changePlan(
  subscription: Subscription,
  plan: CommercialPlan,
  at: string,
): Subscription {
  requireField(at, 'at');

  if (isTerminal(subscription)) {
    throw new BillingError(
      'InvalidTransition',
      `Subscription '${subscription.subscriptionId}' is expired; changing its plan would entitle an organization that has stopped paying.`,
    );
  }
  assertSubscribable(plan);

  if (plan.planId === subscription.planId) {
    throw new BillingError(
      'IncompatiblePlan',
      `Subscription '${subscription.subscriptionId}' is already on plan '${plan.planId}'.`,
    );
  }

  return deepFreeze({
    ...subscription,
    planId: plan.planId,
    version: subscription.version + 1,
    updatedAt: at,
  });
}

/**
 * Refuse a second live subscription for one organization.
 *
 * `billing.md` gives `subscriptions` the constraint
 * `UNIQUE (organization_id) WHERE status <> 'expired'`. This is that rule where
 * a test can reach it, and it also catches a reused subscription id, which the
 * primary key would catch later and less clearly.
 */
export function assertNoLiveConflict(
  existing: readonly Subscription[],
  incoming: Subscription,
): void {
  for (const current of existing) {
    if (current.subscriptionId === incoming.subscriptionId) {
      throw new BillingError(
        'DuplicateSubscription',
        `Subscription '${incoming.subscriptionId}' already exists. Ids are assigned once.`,
      );
    }
    if (current.organizationId === incoming.organizationId && !isTerminal(current)) {
      throw new BillingError(
        'SubscriptionConflict',
        `Organization '${incoming.organizationId}' already has a live subscription ('${current.subscriptionId}', ${current.status}). One organization, one subscription — a second would bill the customer twice.`,
      );
    }
  }
}
