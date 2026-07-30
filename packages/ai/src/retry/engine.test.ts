/**
 * The retry engine.
 *
 * Three properties carry it. A non-retryable class is refused on its FIRST
 * occurrence rather than after the whole backoff curve reaches the same answer
 * more slowly and more expensively. A settled call gives the same answer
 * however many times it is asked. And nothing here dispatches anything.
 */
import { describe, expect, it } from 'vitest';

import { ProviderError, type ProviderErrorCode } from '@contentos/contracts';

import { DEFAULT_RETRY_POLICY, type RetryPolicy } from './policy.js';
import {
  beginRetryState,
  decideRetry,
  isRetryError,
  isTerminalRetryStatus,
  nextAttemptNumber,
  recordFailure,
  recordSuccess,
  RETRY_STATUSES,
  RetryError,
  settle,
  TERMINAL_RETRY_STATUSES,
  type RetryState,
} from './engine.js';

const KEY = 'wf-1:outline';

const fail = (code: ProviderErrorCode, retryAfterMs?: number): ProviderError =>
  new ProviderError(
    code,
    'openai',
    `[openai] ${code}`,
    retryAfterMs === undefined ? {} : { retryAfterMs },
  );

const policy = (over: Partial<RetryPolicy> = {}): RetryPolicy => ({
  ...DEFAULT_RETRY_POLICY,
  ...over,
});

/** A state with `n` failures of one class already recorded. */
function afterFailures(n: number, code: ProviderErrorCode = 'Unavailable'): RetryState {
  let state = beginRetryState(KEY);
  for (let i = 0; i < n; i += 1) state = recordFailure(state, fail(code));
  return state;
}

describe('the state vocabulary', () => {
  it('is the five documented statuses', () => {
    expect([...RETRY_STATUSES]).toEqual([
      'ready',
      'retrying',
      'succeeded',
      'exhausted',
      'terminal',
    ]);
  });

  it('names three settled statuses', () => {
    expect([...TERMINAL_RETRY_STATUSES].sort()).toEqual(['exhausted', 'succeeded', 'terminal']);
    expect(isTerminalRetryStatus('ready')).toBe(false);
    expect(isTerminalRetryStatus('retrying')).toBe(false);
  });
});

describe('a new state', () => {
  it('starts ready, with no attempts', () => {
    const state = beginRetryState(KEY);
    expect(state).toMatchObject({ status: 'ready', attempts: [], lastCode: null });
    expect(nextAttemptNumber(state)).toBe(1);
  });

  // Without the key a retry is a second generation the provider cannot
  // deduplicate and the meter counts as new work.
  it('requires the idempotency key every attempt will reuse', () => {
    expect(() => beginRetryState('  ')).toThrow(/idempotency key/);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(beginRetryState(KEY))).toBe(true);
    expect(Object.isFrozen(beginRetryState(KEY).attempts)).toBe(true);
  });
});

describe('recording a failure', () => {
  it('appends an attempt and numbers it from one', () => {
    const state = recordFailure(beginRetryState(KEY), fail('Unavailable'));
    expect(state.attempts).toHaveLength(1);
    expect(state.attempts[0]).toMatchObject({ attempt: 1, code: 'Unavailable', retryable: true });
    expect(state.status).toBe('retrying');
  });

  it('takes retryability from the taxonomy, not the caller', () => {
    expect(recordFailure(beginRetryState(KEY), fail('Validation')).attempts[0]?.retryable).toBe(
      false,
    );
    expect(recordFailure(beginRetryState(KEY), fail('RateLimit')).attempts[0]?.retryable).toBe(
      true,
    );
  });

  it("keeps the provider's Retry-After where it gave one", () => {
    const state = recordFailure(beginRetryState(KEY), fail('RateLimit', 30_000));
    expect(state.attempts[0]?.retryAfterMs).toBe(30_000);
  });

  it('leaves the previous state untouched', () => {
    const before = beginRetryState(KEY);
    const after = recordFailure(before, fail('Timeout'));
    expect(before.attempts).toHaveLength(0);
    expect(after.attempts).toHaveLength(1);
  });

  it('keeps the key across every attempt', () => {
    expect(afterFailures(3).idempotencyKey).toBe(KEY);
  });

  // A raw vendor error has not been classified and cannot be decided on.
  it('refuses anything that is not a classified ProviderError', () => {
    expect(() => recordFailure(beginRetryState(KEY), new Error('boom') as never)).toThrow(
      RetryError,
    );
  });

  // A late arrival must not rewrite an outcome already metered and reported.
  it('refuses to record against a settled call', () => {
    const succeeded = recordSuccess(afterFailures(1));
    expect(() => recordFailure(succeeded, fail('Timeout'))).toThrow(/settled/);
  });

  it('reports that as AlreadySettled', () => {
    try {
      recordFailure(recordSuccess(beginRetryState(KEY)), fail('Timeout'));
      expect.unreachable('must refuse');
    } catch (error) {
      expect(isRetryError(error)).toBe(true);
      expect((error as RetryError).code).toBe('AlreadySettled');
    }
  });
});

