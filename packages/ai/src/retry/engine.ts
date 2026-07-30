/**
 * The retry engine — it decides, it never executes.
 *
 * Spec: `08-ai-platform/retry-strategy.md`. This component owns two questions:
 * *should this be retried at all?* and *when?* It does not own which model to
 * try, whether that model is healthy, or the act of dispatching.
 *
 * ── Deterministic by construction ───────────────────────────────────────────
 * Every function here is pure. No clock, no random source, no mutation; the
 * state advances by returning a new frozen value. A decision is therefore a
 * function of the attempt history and the policy alone — which is what makes
 * "why did it stop retrying?" answerable from the record rather than from a
 * reconstruction of the day.
 *
 * ── Every retry reuses the idempotency key ──────────────────────────────────
 * Held on the state rather than passed per call, because a retry that changed
 * the key would be a second generation the provider could not deduplicate and
 * the meter would count as new work. The key is the whole reason a retry after
 * an ambiguous timeout is safe.
 */

import { isProviderError, type ProviderError, type ProviderErrorCode } from '@contentos/contracts';

import { attemptsAllowed, backoffFor, DEFAULT_RETRY_POLICY, type RetryPolicy } from './policy.js';

/** One failed attempt, as it happened. */
export interface RetryAttempt {
  /** 1-based. The first call is attempt 1. */
  readonly attempt: number;
  readonly code: ProviderErrorCode;
  /** Whether the taxonomy says another attempt could survive this. */
  readonly retryable: boolean;
  /**
   * The provider's own `Retry-After`, where it gave one.
   *
   * Honoured over the computed backoff: the provider knows when it will be
   * ready and the formula is only a guess about it.
   */
  readonly retryAfterMs: number | null;
  readonly message: string;
}

export const RETRY_STATUSES = ['ready', 'retrying', 'succeeded', 'exhausted', 'terminal'] as const;

export type RetryStatus = (typeof RETRY_STATUSES)[number];

export function isRetryStatus(value: unknown): value is RetryStatus {
  return typeof value === 'string' && (RETRY_STATUSES as readonly string[]).includes(value);
}

/** Nothing leaves these: the call has an outcome. */
export const TERMINAL_RETRY_STATUSES: readonly RetryStatus[] = [
  'succeeded',
  'exhausted',
  'terminal',
];

export function isTerminalRetryStatus(status: RetryStatus): boolean {
  return TERMINAL_RETRY_STATUSES.includes(status);
}

export interface RetryState {
  /** Reused by every attempt. See the note at the top of the file. */
  readonly idempotencyKey: string;
  readonly status: RetryStatus;
  readonly attempts: readonly RetryAttempt[];
  readonly lastCode: ProviderErrorCode | null;
}

export type RetryAction = 'retry' | 'fail';

export const RETRY_REASONS = [
  'retryable-failure',
  'honouring-retry-after',
  'non-retryable-failure',
  'attempts-exhausted',
  'deadline-exceeded',
  'already-settled',
  'nothing-to-retry',
] as const;

export type RetryReason = (typeof RETRY_REASONS)[number];

export interface RetryDecision {
  readonly action: RetryAction;
  readonly reason: RetryReason;
  /** Which attempt a retry would be. Equal to attempts + 1. */
  readonly attempt: number;
  /** How long to wait first. Zero when the action is `fail`. */
  readonly delayMs: number;
  readonly code: ProviderErrorCode | null;
  /** Human-readable, for the record that explains why it stopped. */
  readonly detail: string;
}

export const RETRY_ERROR_CODES = ['AlreadySettled', 'InvalidAttempt'] as const;

export type RetryErrorCode = (typeof RETRY_ERROR_CODES)[number];

export class RetryError extends Error {
  readonly code: RetryErrorCode;

  constructor(code: RetryErrorCode, message: string) {
    super(message);
    this.name = 'RetryError';
    this.code = code;
  }
}

export function isRetryError(value: unknown): value is RetryError {
  return value instanceof RetryError;
}

function freeze(state: RetryState): RetryState {
  Object.freeze(state.attempts);
  for (const attempt of state.attempts) Object.freeze(attempt);
  return Object.freeze(state);
}

/** A call that has not been attempted yet. */
export function beginRetryState(idempotencyKey: string): RetryState {
  if (idempotencyKey.trim() === '') {
    throw new RetryError(
      'InvalidAttempt',
      'A retry state needs the idempotency key every attempt will reuse; without it a retry is a second generation.',
    );
  }
  return freeze({ idempotencyKey, status: 'ready', attempts: [], lastCode: null });
}

/**
 * Record a failure.
 *
 * Refused once the call has settled: appending to a succeeded or exhausted
 * state would let a late arrival rewrite an outcome that has already been
 * metered and reported.
 */
