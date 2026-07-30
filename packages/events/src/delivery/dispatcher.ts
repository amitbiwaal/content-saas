/**
 * Event dispatcher.
 *
 * Spec: `13-event-platform/event-apis.md` §"API surface 7 — Consumer runtime".
 *
 * DELIVERY COMPOSITION ORDER IS FIXED — barrier, then idempotency, then
 * handler, with retry on the failure path. The order is not arbitrary:
 *
 *   The barrier must be OUTERMOST, or a held event would consume an
 *   idempotency marker before being deferred — and would then be suppressed
 *   forever when it was redelivered.
 *
 *   Idempotency must WRAP the handler so the marker and the effects share one
 *   transaction. Split them and a crash between the two either loses the effect
 *   or repeats it.
 *
 *   Retry is outermost on the FAILURE path, because it decides the event's fate
 *   after everything else has declined to handle it.
 */

import type { DomainEvent, EventTenantScope, TenantContext } from '@contentos/contracts';

import type { AggregateBarrier, GuardExecutor, IdempotencyGuard } from './guards.js';
import type { DeadLetterReason, RetryEngine } from './retry.js';

export interface RegisteredHandler {
  readonly eventType: string;
  /** Exactly one version per handler. Handlers contain NO version branching. */
  readonly version: number;
  readonly group: string;
  /**
   * The tenant scope this handler is written for — ADR-029. Declared, never
   * inferred.
   *
   * A handler that reconstructs workspace context from an organization-scoped
   * event sets `app.tenant_id` to an organization id and reads zero rows
   * without erroring. Composition rejects a mismatch at startup; the dispatcher
   * re-checks it as defence in depth.
   */
  readonly tenantScope: EventTenantScope;
  handle(
    event: DomainEvent<unknown>,
    ctx: TenantContext,
    tx: GuardExecutor,
    signal: AbortSignal,
  ): Promise<void>;
}

export interface DeadLetterRequest {
  readonly event: DomainEvent<unknown>;
  readonly consumerGroup: string;
  readonly failureCode: string;
  readonly failureMessage: string;
  /**
   * Why the event was dead-lettered. Taken from  directly:
   * inferring it from the  union resolves to , because a
   * non-distributive conditional over a union matches neither branch.
   */
  readonly reason: DeadLetterReason;
}

export interface DispatchDeps {
  readonly barrier: AggregateBarrier;
  readonly guard: IdempotencyGuard;
  readonly retry: RetryEngine;
  /** Opens a transaction; the handler and the marker commit together. */
  readonly transaction: <T>(work: (tx: GuardExecutor) => Promise<T>) => Promise<T>;
  readonly quarantine: (request: DeadLetterRequest) => Promise<void>;
  readonly onOutcome?: (outcome: DispatchOutcome) => void;
  /**
   * The declared tenant scope of an event type — ADR-029, supplied by the
   * composed registry.
   *
   * OPTIONAL so that composing it is a decision of the process root and every
   * existing caller behaves exactly as before. When present, an event whose
   * declared scope disagrees with the handler's is refused.
   */
  readonly tenantScopeOf?: (eventType: string, version: number) => EventTenantScope | undefined;
}

/** The failure code recorded when a scope mismatch reaches delivery. */
export const TENANT_SCOPE_MISMATCH = 'TenantScopeMismatch';

export type DispatchOutcome =
  | { readonly kind: 'handled'; readonly eventId: string; readonly group: string }
  | { readonly kind: 'suppressed-duplicate'; readonly eventId: string; readonly group: string }
  | { readonly kind: 'held'; readonly eventId: string; readonly group: string }
  | {
      readonly kind: 'retry';
      readonly eventId: string;
      readonly group: string;
      readonly delayMs: number;
    }
  | {
      readonly kind: 'dead-lettered';
      readonly eventId: string;
      readonly group: string;
      readonly code: string;
    };

