/**
 * Transactional outbox publisher — ADR-020.
 *
 * "PostgreSQL is truth; Redis is transport."
 *
 * The dual-write problem: writing a state change to the database and then
 * publishing to a broker are two operations that can fail independently. If the
 * publish fails after the commit, the event is lost; if it succeeds before a
 * rollback, the event is a lie. The outbox removes the second write entirely —
 * the event is a row in the SAME transaction as the state change, and a
 * separate relay moves it to the bus afterwards.
 *
 * AN EVENT EXISTS IF AND ONLY IF ITS TRANSACTION COMMITTED. That is a property
 * of the transaction, not of any code path being correct.
 */

import type { DomainEvent, OutboxPublisher, Transaction } from '@contentos/contracts';

import { assertValidEnvelope } from '../envelope/validation.js';
import type { EventRegistry } from '../registry/registry.js';

/**
 * The transaction handle carries the query surface the publisher needs.
 *
 * `contracts` declares `Transaction` structurally so it acquires no dependency
 * on `packages/database`; the executable shape is asserted here, at the only
 * layer that actually issues SQL.
 */
export interface TransactionalExecutor extends Transaction {
  query<T>(sql: string, params?: readonly unknown[]): Promise<readonly T[]>;
}

const INSERT_SQL = `
  INSERT INTO outbox_events (
    event_id, tenant_id, organization_id, event_type, event_version,
    aggregate_type, aggregate_id, correlation_id, causation_id, producer,
    payload, occurred_at
  ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
  ON CONFLICT (event_id) DO NOTHING`;

export interface OutboxPublisherOptions {
  readonly registry: EventRegistry;
  /** Counts events accepted into the outbox, for the publish-lag signal. */
  readonly onPublished?: (eventType: string) => void;
}

function isExecutor(tx: Transaction): tx is TransactionalExecutor {
  return typeof (tx as { query?: unknown }).query === 'function';
}

function toParams(event: DomainEvent<unknown>): readonly unknown[] {
  return [
    event.eventId,
    event.tenantId,
    event.organizationId,
    event.eventType,
    event.eventVersion,
    event.aggregateType,
    event.aggregateId,
    event.correlationId,
    event.causationId,
    event.producer,
    JSON.stringify(event.payload),
    event.occurredAt,
  ];
}

class TransactionalOutboxPublisher implements OutboxPublisher {
  readonly #registry: EventRegistry;
  readonly #onPublished: ((eventType: string) => void) | undefined;

  constructor(options: OutboxPublisherOptions) {
    this.#registry = options.registry;
    this.#onPublished = options.onPublished;
  }

  /**
   * There is no overload without `tx`, no ambient variant, and no
   * fire-and-forget path. Publishing outside a transaction is UNREPRESENTABLE,
   * which is how ADR-020's dual-write elimination is enforced structurally
   * rather than by review.
   */
  async publish<T>(tx: Transaction, event: DomainEvent<T>): Promise<void> {
    await this.#write(tx, [event]);
  }

  /**
   * Batch publication for the relay and for producers emitting several events
   * in one transaction — including the atomic dual publication used during a
   * breaking-change migration (`versioning.md`).
   */
  async publishBatch<T>(tx: Transaction, events: readonly DomainEvent<T>[]): Promise<void> {
    if (events.length === 0) return;
    await this.#write(tx, events);
  }

  async #write(tx: Transaction, events: readonly DomainEvent<unknown>[]): Promise<void> {
    if (!isExecutor(tx)) {
      throw new TypeError(
        'publish requires a live transaction handle. A handle without a query surface cannot guarantee the event commits with the state change.',
      );
    }

    // Validation happens BEFORE the insert, inside the caller's transaction. A
    // throw here rolls the producer's state change back with it, so an
    // unregistered type or a malformed payload never reaches the outbox.
    for (const event of events) {
      assertValidEnvelope(event);
      const registered = this.#registry.validate(event);
      if (!registered.ok) {
        throw registered.error;
      }
    }

    for (const event of events) {
      // ON CONFLICT DO NOTHING makes a retried producer idempotent on
      // `event_id`: the same event published twice in a retried transaction
      // yields one row, not two.
      await tx.query(INSERT_SQL, toParams(event));
      this.#onPublished?.(event.eventType);
    }
  }
}

/**
 * Domain components depend on the NARROW `EventPublisher` interface; the wide
 * `OutboxPublisher` exists for the relay and for multi-event producers.
 */
export function createOutboxPublisher(options: OutboxPublisherOptions): OutboxPublisher {
  return new TransactionalOutboxPublisher(options);
}
