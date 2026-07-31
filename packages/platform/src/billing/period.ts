/**
 * The billing period, and the cycle that produces the next one.
 *
 * `billing.md` gives a subscription a `currentPeriod` and the `subscriptions`
 * table `current_period_start / current_period_end`. This is that interval as a
 * value, plus the arithmetic that advances it.
 *
 * ── Half-open, so adjacent periods never overlap ───────────────────────────
 * `[start, end)`. An instant belongs to exactly one period. Inclusive bounds
 * would put the boundary instant in two of them, which is a usage record billed
 * twice — and the same discipline the consumption and settlement queries
 * already use for their date windows.
 *
 * ── No clock ───────────────────────────────────────────────────────────────
 * Every function is given the instant it should reason about. A period that
 * read the clock could not be asserted on, and a renewal job and a customer's
 * invoice page would disagree about which period a run fell in.
 *
 * ── Why the anniversary is clamped ─────────────────────────────────────────
 * A subscription that starts on 31 January has no anniversary on 31 February.
 * Rolling forward to 3 March would move every subsequent period and drift the
 * billing date away from what the customer agreed. The last day of the target
 * month is the only answer that keeps the anniversary stable, and it is what
 * every payment provider does.
 */

import { BillingError } from './errors.js';
import { deepFreeze } from './immutable.js';

/**
 * How often a subscription renews.
 *
 * `billing.md` names a monthly price and monthly periods. `annual` is the other
 * cycle the arithmetic has to handle, and a cycle type with one member could
 * never be invalid — which the increment requires it to be able to be.
 */
export const BILLING_CYCLES = ['monthly', 'annual'] as const;

export type BillingCycle = (typeof BILLING_CYCLES)[number];

export function isBillingCycle(value: unknown): value is BillingCycle {
  return typeof value === 'string' && (BILLING_CYCLES as readonly string[]).includes(value);
}

export function assertBillingCycle(value: unknown): BillingCycle {
  if (isBillingCycle(value)) return value;
  throw new BillingError(
    'InvalidBillingCycle',
    `'${String(value)}' is not a billing cycle. Available: ${BILLING_CYCLES.join(', ')}.`,
  );
}

/** How many months a cycle advances the period by. */
export const MONTHS_PER_CYCLE: Readonly<Record<BillingCycle, number>> = Object.freeze({
  monthly: 1,
  annual: 12,
});

/**
 * One billing period. Half-open: `[start, end)`.
 *
 * The cycle travels with it because a period read back from a store has to say
 * how the next one is computed without a second lookup.
 */
export interface BillingPeriod {
  readonly start: string;
  readonly end: string;
  readonly cycle: BillingCycle;
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

/**
 * Parse an instant this module will do arithmetic on.
 *
 * The format is pinned rather than left to `Date`'s parser, which accepts
 * local-time strings and produces a different instant depending on where the
 * process runs. A billing boundary that moved with the server's timezone would
 * bill one customer twice and another not at all.
 */
function instantOf(value: string, field: string): Date {
  if (!ISO.test(value)) {
    throw new BillingError(
      'InvalidBillingPeriod',
      `'${field}' must be a UTC ISO-8601 instant (YYYY-MM-DDTHH:MM:SS[.mmm]Z); got '${value}'. A local-time string names a different instant depending on where it is read.`,
    );
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new BillingError('InvalidBillingPeriod', `'${field}' is not a real instant: '${value}'.`);
  }
  return parsed;
}

/**
 * A period, validated.
 *
 * Refuses an empty or backwards interval: a period that ends before it begins
 * contains no usage, so every run in it would be billed to nothing.
 */
export function createBillingPeriod(input: {
  readonly start: string;
  readonly end: string;
  readonly cycle: BillingCycle;
}): BillingPeriod {
  const start = instantOf(input.start, 'start');
  const end = instantOf(input.end, 'end');
  const cycle = assertBillingCycle(input.cycle);

  if (end.getTime() <= start.getTime()) {
    throw new BillingError(
      'InvalidBillingPeriod',
      `A billing period must end after it begins; got ${input.start} to ${input.end}. An empty period contains no usage.`,
    );
  }

  return deepFreeze({ start: input.start, end: input.end, cycle });
}

/** Is this instant inside the period? Half-open: `start <= at < end`. */
export function periodContains(period: BillingPeriod, at: string): boolean {
  const instant = instantOf(at, 'at').getTime();
  return (
    instant >= instantOf(period.start, 'start').getTime() &&
    instant < instantOf(period.end, 'end').getTime()
  );
}

/**
 * Has the period run out at this instant?
 *
 * The renewal question. True exactly when the instant is no longer inside it,
 * so a period that has elapsed and one that contains the instant are never both
 * true — otherwise a rollover job and the billing page would disagree.
 */
export function hasPeriodElapsed(period: BillingPeriod, at: string): boolean {
  return instantOf(at, 'at').getTime() >= instantOf(period.end, 'end').getTime();
}

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

function daysInMonth(year: number, monthIndex: number): number {
  if (monthIndex !== 1) return DAYS_IN_MONTH[monthIndex] ?? 30;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return leap ? 29 : 28;
}

/**
 * The same day-of-month, `months` later, clamped to the target month's length.
 *
 * Built from UTC components rather than by adding milliseconds: a month is not
 * a fixed number of them, and adding 30 days repeatedly walks the billing date
 * backwards through the calendar.
 */
function addMonths(from: Date, months: number): Date {
  const year = from.getUTCFullYear();
  const monthIndex = from.getUTCMonth() + months;
  const targetYear = year + Math.floor(monthIndex / 12);
  const targetMonth = ((monthIndex % 12) + 12) % 12;
  const day = Math.min(from.getUTCDate(), daysInMonth(targetYear, targetMonth));

  return new Date(
    Date.UTC(
      targetYear,
      targetMonth,
      day,
      from.getUTCHours(),
      from.getUTCMinutes(),
      from.getUTCSeconds(),
      from.getUTCMilliseconds(),
    ),
  );
}

/** The period that begins where this one ends. Same cycle, same anniversary. */
export function nextPeriod(period: BillingPeriod): BillingPeriod {
  const start = instantOf(period.end, 'end');
  const end = addMonths(start, MONTHS_PER_CYCLE[period.cycle]);

  return deepFreeze({
    start: start.toISOString(),
    end: end.toISOString(),
    cycle: period.cycle,
  });
}

/** The first period of a subscription that starts at this instant. */
export function firstPeriod(startsAt: string, cycle: BillingCycle): BillingPeriod {
  const start = instantOf(startsAt, 'startsAt');
  const validated = assertBillingCycle(cycle);

  return deepFreeze({
    start: start.toISOString(),
    end: addMonths(start, MONTHS_PER_CYCLE[validated]).toISOString(),
    cycle: validated,
  });
}

/**
 * Roll forward until the period contains this instant.
 *
 * What a renewal job that missed a run has to do. Bounded, because an unbounded
 * loop over a corrupt period would hang the job rather than fail it — and a
 * subscription more than a hundred periods behind is a data problem, not a
 * rollover.
 */
export function advanceTo(period: BillingPeriod, at: string, limit = 120): BillingPeriod {
  let current = period;
  for (let steps = 0; steps < limit; steps += 1) {
    if (!hasPeriodElapsed(current, at)) return current;
    current = nextPeriod(current);
  }
  throw new BillingError(
    'InvalidBillingPeriod',
    `A period beginning ${period.start} is still behind ${at} after ${String(limit)} rollovers. That is a stale record, not a renewal.`,
  );
}
