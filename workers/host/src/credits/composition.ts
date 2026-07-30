/**
 * Credits worker composition.
 *
 * The same shape as the cascade worker's: connection → port → service →
 * handlers → subscriptions → registry validation, refusing to start if the
 * pieces do not fit. Nothing is duplicated — `subscriptionsFor`,
 * `assertSubscriptionsMatchRegistry`, `createConsumerWorker` and the dispatcher
 * are the ones already in use.
 *
 * ── Why TWO subscriptions and not one ───────────────────────────────────────
 * `OrganizationSuspended` is declared on the `organization` stream and
 * `WorkspaceSuspended` on `workspace`. A consumer group reads ONE stream, so a
 * single group could only ever receive one of the two — and would start
 * cleanly, heartbeat healthily, and silently leave half the holds open. The
 * split is what `assertSubscriptionsMatchRegistry` exists to force.
 */

import type { TenantScopedConnection } from '@contentos/database';
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
  CREDITS_ORGANIZATION_RELEASE_GROUP,
  CREDITS_WORKSPACE_RELEASE_GROUP,
  ORGANIZATION_STREAM,
  WORKSPACE_STREAM,
  type CreditsService,
} from '@contentos/platform';

import {
  assertSubscriptionsMatchRegistry,
  createConsumerWorker,
  createQuarantine,
  createRetryHistory,
  type ConsumerSubscription,
  type ConsumerWorker,
  type RetryHistory,
} from '../cascade/consumer-worker.js';
import { subscriptionsFor } from '../cascade/composition.js';
import { createWorkerEventRegistry } from '../events/registry.js';
import { createCreditsHandlers } from './handlers.js';
import { createCreditsRunner } from './ports.js';

export interface CreditsWorkerOptions {
  readonly connection: TenantScopedConnection;
  readonly bus: EventBus;
  readonly deadLetters: DeadLetterQueue;
  readonly barrier: AggregateBarrier;
  readonly guard: IdempotencyGuard;
  readonly retry: RetryEngine;
  /**
   * Injected rather than constructed here: it needs a publisher and a ledger,
   * which are process-wide, and a second copy would publish somewhere else.
   */
  readonly credits: CreditsService;
  /** Opens the transaction the idempotency marker and the DLQ entry commit in. */
  readonly transaction: <T>(work: (tx: GuardExecutor) => Promise<T>) => Promise<T>;
  readonly consumerName: string;
  readonly now?: () => Date;
  readonly onError?: (error: unknown) => void;
  readonly onQuarantined?: (group: string, code: string) => void;
}

export interface CreditsWorkerComposition {
  readonly worker: ConsumerWorker;
  readonly registry: ComposedRegistry;
  readonly subscriptions: readonly ConsumerSubscription[];
  readonly handlers: readonly RegisteredHandler[];
  readonly history: RetryHistory;
}

/** The groups this worker hosts. Nothing else subscribes. */
export const CREDITS_CONSUMER_GROUPS: readonly string[] = [
  CREDITS_ORGANIZATION_RELEASE_GROUP,
  CREDITS_WORKSPACE_RELEASE_GROUP,
];

/**
 * Split handlers by the stream their group reads.
 *
 * Derived from the group each handler declares rather than listed, so a handler
 * cannot end up subscribed to a stream its events never reach.
 */
export function creditsSubscriptions(
  handlers: readonly RegisteredHandler[],
): readonly ConsumerSubscription[] {
  const onOrganizationStream = handlers.filter(
    (h) => h.group === CREDITS_ORGANIZATION_RELEASE_GROUP,
  );
  const onWorkspaceStream = handlers.filter((h) => h.group === CREDITS_WORKSPACE_RELEASE_GROUP);
  return [
    ...subscriptionsFor(onOrganizationStream, ORGANIZATION_STREAM),
    ...subscriptionsFor(onWorkspaceStream, WORKSPACE_STREAM),
  ];
}

export function composeCreditsWorker(options: CreditsWorkerOptions): CreditsWorkerComposition {
  const handlers = createCreditsHandlers({
    credits: options.credits,
    runner: createCreditsRunner(options.connection),
  });

  // Pass 1 — the registry (T3.1): declared group with no handler, handler with
  // no declaration, handler whose tenant scope disagrees with the event's.
  const registry = createWorkerEventRegistry(handlers);

  // Pass 2 — the streams, which the registry cannot check.
  const subscriptions = creditsSubscriptions(handlers);
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
