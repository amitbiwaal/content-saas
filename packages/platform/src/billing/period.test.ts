import { describe, expect, it } from 'vitest';

import { BillingError, type BillingErrorCode } from './errors.js';
import {
  advanceTo,
  assertBillingCycle,
  BILLING_CYCLES,
  createBillingPeriod,
  firstPeriod,
  hasPeriodElapsed,
  isBillingCycle,
  MONTHS_PER_CYCLE,
  nextPeriod,
  periodContains,
} from './period.js';

const codeOf = (call: () => unknown): BillingErrorCode | null => {
  try {
    call();
    return null;
  } catch (error) {
    if (error instanceof BillingError) return error.code;
    throw error;
  }
};

describe('billing cycles', () => {
  it('are the two the arithmetic knows', () => {
    expect(BILLING_CYCLES).toEqual(['monthly', 'annual']);
  });

  it('advance the period by the months they name', () => {
    expect(MONTHS_PER_CYCLE.monthly).toBe(1);
    expect(MONTHS_PER_CYCLE.annual).toBe(12);
  });

  it('reject anything else', () => {
    expect(isBillingCycle('weekly')).toBe(false);
    expect(isBillingCycle('MONTHLY')).toBe(false);
    expect(isBillingCycle(null)).toBe(false);
    expect(codeOf(() => assertBillingCycle('weekly'))).toBe('InvalidBillingCycle');
  });

  it('name the ones that are available when they refuse', () => {
    let message = '';
    try {
      assertBillingCycle('quarterly');
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('monthly, annual');
  });
});

describe('createBillingPeriod', () => {
  it('accepts a real interval', () => {
    const period = createBillingPeriod({
      start: '2026-01-01T00:00:00.000Z',
      end: '2026-02-01T00:00:00.000Z',
      cycle: 'monthly',
    });

    expect(period.start).toBe('2026-01-01T00:00:00.000Z');
    expect(period.cycle).toBe('monthly');
  });

  it('refuses a period that ends before it begins', () => {
    expect(
      codeOf(() =>
        createBillingPeriod({
          start: '2026-02-01T00:00:00.000Z',
          end: '2026-01-01T00:00:00.000Z',
          cycle: 'monthly',
        }),
      ),
    ).toBe('InvalidBillingPeriod');
  });

  it('refuses an empty period, which would contain no usage', () => {
    expect(
      codeOf(() =>
        createBillingPeriod({
          start: '2026-01-01T00:00:00.000Z',
          end: '2026-01-01T00:00:00.000Z',
          cycle: 'monthly',
        }),
      ),
    ).toBe('InvalidBillingPeriod');
  });

  it('refuses a local-time instant, which names a different moment per server', () => {
    expect(
      codeOf(() =>
        createBillingPeriod({
          start: '2026-01-01T00:00:00',
          end: '2026-02-01T00:00:00.000Z',
          cycle: 'monthly',
        }),
      ),
    ).toBe('InvalidBillingPeriod');
  });

  it('refuses a date with no time', () => {
    expect(
      codeOf(() =>
        createBillingPeriod({
          start: '2026-01-01',
          end: '2026-02-01T00:00:00.000Z',
          cycle: 'monthly',
        }),
      ),
    ).toBe('InvalidBillingPeriod');
  });

  it('refuses an instant that is not a real date', () => {
    expect(
      codeOf(() =>
        createBillingPeriod({
          start: '2026-13-45T00:00:00.000Z',
          end: '2026-02-01T00:00:00.000Z',
          cycle: 'monthly',
        }),
      ),
    ).toBe('InvalidBillingPeriod');
  });

  it('refuses an invalid cycle', () => {
    expect(
      codeOf(() =>
        createBillingPeriod({
          start: '2026-01-01T00:00:00.000Z',
          end: '2026-02-01T00:00:00.000Z',
          cycle: 'weekly' as 'monthly',
        }),
      ),
    ).toBe('InvalidBillingCycle');
  });

  it('is frozen', () => {
    const period = createBillingPeriod({
      start: '2026-01-01T00:00:00.000Z',
      end: '2026-02-01T00:00:00.000Z',
      cycle: 'monthly',
    });

    expect(Object.isFrozen(period)).toBe(true);
    expect(() => {
      (period as { end: string }).end = '2027-01-01T00:00:00.000Z';
    }).toThrow();
  });
});

describe('a period is half-open', () => {
  const period = createBillingPeriod({
    start: '2026-01-01T00:00:00.000Z',
    end: '2026-02-01T00:00:00.000Z',
    cycle: 'monthly',
  });

  it('contains its start', () => {
    expect(periodContains(period, '2026-01-01T00:00:00.000Z')).toBe(true);
  });

  it('does NOT contain its end', () => {
    // Inclusive bounds would put the boundary instant in two periods, which is
    // one usage record billed twice.
    expect(periodContains(period, '2026-02-01T00:00:00.000Z')).toBe(false);
  });

  it('contains the instant before its end', () => {
    expect(periodContains(period, '2026-01-31T23:59:59.999Z')).toBe(true);
  });

  it('excludes anything before it', () => {
    expect(periodContains(period, '2025-12-31T23:59:59.999Z')).toBe(false);
  });

  it('and the next period picks up exactly where it stops', () => {
    const next = nextPeriod(period);

    expect(next.start).toBe(period.end);
    expect(periodContains(next, period.end)).toBe(true);
  });

  it('never says a period both contains an instant and has elapsed at it', () => {
    for (const at of [
      '2025-12-31T23:59:59.999Z',
      '2026-01-01T00:00:00.000Z',
      '2026-01-15T12:00:00.000Z',
      '2026-02-01T00:00:00.000Z',
      '2026-03-01T00:00:00.000Z',
    ]) {
      expect(periodContains(period, at) && hasPeriodElapsed(period, at)).toBe(false);
    }
  });
});

describe('hasPeriodElapsed', () => {
  const period = createBillingPeriod({
    start: '2026-01-01T00:00:00.000Z',
    end: '2026-02-01T00:00:00.000Z',
    cycle: 'monthly',
  });

  it('is true at the boundary', () => {
    expect(hasPeriodElapsed(period, '2026-02-01T00:00:00.000Z')).toBe(true);
  });

  it('is false one millisecond earlier', () => {
    expect(hasPeriodElapsed(period, '2026-01-31T23:59:59.999Z')).toBe(false);
  });
});

describe('nextPeriod', () => {
  const monthly = (start: string, end: string) =>
    createBillingPeriod({ start, end, cycle: 'monthly' });

  it('advances a monthly period by one month', () => {
    const next = nextPeriod(monthly('2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z'));

    expect(next.start).toBe('2026-02-01T00:00:00.000Z');
    expect(next.end).toBe('2026-03-01T00:00:00.000Z');
  });

  it('advances an annual period by twelve months', () => {
    const next = nextPeriod(
      createBillingPeriod({
        start: '2026-01-01T00:00:00.000Z',
        end: '2027-01-01T00:00:00.000Z',
        cycle: 'annual',
      }),
    );

    expect(next.end).toBe('2028-01-01T00:00:00.000Z');
  });

  it('keeps the cycle', () => {
    expect(nextPeriod(monthly('2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z')).cycle).toBe(
      'monthly',
    );
  });

  it('keeps the time of day, so a boundary does not drift', () => {
    const next = nextPeriod(monthly('2026-01-15T09:30:00.000Z', '2026-02-15T09:30:00.000Z'));

    expect(next.end).toBe('2026-03-15T09:30:00.000Z');
  });

  it('clamps a 31st anniversary to the end of a short month', () => {
    // 31 January has no anniversary in February. Rolling to 3 March would move
    // every later period and drift the billing date from what was agreed.
    const next = nextPeriod(monthly('2025-12-31T00:00:00.000Z', '2026-01-31T00:00:00.000Z'));

    expect(next.end).toBe('2026-02-28T00:00:00.000Z');
  });

  it('clamps to 29 February in a leap year', () => {
    const next = nextPeriod(monthly('2023-12-31T00:00:00.000Z', '2024-01-31T00:00:00.000Z'));

    expect(next.end).toBe('2024-02-29T00:00:00.000Z');
  });

  it('does not clamp in a century that is not a leap year', () => {
    // 1900 is divisible by 4 and by 100 but not by 400.
    const next = nextPeriod(monthly('1899-12-31T00:00:00.000Z', '1900-01-31T00:00:00.000Z'));

    expect(next.end).toBe('1900-02-28T00:00:00.000Z');
  });

  it('does clamp in a century that IS a leap year', () => {
    const next = nextPeriod(monthly('1999-12-31T00:00:00.000Z', '2000-01-31T00:00:00.000Z'));

    expect(next.end).toBe('2000-02-29T00:00:00.000Z');
  });

  it('crosses a year boundary', () => {
    const next = nextPeriod(monthly('2026-11-01T00:00:00.000Z', '2026-12-01T00:00:00.000Z'));

    expect(next.end).toBe('2027-01-01T00:00:00.000Z');
  });

  it('handles a 30-day month', () => {
    const next = nextPeriod(monthly('2026-03-31T00:00:00.000Z', '2026-04-30T00:00:00.000Z'));

    expect(next.end).toBe('2026-05-30T00:00:00.000Z');
  });

  it('leaves no gap and no overlap across a year of rollovers', () => {
    let period = monthly('2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z');
    for (let month = 0; month < 12; month += 1) {
      const next = nextPeriod(period);
      expect(next.start).toBe(period.end);
      period = next;
    }
    expect(period.end).toBe('2027-02-01T00:00:00.000Z');
  });
});

describe('firstPeriod', () => {
  it('runs from the start instant to the next anniversary', () => {
    const period = firstPeriod('2026-01-15T09:30:00.000Z', 'monthly');

    expect(period.start).toBe('2026-01-15T09:30:00.000Z');
    expect(period.end).toBe('2026-02-15T09:30:00.000Z');
  });

  it('runs a year for an annual cycle', () => {
    expect(firstPeriod('2026-01-15T09:30:00.000Z', 'annual').end).toBe('2027-01-15T09:30:00.000Z');
  });

  it('normalises the instant it was given', () => {
    expect(firstPeriod('2026-01-15T09:30:00Z', 'monthly').start).toBe('2026-01-15T09:30:00.000Z');
  });

  it('refuses an invalid cycle', () => {
    expect(codeOf(() => firstPeriod('2026-01-15T09:30:00.000Z', 'weekly' as 'monthly'))).toBe(
      'InvalidBillingCycle',
    );
  });
});

describe('advanceTo', () => {
  const period = createBillingPeriod({
    start: '2026-01-01T00:00:00.000Z',
    end: '2026-02-01T00:00:00.000Z',
    cycle: 'monthly',
  });

  it('returns the period unchanged when it still contains the instant', () => {
    expect(advanceTo(period, '2026-01-15T00:00:00.000Z')).toEqual(period);
  });

  it('rolls forward past a missed renewal', () => {
    const caught = advanceTo(period, '2026-04-15T00:00:00.000Z');

    expect(caught.start).toBe('2026-04-01T00:00:00.000Z');
    expect(caught.end).toBe('2026-05-01T00:00:00.000Z');
    expect(periodContains(caught, '2026-04-15T00:00:00.000Z')).toBe(true);
  });

  it('rolls exactly one period at a boundary', () => {
    expect(advanceTo(period, '2026-02-01T00:00:00.000Z').start).toBe('2026-02-01T00:00:00.000Z');
  });

  it('refuses rather than hanging on a record too far behind', () => {
    // An unbounded loop over a stale period would hang a renewal job instead of
    // failing it.
    expect(codeOf(() => advanceTo(period, '2099-01-01T00:00:00.000Z'))).toBe(
      'InvalidBillingPeriod',
    );
  });

  it('honours a supplied bound', () => {
    expect(codeOf(() => advanceTo(period, '2026-06-01T00:00:00.000Z', 2))).toBe(
      'InvalidBillingPeriod',
    );
    expect(advanceTo(period, '2026-06-01T00:00:00.000Z', 12).start).toBe(
      '2026-06-01T00:00:00.000Z',
    );
  });

  it('is deterministic', () => {
    expect(advanceTo(period, '2026-04-15T00:00:00.000Z')).toEqual(
      advanceTo(period, '2026-04-15T00:00:00.000Z'),
    );
  });
});
