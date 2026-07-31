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
 *   authenticate → route → authorize → rate limit → idempotency → handler
 *
 * Authentication comes BEFORE routing, which is what `pipeline/order.ts`
 * already requires of validation and for the same reason: "validation errors
 * after authentication are not an unauthenticated probe of the API internal
 * shape." A 404 issued before a credential is checked tells anyone which paths
 * exist. Authorization comes after routing because the permission to require is
 * a property of the route.
 *
 * RATE LIMITING RUNS AFTER AUTHORIZATION, a deliberate departure from where
 * `pipeline/order.ts` places `rate-limit-post-auth`. Three of the five policies
 * count against a workspace or an organization, and until authorization has run
 * those are values a CALLER SENT. Counting against an unverified workspace id
 * would let anyone exhaust another tenant's quota by naming it in a header — a
 * denial of service handed out for free. After authorization they are records
 * the directory returned. The pre-auth IP limit that `order.ts` is really about
 * is `rateLimitPreAuth`, which is unchanged and still runs first.
 *
 * IDEMPOTENCY RUNS LAST, immediately before the handler, so a request that was
 * going to be refused anyway never consumes a key. A 429 that burned a client's
 * idempotency key would make the retry it is asking for impossible.
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
import {
  IDEMPOTENCY_KEY_HEADER,
  withIdempotencyKey,
  type IdempotencyGuard,
} from '../idempotency/guard.js';
import type { RateLimitEnforcer } from '../ratelimit/enforcer.js';
import type { RateLimitClass, RateLimitSubject } from '../ratelimit/policy.js';
import {
  errorFor,
  isStreamResponse,
  type ApiRequest,
  type ApiResult,
  type AuthenticatedRequest,
} from './http.js';
import type { AiControllers } from './controllers.js';

export const AI_BASE_PATH = '/v1/ai';

export interface AiRoute {
  readonly method: 'GET' | 'POST';
  /** ':id' marks a parameter. */
  readonly pattern: string;
  readonly handler: keyof AiControllers;
  /** What a caller must hold. Checked by the middleware, never by the handler. */
  readonly permission: Permission;
  /**
   * The rate-limit class, which `06-api/api-principles.md` requires every
   * endpoint to declare. Not optional, for the same reason `permission` is not:
   * an endpoint that forgot one would be limited by whatever policy happened to
   * apply to everything.
   */
  readonly rateLimitClass: RateLimitClass;
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
    // `expensive`, which api-principles.md defines as "pipeline runs, exports,
    // bulk operations". These two buy model calls; nothing else here spends.
    rateLimitClass: 'expensive',
  },
  {
    method: 'POST',
    pattern: '/v1/ai/stream',
    handler: 'stream',
    permission: 'article:execute',
    rateLimitClass: 'expensive',
  },
  {
    method: 'GET',
    pattern: '/v1/ai/jobs/:id',
    handler: 'job',
    permission: 'run:read',
    rateLimitClass: 'read',
  },
  {
    method: 'GET',
    pattern: '/v1/ai/workflows/:id',
    handler: 'workflow',
    permission: 'run:read',
    rateLimitClass: 'read',
  },
  {
    method: 'GET',
    pattern: '/v1/ai/providers',
    handler: 'listProviders',
    permission: 'workspace:read',
    rateLimitClass: 'read',
  },
  {
    method: 'GET',
    pattern: '/v1/ai/health',
    handler: 'health',
    permission: 'workspace:read',
    rateLimitClass: 'read',
  },
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
 * It authenticates, resolves a route, authorizes, limits, deduplicates, and
 * calls the controller with an `AuthenticatedRequest`. It holds no
 * endpoint-specific behaviour, which is what keeps adding a seventh endpoint a
 * change to the table above and nothing else — including what that endpoint
 * requires and what class it is limited under, neither of which is optional.
 */
