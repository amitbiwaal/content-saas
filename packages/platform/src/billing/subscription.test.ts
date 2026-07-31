import { describe, expect, it } from 'vitest';

import { BillingError, type BillingErrorCode } from './errors.js';
import { createBillingPeriod, nextPeriod, type BillingPeriod } from './period.js';
import { createPlan, UNSET_RATE_LIMITS, type CommercialPlan } from './plan.js';
import {
  applyTransition,
  assertIdentityUnchanged,
  assertNoLiveConflict,
  assertNotStale,
  assertTransitionAllowed,
  canTransition,
  changePlan,
  createSubscription,
  ENTITLING_SUBSCRIPTION_STATUSES,
  INITIAL_SUBSCRIPTION_STATUS,
  isDueForRenewal,
  isEntitling,
  isSubscriptionStatus,
  isTerminal,
  renew,
  SUBSCRIPTION_STATUSES,
  SUBSCRIPTION_TRANSITION_RULES,
  SUBSCRIPTION_TRANSITIONS,
  TERMINAL_SUBSCRIPTION_STATUS,
  transitionsFrom,
  type Subscription,
  type SubscriptionStatus,
  type SubscriptionTransition,
} from './subscription.js';

const ORG = '018f7a1e-0000-7000-8000-0000000000aa';
const STARTED = '2026-01-01T00:00:00.000Z';
const LATER = '2026-01-15T00:00:00.000Z';

const codeOf = (call: () => unknown): BillingErrorCode | null => {
  try {
    call();
    return null;
  } catch (error) {
    if (error instanceof BillingError) return error.code;
    throw error;
  }
};

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
    createdAt: STARTED,
    ...overrides,
  });

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

/** Walk a subscription to a status by the transitions that reach it. */
const ROUTES: Readonly<Record<SubscriptionStatus, readonly SubscriptionTransition[]>> = {
  trialing: [],
  active: ['activate'],
  past_due: ['activate', 'payment_failed'],
  cancel_pending: ['activate', 'request_cancellation'],
  suspended: ['activate', 'payment_failed', 'dunning_exhausted'],
  expired: ['trial_expired'],
};

const at = (status: SubscriptionStatus): Subscription =>
  ROUTES[status].reduce<Subscription>(
    (current, transition) => applyTransition(current, transition, LATER),
    subscription(),
  );

// ── The vocabulary ──────────────────────────────────────────────────────────

describe('subscription statuses', () => {
  it('are the six the lifecycle diagram names', () => {
    expect(SUBSCRIPTION_STATUSES).toEqual([
      'trialing',
      'active',
      'past_due',
      'cancel_pending',
      'suspended',
      'expired',
    ]);
  });

  it('start at trialing', () => {
    expect(INITIAL_SUBSCRIPTION_STATUS).toBe('trialing');
    expect(subscription().status).toBe('trialing');
  });

  it('reject anything else', () => {
    expect(isSubscriptionStatus('cancelled')).toBe(false);
    expect(isSubscriptionStatus('ACTIVE')).toBe(false);
    expect(isSubscriptionStatus(null)).toBe(false);
  });

  it('entitle in every status but suspended and expired', () => {
    expect(ENTITLING_SUBSCRIPTION_STATUSES).toEqual([
      'trialing',
      'active',
      'past_due',
      'cancel_pending',
    ]);
  });

  it('still entitle while past_due, because dunning is a grace period', () => {
    expect(isEntitling(at('past_due'))).toBe(true);
  });

  it('stop entitling once suspended or expired', () => {
    expect(isEntitling(at('suspended'))).toBe(false);
    expect(isEntitling(at('expired'))).toBe(false);
  });
});

// ── The machine ─────────────────────────────────────────────────────────────

