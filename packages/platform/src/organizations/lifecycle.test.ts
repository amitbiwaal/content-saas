/**
 * Organization lifecycle — the pure state machine.
 *
 * These assertions are transcribed from the diagram in
 * `02-domain-design/organizations.md` §Lifecycle. Where a test looks redundant
 * it is pinning an arrow that exists in that diagram; the value is that
 * deleting an arrow from the code fails here rather than in production.
 */
import { describe, expect, it } from 'vitest';

import {
  assertTransitionAllowed,
  canTransition,
  CLOSURE_WINDOW_DAYS,
  INITIAL_STATUS,
  isOrganizationStatus,
  ORGANIZATION_STATUSES,
  ORGANIZATION_TRANSITIONS,
  OrganizationError,
  resolveTarget,
  restoresPreviousStatus,
  TRANSITION_RULES,
  transitionsFrom,
  type OrganizationStatus,
  type OrganizationTransition,
} from './lifecycle.js';

describe('organization statuses', () => {
  // The CHECK constraint in migration 0003 is the other half of this contract.
  // A status here that the database refuses is a row nothing can write.
  it('are exactly the five the database CHECK constraint allows', () => {
    expect([...ORGANIZATION_STATUSES]).toEqual([
      'active',
      'past_due',
      'suspended',
      'pending_closure',
      'closed',
    ]);
  });

  it('recognises its own members and nothing else', () => {
    for (const status of ORGANIZATION_STATUSES) {
      expect(isOrganizationStatus(status)).toBe(true);
    }
    expect(isOrganizationStatus('archived')).toBe(false);
    expect(isOrganizationStatus('')).toBe(false);
    expect(isOrganizationStatus('ACTIVE')).toBe(false);
  });

  it('provisions into active', () => {
    expect(INITIAL_STATUS).toBe('active');
  });

  it('opens a 30-day closure window', () => {
    expect(CLOSURE_WINDOW_DAYS).toBe(30);
  });
});

describe('lifecycle transitions — the canonical diagram', () => {
  const ARROWS: readonly (readonly [OrganizationStatus, OrganizationTransition])[] = [
    ['active', 'payment_failed'],
    ['past_due', 'payment_recovered'],
    ['active', 'suspend'],
    ['past_due', 'suspend'],
    ['suspended', 'reactivate'],
    ['active', 'request_closure'],
    ['past_due', 'request_closure'],
    ['suspended', 'request_closure'],
    ['pending_closure', 'cancel_closure'],
    ['pending_closure', 'close'],
  ];

  for (const [from, transition] of ARROWS) {
    it(`permits '${transition}' from '${from}'`, () => {
      expect(canTransition(from, transition)).toBe(true);
      expect(() => {
        assertTransitionAllowed(from, transition);
      }).not.toThrow();
    });
  }

  it('lands each fixed transition on its documented status', () => {
    expect(resolveTarget('payment_failed')).toBe('past_due');
    expect(resolveTarget('payment_recovered')).toBe('active');
    expect(resolveTarget('suspend')).toBe('suspended');
    expect(resolveTarget('request_closure')).toBe('pending_closure');
    expect(resolveTarget('close')).toBe('closed');
  });
});

