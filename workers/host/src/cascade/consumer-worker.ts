/**
 * Consumer worker runtime.
 *
 * Spec: `13-event-platform/workers.md`. Like the relay worker, this COMPOSES
 * the platform and reimplements nothing: the bus delivers and deserializes, the
 * dispatcher enforces barrier → idempotency → handler → retry, the DLQ absorbs
 * terminal failures. The worker's own job is the loop, the acknowledgement
 * decision, and the heartbeat.
 *
 * ── The acknowledgement decision is the whole worker ────────────────────────
 * `handled`, `suppressed-duplicate` and `dead-lettered` are all FINISHED —
 * the event will never be processed again by this group, so it is acked.
 * `held` and `retry` are NOT: leaving the entry pending is what makes
 * redelivery happen, either on the next read or through `claimStalled` after
 * the consumer that held it died. Acking a retryable event is how events are
 * lost, and nothing downstream would notice.
 *
 * ── A group sees its whole stream ───────────────────────────────────────────
 * One stream carries every event type of an aggregate family, so a group
 * receives types it has no handler for. Those are acked immediately and
 * ignored. Leaving them pending would grow the group's backlog forever with
 * events it was never meant to process.
 */

import {
  type DeadLetterQueue,
  type DeadLetterRequest,
  type DeliveredEvent,
  type Dispatcher,
  type ComposedRegistry,
  type EventBus,
  type GuardExecutor,
  type RegisteredHandler,
  type RetryAttempt,
} from '@contentos/events';

export interface ConsumerSubscription {
  readonly stream: string;
  readonly group: string;
  /** Every handler this group runs. One per (eventType, version). */
  readonly handlers: readonly RegisteredHandler[];
}

export interface ConsumerGroupHealth {
  readonly group: string;
  readonly stream: string;
  /** Null until the group has completed its first read. */
  readonly lastHeartbeatAt: Date | null;
  readonly handled: number;
  readonly suppressed: number;
  readonly deadLettered: number;
  readonly retried: number;
  readonly ignored: number;
  readonly inFlight: number;
}

export type ConsumerWorkerStatus = 'starting' | 'ready' | 'draining' | 'stopped';

export interface ConsumerWorkerHealth {
  readonly status: ConsumerWorkerStatus;
  readonly groups: readonly ConsumerGroupHealth[];
  readonly startedAt: Date;
  readonly cyclesCompleted: number;
}

export interface ConsumerWorkerDeps {
  readonly bus: EventBus;
  readonly dispatcher: Dispatcher;
  readonly subscriptions: readonly ConsumerSubscription[];
  /** This process's identity within each group, for XAUTOCLAIM attribution. */
  readonly consumerName: string;
  readonly batchSize?: number;
  readonly blockMs?: number;
  readonly idleIntervalMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => Date;
  readonly onError?: (error: unknown) => void;
}

export const DEFAULT_BATCH_SIZE = 16;
export const DEFAULT_BLOCK_MS = 2000;
export const DEFAULT_IDLE_INTERVAL_MS = 200;

/**
 * Yield to the event loop once per cycle.
 *
 * Same liveness requirement as the relay worker: a poll loop of pure promise
 * work drains only the microtask queue, so timers never fire and the SIGTERM
 * handler can never run.
 */
function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export interface ConsumerWorker {
  start(): Promise<void>;
  shutdown(): Promise<void>;
  health(): ConsumerWorkerHealth;
  /** One pass over every subscription. For tests and one-shot drains. */
  runCycle(): Promise<number>;
}

interface GroupState {
  lastHeartbeatAt: Date | null;
  handled: number;
  suppressed: number;
  deadLettered: number;
  retried: number;
  ignored: number;
  inFlight: number;
}

