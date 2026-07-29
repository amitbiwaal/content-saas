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
