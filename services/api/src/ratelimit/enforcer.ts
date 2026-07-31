/**
 * Applying the policies, and reporting the result.
 *
 * ── Every applicable policy is consumed, not just the first to refuse ───────
 * The policies are evaluated together and a request is denied if ANY of them
 * denies. All of them still record the request, because a request that reached
 * the server consumed capacity in every dimension it belongs to — and because
 * stopping at the first refusal would let a caller shield an expensive quota by
 * deliberately exhausting a cheap one first.
 *
 * ── The headers report the binding policy ───────────────────────────────────
 * `06-api/api-principles.md`: "Headers are returned on EVERY response, not only
 * on 429. A client that can see its remaining budget can pace itself; one that
 * discovers the limit by hitting it cannot." With five policies in play there
 * is one useful answer — the tightest — so the headers describe whichever has
 * least room, which is the one a client will hit first.
 *
 * ── An unreachable limiter refuses, by default ──────────────────────────────
 * The alternative, admitting everything while the store is down, is an
 * unbounded spending window on the most expensive endpoints in the platform:
 * `/v1/ai/execute` buys model calls, and nothing else between the edge and the
 * provider counts requests. A brief refusal is recoverable; an afternoon of
 * unmetered provider spend is not. It is a configured choice rather than a
 * hardcoded one, because a deployment whose traffic is all reads may prefer the
 * opposite.
 */

import type { RateLimitDecision, RateLimiter } from '../pipeline/stages.js';
import {
  policiesFor,
  rateLimitKey,
  type RateLimitClass,
  type RateLimitPolicy,
  type RateLimitSubject,
} from './policy.js';
import { RateLimiterUnavailableError } from './redis-limiter.js';

/** What to do when the limiter itself cannot answer. */
export const STORE_FAILURE_MODES = ['deny', 'allow'] as const;

export type StoreFailureMode = (typeof STORE_FAILURE_MODES)[number];

export const DEFAULT_STORE_FAILURE_MODE: StoreFailureMode = 'deny';

export type RateLimitOutcome =
  | {
      readonly outcome: 'allowed';
      readonly headers: Readonly<Record<string, string>>;
    }
  | {
      readonly outcome: 'limited';
      readonly headers: Readonly<Record<string, string>>;
      readonly retryAfterSeconds: number;
      /** For operators. Never returned to a caller. */
      readonly policy: string;
    }
  | { readonly outcome: 'unavailable' };

export interface RateLimitEnforcerOptions {
  readonly limiter: RateLimiter;
  readonly policies: readonly RateLimitPolicy[];
  /** Injected: `X-RateLimit-Reset` is an absolute time and needs a clock. */
  readonly now: () => Date;
  readonly onStoreFailure?: StoreFailureMode;
}

export interface RateLimitEnforcer {
  check(subject: RateLimitSubject, requestClass: RateLimitClass): Promise<RateLimitOutcome>;
}

interface Evaluated {
  readonly policy: RateLimitPolicy;
  readonly decision: RateLimitDecision;
}

/**
 * The tightest policy — least remaining, then furthest reset.
 *
 * Deterministic on purpose: with two policies equally close to their limit, a
 * client must not see the headers flip between them from one request to the
 * next, because the pacing it derives from them would oscillate.
 */
function binding(evaluated: readonly Evaluated[]): Evaluated {
  return [...evaluated].sort((left, right) => {
    if (left.decision.remaining !== right.decision.remaining) {
      return left.decision.remaining - right.decision.remaining;
    }
    if (left.decision.resetSeconds !== right.decision.resetSeconds) {
      return right.decision.resetSeconds - left.decision.resetSeconds;
    }
    return left.policy.name.localeCompare(right.policy.name);
  })[0] as Evaluated;
}

/**
 * The canonical headers.
 *
 * `X-RateLimit-Reset` is an absolute Unix timestamp in seconds, as the example
 * in `api-principles.md` shows — not a duration. A client comparing it to its
 * own clock needs an instant, and a duration would be stale by whatever the
 * response spent in flight.
 */
export function rateLimitHeaders(
  policy: RateLimitPolicy,
  decision: RateLimitDecision,
  now: Date,
): Readonly<Record<string, string>> {
  return Object.freeze({
    'x-ratelimit-limit': String(policy.limit),
    'x-ratelimit-remaining': String(decision.remaining),
    'x-ratelimit-reset': String(Math.floor(now.getTime() / 1000) + decision.resetSeconds),
  });
}

export function createRateLimitEnforcer(options: RateLimitEnforcerOptions): RateLimitEnforcer {
  const mode = options.onStoreFailure ?? DEFAULT_STORE_FAILURE_MODE;

  return {
    async check(
      subject: RateLimitSubject,
      requestClass: RateLimitClass,
    ): Promise<RateLimitOutcome> {
      const applicable = policiesFor(options.policies, requestClass);
      if (applicable.length === 0) {
        // Nothing configured for this class. Reported honestly rather than
        // with invented numbers: headers claiming a limit nothing enforces
        // would have clients pace themselves against a fiction.
        return Object.freeze({ outcome: 'allowed' as const, headers: Object.freeze({}) });
      }

      let evaluated: Evaluated[];
      try {
        evaluated = await Promise.all(
          applicable.map(async (policy) => ({
            policy,
            decision: await options.limiter.consume(
              rateLimitKey(policy, subject),
              policy.limit,
              policy.windowSeconds,
            ),
          })),
        );
      } catch (failure) {
        if (mode === 'allow' && failure instanceof RateLimiterUnavailableError) {
          return Object.freeze({ outcome: 'allowed' as const, headers: Object.freeze({}) });
        }
        return Object.freeze({ outcome: 'unavailable' as const });
      }

      const denied = evaluated.filter((entry) => !entry.decision.allowed);
      const now = options.now();

      if (denied.length > 0) {
        const tightest = binding(denied);
        return Object.freeze({
          outcome: 'limited' as const,
          headers: rateLimitHeaders(tightest.policy, tightest.decision, now),
          // At least a second: `Retry-After: 0` invites an immediate retry that
          // is refused again, which is a hot loop rather than back-off.
          retryAfterSeconds: Math.max(1, tightest.decision.resetSeconds),
          policy: tightest.policy.name,
        });
      }

      const tightest = binding(evaluated);
      return Object.freeze({
        outcome: 'allowed' as const,
        headers: rateLimitHeaders(tightest.policy, tightest.decision, now),
      });
    },
  };
}
