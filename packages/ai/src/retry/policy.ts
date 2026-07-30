/**
 * Retry policy and backoff.
 *
 * Spec: `08-ai-platform/retry-strategy.md`.
 *
 * ── This is not the event platform's retry engine ───────────────────────────
 * `packages/events` decides whether an EVENT is redelivered to a consumer group
 * or dead-lettered. This decides whether an AI CALL is attempted again. They
 * answer different questions from different taxonomies, and `packages/ai` may
 * not import `packages/events` in any case — two feature packages communicate
 * through contracts. Nothing here is a copy of that engine; the shared word is
 * "retry" and nothing else.
 *
 * ── Retry is a cost decision, not a resilience reflex ───────────────────────
 * Every retry is a real provider call: it consumes budget, quota and latency.
 * The spec's default is ONE retry, not five, and the per-code limits below are
 * its table rather than a guess.
 *
 * ── Jitter: a deliberate, flagged departure from the spec ───────────────────
 * `retry-strategy.md` calls jitter mandatory and "the single most important
 * detail in the backoff configuration", because without it every request that
 * failed at the same instant retries at the same instant — a synchronised herd
 * that turns a provider blip into a self-inflicted outage.
 *
 * This increment requires deterministic backoff: identical inputs, identical
 * output. Both can hold, because they are properties of different layers. What
 * is computed here is the DELAY, a pure function of the attempt. What the spec
 * protects is the moment of DISPATCH, and dispatch is scheduling, which this
 * increment explicitly excludes.
 *
 * The consequence must be stated rather than assumed: whatever eventually
 * schedules these attempts has to spread them, or the spec's warning applies in
 * full. This file computes a delay; it does not promise a safe one.
 */

import type { ProviderErrorCode } from '@contentos/contracts';

export const BACKOFF_STRATEGIES = ['fixed', 'linear', 'exponential'] as const;

export type BackoffStrategy = (typeof BACKOFF_STRATEGIES)[number];

export function isBackoffStrategy(value: unknown): value is BackoffStrategy {
  return typeof value === 'string' && (BACKOFF_STRATEGIES as readonly string[]).includes(value);
}

export interface RetryPolicy {
  /** Attempts INCLUDING the first. 2 means one try plus one retry. */
  readonly maxAttempts: number;
  readonly strategy: BackoffStrategy;
  readonly baseDelayMs: number;
  /** Beyond this the caller's deadline is the binding constraint anyway. */
  readonly maxDelayMs: number;
  /** Exponential only. Ignored by the other two strategies. */
  readonly multiplier: number;
  /**
   * Per-class attempt limits, from the spec's failure taxonomy.
   *
   * A rate limit is transient on the same model and worth three attempts; an
   * unavailability is a signal about that model and worth two. Getting these
   * backwards produces either wasted waiting or unnecessary fallback.
   */
  readonly maxAttemptsByCode: Readonly<Partial<Record<ProviderErrorCode, number>>>;
}

/**
 * The spec's numbers, not invented ones.
 *
 * Base 500 ms — below typical provider recovery, above instant hammering.
 * Ceiling 8 s — beyond it the caller's deadline binds first.
 */
export const DEFAULT_RETRY_POLICY: RetryPolicy = Object.freeze({
  maxAttempts: 2,
  strategy: 'exponential',
  baseDelayMs: 500,
  maxDelayMs: 8000,
  multiplier: 2,
  maxAttemptsByCode: Object.freeze({
    RateLimit: 3,
    Unavailable: 2,
    Timeout: 2,
    MalformedResponse: 2,
  }),
});

