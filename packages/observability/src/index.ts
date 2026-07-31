/**
 * `@contentos/observability` — THE public surface.
 *
 * "packages/observability is the only place instrumentation is configured —
 * services import it rather than wiring OTel individually, which is what makes
 * mandatory span attributes actually mandatory" (`14-operations/monitoring.md` §7).
 *
 * Abstractions only. No provider SDK is imported anywhere in this package: not
 * OpenTelemetry, not Prometheus, not Sentry. Exporters bind at the process edge.
 */

// Logging — `07-development-guide/logging-guide.md`
export type { Logger, LoggerOptions, LogSink } from './logging/logger.js';
export { createLogger, stdoutSink } from './logging/logger.js';
export type {
  LogBindings,
  LogFields,
  LogLevel,
  LogRecord,
  LogRecordField,
  Outcome,
} from './logging/log-record.js';
export { LOG_LEVELS, LOG_RECORD_FIELDS, UNBOUND_CORRELATION_ID } from './logging/log-record.js';
export type { ScanResult } from './logging/redaction.js';
export { REDACTED, SecretValue, scanForCredentials } from './logging/redaction.js';

// Tracing — W3C Trace Context, no OTel dependency
export type { IdGenerator, SpanContext, SpanId, TraceId } from './tracing/trace-context.js';
export {
  cryptoIdGenerator,
  formatTraceparent,
  INVALID_SPAN_ID,
  INVALID_TRACE_ID,
  isValidSpanId,
  isValidTraceId,
  parseTraceparent,
} from './tracing/trace-context.js';
export type {
  AttributeValue,
  FinishedSpan,
  OptionalSpanAttributes,
  RequiredSpanAttributes,
  Span,
  SpanAttributes,
  SpanExporter,
  SpanStatus,
  Tracer,
  TracerOptions,
} from './tracing/tracer.js';
export { createTracer } from './tracing/tracer.js';

// Metrics — `14-operations/monitoring.md` §5.1
export type {
  Counter,
  Gauge,
  Histogram,
  HistogramSnapshot,
  MetricDefinition,
  MetricKind,
  MetricSample,
  Timer,
} from './metrics/registry.js';
export { DEFAULT_DURATION_BUCKETS_SECONDS, MetricRegistry } from './metrics/registry.js';
export type { ForbiddenMetricLabel, MetricLabels } from './metrics/labels.js';
export { assertLabelsAllowed, FORBIDDEN_METRIC_LABELS, labelKey } from './metrics/labels.js';

// Context and correlation
export type { RequestContext } from './context/request-context.js';
export {
  contextBindings,
  currentContext,
  newCorrelationId,
  runWithContext,
  withContext,
} from './context/request-context.js';

// Health — `14-operations/monitoring.md` §9
export type {
  DeepHealthReport,
  DependencyCheck,
  DependencyReport,
  DependencyResult,
  HealthOptions,
  HealthStatus,
  LivenessReport,
  LocalDependencyCheck,
  ReadinessReport,
  RemoteDependencyCheck,
} from './health/health.js';
export { HealthMonitor } from './health/health.js';

// ── S6.1 · The delta ────────────────────────────────────────────────────────
//
// The package above is canonical and unchanged. What was missing:
//
//   - `MetricsCollector` and `HealthReporter` — the two ports. `Logger` and
//     `Tracer` were already interfaces; `MetricRegistry` and `HealthMonitor`
//     are classes, so a module taking either depended on an implementation.
//     These are the shapes those classes already satisfy.
//   - A named component vocabulary, so two services cannot report one
//     dependency under two names.
//   - The seven core metric DEFINITIONS, so two services cannot measure one
//     thing under two names or two units.
//   - The guards: severity, health state, metric kind, outcome.

export type { ObservedComponent } from './components.js';
export {
  isObservedComponent,
  isReadinessComponent,
  OBSERVED_COMPONENTS,
  READINESS_COMPONENTS,
} from './components.js';

export type { HealthReporter, MetricsCollector } from './ports.js';

export {
  AI_EXECUTION_DURATION,
  CACHE_OPERATIONS,
  CORE_METRIC_DEFINITIONS,
  CREDIT_OPERATIONS,
  PAYMENT_DURATION,
  QUEUE_LATENCY,
  REQUEST_DURATION,
  WEBHOOK_PROCESSING,
} from './metrics/definitions.js';

export { assertCompatibleDefinition, isMetricKind, METRIC_KINDS } from './metrics/registry.js';
export { HEALTH_STATUSES, isHealthStatus } from './health/health.js';
export { isLogLevel, isOutcome, OUTCOMES } from './logging/log-record.js';

