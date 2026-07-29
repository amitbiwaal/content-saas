/**
 * Retry engine.
 *
 * Spec: `13-event-platform/retry-engine.md`.
 *
 * TWO RULES SHAPE EVERYTHING HERE:
 *
 *   Retry only TRANSIENT failures. Retrying a deterministic failure burns
 *   budget to reach the same outcome, and delays the dead-letter that an
 *   operator actually needs to see.
 *
 *   `RetryDecision` HAS NO DROP VARIANT. An event is retried, or it is
 *   dead-lettered. There is no third option, so "no event is silently
 *   discarded" is a property of the type rather than of every code path being
 *   written correctly.
 */

export type Classification = 'transient' | 'terminal';

/**
 * FROZEN terminal classifications. These are deterministic: the same input
 * produces the same failure however many times it is attempted.
 *
 * `GuardrailBlocked` is terminal because a guardrail refusal is a decision, not
 * an outage — retrying it is an attempt to get a different answer to the same
 * question.
 */
export const TERMINAL_CODES = [
  'GuardrailBlocked',
  'ValidationRejected',
  'SchemaViolation',
  'UnknownEventType',
  'AuthorizationFailure',
] as const;

export type TerminalCode = (typeof TERMINAL_CODES)[number];

const TERMINAL = new Set<string>(TERMINAL_CODES);

/** Unrecognised failures are treated as TRANSIENT — see `classify`. */
export function classify(code: string): Classification {
  return TERMINAL.has(code) ? 'terminal' : 'transient';
}

export function isTerminalCode(code: string): code is TerminalCode {
  return TERMINAL.has(code);
}

/**
 * The decision. `retry` or `dead-letter` — deliberately no `drop`.
 */
export type RetryDecision =
  | { readonly action: 'retry'; readonly delayMs: number; readonly attempt: number }
  | { readonly action: 'dead-letter'; readonly reason: DeadLetterReason; readonly code: string };

export type DeadLetterReason =
  | 'terminal-classification'
  | 'attempts-exhausted'
  | 'budget-exhausted';

export interface RetryPolicy {
  /** Attempts INCLUDING the first. 5 means one try plus four retries. */
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  /** Jitter fraction in [0,1]. 0 disables it, which is what tests want. */
  readonly jitter: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 5,
  baseDelayMs: 1000,
  maxDelayMs: 60_000,
  jitter: 0.2,
};

export interface RetryContext {
  readonly eventId: string;
  readonly eventType: string;
  readonly consumerGroup: string;
  readonly attempt: number;
  readonly code: string;
}

export interface RetryBudget {
  readonly scope: 'consumer-group' | 'event-type';
  readonly key: string;
  readonly remaining: number;
}

/**
 * Exponential backoff with jitter, capped.
 *
 * Jitter matters more than the curve: without it, a dependency outage
 * synchronises every consumer's retry into a thundering herd that arrives
 * exactly when the dependency is trying to recover.
 */
export function backoffMs(
  attempt: number,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  random: () => number = Math.random,
): number {
  const exponential = policy.baseDelayMs * 2 ** Math.max(0, attempt - 1);
  const capped = Math.min(exponential, policy.maxDelayMs);
  if (policy.jitter <= 0) return capped;
  const spread = capped * policy.jitter;
  return Math.round(capped - spread / 2 + random() * spread);
}

export interface RetryEngineOptions {
  readonly policy?: RetryPolicy;
  readonly random?: () => number;
  /** Remaining budget for the scope, if a budget is in force. */
  readonly budget?: (context: RetryContext) => number | undefined;
}

export interface RetryEngine {
  decide(context: RetryContext): RetryDecision;
}

export function createRetryEngine(options: RetryEngineOptions = {}): RetryEngine {
  const policy = options.policy ?? DEFAULT_RETRY_POLICY;
  const random = options.random ?? Math.random;

  return {
    decide(context: RetryContext): RetryDecision {
      // Terminal first: a deterministic failure is dead-lettered on its FIRST
      // occurrence. Waiting for attempts to exhaust would delay the operator
      // signal by the whole backoff curve to reach the identical outcome.
      if (classify(context.code) === 'terminal') {
        return { action: 'dead-letter', reason: 'terminal-classification', code: context.code };
      }

      if (context.attempt >= policy.maxAttempts) {
        return { action: 'dead-letter', reason: 'attempts-exhausted', code: context.code };
      }

      // A budget protects the platform from one pathological event type
      // consuming every worker's capacity on retries.
      const remaining = options.budget?.(context);
      if (remaining !== undefined && remaining <= 0) {
        return { action: 'dead-letter', reason: 'budget-exhausted', code: context.code };
      }

      return {
        action: 'retry',
        delayMs: backoffMs(context.attempt, policy, random),
        attempt: context.attempt + 1,
      };
    },
  };
}
