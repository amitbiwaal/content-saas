/**
 * The router with the real limiter and the real idempotency guard behind it.
 *
 * Where `routes.test.ts` checks the ordering with everything stubbed, this runs
 * the actual sliding window and the actual claim protocol through the actual
 * router. The properties that matter here — exactly-once under concurrency, a
 * refusal not consuming a key, headers on every response — are all EMERGENT
 * from how the pieces are wired, and none of them is visible in a unit test of
 * any one piece.
 */

import type { AuthContext, AuthenticationResult } from '@contentos/security';
import { describe, expect, it } from 'vitest';

import type { AuthMiddleware } from '../auth/middleware.js';
import { createIdempotencyGuard } from '../idempotency/guard.js';
import { createRedisIdempotencyStore } from '../idempotency/store.js';
import { createRateLimitEnforcer } from '../ratelimit/enforcer.js';
import { createFakeRedis } from '../ratelimit/fake-redis.fixture.js';
import type { RateLimitPolicy } from '../ratelimit/policy.js';
import { createRedisRateLimiter } from '../ratelimit/redis-limiter.js';
import type { AiControllers } from './controllers.js';
import {
  ok,
  type ApiRequest,
  type ApiResponse,
  type ApiResult,
  type AuthenticatedRequest,
  type ErrorBody,
} from './http.js';
import { createAiRouter } from './routes.js';

const START = Date.UTC(2026, 6, 31, 12, 0, 0);
const ORG = 'org-1';
const WS = 'ws-1';

const AUTH: AuthContext = Object.freeze({
  requestId: 'req-1',
  correlationId: 'corr-1',
  principal: Object.freeze({
    subjectId: 'user-1',
    kind: 'user' as const,
    method: 'password' as const,
    organizationId: ORG,
    workspaceId: WS,
    roles: Object.freeze(['editor' as const]),
    permissions: Object.freeze(['article:execute' as const, 'run:read' as const]),
    authenticatedAt: new Date(START),
    mfaSatisfied: true,
    sessionId: null,
  }),
  organization: Object.freeze({ id: ORG, status: 'active' }),
  workspace: Object.freeze({ id: WS, status: 'active' }),
});

const AUTHENTICATED: AuthenticationResult = {
  outcome: 'authenticated',
  subject: {
    subjectId: 'user-1',
    kind: 'user',
    authenticatedAt: new Date(START),
    method: 'password',
    mfaSatisfied: true,
    sessionId: null,
  },
  organizationId: null,
  workspaceId: null,
};

const auth = (context: AuthContext = AUTH): AuthMiddleware => ({
  authenticate: () => Promise.resolve(AUTHENTICATED),
  authorize: () => Promise.resolve({ outcome: 'authorized', context }),
});

interface Harness {
  readonly route: (request: ApiRequest) => Promise<ApiResult>;
  readonly executions: number[];
  readonly redis: ReturnType<typeof createFakeRedis>;
  readonly clock: { ms: number };
}

interface HarnessOptions {
  readonly policies?: readonly RateLimitPolicy[];
  readonly handler?: (request: AuthenticatedRequest, attempt: number) => Promise<ApiResult>;
  readonly context?: AuthContext;
}

function harness(options: HarnessOptions = {}): Harness {
  const clock = { ms: START };
  const redis = createFakeRedis({ now: () => clock.ms });
  const executions: number[] = [];

  const handler = async (request: AuthenticatedRequest): Promise<ApiResult> => {
    const attempt = executions.length + 1;
    executions.push(attempt);
    if (options.handler !== undefined) return options.handler(request, attempt);
    return Promise.resolve(ok({ ran: attempt }));
  };

  const controllers: AiControllers = {
    execute: handler as AiControllers['execute'],
    stream: handler,
    job: handler as AiControllers['job'],
    workflow: handler as AiControllers['workflow'],
    listProviders: handler as AiControllers['listProviders'],
    health: handler as AiControllers['health'],
  };

  return {
    clock,
    redis,
    executions,
    route: createAiRouter({
      controllers,
      auth: auth(options.context),
      rateLimit: createRateLimitEnforcer({
        limiter: createRedisRateLimiter({ redis }),
        policies: options.policies ?? [
          { name: 'per-user', scope: 'user', limit: 1000, windowSeconds: 60 },
        ],
        now: () => new Date(clock.ms),
      }),
      idempotency: createIdempotencyGuard({ store: createRedisIdempotencyStore({ redis }) }),
    }),
  };
}

