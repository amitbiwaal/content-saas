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
  ErrorBody,
} from './ai/http.js';
export { API_ERROR_MESSAGES, errorFor, isStreamResponse, ok, requestIdOf } from './ai/http.js';

export type { ScopedRead, ValidationOutcome } from './ai/validation.js';
export { readResumeToken, toGatewayRequest, toScopedRead } from './ai/validation.js';

export type { AiDispatcher, JobReader, WorkflowReader } from './ai/ports.js';

export type { DispatcherOptions } from './ai/dispatch.js';
export { createProviderDispatcher } from './ai/dispatch.js';

export type { AiControllerOptions, AiControllers } from './ai/controllers.js';
export { createAiControllers, failureResponse, rejectionResponse } from './ai/controllers.js';

export type { AiRoute, RouteMatch } from './ai/routes.js';
export {
  AI_BASE_PATH,
  AI_ROUTES,
  createAiRouter,
  matchPattern,
  resolveRoute,
} from './ai/routes.js';
