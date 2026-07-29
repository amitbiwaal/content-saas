/**
 * Event Platform metric catalogue.
 *
 * Spec: `13-event-platform/observability.md` §"Metric catalogue".
 *
 * NAMES ARE FROZEN. A component may not emit a differently-named metric for a
 * catalogued concept, because a dashboard or alert written against one name is
 * silently blind to the other. Every name below is quoted from the catalogue.
 *
 * TWO FAILURE CLASSES, TWO PATHS. Degradation — lag, latency, depth — is an SLO
 * problem recorded through the ordinary counters. An INVARIANT BREACH is a
 * broken guarantee and goes through `recordInvariantBreach`, which is a
 * separate method precisely so reporting a breach cannot be mistaken for
 * reporting a metric: it always pages, never samples.
 *
 * CARDINALITY IS A CORRECTNESS CONCERN, not a tuning one. `tenantId`,
 * `event_id` and `aggregate_id` are never labels — one time series per event
 * would take the metrics backend down long before the platform. The
 * `MetricRegistry` enforces this at declaration time.
 */

import type { DomainEvent } from '@contentos/contracts';
import type { Counter, Gauge, Histogram, MetricRegistry } from '@contentos/observability';

export type DeliveryOutcome = 'handled' | 'suppressed' | 'retried' | 'dead-lettered';

export type InvariantKind =
  | 'ordering-violation'
  | 'idempotency-failure'
  | 'registry-bypass'
  | 'publish-side-dlq'
  | 'replay-conflict';

export interface InvariantBreach {
  readonly kind: InvariantKind;
  readonly group: string | null;
  readonly eventId: string;
  readonly eventType: string;
  readonly tenantId: string;
  readonly detail: string;
}

const MS_PER_SECOND = 1000;

/** Durations are recorded in SECONDS; every catalogued name says so. */
function seconds(ms: number): number {
  return ms / MS_PER_SECOND;
}

export interface EventPlatformMetrics {
  // Publication
  recordPublish(eventType: string, producer: string, durationMs: number): void;
  recordRelayLag(committedAt: Date, appendedAt: Date): void;
  recordRelayBatch(size: number): void;
  recordPublishAttempt(outcome: 'success' | 'failure'): void;
  recordQuarantined(eventType: string): void;
  setPendingDepth(depth: number): void;

  // Delivery
  recordDelivery(group: string, event: DomainEvent<unknown>, outcome: DeliveryOutcome): void;
  recordHandlerDuration(group: string, eventType: string, durationMs: number): void;
  recordLag(group: string, eventType: string, oldestUnprocessedAt: Date, now?: Date): void;
  recordDuplicateDelivery(group: string, eventType: string): void;
  recordStalledClaimed(group: string, count?: number): void;
  setConsumerPendingDepth(group: string, depth: number): void;
  setQueueDepth(eventType: string, depth: number): void;

  // Retry and DLQ
  recordRetryAttempt(group: string, eventType: string, classification: string): void;
  recordRetryBudgetExhausted(scope: string, key: string): void;
  recordTerminalFailure(group: string, code: string): void;
  recordDeadLettered(
    eventType: string,
    group: string,
    failureCode: string,
    source: 'publish' | 'delivery',
  ): void;
  setDlqDepth(status: string, depth: number): void;
  setDlqOldestAge(ageSeconds: number): void;

  // Idempotency and ordering
  recordSuppressed(group: string, eventType: string): void;
  recordHandled(group: string, eventType: string): void;
  setBarrierHeld(group: string, held: number): void;
  recordOrderingGap(group: string, eventType: string): void;

  // Replay
  recordReplayRun(mode: string, outcome: string): void;
  recordReplayDelivered(group: string, count?: number): void;
  recordReplaySkipped(reason: string): void;
  recordReplayDuplicateSuppressed(group: string): void;
  recordReplayDuration(durationMs: number, mode: string): void;
  setActiveReplayRuns(count: number): void;
  recordBackpressurePause(): void;
  recordDeletedTenantSkip(): void;

