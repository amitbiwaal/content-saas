import { describe, expect, it } from 'vitest';

import { ORGANIZATION_STATUSES } from '../organizations/lifecycle.js';
import {
  assertBillingCurrency,
  assertOneAccountPerOrganization,
  assertOwnedBy,
  BILLABLE_STATUSES,
  createBillingAccount,
  isBillable,
  isBillingStatus,
  type BillingAccount,
  type BillingStatus,
} from './account.js';
import { BillingError, type BillingErrorCode } from './errors.js';

const ORG = '018f7a1e-0000-7000-8000-0000000000aa';
const WS = '018f7a1e-0000-7000-8000-0000000000bb';
const AT = '2026-01-01T00:00:00.000Z';

const codeOf = (call: () => unknown): BillingErrorCode | null => {
  try {
    call();
    return null;
  } catch (error) {
    if (error instanceof BillingError) return error.code;
    throw error;
  }
};

const account = (
  overrides: Partial<Parameters<typeof createBillingAccount>[0]> = {},
): BillingAccount =>
  createBillingAccount({
    organizationId: ORG,
    currency: 'USD',
    status: 'active',
    createdAt: AT,
    ...overrides,
  });

// ── Identity ────────────────────────────────────────────────────────────────

describe('a billing account is the organization', () => {
  it('takes the organization’s id as its own', () => {
    // No `billing_accounts` table exists in the specification and this adds
    // none; a separate id would be a second thing to reconcile.
    expect(account().accountId).toBe(ORG);
    expect(account().accountId).toBe(account().organizationId);
  });

  it('refuses an account with no organization', () => {
    expect(codeOf(() => account({ organizationId: '' }))).toBe('InvalidDeclaration');
    expect(codeOf(() => account({ organizationId: '   ' }))).toBe('InvalidDeclaration');
  });

  it('refuses an account with no creation instant', () => {
    expect(codeOf(() => account({ createdAt: '' }))).toBe('InvalidDeclaration');
  });
});

// ── Status ──────────────────────────────────────────────────────────────────

describe('billing status is the organization’s status', () => {
  it('accepts every organization status and nothing else', () => {
    // Two statuses for one fact would drift, and the drift would be invisible
    // until a customer was suspended in one and paying in the other.
    for (const status of ORGANIZATION_STATUSES) {
      expect(isBillingStatus(status)).toBe(true);
    }
    expect(isBillingStatus('trialing')).toBe(false);
    expect(isBillingStatus('cancelled')).toBe(false);
    expect(isBillingStatus(null)).toBe(false);
  });

  it('refuses a status the organization lifecycle does not have', () => {
    expect(codeOf(() => account({ status: 'trialing' as BillingStatus }))).toBe(
      'InvalidDeclaration',
    );
  });

  it('bills an active account', () => {
    expect(isBillable(account())).toBe(true);
  });

  it('still bills a past_due account', () => {
    // "A provider outage must never suspend a paying customer" — dunning is a
    // grace period, and Organizations decides when it has run out.
    expect(isBillable(account({ status: 'past_due' }))).toBe(true);
    expect(BILLABLE_STATUSES).toEqual(['active', 'past_due']);
  });

  it('does not bill a suspended, closing or closed account', () => {
    for (const status of ['suspended', 'pending_closure', 'closed'] as const) {
      expect(isBillable(account({ status }))).toBe(false);
    }
  });
});

// ── Currency ────────────────────────────────────────────────────────────────

