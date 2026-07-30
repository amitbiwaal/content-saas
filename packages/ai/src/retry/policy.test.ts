/**
 * Retry policy and backoff.
 *
 * The load-bearing property is determinism: identical inputs, identical output,
 * every time. Asserted directly rather than inferred from the absence of
 * `Math.random`, because the absence of something is not a test.
 *
 * The off-by-one in a backoff curve is the bug worth guarding: it is invisible
 * in output and it doubles or halves every wait.
 */
import { describe, expect, it } from 'vitest';

import {
  assertRetryPolicyValid,
  attemptsAllowed,
  BACKOFF_STRATEGIES,
  backoffFor,
  backoffSchedule,
  DEFAULT_RETRY_POLICY,
  isBackoffStrategy,
  RetryPolicyError,
  type RetryPolicy,
} from './policy.js';

const policy = (over: Partial<RetryPolicy> = {}): RetryPolicy => ({
  ...DEFAULT_RETRY_POLICY,
  ...over,
});

describe('the strategy vocabulary', () => {
  it('is the three the increment names', () => {
    expect([...BACKOFF_STRATEGIES]).toEqual(['fixed', 'linear', 'exponential']);
  });

  it('recognises them and nothing else', () => {
    for (const strategy of BACKOFF_STRATEGIES) expect(isBackoffStrategy(strategy)).toBe(true);
    for (const other of ['jittered', 'EXPONENTIAL', '', null]) {
      expect(isBackoffStrategy(other), String(other)).toBe(false);
    }
  });
});

describe("the default policy is the spec's table, not a guess", () => {
  it('waits 500ms at base and caps at 8s', () => {
    expect(DEFAULT_RETRY_POLICY.baseDelayMs).toBe(500);
    expect(DEFAULT_RETRY_POLICY.maxDelayMs).toBe(8000);
  });

  // "The default answer is one retry, not five."
  it('allows two attempts by default — one try and one retry', () => {
    expect(DEFAULT_RETRY_POLICY.maxAttempts).toBe(2);
  });

  // A rate limit is transient on the same model and worth another wait; an
  // unavailability is a signal about that model.
  it('allows a rate limit three attempts and the rest two', () => {
    expect(attemptsAllowed(DEFAULT_RETRY_POLICY, 'RateLimit')).toBe(3);
    expect(attemptsAllowed(DEFAULT_RETRY_POLICY, 'Unavailable')).toBe(2);
    expect(attemptsAllowed(DEFAULT_RETRY_POLICY, 'Timeout')).toBe(2);
    expect(attemptsAllowed(DEFAULT_RETRY_POLICY, 'MalformedResponse')).toBe(2);
  });

  it('falls back to the general limit for a class it does not name', () => {
    expect(attemptsAllowed(DEFAULT_RETRY_POLICY, 'Internal')).toBe(2);
  });

  it('is frozen, so one caller cannot retune every other', () => {
    expect(Object.isFrozen(DEFAULT_RETRY_POLICY)).toBe(true);
    expect(() => {
      (DEFAULT_RETRY_POLICY as { maxAttempts: number }).maxAttempts = 99;
    }).toThrow();
  });
});

describe('backoff is deterministic', () => {
  it('gives the same delay for the same attempt, every time', () => {
    const expected = backoffFor(policy(), 4);
    for (let i = 0; i < 100; i += 1) expect(backoffFor(policy(), 4)).toBe(expected);
  });

  it('produces the same schedule from a rebuilt policy', () => {
    expect(backoffSchedule(policy(), 6)).toEqual(backoffSchedule(policy(), 6));
  });

  it('returns an integer, so the value is comparable and loggable', () => {
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      expect(Number.isInteger(backoffFor(policy({ baseDelayMs: 333 }), attempt))).toBe(true);
    }
  });
});

describe('nothing waits before the first try', () => {
  it('is zero at attempt one, whatever the strategy', () => {
    for (const strategy of BACKOFF_STRATEGIES) {
      expect(backoffFor(policy({ strategy }), 1), strategy).toBe(0);
    }
  });

  // The off-by-one that is invisible in output.
  it('waits the base before the FIRST retry, which is attempt two', () => {
    expect(backoffFor(policy({ strategy: 'fixed' }), 2)).toBe(500);
    expect(backoffFor(policy({ strategy: 'linear' }), 2)).toBe(500);
    expect(backoffFor(policy({ strategy: 'exponential' }), 2)).toBe(500);
  });
});

describe('fixed delay', () => {
  it('waits the same every time', () => {
    const p = policy({ strategy: 'fixed', baseDelayMs: 250 });
    expect(backoffSchedule(p, 5)).toEqual([0, 250, 250, 250, 250]);
  });

  it('honours the ceiling even when it is below the base', () => {
    const p = policy({ strategy: 'fixed', baseDelayMs: 250, maxDelayMs: 250 });
    expect(backoffFor(p, 3)).toBe(250);
  });
});

