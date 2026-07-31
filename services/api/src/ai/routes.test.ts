import { describe, expect, it } from 'vitest';

import type { AiControllers } from './controllers.js';
import { ok, type ApiRequest, type ApiResponse, type ErrorBody } from './http.js';
import { AI_ROUTES, createAiRouter, matchPattern, resolveRoute } from './routes.js';

const controllers = (): { readonly controllers: AiControllers; readonly seen: string[] } => {
  const seen: string[] = [];
  const record =
    (name: string) =>
    // eslint-disable-next-line @typescript-eslint/require-await
    async (request: ApiRequest): Promise<ApiResponse> => {
      seen.push(`${name}:${JSON.stringify(request.params)}`);
      return ok({ name });
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

const request = (method: string, path: string): ApiRequest => ({
  method,
  path,
  params: {},
  query: {},
  headers: { 'x-request-id': 'req-1' },
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
  it('calls the controller a route names, with the path parameters filled in', async () => {
    const { controllers: handlers, seen } = controllers();
    const route = createAiRouter(handlers);

    await route(request('GET', '/v1/ai/jobs/job-9'));
    expect(seen).toEqual(['job:{"id":"job-9"}']);
  });

  it('preserves parameters an adapter already extracted', async () => {
    const { controllers: handlers, seen } = controllers();
    const route = createAiRouter(handlers);

    await route({ ...request('GET', '/v1/ai/health'), params: { fromAdapter: 'kept' } });
    expect(seen).toEqual(['health:{"fromAdapter":"kept"}']);
  });

  it('returns 404 for an unknown path', async () => {
    const route = createAiRouter(controllers().controllers);
    const response = (await route(request('GET', '/v1/ai/nope'))) as ApiResponse;

    expect(response.status).toBe(404);
    expect((response.body as ErrorBody).error).toMatchObject({
      code: 'not_found',
      requestId: 'req-1',
    });
  });

  it('returns 405 with Allow when the path is right and the verb is not', async () => {
    // Collapsing this into a 404 would send a client looking at its URL.
    const route = createAiRouter(controllers().controllers);
    const response = (await route(request('DELETE', '/v1/ai/execute'))) as ApiResponse;

    expect(response.status).toBe(405);
    expect(response.headers['allow']).toBe('POST');
    expect((response.body as ErrorBody).error.code).toBe('method_not_allowed');
  });

  it('does not call any controller when it refuses', async () => {
    const { controllers: handlers, seen } = controllers();
    const route = createAiRouter(handlers);

    await route(request('GET', '/v1/ai/nope'));
    await route(request('PUT', '/v1/ai/health'));
    expect(seen).toEqual([]);
  });
});