function errorCode(error: unknown): string {
  if (error !== null && typeof error === 'object' && 'code' in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return error instanceof Error ? error.name : 'UnknownError';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Tenant context comes from the ENVELOPE, never from ambient state. */
function contextOf(event: DomainEvent<unknown>): TenantContext {
  return {
    tenantId: event.tenantId,
    organizationId: event.organizationId,
    source: 'event',
  };
}

export interface Dispatcher {
  dispatch(
    event: DomainEvent<unknown>,
    handler: RegisteredHandler,
    attempt: number,
    signal: AbortSignal,
  ): Promise<DispatchOutcome>;
}

export function createDispatcher(deps: DispatchDeps): Dispatcher {
  const emit = (outcome: DispatchOutcome): DispatchOutcome => {
    deps.onOutcome?.(outcome);
    return outcome;
  };

  return {
    async dispatch(event, handler, attempt, signal): Promise<DispatchOutcome> {
      // 0 · SCOPE — ADR-029, before the barrier.
      //
      // A mismatch is a DEFECT, not a transient failure: retrying it would
      // produce the same wrong answer, and letting it through would have the
      // handler reconstruct tenant context from the wrong scope and read zero
      // rows without erroring. Quarantined before the barrier is acquired and
      // before any idempotency marker is consumed, so the aggregate is not
      // advanced and a corrected deployment can replay it.
      const declaredScope = deps.tenantScopeOf?.(event.eventType, event.eventVersion);
      if (declaredScope !== undefined && declaredScope !== handler.tenantScope) {
        await deps.quarantine({
          event,
          consumerGroup: handler.group,
          failureCode: TENANT_SCOPE_MISMATCH,
          failureMessage: `${event.eventType}@${String(event.eventVersion)} is '${declaredScope}'-scoped but the handler in group '${handler.group}' accepts '${handler.tenantScope}'.`,
          reason: 'terminal-classification',
        });
        return emit({
          kind: 'dead-lettered',
          eventId: event.eventId,
          group: handler.group,
          code: TENANT_SCOPE_MISMATCH,
        });
      }

      // 1 · BARRIER — outermost.
      const token = await deps.barrier.acquire(handler.group, event.aggregateId, event.eventId);
      if (token === 'held') {
        // Released for later redelivery. No marker was consumed.
        return emit({ kind: 'held', eventId: event.eventId, group: handler.group });
      }

      try {
        // 2 · IDEMPOTENCY wrapping 3 · HANDLER, in ONE transaction.
        const result = await deps.transaction(async (tx) =>
          deps.guard.execute(tx, event, handler.group, async (inner) => {
            await handler.handle(event, contextOf(event), inner, signal);
          }),
        );

        await deps.barrier.release(token);

        return emit(
          result.outcome === 'suppressed-duplicate'
            ? { kind: 'suppressed-duplicate', eventId: event.eventId, group: handler.group }
            : { kind: 'handled', eventId: event.eventId, group: handler.group },
        );
      } catch (error) {
        // 4 · RETRY — outermost on the failure path.
        const code = errorCode(error);
        const decision = deps.retry.decide({
          eventId: event.eventId,
          eventType: event.eventType,
          consumerGroup: handler.group,
          attempt,
          code,
        });

        if (decision.action === 'dead-letter') {
          // Quarantine BEFORE releasing the barrier, so the aggregate cannot
          // advance past an event that is not yet durably recorded as failed.
          await deps.quarantine({
            event,
            consumerGroup: handler.group,
            failureCode: code,
            failureMessage: errorMessage(error),
            reason: decision.reason,
          });
          await deps.barrier.releaseWithGap(token, event.eventId);
          return emit({
            kind: 'dead-lettered',
            eventId: event.eventId,
            group: handler.group,
            code,
          });
        }

        // The transaction already rolled back, so no marker was left behind and
        // the redelivery is a genuine retry rather than a suppressed duplicate.
        await deps.barrier.release(token);
        return emit({
          kind: 'retry',
          eventId: event.eventId,
          group: handler.group,
          delayMs: decision.delayMs,
        });
      }
    },
  };
}
