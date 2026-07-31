/**
 * The sliding window, in Redis.
 *
 * Implements the FROZEN `RateLimiter` port from `pipeline/stages.ts` — the same
 * `consume(key, limit, windowSeconds)` that `rateLimitPreAuth` and
 * `rateLimitPostAuth` already call. There is no second limiter interface, so a
 * caller cannot be looking at one contract while the enforcement uses another.
 *
 * ── A log, not an approximation ─────────────────────────────────────────────
 * The window is a sorted set of request timestamps: expired entries are dropped
 * and the survivors are counted. That is EXACT — the answer to "how many
 * requests in the last 60 seconds" is the real number, not a weighted blend of
 * two fixed buckets.
 *
 * The usual objection to a log is memory, and it is bounded here by the limit
 * itself: a key never holds more than `limit` members, because a request that
 * would exceed the limit is not recorded. A denied request costs nothing.
 *
 * ── One round trip, atomically ──────────────────────────────────────────────
 * Prune, count, decide and record happen inside one script. Split across
 * commands, two concurrent requests both read `used = limit - 1` and both
 * proceed — which is precisely the concurrency this exists to prevent, and it
 * appears only under the load that makes a limiter matter.
 *
 * ── The clock is REDIS's ────────────────────────────────────────────────────
 * `TIME` is read inside the script rather than passed in. Several API instances
 * with drifting clocks would otherwise disagree about where the window starts,
 * and the effective limit would depend on which instance a request landed on. A
 * caller-supplied timestamp is also something a caller could influence.
 */

import type { RateLimitDecision, RateLimiter } from '../pipeline/stages.js';

/**
 * The Redis commands this needs, and nothing more.
 *
 * A narrow port rather than the driver: `services/api` must not import
 * `ioredis` (the boundary rule in `events/bus/ioredis-client.ts` exists because
 * a raw client is also a way to reach unprefixed keys shared across tenants). A
 * composition root binds this to the managed client.
 */
export interface RedisCommands {
  eval(
    script: string,
    keys: readonly string[],
    args: readonly (string | number)[],
  ): Promise<unknown>;
}

export class RateLimiterUnavailableError extends Error {
  constructor(cause: unknown) {
    super('The rate limiter could not be reached.');
    this.name = 'RateLimiterUnavailableError';
    this.cause = cause;
  }
}

/**
 * Prune, count, decide, record — atomically.
 *
 * The member is `<millis>-<sequence>` where the sequence comes from Redis's own
 * INCR. Two requests in the same millisecond would otherwise write the same
 * member, and the second ZADD would overwrite the first rather than adding to
 * it — an undercount that appears exactly under concurrency.
 */
export const SLIDING_WINDOW_SCRIPT = `
local key = KEYS[1]
local seqKey = KEYS[2]
local limit = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])

local clock = redis.call('TIME')
local nowMs = (tonumber(clock[1]) * 1000) + math.floor(tonumber(clock[2]) / 1000)

redis.call('ZREMRANGEBYSCORE', key, '-inf', nowMs - windowMs)
local used = redis.call('ZCARD', key)
local allowed = 0

if used < limit then
  local seq = redis.call('INCR', seqKey)
  redis.call('PEXPIRE', seqKey, windowMs)
  redis.call('ZADD', key, nowMs, nowMs .. '-' .. seq)
  redis.call('PEXPIRE', key, windowMs)
  used = used + 1
  allowed = 1
end

local resetMs = windowMs
local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
if oldest[2] then
  resetMs = (tonumber(oldest[2]) + windowMs) - nowMs
  if resetMs < 0 then resetMs = 0 end
end

return { allowed, limit - used, resetMs }
`.trim();

function toNumber(value: unknown, field: string): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value);
  }
  throw new RateLimiterUnavailableError(
    new Error(`The limiter script returned a ${field} of ${String(value)}.`),
  );
}

export interface RedisRateLimiterOptions {
  readonly redis: RedisCommands;
}

/**
 * A limiter backed by Redis. No in-memory state: two API instances counting
 * separately would each allow the full limit, which is the whole reason the
 * counter is shared.
 */
export function createRedisRateLimiter(options: RedisRateLimiterOptions): RateLimiter {
  return {
    async consume(key: string, limit: number, windowSeconds: number): Promise<RateLimitDecision> {
      const windowMs = windowSeconds * 1000;

      let raw: unknown;
      try {
        raw = await options.redis.eval(
          SLIDING_WINDOW_SCRIPT,
          [key, `${key}:seq`],
          [limit, windowMs],
        );
      } catch (failure) {
        // Wrapped, never swallowed. Whether an unreachable limiter should admit
        // or refuse is a policy decision, and it belongs to the enforcer that
        // knows what the request would cost — not here.
        throw new RateLimiterUnavailableError(failure);
      }

      if (!Array.isArray(raw) || raw.length < 3) {
        throw new RateLimiterUnavailableError(
          new Error('The limiter script returned an unexpected shape.'),
        );
      }

      const [allowed, remaining, resetMs] = raw as readonly unknown[];
      return Object.freeze({
        allowed: toNumber(allowed, 'verdict') === 1,
        // Never negative: a limit lowered while a window is in flight would
        // otherwise report a negative budget, which no client renders sensibly.
        remaining: Math.max(0, toNumber(remaining, 'remaining')),
        // Rounded UP, so a client that waits exactly this long is past the
        // boundary rather than one millisecond short of it.
        resetSeconds: Math.max(0, Math.ceil(toNumber(resetMs, 'reset') / 1000)),
      });
    },
  };
}