  // Workers
  setWorkerInstances(group: string, instances: number): void;
  setWorkerInFlight(group: string, inFlight: number): void;
  recordShutdownAbandoned(count?: number): void;

  // Registry
  recordRegistryValidationFailure(eventType: string, reason: string): void;
  recordUnknownVersionDeadLetter(group: string, eventType: string): void;

  /** Always pages, always logs at error, never samples. */
  recordInvariantBreach(breach: InvariantBreach): void;
}

export interface EventMetricsOptions {
  readonly registry: MetricRegistry;
  /**
   * Called for every invariant breach, in addition to the counter.
   *
   * A breach is not a metric to be aggregated into a digest — ordering,
   * idempotency and durability are guarantees other components are BUILT
   * AGAINST, and a single violation compounds silently.
   */
  readonly onInvariantBreach?: (breach: InvariantBreach) => void;
  readonly now?: () => Date;
}

export function createEventPlatformMetrics(options: EventMetricsOptions): EventPlatformMetrics {
  const r = options.registry;
  const now = options.now ?? ((): Date => new Date());

  const counter = (name: string, help: string, labelNames: string[] = []): Counter =>
    r.counter({ name, help, labelNames });
  const gauge = (name: string, help: string, labelNames: string[] = []): Gauge =>
    r.gauge({ name, help, labelNames });
  const histogram = (name: string, help: string, labelNames: string[] = []): Histogram =>
    r.histogram({ name, help, labelNames });

  // ── Publication ──────────────────────────────────────────────────────────
  const publishDuration = histogram(
    'outbox_publish_duration_seconds',
    'Publish-into-transaction latency.',
    ['event_type', 'producer'],
  );
  const published = counter('outbox_events_published_total', 'Events written to the outbox.', [
    'event_type',
    'producer',
  ]);
  const pendingDepth = gauge('outbox_pending_depth', 'Unpublished outbox rows.');
  /**
   * The platform's single most important latency metric: the gap between a
   * state change being durable and its notification being deliverable — the
   * entire window in which the system is internally inconsistent.
   */
  const relayLag = histogram('outbox_relay_lag_seconds', 'Commit to appended-to-bus.');
  const relayBatch = histogram('outbox_relay_batch_size', 'Rows per relay claim.');
  const publishAttempts = counter('outbox_publish_attempts_total', 'Relay append attempts.', [
    'outcome',
  ]);
  const quarantined = counter('outbox_quarantined_total', 'Poison rows quarantined.', [
    'event_type',
  ]);

  // ── Delivery ─────────────────────────────────────────────────────────────
  const throughput = counter('event_throughput_total', 'Events delivered.', [
    'event_type',
    'group',
    'outcome',
  ]);
  /** In TIME, not entry count: a backlog is meaningless without a drain rate. */
  const consumerLag = gauge('consumer_lag_seconds', 'Age of the oldest unprocessed event.', [
    'group',
    'event_type',
  ]);
  const consumerPending = gauge('consumer_pending_depth', 'Claimed but unacknowledged entries.', [
    'group',
  ]);
  const queueDepth = gauge('queue_depth', 'Undelivered stream entries.', ['event_type']);
  const handlerDuration = histogram('handler_duration_seconds', 'Handler execution.', [
    'group',
    'event_type',
  ]);
  /** Expected to be non-zero: at-least-once produces duplicates by design. */
  const duplicateDelivery = counter('duplicate_delivery_total', 'Deliveries with count > 1.', [
    'group',
    'event_type',
  ]);
  const stalledClaimed = counter('stalled_entries_claimed_total', 'Recovered from dead workers.', [
    'group',
  ]);

  // ── Retry and DLQ ────────────────────────────────────────────────────────
  const retryAttempts = counter('retry_attempts_total', 'Retry attempts.', [
    'group',
    'event_type',
    'classification',
  ]);
  const retryBudget = counter('retry_budget_exhausted_total', 'Budget exhaustion.', [
    'scope',
    'key',
  ]);
  const terminalFailures = counter('terminal_failures_total', 'Never-retried failures.', [
    'group',
    'code',
  ]);
  const dlqEntries = counter('dlq_entries_total', 'Dead-lettered events.', [
    'event_type',
    'group',
    'failure_code',
    'source',
  ]);
  const dlqDepth = gauge('dlq_depth', 'Current DLQ size.', ['status']);
  const dlqOldest = gauge('dlq_oldest_quarantined_age_seconds', 'Triage backlog age.');

  // ── Idempotency and ordering ─────────────────────────────────────────────
  const suppressed = counter('idempotency_suppressed_total', 'Duplicates suppressed.', [
    'group',
    'event_type',
  ]);
  const handled = counter('idempotency_handled_total', 'Events actually handled.', [
    'group',
    'event_type',
  ]);
  const orderingViolations = counter('ordering_violations_total', 'INVARIANT BREACH.', [
    'group',
    'event_type',
  ]);
  const orderingGaps = counter('ordering_gaps_total', 'Ordered events dead-lettered.', [
    'group',
    'event_type',
  ]);
  const barrierHeld = gauge('aggregate_barrier_held', 'Aggregates currently blocked.', ['group']);

  // ── Replay ───────────────────────────────────────────────────────────────
  const replayRuns = counter('replay_runs_total', 'Replay executions.', ['mode', 'outcome']);
  /**
   * The catalogue lists `run_id` as a label here, but `run_id` is in the frozen
   * `FORBIDDEN_METRIC_LABELS` guard, which rejects it at declaration. The
   * catalogued NAME is emitted with `group` only; the run id travels on the
   * structured log record and the trace span, where high cardinality is free.
   * Reported as a conflict rather than resolved here.
   */
  const replayDelivered = counter('replay_events_delivered_total', 'Replay delivery rate.', [
    'group',
  ]);
  const replaySkipped = counter('replay_events_skipped_total', 'Rejected on replay.', ['reason']);
  /** A HIGH count is a success signal: it proves idempotency is working. */
  const replayDuplicates = counter('replay_duplicates_suppressed_total', 'Replay safety proof.', [
    'group',
  ]);
  const replayDuration = histogram('replay_run_duration_seconds', 'Replay run duration.', ['mode']);
  const replayActive = gauge('replay_active_runs', 'Replay runs in flight.');
  const replayBackpressure = counter('replay_backpressure_pauses_total', 'Yielded to live load.');
  const deletedTenantSkips = counter(
    'replay_deleted_tenant_skips_total',
    'Events skipped because the tenant was erased.',
  );

  // ── Workers and registry ─────────────────────────────────────────────────
  /** Zero is an alert: events accumulate with no error anywhere. */
  const workerInstances = gauge('worker_instances', 'Workers per group.', ['group']);
  const workerInFlight = gauge('worker_in_flight', 'Concurrency utilization.', ['group']);
  const shutdownAbandoned = counter('worker_shutdown_abandoned_total', 'Deploy hygiene.');
  const registryFailures = counter('registry_validation_failures_total', 'Pre-commit rejections.', [
    'event_type',
    'reason',
  ]);
  const unknownVersion = counter(
    'unknown_version_dead_letters_total',
    'Version negotiation failures.',
    ['group', 'event_type'],
  );

  return {
    recordPublish(eventType, producer, durationMs): void {
      publishDuration.observe(seconds(durationMs), { event_type: eventType, producer });
      published.inc({ event_type: eventType, producer });
    },
    recordRelayLag(committedAt, appendedAt): void {
      relayLag.observe(seconds(appendedAt.getTime() - committedAt.getTime()));
    },
    recordRelayBatch(size): void {
      relayBatch.observe(size);
    },
    recordPublishAttempt(outcome): void {
      publishAttempts.inc({ outcome });
    },
    recordQuarantined(eventType): void {
      quarantined.inc({ event_type: eventType });
    },
    setPendingDepth(depth): void {
      pendingDepth.set(depth);
    },

    recordDelivery(group, event, outcome): void {
      throughput.inc({ event_type: event.eventType, group, outcome });
    },
    recordHandlerDuration(group, eventType, durationMs): void {
      handlerDuration.observe(seconds(durationMs), { group, event_type: eventType });
    },
    recordLag(group, eventType, oldestUnprocessedAt, at): void {
      const reference = at ?? now();
      consumerLag.set(seconds(reference.getTime() - oldestUnprocessedAt.getTime()), {
        group,
        event_type: eventType,
      });
    },
    recordDuplicateDelivery(group, eventType): void {
      duplicateDelivery.inc({ group, event_type: eventType });
    },
    recordStalledClaimed(group, count = 1): void {
      stalledClaimed.inc({ group }, count);
    },
    setConsumerPendingDepth(group, depth): void {
      consumerPending.set(depth, { group });
    },
    setQueueDepth(eventType, depth): void {
      queueDepth.set(depth, { event_type: eventType });
    },

    recordRetryAttempt(group, eventType, classification): void {
      retryAttempts.inc({ group, event_type: eventType, classification });
    },
    recordRetryBudgetExhausted(scope, key): void {
      retryBudget.inc({ scope, key });
    },
    recordTerminalFailure(group, code): void {
      terminalFailures.inc({ group, code });
    },
    recordDeadLettered(eventType, group, failureCode, source): void {
      dlqEntries.inc({ event_type: eventType, group, failure_code: failureCode, source });
    },
    setDlqDepth(status, depth): void {
      dlqDepth.set(depth, { status });
    },
    setDlqOldestAge(ageSeconds): void {
      dlqOldest.set(ageSeconds);
    },

    recordSuppressed(group, eventType): void {
      suppressed.inc({ group, event_type: eventType });
    },
    recordHandled(group, eventType): void {
      handled.inc({ group, event_type: eventType });
    },
    setBarrierHeld(group, held): void {
      barrierHeld.set(held, { group });
    },
    recordOrderingGap(group, eventType): void {
      orderingGaps.inc({ group, event_type: eventType });
    },

    recordReplayRun(mode, outcome): void {
      replayRuns.inc({ mode, outcome });
    },
    recordReplayDelivered(group, count = 1): void {
      replayDelivered.inc({ group }, count);
    },
    recordReplaySkipped(reason): void {
      replaySkipped.inc({ reason });
    },
    recordReplayDuplicateSuppressed(group): void {
      replayDuplicates.inc({ group });
    },
    recordReplayDuration(durationMs, mode): void {
      replayDuration.observe(seconds(durationMs), { mode });
    },
    setActiveReplayRuns(count): void {
      replayActive.set(count);
    },
    recordBackpressurePause(): void {
      replayBackpressure.inc();
    },
    recordDeletedTenantSkip(): void {
      deletedTenantSkips.inc();
    },

    setWorkerInstances(group, instances): void {
      workerInstances.set(instances, { group });
    },
    setWorkerInFlight(group, inFlight): void {
      workerInFlight.set(inFlight, { group });
    },
    recordShutdownAbandoned(count = 1): void {
      shutdownAbandoned.inc({}, count);
    },

    recordRegistryValidationFailure(eventType, reason): void {
      registryFailures.inc({ event_type: eventType, reason });
    },
    recordUnknownVersionDeadLetter(group, eventType): void {
      unknownVersion.inc({ group, event_type: eventType });
    },

    /**
     * An invariant breach pages at count one, without aggregation.
     *
     * `ordering_violations_total` is incremented for the ordering case so the
     * catalogued series exists, but the callback is what carries the breach
     * out — a breach routed through the ordinary counter path would be
     * sampled, batched, and noticed a day late.
     */
    recordInvariantBreach(breach): void {
      if (breach.kind === 'ordering-violation') {
        orderingViolations.inc({ group: breach.group ?? 'none', event_type: breach.eventType });
      }
      options.onInvariantBreach?.(breach);
    },
  };
}
