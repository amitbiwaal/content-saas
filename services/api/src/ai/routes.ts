/**
 * The route table, and the one place authentication is applied.
 *
 * A table rather than a framework's decorators, for the same reason every other
 * control in this service is a plain function: the set of endpoints, the method
 * each accepts, the parameter each names AND THE PERMISSION EACH REQUIRES are
 * then values a test can assert over, instead of behaviour observable only by
 * sending a request. An endpoint that forgot its permission would not compile.
 *
 * ── The order is a security property ────────────────────────────────────────
 *   authenticate → resolve route → authorize → handler
 *
 * Authentication comes BEFORE routing, which is what `pipeline/order.ts`
 * already requires of validation and for the same reason: "validation errors
 * after authentication are not an unauthenticated probe of the API internal
 * shape." A 404 issued before a credential is checked tells anyone which paths
 * exist. Authorization comes after routing because the permission to require is
 * a property of the route.
 *
 * ── 405 and 404 are different answers ───────────────────────────────────────
 * A path that exists but was reached with the wrong method returns 405 and an
 * `Allow` header. Collapsing that into 404 would tell a client its URL was
 * wrong when its verb was, and is the kind of thing that costs an afternoon.
 */

import type { Permission } from '@contentos/security';

import type { AuthMiddleware } from '../auth/middleware.js';
import { requestIdsOf } from '../auth/middleware.js';
import { forbiddenResponse, unauthenticatedResponse } from '../auth/responses.js';
import { errorFor, type ApiRequest, type ApiResult, type AuthenticatedRequest } from './http.js';
import type { AiControllers } from './controllers.js';

export const AI_BASE_PATH = '/v1/ai';

export interface AiRoute {
  readonly method: 'GET' | 'POST';
  /** ':id' marks a parameter. */
  readonly pattern: string;
  readonly handler: keyof AiControllers;
  /** What a caller must hold. Checked by the middleware, never by the handler. */
  readonly permission: Permission;
}

/**
 * Every endpoint this service exposes, and what each one costs.
 *
 * The permissions come from the existing catalogue in `@contentos/security`;
 * none was invented here. Running a model is `article:execute`, which the
 * `editor` role carries and `contributor` does not — model spend is an
 * editorial act, not a drafting one. Reading a job or a workflow is `run:read`,
 * which every role down to `viewer` holds, because a caller that may not see
 * the status of work it started cannot use the API at all.
 *
 * `/v1/ai/health` requires `workspace:read` rather than being public: it
 * reports which providers are reachable, which is operational intelligence.
 * The unauthenticated liveness and readiness probes a scheduler needs already
 * exist separately in `health/endpoints.ts`.
 */
export const AI_ROUTES: readonly AiRoute[] = Object.freeze([
  {
    method: 'POST',
    pattern: '/v1/ai/execute',
    handler: 'execute',
    permission: 'article:execute',
  },
  { method: 'POST', pattern: '/v1/ai/stream', handler: 'stream', permission: 'article:execute' },
  { method: 'GET', pattern: '/v1/ai/jobs/:id', handler: 'job', permission: 'run:read' },
  {
    method: 'GET',
    pattern: '/v1/ai/workflows/:id',
    handler: 'workflow',
    permission: 'run:read',
  },
  {
    method: 'GET',
    pattern: '/v1/ai/providers',
    handler: 'listProviders',
    permission: 'workspace:read',
  },
  { method: 'GET', pattern: '/v1/ai/health', handler: 'health', permission: 'workspace:read' },
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
 * It authenticates, resolves a route, authorizes, and calls the controller with
 * an `AuthenticatedRequest`. It holds no endpoint-specific behaviour, which is
 * what keeps adding a seventh endpoint a change to the table above and nothing
 * else — including a change to what that endpoint requires, which is now
 * impossible to forget because `permission` is not optional.
 */
export function createAiRouter(
  controllers: AiControllers,
  auth: AuthMiddleware,
): (request: ApiRequest) => Promise<ApiResult> {
  return async function route(request: ApiRequest): Promise<ApiResult> {
    const { requestId } = requestIdsOf(request);

    // 1 · Authenticate FIRST — see the file header. Nothing about the API's
    //     shape is disclosed to a caller that has not proved who it is.
    const authenticated = await auth.authenticate(request);
    if (authenticated.outcome === 'failed') {
      return unauthenticatedResponse(authenticated.reason, requestId);
    }

    // 2 · Route, now that the caller is known.
    const resolved = resolveRoute(request.method, request.path);
    if (resolved === null) return errorFor(404, 'not_found', requestId);
    if (!('route' in resolved)) {
      return errorFor(405, 'method_not_allowed', requestId, undefined, {
        allow: resolved.allowed.join(', '),
      });
    }

    // 3 · Authorize against what THIS route requires.
    const decision = await auth.authorize(authenticated, request, resolved.route.permission);
    if (decision.outcome === 'denied') return forbiddenResponse(decision.reason, requestId);

    // 4 · Hand the controller a request it cannot have obtained any other way.
    const authenticatedRequest: AuthenticatedRequest = {
      ...request,
      params: { ...request.params, ...resolved.params },
      auth: decision.context,
    };
    return controllers[resolved.route.handler](authenticatedRequest);
  };
}
