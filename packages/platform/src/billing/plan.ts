/**
 * The commercial plan — `04-platform/billing.md` §Domain model.
 *
 * "Billing is the supplier of entitlement to the rest of the platform — it
 * publishes `PlanLimits`, and everything else applies them."
 *
 * ── The consumers of this already exist ────────────────────────────────────
 * `organizations.plan_limits JSONB` is commented "Projection from Commerce,
 * never authored here", and `flags/registry.ts` already declares
 * `entitlements.sso` and `entitlements.audit_export` with `kind: 'entitlement'`
 * and owner `platform.billing` — "Projected from billing.md, never authored
 * here". Both have been waiting for an author. This is it.
 *
 * ── A plan is reference data, not tenant data ──────────────────────────────
 * "seeded, versioned, and identical for every customer". So it is immutable
 * and carries a version: "a bespoke limit for one enterprise customer is a new
 * plan code, not a mutated row", and a changed entitlement is a new version
 * rather than an edit, or the same plan id would mean two different things to
 * two customers depending on when they read it.
 *
 * ── No numbers are invented here ───────────────────────────────────────────
 * `04-platform/rate-limiting.md` is explicit: "No approved document sets a
 * numeric limit, and this document does not invent one. The matrix is a
 * commercial decision." So this module ships the SHAPE and the validation, and
 * `null` is a first-class "not yet set". No built-in plan catalogue with
 * plausible-looking limits — a made-up number in a plan is a constraint nobody
 * agreed to that a customer would then be held to.
 *
 * ── And no prices ──────────────────────────────────────────────────────────
 * `billing.md` gives `Plan` a `monthlyPrice`, but pricing is OQ-10, an open
 * founder decision, and this increment says "No pricing calculations". A price
 * field nothing may compute with is a field that will silently go stale.
 */

import { parseAmount } from '../credits/amount.js';
import { BillingError } from './errors.js';
import { deepFreeze } from './immutable.js';

/**
 * A plan's identity.
 *
 * Its own id, unlike `SettlementId` or `ConsumptionId`: a plan is genuinely a
 * record of its own — reference data with no organization, versioned
 * independently of anything that references it.
 */
export type PlanId = string;

/**
 * The plan tiers.
 *
 * Established by `06-api/organization-api.md`, which types the organization
 * resource's `plan` field as exactly these three, and referenced by
 * `rate-limiting.md` as "the plan tiers already exist". Not invented here.
 */
export const PLAN_CODES = ['starter', 'growth', 'enterprise'] as const;

export type PlanCode = (typeof PLAN_CODES)[number];

export function isPlanCode(value: unknown): value is PlanCode {
  return typeof value === 'string' && (PLAN_CODES as readonly string[]).includes(value);
}

/**
 * Whether a plan may be subscribed to.
 *
 * `retired` rather than deleted: a plan an existing subscription is on must go
 * on resolving forever, or every customer grandfathered onto an old tier loses
 * their entitlements the day it stops being sold.
 */
export const PLAN_STATUSES = ['active', 'retired'] as const;

export type PlanStatus = (typeof PLAN_STATUSES)[number];

export function isPlanStatus(value: unknown): value is PlanStatus {
  return typeof value === 'string' && (PLAN_STATUSES as readonly string[]).includes(value);
}

/**
 * The inbound rate-limit classes.
 *
 * `06-api/api-principles.md` defines these four and every endpoint declares
 * which it belongs to. Transcribed rather than invented, and deliberately NOT
 * the outbound provider limits, which `08-ai-platform/rate-limiting.md` owns
 * and which are set by provider contracts rather than by a customer's plan.
 */
export const RATE_LIMIT_CLASSES = ['read', 'write', 'expensive', 'auth'] as const;

export type RateLimitClass = (typeof RATE_LIMIT_CLASSES)[number];

/**
 * Requests per minute at each class, or null where no value is set.
 *
 * `auth` is plan-independent by design — "a higher-paying customer does not get
 * more login attempts" — so a plan that sets it is refused rather than quietly
 * ignored, which would let a plan appear to sell something it cannot.
 */
export type PlanRateLimits = Readonly<Record<RateLimitClass, number | null>>;

