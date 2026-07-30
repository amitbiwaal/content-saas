/**
 * `@contentos/ai` — THE public surface.
 *
 * Specified by `08-ai-platform/`. The governed path from every caller to model
 * intelligence, and the jobs that path executes through.
 *
 * Feature-tier: it may import `contracts` and the core packages, and it may NOT
 * import another feature package. The outbox is therefore reached through the
 * `EventPublisher` interface from `contracts` rather than `@contentos/events`
 * (`07-development-guide/project-structure.md` rule 4).
 *
 * S2.1 delivered the job lifecycle, S2.2 the provider PORT, S2.3 the prompt
 * pipeline, S2.4 the workflow runtime, S2.5 usage metering, S2.6 retry and
 * recovery, S2.7 streaming. Still no adapter, no routing, no transport, and
 * nothing that calls a model — or bills for one.
 *
 * The canonical request and response live in `@contentos/contracts`, because an
 * engine issuing an AIRequest is a feature package and two feature packages may
 * not import each other. The prompt contracts stay HERE: the same document
 * names AIRequest/AIResponse the Open Host Service and PromptTemplate part of
 * this capability's own vocabulary
 * (`01-system-architecture/04-context-map.md`).
 */

// Job lifecycle — the pure state machine
export type { Job, JobErrorCode, JobStatus, JobTransition, JobTransitionRule } from './jobs/job.js';
export {
  assertReasonPresent,
  assertTransitionAllowed,
  canTransition,
  INITIAL_JOB_STATUS,
  isJobStatus,
  isJobTransition,
  isTerminalJobStatus,
  JOB_STATUSES,
  JOB_TRANSITION_RULES,
  JOB_TRANSITIONS,
  JobError,
  targetOf,
  TERMINAL_JOB_STATUSES,
  transitionsFrom,
} from './jobs/job.js';

// Job events — payload contracts and envelope construction
export type {
  JobCancelledPayload,
  JobCompletedPayload,
  JobEventContext,
  JobEventPayload,
  JobEventType,
  JobFailedPayload,
  JobQueuedPayload,
  JobStartedPayload,
} from './jobs/events.js';
export {
  EVENT_FOR_TRANSITION,
  JOB_AGGREGATE,
  JOB_EVENT_TYPES,
  JOB_PRODUCER,
  jobCancelled,
  jobCompleted,
  jobFailed,
  jobQueued,
  jobStarted,
} from './jobs/events.js';

// Job Service — create, start, complete, fail, cancel, read
export type {
  CancelJobCommand,
  CreateJobCommand,
  FailJobCommand,
  JobActor,
  JobCursor,
  JobExecutor,
  JobPage,
  JobPageQuery,
  JobResult,
  JobService,
  JobServiceOptions,
  TransitionJobCommand,
} from './jobs/service.js';
export {
  createJobService,
  DEFAULT_JOB_PAGE,
  JOB_AUDIT_ACTIONS,
  MAX_JOB_PAGE,
} from './jobs/service.js';

// Event registry declarations — what a composition root registers.
export {
  AI_EMITTABLE_EVENT_TYPES,
  AI_EVENT_DECLARATIONS,
  AI_REGISTRY_CONTRIBUTION,
  AI_REGISTRY_SOURCE,
  JOB_RUNNER_GROUP,
  JOB_STREAM,
} from './events/declarations.js';

// The provider port — `08-ai-platform/provider-adapters.md`.
// Concrete adapters implement this in `src/providers/`, the only directory
// where a model provider SDK may be imported (ADR-019).
export type { ModelProvider, ProviderHealth, ProviderHealthStatus } from './providers/provider.js';
export {
  PROVIDER_HEALTH_STATUSES,
  isProviderHealthStatus,
  supportsCapability,
} from './providers/provider.js';

export type { ProviderRegistry, ProviderRegistryErrorCode } from './providers/registry.js';
export {
  assertRegisterable,
  createProviderRegistry,
  PROVIDER_REGISTRY_ERROR_CODES,
  ProviderRegistryError,
} from './providers/registry.js';