const post = (key: string | null, body: unknown = { topic: 'espresso' }): ApiRequest => ({
  method: 'POST',
  path: '/v1/ai/execute',
  params: {},
  query: {},
  headers: {
    'x-request-id': 'req-1',
    authorization: 'Bearer token',
    'x-forwarded-for': '198.51.100.4',
    ...(key === null ? {} : { 'idempotency-key': key }),
  },
  body,
});

const get = (): ApiRequest => ({
  method: 'GET',
  path: '/v1/ai/providers',
  params: {},
  query: {},
  headers: { 'x-request-id': 'req-1', authorization: 'Bearer token' },
  body: null,
});

const asResponse = (result: ApiResult): ApiResponse => result as ApiResponse;

// ── Rate limiting through the router ─────────────────────────────────────────

describe('rate limiting, in the pipeline', () => {
  it('returns the canonical headers on a successful response', async () => {
    const { route } = harness({
      policies: [{ name: 'per-user', scope: 'user', limit: 10, windowSeconds: 60 }],
    });
    const response = asResponse(await route(get()));

    expect(response.status).toBe(200);
    expect(response.headers).toMatchObject({
      'x-ratelimit-limit': '10',
      'x-ratelimit-remaining': '9',
      'x-ratelimit-reset': String(Math.floor(START / 1000) + 60),
    });
  });

  it('returns 429 with Retry-After once the window is full', async () => {
    const { route, executions } = harness({
      policies: [{ name: 'per-user', scope: 'user', limit: 2, windowSeconds: 60 }],
    });

    await route(get());
    await route(get());
    const limited = asResponse(await route(get()));

    expect(limited.status).toBe(429);
    expect((limited.body as ErrorBody).error.code).toBe('rate_limited');
    expect(limited.headers['retry-after']).toBeDefined();
    expect(limited.headers['x-ratelimit-remaining']).toBe('0');
    // The refused request never reached a controller.
    expect(executions).toHaveLength(2);
  });

  it('says nothing about which policy bound', async () => {
    // Disclosing the dimension would let a caller probe for the loosest one.
    const { route } = harness({
      policies: [{ name: 'per-user-secret-policy', scope: 'user', limit: 1, windowSeconds: 60 }],
    });
    await route(get());
    const limited = asResponse(await route(get()));

    expect(JSON.stringify(limited.body)).not.toContain('per-user-secret-policy');
    expect(JSON.stringify(limited.body)).not.toContain('cos:');
    expect(JSON.stringify(limited.body)).not.toContain('user-1');
  });

  it('limits by class, so reads do not spend the expensive quota', async () => {
    const { route } = harness({
      policies: [
        { name: 'spend', scope: 'user', limit: 1, windowSeconds: 60, appliesTo: 'expensive' },
        { name: 'reads', scope: 'user', limit: 50, windowSeconds: 60, appliesTo: 'read' },
      ],
    });

    expect(asResponse(await route(post('a'))).status).toBe(200);
    expect(asResponse(await route(post('b'))).status).toBe(429);
    expect(asResponse(await route(get())).status).toBe(200);
  });

  it('refuses with 503 when the limiter cannot be reached', async () => {
    const { route, redis, executions } = harness();
    redis.fail();

    const response = asResponse(await route(get()));
    expect(response.status).toBe(503);
    expect((response.body as ErrorBody).error.code).toBe('service_unavailable');
    expect(response.headers['retry-after']).toBe('1');
    expect(executions).toHaveLength(0);
  });

  it('is applied only after authorization has resolved the tenant', async () => {
    // Keying a quota on an unverified workspace would let anyone exhaust
    // another tenant's budget by naming it in a header.
    const elsewhere: AuthContext = {
      ...AUTH,
      principal: { ...AUTH.principal, workspaceId: 'ws-2' },
      workspace: { id: 'ws-2', status: 'active' },
    };
    const shared = harness({
      policies: [{ name: 'per-workspace', scope: 'workspace', limit: 1, windowSeconds: 60 }],
    });
    const other = harness({
      policies: [{ name: 'per-workspace', scope: 'workspace', limit: 1, windowSeconds: 60 }],
      context: elsewhere,
    });

    await shared.route(get());
    // A different RESOLVED workspace has its own bucket; a header could not
    // have moved a request into it.
    expect(asResponse(await other.route(get())).status).toBe(200);
  });
});