export function createConsumerWorker(deps: ConsumerWorkerDeps): ConsumerWorker {
  const now = deps.now ?? ((): Date => new Date());
  const sleep =
    deps.sleep ?? ((ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)));
  const batchSize = deps.batchSize ?? DEFAULT_BATCH_SIZE;
  const blockMs = deps.blockMs ?? DEFAULT_BLOCK_MS;
  const idleMs = deps.idleIntervalMs ?? DEFAULT_IDLE_INTERVAL_MS;

  const startedAt = now();
  let status: ConsumerWorkerStatus = 'starting';
  let cyclesCompleted = 0;
  let stopping = false;
  let running: Promise<void> | null = null;
  /**
   * Read through a function, not the variable.
   *
   * `shutdown` flips it across an `await`, which control-flow analysis cannot
   * see — it narrows the flag to `false` inside the loop and then reports the
   * second check as always true. The call is what keeps the check honest.
   */
  const stopRequested = (): boolean => stopping;

  const state = new Map<string, GroupState>(
    deps.subscriptions.map((s) => [
      s.group,
      {
        lastHeartbeatAt: null,
        handled: 0,
        suppressed: 0,
        deadLettered: 0,
        retried: 0,
        ignored: 0,
        inFlight: 0,
      },
    ]),
  );

  /** Handlers indexed by `eventType@version` within each group. */
  const handlersOf = new Map<string, Map<string, RegisteredHandler>>(
    deps.subscriptions.map((s) => [
      s.group,
      new Map(s.handlers.map((h) => [`${h.eventType}@${String(h.version)}`, h])),
    ]),
  );

  async function deliver(
    subscription: ConsumerSubscription,
    delivered: DeliveredEvent,
    group: GroupState,
  ): Promise<void> {
    const handler = handlersOf
      .get(subscription.group)
      ?.get(`${delivered.event.eventType}@${String(delivered.event.eventVersion)}`);

    if (handler === undefined) {
      // Not this group's concern. Ack so it leaves the backlog.
      group.ignored += 1;
      await deps.bus.ack(subscription.stream, subscription.group, delivered.entryId);
      return;
    }

    group.inFlight += 1;
    try {
      const outcome = await deps.dispatcher.dispatch(
        delivered.event,
        handler,
        delivered.deliveryCount,
        new AbortController().signal,
      );

      switch (outcome.kind) {
        case 'handled':
          group.handled += 1;
          break;
        case 'suppressed-duplicate':
          group.suppressed += 1;
          break;
        case 'dead-lettered':
          group.deadLettered += 1;
          break;
        case 'retry':
        case 'held':
          // Left PENDING on purpose — that is the redelivery mechanism.
          group.retried += 1;
          return;
      }
      await deps.bus.ack(subscription.stream, subscription.group, delivered.entryId);
    } finally {
      group.inFlight -= 1;
    }
  }

  async function drain(subscription: ConsumerSubscription): Promise<number> {
    const group = state.get(subscription.group);
    if (group === undefined) return 0;

    const batch = await deps.bus.readGroup({
      stream: subscription.stream,
      group: subscription.group,
      consumer: deps.consumerName,
      count: batchSize,
      blockMs,
    });

    // The heartbeat marks a completed READ, not a completed delivery: a group
    // blocked on an empty stream is healthy, and one that cannot read is not.
    group.lastHeartbeatAt = now();

    for (const delivered of batch) {
      await deliver(subscription, delivered, group);
    }
    return batch.length;
  }

  return {
    async runCycle(): Promise<number> {
      let processed = 0;
      for (const subscription of deps.subscriptions) {
        try {
          processed += await drain(subscription);
        } catch (error: unknown) {
          // One group's failure must not stop the others; the next cycle
          // retries, and unacked entries are still pending.
          deps.onError?.(error);
        }
      }
      cyclesCompleted += 1;
      return processed;
    },

    async start(): Promise<void> {
      if (running !== null) return running;
      status = 'ready';
      running = (async (): Promise<void> => {
        while (!stopRequested()) {
          const processed = await this.runCycle();
          await tick();
          if (processed === 0 && !stopRequested()) await sleep(idleMs);
        }
        status = 'stopped';
      })();
      return running;
    },

    async shutdown(): Promise<void> {
      stopping = true;
      status = 'draining';
      // Finish what is in flight rather than cutting a delivery short: a second
      // SIGTERM must not truncate the first drain.
      if (running !== null) await running;
      status = 'stopped';
    },

    health(): ConsumerWorkerHealth {
      return {
        status,
        startedAt,
        cyclesCompleted,
        groups: deps.subscriptions.map((s) => {
          const g = state.get(s.group);
          return {
            group: s.group,
            stream: s.stream,
            lastHeartbeatAt: g?.lastHeartbeatAt ?? null,
            handled: g?.handled ?? 0,
            suppressed: g?.suppressed ?? 0,
            deadLettered: g?.deadLettered ?? 0,
            retried: g?.retried ?? 0,
            ignored: g?.ignored ?? 0,
            inFlight: g?.inFlight ?? 0,
          };
        }),
      };
    },
  };
}

// ── Startup validation ──────────────────────────────────────────────────────

export class SubscriptionValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(
      `Consumer subscriptions are invalid; the worker must not start:\n  ${issues.join('\n  ')}`,
    );
    this.name = 'SubscriptionValidationError';
    this.issues = issues;
  }
}

/**
 * Subscriptions must agree with the registry.
 *
 * Registry composition already rejects a handler with no declaration and a
 * handler whose tenant scope disagrees with the event's. Two things it cannot
 * see are checked here, because both need the SUBSCRIPTIONS:
 *
 *   THE STREAM. A group reading the wrong stream starts cleanly, reports a
 *   healthy heartbeat, and receives nothing forever.
 *
 *   HOSTED-GROUP COMPLETENESS. A process must handle every type of every group
 *   it subscribes to. Subscribing to a group and handling only some of its
 *   declared types means the rest are read, found unhandled, and acked away —
 *   silently discarded by the one process that was supposed to act on them.
 *   Scoped to subscriptions rather than to every group in the registry, so a
 *   group hosted by a different process is not this one's problem.
 */
