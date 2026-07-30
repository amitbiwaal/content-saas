/**
 * The hold model.
 *
 * The state machine and the reservation bound, without a database.
 */
import { describe, expect, it } from 'vitest';

import { formatAmount, parseAmount } from './amount.js';
import {
  assertFitsWithinHold,
  DEFAULT_HOLD_TTL_MS,
  HOLD_STATES,
  HoldError,
  InsufficientCreditsError,
  isHoldState,
  isTerminal,
  OPEN_HOLD_STATE,
  remainingOf,
  stateFor,
  TERMINAL_HOLD_STATES,
  type CreditHold,
  type HoldState,
} from './holds.js';

/** The four, written out independently of the module. */
const CANONICAL_STATES = ['held', 'settled', 'released', 'expired'];

function hold(over: Partial<CreditHold> = {}): CreditHold {
  return {
    id: '018f7a1e-0000-7000-7001-000000000001',
    tenantId: '018f7a1e-0000-7000-8000-0000000000aa',
    organizationId: '018f7a1e-0000-7000-8000-0000000000aa',
    workspaceId: '018f7a1e-0000-7000-8000-0000000000bb',
    runId: 'run-1',
    amount: '20.000000',
    consumed: '0.000000',
    state: 'held',
    expiresAt: '2026-07-31T12:00:00.000Z',
    reason: 'Pipeline.',
    correlationId: '018f7a1e-0000-7000-8000-0000000000dd',
    createdBy: null,
    metadata: {},
    createdAt: '2026-07-30T12:00:00.000Z',
    settledAt: null,
    releasedAt: null,
    ...over,
  };
}

describe('the state machine', () => {
  it('has exactly the four documented states', () => {
    expect([...HOLD_STATES].sort()).toEqual([...CANONICAL_STATES].sort());
  });

  it('recognises them and nothing else', () => {
    for (const state of CANONICAL_STATES) expect(isHoldState(state), state).toBe(true);
    for (const state of ['open', 'HELD', 'pending', '']) {
      expect(isHoldState(state), state).toBe(false);
    }
  });

  it('names one open state and three terminal ones', () => {
    expect(OPEN_HOLD_STATE).toBe('held');
    expect([...TERMINAL_HOLD_STATES].sort()).toEqual(['expired', 'released', 'settled']);
    expect(isTerminal('held')).toBe(false);
    for (const state of TERMINAL_HOLD_STATES) expect(isTerminal(state), state).toBe(true);
  });

  it('maps each closure to its state', () => {
    const closures: HoldState[] = ['settled', 'released', 'expired'];
    for (const closure of closures) {
      expect(stateFor(closure as 'settled' | 'released' | 'expired')).toBe(closure);
    }
  });

  // Longer than the p99 pipeline; short enough that a crashed orchestrator does
  // not hold a customer's balance down indefinitely.
  it('defaults the TTL to 24 hours', () => {
    expect(DEFAULT_HOLD_TTL_MS).toBe(86_400_000);
  });
});

describe('what a hold still reserves', () => {
  it('is the whole amount before anything is spent', () => {
    expect(formatAmount(remainingOf(hold()))).toBe('20.000000');
  });

  it('shrinks as consumption is recorded', () => {
    expect(formatAmount(remainingOf(hold({ consumed: '7.500000' })))).toBe('12.500000');
  });

  it('is zero once the hold closes, whatever it had left', () => {
    for (const state of ['settled', 'released', 'expired'] as const) {
      expect(formatAmount(remainingOf(hold({ state, consumed: '5.000000' }))), state).toBe(
        '0.000000',
      );
    }
  });
});

describe('the reservation is a bound on spend', () => {
  it('admits a charge inside it', () => {
    expect(() => {
      assertFitsWithinHold(hold(), parseAmount('20'));
    }).not.toThrow();
  });

  it('refuses one micro-credit past it', () => {
    expect(() => {
      assertFitsWithinHold(hold(), parseAmount('20.000001'));
    }).toThrow(/exceed its reservation/);
  });

  it('accounts for what is already consumed', () => {
    const partial = hold({ consumed: '18.000000' });
    expect(() => {
      assertFitsWithinHold(partial, parseAmount('2'));
    }).not.toThrow();
    expect(() => {
      assertFitsWithinHold(partial, parseAmount('2.000001'));
    }).toThrow(HoldError);
  });

  it('names the hold, the reservation and what is already spent', () => {
    try {
      assertFitsWithinHold(hold({ consumed: '18.000000' }), parseAmount('5'));
      expect.unreachable('must refuse');
    } catch (error) {
      const e = error as HoldError;
      expect(e.code).toBe('HoldExceeded');
      expect(e.message).toContain('20.000000');
      expect(e.message).toContain('18.000000');
      expect(e.message).toContain('5.000000');
    }
  });

  it('refuses any charge against a closed hold', () => {
    for (const state of ['settled', 'released', 'expired'] as const) {
      expect(() => {
        assertFitsWithinHold(hold({ state }), parseAmount('1'));
      }, state).toThrow(/can only be recorded against an open hold/);
    }
  });
});

describe('the insufficiency refusal', () => {
  // Refused BEFORE any provider call — this is what becomes the 402.
  it('reports available, required and shortfall', () => {
    const error = new InsufficientCreditsError('5.000000', '20.000000', '15.000000');
    expect(error.code).toBe('InsufficientCredits');
    expect(error.available).toBe('5.000000');
    expect(error.required).toBe('20.000000');
    expect(error.shortfall).toBe('15.000000');
  });

  it('says plainly that nothing was spent', () => {
    const error = new InsufficientCreditsError('0.000000', '1.000000', '1.000000');
    expect(error.message).toContain('No provider call was made');
  });

  it('is a HoldError, so one catch covers the protocol', () => {
    expect(new InsufficientCreditsError('0', '1', '1')).toBeInstanceOf(HoldError);
  });
});
