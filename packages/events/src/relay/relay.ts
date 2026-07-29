/**
 * Outbox relay — ADR-020.
 *
 * Spec: `13-event-platform/transactional-outbox.md`.
 *
 * The relay is the ONLY thing that moves an event from PostgreSQL to the bus.
 * "Redis is transport; PostgreSQL is truth" — so the relay may deliver an event
 * more than once, and must never fail to deliver one at all. At-least-once here
 * is deliberate: the consumer's idempotency guard turns it into exactly-once
 * EFFECTS.
 *
 * CRASH RECOVERY IS THE DEFAULT PATH, not an exception. A row is marked
 * published only AFTER the bus has accepted it, so a crash between append and
 * mark re-delivers rather than loses. That asymmetry is chosen: a duplicate is
 * absorbed downstream, a loss is not recoverable.
 */

import type { DomainEvent } from '@contentos/contracts';

import type { GuardExecutor } from '../delivery/guards.js';

export interface OutboxRow {
  readonly id: string;
  readonly event_id: string;
  readonly tenant_id: string;
  readonly organization_id: string;
  readonly event_type: string;
  readonly event_version: number;
  readonly aggregate_type: string;
  readonly aggregate_id: string;
  readonly correlation_id: string;
  readonly causation_id: string | null;
  readonly producer: string;
  readonly occurred_at: string;
  readonly payload: unknown;
  readonly publish_attempts: number;
}

/**
 * Claim a batch in publication order.
 *
 * `FOR UPDATE SKIP LOCKED` is what makes multiple relay instances safe: each
 * claims a disjoint set without blocking on the others. Ordering is by `id`,
 * the BIGSERIAL publication order.
 *
 * The per-aggregate rule is enforced inside the claim, not after it: a row is
 * skipped when an EARLIER unpublished row exists for the same aggregate, so a
 * batch can never contain two events for one aggregate out of order.
 */
const CLAIM_SQL = `
  SELECT o.* FROM outbox_events o
   WHERE o.published_at IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM outbox_events e
        WHERE e.aggregate_id = o.aggregate_id
          AND e.published_at IS NULL
          AND e.id < o.id
     )
   ORDER BY o.id
   LIMIT $1
   FOR UPDATE SKIP LOCKED`;

const MARK_PUBLISHED_SQL = `
  UPDATE outbox_events SET published_at = now() WHERE id = ANY($1::bigint[])`;

const RECORD_ATTEMPT_SQL = `
  UPDATE outbox_events SET publish_attempts = publish_attempts + 1 WHERE id = $1`;

export function toEvent(row: OutboxRow): DomainEvent<unknown> {
  return {
    eventId: row.event_id,
    eventType: row.event_type,
    eventVersion: row.event_version,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    tenantId: row.tenant_id,
    organizationId: row.organization_id,
    correlationId: row.correlation_id,
    causationId: row.causation_id,
    producer: row.producer,
    occurredAt: row.occurred_at,
    payload: row.payload,
  };
}

export type PublishResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: string; readonly message: string };

export interface RelayDeps {
  /** Opens a transaction. The claim and the mark share it. */
  readonly transaction: <T>(work: (tx: GuardExecutor) => Promise<T>) => Promise<T>;
  /** Appends to the bus. May be called more than once for the same event. */
  readonly append: (event: DomainEvent<unknown>) => Promise<PublishResult>;
  /** Publish-side terminal failure. Never a silent drop. */
  readonly quarantine: (
    tx: GuardExecutor,
    event: DomainEvent<unknown>,
    code: string,
    message: string,
  ) => Promise<void>;
  /** Publish-side attempts before quarantine. */
  readonly maxPublishAttempts?: number;
  readonly batchSize?: number;
  readonly onRelayed?: (eventType: string) => void;
  readonly onQuarantined?: (eventType: string, code: string) => void;
}

export interface RelayCycleResult {
  readonly claimed: number;
  readonly published: number;
  readonly quarantined: number;
  readonly retried: number;
}

export interface Relay {
  /** One poll cycle. Returns what it did, so a worker can back off when idle. */
  drainOnce(): Promise<RelayCycleResult>;
}

export const DEFAULT_BATCH_SIZE = 100;
export const DEFAULT_MAX_PUBLISH_ATTEMPTS = 5;

export function createRelay(deps: RelayDeps): Relay {
  const batchSize = deps.batchSize ?? DEFAULT_BATCH_SIZE;
  const maxAttempts = deps.maxPublishAttempts ?? DEFAULT_MAX_PUBLISH_ATTEMPTS;

  return {
    async drainOnce(): Promise<RelayCycleResult> {
      return deps.transaction(async (tx) => {
        const rows = await tx.query<OutboxRow>(CLAIM_SQL, [batchSize]);
        if (rows.length === 0) {
          return { claimed: 0, published: 0, quarantined: 0, retried: 0 };
        }

        const publishedIds: string[] = [];
        let quarantined = 0;
        let retried = 0;

        for (const row of rows) {
          const event = toEvent(row);
          const result = await deps.append(event);

          if (result.ok) {
            // Marked published only AFTER the bus accepted it. A crash here
            // re-delivers; it does not lose.
            publishedIds.push(row.id);
            deps.onRelayed?.(row.event_type);
            continue;
          }

          const attempts = row.publish_attempts + 1;
          if (attempts >= maxAttempts) {
            // Publish-side dead-letter. The event is NOT marked published, and
            // it is NOT left to be retried forever — it is durably recorded so
            // an operator can see it.
            await deps.quarantine(tx, event, result.code, result.message);
            publishedIds.push(row.id);
            quarantined += 1;
            deps.onQuarantined?.(row.event_type, result.code);
            continue;
          }

          // Left unpublished; the next cycle re-claims it. The attempt counter
          // is what stops an unpublishable row from being retried forever.
          await tx.query(RECORD_ATTEMPT_SQL, [row.id]);
          retried += 1;
        }

        if (publishedIds.length > 0) {
          await tx.query(MARK_PUBLISHED_SQL, [publishedIds]);
        }

        return {
          claimed: rows.length,
          published: publishedIds.length - quarantined,
          quarantined,
          retried,
        };
      });
    },
  };
}
