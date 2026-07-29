import { describe, expect, it } from 'vitest';

import type { DomainEvent } from '@contentos/contracts';
import { createTracer, MetricRegistry, type FinishedSpan } from '@contentos/observability';

import { createEventLogger, type EventPlatformLogRecord } from './event-log.js';
import { createEventPlatformMetrics, type InvariantBreach } from './event-metrics.js';
import {
  createEventTracer,
  samplerAlwaysSamplingBreaches,
  SPAN_ATTRIBUTES,
} from './event-tracing.js';

const NOW = new Date('2026-07-29T12:00:00.000Z');

function event(over: Partial<DomainEvent<unknown>> = {}): DomainEvent<unknown> {
  return {
    eventId: '018f7a1e-0000-7000-8000-000000000001',
    eventType: 'ArticlePublished',
    eventVersion: 2,
    aggregateType: 'Article',
    aggregateId: '018f7a1e-0000-7000-8000-0000000000c1',
    tenantId: '018f7a1e-0000-7000-8000-0000000000bb',
    organizationId: '018f7a1e-0000-7000-8000-0000000000aa',
    correlationId: '018f7a1e-0000-7000-8000-0000000000dd',
    causationId: null,
    producer: 'content-platform',
    occurredAt: '2026-07-20T10:00:00.000Z',
    payload: { articleId: 'a1', secret: 'must-never-be-logged' },
    ...over,
  };
}

function metrics(onBreach?: (b: InvariantBreach) => void) {
  const registry = new MetricRegistry();
  const instance = createEventPlatformMetrics({
    registry,
    now: () => NOW,
    ...(onBreach === undefined ? {} : { onInvariantBreach: onBreach }),
  });
  return { registry, instance };
}

function sample(registry: MetricRegistry, name: string): number {
  return registry
    .collect()
    .filter((s) => s.name === name)
    .reduce((acc, s) => acc + (typeof s.value === 'number' ? s.value : 0), 0);
}

/** Histograms collect under the base name, carrying count/sum/buckets. */
function histogramSum(registry: MetricRegistry, name: string): number {
  return registry
    .collect()
    .filter((s) => s.name === name)
    .reduce((acc, s) => acc + (s.histogram?.sum ?? 0), 0);
}