/** Nothing set. The honest starting point, per `rate-limiting.md`. */
export const UNSET_RATE_LIMITS: PlanRateLimits = Object.freeze({
  read: null,
  write: null,
  expensive: null,
  auth: null,
});

/**
 * What a plan entitles an organization to.
 *
 * Named for `organizations.plan_limits`, the column that projects it. The first
 * five come from `billing.md`'s `PlanEntitlements`; the rate and storage limits
 * are what this increment adds; `features` are entitlement flag keys.
 *
 * `null` means "not set", never zero — `settings.md` rule 4, "absence is not
 * zero". A plan with `maxWorkspaces: 0` sells nothing; one with `null` has not
 * been priced yet, and a quota check must be able to tell them apart.
 */
export interface PlanLimits {
  /** Credits granted at the start of each billing period. A decimal string. */
  readonly includedCredits: string;
  readonly maxWorkspaces: number | null;
  readonly maxMembers: number | null;
  /** The ceiling `retention.days` may be set to on this plan. */
  readonly retentionDays: number | null;
  readonly ssoEnabled: boolean;
  readonly rateLimits: PlanRateLimits;
  /** Bytes of stored media and artifacts. */
  readonly storageBytes: number | null;
  /**
   * Entitlement flag keys this plan turns on.
   *
   * Keys the flag registry declares with `kind: 'entitlement'`, not free text.
   * A plan selling a capability nothing checks is a promise the product cannot
   * keep, and `feature-flags.md` warns about exactly that hygiene problem.
   */
  readonly features: readonly string[];
}

export interface CommercialPlan {
  readonly planId: PlanId;
  readonly code: PlanCode;
  /**
   * Monotonic. A changed entitlement is a new version of the plan, never an
   * edit — reference data is identical for every customer, so an edit would
   * change what two customers on the same plan get depending on when they read.
   */
  readonly version: number;
  readonly status: PlanStatus;
  readonly limits: PlanLimits;
  readonly createdAt: string;
}

const requireId = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new BillingError('InvalidDeclaration', `'${field}' is required and must be non-empty.`);
  }
  return value;
};

/**
 * A count that is either unset or a real capacity.
 *
 * Refuses negatives and fractions: half a workspace is not a quota, and a
 * negative one would make every quota check pass.
 */
function assertCapacity(value: number | null, field: string): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new BillingError(
      'InvalidDeclaration',
      `'${field}' must be a non-negative whole number or null (not set); got ${String(value)}.`,
    );
  }
  return value;
}

function assertRateLimits(limits: PlanRateLimits): PlanRateLimits {
  for (const rateClass of RATE_LIMIT_CLASSES) {
    const value = limits[rateClass];
    if (rateClass === 'auth' && value !== null) {
      throw new BillingError(
        'InvalidDeclaration',
        "'rateLimits.auth' is plan-independent by design — it exists to stop credential attacks, not to price usage. A higher-paying customer does not get more login attempts.",
      );
    }
    assertCapacity(value, `rateLimits.${rateClass}`);
  }
  return limits;
}

/**
 * Validate a set of limits and freeze them.
 *
 * `knownFeatures` is supplied rather than read from the flag registry directly:
 * this module must not depend on a registry instance to say whether a plan is
 * well-formed, and the caller that has one can pass its entitlement keys.
 * Omitted, feature keys are accepted as declared — the shape is still checked.
 */
