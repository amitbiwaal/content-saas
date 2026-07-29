/**
 * Event Platform tracing.
 *
 * Spec: `13-event-platform/observability.md` §"Tracing across the asynchronous
 * boundary".
 *
 * CONSUMERS START A NEW TRACE AND LINK; THEY DO NOT EXTEND THE PRODUCER'S. A
 * single request can cause hundreds of downstream events across hours. One
 * continuous trace would be unreadable and would hold the originating span open
 * far past the request that created it. The link preserves navigability without
 * that cost, and `correlationId` is what carries it.
 *
 * SUB-MILLISECOND CHECKS ARE SPAN ATTRIBUTES, NEVER SPANS. Idempotency
 * outcome, version transformation and barrier hold time are attributes on the
 * delivery span; a span per 3 ms check would multiply trace volume several-fold
 * for no diagnostic gain.
 *
 * TRACE ATTRIBUTES CARRY IDENTIFIERS ONLY. Payloads never appear in a trace,
 * and the identifiers that do — `aggregateId`, `correlationId` — are UUIDs that
 * disclose nothing about content.
 *
 * NO OpenTelemetry SDK IS IMPORTED HERE. `@contentos/observability` owns the
 * tracer abstraction and speaks W3C Trace Context, which is the wire format
 * OpenTelemetry itself propagates; exporters bind at the process edge. That is
 * what keeps instrumentation configured in one place.
 */

import type { DomainEvent } from '@contentos/contracts';
import type { Span, SpanAttributes, SpanContext, Tracer } from '@contentos/observability';

/** The W3C header the envelope's trace context travels in. */
export const TRACEPARENT_HEADER = 'traceparent';

export type SpanOutcome = 'ok' | 'error';

/**
 * Identifiers every Event Platform span carries.
 *
 * `eventId` locates one event across outbox, bus, DLQ, replay and idempotency
 * markers. `correlationId` groups everything caused by one originating request
 * — the primary incident query. `causationId` walks the causal chain one hop at
 * a time. `aggregateId` groups everything about one entity.
 */
function eventAttributes(event: DomainEvent<unknown>): SpanAttributes {
  return {
    tenantId: event.tenantId,
    correlationId: event.correlationId,
    'event.id': event.eventId,
    'event.type': event.eventType,
    'event.version': event.eventVersion,
    'event.producer': event.producer,
    'aggregate.id': event.aggregateId,
    'aggregate.type': event.aggregateType,
    ...(event.causationId === null ? {} : { 'causation.id': event.causationId }),
  };
}

export interface EventTracer {
  /** Publish happens inside the producer's transaction, so it EXTENDS that trace. */
  publishSpan(event: DomainEvent<unknown>, parent?: SpanContext | null): Span;
  /** The relay is its own trace, linked to the originating request. */
  relaySpan(event: DomainEvent<unknown>): Span;
  /** Delivery starts a NEW trace linked by correlationId — never an extension. */
  deliverySpan(event: DomainEvent<unknown>, group: string): Span;
  /** A child of the delivery span; handler time is what an operator asks for. */
  handlerSpan(parent: Span, event: DomainEvent<unknown>, group: string): Span;
  /** Each replay RUN is a trace; each delivery within it is a linked span. */
  replayRunSpan(runId: string, mode: string, tenantId: string, correlationId: string): Span;
  replayDeliverySpan(event: DomainEvent<unknown>, group: string, runId: string): Span;
  /** Extract inbound W3C trace context from a carrier. */
  extract(traceparent: string | null | undefined): SpanContext | null;
  /** Format outbound W3C trace context for a carrier. */
  inject(span: Span): string;
}

/** Attribute keys for the sub-millisecond checks that must NOT become spans. */
export const SPAN_ATTRIBUTES = Object.freeze({
  idempotencyOutcome: 'idempotency.outcome',
  versionFrom: 'version.from',
  versionTo: 'version.to',
  orderingHeldMs: 'ordering.held_ms',
  deliveryAttempt: 'delivery.attempt',
  deliveryCount: 'delivery.count',
  replayRunId: 'replay.run_id',
  replayMode: 'replay.mode',
  failureCode: 'failure.code',
});

export function createEventTracer(tracer: Tracer): EventTracer {
  return {
    publishSpan(event, parent): Span {
      // The producer's transaction is still open, so this is the one place the
      // platform genuinely continues the caller's trace.
      return tracer.startSpan('outbox.publish', eventAttributes(event), parent);
    },

    relaySpan(event): Span {
      return tracer.startLinkedSpan('outbox.relay', eventAttributes(event), event.correlationId);
    },

    deliverySpan(event, group): Span {
      return tracer.startLinkedSpan(
        'event.deliver',
        { ...eventAttributes(event), 'consumer.group': group },
        event.correlationId,
      );
    },

    handlerSpan(parent, event, group): Span {
      return tracer.startSpan(
        'event.handle',
        { ...eventAttributes(event), 'consumer.group': group },
        parent.context,
      );
    },

    replayRunSpan(runId, mode, tenantId, correlationId): Span {
      return tracer.startSpan(
        'replay.run',
        {
          tenantId,
          correlationId,
          [SPAN_ATTRIBUTES.replayRunId]: runId,
          [SPAN_ATTRIBUTES.replayMode]: mode,
        },
        null,
      );
    },

    /**
     * A replayed delivery links back to the ORIGINAL event's correlationId, so
     * an operator can navigate from a redelivery to the operation that first
     * produced the event — which is the question asked when a replay causes a
     * surprise.
     */
    replayDeliverySpan(event, group, runId): Span {
      return tracer.startLinkedSpan(
        'replay.deliver',
        {
          ...eventAttributes(event),
          'consumer.group': group,
          [SPAN_ATTRIBUTES.replayRunId]: runId,
        },
        event.correlationId,
      );
    },

    extract(traceparent): SpanContext | null {
      return tracer.extract(traceparent);
    },

    inject(span): string {
      return tracer.inject(span.context);
    },
  };
}

/**
 * Head-based sampler that ALWAYS samples an invariant breach.
 *
 * A breach dropped by a 1% sampler is a correctness incident with no trace
 * attached — the single case where the trace matters most. Compose this around
 * whatever rate the deployment chooses.
 */
export function samplerAlwaysSamplingBreaches(
  base: (name: string, attributes: SpanAttributes) => boolean,
): (name: string, attributes: SpanAttributes) => boolean {
  return (name, attributes): boolean => {
    if (name.startsWith('invariant.') || attributes['invariant.breach'] !== undefined) return true;
    return base(name, attributes);
  };
}
