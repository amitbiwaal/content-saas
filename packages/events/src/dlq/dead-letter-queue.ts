/**
 * Dead letter queue — ADR-027.
 *
 * Spec: `13-event-platform/dead-letter-queue.md`.
 *
 * DURABLE, IN POSTGRESQL. A queue held in Redis would lose its contents in the
 * outage that produced them, which is exactly when an operator needs them.
 *
 * THERE IS NO DELETE METHOD. Removal happens only through retention of entries
 * already resolved or discarded, and both terminal transitions require an actor
 * AND a note — enforced by a CHECK constraint, not by convention. "No event is
 * silently discarded" survives an operator in a hurry.
 */

import type { DomainEvent } from '@contentos/contracts';

import type { GuardExecutor } from '../delivery/guards.js';
import type { DeadLetterReason } from '../delivery/retry.js';

/** Publish-side entries carry this sentinel so one uniqueness rule covers both sources. */
export const PUBLISH_SENTINEL_GROUP = '__publish__';

export type DeadLetterSource = 'publish' | 'delivery';
export type DeadLetterStatus = 'quarantined' | 'replaying' | 'resolved' | 'discarded';

export interface NewDeadLetterEntry {
  readonly event: DomainEvent<unknown>;
  readonly source: DeadLetterSource;
  /** `PUBLISH_SENTINEL_GROUP` for publish-side failures. */
  readonly consumerGroup: string;
  readonly failureCode: string;
  readonly failureMessage: string;
  readonly reason: DeadLetterReason;
  readonly retryHistory?: readonly RetryAttempt[];
}

export interface RetryAttempt {
  readonly attempt: number;
  readonly at: string;
  readonly code: string;
}

export type ReplayAttemptOutcome =
  | { readonly outcome: 'delivered' }
  | { readonly outcome: 'suppressed-duplicate' }
  | { readonly outcome: 'failed'; readonly code: string; readonly message: string };

export interface DeadLetterRow {
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
  readonly source: DeadLetterSource;
  readonly consumer_group: string;
  readonly failure_code: string;
  readonly failure_message: string;
  readonly status: DeadLetterStatus;
}

const QUARANTINE_SQL = `
  INSERT INTO dead_letter_events (
    tenant_id, organization_id, event_id, event_type, event_version,
    aggregate_type, aggregate_id, correlation_id, causation_id, producer,
    occurred_at, payload, source, consumer_group, failure_code,
    failure_message, retry_history
  ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
  ON CONFLICT (event_id, consumer_group) DO NOTHING
  RETURNING id`;

const GET_SQL = `SELECT * FROM dead_letter_events WHERE id = $1`;

const QUERY_SQL = `
  SELECT * FROM dead_letter_events
   WHERE status = COALESCE($1, status)
     AND event_type = COALESCE($2, event_type)
   ORDER BY dead_lettered_at DESC
   LIMIT $3`;

const SUMMARIZE_SQL = `
  SELECT event_type, failure_code, count(*)::int AS count
    FROM dead_letter_events
   WHERE status = 'quarantined'
   GROUP BY event_type, failure_code
   ORDER BY count DESC`;

/**
 * Both terminal transitions demand an actor and a note. The CHECK constraint
 * enforces it too — this is the readable half of the same rule.
 */
const RESOLVE_SQL = `
  UPDATE dead_letter_events
     SET status = $2, resolved_at = now(), resolved_by = $3, resolution_note = $4
   WHERE id = $1 AND status IN ('quarantined','replaying')
   RETURNING id`;

const APPEND_ATTEMPT_SQL = `
  UPDATE dead_letter_events
     SET retry_history = retry_history || $2::jsonb
   WHERE id = $1
   RETURNING id`;

export interface FailureGroup {
  readonly event_type: string;
  readonly failure_code: string;
  readonly count: number;
}

export interface DeadLetterQuery {
  readonly status?: DeadLetterStatus;
  readonly eventType?: string;
  readonly limit?: number;
}