export interface AiRouterOptions {
  readonly controllers: AiControllers;
  readonly auth: AuthMiddleware;
  readonly rateLimit: RateLimitEnforcer;
  readonly idempotency: IdempotencyGuard;
}

/** Attach headers to whichever shape the controller returned. */
function withHeaders(result: ApiResult, headers: Readonly<Record<string, string>>): ApiResult {
  if (Object.keys(headers).length === 0) return result;
  return Object.freeze({ ...result, headers: Object.freeze({ ...result.headers, ...headers }) });
}

export function createAiRouter(
  options: AiRouterOptions,
): (request: ApiRequest) => Promise<ApiResult> {
  const { controllers, auth, rateLimit, idempotency } = options;

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

    // 4 · Rate limit, now that the workspace and organization are RESOLVED.
    const subject: RateLimitSubject = {
      principal: decision.context.principal,
      apiKeyId: authenticated.subject.kind === 'api-key' ? authenticated.subject.subjectId : null,
      // The left-most entry is the client; the rest were added by proxies. An
      // empty string when nothing set it, which is a bucket of its own rather
      // than a hole in the policy.
      ipAddress: request.headers['x-forwarded-for']?.split(',')[0]?.trim() ?? '',
    };
    const limited = await rateLimit.check(subject, resolved.route.rateLimitClass);
    if (limited.outcome === 'unavailable') {
      return errorFor(503, 'service_unavailable', requestId, undefined, { 'retry-after': '1' });
    }
    if (limited.outcome === 'limited') {
      // The policy name is not returned. Which dimension bound is operational
      // detail, and disclosing it would let a caller probe for the loosest one.
      return errorFor(429, 'rate_limited', requestId, undefined, {
        ...limited.headers,
        'retry-after': String(limited.retryAfterSeconds),
      });
    }

    // 5 · Idempotency, last, so a refused request never consumes a key.
    const clientKey = request.headers[IDEMPOTENCY_KEY_HEADER]?.trim();
    const claim = await idempotency.begin({
      principal: decision.context.principal,
      method: request.method,
      // The PATTERN, not the URL: the scope is the endpoint, so two ids on one
      // endpoint cannot share a stored response.
      endpoint: resolved.route.pattern,
      body: request.body,
      clientKey: clientKey === undefined || clientKey === '' ? null : clientKey,
      requestId,
    });
    if (claim.outcome === 'replay' || claim.outcome === 'refused') {
      // Limit headers ride along: a client pacing itself needs them on every
      // response, including the ones it did not want.
      return withHeaders(claim.response, limited.headers);
    }

    // 6 · Hand the controller a request it cannot have obtained any other way.
    const authenticatedRequest: AuthenticatedRequest = {
      ...request,
      params: { ...request.params, ...resolved.params },
      auth: decision.context,
    };

    if (claim.outcome === 'skipped') {
      const result = await controllers[resolved.route.handler](authenticatedRequest);
      return withHeaders(result, limited.headers);
    }

    let result: ApiResult;
    try {
      result = await controllers[resolved.route.handler](authenticatedRequest);
    } catch (failure) {
      // A claim must not outlive a request that produced nothing, or a client
      // retrying a transient failure is refused for the whole 24-hour window.
      await idempotency.release(claim.storageKey);
      throw failure;
    }

    if (isStreamResponse(result)) {
      // A stream is not replayable without buffering the whole of it, and the
      // streaming framework already has the right mechanism for a dropped
      // connection: the resume cursor from S2.7. The claim is released, so a
      // duplicate arriving WHILE this one is in flight is still refused — the
      // property that matters — and a genuine retry afterwards may run.
      await idempotency.release(claim.storageKey);
      return withHeaders(result, limited.headers);
    }

    const withKey = withIdempotencyKey(result, claim.clientKey);
    await idempotency.complete(claim.storageKey, claim.fingerprint, withKey);
    return withHeaders(withKey, limited.headers);
  };
}
