/**
 * The idempotency store.
 *
 * ── Three states, and expiry is one of them ─────────────────────────────────
 *   pending   — a request holds the key and is in flight
 *   completed — a response is stored and will be replayed
 *   expired   — the window has passed; the key is free again
 *
 * `expired` is not a stored value: it is the ABSENCE of one, produced by
 * Redis's own TTL. A store that wrote an expired marker would need something to
 * sweep it, and a sweep that falls behind leaves keys that read as blocked long
 * after they should have been free.
 *
 * ── The claim is the exactly-once guarantee ─────────────────────────────────
 * `begin` is a single atomic script: claim the key if it is free, otherwise
 * return whatever is already there. Two concurrent duplicates cannot both
 * claim, so exactly one executes, and this is the only place that property
 * lives. A read followed by a write would let both see "free" — which is the
 * exact race a duplicate-charge bug is made of, and it only appears under the
 * concurrency that makes it expensive.
 *
 * ── Why a release exists ────────────────────────────────────────────────────
 * A handler that throws must not leave the key claimed for the whole window: a
 * client retrying a failed request would be refused for 24 hours over a
 * transient error. `release` frees the claim, and it is only ever called for a
 * request that produced no stored response.
 */

import type { RedisCommands } from '../ratelimit/redis-limiter.js';

/** `api-principles.md` §Idempotency — "Window | 24 hours". */
export const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

export const IDEMPOTENCY_NAMESPACE = 'idempotency';

/** A response, as it will be replayed. Headers are stored so the replay matches. */
export interface StoredResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

export type IdempotencyRecord =
  | { readonly state: 'pending'; readonly fingerprint: string }
  | {
      readonly state: 'completed';
      readonly fingerprint: string;
      readonly response: StoredResponse;
    };

export type BeginResult =
  | { readonly outcome: 'claimed' }
  | { readonly outcome: 'existing'; readonly record: IdempotencyRecord };

export interface IdempotencyStore {
  /** Atomically claim, or report what already holds the key. */
  begin(key: string, fingerprint: string): Promise<BeginResult>;
  complete(key: string, fingerprint: string, response: StoredResponse): Promise<void>;
  /** Free a claim that produced no response, so a retry is not blocked. */
  release(key: string): Promise<void>;
}

export class IdempotencyStoreUnavailableError extends Error {
  constructor(cause: unknown) {
    super('The idempotency store could not be reached.');
    this.name = 'IdempotencyStoreUnavailableError';
    this.cause = cause;
  }
}

/**
 * SET if absent, otherwise GET — in one atomic step.
 *
 * `SET NX` alone would tell us we lost the race but not what won it, and a
 * follow-up GET could observe a different value than the one that beat us.
 */
export const CLAIM_SCRIPT = `
local existing = redis.call('GET', KEYS[1])
if existing then
  return { 0, existing }
end
redis.call('SET', KEYS[1], ARGV[1], 'EX', tonumber(ARGV[2]))
return { 1, '' }
`.trim();

/**
 * Overwrite ONLY a claim we still hold, and only with a matching fingerprint.
 *
 * A completed record must not be overwritten by a late-arriving duplicate that
 * somehow reached the handler, and a key whose claim expired mid-flight must
 * not be resurrected as completed — the client has long since retried, and
 * storing a response for a key nobody is waiting on would replay stale output
 * to whoever holds the key next.
 */
export const COMPLETE_SCRIPT = `
local existing = redis.call('GET', KEYS[1])
if not existing then
  return 0
end
local record = cjson.decode(existing)
if record.state ~= 'pending' or record.fingerprint ~= ARGV[2] then
  return 0
end
redis.call('SET', KEYS[1], ARGV[1], 'EX', tonumber(ARGV[3]))
return 1
`.trim();

export const RELEASE_SCRIPT = `
local existing = redis.call('GET', KEYS[1])
if not existing then
  return 0
end
local record = cjson.decode(existing)
if record.state ~= 'pending' then
  return 0
end
redis.call('DEL', KEYS[1])
return 1
`.trim();

function segment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '');
}

/**
 * The key.
 *
 * Tenant-prefixed per `16-security/tenant-isolation.md`, and the workspace IS
 * the tenant (ADR-017). Two tenants using the same client-generated key
 * therefore address different records, which is what stops one tenant's retry
 * returning another's stored response.
 *
 * The client-supplied key is sanitised, not trusted: an unescaped separator in
 * it would let a caller address a prefix it was never scoped to.
 */
export function idempotencyKeyFor(workspaceId: string, key: string): string {
  return `cos:${segment(workspaceId)}:${IDEMPOTENCY_NAMESPACE}:${segment(key)}`;
}

function parseRecord(raw: string): IdempotencyRecord | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    const fingerprint = record['fingerprint'];
    if (typeof fingerprint !== 'string') return null;

    if (record['state'] === 'pending') return { state: 'pending', fingerprint };
    if (record['state'] === 'completed') {
      const response = record['response'];
      if (typeof response !== 'object' || response === null) return null;
      const stored = response as Record<string, unknown>;
      if (typeof stored['status'] !== 'number') return null;
      return {
        state: 'completed',
        fingerprint,
        response: {
          status: stored['status'],
          headers: (stored['headers'] ?? {}) as Readonly<Record<string, string>>,
          body: stored['body'],
        },
      };
    }
    return null;
  } catch {
    // A record we cannot read is treated as absent rather than as a blocker: a
    // corrupt value would otherwise refuse a legitimate request for 24 hours.
    return null;
  }
}

export interface RedisIdempotencyStoreOptions {
  readonly redis: RedisCommands;
  readonly ttlSeconds?: number;
}

export function createRedisIdempotencyStore(
  options: RedisIdempotencyStoreOptions,
): IdempotencyStore {
  const ttl = options.ttlSeconds ?? IDEMPOTENCY_TTL_SECONDS;

  async function evaluate(
    script: string,
    keys: readonly string[],
    args: readonly (string | number)[],
  ): Promise<unknown> {
    try {
      return await options.redis.eval(script, keys, args);
    } catch (failure) {
      throw new IdempotencyStoreUnavailableError(failure);
    }
  }

  return {
    async begin(key: string, fingerprint: string): Promise<BeginResult> {
      const raw = await evaluate(
        CLAIM_SCRIPT,
        [key],
        [JSON.stringify({ state: 'pending', fingerprint }), ttl],
      );

      if (!Array.isArray(raw) || raw.length < 2) {
        throw new IdempotencyStoreUnavailableError(
          new Error('The claim script returned an unexpected shape.'),
        );
      }
      const [claimed, existing] = raw as readonly unknown[];
      if (Number(claimed) === 1) return Object.freeze({ outcome: 'claimed' as const });

      const record = typeof existing === 'string' ? parseRecord(existing) : null;
      // An unreadable record is treated as a free key — see `parseRecord`.
      if (record === null) return Object.freeze({ outcome: 'claimed' as const });
      return Object.freeze({ outcome: 'existing' as const, record });
    },

    async complete(key: string, fingerprint: string, response: StoredResponse): Promise<void> {
      await evaluate(
        COMPLETE_SCRIPT,
        [key],
        [JSON.stringify({ state: 'completed', fingerprint, response }), fingerprint, ttl],
      );
    },

    async release(key: string): Promise<void> {
      await evaluate(RELEASE_SCRIPT, [key], []);
    },
  };
}