describe('lifecycle transitions — what is refused', () => {
  it('refuses a transition from a status the diagram has no arrow for', () => {
    expect(canTransition('closed', 'reactivate')).toBe(false);
    expect(canTransition('active', 'close')).toBe(false);
    expect(canTransition('active', 'reactivate')).toBe(false);
    expect(canTransition('suspended', 'payment_recovered')).toBe(false);
    expect(canTransition('pending_closure', 'suspend')).toBe(false);
  });

  it('throws a typed InvalidTransition naming the permitted origins', () => {
    let caught: unknown;
    try {
      assertTransitionAllowed('closed', 'reactivate');
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(OrganizationError);
    expect((caught as OrganizationError).code).toBe('InvalidTransition');
    expect((caught as OrganizationError).message).toContain('suspended');
  });

  // Terminality is expressed by `closed` appearing in no `from` list, so that
  // no call site has to remember a guard.
  it('makes closed terminal — no transition leaves it', () => {
    expect(transitionsFrom('closed')).toEqual([]);
    for (const transition of ORGANIZATION_TRANSITIONS) {
      expect(TRANSITION_RULES[transition].from).not.toContain('closed');
    }
  });

  it('reports the transitions available from every other status', () => {
    expect(transitionsFrom('active')).toEqual(['payment_failed', 'suspend', 'request_closure']);
    expect(transitionsFrom('past_due')).toEqual([
      'payment_recovered',
      'suspend',
      'request_closure',
    ]);
    expect(transitionsFrom('suspended')).toEqual(['reactivate', 'request_closure']);
    expect(transitionsFrom('pending_closure')).toEqual(['cancel_closure', 'close']);
  });
});

describe('reactivation restores the previous recorded state', () => {
  it('identifies which transitions restore rather than fix a status', () => {
    expect(restoresPreviousStatus('reactivate')).toBe(true);
    expect(restoresPreviousStatus('cancel_closure')).toBe(true);
    expect(restoresPreviousStatus('suspend')).toBe(false);
    expect(restoresPreviousStatus('close')).toBe(false);
  });

  // The rule that makes this more than cosmetic: an organization suspended
  // while already past_due still owes money when the suspension lifts.
  it('returns a suspended organization to past_due when that is what it was', () => {
    expect(resolveTarget('reactivate', 'past_due')).toBe('past_due');
  });

  it('returns it to active when that is what it was', () => {
    expect(resolveTarget('reactivate', 'active')).toBe('active');
  });

  it('falls back to active when nothing was recorded', () => {
    expect(resolveTarget('reactivate', null)).toBe('active');
    expect(resolveTarget('reactivate')).toBe('active');
  });

  // A recorded value outside the permitted set is corrupt, hand-edited, or
  // written by an older revision. It is not trusted into a nonsensical state.
  it('refuses to restore a status the transition cannot produce', () => {
    expect(resolveTarget('reactivate', 'closed')).toBe('active');
    expect(resolveTarget('reactivate', 'suspended')).toBe('active');
    expect(resolveTarget('reactivate', 'pending_closure')).toBe('active');
    expect(resolveTarget('reactivate', 'not-a-status')).toBe('active');
    expect(resolveTarget('reactivate', '')).toBe('active');
  });

  // Cancelling a closure must not quietly lift a suspension that was in force
  // when closure was requested.
  it('returns a cancelled closure to the status that preceded the request', () => {
    expect(resolveTarget('cancel_closure', 'suspended')).toBe('suspended');
    expect(resolveTarget('cancel_closure', 'past_due')).toBe('past_due');
    expect(resolveTarget('cancel_closure', 'active')).toBe('active');
    expect(resolveTarget('cancel_closure', null)).toBe('active');
  });

  it('ignores a recorded status on a transition that does not restore', () => {
    expect(resolveTarget('suspend', 'active')).toBe('suspended');
    expect(resolveTarget('close', 'past_due')).toBe('closed');
  });
});

describe('state machine integrity', () => {
  it('declares every transition with at least one origin', () => {
    for (const transition of ORGANIZATION_TRANSITIONS) {
      expect(TRANSITION_RULES[transition].from.length).toBeGreaterThan(0);
    }
  });

  it('names only known statuses in every rule', () => {
    for (const transition of ORGANIZATION_TRANSITIONS) {
      const rule = TRANSITION_RULES[transition];
      for (const from of rule.from) {
        expect(isOrganizationStatus(from)).toBe(true);
      }
      if (rule.target.kind === 'fixed') {
        expect(isOrganizationStatus(rule.target.status)).toBe(true);
      } else {
        expect(rule.target.permitted.length).toBeGreaterThan(0);
        expect(rule.target.permitted).toContain(rule.target.fallback);
      }
    }
  });

  // Every status except the terminal one must be reachable and escapable,
  // or it is a trap the diagram does not describe.
  it('leaves no non-terminal status without an exit', () => {
    for (const status of ORGANIZATION_STATUSES) {
      if (status === 'closed') continue;
      expect(transitionsFrom(status).length).toBeGreaterThan(0);
    }
  });
});