describe('metric catalogue', () => {
  // Names are frozen: a dashboard written against one name is blind to another.
  it('emits the catalogued publication names', () => {
    const m = metrics();
    m.instance.recordPublish('ArticlePublished', 'content-platform', 8);
    const names = new Set(m.registry.collect().map((s) => s.name));
    expect(names.has('outbox_events_published_total')).toBe(true);
    expect(names.has('outbox_publish_duration_seconds')).toBe(true);
  });

  // The names say `_seconds`; recording milliseconds into them would make every
  // SLO threshold wrong by three orders of magnitude.
  it('records durations in seconds, not milliseconds', () => {
    const m = metrics();
    m.instance.recordRelayLag(new Date(NOW.getTime() - 2000), NOW);
    expect(histogramSum(m.registry, 'outbox_relay_lag_seconds')).toBeCloseTo(2, 5);
    m.instance.recordHandlerDuration('read-models', 'ArticlePublished', 1500);
    expect(histogramSum(m.registry, 'handler_duration_seconds')).toBeCloseTo(1.5, 5);
    m.instance.recordPublish('ArticlePublished', 'content-platform', 8);
    expect(histogramSum(m.registry, 'outbox_publish_duration_seconds')).toBeCloseTo(0.008, 5);
  });

  it('counts delivery throughput by outcome', () => {
    const m = metrics();
    m.instance.recordDelivery('read-models', event(), 'handled');
    m.instance.recordDelivery('read-models', event(), 'dead-lettered');
    expect(sample(m.registry, 'event_throughput_total')).toBe(2);
  });

  // Lag is measured in TIME, not entry count: a backlog of 50,000 means nothing
  // without a drain rate.
  it('measures consumer lag in seconds of age', () => {
    const m = metrics();
    m.instance.recordLag('read-models', 'ArticlePublished', new Date(NOW.getTime() - 40_000));
    expect(sample(m.registry, 'consumer_lag_seconds')).toBe(40);
  });

  it('records retry, terminal failure and DLQ counters', () => {
    const m = metrics();
    m.instance.recordRetryAttempt('read-models', 'ArticlePublished', 'transient');
    m.instance.recordTerminalFailure('read-models', 'SchemaViolation');
    m.instance.recordDeadLettered('ArticlePublished', 'read-models', 'SchemaViolation', 'delivery');
    expect(sample(m.registry, 'retry_attempts_total')).toBe(1);
    expect(sample(m.registry, 'terminal_failures_total')).toBe(1);
    expect(sample(m.registry, 'dlq_entries_total')).toBe(1);
  });

  it('records the replay counters, including the safety proof', () => {
    const m = metrics();
    m.instance.recordReplayRun('range', 'completed');
    m.instance.recordReplayDelivered('read-models', 5);
    m.instance.recordReplaySkipped('registry-rejected');
    m.instance.recordReplayDuplicateSuppressed('read-models');
    m.instance.recordBackpressurePause();
    m.instance.recordDeletedTenantSkip();
    expect(sample(m.registry, 'replay_runs_total')).toBe(1);
    expect(sample(m.registry, 'replay_events_delivered_total')).toBe(5);
    expect(sample(m.registry, 'replay_duplicates_suppressed_total')).toBe(1);
    expect(sample(m.registry, 'replay_backpressure_pauses_total')).toBe(1);
    expect(sample(m.registry, 'replay_deleted_tenant_skips_total')).toBe(1);
  });

  it('records worker health gauges', () => {
    const m = metrics();
    m.instance.setWorkerInstances('read-models', 3);
    m.instance.setWorkerInFlight('read-models', 2);
    expect(sample(m.registry, 'worker_instances')).toBe(3);
    expect(sample(m.registry, 'worker_in_flight')).toBe(2);
  });

  it('records the Redis-facing depth gauges', () => {
    const m = metrics();
    m.instance.setQueueDepth('ArticlePublished', 120);
    m.instance.setConsumerPendingDepth('read-models', 7);
    m.instance.recordStalledClaimed('read-models', 4);
    expect(sample(m.registry, 'queue_depth')).toBe(120);
    expect(sample(m.registry, 'consumer_pending_depth')).toBe(7);
    expect(sample(m.registry, 'stalled_entries_claimed_total')).toBe(4);
  });

  // An invariant breach is a broken guarantee, not a degradation: it pages at
  // count one and takes a path that cannot be mistaken for a metric.
  it('routes an invariant breach out of band as well as counting it', () => {
    const seen: InvariantBreach[] = [];
    const m = metrics((b) => seen.push(b));
    m.instance.recordInvariantBreach({
      kind: 'ordering-violation',
      group: 'read-models',
      eventId: 'e1',
      eventType: 'ArticlePublished',
      tenantId: 't1',
      detail: 'out of order',
    });
    expect(sample(m.registry, 'ordering_violations_total')).toBe(1);
    expect(seen).toHaveLength(1);
  });

  it('reports every breach kind through the callback', () => {
    const seen: InvariantBreach[] = [];
    const m = metrics((b) => seen.push(b));
    for (const kind of ['idempotency-failure', 'registry-bypass', 'publish-side-dlq'] as const) {
      m.instance.recordInvariantBreach({
        kind,
        group: null,
        eventId: 'e',
        eventType: 'T',
        tenantId: 't',
        detail: 'd',
      });
    }
    expect(seen.map((b) => b.kind)).toEqual([
      'idempotency-failure',
      'registry-bypass',
      'publish-side-dlq',
    ]);
  });

  // Cardinality discipline is the difference between observability and an
  // outage: one time series per tenant or per event takes the backend down.
  it('refuses a high-cardinality label', () => {
    const registry = new MetricRegistry();
    expect(() =>
      registry.counter({ name: 'x_total', help: 'x', labelNames: ['tenant_id'] }),
    ).toThrow();
  });
});

