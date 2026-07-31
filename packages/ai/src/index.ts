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
 * recovery, S2.7 streaming, S2.8 the first real adapters, S3.1 the Gateway's
 * admission pipeline. Still no routing — and nothing executes a provider or
 * bills for a call.
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

// Provider configuration — credentials and endpoints, from the environment.
export type { CredentialEnvNames, ProviderCredentials } from './providers/config.js';
export {
  credentialEnvNames,
  credentialsFromEnv,
  ProviderConfigError,
  SDK_MAX_RETRIES,
  UNPRICED_COST,
} from './providers/config.js';

// The streaming half of the port — an EXTENSION of ModelProvider, never an
// edit to it.
export type { StreamingModelProvider } from './providers/streaming-provider.js';
export { isStreamingProvider } from './providers/streaming-provider.js';

// The adapters. The only code in the platform that knows a vendor exists.
export type {
  OpenAIAdapterOptions,
  OpenAICompletion,
  OpenAIRequestBody,
  OpenAIStreamFrame,
  OpenAITransport,
} from './providers/openai.js';
export {
  createOpenAIProvider,
  createOpenRouterProvider,
  fromOpenAICompletion,
  OPENAI_CAPABILITIES,
  OPENAI_PROVIDER_ID,
  OPENROUTER_BASE_URL,
  OPENROUTER_PROVIDER_ID,
  toOpenAIRequest,
} from './providers/openai.js';

export type {
  AnthropicAdapterOptions,
  AnthropicMessage,
  AnthropicRequestBody,
  AnthropicStreamEvent,
  AnthropicTransport,
} from './providers/anthropic.js';
export {
  ANTHROPIC_CAPABILITIES,
  ANTHROPIC_PROVIDER_ID,
  createAnthropicProvider,
  fromAnthropicMessage,
  toAnthropicRequest,
} from './providers/anthropic.js';

export type {
  GoogleAdapterOptions,
  GoogleContent,
  GoogleRequestBody,
  GoogleResponse,
  GoogleTransport,
} from './providers/google.js';
export {
  createGoogleProvider,
  fromGoogleResponse,
  GOOGLE_CAPABILITIES,
  GOOGLE_PROVIDER_ID,
  toGoogleRequest,
} from './providers/google.js';

// The AI Gateway — `08-ai-platform/ai-gateway.md`, ADR-008.
// The single governed entry point. It validates, authorizes, normalizes and
// prepares; it never executes.
export type {
  AdmissionResult,
  AdmissionStage,
  GatewayContext,
  GatewayDecision,
  GatewayRequest,
  GatewayResponse,
  RejectionCode,
} from './gateway/contracts.js';
export {
  ADMISSION_STAGES,
  isRejectionCode,
  MAX_VARIABLES_BYTES,
  REJECTION_CODES,
} from './gateway/contracts.js';

export type {
  AdmissionDirectory,
  AdmissionFlags,
  AdmissionMembership,
  AdmissionMembershipStatus,
  AdmissionOrganization,
  AdmissionOrganizationStatus,
  AdmissionWorkspace,
  AdmissionWorkspaceStatus,
} from './gateway/ports.js';
export {
  ADMISSION_MEMBERSHIP_STATUSES,
  ADMISSION_ORGANIZATION_STATUSES,
  ADMISSION_WORKSPACE_STATUSES,
  ADMITTING_ORGANIZATION_STATUS,
  ADMITTING_WORKSPACE_STATUS,
} from './gateway/ports.js';

export type { Gateway, GatewayOptions } from './gateway/admission.js';

// Request routing — `08-ai-platform/model-router.md`, ADR-008. The only
// component that decides which model executes a request. It SELECTS; the
// Gateway dispatches; the retry strategy decides when a chain advances.
export type {
  ExecutionMode,
  ExecutionPlan,
  RouteTarget,
  RoutingPolicyName,
  RoutingReason,
  RoutingRejectionCode,
  RoutingResult,
  StreamingMode,
} from './routing/plan.js';
export {
  EXECUTION_MODES,
  freezePlan,
  isRoutingReason,
  isRoutingRejectionCode,
  ROUTING_POLICIES,
  ROUTING_REASONS,
  ROUTING_REJECTION_CODES,
  STREAMING_MODES,
} from './routing/plan.js';

export type { CatalogueErrorCode, ModelCatalogue, ModelEntry } from './routing/catalogue.js';
export {
  CATALOGUE_ERROR_CODES,
  CatalogueError,
  createModelCatalogue,
  isCatalogueError,
} from './routing/catalogue.js';

export type {
  ProviderPreference,
  RoutingTable,
  RoutingTableErrorCode,
  RoutingTableOptions,
} from './routing/policy.js';
export {
  createRoutingTable,
  ROUTING_TABLE_ERROR_CODES,
  RoutingTableError,
} from './routing/policy.js';

export type { Router, RouterOptions, RoutingInput } from './routing/router.js';
export { createRouter, RoutingInputError } from './routing/router.js';

// The Prompt Template Library — `08-ai-platform/prompt-engine.md`. The identity
// level the spec calls `prompt_templates`, layered over the S2.3 pipeline that
// already owns one immutable version. It supplies prompts; it executes nothing.
export type {
  SemanticVersion,
  TemplateCapability,
  TemplateMetadata,
  TemplateVisibility,
} from './templates/metadata.js';
export {
  compareSemanticVersions,
  formatSemanticVersion,
  isSemanticallyCompatible,
  isTemplateVisibility,
  parseSemanticVersion,
  TEMPLATE_VISIBILITIES,
} from './templates/metadata.js';

