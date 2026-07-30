/**
 * Cascade worker composition.
 *
 * The one place the pieces meet: connection → ports → cascade libraries →
 * handlers → subscriptions → registry validation. Every step already exists;
 * this decides how they are joined and refuses to start if they do not fit.
 *
 * ── Startup is fail-closed, in two passes ───────────────────────────────────
 *   `createWorkerEventRegistry` (T3.1) rejects a declared group with no
 *   handler, a handler with no declaration, and a handler whose tenant scope
 *   disagrees with the event's.
 *
 *   `assertSubscriptionsMatchRegistry` then rejects what the registry cannot
 *   see: a group reading a stream its events are not declared on, which would
 *   start cleanly, heartbeat healthily, and receive nothing forever.
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
  createMembershipCascade,
  createSuspensionCascade,
  ORGANIZATION_LIFECYCLE_CASCADE_GROUP,
  ORGANIZATION_MEMBERSHIP_CASCADE_GROUP,
  ORGANIZATION_STREAM,
  type WorkspaceMembershipService,
  type WorkspaceService,
} from '@contentos/platform';

import { createWorkerEventRegistry } from '../events/registry.js';
import {
  assertSubscriptionsMatchRegistry,
  createConsumerWorker,
  createQuarantine,
  createRetryHistory,
  type ConsumerSubscription,
  type ConsumerWorker,
  type RetryHistory,
} from './consumer-worker.js';
import { createCascadeHandlers } from './handlers.js';
import { createCascadeRunners } from './ports.js';

export interface CascadeWorkerOptions {
  readonly connection: TenantScopedConnection;
  readonly bus: EventBus;
  readonly deadLetters: DeadLetterQueue;
  readonly barrier: AggregateBarrier;
  readonly guard: IdempotencyGuard;
  readonly retry: RetryEngine;
  /**
   * The domain services the cascades drive.
   *
   * Injected rather than constructed here: they need a publisher and an audit
   * writer, which are process-wide concerns, and building a second copy inside
   * the worker would give it a different publisher from everything else.
   */
  readonly workspaces: WorkspaceService;
  readonly workspaceMemberships: WorkspaceMembershipService;
  /** Opens the transaction the idempotency marker and the DLQ entry commit in. */
  readonly transaction: <T>(work: (tx: GuardExecutor) => Promise<T>) => Promise<T>;
  readonly consumerName: string;
  readonly now?: () => Date;
  readonly onError?: (error: unknown) => void;
  readonly onQuarantined?: (group: string, code: string) => void;
}

export interface CascadeWorkerComposition {
  readonly worker: ConsumerWorker;
  readonly registry: ComposedRegistry;
  readonly subscriptions: readonly ConsumerSubscription[];
  readonly handlers: readonly RegisteredHandler[];
  readonly history: RetryHistory;
}

/**
 * Group the handlers into subscriptions by the group each declares.
 *
 * Derived rather than listed, so a handler cannot end up in a group nothing
 * reads — the grouping and the handlers cannot disagree because there is only
 * one source for both.
 */
export function subscriptionsFor(
  handlers: readonly RegisteredHandler[],
  stream: string,
): readonly ConsumerSubscription[] {
  const byGroup = new Map<string, RegisteredHandler[]>();
  for (const handler of handlers) {
    const list = byGroup.get(handler.group) ?? [];
    list.push(handler);
    byGroup.set(handler.group, list);
  }
  return [...byGroup.entries()].map(([group, groupHandlers]) => ({
    stream,
    group,
    handlers: groupHandlers,
  }));
}

/** The groups this worker hosts. Nothing else subscribes. */
export const CASCADE_CONSUMER_GROUPS: readonly string[] = [
  ORGANIZATION_LIFECYCLE_CASCADE_GROUP,
  ORGANIZATION_MEMBERSHIP_CASCADE_GROUP,
];

export function composeCascadeWorker(options: CascadeWorkerOptions): CascadeWorkerComposition {
  const runners = createCascadeRunners(options.connection);

  // The cascade libraries are used as they are. No cascade logic is written
  // here, and none is duplicated.
  const handlers = createCascadeHandlers({
    suspension: createSuspensionCascade({
      workspaces: options.workspaces,
      runner: runners.workspaces,
    }),
    memberships: createMembershipCascade({
      workspaces: options.workspaceMemberships,
      runner: runners.memberships,
    }),
  });

  // Pass 1 — the registry (T3.1).
  const registry = createWorkerEventRegistry(handlers);

  // All three types are organization-scoped and declared on one stream, so a
  // single stream serves both groups.
  const subscriptions = subscriptionsFor(handlers, ORGANIZATION_STREAM);

  // Pass 2 — the streams, which the registry cannot check.
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
        // A retried attempt is transient BY DEFINITION — that is what the retry
        // engine's classification decided. `DispatchOutcome.retry` carries no
        // code, so the per-attempt cause is only distinguishable on the final
        // one; what this preserves is the count and the window, which is what
        // "was it failing the same way every time" is actually asked of.
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
