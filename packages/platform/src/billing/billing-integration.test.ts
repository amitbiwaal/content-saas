/**
 * The Billing domain against the platform pieces that were waiting for it.
 *
 * The unit suites check each model on its own. This wires the layer to what
 * already exists — the entitlement flags owned by `platform.billing`, the
 * organization lifecycle that receives `payment_failed`, and the credit ledger
 * that an included allowance is granted into — and asserts that Billing
 * supplies exactly what those consumers were built to apply, and nothing more.
 *
 * `billing.md`: "Billing is the supplier of entitlement to the rest of the
 * platform — it publishes PlanLimits, and everything else applies them."
 */

import { describe, expect, it } from 'vitest';

import { calculateBalance } from '../credits/aggregate.js';
import type { LedgerEntry } from '../credits/ledger.js';
import { createFeatureFlagRegistry } from '../flags/registry.js';
import {
  assertTransitionAllowed as assertOrganizationTransition,
  canTransition as canOrganizationTransition,
  INITIAL_STATUS,
  ORGANIZATION_STATUSES,
  resolveTarget,
  type OrganizationStatus,
} from '../organizations/lifecycle.js';
import { createSettingsRegistry } from '../settings/registry.js';
import { BILLABLE_STATUSES, createBillingAccount, isBillable, isBillingStatus } from './account.js';
import { BillingError } from './errors.js';
import { nextPeriod } from './period.js';
import { createPlan, entitles, UNSET_RATE_LIMITS, type CommercialPlan } from './plan.js';
import {
  applyTransition,
  createSubscription,
  isEntitling,
  renew,
  type Subscription,
} from './subscription.js';

const ORG = '018f7a1e-0000-7000-8000-0000000000aa';
const STARTED = '2026-01-01T00:00:00.000Z';
const AT = '2026-01-15T00:00:00.000Z';

/** The real registry, with the real built-in declarations. */
const flags = createFeatureFlagRegistry();

const entitlementKeys = flags.declarations
  .filter((declaration) => declaration.kind === 'entitlement')
  .map((declaration) => declaration.key);

const plan = (overrides: Partial<Parameters<typeof createPlan>[0]> = {}): CommercialPlan =>
  createPlan(
    {
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
      createdAt: STARTED,
      ...overrides,
    },
    { knownFeatures: entitlementKeys },
  );

const subscription = (
  overrides: Partial<Parameters<typeof createSubscription>[0]> = {},
): Subscription =>
  createSubscription({
    subscriptionId: 'sub-1',
    organizationId: ORG,
    plan: plan(),
    cycle: 'monthly',
    startedAt: STARTED,
    ...overrides,
  });

// ── Entitlements land where the flag registry expects them ──────────────────

describe('a plan sells only capabilities the platform declares', () => {
  it('the entitlement flags exist and are owned by billing', () => {
    // They were declared before this module: "Projected from billing.md, never
    // authored here." This is the author.
    expect(entitlementKeys.length).toBeGreaterThan(0);
    for (const key of entitlementKeys) {
      expect(flags.require(key).owner).toBe('platform.billing');
    }
  });

  it('accepts a plan selling a real entitlement', () => {
    const growth = plan({
      limits: { ...plan().limits, features: ['entitlements.sso'], ssoEnabled: true },
    });

    expect(entitles(growth, 'entitlements.sso')).toBe(true);
    expect(flags.has('entitlements.sso')).toBe(true);
  });

  it('refuses a plan selling a capability nothing checks', () => {
    expect(() =>
      plan({ limits: { ...plan().limits, features: ['entitlements.time_travel'] } }),
    ).toThrow(BillingError);
  });

  it('refuses a plan selling an operational flag', () => {
    // A kill switch is ours to throw and must not be reachable by the customer
    // it is protecting; selling it as an entitlement would make it one.
    expect(() =>
      plan({ limits: { ...plan().limits, features: ['credits.enforce_authorization'] } }),
    ).toThrow(BillingError);
  });

  it('refuses a plan selling a release flag', () => {
    expect(() =>
      plan({ limits: { ...plan().limits, features: ['knowledge.vector_search'] } }),
    ).toThrow(BillingError);
  });

  it('sells only organization-scoped capabilities', () => {
    // "A plan is bought per account", so every entitlement is
    // organization-scoped. A workspace-scoped entitlement could be turned on
    // for one workspace of a plan the organization never bought.
    for (const key of entitlementKeys) {
      expect(flags.require(key).scope).toBe('organization');
    }
  });

  it('every entitlement has a settings projection to be stored in', () => {
    const settings = createSettingsRegistry();
    const projected = flags.settingDeclarations().map((declaration) => declaration.key);

    for (const key of entitlementKeys) {
      expect(projected).toContain(`flags.${key}`);
    }
    expect(settings.declarations.length).toBeGreaterThan(0);
  });
});