export type {
  LibraryTemplate,
  PromptVersion,
  TemplateDefinition,
  TemplateLibrary,
  TemplateLibraryErrorCode,
} from './templates/library.js';
export {
  bySemanticVersion,
  createTemplateLibrary,
  describeVersion,
  isTemplateLibraryError,
  newestVersion,
  promptVersionStringOf,
  TEMPLATE_LIBRARY_ERROR_CODES,
  TemplateLibraryError,
} from './templates/library.js';

export type {
  ResolutionRejectionCode,
  ResolveOptions,
  ResolvedTemplate,
  TemplateResolution,
  VersionSelector,
} from './templates/resolve.js';
export {
  isResolutionRejectionCode,
  RESOLUTION_REJECTION_CODES,
  resolveTemplate,
} from './templates/resolve.js';

export type { CanonicalPrompt, RenderOptions, RenderPart } from './templates/render.js';
export { RENDER_ORDER, renderCanonicalPrompt } from './templates/render.js';

// Content workflow blueprints — immutable definitions of how content is
// produced. They describe a GRAPH; the frozen S2.4 runtime walks a linear
// sequence, and `toRuntimeDefinition` is the one seam between them. Nothing
// here executes, and no step names a provider.
export type {
  BranchStepDefinition,
  MergeStepDefinition,
  PromptStepDefinition,
  TransformStepDefinition,
  ValidateStepDefinition,
  WorkflowCapability,
  WorkflowMetadata,
  WorkflowStepDefinition,
  WorkflowStepKind,
} from './blueprints/steps.js';
export { binds, isWorkflowStepKind, outgoing, WORKFLOW_STEP_KINDS } from './blueprints/steps.js';

export type {
  BlueprintIssue,
  BlueprintValidationResult,
  ValidateBlueprintOptions,
} from './blueprints/validation.js';
export { validateBlueprint } from './blueprints/validation.js';

export type {
  ContentWorkflow,
  ContentWorkflowDefinition,
  WorkflowRegistry,
  WorkflowRegistryErrorCode,
  WorkflowRegistryOptions,
  WorkflowVersion,
} from './blueprints/registry.js';
export {
  createWorkflowRegistry,
  describeWorkflowVersion,
  isWorkflowRegistryError,
  WORKFLOW_REGISTRY_ERROR_CODES,
  WorkflowRegistryError,
} from './blueprints/registry.js';

export type {
  ResolvedWorkflow,
  ResolveWorkflowOptions,
  RuntimeCompilationCode,
  RuntimeCompilationOptions,
  WorkflowResolution,
  WorkflowResolutionCode,
} from './blueprints/resolve.js';
export {
  isLinear,
  isWorkflowResolutionCode,
  resolveWorkflow,
  RUNTIME_COMPILATION_CODES,
  RuntimeCompilationError,
  toRuntimeDefinition,
  WORKFLOW_RESOLUTION_CODES,
} from './blueprints/resolve.js';
export { createGateway, PIPELINE_ORDER } from './gateway/admission.js';

// ── S4.3 · Content run orchestration ────────────────────────────────────────

export type {
  RunError as ContentRunError,
  RunErrorCode,
  RunStatus,
  RunTransition,
  RunTransitionRule,
} from './runs/state.js';
export {
  assertTransitionAllowed as assertRunTransitionAllowed,
  canTransition as canRunTransition,
  INITIAL_RUN_STATUS,
  isRunError,
  isRunStatus,
  isTerminalRunStatus,
  RUN_ERROR_CODES,
  RUN_STATUSES,
  RUN_TRANSITION_RULES,
  RUN_TRANSITIONS,
  RunError,
  TERMINAL_RUN_STATUSES,
  targetOf as runTransitionTarget,
  transitionsFrom as runTransitionsFrom,
} from './runs/state.js';

export type {
  ContentArtifact,
  ContentRun,
  ContentRunResult,
  ContentRunState,
  RunFailureCode,
  RunMetadata,
  RunTimings,
} from './runs/run.js';
export { isRunFailureCode, RUN_FAILURE_CODES, totalTokens } from './runs/run.js';

export type {
  Orchestrator,
  OrchestratorOptions,
  RunCancellation,
  RunExecutor,
  StartRunOptions,
} from './runs/orchestrator.js';
export { createOrchestrator } from './runs/orchestrator.js';

// ── S4.4 · Content persistence ──────────────────────────────────────────────

export type {
  StoredArtifact,
  StoredContentRun,
  StoredExecutionMetadata,
  StoredFailure,
  StoredPromptReference,
  StoredRecord,
  StoredRecordIssue,
  StoredRecordValidation,
  StoredTimings,
  StoredUsage,
} from './runs/stored.js';
export {
  CONTENT_RUN_SCHEMA_VERSION,
  isSupportedSchemaVersion,
  parsePromptVersion,
  SUPPORTED_SCHEMA_VERSIONS,
  validateStoredArtifact,
  validateStoredRun,
} from './runs/stored.js';

export type { ContentRunRepository, SaveRunInput, UpdateStatusInput } from './runs/repository.js';

export type { ToContentRunOptions, ToStoredOptions } from './runs/mapping.js';
export {
  storedFailureOf,
  toContentRun,
  toStoredArtifacts,
  toStoredRecords,
  toStoredRun,
} from './runs/mapping.js';

export type { LoadContentRunOptions, RunLoadCode, RunLoadResult } from './runs/load.js';
export { isRunLoadCode, loadContentRun, RUN_LOAD_CODES } from './runs/load.js';
