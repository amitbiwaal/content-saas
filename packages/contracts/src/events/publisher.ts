/**
 * Publish surface — `13-event-platform/event-apis.md` §"API surface 1 — Publish".
 *
 * ADR-020 — transactional outbox. "PostgreSQL is truth; Redis is transport."
 */

import type { DomainEvent } from './envelope.js';
import type { Transaction } from './shared.js';

/**
 * What domain components depend on.
 *
 * One method, and it requires a transaction handle. There is no overload
 * without one, no ambient variant, and no fire-and-forget path — publishing
 * outside a transaction is **unrepresentable**, which is how ADR-020's
 * dual-write elimination is enforced structurally rather than by review
 * (`13-event-platform/transactional-outbox.md`).
 *
 * Registry validation happens inside `publish`, before commit. An unregistered
 * type or a schema violation throws, and the producer's state change rolls back
 * with it (`13-event-platform/event-registry.md`).
 */
export interface EventPublisher {
  publish<T>(tx: Transaction, event: DomainEvent<T>): Promise<void>;
}

/**
 * The implementation surface, adding batch publication.
 *
 * Components depend on the narrow `EventPublisher`; this wider one exists for
 * the relay and for producers emitting several events in one transaction —
 * including the atomic dual publication used during a breaking-change migration
 * (`13-event-platform/versioning.md`).
 */
export interface OutboxPublisher extends EventPublisher {
  publishBatch<T>(tx: Transaction, events: readonly DomainEvent<T>[]): Promise<void>;
}