describe('linear delay', () => {
  it('grows by the base each attempt', () => {
    const p = policy({ strategy: 'linear', baseDelayMs: 200, maxDelayMs: 10_000 });
    expect(backoffSchedule(p, 5)).toEqual([0, 200, 400, 600, 800]);
  });

  it('stops at the ceiling', () => {
    const p = policy({ strategy: 'linear', baseDelayMs: 200, maxDelayMs: 500 });
    expect(backoffSchedule(p, 5)).toEqual([0, 200, 400, 500, 500]);
  });
});

describe('exponential delay', () => {
  it('doubles from the base', () => {
    const p = policy({ strategy: 'exponential', baseDelayMs: 500, maxDelayMs: 100_000 });
    expect(backoffSchedule(p, 6)).toEqual([0, 500, 1000, 2000, 4000, 8000]);
  });

  it('stops at the ceiling — 8s by default', () => {
    expect(backoffSchedule(policy(), 8)).toEqual([0, 500, 1000, 2000, 4000, 8000, 8000, 8000]);
  });

  it('honours a multiplier other than two', () => {
    const p = policy({ strategy: 'exponential', baseDelayMs: 100, multiplier: 3, maxDelayMs: 1e6 });
    expect(backoffSchedule(p, 5)).toEqual([0, 100, 300, 900, 2700]);
  });

  // A multiplier of one is a fixed delay by another name, and is legal.
  it('degenerates to a fixed delay at a multiplier of one', () => {
    const p = policy({ strategy: 'exponential', baseDelayMs: 400, multiplier: 1 });
    expect(backoffSchedule(p, 4)).toEqual([0, 400, 400, 400]);
  });
});

describe('there is no jitter anywhere', () => {
  // The increment requires determinism; the spec requires jitter at DISPATCH.
  // Both hold because they are properties of different layers — but the
  // absence here has to be visible, not assumed.
  it('never varies across a long run of identical calls', () => {
    const p = policy();
    const values = new Set(Array.from({ length: 500 }, () => backoffFor(p, 3)));
    expect(values.size).toBe(1);
  });

  it('produces one schedule, not a distribution', () => {
    const schedules = new Set(
      Array.from({ length: 50 }, () => JSON.stringify(backoffSchedule(policy(), 6))),
    );
    expect(schedules.size).toBe(1);
  });
});

describe('an unusable policy is refused', () => {
  it('refuses fewer than one attempt', () => {
    // Zero would disable the platform in a way nothing reports.
    for (const maxAttempts of [0, -1, 1.5]) {
      expect(() => {
        assertRetryPolicyValid(policy({ maxAttempts }));
      }, String(maxAttempts)).toThrow(RetryPolicyError);
    }
  });

  it('refuses an unknown strategy', () => {
    expect(() => {
      assertRetryPolicyValid(policy({ strategy: 'jittered' as never }));
    }).toThrow(/not a backoff strategy/);
  });

  it('refuses a negative or fractional delay', () => {
    for (const baseDelayMs of [-1, 1.5]) {
      expect(() => {
        assertRetryPolicyValid(policy({ baseDelayMs }));
      }, String(baseDelayMs)).toThrow(RetryPolicyError);
    }
  });

  it('refuses a ceiling below the base', () => {
    expect(() => {
      assertRetryPolicyValid(policy({ baseDelayMs: 1000, maxDelayMs: 500 }));
    }).toThrow(/ceiling would shorten/);
  });

  // Below one the delay shrinks each attempt, hammering a provider harder the
  // longer it stays down.
  it('refuses a multiplier below one', () => {
    for (const multiplier of [0, 0.5, -1, Number.NaN]) {
      expect(() => {
        assertRetryPolicyValid(policy({ multiplier }));
      }, String(multiplier)).toThrow(RetryPolicyError);
    }
  });

  it('refuses a per-code limit that is not a positive integer', () => {
    expect(() => {
      assertRetryPolicyValid(policy({ maxAttemptsByCode: { RateLimit: 0 } }));
    }).toThrow(/maxAttemptsByCode.RateLimit/);
  });

  it('accepts the default policy', () => {
    expect(() => {
      assertRetryPolicyValid(DEFAULT_RETRY_POLICY);
    }).not.toThrow();
  });

  // An author fixing a policy should see the whole picture in one cycle.
  it('reports every issue, not the first', () => {
    try {
      assertRetryPolicyValid(policy({ maxAttempts: 0, multiplier: 0, baseDelayMs: -1 }));
      expect.unreachable('must refuse');
    } catch (error) {
      expect((error as RetryPolicyError).issues.length).toBeGreaterThanOrEqual(3);
    }
  });

  it('refuses a nonsensical attempt number', () => {
    for (const attempt of [0, -1, 1.5]) {
      expect(() => backoffFor(policy(), attempt), String(attempt)).toThrow(RetryPolicyError);
    }
  });
});