// ── S6.5 · Deployment & production operations ───────────────────────────────
//
// No deployment, release, environment or maintenance code existed anywhere.
// This adds the DESCRIPTION layer for `14-operations/deployment.md`: the four
// environments, the release record §5 requires, the deploy order §3.3 fixes,
// §10's rollback state machine, the production readiness gate, maintenance
// windows and runbooks.
//
// It executes nothing. No shell, no Docker, no Kubernetes, no Terraform, no
// Helm, no cloud SDK, no CI call — a layer that could perform a deployment
// would make §3.2's manual approval advisory rather than structural.
//
// `ProductionReadinessReport` is deliberately NOT `ReadinessReport`: that one
// is the `/health/ready` probe, asked every few seconds about one process.

export type { DeploymentErrorCode } from './deployment/errors.js';
export {
  assertIdentifier as assertDeploymentIdentifier,
  assertInstant as assertDeploymentInstant,
  DeploymentError,
  MAX_IDENTIFIER_LENGTH as MAX_DEPLOYMENT_IDENTIFIER_LENGTH,
  MAX_TEXT_LENGTH as MAX_DEPLOYMENT_TEXT_LENGTH,
} from './deployment/errors.js';

export type {
  DeploymentEnvironment,
  DeploymentTarget,
  EnvironmentConfiguration,
  MigrationPhase,
  Release,
  ReleaseId,
  ReleaseStrategy,
} from './deployment/release.js';
export {
  assertValidRelease,
  blocksRollback,
  configurationOf,
  createRelease,
  DEPLOYMENT_ENVIRONMENTS,
  DEPLOYMENT_TARGETS,
  deployRank,
  ENVIRONMENT_CONFIGURATIONS,
  holdsRealData,
  isCorrectlyOrdered,
  isDeploymentEnvironment,
  isDeploymentTarget,
  isMigrationPhase,
  isReleaseStrategy,
  MIGRATION_PHASES,
  orderTargets,
  promotionRank,
  RELEASE_STRATEGIES,
  ZERO_DOWNTIME_STRATEGIES,
} from './deployment/release.js';

export type {
  Deployment,
  DeploymentId,
  DeploymentPlan,
  DeploymentState,
  DeploymentTransition,
  DeploymentTransitionRule,
  RollbackPlan,
} from './deployment/deployment.js';
export {
  assertTransitionAllowed as assertDeploymentTransitionAllowed,
  assertValidDeployment,
  assertValidDeploymentPlan,
  assertValidRollbackPlan,
  canTransition as canDeploymentTransition,
  createDeployment,
  createDeploymentPlan,
  createRollbackPlan,
  DEPLOYMENT_STATES,
  DEPLOYMENT_TRANSITION_RULES,
  DEPLOYMENT_TRANSITIONS,
  isDeploymentState,
  isRollbackable,
  ROLLBACK_TARGET_MINUTES,
  STAGING_SOAK_MINUTES,
  transitionsFrom as deploymentTransitionsFrom,
} from './deployment/deployment.js';

export type {
  DeploymentReport,
  EnvironmentProjection,
  HealthProjection,
  ProductionReadinessReport,
  ReadinessCheck,
  ReadinessCheckName,
} from './deployment/readiness.js';
export {
  assertValidReadinessReport,
  blockingChecks,
  buildDeploymentReport,
  buildReadinessReport,
  isReadinessCheck,
  MANDATORY_FOR_PRODUCTION,
  projectEnvironment,
  projectHealth,
  READINESS_CHECKS,
  requiredChecks,
} from './deployment/readiness.js';

export type {
  MaintenanceMode,
  MaintenanceWindow,
  MaintenanceWindowId,
  OperationalRunbook,
  RunbookId,
  RunbookStep,
} from './deployment/operations.js';
export {
  assertValidMaintenanceWindow,
  assertValidRunbook,
  blocksReads,
  blocksWrites,
  createMaintenanceWindow,
  createRunbook,
  isMaintenanceMode,
  isRehearsed,
  isWindowActive,
  MAINTENANCE_MODES,
  MAX_RUNBOOK_STEPS,
  MAX_WINDOW_HOURS,
  modeAt,
} from './deployment/operations.js';

export type {
  DeploymentPosition,
  DeploymentQuery,
  DeploymentRepository,
  DeploymentSlice,
  MaintenanceQuery,
  MaintenanceSlice,
  OperationsRepository,
} from './deployment/repository.js';

export type {
  DeploymentAction,
  DeploymentAuditEvent,
  DeploymentService,
  DeploymentServiceOptions,
  ProductionOperationsService,
  ProductionOperationsServiceOptions,
} from './deployment/service.js';
export {
  createDeploymentService,
  createProductionOperationsService,
  DEPLOYMENT_ACTIONS,
  toAuditEvent as toDeploymentAuditEvent,
} from './deployment/service.js';