export class RetryPolicyError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid retry policy: ${issues.join('; ')}.`);
    this.name = 'RetryPolicyError';
    this.issues = issues;
  }
}

/** Reject a policy that could not produce a sane schedule. Every issue at once. */
export function assertRetryPolicyValid(policy: RetryPolicy): void {
  const issues: string[] = [];
  const raw = policy as unknown as Record<string, unknown>;

  const maxAttempts = raw['maxAttempts'];
  if (!Number.isInteger(maxAttempts) || (maxAttempts as number) < 1) {
    // Zero attempts would mean never calling the provider at all, which is a
    // way of disabling the platform that nothing would report.
    issues.push('maxAttempts must be an integer >= 1, counting the first try');
  }
  if (!isBackoffStrategy(raw['strategy'])) {
    issues.push(`'${String(raw['strategy'])}' is not a backoff strategy`);
  }
  const baseDelayMs = raw['baseDelayMs'];
  if (!Number.isInteger(baseDelayMs) || (baseDelayMs as number) < 0) {
    issues.push('baseDelayMs must be a non-negative integer');
  }
  const maxDelayMs = raw['maxDelayMs'];
  if (!Number.isInteger(maxDelayMs) || (maxDelayMs as number) < 0) {
    issues.push('maxDelayMs must be a non-negative integer');
  }
  if (
    Number.isInteger(baseDelayMs) &&
    Number.isInteger(maxDelayMs) &&
    (maxDelayMs as number) < (baseDelayMs as number)
  ) {
    issues.push('maxDelayMs must be >= baseDelayMs, or the ceiling would shorten the first wait');
  }
  const multiplier = raw['multiplier'];
  if (typeof multiplier !== 'number' || !Number.isFinite(multiplier) || multiplier < 1) {
    // Below 1 the delay shrinks with each attempt, which hammers a provider
    // harder the longer it stays down.
    issues.push('multiplier must be a finite number >= 1');
  }

  const byCode: unknown = raw['maxAttemptsByCode'];
  if (typeof byCode !== 'object' || byCode === null) {
    issues.push('maxAttemptsByCode must be an object, empty if there are no overrides');
  } else {
    for (const [code, limit] of Object.entries(byCode as Record<string, unknown>)) {
      if (!Number.isInteger(limit) || (limit as number) < 1) {
        issues.push(`maxAttemptsByCode.${code} must be an integer >= 1`);
      }
    }
  }

  if (issues.length > 0) throw new RetryPolicyError(issues);
}

/** How many attempts this class of failure is worth. */
export function attemptsAllowed(policy: RetryPolicy, code: ProviderErrorCode): number {
  return policy.maxAttemptsByCode[code] ?? policy.maxAttempts;
}

/**
 * The delay before attempt `nextAttempt`, in milliseconds.
 *
 * `nextAttempt` is 1-based and is the attempt ABOUT to be made, so the wait
 * before the first retry is `nextAttempt = 2`. Written that way because the
 * off-by-one in a backoff curve is invisible in output and doubles or halves
 * every wait.
 *
 * Pure: no clock, no random source, no state. The same attempt number and the
 * same policy give the same integer, always.
 */
export function backoffFor(policy: RetryPolicy, nextAttempt: number): number {
  if (!Number.isInteger(nextAttempt) || nextAttempt < 1) {
    throw new RetryPolicyError([`nextAttempt must be an integer >= 1, got ${String(nextAttempt)}`]);
  }
  // Nothing waits before the first try.
  if (nextAttempt === 1) return 0;

  const step = nextAttempt - 1;
  const raw =
    policy.strategy === 'fixed'
      ? policy.baseDelayMs
      : policy.strategy === 'linear'
        ? policy.baseDelayMs * step
        : policy.baseDelayMs * policy.multiplier ** (step - 1);

  // Floor rather than round: a delay is a lower bound on waiting, and an
  // integer keeps the value comparable and loggable.
  return Math.min(Math.floor(raw), policy.maxDelayMs);
}

/**
 * The whole schedule a policy would produce, for inspection.
 *
 * Exported because a backoff curve is far easier to review as a list than as a
 * formula, and a policy nobody can picture is one nobody checks.
 */
export function backoffSchedule(policy: RetryPolicy, attempts: number): readonly number[] {
  return Array.from({ length: Math.max(0, attempts) }, (_, i) => backoffFor(policy, i + 1));
}