export { normalizeProviderError, throughProvider } from './providers/normalize.js';

export type { AIValidationIssue, AIValidationResult } from './providers/validation.js';
export {
  assertCapabilityDeclared,
  validateAIRequest,
  validateAIResponse,
} from './providers/validation.js';

// The prompt pipeline — `08-ai-platform/prompt-engine.md`.
// It renders; it does not retrieve, route, or dispatch.
export type {
  PromptContext,
  PromptContextBlock,
  PromptContextSlot,
  PromptErrorCode,
  PromptInput,
  PromptModelHints,
  PromptParts,
  PromptTemplate,
  PromptTemplateRef,
  PromptTemplateStatus,
  PromptVariableType,
  VariableDeclaration,
} from './prompts/template.js';
export {
  isPromptError,
  isPromptVariableType,
  PROMPT_ERROR_CODES,
  PROMPT_TEMPLATE_STATUSES,
  PROMPT_VARIABLE_TYPES,
  PromptError,
  promptVersionOf,
} from './prompts/template.js';

export type { PromptIssue, PromptValidationResult } from './prompts/validation.js';
export {
  MAX_CONTEXT_BLOCKS,
  MAX_PROMPT_CHARS,
  MAX_TEMPLATE_CHARS,
  placeholdersIn,
  PLACEHOLDER,
  validatePromptTemplate,
} from './prompts/validation.js';

export type { CompiledPrompt, CompileOptions } from './prompts/compile.js';
export { compilePrompt } from './prompts/compile.js';

export type { PromptCatalogue } from './prompts/resolver.js';
export { createPromptCatalogue } from './prompts/resolver.js';

export type {
  PrepareExecutionOptions,
  PromptExecutionRequest,
  PromptExecutionResult,
} from './prompts/execution.js';
export { completeExecution, prepareExecution } from './prompts/execution.js';

// The workflow runtime — deterministic orchestration between the job lifecycle
// and the prompt pipeline. It prepares execution; it never performs it.
export type {
  WorkflowDefinition,
  WorkflowIssue,
  WorkflowStep,
  WorkflowValidationResult,
} from './workflow/definition.js';
export { MAX_WORKFLOW_STEPS, validateWorkflowDefinition } from './workflow/definition.js';

export type {
  WorkflowErrorCode,
  WorkflowStatus,
  WorkflowTransition,
  WorkflowTransitionRule,
} from './workflow/state.js';
export {
  assertTransitionAllowed as assertWorkflowTransitionAllowed,
  canTransition as canWorkflowTransition,
  INITIAL_WORKFLOW_STATUS,
  isTerminalWorkflowStatus,
  isWorkflowError,
  isWorkflowStatus,
  isWorkflowTransition,
  TERMINAL_WORKFLOW_STATUSES,
  transitionsFrom as workflowTransitionsFrom,
  WORKFLOW_ERROR_CODES,
  WORKFLOW_STATUSES,
  WORKFLOW_TRANSITION_RULES,
  WORKFLOW_TRANSITIONS,
  WorkflowError,
} from './workflow/state.js';

export type {
  StartWorkflowOptions,
  WorkflowExecution,
  WorkflowExecutionContext,
  WorkflowResult,
  WorkflowState,
  WorkflowStepResult,
} from './workflow/engine.js';
export {
  awaitExecution,
  buildRequest,
  createWorkflowExecution,
  fail as failWorkflow,
  idempotencyKeyFor,
  loadStep,
  pendingRequest,
  preparePrompt,
  recordExecution,
  resultOf,
  start as startWorkflow,
} from './workflow/engine.js';

// Usage metering — `08-ai-platform/cost-management.md`.
// It measures, computes and reports. It never bills, deducts, or persists.
export {
  COST_SCALE,
  DECIMAL_PATTERN,
  DecimalError,
  formatDecimal,
  isDecimalString,
  parseDecimal,
  PRICE_UNIT_TOKENS,
  ZERO_COST,
} from './usage/decimal.js';

