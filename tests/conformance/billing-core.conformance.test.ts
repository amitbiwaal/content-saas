/**
 * The Billing domain against the platform it is the supplier for.
 *
 * ── What only this file can check ───────────────────────────────────────────
 *
 * 1. NO SECOND MODEL. `BillingStatus` IS `OrganizationStatus`;
 *    `BillingAccountId` IS the organization's id; plan codes are the tiers the
 *    organization API already declares; rate-limit classes are the ones
 *    `api-principles.md` defines; entitlements are flags the registry already
 *    owns. Nothing here re-declares any of them.
 *
 * 2. BILLING REPORTS; IT NEVER DECIDES. No organization transition, no
 *    suspension, no ledger write, no provider call. Structural, per module.
 *
 * 3. NO PAYMENTS, NO INVOICES, NO WEBHOOKS, NO TAXES, NO AI, NO DATABASE.
 *
 * 4. NO INVENTED NUMBERS. `rate-limiting.md` refuses to set a limit; so does
 *    this. No seeded plan catalogue with plausible-looking figures.
 *
 * 5. THE DEVIATIONS, recorded so they cannot be forgotten.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  assertBillingCurrency,
  BILLABLE_STATUSES,
  BillingError,
  canSubscriptionTransition,
  canTransition as canOrganizationTransition,
  createBillingAccount,
  createPlan,
  createSubscription,
  isBillingStatus,
  LEDGER_CURRENCY,
  ORGANIZATION_STATUSES,
  PLAN_CODES,
  RATE_LIMIT_CLASSES,
  SUBSCRIPTION_STATUSES,
  UNSET_RATE_LIMITS,
  type BillingAccountRepository,
  type CommercialPlan,
  type OrganizationStatus,
  type PlanRepository,
  type SubscriptionRepository,
} from '@contentos/platform';
import { describe, expect, it } from 'vitest';

const ORG = '018f7a1e-0000-7000-8000-0000000000aa';
const AT = '2026-01-01T00:00:00.000Z';

const billingDir = new URL('../../packages/platform/src/billing/', import.meta.url);

const codeOf = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, billingDir)), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

/** Every module this increment added. */
const MODULES = [
  'account.ts',
  'errors.ts',
  'immutable.ts',
  'period.ts',
  'plan.ts',
  'repository.ts',
  'subscription.ts',
] as const;

const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

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

// ── 1 · No second model ─────────────────────────────────────────────────────

describe('the account is the organization', () => {
  it('takes the organization’s id, and adds no id of its own', () => {
    const account = createBillingAccount({
      organizationId: ORG,
      currency: 'USD',
      status: 'active',
      createdAt: AT,
    });

    expect(account.accountId).toBe(ORG);
    expect(account.accountId).toBe(account.organizationId);
  });

  it('adds no `billing_accounts` table', () => {
    // `billing.md` specifies `plans`, `subscriptions`, `invoices`,
    // `payment_methods` and `provider_webhook_events` — and no account table,
    // because `subscriptions` keys on `organization_id`.
    for (const file of MODULES) {
      expect(codeOf(file)).not.toMatch(/CREATE TABLE|ALTER TABLE|INSERT INTO/i);
    }
  });

  it('takes its status from the organization lifecycle, unchanged', () => {
    // Two statuses for one fact would drift, and the drift would be invisible
    // until a customer was suspended in one and paying in the other.
    for (const status of ORGANIZATION_STATUSES) {
      expect(isBillingStatus(status)).toBe(true);
    }
    expect(isBillingStatus('trialing')).toBe(false);
  });

  it('declares no status list of its own', () => {
    const code = codeOf('account.ts');
    expect(code).not.toMatch(/BILLING_STATUSES/);
    expect(code).toMatch(/from '\.\.\/organizations\/lifecycle\.js'/);
  });

  it('bills in exactly the statuses the organization can be billed in', () => {
    expect(BILLABLE_STATUSES.every((status) => ORGANIZATION_STATUSES.includes(status))).toBe(true);
    expect(BILLABLE_STATUSES).toEqual(['active', 'past_due']);
  });

  it('does not confuse its currency with the ledger’s', () => {
    // `LEDGER_CURRENCY` is what the ledger denominates in; an account's
    // currency is what the customer is charged in. Conflating them would price
    // a credit at one unit of a currency nobody agreed to.
    expect(LEDGER_CURRENCY).toBe('credits');
    expect(() => assertBillingCurrency(LEDGER_CURRENCY)).toThrow(BillingError);
  });
});

