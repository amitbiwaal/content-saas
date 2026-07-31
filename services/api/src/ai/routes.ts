/**
 * The route table.
 *
 * A table rather than a framework's decorators, for the same reason every other
 * control in this service is a plain function: the set of endpoints, the method
 * each accepts and the parameter each names are then values that a test can
 * assert over, instead of behaviour observable only by sending a request.
 *
 * ── 405 and 404 are different answers ───────────────────────────────────────
 * A path that exists but was reached with the wrong method returns 405 and an
 * `Allow` header. Collapsing that into 404 would tell a client its URL was
 * wrong when its verb was, and is the kind of thing that costs an afternoon.
 */

import { errorFor, requestIdOf, type ApiRequest, type ApiResult } from './http.js';
import type { AiControllers } from './controllers.js';

export const AI_BASE_PATH = '/v1/ai';

export interface AiRoute {
  readonly method: 'GET' | 'POST';
  /** ':id' marks a parameter. */
  readonly pattern: string;
  readonly handler: keyof AiControllers;
}

/**
 * Every endpoint this increment exposes.
 *
 * The paths are the ones the increment names. `06-api/ai-api.md` specifies a
 * different, workspace-scoped surface for the customer-facing intent API
 * (`/v1/workspaces/{workspaceId}/ai/generate` and the canonical `Run`
 * resource); these are the platform-facing routes, and the divergence is
 * recorded in the deliverable rather than resolved unilaterally here.
 */
export const AI_ROUTES: readonly AiRoute[] = Object.freeze([
  { method: 'POST', pattern: '/v1/ai/execute', handler: 'execute' },
  { method: 'POST', pattern: '/v1/ai/stream', handler: 'stream' },
  { method: 'GET', pattern: '/v1/ai/jobs/:id', handler: 'job' },
  { method: 'GET', pattern: '/v1/ai/workflows/:id', handler: 'workflow' },
  { method: 'GET', pattern: '/v1/ai/providers', handler: 'listProviders' },
  { method: 'GET', pattern: '/v1/ai/health', handler: 'health' },
]);

const segmentsOf = (path: string): readonly string[] =>
  path
    .split('?')[0]
    ?.split('/')
    .filter((segment) => segment !== '') ?? [];

/** Match one pattern. Returns the captured parameters, or null. */
export function matchPattern(
  pattern: string,
  path: string,
): Readonly<Record<string, string>> | null {
  const expected = segmentsOf(pattern);
  const actual = segmentsOf(path);
  if (expected.length !== actual.length) return null;

  const params: Record<string, string> = {};
  for (let index = 0; index < expected.length; index += 1) {
    const want = expected[index] as string;
    const got = actual[index] as string;
    if (want.startsWith(':')) {
      // An empty parameter would make '/v1/ai/jobs//' match, and the read that
      // followed would be scoped by an empty id.
      if (got === '') return null;
      params[want.slice(1)] = got;
      continue;
    }
    if (want !== got) return null;
  }
  return Object.freeze(params);
}

export interface RouteMatch {
  readonly route: AiRoute;
  readonly params: Readonly<Record<string, string>>;
}

/** The route for a method and path, or why there is not one. */
export function resolveRoute(
  method: string,
  path: string,
): RouteMatch | { readonly allowed: readonly string[] } | null {
  const verb = method.toUpperCase();
  const pathMatches: AiRoute[] = [];

  for (const route of AI_ROUTES) {
    const params = matchPattern(route.pattern, path);
    if (params === null) continue;
    pathMatches.push(route);
    if (route.method === verb) return { route, params };
  }

  if (pathMatches.length === 0) return null;
  return { allowed: Object.freeze(pathMatches.map((route) => route.method)) };
}

/**
 * The single entry point a transport adapter binds to.
 *
 * It resolves a route, fills in the path parameters and calls the controller.
 * It contains no endpoint-specific behaviour, which is what keeps adding a
 * seventh endpoint a change to the table above and nothing else.
 */
export function createAiRouter(
  controllers: AiControllers,
): (request: ApiRequest) => Promise<ApiResult> {
  return async function route(request: ApiRequest): Promise<ApiResult> {
    const resolved = resolveRoute(request.method, request.path);
    if (resolved === null) return errorFor(404, 'not_found', requestIdOf(request));
    if (!('route' in resolved)) {
      return errorFor(405, 'method_not_allowed', requestIdOf(request), undefined, {
        allow: resolved.allowed.join(', '),
      });
    }

    const handler = controllers[resolved.route.handler];
    return handler({ ...request, params: { ...request.params, ...resolved.params } });
  };
}