describe('currency', () => {
  it('accepts an ISO-4217 code', () => {
    expect(assertBillingCurrency('USD')).toBe('USD');
    expect(assertBillingCurrency('EUR')).toBe('EUR');
    expect(assertBillingCurrency('JPY')).toBe('JPY');
  });

  it('refuses lowercase, which is not the standard’s form', () => {
    expect(codeOf(() => assertBillingCurrency('usd'))).toBe('InvalidDeclaration');
  });

  it('refuses anything that is not three letters', () => {
    for (const bad of ['US', 'USDD', '840', '', 'US$', null, 42]) {
      expect(codeOf(() => assertBillingCurrency(bad))).toBe('InvalidDeclaration');
    }
  });

  it('is not the ledger’s currency', () => {
    // `LEDGER_CURRENCY` is 'credits' — what the ledger denominates in. This is
    // what the customer is charged in. Conflating them would price a credit at
    // one unit of a currency nobody agreed to.
    expect(codeOf(() => assertBillingCurrency('credits'))).toBe('InvalidDeclaration');
  });
});

// ── The workspace is attribution ────────────────────────────────────────────

describe('the workspace field', () => {
  it('is null by default: the account covers the whole organization', () => {
    expect(account().workspaceId).toBeNull();
  });

  it('is carried when supplied, for reporting', () => {
    expect(account({ workspaceId: WS }).workspaceId).toBe(WS);
  });

  it('refuses an empty string, which is neither a workspace nor absence', () => {
    expect(codeOf(() => account({ workspaceId: '  ' }))).toBe('InvalidDeclaration');
  });

  it('cannot make a second account for one organization', () => {
    // A workspace is never billed. Letting it key a second account would split
    // an agency's single invoice across fifty client workspaces.
    expect(
      codeOf(() => {
        assertOneAccountPerOrganization([account()], account({ workspaceId: WS }));
      }),
    ).toBe('OwnershipMismatch');
  });

  it('says why, so the refusal is actionable', () => {
    let message = '';
    try {
      assertOneAccountPerOrganization([account()], account({ workspaceId: WS }));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('the invoice is singular');
  });
});

describe('assertOneAccountPerOrganization', () => {
  it('admits the first account', () => {
    expect(
      codeOf(() => {
        assertOneAccountPerOrganization([], account());
      }),
    ).toBeNull();
  });

  it('admits an account for a different organization', () => {
    expect(
      codeOf(() => {
        assertOneAccountPerOrganization([account()], account({ organizationId: 'other-org' }));
      }),
    ).toBeNull();
  });

  it('refuses a second account for the same organization', () => {
    expect(
      codeOf(() => {
        assertOneAccountPerOrganization([account()], account({ currency: 'EUR' }));
      }),
    ).toBe('OwnershipMismatch');
  });
});

// ── Ownership ───────────────────────────────────────────────────────────────

describe('assertOwnedBy', () => {
  it('admits a record belonging to the account', () => {
    expect(
      codeOf(() => {
        assertOwnedBy(account(), { organizationId: ORG }, 'Subscription sub-1');
      }),
    ).toBeNull();
  });

  it('refuses one belonging to another organization', () => {
    // The failure it prevents is a subscription's entitlements resolving for a
    // customer who did not buy them.
    expect(
      codeOf(() => {
        assertOwnedBy(account(), { organizationId: 'someone-else' }, 'Subscription sub-1');
      }),
    ).toBe('OwnershipMismatch');
  });

  it('names both the record and the account', () => {
    let message = '';
    try {
      assertOwnedBy(account(), { organizationId: 'someone-else' }, 'Subscription sub-1');
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('Subscription sub-1');
    expect(message).toContain('someone-else');
    expect(message).toContain(ORG);
  });
});

// ── Immutability ────────────────────────────────────────────────────────────

describe('immutability', () => {
  it('freezes an account through', () => {
    const built = account({ providerRef: 'cus_abc' });

    expect(Object.isFrozen(built)).toBe(true);
    expect(() => {
      (built as { status: BillingStatus }).status = 'closed';
    }).toThrow();
  });

  it('defaults the provider reference to null rather than inventing one', () => {
    expect(account().providerRef).toBeNull();
  });

  it('carries a provider reference without interpreting it', () => {
    expect(account({ providerRef: 'cus_abc' }).providerRef).toBe('cus_abc');
  });

  it('is the same account twice', () => {
    expect(account()).toEqual(account());
  });
});
