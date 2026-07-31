import { describe, expect, it } from 'vitest';

import { createFakeRedis } from './fake-redis.fixture.js';
import { createRedisRateLimiter, RateLimiterUnavailableError } from './redis-limiter.js';

const START = Date.UTC(2026, 6, 31, 12, 0, 0);

function limiterAt(clock: { ms: number }) {
  const redis = createFakeRedis({ now: () => clock.ms });
  return { redis, limiter: createRedisRateLimiter({ redis }) };
}

describe('the sliding window', () => {
  it('permits exactly the limit inside one window', async () => {
    const clock = { ms: START };
    const { limiter } = limiterAt(clock);

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const decision = await limiter.consume('k', 3, 60);
      expect(decision.allowed, `attempt ${String(attempt)}`).toBe(true);
      expect(decision.remaining).toBe(3 - attempt);
    }
    await expect(limiter.consume('k', 3, 60)).resolves.toMatchObject({
      allowed: false,
      remaining: 0,
    });
  });

  it('does not record a request it refused', async () => {
    // A denied request costs nothing, which is what bounds the log at `limit`.
    const clock = { ms: START };
    const { limiter } = limiterAt(clock);

    await limiter.consume('k', 1, 60);
    await limiter.consume('k', 1, 60);
    await limiter.consume('k', 1, 60);

    // One second after the single recorded request leaves the window.
    clock.ms = START + 61_000;
    await expect(limiter.consume('k', 1, 60)).resolves.toMatchObject({ allowed: true });
  });

  it('slides — it does not reset on a fixed boundary', async () => {
    // The property a fixed-window counter lacks: at t=59 the earlier requests
    // are still inside the window, so the burst is refused rather than
    // forgiven by the clock ticking over.
    const clock = { ms: START };
    const { limiter } = limiterAt(clock);

    await limiter.consume('k', 2, 60);
    clock.ms = START + 30_000;
    await limiter.consume('k', 2, 60);

    clock.ms = START + 59_000;
    await expect(limiter.consume('k', 2, 60)).resolves.toMatchObject({ allowed: false });

    // Only the first has aged out here, so exactly one slot opens.
    clock.ms = START + 61_000;
    await expect(limiter.consume('k', 2, 60)).resolves.toMatchObject({ allowed: true });
    await expect(limiter.consume('k', 2, 60)).resolves.toMatchObject({ allowed: false });
  });

  it('reports when the window next frees a slot', async () => {
    const clock = { ms: START };
    const { limiter } = limiterAt(clock);

    await limiter.consume('k', 1, 60);
    clock.ms = START + 20_000;
    const decision = await limiter.consume('k', 1, 60);

    // The oldest entry is 20s old, so 40s remain before it leaves.
    expect(decision.allowed).toBe(false);
    expect(decision.resetSeconds).toBe(40);
  });

  it('rounds the reset UP, so a client that waits is past the boundary', async () => {
    const clock = { ms: START };
    const { limiter } = limiterAt(clock);

    await limiter.consume('k', 1, 60);
    clock.ms = START + 59_500;
    // 500ms remain; a client told to wait 0 seconds would retry into a refusal.
    expect((await limiter.consume('k', 1, 60)).resetSeconds).toBe(1);
  });

  it('counts each key independently', async () => {
    const clock = { ms: START };
    const { limiter } = limiterAt(clock);

    await limiter.consume('a', 1, 60);
    await expect(limiter.consume('b', 1, 60)).resolves.toMatchObject({ allowed: true });
    await expect(limiter.consume('a', 1, 60)).resolves.toMatchObject({ allowed: false });
  });

  it('never reports a negative budget when a limit is lowered mid-window', async () => {
    const clock = { ms: START };
    const { limiter } = limiterAt(clock);

    await limiter.consume('k', 5, 60);
    await limiter.consume('k', 5, 60);
    await limiter.consume('k', 5, 60);

    const decision = await limiter.consume('k', 2, 60);
    expect(decision.allowed).toBe(false);
    expect(decision.remaining).toBe(0);
  });

  it('expires its keys, so an idle bucket does not live forever', async () => {
    const clock = { ms: START };
    const { redis, limiter } = limiterAt(clock);

    await limiter.consume('k', 1, 60);
    expect(redis.keys()).toContain('k');

    clock.ms = START + 61_000;
    expect(redis.keys()).not.toContain('k');
  });
});

describe('requests arriving in the same millisecond', () => {
  it('counts every one of them', async () => {
    // The bug a naive score-as-member implementation has: two requests in one
    // millisecond write the same sorted-set member, the second ZADD overwrites
    // the first, and the limiter silently allows double the limit. It appears
    // only under the concurrency that makes a limiter matter.
    const clock = { ms: START };
    const { limiter } = limiterAt(clock);

    const decisions = await Promise.all([
      limiter.consume('k', 2, 60),
      limiter.consume('k', 2, 60),
      limiter.consume('k', 2, 60),
    ]);

    expect(decisions.filter((decision) => decision.allowed)).toHaveLength(2);
    expect(decisions.filter((decision) => !decision.allowed)).toHaveLength(1);
  });

  it('admits exactly the limit under a burst far larger than it', async () => {
    const clock = { ms: START };
    const { limiter } = limiterAt(clock);

    const decisions = await Promise.all(
      Array.from({ length: 50 }, () => limiter.consume('k', 7, 60)),
    );
    expect(decisions.filter((decision) => decision.allowed)).toHaveLength(7);
  });
});

describe('when Redis cannot answer', () => {
  it('raises a typed failure rather than guessing', async () => {
    const clock = { ms: START };
    const { redis, limiter } = limiterAt(clock);
    redis.fail();

    await expect(limiter.consume('k', 1, 60)).rejects.toBeInstanceOf(RateLimiterUnavailableError);
  });

  it('raises the same failure when the script returns something unexpected', async () => {
    const limiter = createRedisRateLimiter({
      redis: { eval: () => Promise.resolve('not an array') },
    });
    await expect(limiter.consume('k', 1, 60)).rejects.toBeInstanceOf(RateLimiterUnavailableError);
  });

  it('raises rather than trusting a non-numeric field', async () => {
    const limiter = createRedisRateLimiter({
      redis: { eval: () => Promise.resolve([1, 'lots', 'soon']) },
    });
    await expect(limiter.consume('k', 1, 60)).rejects.toBeInstanceOf(RateLimiterUnavailableError);
  });

  it('recovers as soon as Redis does, with the window intact', async () => {
    const clock = { ms: START };
    const { redis, limiter } = limiterAt(clock);

    await limiter.consume('k', 2, 60);
    redis.fail();
    await expect(limiter.consume('k', 2, 60)).rejects.toBeInstanceOf(RateLimiterUnavailableError);

    redis.fail(null);
    // The blip cost a request; the count it had already recorded survives it.
    await expect(limiter.consume('k', 2, 60)).resolves.toMatchObject({
      allowed: true,
      remaining: 0,
    });
  });

  it('accepts string replies, which is what a real driver returns', async () => {
    const limiter = createRedisRateLimiter({
      redis: { eval: () => Promise.resolve(['1', '4', '30000']) },
    });
    await expect(limiter.consume('k', 5, 60)).resolves.toEqual({
      allowed: true,
      remaining: 4,
      resetSeconds: 30,
    });
  });
});
