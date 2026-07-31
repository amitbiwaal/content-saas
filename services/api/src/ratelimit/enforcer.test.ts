import type { Principal } from '@contentos/security';
import { describe, expect, it } from 'vitest';

import type { RateLimiter } from '../pipeline/stages.js';
import { createRateLimitEnforcer, rateLimitHeaders } from './enforcer.js';
import { createFakeRedis } from './fake-redis.fixture.js';
import type { RateLimitPolicy, RateLimitSubject } from './policy.js';
import { createRedisRateLimiter, RateLimiterUnavailableError } from './redis-limiter.js';

const START = Date.UTC(2026, 6, 31, 12, 0, 0);
const NOW = new Date(START);

const principal = (overrides: Partial<Principal> = {}): Principal => ({
  subjectId: 'user-1',
  kind: 'user',
  method: 'password',
  organizationId: 'org-1',
  workspaceId: 'ws-1',
  roles: ['editor'],
  permissions: ['article:execute'],
  authenticatedAt: NOW,
  mfaSatisfied: true,
  sessionId: null,
  ...overrides,
});

const subject = (overrides: Partial<RateLimitSubject> = {}): RateLimitSubject => ({
  principal: principal(),
  apiKeyId: 'key-1',
  ipAddress: '198.51.100.4',
  ...overrides,
});

function enforcerWith(policies: readonly RateLimitPolicy[], clock = { ms: START }) {
  const redis = createFakeRedis({ now: () => clock.ms });
  return {
    redis,
    clock,
    enforcer: createRateLimitEnforcer({
      limiter: createRedisRateLimiter({ redis }),
      policies,
      now: () => new Date(clock.ms),
    }),
  };
}

describe('multiple independent policies', () => {
  const POLICIES: readonly RateLimitPolicy[] = [
    { name: 'per-user', scope: 'user', limit: 5, windowSeconds: 60 },
    { name: 'per-workspace', scope: 'workspace', limit: 3, windowSeconds: 60 },
    { name: 'per-org', scope: 'organization', limit: 10, windowSeconds: 60 },
  ];

  it('denies when the tightest policy is exhausted, even though others have room', async () => {
    const { enforcer } = enforcerWith(POLICIES);

    for (let i = 0; i < 3; i += 1) {
      expect((await enforcer.check(subject(), 'expensive')).outcome).toBe('allowed');
    }
    const limited = await enforcer.check(subject(), 'expensive');
    expect(limited).toMatchObject({ outcome: 'limited', policy: 'per-workspace' });
  });

  it('consumes every applicable policy, not only the first to refuse', async () => {
    // Stopping at the first refusal would let a caller shield an expensive
    // quota by deliberately exhausting a cheap one first.
    const { enforcer } = enforcerWith(POLICIES);

    for (let i = 0; i < 6; i += 1) await enforcer.check(subject(), 'expensive');

    // Six requests arrived; the per-user policy counted five of them and is now
    // exhausted too, even though the workspace policy refused from the fourth.
    const other = await enforcer.check(
      subject({ principal: principal({ workspaceId: 'ws-2' }) }),
      'expensive',
    );
    // A different workspace has its own bucket, but the same user and
    // organization do not — the user policy is spent.
    expect(other).toMatchObject({ outcome: 'limited', policy: 'per-user' });
  });

  it('counts separate users separately and one workspace together', async () => {
    const { enforcer } = enforcerWith([
      { name: 'per-user', scope: 'user', limit: 2, windowSeconds: 60 },
    ]);

    await enforcer.check(subject(), 'read');
    await enforcer.check(subject(), 'read');
    expect((await enforcer.check(subject(), 'read')).outcome).toBe('limited');

    const other = subject({ principal: principal({ subjectId: 'user-2' }) });
    expect((await enforcer.check(other, 'read')).outcome).toBe('allowed');
  });

  it('counts an API key separately from the user it acts as', async () => {
    const { enforcer } = enforcerWith([
      { name: 'per-key', scope: 'api-key', limit: 1, windowSeconds: 60 },
    ]);

    await enforcer.check(subject({ apiKeyId: 'key-1' }), 'read');
    expect((await enforcer.check(subject({ apiKeyId: 'key-1' }), 'read')).outcome).toBe('limited');
    expect((await enforcer.check(subject({ apiKeyId: 'key-2' }), 'read')).outcome).toBe('allowed');
  });

  it('counts an IP across tenants', async () => {
    const { enforcer } = enforcerWith([
      { name: 'per-ip', scope: 'ip', limit: 1, windowSeconds: 60 },
    ]);

    await enforcer.check(subject(), 'read');
    const elsewhere = subject({
      principal: principal({ workspaceId: 'ws-9', organizationId: 'org-9' }),
    });
    expect((await enforcer.check(elsewhere, 'read')).outcome).toBe('limited');
  });

  it('counts an organization across its workspaces', async () => {
    const { enforcer } = enforcerWith([
      { name: 'per-org', scope: 'organization', limit: 2, windowSeconds: 60 },
    ]);

    await enforcer.check(subject(), 'read');
    await enforcer.check(subject({ principal: principal({ workspaceId: 'ws-2' }) }), 'read');
    expect(
      (await enforcer.check(subject({ principal: principal({ workspaceId: 'ws-3' }) }), 'read'))
        .outcome,
    ).toBe('limited');
  });

  it('applies only the policies for the request class', async () => {
    const { enforcer } = enforcerWith([
      { name: 'spend', scope: 'user', limit: 1, windowSeconds: 60, appliesTo: 'expensive' },
      { name: 'reads', scope: 'user', limit: 9, windowSeconds: 60, appliesTo: 'read' },
    ]);

    await enforcer.check(subject(), 'expensive');
    expect((await enforcer.check(subject(), 'expensive')).outcome).toBe('limited');
    // Reading is untouched by an exhausted spend quota.
    expect((await enforcer.check(subject(), 'read')).outcome).toBe('allowed');
  });
});