describe('the transition table', () => {
  it('has an entry for every named transition', () => {
    for (const transition of SUBSCRIPTION_TRANSITIONS) {
      expect(SUBSCRIPTION_TRANSITION_RULES[transition]).toBeDefined();
    }
  });

  it('only ever names real statuses', () => {
    for (const transition of SUBSCRIPTION_TRANSITIONS) {
      const rule = SUBSCRIPTION_TRANSITION_RULES[transition];
      expect(isSubscriptionStatus(rule.to)).toBe(true);
      for (const from of rule.from) {
        expect(isSubscriptionStatus(from)).toBe(true);
      }
    }
  });

  it('leaves `expired` terminal by absence, not by a guard', () => {
    for (const transition of SUBSCRIPTION_TRANSITIONS) {
      expect(SUBSCRIPTION_TRANSITION_RULES[transition].from).not.toContain(
        TERMINAL_SUBSCRIPTION_STATUS,
      );
    }
    expect(transitionsFrom('expired')).toEqual([]);
  });

  it('reaches every status from the initial one', () => {
    // A status nothing can reach is a status that will never be right.
    for (const status of SUBSCRIPTION_STATUSES) {
      expect(at(status).status).toBe(status);
    }
  });

  it('transcribes the diagram’s arrows', () => {
    const ARROWS: readonly (readonly [SubscriptionStatus, SubscriptionTransition])[] = [
      ['trialing', 'activate'],
      ['trialing', 'trial_expired'],
      ['active', 'payment_failed'],
      ['past_due', 'payment_recovered'],
      ['past_due', 'dunning_exhausted'],
      ['active', 'request_cancellation'],
      ['cancel_pending', 'revoke_cancellation'],
      ['cancel_pending', 'period_ended'],
      ['suspended', 'payment_recovered'],
      ['suspended', 'close'],
    ];

    for (const [from, transition] of ARROWS) {
      expect(canTransition(from, transition)).toBe(true);
    }
  });

  it('has no arrow the diagram does not', () => {
    expect(canTransition('trialing', 'payment_failed')).toBe(false);
    expect(canTransition('active', 'dunning_exhausted')).toBe(false);
    expect(canTransition('suspended', 'request_cancellation')).toBe(false);
    expect(canTransition('past_due', 'request_cancellation')).toBe(false);
  });

  it('resolves a transition to its target', () => {
    expect(assertTransitionAllowed('trialing', 'activate')).toBe('active');
    expect(assertTransitionAllowed('suspended', 'payment_recovered')).toBe('active');
  });

  it('refuses an illegal transition by name', () => {
    expect(codeOf(() => assertTransitionAllowed('trialing', 'dunning_exhausted'))).toBe(
      'InvalidTransition',
    );
  });

  it('says what IS available when it refuses', () => {
    let message = '';
    try {
      assertTransitionAllowed('trialing', 'payment_failed');
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('activate');
    expect(message).toContain('trial_expired');
  });

  it('says that expired is terminal rather than listing nothing', () => {
    let message = '';
    try {
      assertTransitionAllowed('expired', 'activate');
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('terminal');
  });
});

// ── Creating ────────────────────────────────────────────────────────────────

describe('createSubscription', () => {
  it('starts trialing on the plan it was given', () => {
    const created = subscription();

    expect(created.status).toBe('trialing');
    expect(created.planId).toBe('plan-growth-v1');
    expect(created.version).toBe(1);
  });

  it('has no workspace anywhere on it', () => {
    // "A workspace is never billed."
    expect(Object.keys(subscription())).not.toContain('workspaceId');
  });

  it('computes its first period from the cycle', () => {
    expect(subscription().currentPeriod.start).toBe(STARTED);
    expect(subscription().currentPeriod.end).toBe('2026-02-01T00:00:00.000Z');
    expect(subscription({ cycle: 'annual' }).currentPeriod.end).toBe('2027-01-01T00:00:00.000Z');
  });

  it('renews at its period end', () => {
    expect(subscription().renewsAt).toBe(subscription().currentPeriod.end);
  });

  it('is not cancelled', () => {
    expect(subscription().cancelledAt).toBeNull();
  });

  it('refuses a retired plan', () => {
    expect(codeOf(() => subscription({ plan: plan({ status: 'retired' }) }))).toBe(
      'IncompatiblePlan',
    );
  });

  it('refuses a missing id, organization or start', () => {
    expect(codeOf(() => subscription({ subscriptionId: '' }))).toBe('InvalidDeclaration');
    expect(codeOf(() => subscription({ organizationId: '  ' }))).toBe('InvalidDeclaration');
    expect(codeOf(() => subscription({ startedAt: '' }))).toBe('InvalidDeclaration');
  });

  it('refuses an invalid cycle', () => {
    expect(codeOf(() => subscription({ cycle: 'weekly' as 'monthly' }))).toBe(
      'InvalidBillingCycle',
    );
  });

  it('is frozen through', () => {
    const created = subscription();

    expect(Object.isFrozen(created)).toBe(true);
    expect(Object.isFrozen(created.currentPeriod)).toBe(true);
    expect(() => {
      (created as { status: SubscriptionStatus }).status = 'active';
    }).toThrow();
  });
});

// ── Transitioning ───────────────────────────────────────────────────────────

describe('applyTransition', () => {
  it('returns a new subscription and leaves the old one alone', () => {
    const before = subscription();
    const after = applyTransition(before, 'activate', LATER);

    expect(before.status).toBe('trialing');
    expect(after.status).toBe('active');
    expect(after).not.toBe(before);
  });

  it('advances the version, so two states can be ordered', () => {
    expect(applyTransition(subscription(), 'activate', LATER).version).toBe(2);
  });

  it('stamps the instant it was given', () => {
    expect(applyTransition(subscription(), 'activate', LATER).updatedAt).toBe(LATER);
  });

  it('requires an instant', () => {
    expect(codeOf(() => applyTransition(subscription(), 'activate', ''))).toBe(
      'InvalidDeclaration',
    );
  });

  it('records when cancellation was REQUESTED, not when it takes effect', () => {
    // Cancel at period end: the customer keeps what they paid for.
    const cancelled = applyTransition(at('active'), 'request_cancellation', LATER);

    expect(cancelled.cancelledAt).toBe(LATER);
    expect(cancelled.status).toBe('cancel_pending');
    expect(cancelled.renewsAt).toBe(cancelled.currentPeriod.end);
  });

  it('clears the cancellation when it is revoked', () => {
    // Otherwise a revoked cancellation would still expire the subscription.
    const revoked = applyTransition(at('cancel_pending'), 'revoke_cancellation', LATER);

    expect(revoked.cancelledAt).toBeNull();
    expect(revoked.status).toBe('active');
  });

  it('stops renewing once terminal', () => {
    expect(applyTransition(at('cancel_pending'), 'period_ended', LATER).renewsAt).toBeNull();
    expect(applyTransition(subscription(), 'trial_expired', LATER).renewsAt).toBeNull();
  });

  it('refuses an illegal transition', () => {
    expect(codeOf(() => applyTransition(subscription(), 'payment_failed', LATER))).toBe(
      'InvalidTransition',
    );
  });

  it('refuses to move a terminal subscription', () => {
    expect(codeOf(() => applyTransition(at('expired'), 'activate', LATER))).toBe(
      'InvalidTransition',
    );
  });

  it('recovers a suspended subscription straight to active', () => {
    expect(applyTransition(at('suspended'), 'payment_recovered', LATER).status).toBe('active');
  });

  it('keeps the identifiers across every transition', () => {
    for (const status of SUBSCRIPTION_STATUSES) {
      const moved = at(status);
      expect(moved.subscriptionId).toBe('sub-1');
      expect(moved.organizationId).toBe(ORG);
      expect(moved.startedAt).toBe(STARTED);
    }
  });

  it('never transitions an organization', () => {
    // "Billing never suspends anything itself."
    const suspended = at('suspended');
    expect(Object.keys(suspended)).not.toContain('organizationStatus');
  });
});

// ── Renewing ────────────────────────────────────────────────────────────────

describe('renew', () => {
  const next = (subject: Subscription): BillingPeriod => nextPeriod(subject.currentPeriod);

  it('rolls into the next period without changing status', () => {
    const active = at('active');
    const renewed = renew(active, next(active), '2026-02-01T00:00:00.000Z');

    expect(renewed.status).toBe('active');
    expect(renewed.currentPeriod.start).toBe('2026-02-01T00:00:00.000Z');
    expect(renewed.renewsAt).toBe('2026-03-01T00:00:00.000Z');
    expect(renewed.version).toBe(active.version + 1);
  });

  it('refuses a period that leaves a gap', () => {
    const active = at('active');
    const gapped = createBillingPeriod({
      start: '2026-02-02T00:00:00.000Z',
      end: '2026-03-02T00:00:00.000Z',
      cycle: 'monthly',
    });

    expect(codeOf(() => renew(active, gapped, LATER))).toBe('InvalidBillingPeriod');
  });

  it('refuses a period that overlaps the current one', () => {
    const active = at('active');
    const overlapping = createBillingPeriod({
      start: '2026-01-15T00:00:00.000Z',
      end: '2026-02-15T00:00:00.000Z',
      cycle: 'monthly',
    });

    expect(codeOf(() => renew(active, overlapping, LATER))).toBe('InvalidBillingPeriod');
  });

  it('refuses to renew an expired subscription', () => {
    const expired = at('expired');
    expect(codeOf(() => renew(expired, next(expired), LATER))).toBe('InvalidTransition');
  });

  it('refuses to renew a cancelled one', () => {
    // Renewing would bill a customer who asked to stop.
    const cancelled = at('cancel_pending');
    expect(codeOf(() => renew(cancelled, next(cancelled), LATER))).toBe('InvalidTransition');
  });

  it('renews a past_due subscription, which is still entitled', () => {
    const pastDue = at('past_due');
    expect(renew(pastDue, next(pastDue), LATER).status).toBe('past_due');
  });

  it('is due for renewal only once the period has elapsed', () => {
    const active = at('active');

    expect(isDueForRenewal(active, '2026-01-15T00:00:00.000Z')).toBe(false);
    expect(isDueForRenewal(active, '2026-02-01T00:00:00.000Z')).toBe(true);
  });

  it('is never due once terminal', () => {
    expect(isDueForRenewal(at('expired'), '2099-01-01T00:00:00.000Z')).toBe(false);
  });
});

// ── Changing plan ───────────────────────────────────────────────────────────

describe('changePlan', () => {
  it('moves a subscription to another plan', () => {
    const upgraded = changePlan(
      at('active'),
      plan({ planId: 'plan-enterprise-v1', code: 'enterprise' }),
      LATER,
    );

    expect(upgraded.planId).toBe('plan-enterprise-v1');
    expect(upgraded.status).toBe('active');
    expect(upgraded.version).toBe(at('active').version + 1);
  });

  it('refuses a retired plan', () => {
    expect(
      codeOf(() => changePlan(at('active'), plan({ planId: 'p2', status: 'retired' }), LATER)),
    ).toBe('IncompatiblePlan');
  });

  it('refuses a change to the plan it is already on', () => {
    expect(codeOf(() => changePlan(at('active'), plan(), LATER))).toBe('IncompatiblePlan');
  });

  it('refuses to change the plan of an expired subscription', () => {
    expect(codeOf(() => changePlan(at('expired'), plan({ planId: 'p2' }), LATER))).toBe(
      'InvalidTransition',
    );
  });

  it('changes nothing about the organization', () => {
    // A downgrade putting an organization over quota is Organizations'
    // decision, reached through the event.
    const downgraded = changePlan(at('active'), plan({ planId: 'p2', code: 'starter' }), LATER);
    expect(downgraded.organizationId).toBe(ORG);
  });
});

// ── Immutable identifiers ───────────────────────────────────────────────────

describe('assertIdentityUnchanged', () => {
  it('admits a subscription whose identifiers held', () => {
    expect(
      codeOf(() => {
        assertIdentityUnchanged(subscription(), applyTransition(subscription(), 'activate', LATER));
      }),
    ).toBeNull();
  });

  it('refuses a changed id', () => {
    expect(
      codeOf(() => {
        assertIdentityUnchanged(subscription(), subscription({ subscriptionId: 'sub-2' }));
      }),
    ).toBe('ImmutableFieldChanged');
  });

  it('refuses a changed organization', () => {
    // It would move a customer's commercial history to another account.
    expect(
      codeOf(() => {
        assertIdentityUnchanged(subscription(), subscription({ organizationId: 'other' }));
      }),
    ).toBe('ImmutableFieldChanged');
  });

  it('refuses a changed start, which is a historical fact', () => {
    expect(
      codeOf(() => {
        assertIdentityUnchanged(
          subscription(),
          subscription({ startedAt: '2025-01-01T00:00:00.000Z' }),
        );
      }),
    ).toBe('ImmutableFieldChanged');
  });

  it('permits a changed plan, which is what an upgrade is', () => {
    expect(
      codeOf(() => {
        assertIdentityUnchanged(
          at('active'),
          changePlan(at('active'), plan({ planId: 'p2' }), LATER),
        );
      }),
    ).toBeNull();
  });
});

describe('assertNotStale', () => {
  it('admits a newer version', () => {
    expect(
      codeOf(() => {
        assertNotStale(subscription(), applyTransition(subscription(), 'activate', LATER));
      }),
    ).toBeNull();
  });

  it('refuses an equal version', () => {
    expect(
      codeOf(() => {
        assertNotStale(subscription(), subscription());
      }),
    ).toBe('StaleVersion');
  });

  it('refuses an older one, because delivery is not ordered', () => {
    const newer = applyTransition(subscription(), 'activate', LATER);
    expect(
      codeOf(() => {
        assertNotStale(newer, subscription());
      }),
    ).toBe('StaleVersion');
  });

  it('checks identity before version', () => {
    expect(
      codeOf(() => {
        assertNotStale(subscription(), subscription({ organizationId: 'other' }));
      }),
    ).toBe('ImmutableFieldChanged');
  });
});

// ── One organization, one subscription ──────────────────────────────────────

describe('assertNoLiveConflict', () => {
  it('admits the first subscription', () => {
    expect(
      codeOf(() => {
        assertNoLiveConflict([], subscription());
      }),
    ).toBeNull();
  });

  it('refuses a reused subscription id', () => {
    expect(
      codeOf(() => {
        assertNoLiveConflict([subscription()], subscription({ organizationId: 'other' }));
      }),
    ).toBe('DuplicateSubscription');
  });

  it('refuses a second live subscription for one organization', () => {
    // `UNIQUE (organization_id) WHERE status <> 'expired'`.
    expect(
      codeOf(() => {
        assertNoLiveConflict([at('active')], subscription({ subscriptionId: 'sub-2' }));
      }),
    ).toBe('SubscriptionConflict');
  });

  it('refuses one even while the existing subscription is only past_due', () => {
    expect(
      codeOf(() => {
        assertNoLiveConflict([at('past_due')], subscription({ subscriptionId: 'sub-2' }));
      }),
    ).toBe('SubscriptionConflict');
  });

  it('admits a replacement once the previous one expired', () => {
    expect(
      codeOf(() => {
        assertNoLiveConflict([at('expired')], subscription({ subscriptionId: 'sub-2' }));
      }),
    ).toBeNull();
  });

  it('admits a subscription for a different organization', () => {
    expect(
      codeOf(() => {
        assertNoLiveConflict(
          [at('active')],
          subscription({ subscriptionId: 'sub-2', organizationId: 'other' }),
        );
      }),
    ).toBeNull();
  });

  it('says which subscription is in the way', () => {
    let message = '';
    try {
      assertNoLiveConflict([at('active')], subscription({ subscriptionId: 'sub-2' }));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('sub-1');
    expect(message).toContain('active');
  });
});

describe('isTerminal', () => {
  it('is true only for expired', () => {
    for (const status of SUBSCRIPTION_STATUSES) {
      expect(isTerminal(at(status))).toBe(status === 'expired');
    }
  });
});
