import type { AuthContext, AuthenticationResult, AuthorizationResult } from '@contentos/security';
import { describe, expect, it } from 'vitest';

import type { AuthMiddleware } from '../auth/middleware.js';
import { createIdempotencyGuard, type IdempotencyGuard } from '../idempotency/guard.js';
import { createRedisIdempotencyStore } from '../idempotency/store.js';
import { createRateLimitEnforcer, type RateLimitEnforcer } from '../ratelimit/enforcer.js';
import { createFakeRedis } from '../ratelimit/fake-redis.fixture.js';
import { createRedisRateLimiter } from '../ratelimit/redis-limiter.js';
import type { AiControllers } from './controllers.js';
import {
  ok,
  type ApiRequest,
  type ApiResponse,
  type AuthenticatedRequest,
  type ErrorBody,
} from './http.js';
import { AI_ROUTES, createAiRouter, matchPattern, resolveRoute } from './routes.js';

const ORG = '11111111-1111-4111-8111-111111111111';
const WORKSPACE = '22222222-2222-4222-8222-222222222222';

const AUTH: AuthContext = Object.freeze({
  requestId: 'req-1',
  correlationId: 'corr-1',
  principal: Object.freeze({
    subjectId: 'user-1',
    kind: 'user' as const,
    method: 'password' as const,
    organizationId: ORG,
    workspaceId: WORKSPACE,
    roles: Object.freeze(['editor' as const]),
    permissions: Object.freeze(['article:execute' as const]),
    authenticatedAt: new Date('2026-07-31T00:00:00.000Z'),
    mfaSatisfied: true,
    sessionId: null,
  }),
  organization: Object.freeze({ id: ORG, status: 'active' }),
  workspace: Object.freeze({ id: WORKSPACE, status: 'active' }),
});

const AUTHENTICATED: AuthenticationResult = {
  outcome: 'authenticated',
  subject: {
    subjectId: 'user-1',
    kind: 'user',
    authenticatedAt: new Date('2026-07-31T00:00:00.000Z'),
    method: 'password',
    mfaSatisfied: true,
    sessionId: null,
  },
  organizationId: null,
  workspaceId: null,
};

interface Recorded {
  readonly controllers: AiControllers;
  readonly seen: string[];
}

const controllers = (): Recorded => {
  const seen: string[] = [];
  const record =
    (name: string) =>
    (request: AuthenticatedRequest): Promise<ApiResponse> => {
      seen.push(`${name}:${JSON.stringify(request.params)}:${request.auth.principal.workspaceId}`);
      return Promise.resolve(ok({ name }));
    };
  return {
    seen,
    controllers: {
      execute: record('execute'),
      stream: record('stream'),
      job: record('job'),
      workflow: record('workflow'),
      listProviders: record('listProviders'),
      health: record('health'),
    },
  };
};

interface AuthCalls {
  readonly middleware: AuthMiddleware;
  readonly permissions: string[];
}

function middlewareThat(
  authentication: AuthenticationResult = AUTHENTICATED,
  authorization: AuthorizationResult = { outcome: 'authorized', context: AUTH },
): AuthCalls {
  const permissions: string[] = [];
  return {
    permissions,
    middleware: {
      authenticate: () => Promise.resolve(authentication),
      authorize: (_authenticated, _request, permission) => {
        permissions.push(permission);
        return Promise.resolve(authorization);
      },
    },
  };
}

const START = Date.UTC(2026, 6, 31, 12, 0, 0);

/** Everything a router needs, with the limiter and the guard wide open. */
function collaborators(limit = 1000): {
  rateLimit: RateLimitEnforcer;
  idempotency: IdempotencyGuard;
} {
  const redis = createFakeRedis({ now: () => START });
  return {
    rateLimit: createRateLimitEnforcer({
      limiter: createRedisRateLimiter({ redis }),
      policies: [{ name: 'per-user', scope: 'user', limit, windowSeconds: 60 }],
      now: () => new Date(START),
    }),
    idempotency: createIdempotencyGuard({ store: createRedisIdempotencyStore({ redis }) }),
  };
}

function router(
  handlers: AiControllers,
  middleware: AuthMiddleware,
  over: Partial<{ rateLimit: RateLimitEnforcer; idempotency: IdempotencyGuard }> = {},
): (
  r: ApiRequest,
) => Promise<ApiResponse | { readonly headers: Readonly<Record<string, string>> }> {
  return createAiRouter({
    controllers: handlers,
    auth: middleware,
    ...collaborators(),
    ...over,
  }) as (r: ApiRequest) => Promise<ApiResponse>;
}

