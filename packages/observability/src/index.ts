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
