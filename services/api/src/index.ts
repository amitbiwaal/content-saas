/**
 * `services/api` — the ONLY inbound network surface.
 *
 * Platform middleware only: no business endpoints, no feature APIs, no provider
 * SDKs, no business logic. Specified by `16-security/api-security.md` and
 * `14-operations/monitoring.md` §9.
 */

export type { StageName } from './pipeline/order.js';
export {
  assertPipelineOrder,
  ORDER_INVARIANTS,
  PIPELINE_ORDER,
  PRE_BODY_STAGES,
  stageIndex,
} from './pipeline/order.js';

export type {
  ErrorResponse,
  PipelineRequest,
  RateLimitConfig,
  RateLimitDecision,
  RateLimiter,
  SchemaValidator,
  StageOutcome,
  ValidationIssue,
} from './pipeline/stages.js';
export {
  checkCsrf,
  checkSizeLimits,
  CSRF_COOKIE,
  CSRF_HEADER,
  exceedsNestingDepth,
  isUuid,
  proceed,
  rateLimitPostAuth,
  rateLimitPreAuth,
  SECURITY_HEADERS,
  SIZE_LIMITS,
  toErrorResponse,
  validateRequest,
} from './pipeline/stages.js';

export type {
  PipelineHooks,
  PipelineResult,
  RequestIdentity,
  ResolvedResource,
} from './pipeline/runner.js';
export { runPipeline } from './pipeline/runner.js';

// Event registry composition root — one registry per process, built at startup.
export { API_REGISTRY_CONTRIBUTIONS, createApiEventRegistry } from './events/registry.js';

export type { HealthHttpResponse, StartupState } from './health/endpoints.js';
export {
  HEALTH_PATHS,
  isHealthPath,
  live,
  ready,
  startup,
  StartupTracker,
} from './health/endpoints.js';

// The AI REST layer — transport over the Gateway (S3.1). Controllers validate
// HTTP, call `Gateway.admit`, and map the answer. No business logic.
export type {
  ApiErrorCode,
  ApiRequest,
  ApiResponse,
  ApiResult,
  ApiStreamResponse,
  AuthenticatedRequest,
  ErrorBody,
} from './ai/http.js';
export { API_ERROR_MESSAGES, errorFor, isStreamResponse, ok } from './ai/http.js';

// Authentication and authorization — the middleware every request passes
// through before a controller sees it. Ports only; a composition root binds
// them (`auth/ports.ts`).
export type {
  ApiKeyDirectory,
  DirectoryOrganization,
  DirectoryWorkspace,
  IdentityDirectory,
  TokenVerifier,
} from './auth/ports.js';
export type { AuthMiddleware, AuthMiddlewareOptions } from './auth/middleware.js';
export {
  ACCESSIBLE_WORKSPACE_STATUS,
  BARRING_ORGANIZATION_STATUS,
  createAuthMiddleware,
  presentedCredential,
  requestIdsOf,
  WORKSPACE_HEADER,
} from './auth/middleware.js';
export { forbiddenResponse, unauthenticatedResponse, WWW_AUTHENTICATE } from './auth/responses.js';

export type { ScopedRead, ValidationOutcome } from './ai/validation.js';
export { readResumeToken, toGatewayRequest, toScopedRead } from './ai/validation.js';

export type { AiDispatcher, JobReader, WorkflowReader } from './ai/ports.js';

export type { DispatcherOptions } from './ai/dispatch.js';
export { createProviderDispatcher } from './ai/dispatch.js';

export type { AiControllerOptions, AiControllers } from './ai/controllers.js';
export { createAiControllers, failureResponse, rejectionResponse } from './ai/controllers.js';

export type { AiRoute, AiRouterOptions, RouteMatch } from './ai/routes.js';
export {
  AI_BASE_PATH,
  AI_ROUTES,
  createAiRouter,
  matchPattern,
  resolveRoute,
} from './ai/routes.js';

// Rate limiting — the sliding window, its policies, and their enforcement.
// Implements the FROZEN `RateLimiter` port from `pipeline/stages.ts`; there is
// no second limiter interface.
export type {
  RateLimitClass,
  RateLimitPolicy,
  RateLimitScope,
  RateLimitSubject,
} from './ratelimit/policy.js';
export {
  createPolicySet,
  isRateLimitScope,
  policiesFor,
  RATE_LIMIT_CLASSES,
  RATE_LIMIT_NAMESPACE,
  RATE_LIMIT_SCOPES,
  rateLimitKey,
  RateLimitConfigError,
} from './ratelimit/policy.js';

export type { RedisCommands, RedisRateLimiterOptions } from './ratelimit/redis-limiter.js';
export {
  createRedisRateLimiter,
  RateLimiterUnavailableError,
  SLIDING_WINDOW_SCRIPT,
} from './ratelimit/redis-limiter.js';

export type {
  RateLimitEnforcer,
  RateLimitEnforcerOptions,
  RateLimitOutcome,
  StoreFailureMode,
} from './ratelimit/enforcer.js';
export {
  createRateLimitEnforcer,
  DEFAULT_STORE_FAILURE_MODE,
  rateLimitHeaders,
  STORE_FAILURE_MODES,
} from './ratelimit/enforcer.js';

// Idempotency — fingerprint, store, and the exactly-once claim.
export type { FingerprintInput } from './idempotency/fingerprint.js';
export {
  canonicalize,
  FINGERPRINT_EXCLUDED_FIELDS,
  fingerprintOf,
} from './idempotency/fingerprint.js';

export type {
  BeginResult,
  IdempotencyRecord,
  IdempotencyStore,
  RedisIdempotencyStoreOptions,
  StoredResponse,
} from './idempotency/store.js';
export {
  CLAIM_SCRIPT,
  COMPLETE_SCRIPT,
  createRedisIdempotencyStore,
  IDEMPOTENCY_NAMESPACE,
  IDEMPOTENCY_TTL_SECONDS,
  idempotencyKeyFor,
  IdempotencyStoreUnavailableError,
  RELEASE_SCRIPT,
} from './idempotency/store.js';

export type { BeginInput, IdempotencyGuard, IdempotencyOutcome } from './idempotency/guard.js';
export {
  CONFLICT_STATUS,
  createIdempotencyGuard,
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENT_REPLAY_HEADER,
  PENDING_RETRY_AFTER_SECONDS,
  withIdempotencyKey,
} from './idempotency/guard.js';