const request = (method: string, path: string): ApiRequest => ({
  method,
  path,
  params: {},
  query: {},
  headers: { 'x-request-id': 'req-1', authorization: 'Bearer token' },
  body: null,
});

describe('the route table', () => {
  it('exposes exactly the six endpoints of this increment', () => {
    expect(AI_ROUTES.map((route) => `${route.method} ${route.pattern}`)).toEqual([
      'POST /v1/ai/execute',
      'POST /v1/ai/stream',
      'GET /v1/ai/jobs/:id',
      'GET /v1/ai/workflows/:id',
      'GET /v1/ai/providers',
      'GET /v1/ai/health',
    ]);
  });

  it('names a controller that exists for every route', () => {
    const { controllers: handlers } = controllers();
    for (const route of AI_ROUTES) {
      expect(typeof handlers[route.handler]).toBe('function');
    }
  });

  it('declares a permission for every route, so none can be reached unguarded', () => {
    for (const route of AI_ROUTES) {
      expect(route.permission, route.pattern).toMatch(/^[a-z]+:[a-z]+$/);
    }
  });

  it('requires execute permission to spend on a model, and read to look', () => {
    const required = Object.fromEntries(AI_ROUTES.map((r) => [r.pattern, r.permission]));
    expect(required['/v1/ai/execute']).toBe('article:execute');
    expect(required['/v1/ai/stream']).toBe('article:execute');
    expect(required['/v1/ai/jobs/:id']).toBe('run:read');
    expect(required['/v1/ai/workflows/:id']).toBe('run:read');
  });

  it('declares a rate-limit class for every route, as api-principles requires', () => {
    const classes = Object.fromEntries(AI_ROUTES.map((r) => [r.pattern, r.rateLimitClass]));
    // The two that buy model calls are `expensive`; the rest are reads.
    expect(classes['/v1/ai/execute']).toBe('expensive');
    expect(classes['/v1/ai/stream']).toBe('expensive');
    for (const route of AI_ROUTES.filter((r) => r.method === 'GET')) {
      expect(route.rateLimitClass, route.pattern).toBe('read');
    }
  });
});

describe('matching a pattern', () => {
  it('matches a static path exactly', () => {
    expect(matchPattern('/v1/ai/health', '/v1/ai/health')).toEqual({});
    expect(matchPattern('/v1/ai/health', '/v1/ai/healthz')).toBeNull();
  });

  it('captures a parameter', () => {
    expect(matchPattern('/v1/ai/jobs/:id', '/v1/ai/jobs/job-1')).toEqual({ id: 'job-1' });
  });

  it('ignores a query string', () => {
    expect(matchPattern('/v1/ai/stream', '/v1/ai/stream?resumeToken=x')).toEqual({});
  });

  it('tolerates a trailing slash', () => {
    expect(matchPattern('/v1/ai/health', '/v1/ai/health/')).toEqual({});
  });

  it('refuses an empty parameter, which would scope a read by an empty id', () => {
    expect(matchPattern('/v1/ai/jobs/:id', '/v1/ai/jobs/')).toBeNull();
    expect(matchPattern('/v1/ai/jobs/:id', '/v1/ai/jobs//')).toBeNull();
  });

  it('refuses a path of the wrong length', () => {
    expect(matchPattern('/v1/ai/jobs/:id', '/v1/ai/jobs/job-1/events')).toBeNull();
    expect(matchPattern('/v1/ai/jobs/:id', '/v1/ai')).toBeNull();
  });
});

describe('resolving a route', () => {
  it('finds the handler and the parameters', () => {
    expect(resolveRoute('GET', '/v1/ai/workflows/w-1')).toEqual({
      route: AI_ROUTES[3],
      params: { id: 'w-1' },
    });
  });

  it('is case-insensitive about the method', () => {
    expect(resolveRoute('post', '/v1/ai/execute')).toMatchObject({ route: AI_ROUTES[0] });
  });

  it('reports the allowed methods when only the verb is wrong', () => {
    expect(resolveRoute('GET', '/v1/ai/execute')).toEqual({ allowed: ['POST'] });
  });

  it('returns nothing for a path it does not serve', () => {
    expect(resolveRoute('GET', '/v1/ai/nope')).toBeNull();
    expect(resolveRoute('GET', '/v1/workspaces/x/ai/generate')).toBeNull();
  });
});

