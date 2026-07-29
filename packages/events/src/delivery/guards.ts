/**
 * Idempotency guard and aggregate barrier.
 *
 * Spec: `13-event-platform/idempotency.md` and `ordering.md`.
 *
 * EXACTLY-ONCE DELIVERY IS NOT ACHIEVABLE. Exactly-once EFFECTS are, and the
 * distinction is the whole design: the bus may deliver an event any number of
 * times, and the guard ensures the effects happen once.
 *
 * The mechanism is a database constraint, not a check. The handler's writes and
 * the `processed_events` marker commit in ONE transaction, so a redelivery
 * collides on the primary key rather than racing a lookup.
 */

import type { DomainEvent, Transaction } from '@contentos/contracts';

export interface GuardExecutor extends Transaction {
  query<T>(sql: string, params?: readonly unknown[]): Promise<readonly T[]>;
}

export type IdempotencyOutcome<T> =
  | { readonly outcome: 'executed'; readonly value: T }
  | { readonly outcome: 'suppressed-duplicate' };

const CLAIM_SQL = `
  INSERT INTO processed_events (tenant_id, organization_id, consumer_group, event_id)
  VALUES ($1, $2, $3, $4)
  ON CONFLICT (consumer_group, event_id) DO NOTHING
  RETURNING event_id`;

const WAS_PROCESSED_SQL = `
  SELECT 1 FROM processed_events WHERE consumer_group = $1 AND event_id = $2`;

export interface IdempotencyGuard {
  /**
   * Claim the marker and run the work in the SAME transaction.
   *
   * The marker is written FIRST. If the insert returns no row the event was
   * already processed by this group, and the work does not run. If the work
   * then throws, the whole transaction rolls back — including the marker — so a
   * failed attempt is retryable rather than permanently suppressed.
   */
  execute<T>(
    tx: GuardExecutor,
    event: DomainEvent<unknown>,
    group: string,
    work: (tx: GuardExecutor) => Promise<T>,
  ): Promise<IdempotencyOutcome<T>>;

  wasProcessed(tx: GuardExecutor, group: string, eventId: string): Promise<boolean>;
}

export interface IdempotencyGuardOptions {
  readonly onSuppressed?: (group: string, eventType: string) => void;
}

export function createIdempotencyGuard(options: IdempotencyGuardOptions = {}): IdempotencyGuard {
  return {
    async execute<T>(
      tx: GuardExecutor,
      event: DomainEvent<unknown>,
      group: string,
      work: (tx: GuardExecutor) => Promise<T>,
    ): Promise<IdempotencyOutcome<T>> {
      const claimed = await tx.query<{ event_id: string }>(CLAIM_SQL, [
        event.tenantId,
        event.organizationId,
        group,
        event.eventId,
      ]);

      if (claimed.length === 0) {
        // Already processed by this group. Suppressed duplicates log at debug —
        // they are the mechanism working correctly, not an error. A SPIKE is
        // what escalates.
        options.onSuppressed?.(group, event.eventType);
        return { outcome: 'suppressed-duplicate' };
      }

      const value = await work(tx);
      return { outcome: 'executed', value };
    },

    async wasProcessed(tx: GuardExecutor, group: string, eventId: string): Promise<boolean> {
      const rows = await tx.query(WAS_PROCESSED_SQL, [group, eventId]);
      return rows.length > 0;
    },
  };
}

// ── Aggregate barrier ───────────────────────────────────────────────────────

/**
 * Per-aggregate ordering.
 *
 * `aggregateId` is the ONLY partition key. Two events for the same aggregate
 * are never handled concurrently by one consumer group; events for different
 * aggregates are fully parallel, which is what keeps throughput.
 *
 * A held event is RELEASED FOR LATER REDELIVERY rather than queued in memory.
 * An in-process queue would lose its contents on a crash — the bus already
 * durably holds the event, so deferring to it is both simpler and safer.
 */
/**
 * Branded so `BarrierToken | 'held'` is a real discriminated union.
 *
 * As a bare `string` alias the union collapsed to `string`, so the type gave no
 * protection: any string satisfied it and `'held'` was indistinguishable from a
 * lease. Lint caught this as a redundant constituent, which it was.
 */
export type BarrierToken = string & { readonly __barrier: unique symbol };

export interface AggregateBarrier {
  acquire(group: string, aggregateId: string, eventId: string): Promise<BarrierToken | 'held'>;
  release(token: BarrierToken): Promise<void>;
  /**
   * Release after a dead-letter. The gap is recorded: subsequent events for
   * this aggregate proceed, and the fact that one is missing is explicit rather
   * than inferred from a silence.
   */
  releaseWithGap(token: BarrierToken, deadLetteredEventId: string): Promise<void>;
  heldCount(group: string): number;
}

export interface BarrierGap {
  readonly group: string;
  readonly aggregateId: string;
  readonly eventId: string;
}

export interface AggregateBarrierOptions {
  readonly onGap?: (gap: BarrierGap) => void;
}

interface Lease {
  readonly group: string;
  readonly aggregateId: string;
  readonly eventId: string;
}

/**
 * In-process barrier, correct for the single-writer-per-group deployment the
 * platform runs today (`workers.md`). The interface is what a distributed
 * implementation would satisfy, so swapping it does not touch a consumer.
 */
export function createAggregateBarrier(options: AggregateBarrierOptions = {}): AggregateBarrier {
  const leases = new Map<BarrierToken, Lease>();
  const active = new Set<string>();
  let counter = 0;

  const slot = (group: string, aggregateId: string): string => `${group}::${aggregateId}`;

  return {
    acquire(group, aggregateId, eventId): Promise<BarrierToken | 'held'> {
      const key = slot(group, aggregateId);
      if (active.has(key)) {
        return Promise.resolve('held');
      }
      active.add(key);
      counter += 1;
      const token = `${key}#${String(counter)}` as BarrierToken;
      leases.set(token, { group, aggregateId, eventId });
      return Promise.resolve(token);
    },

    release(token): Promise<void> {
      const lease = leases.get(token);
      if (lease !== undefined) {
        active.delete(slot(lease.group, lease.aggregateId));
        leases.delete(token);
      }
      return Promise.resolve();
    },

    releaseWithGap(token, deadLetteredEventId): Promise<void> {
      const lease = leases.get(token);
      if (lease !== undefined) {
        active.delete(slot(lease.group, lease.aggregateId));
        leases.delete(token);
        options.onGap?.({
          group: lease.group,
          aggregateId: lease.aggregateId,
          eventId: deadLetteredEventId,
        });
      }
      return Promise.resolve();
    },

    heldCount(group): number {
      let count = 0;
      for (const key of active) {
        if (key.startsWith(`${group}::`)) count += 1;
      }
      return count;
    },
  };
}
