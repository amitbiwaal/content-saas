import { describe, expect, it } from 'vitest';

import { LEDGER_CURRENCY, type LedgerBalance } from './aggregate.js';
import {
  assertSufficient,
  calculateAvailability,
  hasSufficient,
  reservedAmount,
} from './availability.js';
import { formatAmount } from './amount.js';
import { HoldError, InsufficientCreditsError, type CreditHold } from './holds.js';
import { toCreditReservation, type CreditReservation } from './reservation.js';

const ORG = '018f7a1e-0000-7000-8000-0000000000aa';
const OTHER = '018f7a1e-0000-7000-8000-0000000000cc';
const WS = '018f7a1e-0000-7000-8000-0000000000bb';
const AT = '2026-07-31T12:00:00.000Z';

const ledgerBalance = (balance: string, organizationId = ORG): LedgerBalance =>
  Object.freeze({
    organizationId,
    currency: LEDGER_CURRENCY,
    credited: balance,
    debited: '0.000000',
    balance,
    entryCount: 1,
    transactionCount: 1,
  });

const reservation = (
  id: string,
  amount: string,
  overrides: Partial<CreditHold> = {},
): CreditReservation =>
  toCreditReservation({
    id,
    tenantId: ORG,
    organizationId: ORG,
    workspaceId: WS,
    runId: `run-${id}`,
    amount,
    consumed: '0.000000',
    state: 'held',
    expiresAt: '2026-08-01T12:00:00.000Z',
    reason: 'a run',
    correlationId: '018f7a1e-0000-7000-8000-0000000000dd',
    createdBy: null,
    metadata: {},
    createdAt: AT,
    settledAt: null,
    releasedAt: null,
    ...overrides,
  });

// ── The formula ─────────────────────────────────────────────────────────────

describe('available = balance − active reservations', () => {
  it('is the balance when nothing is reserved', () => {
    expect(
      calculateAvailability({ balance: ledgerBalance('100.000000'), reservations: [] }),
    ).toEqual({
      organizationId: ORG,
      currency: LEDGER_CURRENCY,
      balance: '100.000000',
      reserved: '0.000000',
      available: '100.000000',
      activeReservations: 0,
    });
  });

  it('subtracts every active reservation', () => {
    const availability = calculateAvailability({
      balance: ledgerBalance('100.000000'),
      reservations: [reservation('a', '30.000000'), reservation('b', '20.000000')],
    });

    expect(availability.reserved).toBe('50.000000');
    expect(availability.available).toBe('50.000000');
    expect(availability.activeReservations).toBe(2);
  });

  it('subtracts only what is UNSPENT', () => {
    // What has been spent is already a ledger debit; subtracting the whole
    // reservation on top of that would take the same credits twice.
    const availability = calculateAvailability({
      balance: ledgerBalance('90.000000'),
      reservations: [reservation('a', '30.000000', { consumed: '10.000000' })],
    });

    expect(availability.reserved).toBe('20.000000');
    expect(availability.available).toBe('70.000000');
  });

  it('subtracts nothing for a closed reservation', () => {
    // One that has been released, expired or consumed has already stopped
    // holding credits down.
    for (const state of ['settled', 'released', 'expired'] as const) {
      const availability = calculateAvailability({
        balance: ledgerBalance('100.000000'),
        reservations: [reservation('a', '30.000000', { state })],
      });

      expect(availability.reserved).toBe('0.000000');
      expect(availability.available).toBe('100.000000');
      expect(availability.activeReservations).toBe(0);
    }
  });

  it('can go negative when a correction landed after a reservation', () => {
    const availability = calculateAvailability({
      balance: ledgerBalance('10.000000'),
      reservations: [reservation('a', '30.000000')],
    });

    expect(availability.available).toBe('-20.000000');
  });

  it('reads a negative balance the ledger produced', () => {
    expect(
      calculateAvailability({ balance: ledgerBalance('-5.000000'), reservations: [] }).available,
    ).toBe('-5.000000');
  });

  it('is exact where a float would not be', () => {
    const availability = calculateAvailability({
      balance: ledgerBalance('0.300000'),
      reservations: [reservation('a', '0.100000'), reservation('b', '0.200000')],
    });

    expect(availability.available).toBe('0.000000');
  });

  it('ignores another organization’s reservations', () => {
    // Which would be one customer's runs holding down another's balance.
    const foreign = reservation('a', '50.000000', { organizationId: OTHER });
    const availability = calculateAvailability({
      balance: ledgerBalance('100.000000'),
      reservations: [foreign],
    });

    expect(availability.reserved).toBe('0.000000');
    expect(availability.available).toBe('100.000000');
  });
});

describe('the balance comes from the ledger, never from reservations', () => {
  it('carries the ledger figure through untouched', () => {
    const availability = calculateAvailability({
      balance: ledgerBalance('42.500000'),
      reservations: [reservation('a', '10.000000')],
    });

    expect(availability.balance).toBe('42.500000');
  });

  it('reports balance and reserved separately, not just the difference', () => {
    // "Out of credits" and "all credits committed to runs in flight" call for
    // opposite actions.
    const availability = calculateAvailability({
      balance: ledgerBalance('100.000000'),
      reservations: [reservation('a', '100.000000')],
    });

    expect(availability.balance).toBe('100.000000');
    expect(availability.reserved).toBe('100.000000');
    expect(availability.available).toBe('0.000000');
  });

  it('is credits, and only credits', () => {
    expect(
      calculateAvailability({ balance: ledgerBalance('1.000000'), reservations: [] }).currency,
    ).toBe('credits');
  });
});

