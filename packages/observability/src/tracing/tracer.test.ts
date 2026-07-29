import { describe, expect, it } from 'vitest';

import {
  formatTraceparent,
  INVALID_SPAN_ID,
  INVALID_TRACE_ID,
  isValidSpanId,
  isValidTraceId,
  parseTraceparent,
  type IdGenerator,
} from './trace-context.js';
import { createTracer, type FinishedSpan, type SpanAttributes } from './tracer.js';

function fixedIds(): IdGenerator {
  let t = 0;
  let s = 0;
  return {
    traceId: () => (++t).toString(16).padStart(32, '0'),
    spanId: () => (++s).toString(16).padStart(16, '0'),
  };
}

function collector(): { exported: FinishedSpan[]; export: (s: FinishedSpan) => void } {
  const exported: FinishedSpan[] = [];
  return { exported, export: (s) => exported.push(s) };
}

const ATTRS: SpanAttributes = { tenantId: 'ws-1', correlationId: 'corr-1' };

describe('W3C trace context propagation', () => {
  it('round-trips a traceparent header', () => {
    const context = {
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      spanId: '00f067aa0ba902b7',
      parentSpanId: null,
      sampled: true,
    };
    const header = formatTraceparent(context);
    expect(header).toBe('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01');

    const parsed = parseTraceparent(header);
    expect(parsed?.traceId).toBe(context.traceId);
    expect(parsed?.spanId).toBe(context.spanId);
    expect(parsed?.sampled).toBe(true);
  });

  it('carries the sampled flag as 00 when not sampled', () => {
    const header = formatTraceparent({
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      spanId: '00f067aa0ba902b7',
      parentSpanId: null,
      sampled: false,
    });
    expect(header.endsWith('-00')).toBe(true);
    expect(parseTraceparent(header)?.sampled).toBe(false);
  });

  // A malformed header starts a new trace rather than propagating a broken one.
  const malformed: readonly (readonly [string, string | undefined])[] = [
    ['undefined', undefined],
    ['empty', ''],
    ['wrong version', '01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'],
    ['short trace id', '00-4bf92f3577b34da6-00f067aa0ba902b7-01'],
    ['non-hex', '00-ZZf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'],
    ['all-zero trace id', `00-${INVALID_TRACE_ID}-00f067aa0ba902b7-01`],
    ['all-zero span id', `00-4bf92f3577b34da6a3ce929d0e0e4736-${INVALID_SPAN_ID}-01`],
  ];

  for (const [label, header] of malformed) {
    it(`returns null for a ${label} traceparent`, () => {
      expect(parseTraceparent(header)).toBeNull();
    });
  }

  it('validates id shapes', () => {
    expect(isValidTraceId('4bf92f3577b34da6a3ce929d0e0e4736')).toBe(true);
    expect(isValidTraceId(INVALID_TRACE_ID)).toBe(false);
    expect(isValidSpanId('00f067aa0ba902b7')).toBe(true);
    expect(isValidSpanId(INVALID_SPAN_ID)).toBe(false);
  });

  it('generates valid ids by default', () => {
    const tracer = createTracer();
    const span = tracer.startSpan('op', ATTRS);
    expect(isValidTraceId(span.context.traceId)).toBe(true);
    expect(isValidSpanId(span.context.spanId)).toBe(true);
  });
});

describe('spans', () => {
  it('starts a root span with no parent', () => {
    const span = createTracer({ ids: fixedIds() }).startSpan('op', ATTRS);
    expect(span.context.parentSpanId).toBeNull();
  });

  it('continues an inbound trace, keeping the trace id and linking the parent', () => {
    const tracer = createTracer({ ids: fixedIds() });
    const parent = tracer.extract('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01');
    const child = tracer.startSpan('op', ATTRS, parent);

    expect(child.context.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
    expect(child.context.parentSpanId).toBe('00f067aa0ba902b7');
    expect(child.context.spanId).not.toBe('00f067aa0ba902b7');
  });

  // Head-based sampling, decided once per trace.
  it('inherits the parent sampling decision rather than re-sampling', () => {
    const tracer = createTracer({ ids: fixedIds(), sampler: () => true });
    const parent = tracer.extract('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00');
    expect(tracer.startSpan('op', ATTRS, parent).context.sampled).toBe(false);
  });

  it('records mandatory attributes on the exported span', () => {
    const c = collector();
    createTracer({ ids: fixedIds(), exporter: c }).startSpan('op', ATTRS).end();
    expect(c.exported[0]?.attributes).toMatchObject({ tenantId: 'ws-1', correlationId: 'corr-1' });
  });

  it('measures duration from an injected clock', () => {
    const c = collector();
    let clock = 100;
    const span = createTracer({ ids: fixedIds(), exporter: c, now: () => clock }).startSpan(
      'op',
      ATTRS,
    );
    clock = 350;
    span.end();
    expect(c.exported[0]?.durationMs).toBe(250);
  });

  it('exports exactly once even if end() is called twice', () => {
    const c = collector();
    const span = createTracer({ ids: fixedIds(), exporter: c }).startSpan('op', ATTRS);
    span.end();
    span.end();
    expect(c.exported).toHaveLength(1);
  });

  it('ignores mutation after end', () => {
    const c = collector();
    const span = createTracer({ ids: fixedIds(), exporter: c }).startSpan('op', ATTRS);
    span.end();
    span.setAttribute('late', 'value');
    expect(c.exported[0]?.attributes).not.toHaveProperty('late');
  });

  it('records status and code', () => {
    const c = collector();
    const span = createTracer({ ids: fixedIds(), exporter: c }).startSpan('op', ATTRS);
    span.setStatus('error', 'E_TIMEOUT');
    span.end();
    expect(c.exported[0]).toMatchObject({ status: 'error', code: 'E_TIMEOUT' });
  });

  // The application never blocks on telemetry.
  it('swallows an exporter failure and reports it', () => {
    let failures = 0;
    const span = createTracer({
      ids: fixedIds(),
      exporter: {
        export: () => {
          throw new Error('collector down');
        },
      },
      onExportFailure: () => (failures += 1),
    }).startSpan('op', ATTRS);
    expect(() => {
      span.end();
    }).not.toThrow();
    expect(failures).toBe(1);
  });
});

describe('async boundary — consumers link rather than extend', () => {
  it('starts a NEW trace and records the link', () => {
    const c = collector();
    const upstream = '4bf92f3577b34da6a3ce929d0e0e4736';
    const span = createTracer({ ids: fixedIds(), exporter: c }).startLinkedSpan(
      'consume',
      ATTRS,
      upstream,
    );
    span.end();

    expect(span.context.traceId).not.toBe(upstream);
    expect(span.context.parentSpanId).toBeNull();
    expect(c.exported[0]?.attributes['link.trace_id']).toBe(upstream);
  });
});