// ── Idempotency through the router ───────────────────────────────────────────

describe('idempotency, in the pipeline', () => {
  it('executes once and replays the stored response', async () => {
    const { route, executions } = harness();

    const first = asResponse(await route(post('idem-1')));
    const second = asResponse(await route(post('idem-1')));

    expect(executions).toEqual([1]);
    expect(first.body).toEqual({ ran: 1 });
    expect(second.body).toEqual({ ran: 1 });
    expect(second.status).toBe(first.status);
  });

  it('marks the replay and echoes the key on both', async () => {
    const { route } = harness();

    const first = asResponse(await route(post('idem-1')));
    const second = asResponse(await route(post('idem-1')));

    expect(first.headers['idempotency-key']).toBe('idem-1');
    expect(first.headers['idempotent-replay']).toBeUndefined();
    expect(second.headers['idempotency-key']).toBe('idem-1');
    expect(second.headers['idempotent-replay']).toBe('true');
  });

  it('rejects the same key with a different payload, without executing', async () => {
    const { route, executions } = harness();

    await route(post('idem-1', { topic: 'espresso' }));
    const conflict = asResponse(await route(post('idem-1', { topic: 'tea' })));

    expect(conflict.status).toBe(409);
    expect((conflict.body as ErrorBody).error.code).toBe('idempotency_conflict');
    expect(executions).toEqual([1]);
  });

  it('replays regardless of how the client ordered the body', async () => {
    const { route, executions } = harness();

    await route(post('idem-1', { a: 1, b: 2 }));
    const second = asResponse(await route(post('idem-1', { b: 2, a: 1 })));

    expect(second.headers['idempotent-replay']).toBe('true');
    expect(executions).toEqual([1]);
  });

  it('runs a request with no key normally, every time', async () => {
    const { route, executions } = harness();

    await route(post(null));
    await route(post(null));
    expect(executions).toEqual([1, 2]);
  });

  it('carries rate limit headers on a replay too', async () => {
    // A client pacing itself needs them on every response, including the ones
    // it did not want.
    const { route } = harness({
      policies: [{ name: 'per-user', scope: 'user', limit: 10, windowSeconds: 60 }],
    });

    await route(post('idem-1'));
    const replay = asResponse(await route(post('idem-1')));
    expect(replay.headers['x-ratelimit-limit']).toBe('10');
  });

  it('does not consume a key on a request the limiter refused', async () => {
    // A 429 that burned the client's key would make the retry it is asking for
    // impossible. Idempotency therefore runs LAST, after the limiter.
    const { route, executions, clock } = harness({
      policies: [{ name: 'per-user', scope: 'user', limit: 1, windowSeconds: 60 }],
    });

    // Spend the single slot on an unkeyed read.
    expect(asResponse(await route(get())).status).toBe(200);
    expect(asResponse(await route(post('idem-1'))).status).toBe(429);
    // The refused POST reached no controller, so nothing was recorded for it.
    expect(executions).toEqual([1]);

    // Once the window frees, the key is still on its FIRST use — a replay here
    // would mean the 429 had consumed it.
    clock.ms += 61_000;
    const retried = asResponse(await route(post('idem-1')));
    expect(retried.status).toBe(200);
    expect(retried.headers['idempotent-replay']).toBeUndefined();
    expect(executions).toEqual([1, 2]);
  });

  it('frees the claim when the handler throws, so a retry is possible', async () => {
    let attempts = 0;
    const { route, executions } = harness({
      handler: (_request, attempt) => {
        attempts = attempt;
        if (attempt === 1) return Promise.reject(new Error('transient'));
        return Promise.resolve(ok({ ran: attempt }));
      },
    });

    await expect(route(post('idem-1'))).rejects.toThrow('transient');
    const retried = asResponse(await route(post('idem-1')));

    expect(retried.body).toEqual({ ran: 2 });
    expect(executions).toEqual([1, 2]);
    expect(attempts).toBe(2);
  });

  it('does not store a stream, and says so by letting a later retry run', async () => {
    // Replaying a stream would mean buffering the whole of it; the streaming
    // framework already has the right mechanism for a dropped connection.
    const streamed: ApiResult = {
      status: 200,
      headers: { 'content-type': 'application/x-ndjson' },
      // eslint-disable-next-line @typescript-eslint/require-await
      lines: {
        async *[Symbol.asyncIterator]() {
          yield 'x\n';
        },
      },
    };
    const { route, executions } = harness({ handler: () => Promise.resolve(streamed) });

    await route({ ...post('idem-1'), path: '/v1/ai/stream' });
    await route({ ...post('idem-1'), path: '/v1/ai/stream' });
    expect(executions).toEqual([1, 2]);
  });

  it('refuses with 503 when the store is down, rather than executing unguarded', async () => {
    // The fake fails every command, so the limiter would refuse first. Giving
    // it no policy for this class isolates the guard's own failure path, which
    // is the one under test: proceeding without a claim is how a retry storm
    // during a Redis blip becomes a duplicate charge.
    const { route, redis, executions } = harness({
      policies: [
        { name: 'auth-only', scope: 'user', limit: 1, windowSeconds: 60, appliesTo: 'auth' },
      ],
    });
    redis.fail();

    const response = asResponse(await route(post('idem-1')));
    expect(response.status).toBe(503);
    expect((response.body as ErrorBody).error.code).toBe('service_unavailable');
    expect(executions).toHaveLength(0);

    // And it recovers: the very next request, once Redis is back, executes.
    redis.fail(null);
    expect(asResponse(await route(post('idem-1'))).status).toBe(200);
    expect(executions).toEqual([1]);
  });
});