export type {
  ModelPrice,
  PricingErrorCode,
  PricingRegistry,
  PricingRegistryOptions,
  ResolvedPrice,
} from './usage/pricing.js';
export {
  assertPriceValid,
  createPricingRegistry,
  isPricingError,
  PRICING_ERROR_CODES,
  PricingError,
} from './usage/pricing.js';

export type { CostInput } from './usage/calculator.js';
export { computeCost, costFrom, DEFAULT_CURRENCY, unpricedBreakdown } from './usage/calculator.js';

export type { RecordUsageOptions, UsageErrorCode } from './usage/recorder.js';
export {
  isLedgerCompatibleAmount,
  isUsageError,
  ledgerKeyFor,
  recordResponseUsage,
  recordUsage,
  UNKNOWN_TOKENIZER,
  USAGE_ERROR_CODES,
  UsageError,
} from './usage/recorder.js';

// Retry and recovery — `08-ai-platform/retry-strategy.md`.
// It decides whether and when; it never dispatches. NOT the event platform's
// retry engine, which decides whether an EVENT is redelivered.
export type { BackoffStrategy, RetryPolicy } from './retry/policy.js';
export {
  assertRetryPolicyValid,
  attemptsAllowed,
  BACKOFF_STRATEGIES,
  backoffFor,
  backoffSchedule,
  DEFAULT_RETRY_POLICY,
  isBackoffStrategy,
  RetryPolicyError,
} from './retry/policy.js';

export type {
  DecideOptions,
  RetryAction,
  RetryAttempt,
  RetryDecision,
  RetryErrorCode,
  RetryReason,
  RetryState,
  RetryStatus,
} from './retry/engine.js';
export {
  beginRetryState,
  decideRetry,
  isRetryError,
  isRetryStatus,
  isTerminalRetryStatus,
  nextAttemptNumber,
  recordFailure,
  recordSuccess,
  RETRY_ERROR_CODES,
  RETRY_REASONS,
  RETRY_STATUSES,
  RetryError,
  settle,
  TERMINAL_RETRY_STATUSES,
} from './retry/engine.js';

export type { RecoverOptions, RecoveryAction, RecoveryResult } from './retry/recovery.js';
export { isRecoveryAction, recover, RECOVERY_ACTIONS, sameRecovery } from './retry/recovery.js';

// Streaming — `08-ai-platform/provider-adapters.md` §Streaming.
// The protocol, never the transport. A completed stream assembles the SAME
// canonical AIResponse a non-streamed call returns.
export type { StreamErrorCode, StreamStatus, StreamTransition } from './streaming/state.js';
export {
  assertTransitionAllowed as assertStreamTransitionAllowed,
  canTransition as canStreamTransition,
  INITIAL_STREAM_STATUS,
  isStreamError,
  isStreamStatus,
  isStreamTransition,
  isTerminalStreamStatus,
  STREAM_ERROR_CODES,
  STREAM_STATUSES,
  STREAM_TRANSITION_ORIGINS,
  STREAM_TRANSITIONS,
  StreamError,
  TERMINAL_STREAM_STATUSES,
  transitionsFrom as streamTransitionsFrom,
} from './streaming/state.js';

export type { ChunkIssue, ChunkValidationResult, StreamChunk } from './streaming/chunk.js';
export { isFinalChunk, validateChunk } from './streaming/chunk.js';

export type {
  AIStream,
  OpenStreamOptions,
  StreamCursor,
  StreamEvent,
  StreamEventKind,
  StreamResult,
  StreamState,
} from './streaming/engine.js';
export {
  acceptChunk,
  assembleResponse,
  chunksAfter,
  cursorFromToken,
  cursorOf,
  eventsOf,
  failStream,
  openStream,
  parseResumeToken,
  resultOf as streamResultOf,
  resumeTokenFor,
  startStream,
  STREAM_EVENT_KINDS,
} from './streaming/engine.js';