export function assertSubscriptionsMatchRegistry(
  composed: ComposedRegistry,
  subscriptions: readonly ConsumerSubscription[],
): void {
  const issues: string[] = [];
  const registry = composed.registry;

  for (const subscription of subscriptions) {
    if (subscription.handlers.length === 0) {
      issues.push(`Group '${subscription.group}' subscribes to no event type.`);
      continue;
    }

    const handled = new Set(
      subscription.handlers.map((h) => `${h.eventType}@${String(h.version)}`),
    );

    for (const handler of subscription.handlers) {
      if (!registry.isRegistered(handler.eventType, handler.version)) {
        issues.push(
          `Group '${subscription.group}' handles ${handler.eventType}@${String(handler.version)}, which the registry does not declare.`,
        );
        continue;
      }
      const declaredStream = registry.streamFor(handler.eventType);
      if (declaredStream !== subscription.stream) {
        issues.push(
          `Group '${subscription.group}' reads stream '${subscription.stream}' but ${handler.eventType} is declared on '${declaredStream}'. It would receive nothing.`,
        );
      }
      const declaresGroup = registry
        .consumersOf(handler.eventType)
        .some((c) => c.consumerGroup === subscription.group);
      if (!declaresGroup) {
        issues.push(
          `Group '${subscription.group}' handles ${handler.eventType} but is not declared as one of its consumers.`,
        );
      }
    }

    // Every type the registry says this group consumes must be handled here.
    for (const declaration of composed.declarations) {
      for (const consumer of declaration.consumers) {
        if (consumer.consumerGroup !== subscription.group) continue;
        for (const version of consumer.versions) {
          if (!handled.has(`${declaration.eventType}@${String(version)}`)) {
            issues.push(
              `Group '${subscription.group}' is declared as a consumer of ${declaration.eventType}@${String(version)} but registers no handler for it.`,
            );
          }
        }
      }
    }
  }

  if (issues.length > 0) throw new SubscriptionValidationError(issues);
}

// ── Dead-letter wiring ──────────────────────────────────────────────────────

/**
 * The dispatcher's `quarantine` hook, backed by the durable DLQ.
 *
 * The dispatcher reports a failure; it does not know the attempt history. The
 * worker does, so it supplies it — a DLQ entry without the retry history
 * cannot answer "was this failing the same way every time", which is the first
 * question asked of one (ADR-027).
 *
 * Event id, correlation id, causation id and producer all travel on the stored
 * envelope, so the entry is self-contained.
 */
export interface QuarantineDeps {
  readonly deadLetters: DeadLetterQueue;
  readonly transaction: <T>(work: (tx: GuardExecutor) => Promise<T>) => Promise<T>;
  readonly history: RetryHistory;
  readonly onQuarantined?: (request: DeadLetterRequest) => void;
}

/**
 * Per-(event, group) attempt log, kept only until the event leaves the worker.
 *
 * In memory on purpose: it exists to enrich a DLQ entry at the moment one is
 * written, and an entry that outlives the process it describes would be
 * reporting a history no longer being added to. The durable record is the DLQ
 * row itself (ADR-027).
 */
export interface RetryHistory {
  recordAttempt(eventId: string, group: string, code: string, at: Date): void;
  drain(eventId: string, group: string): readonly RetryAttempt[];
}

export function createRetryHistory(): RetryHistory {
  const attempts = new Map<string, RetryAttempt[]>();
  const key = (eventId: string, group: string): string => `${group}::${eventId}`;

  return {
    recordAttempt(eventId, group, code, at) {
      const k = key(eventId, group);
      const list = attempts.get(k) ?? [];
      list.push({ attempt: list.length + 1, at: at.toISOString(), code });
      attempts.set(k, list);
    },
    drain(eventId, group) {
      const k = key(eventId, group);
      const list = attempts.get(k) ?? [];
      // Drained so a replayed event starts a fresh history rather than
      // inheriting the one that put it in the queue.
      attempts.delete(k);
      return list;
    },
  };
}

export function createQuarantine(
  deps: QuarantineDeps,
): (request: DeadLetterRequest) => Promise<void> {
  return async (request: DeadLetterRequest): Promise<void> => {
    const retryHistory = deps.history.drain(request.event.eventId, request.consumerGroup);
    await deps.transaction(async (tx) => {
      await deps.deadLetters.quarantine(tx, {
        event: request.event,
        source: 'delivery',
        consumerGroup: request.consumerGroup,
        failureCode: request.failureCode,
        failureMessage: request.failureMessage,
        reason: request.reason,
        retryHistory,
      });
    });
    deps.onQuarantined?.(request);
  };
}
