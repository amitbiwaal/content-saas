import { describe, expect, it } from 'vitest';

import { BillingError, type BillingErrorCode } from './errors.js';
import {
  assertNewerVersion,
  assertSubscribable,
  createPlan,
  createPlanLimits,
  entitles,
  isPlanCode,
  isPlanStatus,
  PLAN_CODES,
  PLAN_STATUSES,
  RATE_LIMIT_CLASSES,
  UNSET_RATE_LIMITS,
  type CommercialPlan,
  type PlanLimits,
} from './plan.js';

const codeOf = (call: () => unknown): BillingErrorCode | null => {
  try {
    call();
    return null;
  } catch (error) {
    if (error instanceof BillingError) return error.code;
    throw error;
  }
};

const limits = (overrides: Partial<PlanLimits> = {}): PlanLimits => ({
  includedCredits: '1000.000000',
  maxWorkspaces: 5,
  maxMembers: 20,
  retentionDays: 365,
  ssoEnabled: false,
  rateLimits: UNSET_RATE_LIMITS,
  storageBytes: null,
  features: [],
  ...overrides,
});

const plan = (overrides: Partial<Parameters<typeof createPlan>[0]> = {}): CommercialPlan =>
  createPlan({
    planId: 'plan-growth-v1',
    code: 'growth',
    version: 1,
    status: 'active',
    limits: limits(),
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  });

// ── The vocabulary ──────────────────────────────────────────────────────────

describe('plan codes and statuses', () => {
  it('are the three tiers the organization resource already declares', () => {
    expect(PLAN_CODES).toEqual(['starter', 'growth', 'enterprise']);
  });

  it('reject a tier nothing declares', () => {
    expect(isPlanCode('free')).toBe(false);
    expect(isPlanCode('STARTER')).toBe(false);
    expect(isPlanCode(null)).toBe(false);
  });

  it('retire rather than delete', () => {
    // A plan an existing subscription is on must go on resolving forever.
    expect(PLAN_STATUSES).toEqual(['active', 'retired']);
    expect(isPlanStatus('deleted')).toBe(false);
  });

  it('name the four inbound rate-limit classes api-principles.md defines', () => {
    expect(RATE_LIMIT_CLASSES).toEqual(['read', 'write', 'expensive', 'auth']);
  });

  it('start with every rate limit unset, because no document sets one', () => {
    expect(UNSET_RATE_LIMITS).toEqual({
      read: null,
      write: null,
      expensive: null,
      auth: null,
    });
    expect(Object.isFrozen(UNSET_RATE_LIMITS)).toBe(true);
  });
});

// ── Limits ──────────────────────────────────────────────────────────────────

describe('createPlanLimits', () => {
  it('accepts a well-formed set', () => {
    const result = createPlanLimits(limits());

    expect(result.includedCredits).toBe('1000.000000');
    expect(result.maxWorkspaces).toBe(5);
  });

  it('keeps null distinct from zero', () => {
    // "Absence is not zero" — a plan with 0 workspaces sells nothing; one with
    // null has not been priced yet, and a quota check must tell them apart.
    const unset = createPlanLimits(limits({ maxWorkspaces: null }));
    const none = createPlanLimits(limits({ maxWorkspaces: 0 }));

    expect(unset.maxWorkspaces).toBeNull();
    expect(none.maxWorkspaces).toBe(0);
  });

  it('validates included credits against the ledger’s own grammar', () => {
    // A plan cannot promise an allowance the credit column would refuse.
    expect(() => createPlanLimits(limits({ includedCredits: '-1.000000' }))).toThrow();
    expect(() => createPlanLimits(limits({ includedCredits: 'lots' }))).toThrow();
  });

  it('refuses a negative capacity', () => {
    expect(codeOf(() => createPlanLimits(limits({ maxMembers: -1 })))).toBe('InvalidDeclaration');
  });

  it('refuses a fractional capacity', () => {
    expect(codeOf(() => createPlanLimits(limits({ maxWorkspaces: 2.5 })))).toBe(
      'InvalidDeclaration',
    );
  });

  it('refuses a non-boolean ssoEnabled', () => {
    expect(
      codeOf(() => createPlanLimits(limits({ ssoEnabled: 'yes' as unknown as boolean }))),
    ).toBe('InvalidDeclaration');
  });

  it('accepts a set rate limit', () => {
    const result = createPlanLimits(
      limits({ rateLimits: { ...UNSET_RATE_LIMITS, read: 600, write: 120 } }),
    );

    expect(result.rateLimits.read).toBe(600);
    expect(result.rateLimits.expensive).toBeNull();
  });

  it('refuses a plan that tries to sell auth rate limits', () => {
    // Plan-independent by design: a higher-paying customer does not get more
    // login attempts.
    expect(
      codeOf(() => createPlanLimits(limits({ rateLimits: { ...UNSET_RATE_LIMITS, auth: 100 } }))),
    ).toBe('InvalidDeclaration');
  });

  it('refuses a negative rate limit', () => {
    expect(
      codeOf(() => createPlanLimits(limits({ rateLimits: { ...UNSET_RATE_LIMITS, read: -5 } }))),
    ).toBe('InvalidDeclaration');
  });

  it('refuses a duplicated feature', () => {
    expect(
      codeOf(() =>
        createPlanLimits(limits({ features: ['entitlements.sso', 'entitlements.sso'] })),
      ),
    ).toBe('InvalidDeclaration');
  });

  it('refuses an empty feature key', () => {
    expect(codeOf(() => createPlanLimits(limits({ features: ['  '] })))).toBe('InvalidDeclaration');
  });

  it('refuses a feature nothing declares, when the known set is supplied', () => {
    // A plan selling a capability nothing checks is a promise the product
    // cannot keep.
    expect(
      codeOf(() =>
        createPlanLimits(limits({ features: ['entitlements.telepathy'] }), {
          knownFeatures: ['entitlements.sso', 'entitlements.audit_export'],
        }),
      ),
    ).toBe('IncompatiblePlan');
  });

  it('accepts a declared feature', () => {
    const result = createPlanLimits(limits({ features: ['entitlements.sso'] }), {
      knownFeatures: ['entitlements.sso', 'entitlements.audit_export'],
    });

    expect(result.features).toEqual(['entitlements.sso']);
  });

  it('checks only the shape when no known set is supplied', () => {
    expect(createPlanLimits(limits({ features: ['anything.at.all'] })).features).toEqual([
      'anything.at.all',
    ]);
  });

  it('copies the arrays it was given, so a caller cannot edit a plan later', () => {
    const features = ['entitlements.sso'];
    const result = createPlanLimits(limits({ features }));
    features.push('entitlements.audit_export');

    expect(result.features).toEqual(['entitlements.sso']);
  });

  it('is frozen through', () => {
    const result = createPlanLimits(limits({ features: ['entitlements.sso'] }));

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.rateLimits)).toBe(true);
    expect(Object.isFrozen(result.features)).toBe(true);
    expect(() => {
      (result as { includedCredits: string }).includedCredits = '999999.000000';
    }).toThrow();
  });
});