describe('recording success', () => {
  it('settles the call', () => {
    expect(recordSuccess(afterFailures(1)).status).toBe('succeeded');
  });

  // A redelivered completion is the transport behaving correctly rather than a
  // second success.
  it('is idempotent — twice is the same as once', () => {
    const once = recordSuccess(afterFailures(1));
    expect(recordSuccess(once)).toBe(once);
  });

  it('refuses success after the call ended the other way', () => {
    const exhausted = settle(afterFailures(2), decideRetry(afterFailures(2)));
    expect(exhausted.status).toBe('exhausted');
    expect(() => recordSuccess(exhausted)).toThrow(/already ended the other way/);
  });
});

describe('a retryable failure is retried', () => {
  it('decides to retry, naming the attempt and the wait', () => {
    const decision = decideRetry(afterFailures(1, 'Unavailable'));
    expect(decision).toMatchObject({
      action: 'retry',
      reason: 'retryable-failure',
      attempt: 2,
      delayMs: 500,
      code: 'Unavailable',
    });
  });

  it('retries every class the taxonomy calls retryable', () => {
    for (const code of ['RateLimit', 'Unavailable', 'Timeout', 'MalformedResponse'] as const) {
      expect(decideRetry(afterFailures(1, code)).action, code).toBe('retry');
    }
  });

  it('follows the backoff curve as attempts accumulate', () => {
    // No per-code override, so the general limit applies and the curve is
    // visible for more than one step.
    const p = policy({ maxAttempts: 5, maxAttemptsByCode: {} });
    expect(decideRetry(afterFailures(1), { policy: p }).delayMs).toBe(500);
    expect(decideRetry(afterFailures(2), { policy: p }).delayMs).toBe(1000);
    expect(decideRetry(afterFailures(3), { policy: p }).delayMs).toBe(2000);
  });

  it('carries a detail that explains the decision', () => {
    expect(decideRetry(afterFailures(1)).detail).toContain('Attempt 2 of 2');
  });
});

describe('a non-retryable failure is refused immediately', () => {
  // Refused on its FIRST occurrence: waiting for attempts to exhaust would
  // reach the identical outcome more slowly and more expensively.
  it('fails on the first attempt, not after the curve', () => {
    for (const code of [
      'Authentication',
      'Validation',
      'ContentFiltered',
      'ContextTooLarge',
      'ModelUnavailable',
      'Internal',
    ] as const) {
      const decision = decideRetry(afterFailures(1, code));
      expect(decision.action, code).toBe('fail');
      expect(decision.reason, code).toBe('non-retryable-failure');
      expect(decision.delayMs, code).toBe(0);
    }
  });

  // Rule 2 of the spec, which is normative and admits no exception:
  // automatically re-running a refused prompt converts a supplier's safety
  // judgment into an obstacle to route around.
  it('never retries a provider safety refusal', () => {
    const decision = decideRetry(afterFailures(1, 'ContentFiltered'), {
      policy: policy({ maxAttempts: 10 }),
    });
    expect(decision.action).toBe('fail');
  });

  // Our own defect: retrying it wastes money and hides the bug.
  it('never retries a malformed request of ours', () => {
    expect(decideRetry(afterFailures(1, 'Validation')).action).toBe('fail');
  });

  it('explains why another attempt would be pointless', () => {
    expect(decideRetry(afterFailures(1, 'Authentication')).detail).toContain('not retryable');
  });
});

describe('exhausted retries', () => {
  it('stops once the attempts allowed are used', () => {
    const decision = decideRetry(afterFailures(2, 'Unavailable'));
    expect(decision).toMatchObject({ action: 'fail', reason: 'attempts-exhausted' });
  });

  it('allows a rate limit the third attempt the spec gives it', () => {
    expect(decideRetry(afterFailures(2, 'RateLimit')).action).toBe('retry');
    expect(decideRetry(afterFailures(3, 'RateLimit')).action).toBe('fail');
  });

  it('counts how many of how many were made', () => {
    expect(decideRetry(afterFailures(2)).detail).toContain('2 of 2');
  });

  it('settles an exhausted state', () => {
    const state = afterFailures(2);
    expect(settle(state, decideRetry(state)).status).toBe('exhausted');
  });

  it('settles a non-retryable state as terminal, not exhausted', () => {
    const state = afterFailures(1, 'Authentication');
    expect(settle(state, decideRetry(state)).status).toBe('terminal');
  });

  it('leaves the state alone when the decision is to retry', () => {
    const state = afterFailures(1);
    expect(settle(state, decideRetry(state))).toBe(state);
  });
});