export function createPlanLimits(
  input: PlanLimits,
  options: { readonly knownFeatures?: readonly string[] } = {},
): PlanLimits {
  // Parsed, not merely shape-checked: `parseAmount` is the ledger's own
  // grammar, so a plan cannot promise an allowance the credit column would
  // refuse to grant.
  parseAmount(input.includedCredits);

  assertCapacity(input.maxWorkspaces, 'maxWorkspaces');
  assertCapacity(input.maxMembers, 'maxMembers');
  assertCapacity(input.retentionDays, 'retentionDays');
  assertCapacity(input.storageBytes, 'storageBytes');
  assertRateLimits(input.rateLimits);

  if (typeof input.ssoEnabled !== 'boolean') {
    throw new BillingError('InvalidDeclaration', "'ssoEnabled' must be a boolean.");
  }

  const seen = new Set<string>();
  for (const feature of input.features) {
    if (typeof feature !== 'string' || feature.trim() === '') {
      throw new BillingError('InvalidDeclaration', 'Every feature key must be a non-empty string.');
    }
    if (seen.has(feature)) {
      throw new BillingError(
        'InvalidDeclaration',
        `Feature '${feature}' is listed twice. A plan either entitles a capability or it does not.`,
      );
    }
    seen.add(feature);

    const known = options.knownFeatures;
    if (known !== undefined && !known.includes(feature)) {
      throw new BillingError(
        'IncompatiblePlan',
        `'${feature}' is not a declared entitlement. A plan selling a capability nothing checks is a promise the product cannot keep. Declared: ${known.join(', ') || '(none)'}.`,
      );
    }
  }

  return deepFreeze({
    includedCredits: input.includedCredits,
    maxWorkspaces: input.maxWorkspaces,
    maxMembers: input.maxMembers,
    retentionDays: input.retentionDays,
    ssoEnabled: input.ssoEnabled,
    rateLimits: { ...input.rateLimits },
    storageBytes: input.storageBytes,
    features: [...input.features],
  });
}

/** A plan, validated and frozen. Reference data: no organization anywhere. */
export function createPlan(
  input: {
    readonly planId: PlanId;
    readonly code: PlanCode;
    readonly version: number;
    readonly status: PlanStatus;
    readonly limits: PlanLimits;
    readonly createdAt: string;
  },
  options: { readonly knownFeatures?: readonly string[] } = {},
): CommercialPlan {
  requireId(input.planId, 'planId');
  requireId(input.createdAt, 'createdAt');

  if (!isPlanCode(input.code)) {
    throw new BillingError(
      'InvalidDeclaration',
      `'${String(input.code)}' is not a plan code. Available: ${PLAN_CODES.join(', ')}.`,
    );
  }
  if (!isPlanStatus(input.status)) {
    throw new BillingError(
      'InvalidDeclaration',
      `'${String(input.status)}' is not a plan status. Available: ${PLAN_STATUSES.join(', ')}.`,
    );
  }
  if (!Number.isSafeInteger(input.version) || input.version < 1) {
    throw new BillingError(
      'InvalidDeclaration',
      `A plan version must be a whole number from 1; got ${String(input.version)}.`,
    );
  }

  return deepFreeze({
    planId: input.planId,
    code: input.code,
    version: input.version,
    status: input.status,
    limits: createPlanLimits(input.limits, options),
    createdAt: input.createdAt,
  });
}

/** Does this plan turn on that entitlement? */
export function entitles(plan: CommercialPlan, feature: string): boolean {
  return plan.limits.features.includes(feature);
}

/**
 * May a subscription be started on this plan?
 *
 * A retired plan goes on resolving for whoever is already on it and cannot be
 * newly subscribed to, which is the whole reason it is retired rather than
 * deleted.
 */
export function assertSubscribable(plan: CommercialPlan): void {
  if (plan.status !== 'active') {
    throw new BillingError(
      'IncompatiblePlan',
      `Plan '${plan.code}' (${plan.planId}) is ${plan.status} and cannot be newly subscribed to. Existing subscriptions on it continue to resolve.`,
    );
  }
}

/**
 * The newer of two versions of one plan, refusing a stale write.
 *
 * The same discipline `billing.md` applies to `SubscriptionChanged`: an
 * out-of-order delivery is ignored rather than applied.
 */
export function assertNewerVersion(current: CommercialPlan, incoming: CommercialPlan): void {
  if (current.planId !== incoming.planId) {
    throw new BillingError(
      'ImmutableFieldChanged',
      `Plan '${current.planId}' and '${incoming.planId}' are different plans; version ordering is per plan.`,
    );
  }
  if (incoming.code !== current.code) {
    throw new BillingError(
      'ImmutableFieldChanged',
      `Plan '${current.planId}' is code '${current.code}'; a version cannot change it to '${incoming.code}'. A different tier is a different plan.`,
    );
  }
  if (incoming.version <= current.version) {
    throw new BillingError(
      'StaleVersion',
      `Plan '${current.planId}' is at version ${String(current.version)}; version ${String(incoming.version)} arrived after it and is ignored.`,
    );
  }
}