// ── The plan ────────────────────────────────────────────────────────────────

describe('createPlan', () => {
  it('builds a plan with no organization anywhere on it', () => {
    // Reference data: seeded, versioned, identical for every customer.
    expect(Object.keys(plan())).not.toContain('organizationId');
    expect(Object.keys(plan())).not.toContain('tenantId');
  });

  it('carries no price', () => {
    // "No pricing calculations", and pricing is an open founder decision. A
    // price field nothing may compute with is a field that will go stale.
    const keys = Object.keys(plan());
    expect(keys).not.toContain('price');
    expect(keys).not.toContain('monthlyPrice');
    expect(keys).not.toContain('amount');
  });

  it('refuses an unknown code', () => {
    expect(codeOf(() => plan({ code: 'free' as 'growth' }))).toBe('InvalidDeclaration');
  });

  it('refuses an unknown status', () => {
    expect(codeOf(() => plan({ status: 'draft' as 'active' }))).toBe('InvalidDeclaration');
  });

  it('refuses a missing id', () => {
    expect(codeOf(() => plan({ planId: '' }))).toBe('InvalidDeclaration');
  });

  it('refuses a version below one', () => {
    expect(codeOf(() => plan({ version: 0 }))).toBe('InvalidDeclaration');
    expect(codeOf(() => plan({ version: -1 }))).toBe('InvalidDeclaration');
    expect(codeOf(() => plan({ version: 1.5 }))).toBe('InvalidDeclaration');
  });

  it('is frozen through', () => {
    const built = plan();

    expect(Object.isFrozen(built)).toBe(true);
    expect(Object.isFrozen(built.limits)).toBe(true);
    expect(() => {
      (built.limits as { maxWorkspaces: number | null }).maxWorkspaces = 9999;
    }).toThrow();
  });

  it('is the same plan twice', () => {
    expect(plan()).toEqual(plan());
  });
});

describe('entitles', () => {
  it('is true for a feature the plan sells', () => {
    expect(
      entitles(plan({ limits: limits({ features: ['entitlements.sso'] }) }), 'entitlements.sso'),
    ).toBe(true);
  });

  it('is false for one it does not', () => {
    expect(entitles(plan(), 'entitlements.sso')).toBe(false);
  });
});

describe('assertSubscribable', () => {
  it('admits an active plan', () => {
    expect(
      codeOf(() => {
        assertSubscribable(plan());
      }),
    ).toBeNull();
  });

  it('refuses a retired plan', () => {
    expect(
      codeOf(() => {
        assertSubscribable(plan({ status: 'retired' }));
      }),
    ).toBe('IncompatiblePlan');
  });

  it('says a retired plan still resolves for whoever is on it', () => {
    let message = '';
    try {
      assertSubscribable(plan({ status: 'retired' }));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('Existing subscriptions on it continue to resolve');
  });
});

describe('assertNewerVersion', () => {
  it('accepts a higher version of the same plan', () => {
    expect(
      codeOf(() => {
        assertNewerVersion(plan({ version: 1 }), plan({ version: 2 }));
      }),
    ).toBeNull();
  });

  it('refuses an equal version', () => {
    expect(
      codeOf(() => {
        assertNewerVersion(plan({ version: 2 }), plan({ version: 2 }));
      }),
    ).toBe('StaleVersion');
  });

  it('refuses an older version, because delivery is not ordered', () => {
    expect(
      codeOf(() => {
        assertNewerVersion(plan({ version: 3 }), plan({ version: 2 }));
      }),
    ).toBe('StaleVersion');
  });

  it('refuses a version that changes the tier', () => {
    // A different tier is a different plan, not a new version of this one.
    expect(
      codeOf(() => {
        assertNewerVersion(plan({ version: 1 }), plan({ version: 2, code: 'enterprise' }));
      }),
    ).toBe('ImmutableFieldChanged');
  });

  it('refuses to order versions of two different plans', () => {
    expect(
      codeOf(() => {
        assertNewerVersion(plan({ planId: 'a' }), plan({ planId: 'b', version: 2 }));
      }),
    ).toBe('ImmutableFieldChanged');
  });
});