describe('determinism', () => {
  const balance = ledgerBalance('100.000000');
  const reservations = [
    reservation('a', '10.000000'),
    reservation('b', '20.000000'),
    reservation('c', '5.000000'),
  ];

  it('gives the same answer twice', () => {
    expect(calculateAvailability({ balance, reservations })).toEqual(
      calculateAvailability({ balance, reservations }),
    );
  });

  it('does not depend on the order the reservations arrived in', () => {
    expect(calculateAvailability({ balance, reservations: [...reservations].reverse() })).toEqual(
      calculateAvailability({ balance, reservations }),
    );
  });

  it('freezes what it returns', () => {
    const availability = calculateAvailability({ balance, reservations });

    expect(Object.isFrozen(availability)).toBe(true);
    expect(() => {
      (availability as { available: string }).available = '999.000000';
    }).toThrow();
  });
});

describe('the reserved total on its own', () => {
  it('sums the unspent part of the active reservations', () => {
    expect(
      formatAmount(
        reservedAmount([
          reservation('a', '10.000000'),
          reservation('b', '5.000000', { consumed: '2.000000' }),
          reservation('c', '100.000000', { state: 'released' }),
        ]),
      ),
    ).toBe('13.000000');
  });

  it('is zero for no reservations at all', () => {
    expect(formatAmount(reservedAmount([]))).toBe('0.000000');
  });
});

// ── Admission ───────────────────────────────────────────────────────────────

describe('deciding whether a new reservation fits', () => {
  const availability = calculateAvailability({
    balance: ledgerBalance('100.000000'),
    reservations: [reservation('a', '60.000000')],
  });

  it('admits a request the remainder covers', () => {
    expect(hasSufficient(availability, '40.000000')).toBe(true);
    expect(hasSufficient(availability, '10.000000')).toBe(true);
  });

  it('admits a request that exactly exhausts the remainder', () => {
    expect(hasSufficient(availability, '40.000000')).toBe(true);
  });

  it('refuses one a single credit beyond it', () => {
    expect(hasSufficient(availability, '40.000001')).toBe(false);
  });

  it('refuses when everything is already committed', () => {
    const committed = calculateAvailability({
      balance: ledgerBalance('100.000000'),
      reservations: [reservation('a', '100.000000')],
    });

    expect(hasSufficient(committed, '0.000001')).toBe(false);
    expect(hasSufficient(committed, '0')).toBe(true);
  });

  it('refuses anything at all when available is negative', () => {
    const overdrawn = calculateAvailability({
      balance: ledgerBalance('-1.000000'),
      reservations: [],
    });

    expect(hasSufficient(overdrawn, '0.000001')).toBe(false);
  });
});

describe('refusing an insufficient reservation', () => {
  const availability = calculateAvailability({
    balance: ledgerBalance('100.000000'),
    reservations: [reservation('a', '60.000000')],
  });

  it('accepts one it can cover', () => {
    expect(() => {
      assertSufficient(availability, '40.000000');
    }).not.toThrow();
  });

  it('throws the FROZEN insufficient-credits error', () => {
    // Which already carries the three figures a caller needs and already says
    // no provider call was made.
    expect(() => {
      assertSufficient(availability, '50.000000');
    }).toThrow(InsufficientCreditsError);
  });

  it('is a HoldError, so one catch learns one fact', () => {
    try {
      assertSufficient(availability, '50.000000');
      throw new Error('expected a refusal');
    } catch (failure) {
      expect(failure).toBeInstanceOf(HoldError);
      if (!(failure instanceof InsufficientCreditsError)) return;
      expect(failure.code).toBe('InsufficientCredits');
    }
  });

  it('names what was available, what was needed and the shortfall', () => {
    try {
      assertSufficient(availability, '50.000000');
      throw new Error('expected a refusal');
    } catch (failure) {
      if (!(failure instanceof InsufficientCreditsError)) throw failure;
      expect(failure.available).toBe('40.000000');
      expect(failure.required).toBe('50.000000');
      expect(failure.shortfall).toBe('10.000000');
    }
  });

  it('says no provider call was made', () => {
    // The whole point of checking before execution rather than after.
    try {
      assertSufficient(availability, '50.000000');
      throw new Error('expected a refusal');
    } catch (failure) {
      if (!(failure instanceof InsufficientCreditsError)) throw failure;
      expect(failure.message).toMatch(/No provider call was made/);
    }
  });

  it('computes the shortfall exactly, even from a negative balance', () => {
    const overdrawn = calculateAvailability({
      balance: ledgerBalance('-5.000000'),
      reservations: [],
    });

    try {
      assertSufficient(overdrawn, '10.000000');
      throw new Error('expected a refusal');
    } catch (failure) {
      if (!(failure instanceof InsufficientCreditsError)) throw failure;
      expect(failure.shortfall).toBe('15.000000');
    }
  });
});
