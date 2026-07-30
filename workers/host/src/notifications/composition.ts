/**
 * Notification worker composition.
 *
 * The same shape as the cascade and credits workers: handlers → registry →
 * subscriptions → validation, refusing to start if the pieces do not fit.
 * Nothing is duplicated — `subscriptionsFor`, `assertSubscriptionsMatchRegistry`,
 * `createConsumerWorker` and the dispatcher are the ones already in use.
 *
 * ── Two groups, because two streams ─────────────────────────────────────────
 * The credit thresholds are declared on `credit` and the settings and flag
 * changes on `settings`. A consumer group reads ONE stream, so a single group
 * could only ever receive half of them — and would start cleanly, heartbeat
 * healthily, and silently never notify anyone about the other half.
 *
 * ── No port ─────────────────────────────────────────────────────────────────
 * There is no `ports.ts` here. Every event is organization-scoped and a
 * notification is keyed on the organization, so the dispatcher's own
 * transaction is already the right one: the record and the idempotency marker
 * commit together. A port would open a second transaction and give that up.
 */

import {
  createDispatcher,
  type AggregateBarrier,
  type ComposedRegistry,
  type DeadLetterQueue,
  type EventBus,
  type GuardExecutor,
  type IdempotencyGuard,
  type RegisteredHandler,
  type RetryEngine,
} from '@contentos/events';
import {
  CREDIT_STREAM,
  NOTIFICATIONS_BILLING_GROUP,
  NOTIFICATIONS_PLATFORM_GROUP,
  SETTINGS_STREAM,
  type NotificationService,
} from '@contentos/platform';

import { subscriptionsFor } from '../cascade/composition.js';
import {
  assertSubscriptionsMatchRegistry,
  createConsumerWorker,
  createQuarantine,
  createRetryHistory,
  type ConsumerSubscription,
  type ConsumerWorker,
  type RetryHistory,
} from '../cascade/consumer-worker.js';
import { createWorkerEventRegistry } from '../events/registry.js';
import { createNotificationHandlers } from './handlers.js';

export interface NotificationWorkerOptions {
  readonly bus: EventBus;
  readonly deadLetters: DeadLetterQueue;
  readonly barrier: AggregateBarrier;
  readonly guard: IdempotencyGuard;
  readonly retry: RetryEngine;
  /**
   * Injected rather than constructed here: it needs an audit writer, which is a
   * process-wide concern, and a second copy would write somewhere else.
   */
  readonly notifications: NotificationService;
  /** Opens the transaction the marker, the DLQ entry AND the record commit in. */
  readonly transaction: <T>(work: (tx: GuardExecutor) => Promise<T>) => Promise<T>;
  readonly consumerName: string;
  readonly now?: () => Date;
  readonly onError?: (error: unknown) => void;
  readonly onQuarantined?: (group: string, code: string) => void;
}

export interface NotificationWorkerComposition {
  readonly worker: ConsumerWorker;
  readonly registry: ComposedRegistry;
  readonly subscriptions: readonly ConsumerSubscription[];
  readonly handlers: readonly RegisteredHandler[];
  readonly history: RetryHistory;
}

/** The groups this worker hosts. Nothing else subscribes. */
export const NOTIFICATION_CONSUMER_GROUPS: readonly string[] = [
  NOTIFICATIONS_BILLING_GROUP,
  NOTIFICATIONS_PLATFORM_GROUP,
];

/**
 * Split handlers by the stream their group reads.
 *
 * Derived from the group each handler declares rather than listed, so a handler
 * cannot end up subscribed to a stream its events never reach.
 */
export function notificationSubscriptions(
  handlers: readonly RegisteredHandler[],
): readonly ConsumerSubscription[] {
  return [
    ...subscriptionsFor(
      handlers.filter((h) => h.group === NOTIFICATIONS_BILLING_GROUP),
      CREDIT_STREAM,
    ),
    ...subscriptionsFor(
      handlers.filter((h) => h.group === NOTIFICATIONS_PLATFORM_GROUP),
      SETTINGS_STREAM,
    ),
  ];
}

export function composeNotificationWorker(
  options: NotificationWorkerOptions,
): NotificationWorkerComposition {
  const handlers = createNotificationHandlers({ notifications: options.notifications });

  // Pass 1 — the registry (T3.1): declared group with no handler, handler with
  // no declaration, handler whose tenant scope disagrees with the event's.
  const registry = createWorkerEventRegistry(handlers);

  // Pass 2 — the streams, which the registry cannot check.
  const subscriptions = notificationSubscriptions(handlers);
  assertSubscriptionsMatchRegistry(registry, subscriptions);

  const history = createRetryHistory();
  const now = options.now ?? ((): Date => new Date());

  const worker = createConsumerWorker({
    bus: options.bus,
    dispatcher: createDispatcher({
      barrier: options.barrier,
      guard: options.guard,
      retry: options.retry,
      transaction: options.transaction,
      quarantine: createQuarantine({
        deadLetters: options.deadLetters,
        transaction: options.transaction,
        history,
        onQuarantined: (r) => options.onQuarantined?.(r.consumerGroup, r.failureCode),
      }),
      // ADR-029 — the declared scope, resolved from the composed registry.
      tenantScopeOf: registry.tenantScopeOf,
      onOutcome: (outcome) => {
        if (outcome.kind === 'retry') {
          history.recordAttempt(outcome.eventId, outcome.group, 'transient', now());
        }
      },
    }),
    subscriptions,
    consumerName: options.consumerName,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.onError === undefined ? {} : { onError: options.onError }),
  });

  return { worker, registry, subscriptions, handlers, history };
}
