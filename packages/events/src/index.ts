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