describe('the vocabularies are the platform’s, not new ones', () => {
  it('plan codes are the tiers the organization API declares', () => {
    expect(PLAN_CODES).toEqual(['starter', 'growth', 'enterprise']);
    expect(read('../../contentos-docs/06-api/organization-api.md')).toContain(
      "readonly plan: 'starter' | 'growth' | 'enterprise';",
    );
  });

  it('rate-limit classes are the four api-principles.md defines', () => {
    expect(RATE_LIMIT_CLASSES).toEqual(['read', 'write', 'expensive', 'auth']);
    const spec = read('../../contentos-docs/04-platform/rate-limiting.md');
    for (const rateClass of RATE_LIMIT_CLASSES) {
      expect(spec).toContain(`\`${rateClass}\``);
    }
  });

  it('subscription statuses are the lifecycle diagram’s', () => {
    expect(SUBSCRIPTION_STATUSES).toEqual([
      'trialing',
      'active',
      'past_due',
      'cancel_pending',
      'suspended',
      'expired',
    ]);
  });

  it('the subscription machine is not the organization machine', () => {
    // They share two status NAMES and nothing else. `dunning_exhausted` is a
    // subscription fact; `suspend` is an organization decision.
    expect(canSubscriptionTransition('past_due', 'dunning_exhausted')).toBe(true);
    expect(canOrganizationTransition('past_due', 'suspend')).toBe(true);
    expect(codeOf('subscription.ts')).not.toMatch(/organizations\/lifecycle/);
  });

  it('the projection targets it feeds already exist', () => {
    const identity = read('../../infrastructure/migrations/0003_identity.sql');
    expect(identity).toContain('plan_limits  JSONB');
    expect(identity).toContain('billing_ref  TEXT');
    expect(identity).toContain('Projection from Commerce, never authored here');
    expect(identity).toContain("CHECK (status IN ('active','past_due','suspended'");
  });
});

// ── 2 · Billing reports; it never decides ───────────────────────────────────