describe('structured logging', () => {
  function logger(minLevel?: 'debug' | 'info' | 'warn' | 'error') {
    const written: EventPlatformLogRecord[] = [];
    const instance = createEventLogger({
      sink: { write: (r) => written.push(r) },
      clock: () => NOW,
      ...(minLevel === undefined ? {} : { minLevel }),
    });
    return { instance, written };
  }

  it('emits every correlation field the platform is diagnosed with', () => {
    const l = logger();
    l.instance.info(event({ causationId: 'c-1' }), {
      component: 'dispatcher',
      event: 'delivered',
      outcome: 'handled',
      group: 'read-models',
    });
    const record = l.written[0];
    expect(record?.eventId).toBe('018f7a1e-0000-7000-8000-000000000001');
    expect(record?.correlationId).toBe('018f7a1e-0000-7000-8000-0000000000dd');
    expect(record?.causationId).toBe('c-1');
    expect(record?.aggregateId).toBe('018f7a1e-0000-7000-8000-0000000000c1');
    expect(record?.tenantId).toBe('018f7a1e-0000-7000-8000-0000000000bb');
    expect(record?.eventType).toBe('ArticlePublished');
    expect(record?.eventVersion).toBe(2);
    expect(record?.group).toBe('read-models');
  });

  // Payloads reach a broader audience than the database and outlive it in
  // aggregation systems. The record type has no payload field at all.
  it('never emits the payload, at any level', () => {
    const l = logger('debug');
    for (const level of ['debug', 'info', 'warn'] as const) {
      l.instance[level](event(), {
        component: 'relay',
        event: 'claimed',
        outcome: 'ok',
      });
    }
    l.instance.error(event(), {
      component: 'relay',
      event: 'dead-lettered',
      outcome: 'failed',
      errorCode: 'BusUnavailable',
    });
    const serialised = JSON.stringify(l.written);
    expect(serialised).not.toContain('must-never-be-logged');
    expect(serialised).not.toContain('payload');
  });

  it('carries the replay run id and the retry attempt', () => {
    const l = logger();
    l.instance.info(event(), {
      component: 'replay',
      event: 'replayed',
      outcome: 'delivered',
      group: 'read-models',
      replayRunId: 'run-7',
      attempt: 3,
    });
    expect(l.written[0]?.replayRunId).toBe('run-7');
    expect(l.written[0]?.attempt).toBe(3);
  });

  it('records the failure reason as a classification code', () => {
    const l = logger();
    l.instance.error(event(), {
      component: 'dlq',
      event: 'dead-lettered',
      outcome: 'failed',
      errorCode: 'SchemaViolation',
    });
    expect(l.written[0]?.errorCode).toBe('SchemaViolation');
    expect(l.written[0]?.level).toBe('error');
  });

  // An error silenced by a config change is an error nobody learns about.
  it('never suppresses error or warn by level configuration', () => {
    const l = logger('error');
    l.instance.debug(event(), { component: 'relay', event: 'claimed', outcome: 'ok' });
    l.instance.info(event(), { component: 'relay', event: 'claimed', outcome: 'ok' });
    l.instance.warn(event(), { component: 'relay', event: 'held', outcome: 'held' });
    l.instance.error(event(), {
      component: 'relay',
      event: 'dead-lettered',
      outcome: 'failed',
      errorCode: 'X',
    });
    expect(l.written.map((r) => r.level)).toEqual(['warn', 'error']);
  });

  it('suppresses debug below the configured level', () => {
    const l = logger('info');
    l.instance.debug(event(), { component: 'relay', event: 'claimed', outcome: 'ok' });
    expect(l.written).toHaveLength(0);
  });

  // A raw dependency error routinely embeds a connection string.
  it('redacts a credential that reached the classification field', () => {
    const hits: number[] = [];
    const written: EventPlatformLogRecord[] = [];
    const instance = createEventLogger({
      sink: { write: (r) => written.push(r) },
      clock: () => NOW,
      onRedactionHit: (n) => hits.push(n),
    });
    instance.error(event(), {
      component: 'relay',
      event: 'dead-lettered',
      outcome: 'failed',
      errorCode: 'upstream rejected: Bearer aVeryLongLookingAccessToken123456',
    });
    expect(hits.length).toBeGreaterThan(0);
    expect(written[0]?.errorCode).not.toContain('aVeryLongLookingAccessToken123456');
  });

  // Telemetry must never block the platform.
  it('reports a failing sink rather than throwing into the caller', () => {
    const failures: unknown[] = [];
    const instance = createEventLogger({
      sink: {
        write(): void {
          throw new Error('sink down');
        },
      },
      onDeliveryFailure: (e) => failures.push(e),
    });
    expect(() => {
      instance.info(event(), { component: 'relay', event: 'claimed', outcome: 'ok' });
    }).not.toThrow();
    expect(failures).toHaveLength(1);
  });
});