describe('the provider knows better than the formula', () => {
  it('honours Retry-After over the computed backoff', () => {
    const state = recordFailure(beginRetryState(KEY), fail('RateLimit', 30_000));
    const decision = decideRetry(state);
    expect(decision.delayMs).toBe(30_000);
    expect(decision.reason).toBe('honouring-retry-after');
  });

  it('honours a Retry-After beyond the policy ceiling', () => {
    const state = recordFailure(beginRetryState(KEY), fail('RateLimit', 60_000));
    expect(decideRetry(state).delayMs).toBe(60_000);
  });

  it('honours a Retry-After of zero, meaning retry now', () => {
    const state = recordFailure(beginRetryState(KEY), fail('RateLimit', 0));
    expect(decideRetry(state).delayMs).toBe(0);
    expect(decideRetry(state).action).toBe('retry');
  });

  it('falls back to the formula when none was given', () => {
    expect(decideRetry(afterFailures(1, 'RateLimit')).reason).toBe('retryable-failure');
  });
});

describe("the caller's deadline binds", () => {
  // Retrying past a deadline consumes budget and quota to produce a result
  // nobody is waiting for.
  it('abandons a retry whose wait exceeds what is left', () => {
    const decision = decideRetry(afterFailures(1), { remainingMs: 100 });
    expect(decision).toMatchObject({ action: 'fail', reason: 'deadline-exceeded' });
  });

  it('retries when there is time', () => {
    expect(decideRetry(afterFailures(1), { remainingMs: 10_000 }).action).toBe('retry');
  });

  it('retries when the wait exactly fits', () => {
    expect(decideRetry(afterFailures(1), { remainingMs: 500 }).action).toBe('retry');
  });

  it('abandons a long Retry-After the caller cannot wait for', () => {
    const state = recordFailure(beginRetryState(KEY), fail('RateLimit', 60_000));
    expect(decideRetry(state, { remainingMs: 5000 }).reason).toBe('deadline-exceeded');
  });

  it('ignores the deadline when none was supplied', () => {
    expect(decideRetry(afterFailures(1)).action).toBe('retry');
  });
});

describe('deciding changes nothing, and is repeatable', () => {
  // A caller may ask twice and must get the same answer.
  it('gives the same decision every time', () => {
    const state = afterFailures(1);
    const first = decideRetry(state);
    for (let i = 0; i < 50; i += 1) expect(decideRetry(state)).toEqual(first);
  });

  it('does not advance the state', () => {
    const state = afterFailures(1);
    decideRetry(state);
    expect(state.attempts).toHaveLength(1);
    expect(state.status).toBe('retrying');
  });

  it('freezes the decision', () => {
    const decision = decideRetry(afterFailures(1));
    expect(Object.isFrozen(decision)).toBe(true);
    expect(() => {
      (decision as { action: string }).action = 'retry';
    }).toThrow();
  });
});

describe('a settled call is protected', () => {
  it('refuses to retry a succeeded call', () => {
    const decision = decideRetry(recordSuccess(afterFailures(1)));
    expect(decision).toMatchObject({ action: 'fail', reason: 'already-settled' });
  });

  it('refuses to retry an exhausted call', () => {
    const state = afterFailures(2);
    const exhausted = settle(state, decideRetry(state));
    expect(decideRetry(exhausted).reason).toBe('already-settled');
  });

  it('refuses to retry a terminally failed call', () => {
    const state = afterFailures(1, 'Authentication');
    const terminal = settle(state, decideRetry(state));
    expect(decideRetry(terminal).reason).toBe('already-settled');
  });

  it('settles idempotently', () => {
    const state = afterFailures(2);
    const once = settle(state, decideRetry(state));
    expect(settle(once, decideRetry(once))).toBe(once);
  });

  it('has nothing to decide before anything failed', () => {
    expect(decideRetry(beginRetryState(KEY))).toMatchObject({
      action: 'fail',
      reason: 'nothing-to-retry',
    });
  });
});

describe('metering keys off the attempt number', () => {
  // Cost metering is keyed on (idempotencyKey, attempt), so each genuine call
  // meters exactly once and a duplicated retry never double-charges.
  it('reports the attempt the next call would be', () => {
    expect(nextAttemptNumber(beginRetryState(KEY))).toBe(1);
    expect(nextAttemptNumber(afterFailures(1))).toBe(2);
    expect(nextAttemptNumber(afterFailures(3))).toBe(4);
  });

  it('agrees with the attempt the decision names', () => {
    const state = afterFailures(1);
    expect(decideRetry(state).attempt).toBe(nextAttemptNumber(state));
  });
});