// ── Concurrency ──────────────────────────────────────────────────────────────

describe('concurrent duplicates', () => {
  it('execute exactly once, and the losers are told to retry', async () => {
    const { route, executions } = harness();

    const results = await Promise.all(Array.from({ length: 12 }, () => route(post('idem-1'))));
    const statuses = results.map((result) => asResponse(result).status);

    expect(executions).toEqual([1]);
    expect(statuses.filter((status) => status === 200)).toHaveLength(1);
    expect(statuses.filter((status) => status === 409)).toHaveLength(11);
    for (const result of results) {
      const response = asResponse(result);
      if (response.status !== 409) continue;
      expect((response.body as ErrorBody).error.code).toBe('idempotency_in_progress');
      expect(response.headers['retry-after']).toBe('1');
    }
  });

  it('lets a genuine retry replay once the first has completed', async () => {
    const { route, executions } = harness();

    await Promise.all(Array.from({ length: 5 }, () => route(post('idem-1'))));
    const later = asResponse(await route(post('idem-1')));

    expect(executions).toEqual([1]);
    expect(later.headers['idempotent-replay']).toBe('true');
    expect(later.body).toEqual({ ran: 1 });
  });

  it('keeps different keys independent under concurrency', async () => {
    const { route, executions } = harness();

    const results = await Promise.all([
      route(post('a')),
      route(post('b')),
      route(post('c')),
      route(post('a')),
    ]);

    expect(executions).toHaveLength(3);
    expect(results.map((r) => asResponse(r).status).filter((s) => s === 409)).toHaveLength(1);
  });

  it('admits exactly the limit when a burst races the limiter', async () => {
    const { route } = harness({
      policies: [{ name: 'per-user', scope: 'user', limit: 3, windowSeconds: 60 }],
    });

    const statuses = await Promise.all(
      Array.from({ length: 20 }, (_, index) => route(post(`key-${String(index)}`))),
    ).then((results) => results.map((r) => asResponse(r).status));

    expect(statuses.filter((status) => status === 200)).toHaveLength(3);
    expect(statuses.filter((status) => status === 429)).toHaveLength(17);
  });
});
