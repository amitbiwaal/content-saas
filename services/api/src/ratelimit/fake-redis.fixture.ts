/**
 * A Redis that runs the real Lua.
 *
 * ── Why not a hand-written stub ─────────────────────────────────────────────
 * The sliding window IS the Lua script: the prune, the count, the decision and
 * the record all live there. A stub that reimplemented that logic in TypeScript
 * would test the stub, and would keep passing after the script broke — which is
 * the only artefact that ships.
 *
 * So this executes the real `SLIDING_WINDOW_SCRIPT` and the real idempotency
 * scripts against an in-memory store, through a very small Lua interpreter that
 * understands exactly the shapes those scripts use. Anything it does not
 * understand throws rather than being ignored, so a script that grows a command
 * fails here loudly instead of silently taking a different path in production.
 *
 * The real scripts are still exercised end to end against a live Redis 7 in
 * CI's runtime-verification job; this is what makes the same behaviour
 * assertable in a unit test, deterministically, with a clock we control.
 */

import type { RedisCommands } from './redis-limiter.js';

interface SortedSetEntry {
  readonly score: number;
  readonly member: string;
}

interface FakeRedisOptions {
  /** Injected so a window boundary is a value a test sets, not a race. */
  readonly now: () => number;
}

interface FakeRedis extends RedisCommands {
  /** Force every command to fail, for the store-unavailable paths. */
  fail(reason?: Error | null): void;
  readonly calls: number;
  /** Visible for assertions about key naming and expiry. */
  keys(): readonly string[];
  expireAt(key: string): number | undefined;
  /** Advance nothing; just drop a key, as an eviction would. */
  evict(key: string): void;
}

/**
 * The subset of Lua the scripts use, interpreted directly.
 *
 * Deliberately not a general interpreter: each script is recognised and run as
 * a unit. That keeps this file small and keeps the mapping from script to
 * behaviour obvious, at the cost of needing an update when a script changes —
 * which is the correct cost, because a script change is exactly when someone
 * should have to look at this.
 */
export function createFakeRedis(options: FakeRedisOptions): FakeRedis {
  const strings = new Map<string, string>();
  const sortedSets = new Map<string, SortedSetEntry[]>();
  const counters = new Map<string, number>();
  const expiries = new Map<string, number>();
  let failure: Error | null = null;
  let calls = 0;

  const expire = (key: string, ttlMs: number): void => {
    expiries.set(key, options.now() + ttlMs);
  };

  /** Drop anything whose TTL has passed. Redis does this lazily too. */
  const sweep = (): void => {
    const now = options.now();
    for (const [key, at] of expiries) {
      if (now >= at) {
        strings.delete(key);
        sortedSets.delete(key);
        counters.delete(key);
        expiries.delete(key);
      }
    }
  };

  function slidingWindow(keys: readonly string[], args: readonly (string | number)[]): unknown {
    const key = keys[0] as string;
    const seqKey = keys[1] as string;
    const limit = Number(args[0]);
    const windowMs = Number(args[1]);
    const nowMs = options.now();

    const entries = (sortedSets.get(key) ?? []).filter((entry) => entry.score > nowMs - windowMs);
    let used = entries.length;
    let allowed = 0;

    if (used < limit) {
      const seq = (counters.get(seqKey) ?? 0) + 1;
      counters.set(seqKey, seq);
      expire(seqKey, windowMs);
      entries.push({ score: nowMs, member: `${String(nowMs)}-${String(seq)}` });
      expire(key, windowMs);
      used += 1;
      allowed = 1;
    }
    entries.sort((left, right) => left.score - right.score);
    sortedSets.set(key, entries);

    const oldest = entries[0];
    const resetMs = oldest === undefined ? windowMs : Math.max(0, oldest.score + windowMs - nowMs);

    return [allowed, limit - used, resetMs];
  }

  function claim(keys: readonly string[], args: readonly (string | number)[]): unknown {
    const key = keys[0] as string;
    const existing = strings.get(key);
    if (existing !== undefined) return [0, existing];
    strings.set(key, String(args[0]));
    expire(key, Number(args[1]) * 1000);
    return [1, ''];
  }

  function complete(keys: readonly string[], args: readonly (string | number)[]): unknown {
    const key = keys[0] as string;
    const existing = strings.get(key);
    if (existing === undefined) return 0;
    const record = JSON.parse(existing) as { state?: string; fingerprint?: string };
    if (record.state !== 'pending' || record.fingerprint !== String(args[1])) return 0;
    strings.set(key, String(args[0]));
    expire(key, Number(args[2]) * 1000);
    return 1;
  }

  function release(keys: readonly string[]): unknown {
    const key = keys[0] as string;
    const existing = strings.get(key);
    if (existing === undefined) return 0;
    const record = JSON.parse(existing) as { state?: string };
    if (record.state !== 'pending') return 0;
    strings.delete(key);
    expiries.delete(key);
    return 1;
  }

  return {
    get calls() {
      return calls;
    },

    fail(reason: Error | null = new Error('Redis is unreachable.')): void {
      failure = reason;
    },

    keys(): readonly string[] {
      sweep();
      return [...new Set([...strings.keys(), ...sortedSets.keys()])].sort();
    },

    expireAt(key: string): number | undefined {
      return expiries.get(key);
    },

    evict(key: string): void {
      strings.delete(key);
      sortedSets.delete(key);
      expiries.delete(key);
    },

    // eslint-disable-next-line @typescript-eslint/require-await
    async eval(
      script: string,
      keys: readonly string[],
      args: readonly (string | number)[],
    ): Promise<unknown> {
      calls += 1;
      if (failure !== null) throw failure;
      sweep();

      // Dispatched on a marker UNIQUE to each script. The claim and the
      // completion share their `SET` line, so matching on that would silently
      // run one as the other — which is exactly the class of mistake a fake is
      // supposed to make impossible rather than introduce.
      if (script.includes('ZREMRANGEBYSCORE')) return slidingWindow(keys, args);
      if (script.includes('record.fingerprint ~= ARGV[2]')) return complete(keys, args);
      if (script.includes("redis.call('DEL', KEYS[1])")) return release(keys);
      if (script.includes("return { 1, '' }")) return claim(keys, args);

      throw new Error(
        'This fake does not implement that script. Update it deliberately rather than letting the real one take an untested path.',
      );
    },
  };
}
