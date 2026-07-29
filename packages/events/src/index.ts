/**
 * `@contentos/events` — THE public surface.
 *
 * Specified by `13-event-platform/`. ADR-020 (outbox + Redis Streams bus),
 * ADR-027 (durable DLQ), ADR-028 (replay coordination).
 */

export type { ValidationIssue, ValidationResult } from './envelope/validation.js';
export {
  assertValidEnvelope,
  EnvelopeValidationError,
  MAX_PAYLOAD_ARRAY_LENGTH,
  MAX_PAYLOAD_BYTES,
  MAX_PAYLOAD_DEPTH,
  validateEnvelope,
  validatePayload,
} from './envelope/validation.js';

export type {
  ConsumerDeclaration,
  Criticality,
  EventRegistry,
  EventTypeDeclaration,
  RegistryValidation,
  RetirementCheck,
  UnknownVersionPolicy,
  VersionState,
} from './registry/registry.js';
export { createEventRegistry, RegistryError } from './registry/registry.js';

export type { OutboxPublisherOptions, TransactionalExecutor } from './outbox/publisher.js';
export { createOutboxPublisher } from './outbox/publisher.js';

// Delivery — 13-event-platform/{retry-engine,idempotency,ordering}.md
export type {
  Classification,
  DeadLetterReason,
  RetryBudget,
  RetryContext,
  RetryDecision,
  RetryEngine,
  RetryEngineOptions,
  RetryPolicy,
  TerminalCode,
} from './delivery/retry.js';
export {
  backoffMs,
  classify,
  createRetryEngine,
  DEFAULT_RETRY_POLICY,
  isTerminalCode,
  TERMINAL_CODES,
} from './delivery/retry.js';

export type {
  AggregateBarrier,
  AggregateBarrierOptions,
  BarrierGap,
  BarrierToken,
  GuardExecutor,
  IdempotencyGuard,
  IdempotencyGuardOptions,
  IdempotencyOutcome,
} from './delivery/guards.js';
export { createAggregateBarrier, createIdempotencyGuard } from './delivery/guards.js';

export type {
  DeadLetterRequest,
  DispatchDeps,
  Dispatcher,
  DispatchOutcome,
  RegisteredHandler,
} from './delivery/dispatcher.js';
export { createDispatcher } from './delivery/dispatcher.js';

// Dead letter queue — ADR-027
export type {
  DeadLetterQuery,
  DeadLetterQueue,
  DeadLetterQueueOptions,
  DeadLetterRow,
  DeadLetterSource,
  DeadLetterStatus,
  FailureGroup,
  NewDeadLetterEntry,
  ReplayAttemptOutcome,
  RetryAttempt,
} from './dlq/dead-letter-queue.js';
export { createDeadLetterQueue, PUBLISH_SENTINEL_GROUP } from './dlq/dead-letter-queue.js';

// Outbox relay — ADR-020
export type {
  OutboxRow,
  PublishResult,
  Relay,
  RelayCycleResult,
  RelayDeps,
} from './relay/relay.js';
export {
  createRelay,
  DEFAULT_BATCH_SIZE,
  DEFAULT_MAX_PUBLISH_ATTEMPTS,
  toEvent,
} from './relay/relay.js';

// Serializer — the wire format
export type { EventSerializer } from './serializer/serializer.js';
export { createEventSerializer, DeserializationError } from './serializer/serializer.js';

// Redis Streams event bus — ADR-020. `EventBus` is the swap point.
export type {
  BusEntryId,
  ClaimOptions,
  ClaimResult,
  DeliveredEvent,
  EventBus,
  ReadGroupOptions,
  RedisStreamsBusOptions,
  RedisStreamsClient,
} from './bus/redis-streams.js';
export {
  BackPressureError,
  BusShutdownError,
  createRedisStreamsBus,
  DEFAULT_BASE_DELAY_MS,
  DEFAULT_MAX_ATTEMPTS,
  isTransientRedisError,
} from './bus/redis-streams.js';

// The concrete driver binding. Exported so a worker can construct a client
// WITHOUT importing `ioredis` itself — raw client access is how unprefixed,
// cross-tenant keys get created, so it stays behind this barrel.
export type { ManagedRedisClient, RedisConnectionOptions } from './bus/ioredis-client.js';
export {
  createRedisClient,
  DEFAULT_READY_TIMEOUT_MS,
  REDIS_CLIENT_DEFAULTS,
} from './bus/ioredis-client.js';

// Replay coordination — ADR-028. Re-delivers events; never re-executes effects.
export type {
  NonEmpty,
  ReplayAuditEntry,
  ReplayContext,
  ReplayCoordinator,
  ReplayDeliveryOutcome,
  ReplayDeps,
  ReplayEstimate,
  ReplayMode,
  ReplayProgress,
  ReplayRequest,
  ReplayRun,
  ReplayStatus,
} from './replay/replay-coordinator.js';
export {
  createReplayCoordinator,
  DEFAULT_BATCH_SIZE as DEFAULT_REPLAY_BATCH_SIZE,
  DEFAULT_CHECKPOINT_INTERVAL,
  DEFAULT_LAG_THRESHOLD_SECONDS,
  DEFAULT_MAX_EVENTS,
  DEFAULT_RATE_LIMIT_PER_SECOND,
  MAX_CONCURRENT_RUNS,
  OUTBOX_RETENTION_DAYS,
  ReplayRejectedError,
  SKIP_REASONS,
} from './replay/replay-coordinator.js';

// Observability — the FROZEN metric catalogue, log schema and trace model.
export type {
  DeliveryOutcome as MetricDeliveryOutcome,
  EventMetricsOptions,
  EventPlatformMetrics,
  InvariantBreach,
  InvariantKind,
} from './observability/event-metrics.js';
export { createEventPlatformMetrics } from './observability/event-metrics.js';
export type {
  EventLogAction,
  EventLogComponent,
  EventLogContext,
  EventLogger,
  EventLoggerOptions,
  EventLogSink,
  EventPlatformLogRecord,
} from './observability/event-log.js';
export { createEventLogger, jsonLineSink } from './observability/event-log.js';
export type { EventTracer, SpanOutcome } from './observability/event-tracing.js';
export {
  createEventTracer,
  samplerAlwaysSamplingBreaches,
  SPAN_ATTRIBUTES,
  TRACEPARENT_HEADER,
} from './observability/event-tracing.js';