describe('the router', () => {
  it('calls the controller with the path parameters and the authenticated context', async () => {
    const { controllers: handlers, seen } = controllers();
    const route = router(handlers, middlewareThat().middleware);

    await route(request('GET', '/v1/ai/jobs/job-9'));
    expect(seen).toEqual([`job:{"id":"job-9"}:${WORKSPACE}`]);
  });

  it('authorizes against the permission the route declares', async () => {
    const auth = middlewareThat();
    const route = router(controllers().controllers, auth.middleware);

    await route(request('POST', '/v1/ai/execute'));
    await route(request('GET', '/v1/ai/jobs/j'));
    expect(auth.permissions).toEqual(['article:execute', 'run:read']);
  });

  it('preserves parameters an adapter already extracted', async () => {
    const { controllers: handlers, seen } = controllers();
    const route = router(handlers, middlewareThat().middleware);

    await route({ ...request('GET', '/v1/ai/health'), params: { fromAdapter: 'kept' } });
    expect(seen).toEqual([`health:{"fromAdapter":"kept"}:${WORKSPACE}`]);
  });

  it('returns 401 before disclosing whether a path exists', async () => {
    // Routing after authentication is the property: an unauthenticated caller
    // learns nothing about the API shape, not even which URLs are real.
    const auth = middlewareThat({ outcome: 'failed', reason: 'missing' });
    const route = router(controllers().controllers, auth.middleware);

    const real = (await route(request('GET', '/v1/ai/health'))) as ApiResponse;
    const fake = (await route(request('GET', '/v1/ai/nope'))) as ApiResponse;

    expect(real.status).toBe(401);
    expect(fake.status).toBe(401);
    expect(real.body).toEqual(fake.body);
  });

  it('carries a challenge on every 401', async () => {
    const auth = middlewareThat({ outcome: 'failed', reason: 'expired' });
    const route = router(controllers().controllers, auth.middleware);
    const response = (await route(request('GET', '/v1/ai/health'))) as ApiResponse;

    expect(response.headers['www-authenticate']).toContain('Bearer');
    expect((response.body as ErrorBody).error).toMatchObject({
      code: 'unauthenticated',
      requestId: 'req-1',
    });
  });

  it('returns 403 when authenticated but not permitted', async () => {
    const auth = middlewareThat(AUTHENTICATED, {
      outcome: 'denied',
      reason: 'insufficient-permission',
    });
    const route = router(controllers().controllers, auth.middleware);
    const response = (await route(request('POST', '/v1/ai/execute'))) as ApiResponse;

    expect(response.status).toBe(403);
    expect((response.body as ErrorBody).error.code).toBe('forbidden');
  });

  it('does not authorize a route that does not exist', async () => {
    const auth = middlewareThat();
    const route = router(controllers().controllers, auth.middleware);

    const response = (await route(request('GET', '/v1/ai/nope'))) as ApiResponse;
    expect(response.status).toBe(404);
    expect(auth.permissions).toEqual([]);
  });

  it('returns 405 with Allow when the path is right and the verb is not', async () => {
    // Collapsing this into a 404 would send a client looking at its URL.
    const route = router(controllers().controllers, middlewareThat().middleware);
    const response = (await route(request('DELETE', '/v1/ai/execute'))) as ApiResponse;

    expect(response.status).toBe(405);
    expect(response.headers['allow']).toBe('POST');
    expect((response.body as ErrorBody).error.code).toBe('method_not_allowed');
  });

  it('does not call any controller when it refuses, at any stage', async () => {
    const { controllers: handlers, seen } = controllers();

    await router(handlers, middlewareThat().middleware)(request('GET', '/v1/ai/nope'));
    await router(handlers, middlewareThat().middleware)(request('PUT', '/v1/ai/health'));
    await router(
      handlers,
      middlewareThat({ outcome: 'failed', reason: 'invalid' }).middleware,
    )(request('GET', '/v1/ai/health'));
    await router(
      handlers,
      middlewareThat(AUTHENTICATED, { outcome: 'denied', reason: 'membership-required' })
        .middleware,
    )(request('POST', '/v1/ai/execute'));

    expect(seen).toEqual([]);
  });
});