describe('tracing', () => {
  function tracing() {
    const exported: FinishedSpan[] = [];
    const tracer = createTracer({ exporter: { export: (s) => exported.push(s) } });
    return { instance: createEventTracer(tracer), exported, tracer };
  }

  it('traces publish, relay, delivery, handler and replay', () => {
    const t = tracing();
    const e = event();
    t.instance.publishSpan(e).end();
    t.instance.relaySpan(e).end();
    const delivery = t.instance.deliverySpan(e, 'read-models');
    t.instance.handlerSpan(delivery, e, 'read-models').end();
    delivery.end();
    t.instance.replayRunSpan('run-1', 'range', e.tenantId, e.correlationId).end();
    t.instance.replayDeliverySpan(e, 'read-models', 'run-1').end();

    expect(t.exported.map((s) => s.name)).toEqual([
      'outbox.publish',
      'outbox.relay',
      'event.handle',
      'event.deliver',
      'replay.run',
      'replay.deliver',
    ]);
  });

  // One continuous trace across hours would be unreadable and would hold the
  // originating span open; the link preserves navigability without that cost.
  it('starts a NEW trace for delivery rather than extending the producer', () => {
    const t = tracing();
    const e = event();
    const publish = t.instance.publishSpan(e);
    publish.end();
    const delivery = t.instance.deliverySpan(e, 'read-models');
    delivery.end();
    expect(delivery.context.traceId).not.toBe(publish.context.traceId);
  });

  it('makes the handler span a child of the delivery span', () => {
    const t = tracing();
    const e = event();
    const delivery = t.instance.deliverySpan(e, 'read-models');
    const handler = t.instance.handlerSpan(delivery, e, 'read-models');
    handler.end();
    delivery.end();
    expect(handler.context.traceId).toBe(delivery.context.traceId);
  });

  it('carries the four correlation identifiers as attributes', () => {
    const t = tracing();
    t.instance.deliverySpan(event({ causationId: 'c-9' }), 'read-models').end();
    const attrs = t.exported[0]?.attributes ?? {};
    expect(attrs['event.id']).toBe('018f7a1e-0000-7000-8000-000000000001');
    expect(attrs['correlationId']).toBe('018f7a1e-0000-7000-8000-0000000000dd');
    expect(attrs['causation.id']).toBe('c-9');
    expect(attrs['aggregate.id']).toBe('018f7a1e-0000-7000-8000-0000000000c1');
  });

  it('never puts a payload on a span', () => {
    const t = tracing();
    t.instance.deliverySpan(event(), 'read-models').end();
    expect(JSON.stringify(t.exported[0]?.attributes)).not.toContain('must-never-be-logged');
  });

  // A span per 3 ms check would multiply trace volume for no diagnostic gain.
  it('records sub-millisecond checks as attributes, not spans', () => {
    const t = tracing();
    const delivery = t.instance.deliverySpan(event(), 'read-models');
    delivery.setAttribute(SPAN_ATTRIBUTES.idempotencyOutcome, 'suppressed-duplicate');
    delivery.setAttribute(SPAN_ATTRIBUTES.orderingHeldMs, 3);
    delivery.setAttribute(SPAN_ATTRIBUTES.versionFrom, 1);
    delivery.setAttribute(SPAN_ATTRIBUTES.versionTo, 2);
    delivery.end();
    expect(t.exported).toHaveLength(1);
    expect(t.exported[0]?.attributes[SPAN_ATTRIBUTES.idempotencyOutcome]).toBe(
      'suppressed-duplicate',
    );
    expect(t.exported[0]?.attributes[SPAN_ATTRIBUTES.orderingHeldMs]).toBe(3);
  });

  it('propagates W3C trace context across the asynchronous boundary', () => {
    const t = tracing();
    const publish = t.instance.publishSpan(event());
    const carrier = t.instance.inject(publish);
    expect(carrier).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-\d{2}$/);

    const extracted = t.instance.extract(carrier);
    expect(extracted?.traceId).toBe(publish.context.traceId);
    // A span started from the extracted context continues the SAME trace.
    const continued = t.instance.publishSpan(event(), extracted);
    expect(continued.context.traceId).toBe(publish.context.traceId);
  });

  it('returns null for an absent or malformed traceparent', () => {
    const t = tracing();
    expect(t.instance.extract(undefined)).toBeNull();
    expect(t.instance.extract('not-a-traceparent')).toBeNull();
  });

  // A breach dropped by a 1% sampler is a correctness incident with no trace —
  // the single case where the trace matters most.
  it('always samples an invariant breach, whatever the base rate says', () => {
    const never = (): boolean => false;
    const sampler = samplerAlwaysSamplingBreaches(never);
    expect(sampler('event.deliver', { tenantId: 't', correlationId: 'c' })).toBe(false);
    expect(sampler('invariant.ordering-violation', { tenantId: 't', correlationId: 'c' })).toBe(
      true,
    );
    expect(
      sampler('event.deliver', {
        tenantId: 't',
        correlationId: 'c',
        'invariant.breach': 'ordering-violation',
      }),
    ).toBe(true);
  });
});