// ── The included allowance is a real ledger amount ──────────────────────────

describe('included credits reach the ledger unchanged', () => {
  const grant = (amount: string): LedgerEntry => ({
    id: 'grant-1',
    tenantId: ORG,
    organizationId: ORG,
    workspaceId: null,
    entryType: 'grant',
    amount,
    direction: 'credit',
    idempotencyKey: 'sub-1:2026-01',
    referenceEntryId: null,
    reason: 'included allowance',
    correlationId: '018f7a1e-0000-7000-8000-0000000000dd',
    createdBy: null,
    metadata: {},
    createdAt: STARTED,
  });

  it('grants exactly what the plan promised', () => {
    const balance = calculateBalance({
      organizationId: ORG,
      entries: [grant(plan().limits.includedCredits)],
    });

    expect(balance.balance).toBe('1000.000000');
    expect(balance.credited).toBe('1000.000000');
  });

  it('a plan cannot promise an allowance the ledger would refuse', () => {
    // Validated against `parseAmount`, the ledger's own grammar — so a plan
    // that would fail at the NUMERIC column fails at declaration instead.
    expect(() => plan({ limits: { ...plan().limits, includedCredits: '-1.000000' } })).toThrow();
    expect(() => plan({ limits: { ...plan().limits, includedCredits: '1000.0000001' } })).toThrow();
  });

  it('a plan that includes nothing is a plan, not a broken one', () => {
    const free = plan({ limits: { ...plan().limits, includedCredits: '0.000000' } });

    expect(
      calculateBalance({ organizationId: ORG, entries: [grant(free.limits.includedCredits)] })
        .balance,
    ).toBe('0.000000');
  });

  it('one allowance per period, keyed so a retry grants once', () => {
    // The ledger fold refuses a reused transaction id — which is what stops a
    // retried renewal granting the allowance twice.
    expect(() =>
      calculateBalance({
        organizationId: ORG,
        entries: [grant('1000.000000'), grant('1000.000000')],
      }),
    ).toThrow();
  });

  it('billing never spends: it grants, credits debits', () => {
    const balance = calculateBalance({
      organizationId: ORG,
      entries: [grant(plan().limits.includedCredits)],
    });

    expect(balance.debited).toBe('0.000000');
  });
});

// ── Billing reports; Organizations decides ──────────────────────────────────

