import { describe, expect, it } from 'vitest';

import { assertLabelsAllowed, FORBIDDEN_METRIC_LABELS, labelKey } from './labels.js';
import { MetricRegistry } from './registry.js';

describe('metric registration', () => {
  it('registers a counter and collects its value', () => {
    const registry = new MetricRegistry();
    const counter = registry.counter({
      name: 'http_requests_total',
      help: 'HTTP requests',
      labelNames: ['route', 'status'],
    });
    counter.inc({ route: '/v1/articles', status: '200' });
    counter.inc({ route: '/v1/articles', status: '200' }, 4);

    const [sample] = registry.collect();
    expect(sample).toMatchObject({ name: 'http_requests_total', kind: 'counter', value: 5 });
  });

  it('keeps one series per distinct label set', () => {
    const registry = new MetricRegistry();
    const counter = registry.counter({ name: 'c', help: 'h', labelNames: ['outcome'] });
    counter.inc({ outcome: 'success' });
    counter.inc({ outcome: 'failed' });
    expect(registry.collect()).toHaveLength(2);
  });

  it('returns the same instrument when a metric is declared twice', () => {
    const registry = new MetricRegistry();
    registry.counter({ name: 'c', help: 'h', labelNames: [] }).inc();
    registry.counter({ name: 'c', help: 'h', labelNames: [] }).inc();
    expect(registry.collect()[0]?.value).toBe(2);
    expect(registry.definitions()).toHaveLength(1);
  });

  it('refuses to re-register a name under a different kind', () => {
    const registry = new MetricRegistry();
    registry.counter({ name: 'x', help: 'h', labelNames: [] });
    expect(() => registry.gauge({ name: 'x', help: 'h', labelNames: [] })).toThrow(
      /already registered/,
    );
  });

  it('refuses a decreasing counter', () => {
    const registry = new MetricRegistry();
    const counter = registry.counter({ name: 'c', help: 'h', labelNames: [] });
    expect(() => {
      counter.inc({}, -1);
    }).toThrow(/cannot decrease/);
  });

  it('supports gauge set, inc, and dec', () => {
    const registry = new MetricRegistry();
    const gauge = registry.gauge({ name: 'pipeline_active', help: 'h', labelNames: [] });
    gauge.set(10);
    gauge.inc();
    gauge.dec({}, 3);
    expect(registry.collect()[0]?.value).toBe(8);
  });

  it('buckets histogram observations cumulatively, with +Inf last', () => {
    const registry = new MetricRegistry();
    const histogram = registry.histogram({
      name: 'h',
      help: 'h',
      labelNames: [],
      buckets: [1, 5, 10],
    });
    histogram.observe(0.5);
    histogram.observe(4);
    histogram.observe(50);

    const snapshot = registry.collect()[0]?.histogram;
    expect(snapshot?.count).toBe(3);
    expect(snapshot?.sum).toBe(54.5);
    expect(snapshot?.bucketCounts).toEqual([1, 2, 2, 3]);
  });
});

describe('timers', () => {
  it('records elapsed time in SECONDS', () => {
    const registry = new MetricRegistry();
    let clock = 1000;
    const timer = registry.timer(
      { name: 'stage_duration_seconds', help: 'h', labelNames: ['stage'] },
      () => clock,
    );
    const stop = timer.start({ stage: 'review' });
    clock = 3500;
    stop();

    const snapshot = registry.collect()[0]?.histogram;
    expect(snapshot?.sum).toBe(2.5);
    expect(snapshot?.count).toBe(1);
  });

  it('accepts a directly observed duration', () => {
    const registry = new MetricRegistry();
    registry.timer({ name: 't', help: 'h', labelNames: [] }).observeSeconds(0.25);
    expect(registry.collect()[0]?.histogram?.sum).toBe(0.25);
  });
});

describe('cardinality discipline — tenantId is never a metric label', () => {
  it('lists both casings of every forbidden identifier', () => {
    expect(FORBIDDEN_METRIC_LABELS).toContain('tenantId');
    expect(FORBIDDEN_METRIC_LABELS).toContain('tenant_id');
    expect(FORBIDDEN_METRIC_LABELS).toContain('correlationId');
    expect(FORBIDDEN_METRIC_LABELS).toContain('correlation_id');
  });

  it('rejects a forbidden label at runtime', () => {
    expect(() => {
      assertLabelsAllowed({ tenant_id: 'ws-1' });
    }).toThrow(/Forbidden metric label/);
    expect(() => {
      assertLabelsAllowed({ outcome: 'success' });
    }).not.toThrow();
  });

  it('rejects a forbidden label supplied to an instrument', () => {
    const registry = new MetricRegistry();
    const counter = registry.counter({ name: 'c', help: 'h', labelNames: [] });
    // Cast past the compile-time guard to prove the runtime layer also holds.
    expect(() => {
      counter.inc({ tenantId: 'ws-1' } as never);
    }).toThrow(/Forbidden metric label/);
  });

  it('rejects a forbidden label declared in the definition', () => {
    const registry = new MetricRegistry();
    expect(() => registry.counter({ name: 'c', help: 'h', labelNames: ['tenant_id'] })).toThrow(
      /Forbidden metric label/,
    );
  });

  it('is order-independent when keying a label set', () => {
    expect(labelKey({ a: '1', b: '2' })).toBe(labelKey({ b: '2', a: '1' }));
  });
});