describe('billing never suspends anything itself', () => {
  it('transitions no organization', () => {
    // "It reports commercial facts; organizations.md decides and executes the
    // cascade. This keeps one service in charge of tenancy state transitions."
    for (const file of MODULES) {
      const code = codeOf(file);
      expect(code).not.toMatch(/OrganizationError|resolveTarget|restoresPreviousStatus/);
      expect(code).not.toMatch(/organizationService|suspendOrganization|closeOrganization/);
    }
  });

  it('reaches the organization lifecycle from ONE module, for its status only', () => {
    // `account.ts` needs `isOrganizationStatus` and nothing else. Every other
    // module has no path to the organization machine at all.
    const account = codeOf('account.ts');
    expect(account).toMatch(/isOrganizationStatus/);
    expect(account).not.toMatch(
      /ORGANIZATION_TRANSITIONS|TRANSITION_RULES|assertTransitionAllowed/,
    );

    for (const file of MODULES.filter((f) => f !== 'account.ts')) {
      expect(codeOf(file)).not.toMatch(/organizations\/lifecycle/);
    }
  });

  it('writes no ledger entry', () => {
    // "Billing sells credits and records the purchase; credits.md owns the
    // ledger that spends them."
    for (const file of MODULES) {
      const code = codeOf(file);
      expect(code).not.toMatch(/\.append\(|appendEntry|createCreditLedgerService|LedgerEntry/);
      expect(code).not.toMatch(/authorizeSpend|recordConsumption|settle\(|CreditHold/);
    }
  });

  it('touches the credits package for one thing only: the amount grammar', () => {
    // `includedCredits` is validated by `parseAmount` so a plan cannot promise
    // an allowance the NUMERIC column would refuse.
    expect(codeOf('plan.ts')).toMatch(/import \{ parseAmount \} from '\.\.\/credits\/amount\.js'/);
    for (const file of MODULES.filter((f) => f !== 'plan.ts')) {
      expect(codeOf(file)).not.toMatch(/\.\.\/credits\//);
    }
  });

  it('enforces no limit it publishes', () => {
    // "Enforcing limits at request time" belongs to organizations (quota),
    // credits (spend) and feature-flags (capability). This supplies the values.
    for (const file of MODULES) {
      expect(codeOf(file)).not.toMatch(/enforce|checkQuota|assertQuota|rateLimiter|throttle/i);
    }
  });
});

// ── 3 · No payments, no invoices, no webhooks ───────────────────────────────

describe('the modules depend on nothing they may not', () => {
  it('import no payment or tax SDK', () => {
    for (const file of MODULES) {
      expect(codeOf(file)).not.toMatch(/stripe|paddle|braintree|paypal|adyen|avalara|taxjar/i);
    }
  });

  it('implement no invoice, checkout, coupon, refund or webhook', () => {
    // Declarations and imports, not prose: an error message may explain that
    // "the invoice is singular" without this layer having invoices.
    const OUT_OF_SCOPE =
      /(?:interface|type|class|function|const|enum)\s+\w*(?:Invoice|Checkout|Coupon|Discount|Refund|Webhook|Receipt)/i;
    for (const file of MODULES) {
      const code = codeOf(file);
      expect(code).not.toMatch(OUT_OF_SCOPE);
      expect(code).not.toMatch(/^import .*(?:Invoice|Checkout|Coupon|Refund|Webhook)/im);
      // Nor a field carrying one.
      expect(code).not.toMatch(/readonly \w*(?:invoice|coupon|refund|webhook)\w*\s*[:?]/i);
    }
  });

  it('implement no payment method and hold no card data', () => {
    // "No card data ever enters this system."
    for (const file of MODULES) {
      expect(codeOf(file)).not.toMatch(/card|last4|cvv|pan\b|paymentMethod|charge\(/i);
    }
  });

  it('carry a provider reference without ever reaching a provider', () => {
    const code = codeOf('subscription.ts');
    expect(code).toMatch(/providerRef/);
    expect(code).not.toMatch(/fetch\(|https?:\/\/|axios|got\(/);
  });

  it('import no driver and write no SQL', () => {
    for (const file of MODULES) {
      const code = codeOf(file);
      expect(code).not.toMatch(/from '(pg|postgres|mysql2|knex|drizzle|prisma)/);
      expect(code).not.toMatch(/SELECT .+ FROM |createPool|\.query\(/i);
      expect(code).not.toMatch(/@contentos\/contracts/);
    }
  });

  it('import nothing from the AI platform', () => {
    // `providerRef` is a payment provider's opaque string, so the check is for
    // the AI package and its runtime vocabulary, not the word "provider".
    for (const file of MODULES) {
      const code = codeOf(file);
      expect(code).not.toMatch(/@contentos\/ai/);
      expect(code).not.toMatch(/orchestrat|workflowRuntime|promptTemplate|modelTier|tokenUsage/i);
      expect(code).not.toMatch(
        /(?:interface|type|class|function|const)\s+\w*(?:Provider|Prompt|Workflow|Completion)/,
      );
    }
  });

  it('read no clock and generate no ids', () => {
    // Every instant is supplied. A lifecycle that timestamped itself could not
    // be asserted on, and a renewal job would disagree with the billing page.
    for (const file of MODULES) {
      const code = codeOf(file);
      expect(code).not.toMatch(/Date\.now\(|new Date\(\)|Math\.random\(|randomUUID|secureId/);
    }
  });

  it('parse instants only in the one module that does calendar arithmetic', () => {
    for (const file of MODULES.filter((f) => f !== 'period.ts')) {
      expect(codeOf(file)).not.toMatch(/new Date\(/);
    }
    // And there, only from a supplied string — never from the clock.
    expect(codeOf('period.ts')).toMatch(/new Date\(value\)/);
  });
});

describe('the ports are ports', () => {
  it('ship no implementation', () => {
    const code = codeOf('repository.ts');
    expect(code).not.toMatch(/^export (async )?function/m);
    expect(code).not.toMatch(/^export const/m);
    expect(code).toMatch(/interface BillingAccountRepository/);
    expect(code).toMatch(/interface SubscriptionRepository/);
    expect(code).toMatch(/interface PlanRepository/);
  });

  it('offer no invoice, payment or webhook method', () => {
    const code = codeOf('repository.ts');
    expect(code).not.toMatch(/Invoice|Payment|Webhook|Charge|Checkout/);
  });

  it('give the plan repository no organization dimension', () => {
    // A plan is reference data — "identical for every customer". A
    // per-organization plan lookup would be the bespoke row billing.md rules out.
    const code = codeOf('repository.ts');
    const planSection = code.slice(code.indexOf('interface PlanRepository'));
    expect(planSection).not.toMatch(/organizationId/);
  });

  it('page by keyset, never by offset', () => {
    const code = codeOf('repository.ts');
    expect(code).toMatch(/interface SubscriptionPosition/);
    expect(code).not.toMatch(/offset|page:|pageNumber/i);
  });

  it('are reachable as types from the barrel', () => {
    const accounts: BillingAccountRepository | null = null;
    const subscriptions: SubscriptionRepository | null = null;
    const plans: PlanRepository | null = null;

    expect([accounts, subscriptions, plans]).toEqual([null, null, null]);
  });
});

// ── 4 · No invented numbers ─────────────────────────────────────────────────

describe('no number nobody agreed to', () => {
  it('sets no rate limit', () => {
    // "No approved document sets a numeric limit, and this document does not
    // invent one. The matrix is a commercial decision."
    expect(UNSET_RATE_LIMITS).toEqual({ read: null, write: null, expensive: null, auth: null });
    expect(read('../../contentos-docs/04-platform/rate-limiting.md')).toContain(
      'this document does not invent one',
    );
  });

  it('seeds no plan catalogue', () => {
    // A built-in plan carrying plausible-looking limits is a constraint nobody
    // agreed to that a customer would then be held to.
    const code = codeOf('plan.ts');
    expect(code).not.toMatch(/BUILT_IN_PLANS|DEFAULT_PLANS|PLAN_CATALOGUE/);
  });

  it('carries no price anywhere', () => {
    // "No pricing calculations", and pricing is an open founder decision. A
    // field or a type, not the word — an error message may say a limit "has not
    // been priced yet" without this layer holding a price.
    for (const file of MODULES) {
      const code = codeOf(file);
      expect(code).not.toMatch(/readonly \w*[Pp]rice\w*\s*[:?]/);
      expect(code).not.toMatch(/\b(?:Money|MonetaryAmount|cents|mrr)\b/i);
      expect(code).not.toMatch(
        /(?:interface|type|class|function|const)\s+\w*(?:Price|Pricing|Invoice)/i,
      );
    }
    expect(Object.keys(plan())).not.toContain('monthlyPrice');
    expect(Object.keys(plan().limits)).not.toContain('price');
  });

  it('keeps "not set" distinct from zero', () => {
    // `settings.md` rule 4: absence is not zero. A plan with 0 workspaces sells
    // nothing; one with null has not been priced.
    expect(
      plan({ limits: { ...plan().limits, maxWorkspaces: null } }).limits.maxWorkspaces,
    ).toBeNull();
    expect(plan({ limits: { ...plan().limits, maxWorkspaces: 0 } }).limits.maxWorkspaces).toBe(0);
  });
});

// ── 5 · Immutability ────────────────────────────────────────────────────────

describe('plans and subscriptions are immutable', () => {
  it('freezes a plan through', () => {
    const built = plan();

    expect(Object.isFrozen(built)).toBe(true);
    expect(Object.isFrozen(built.limits)).toBe(true);
    expect(Object.isFrozen(built.limits.rateLimits)).toBe(true);
    expect(Object.isFrozen(built.limits.features)).toBe(true);
  });

  it('freezes a subscription through', () => {
    const built = createSubscription({
      subscriptionId: 'sub-1',
      organizationId: ORG,
      plan: plan(),
      cycle: 'monthly',
      startedAt: AT,
    });

    expect(Object.isFrozen(built)).toBe(true);
    expect(Object.isFrozen(built.currentPeriod)).toBe(true);
  });

  it('freezes an account through', () => {
    expect(
      Object.isFrozen(
        createBillingAccount({
          organizationId: ORG,
          currency: 'USD',
          status: 'active',
          createdAt: AT,
        }),
      ),
    ).toBe(true);
  });

  it('mutates nothing anywhere: every builder returns a new value', () => {
    // `this.x =` inside a constructor is how a class is built and mutates
    // nothing a caller can see; assignment to anything else would.
    for (const file of MODULES) {
      expect(codeOf(file)).not.toMatch(/^\s*(?!this\.)\w+\.\w+ = /m);
    }
  });
});

// ── 6 · Deviations ──────────────────────────────────────────────────────────

describe('recorded deviations', () => {
  it('DEVIATION: BillingStatus is OrganizationStatus, not a new vocabulary', () => {
    // The increment names a `BillingStatus`. The organization already stores
    // one, `organizations.md` owns moving it, and it already has `past_due`.
    const status: OrganizationStatus = 'past_due';
    expect(isBillingStatus(status)).toBe(true);
    expect(codeOf('account.ts')).toMatch(/type BillingStatus = OrganizationStatus/);
  });

  it('DEVIATION: BillingAccountId is the organization’s id', () => {
    expect(codeOf('account.ts')).toMatch(/accountId: input\.organizationId/);
  });

  it('DEVIATION: the account’s workspace is attribution, never a boundary', () => {
    // The increment asks for an optional workspace. `billing.md`: "A workspace
    // is never billed... the invoice is singular." It is carried for reporting
    // and cannot key a second account.
    const account = createBillingAccount({
      organizationId: ORG,
      workspaceId: '018f7a1e-0000-7000-8000-0000000000bb',
      currency: 'USD',
      status: 'active',
      createdAt: AT,
    });

    expect(account.workspaceId).not.toBeNull();
    expect(account.accountId).toBe(ORG);
    expect(codeOf('subscription.ts')).not.toMatch(/workspaceId/);
  });

  it('DEVIATION: a plan carries no price', () => {
    expect(codeOf('plan.ts')).not.toMatch(/monthlyPrice/);
  });

  it('DEVIATION: `annual` is not established by billing.md', () => {
    // The spec names a monthly price and monthly periods. A cycle type with one
    // member could never be invalid, which the increment requires.
    expect(codeOf('period.ts')).toMatch(/'monthly', 'annual'/);
  });

  it('DEVIATION: the error taxonomy is new, per the one-per-module convention', () => {
    // `OrganizationError`, `FeatureFlagError`, `SettingsError`, `HoldError` and
    // `LedgerError` each belong to one module. `HoldErrorCode` gaining
    // `PlanNotFound` would make the credits taxonomy describe things credits
    // knows nothing about.
    expect(new BillingError('PlanNotFound', 'x').name).toBe('BillingError');
    expect(codeOf('errors.ts')).toMatch(/class BillingError extends Error/);
    for (const file of MODULES.filter((f) => f !== 'errors.ts')) {
      expect(codeOf(file)).not.toMatch(/class \w*Error extends/);
    }
  });

  it('DEVIATION: no migration, because database implementation is out of scope', () => {
    // `billing.md` puts these tables in `0021_commerce`; that number was taken
    // by `0021_event_platform.sql` and the Commerce migration has never been
    // written. The projection columns it feeds already exist.
    const migrations = read('../../infrastructure/migrations/0003_identity.sql');
    expect(migrations).toContain('plan_limits');
    expect(() => read('../../infrastructure/migrations/0026_commerce.sql')).toThrow();
  });
});
