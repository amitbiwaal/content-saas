/**
 * Job runner composition.
 *
 * The same shape as the cascade, credits and notification workers: handlers →
 * registry → subscriptions → validation, refusing to start if the pieces do not
 * fit. Nothing is duplicated — `subscriptionsFor`,
 * `assertSubscriptionsMatchRegistry`, `createConsumerWorker` and the dispatcher
 * are the ones already in use.
 *
 * ── One group, one stream ───────────────────────────────────────────────────
 * All five job types are declared on the `job` stream and only `JobQueued` has
 * a handler, so a single subscription covers it. The two-subscription shape the
 * other workers need is a consequence of their events living on different
 * streams; nothing here does.
 */

import {
  AI_REGISTRY_CONTRIBUTION,
  JOB_RUNNER_GROUP,
  JOB_STREAM,
  type JobService,
} from '@contentos/ai';
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
import { createJobHandlers } from './handlers.js';

export interface JobWorkerOptions {
  readonly bus: EventBus;
  readonly deadLetters: DeadLetterQueue;
  readonly barrier: AggregateBarrier;
  readonly guard: IdempotencyGuard;
  readonly retry: RetryEngine;
  /**
   * Injected rather than constructed here: it needs a publisher and an audit
   * writer, which are process-wide, and a second copy would publish elsewhere.
   */
  readonly jobs: JobService;
  /** Opens the transaction the marker, the DLQ entry AND the transition commit in. */
  readonly transaction: <T>(work: (tx: GuardExecutor) => Promise<T>) => Promise<T>;
  readonly consumerName: string;
  readonly now?: () => Date;
  readonly onError?: (error: unknown) => void;
  readonly onQuarantined?: (group: string, code: string) => void;
}

export interface JobWorkerComposition {
  readonly worker: ConsumerWorker;
  readonly registry: ComposedRegistry;
  readonly subscriptions: readonly ConsumerSubscription[];
  readonly handlers: readonly RegisteredHandler[];
  readonly history: RetryHistory;
}

/** The group this worker hosts. Nothing else subscribes. */
export const JOB_CONSUMER_GROUPS: readonly string[] = [JOB_RUNNER_GROUP];

/**
 * The contribution this worker's registry needs beyond the platform's.
 *
 * Exported so a composition root can see that hosting the job runner means
 * registering the AI package's declarations — the alternative, a registry
 * missing them, refuses to start rather than running blind.
 */
export const JOB_REGISTRY_CONTRIBUTION = AI_REGISTRY_CONTRIBUTION;

export function composeJobWorker(options: JobWorkerOptions): JobWorkerComposition {
  const handlers = createJobHandlers({ jobs: options.jobs });

  // Pass 1 — the registry (T3.1): declared group with no handler, handler with
  // no declaration, handler whose tenant scope disagrees with the event's.
  const registry = createWorkerEventRegistry(handlers);

  // Pass 2 — the streams, which the registry cannot check.
  const subscriptions = subscriptionsFor(handlers, JOB_STREAM);
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