export interface DeadLetterQueue {
  quarantine(tx: GuardExecutor, entry: NewDeadLetterEntry): Promise<string | null>;
  get(tx: GuardExecutor, id: string): Promise<DeadLetterRow | null>;
  query(tx: GuardExecutor, q: DeadLetterQuery): Promise<readonly DeadLetterRow[]>;
  summarize(tx: GuardExecutor): Promise<readonly FailureGroup[]>;
  resolve(tx: GuardExecutor, id: string, actor: string, note: string): Promise<boolean>;
  discard(tx: GuardExecutor, id: string, actor: string, note: string): Promise<boolean>;
  appendReplayAttempt(tx: GuardExecutor, id: string, outcome: ReplayAttemptOutcome): Promise<void>;
  /** Rebuild the original envelope from a stored row, byte-identically. */
  toEvent(row: DeadLetterRow): DomainEvent<unknown>;
}

export interface DeadLetterQueueOptions {
  readonly now?: () => Date;
  readonly onQuarantined?: (eventType: string, failureCode: string) => void;
}

function requireActorAndNote(actor: string, note: string): void {
  if (actor.trim() === '' || note.trim() === '') {
    throw new Error(
      'A dead-letter entry may only be resolved or discarded with an actor and a note. Both are required so no event leaves the queue unaccounted for.',
    );
  }
}

export function createDeadLetterQueue(options: DeadLetterQueueOptions = {}): DeadLetterQueue {
  const now = options.now ?? ((): Date => new Date());

  const terminal = async (
    tx: GuardExecutor,
    id: string,
    status: 'resolved' | 'discarded',
    actor: string,
    note: string,
  ): Promise<boolean> => {
    requireActorAndNote(actor, note);
    const rows = await tx.query<{ id: string }>(RESOLVE_SQL, [id, status, actor, note]);
    return rows.length > 0;
  };

  return {
    /**
     * The COMPLETE envelope is preserved, not a summary. A replay must be able
     * to reconstruct the original event exactly; a truncated record turns the
     * DLQ into a log rather than a queue.
     */
    async quarantine(tx, entry): Promise<string | null> {
      const e = entry.event;
      const rows = await tx.query<{ id: string }>(QUARANTINE_SQL, [
        e.tenantId,
        e.organizationId,
        e.eventId,
        e.eventType,
        e.eventVersion,
        e.aggregateType,
        e.aggregateId,
        e.correlationId,
        e.causationId,
        e.producer,
        e.occurredAt,
        JSON.stringify(e.payload),
        entry.source,
        entry.consumerGroup,
        entry.failureCode,
        entry.failureMessage,
        JSON.stringify(entry.retryHistory ?? []),
      ]);
      options.onQuarantined?.(e.eventType, entry.failureCode);
      // ON CONFLICT DO NOTHING: a redelivery of an already-quarantined event
      // must not create a second entry.
      return rows[0]?.id ?? null;
    },

    async get(tx, id): Promise<DeadLetterRow | null> {
      const rows = await tx.query<DeadLetterRow>(GET_SQL, [id]);
      return rows[0] ?? null;
    },

    query(tx, q): Promise<readonly DeadLetterRow[]> {
      return tx.query<DeadLetterRow>(QUERY_SQL, [
        q.status ?? null,
        q.eventType ?? null,
        q.limit ?? 100,
      ]);
    },

    summarize(tx): Promise<readonly FailureGroup[]> {
      return tx.query<FailureGroup>(SUMMARIZE_SQL);
    },

    resolve(tx, id, actor, note): Promise<boolean> {
      return terminal(tx, id, 'resolved', actor, note);
    },

    discard(tx, id, actor, note): Promise<boolean> {
      return terminal(tx, id, 'discarded', actor, note);
    },

    async appendReplayAttempt(tx, id, outcome): Promise<void> {
      const record = { at: now().toISOString(), ...outcome };
      await tx.query(APPEND_ATTEMPT_SQL, [id, JSON.stringify([record])]);
    },

    toEvent(row): DomainEvent<unknown> {
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
    },
  };
}
