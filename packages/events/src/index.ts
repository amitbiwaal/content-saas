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