describe('the two lifecycles are wired but separate', () => {
  it('the organization already has the transitions billing reports', () => {
    // `payment_failed` and `payment_recovered` were named on the organization
    // machine before this module existed — they were waiting for a reporter.
    expect(canOrganizationTransition('active', 'payment_failed')).toBe(true);
    expect(canOrganizationTransition('past_due', 'payment_recovered')).toBe(true);
  });

  it('a subscription reaching past_due does not move the organization', () => {
    // "Billing never suspends anything itself. It reports commercial facts;
    // organizations.md decides and executes the cascade."
    const active = applyTransition(subscription(), 'activate', AT);
    const pastDue = applyTransition(active, 'payment_failed', AT);

    expect(pastDue.status).toBe('past_due');
    // The organization is untouched — nothing here can touch it.
    expect(Object.keys(pastDue)).not.toContain('organizationStatus');
    expect(INITIAL_STATUS).toBe('active');
  });

  it('but the fact it reports lands on a transition the organization has', () => {
    expect(resolveTarget('payment_failed')).toBe('past_due');
    expect(resolveTarget('payment_recovered')).toBe('active');
  });

  it('a subscription past_due and an organization past_due both still entitle', () => {
    const pastDue = applyTransition(
      applyTransition(subscription(), 'activate', AT),
      'payment_failed',
      AT,
    );
    const account = createBillingAccount({
      organizationId: ORG,
      currency: 'USD',
      status: 'past_due',
      createdAt: STARTED,
    });

    // "A provider outage must never suspend a paying customer."
    expect(isEntitling(pastDue)).toBe(true);
    expect(isBillable(account)).toBe(true);
  });

  it('dunning exhausted stops the subscription entitling, and Organizations suspends', () => {
    const exhausted = applyTransition(
      applyTransition(applyTransition(subscription(), 'activate', AT), 'payment_failed', AT),
      'dunning_exhausted',
      AT,
    );

    expect(isEntitling(exhausted)).toBe(false);
    // The cascade is the organization's, and its machine already has the edge.
    expect(canOrganizationTransition('past_due', 'suspend')).toBe(true);
    expect(resolveTarget('suspend')).toBe('suspended');
  });

  it('the account status is the organization status, for every one of them', () => {
    for (const status of ORGANIZATION_STATUSES) {
      expect(isBillingStatus(status)).toBe(true);
      const account = createBillingAccount({
        organizationId: ORG,
        currency: 'USD',
        status,
        createdAt: STARTED,
      });
      expect(account.status).toBe(status);
      expect(isBillable(account)).toBe(BILLABLE_STATUSES.includes(status));
    }
  });

  it('a suspended organization is reactivated to what it was, not to active', () => {
    // The revenue-integrity rule that already exists: an organization suspended
    // while past_due still owes money when the suspension lifts.
    expect(resolveTarget('reactivate', 'past_due')).toBe('past_due');
    expect(resolveTarget('reactivate', 'active')).toBe('active');
  });

  it('the organization machine refuses what billing cannot report around', () => {
    expect(() => {
      assertOrganizationTransition('closed' as OrganizationStatus, 'payment_recovered');
    }).toThrow();
  });
});

// ── A subscription over a year ──────────────────────────────────────────────

describe('a subscription through a year of periods', () => {
  it('renews twelve times with no gap and no overlap', () => {
    let current = applyTransition(subscription(), 'activate', STARTED);
    const boundaries: string[] = [current.currentPeriod.start];

    for (let month = 0; month < 12; month += 1) {
      const next = nextPeriod(current.currentPeriod);
      current = renew(current, next, next.start);
      boundaries.push(current.currentPeriod.start);
    }

    expect(boundaries[0]).toBe('2026-01-01T00:00:00.000Z');
    expect(boundaries[12]).toBe('2027-01-01T00:00:00.000Z');
    expect(current.status).toBe('active');
    expect(current.version).toBe(14);
  });

  it('records a version per change, so an out-of-order delivery is detectable', () => {
    const created = subscription();
    const activated = applyTransition(created, 'activate', AT);
    const failed = applyTransition(activated, 'payment_failed', AT);
    const recovered = applyTransition(failed, 'payment_recovered', AT);

    expect([created.version, activated.version, failed.version, recovered.version]).toEqual([
      1, 2, 3, 4,
    ]);
  });

  it('cancels at period end and keeps entitling until it', () => {
    const active = applyTransition(subscription(), 'activate', STARTED);
    const cancelled = applyTransition(active, 'request_cancellation', AT);

    // The customer keeps what they paid for.
    expect(isEntitling(cancelled)).toBe(true);
    expect(cancelled.currentPeriod.end).toBe('2026-02-01T00:00:00.000Z');

    const expired = applyTransition(cancelled, 'period_ended', '2026-02-01T00:00:00.000Z');
    expect(isEntitling(expired)).toBe(false);
    expect(expired.renewsAt).toBeNull();
  });

  it('a revoked cancellation renews again', () => {
    const cancelled = applyTransition(
      applyTransition(subscription(), 'activate', STARTED),
      'request_cancellation',
      AT,
    );
    const revoked = applyTransition(cancelled, 'revoke_cancellation', AT);

    expect(revoked.cancelledAt).toBeNull();
    expect(() => renew(revoked, nextPeriod(revoked.currentPeriod), AT)).not.toThrow();
  });

  it('a cancelled subscription is never renewed', () => {
    const cancelled = applyTransition(
      applyTransition(subscription(), 'activate', STARTED),
      'request_cancellation',
      AT,
    );

    expect(() => renew(cancelled, nextPeriod(cancelled.currentPeriod), AT)).toThrow(BillingError);
  });
});
