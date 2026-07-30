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