describe('the canonical headers', () => {
  it('are returned on an allowed response, not only on a 429', async () => {
    // "A client that can see its remaining budget can pace itself; one that
    // discovers the limit by hitting it cannot."
    const { enforcer } = enforcerWith([
      { name: 'per-user', scope: 'user', limit: 5, windowSeconds: 60 },
    ]);

    const outcome = await enforcer.check(subject(), 'read');
    expect(outcome.outcome).toBe('allowed');
    if (outcome.outcome !== 'allowed') return;
    expect(outcome.headers).toEqual({
      'x-ratelimit-limit': '5',
      'x-ratelimit-remaining': '4',
      'x-ratelimit-reset': String(Math.floor(START / 1000) + 60),
    });
  });

  it('reports an absolute reset instant, not a duration', () => {
    // A duration would be stale by whatever the response spent in flight.
    const headers = rateLimitHeaders(
      { name: 'p', scope: 'user', limit: 10, windowSeconds: 60 },
      { allowed: true, remaining: 3, resetSeconds: 30 },
      NOW,
    );
    expect(headers['x-ratelimit-reset']).toBe(String(Math.floor(START / 1000) + 30));
  });

  it('describes the tightest policy, which is the one a client hits first', async () => {
    const { enforcer } = enforcerWith([
      { name: 'loose', scope: 'organization', limit: 100, windowSeconds: 60 },
      { name: 'tight', scope: 'workspace', limit: 4, windowSeconds: 60 },
    ]);

    const outcome = await enforcer.check(subject(), 'read');
    if (outcome.outcome !== 'allowed') throw new Error('expected allowed');
    expect(outcome.headers['x-ratelimit-limit']).toBe('4');
  });

  it('is stable between requests when two policies are equally close', async () => {
    // Headers that flipped between two equal policies would make the pacing a
    // client derives from them oscillate.
    const { enforcer } = enforcerWith([
      { name: 'b-policy', scope: 'user', limit: 5, windowSeconds: 60 },
      { name: 'a-policy', scope: 'workspace', limit: 5, windowSeconds: 60 },
    ]);

    const first = await enforcer.check(subject(), 'read');
    const second = await enforcer.check(subject(), 'read');
    if (first.outcome !== 'allowed' || second.outcome !== 'allowed') throw new Error('expected');
    expect(first.headers['x-ratelimit-limit']).toBe(second.headers['x-ratelimit-limit']);
  });

  it('carries a retry-after of at least a second on a refusal', async () => {
    const { enforcer } = enforcerWith([{ name: 'p', scope: 'user', limit: 1, windowSeconds: 60 }]);

    await enforcer.check(subject(), 'read');
    const limited = await enforcer.check(subject(), 'read');
    if (limited.outcome !== 'limited') throw new Error('expected limited');
    expect(limited.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(limited.headers['x-ratelimit-remaining']).toBe('0');
  });

  it('returns no headers when nothing is configured for the class', async () => {
    // Reported honestly rather than with invented numbers: headers claiming a
    // limit nothing enforces would have clients pace against a fiction.
    const { enforcer } = enforcerWith([
      { name: 'p', scope: 'user', limit: 1, windowSeconds: 60, appliesTo: 'auth' },
    ]);
    expect(await enforcer.check(subject(), 'read')).toEqual({ outcome: 'allowed', headers: {} });
  });
});

describe('when the limiter cannot be reached', () => {
  const POLICIES: readonly RateLimitPolicy[] = [
    { name: 'p', scope: 'user', limit: 5, windowSeconds: 60 },
  ];

  it('reports unavailable by default, rather than admitting silently', async () => {
    // Admitting everything while the store is down is an unbounded spending
    // window on the most expensive endpoints in the platform.
    const { redis, enforcer } = enforcerWith(POLICIES);
    redis.fail();

    expect(await enforcer.check(subject(), 'expensive')).toEqual({ outcome: 'unavailable' });
  });

  it('admits when a deployment has configured it to', async () => {
    const clock = { ms: START };
    const redis = createFakeRedis({ now: () => clock.ms });
    redis.fail();

    const enforcer = createRateLimitEnforcer({
      limiter: createRedisRateLimiter({ redis }),
      policies: POLICIES,
      now: () => new Date(clock.ms),
      onStoreFailure: 'allow',
    });

    expect(await enforcer.check(subject(), 'read')).toEqual({ outcome: 'allowed', headers: {} });
  });

  it('does not treat an unrelated failure as a store outage', async () => {
    // A programming error must not be quietly converted into "allow".
    const limiter: RateLimiter = {
      consume: () => Promise.reject(new TypeError('undefined is not a function')),
    };
    const enforcer = createRateLimitEnforcer({
      limiter,
      policies: POLICIES,
      now: () => NOW,
      onStoreFailure: 'allow',
    });

    expect(await enforcer.check(subject(), 'read')).toEqual({ outcome: 'unavailable' });
  });

  it('resumes counting from where it was once Redis returns', async () => {
    const { redis, enforcer } = enforcerWith([
      { name: 'p', scope: 'user', limit: 2, windowSeconds: 60 },
    ]);

    await enforcer.check(subject(), 'read');
    redis.fail();
    expect((await enforcer.check(subject(), 'read')).outcome).toBe('unavailable');

    redis.fail(null);
    expect((await enforcer.check(subject(), 'read')).outcome).toBe('allowed');
    expect((await enforcer.check(subject(), 'read')).outcome).toBe('limited');
  });

  it('surfaces the typed failure from the limiter itself', async () => {
    const { redis } = enforcerWith(POLICIES);
    redis.fail();
    const limiter = createRedisRateLimiter({ redis });
    await expect(limiter.consume('k', 1, 60)).rejects.toBeInstanceOf(RateLimiterUnavailableError);
  });
});