export function recordFailure(state: RetryState, error: ProviderError): RetryState {
  if (isTerminalRetryStatus(state.status)) {
    throw new RetryError(
      'AlreadySettled',
      `Cannot record a failure against a '${state.status}' call: the outcome for '${state.idempotencyKey}' is settled, and a late arrival must not rewrite it.`,
    );
  }
  if (!isProviderError(error)) {
    throw new RetryError(
      'InvalidAttempt',
      'A failure is recorded from a ProviderError; a raw vendor error has not been classified and cannot be decided on.',
    );
  }

  const attempt: RetryAttempt = {
    attempt: state.attempts.length + 1,
    code: error.code,
    retryable: error.retryable,
    retryAfterMs: error.retryAfterMs,
    message: error.message,
  };

  return freeze({
    ...state,
    status: 'retrying',
    attempts: [...state.attempts, attempt],
    lastCode: error.code,
  });
}

/**
 * Record success.
 *
 * Idempotent: recording it twice leaves the same state, because a redelivered
 * completion is the transport behaving correctly rather than a second success.
 */
export function recordSuccess(state: RetryState): RetryState {
  if (state.status === 'succeeded') return state;
  if (isTerminalRetryStatus(state.status)) {
    throw new RetryError(
      'AlreadySettled',
      `Cannot record success against a '${state.status}' call: '${state.idempotencyKey}' already ended the other way, and two outcomes for one call is a reconciliation problem.`,
    );
  }
  return freeze({ ...state, status: 'succeeded' });
}

export interface DecideOptions {
  readonly policy?: RetryPolicy;
  /**
   * The caller's remaining deadline, in milliseconds.
   *
   * Supplied rather than read from a clock, so the decision stays pure. When
   * given, a retry whose wait would exceed it is abandoned: retrying past a
   * deadline consumes budget and quota to produce a result nobody is waiting
   * for.
   */
  readonly remainingMs?: number;
}

const detailFor = (reason: RetryReason, state: RetryState, allowed: number): string => {
  const made = state.attempts.length;
  switch (reason) {
    case 'nothing-to-retry':
      return 'No attempt has failed, so there is nothing to decide about.';
    case 'already-settled':
      return `The call is '${state.status}'; its outcome is settled.`;
    case 'non-retryable-failure':
      return `'${String(state.lastCode)}' is not retryable: another attempt would fail the same way, and for a refusal or a malformed request it would also be wrong to try.`;
    case 'attempts-exhausted':
      return `${String(made)} of ${String(allowed)} attempts made for '${String(state.lastCode)}'.`;
    case 'deadline-exceeded':
      return 'The next attempt would finish after the caller stopped waiting.';
    case 'honouring-retry-after':
      return `The provider asked to be retried later; its own Retry-After is used over the computed backoff.`;
    case 'retryable-failure':
      return `Attempt ${String(made + 1)} of ${String(allowed)} for '${String(state.lastCode)}'.`;
  }
};

/**
 * Decide what happens next. Pure, and it executes nothing.
 *
 * The order is the one the spec implies and matters: a non-retryable class is
 * refused on its FIRST occurrence rather than after the whole backoff curve
 * reaches the same answer more slowly and more expensively.
 */
export function decideRetry(state: RetryState, options: DecideOptions = {}): RetryDecision {
  const policy = options.policy ?? DEFAULT_RETRY_POLICY;
  const made = state.attempts.length;
  const last = state.attempts[made - 1];

  const fail = (reason: RetryReason, allowed: number): RetryDecision =>
    Object.freeze({
      action: 'fail' as const,
      reason,
      attempt: made,
      delayMs: 0,
      code: state.lastCode,
      detail: detailFor(reason, state, allowed),
    });

  // A settled call has an answer. Deciding again must give the same one.
  if (isTerminalRetryStatus(state.status)) return fail('already-settled', 0);
  if (last === undefined) return fail('nothing-to-retry', policy.maxAttempts);

  const allowed = attemptsAllowed(policy, last.code);

  if (!last.retryable) return fail('non-retryable-failure', allowed);
  if (made >= allowed) return fail('attempts-exhausted', allowed);

  // The provider knows when it will be ready; the formula is a guess about it.
  const usingRetryAfter = last.retryAfterMs !== null;
  const delayMs = usingRetryAfter ? last.retryAfterMs : backoffFor(policy, made + 1);

  if (options.remainingMs !== undefined && delayMs > options.remainingMs) {
    return fail('deadline-exceeded', allowed);
  }

  const reason: RetryReason = usingRetryAfter ? 'honouring-retry-after' : 'retryable-failure';
  return Object.freeze({
    action: 'retry' as const,
    reason,
    attempt: made + 1,
    delayMs,
    code: last.code,
    detail: detailFor(reason, state, allowed),
  });
}

/**
 * Settle a state that has run out of road.
 *
 * Separate from `decideRetry` because deciding must not change anything — a
 * caller may ask twice and must get the same answer. This is the act that ends
 * it, and it is what makes a later `recordFailure` refuse.
 */
export function settle(state: RetryState, decision: RetryDecision): RetryState {
  if (decision.action === 'retry') return state;
  if (isTerminalRetryStatus(state.status)) return state;
  return freeze({
    ...state,
    status: decision.reason === 'attempts-exhausted' ? 'exhausted' : 'terminal',
  });
}

/** The attempt number a metering record for the next call would carry. */
export function nextAttemptNumber(state: RetryState): number {
  return state.attempts.length + 1;
}
