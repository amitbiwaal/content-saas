/**
 * The four abstractions, working together on one request.
 *
 * The unit suites check each in isolation. This runs a request end to end
 * through the REAL logger, tracer, registry and health monitor — one
 * correlation id, one trace, one set of measurements — and asserts the thing
 * that only shows up when they are combined: that a reader can join a log line
 * to a span to a metric, and that no identifier leaks into a label.
 */

import { describe, expect, it } from 'vitest';

import { OBSERVED_COMPONENTS, READINESS_COMPONENTS } from './components.js';
import {
  contextBindings,
  currentContext,
  runWithContext,
  type RequestContext,
} from './context/request-context.js';
import { HealthMonitor, type DependencyResult } from './health/health.js';
import { createLogger, type LogSink } from './logging/logger.js';
import type { LogRecord } from './logging/log-record.js';
import { CORE_METRIC_DEFINITIONS, REQUEST_DURATION } from './metrics/definitions.js';
import { FORBIDDEN_METRIC_LABELS } from './metrics/labels.js';
import { MetricRegistry } from './metrics/registry.js';
import type { HealthReporter, MetricsCollector } from './ports.js';
import { createTracer, type FinishedSpan } from './tracing/tracer.js';
import { isValidSpanId, isValidTraceId } from './tracing/trace-context.js';

const ORG = '018f7a1e-0000-7000-8000-0000000000aa';
const CORRELATION = '018f7a1e-0000-7000-8000-0000000000dd';

/** A sink that keeps the parsed records, so a test can read what shipped. */
function capturingSink(): { sink: LogSink; records: LogRecord[] } {
  const records: LogRecord[] = [];
  return {
    records,
    sink: {
      write(line: string): void {
        records.push(JSON.parse(line) as LogRecord);
      },
    },
  };
}

function rig() {
  const { sink, records } = capturingSink();
  const spans: FinishedSpan[] = [];

  return {
    records,
    spans,
    logger: createLogger({ service: 'api', version: '1.0.0', sink }),
    tracer: createTracer({
      service: 'api',
      exporter: {
        export(span: FinishedSpan): void {
          spans.push(span);
        },
      },
    }),
    metrics: new MetricRegistry() satisfies MetricsCollector,
  };
}

/**
 * The ambient context's bindings.
 *
 * `contextBindings` takes the context rather than reading the store, so this is
 * the one place the two are joined — which is what a service's request wrapper
 * does once, at the edge.
 */
function ambientBindings(): Record<string, string> {
  const active = currentContext();
  if (active === undefined) throw new Error('no request context is active');
  return contextBindings(active);
}

const context = (): RequestContext => ({
  correlationId: CORRELATION,
  requestId: 'req-1',
  organizationId: ORG,
  actorId: '018f7a1e-0000-7000-8000-000000000001',
});

// ── One request, three signals ──────────────────────────────────────────────

describe('a request is observable through all three, and they join up', () => {
  it('logs, traces and measures one request without any of them knowing the others', () => {
    const r = rig();
    const requests = r.metrics.timer(REQUEST_DURATION);

    runWithContext(context(), () => {
      const log = r.logger.child(ambientBindings());
      const span = r.tracer.startSpan('POST /v1/runs', {
        'contentos.service': 'api',
        'contentos.operation': 'createRun',
      });

      log.info({ event: 'request.started' });
      requests.observeSeconds(0.42, {
        route: '/v1/runs',
        method: 'POST',
        status: '200',
        outcome: 'success',
      });
      span.setStatus('ok');
      span.end();
      log.info({ event: 'request.finished', outcome: 'success', durationMs: 420 });
    });

    expect(r.records).toHaveLength(2);
    expect(r.spans).toHaveLength(1);

    // The correlation id is on both, which is what makes them joinable.
    expect(r.records[0]?.correlationId).toBe(CORRELATION);
    expect(r.records[1]?.correlationId).toBe(CORRELATION);

    const samples = r.metrics.collect().filter((s) => s.name === 'request_duration_seconds');
    expect(samples).toHaveLength(1);
    expect(samples[0]?.histogram?.count).toBe(1);
    expect(samples[0]?.histogram?.sum).toBeCloseTo(0.42, 6);
  });

  it('carries the organization on the log line and never on the metric', () => {
    // The whole reason both exist: a log line is per-request and access
    // controlled; a metric label is a series that lives forever.
    const r = rig();
    const requests = r.metrics.timer(REQUEST_DURATION);

    runWithContext(context(), () => {
      r.logger.child(ambientBindings()).info({ event: 'request.started' });
      requests.observeSeconds(0.1, {
        route: '/v1/runs',
        method: 'POST',
        status: '200',
        outcome: 'success',
      });
    });

    expect(r.records[0]?.organizationId).toBe(ORG);

    for (const sample of r.metrics.collect()) {
      expect(Object.keys(sample.labels)).not.toContain('organizationId');
      expect(JSON.stringify(sample.labels)).not.toContain(ORG);
    }
  });

  it('produces a trace and span id a log line could reference', () => {
    const r = rig();
    const span = r.tracer.startSpan('work', {
      'contentos.service': 'api',
      'contentos.operation': 'work',
    });
    span.setStatus('ok');
    span.end();

    const finished = r.spans[0];
    expect(finished).toBeDefined();
    expect(isValidTraceId(finished?.context.traceId ?? '')).toBe(true);
    expect(isValidSpanId(finished?.context.spanId ?? '')).toBe(true);
  });

  it('records a failure as a failure on both surfaces', () => {
    const r = rig();
    const requests = r.metrics.timer(REQUEST_DURATION);

    runWithContext(context(), () => {
      const span = r.tracer.startSpan('POST /v1/runs', {
        'contentos.service': 'api',
        'contentos.operation': 'createRun',
      });
      r.logger.child(ambientBindings()).error({ event: 'request.failed', code: 'ServiceFailed' });
      requests.observeSeconds(1.5, {
        route: '/v1/runs',
        method: 'POST',
        status: '500',
        outcome: 'failure',
      });
      span.setStatus('error', 'ServiceFailed');
      span.end();
    });

    expect(r.records[0]?.level).toBe('error');
    expect(r.records[0]?.code).toBe('ServiceFailed');
    expect(r.spans[0]?.status).toBe('error');

    const sample = r.metrics.collect().find((s) => s.name === 'request_duration_seconds');
    expect(sample?.labels['outcome']).toBe('failure');
  });
});

// ── Every core definition, against the real registry ────────────────────────

describe('the seven definitions register together on one collector', () => {
  it('all declare without conflict', () => {
    const metrics: MetricsCollector = new MetricRegistry();

    for (const definition of CORE_METRIC_DEFINITIONS) {
      if (definition.kind === 'counter') metrics.counter(definition);
      else if (definition.kind === 'gauge') metrics.gauge(definition);
      else metrics.histogram(definition);
    }

    expect(
      metrics
        .definitions()
        .map((d) => d.name)
        .sort(),
    ).toEqual(CORE_METRIC_DEFINITIONS.map((d) => d.name).sort());
  });

  it('are idempotent: declaring the whole set twice changes nothing', () => {
    // Two modules both declaring the core set at startup is the ordinary case.
    const metrics: MetricsCollector = new MetricRegistry();
    const declare = (): void => {
      for (const definition of CORE_METRIC_DEFINITIONS) {
        if (definition.kind === 'counter') metrics.counter(definition);
        else if (definition.kind === 'gauge') metrics.gauge(definition);
        else metrics.histogram(definition);
      }
    };

    declare();
    expect(declare).not.toThrow();
    expect(metrics.definitions()).toHaveLength(7);
  });

  it('leak no identifier into any label, even after observation', () => {
    const metrics: MetricsCollector = new MetricRegistry();
    metrics
      .timer(REQUEST_DURATION)
      .observeSeconds(0.1, { route: '/v1/x', method: 'GET', status: '200', outcome: 'success' });
    metrics
      .counter({ name: 'credit_operations_total', help: 'x', labelNames: ['operation', 'outcome'] })
      .inc({ operation: 'consume', outcome: 'success' });

    for (const sample of metrics.collect()) {
      for (const label of Object.keys(sample.labels)) {
        expect(FORBIDDEN_METRIC_LABELS as readonly string[]).not.toContain(label);
      }
    }
  });
});

// ── Health, over the named components ───────────────────────────────────────

describe('health reports over the component vocabulary', () => {
  const healthy = (): Promise<DependencyResult> => Promise.resolve({ status: 'healthy' });

  function monitor(overrides: {
    local?: readonly { name: string; result: () => Promise<DependencyResult> }[];
    remote?: readonly { name: string; result: () => Promise<DependencyResult> }[];
  }): HealthReporter {
    return new HealthMonitor({
      service: 'api',
      version: '1.0.0',
      localChecks: (overrides.local ?? []).map((c) => ({
        name: c.name,
        kind: 'local' as const,
        check: c.result,
      })),
      remoteChecks: (overrides.remote ?? []).map((c) => ({
        name: c.name,
        kind: 'remote' as const,
        check: c.result,
      })),
    });
  }

  it('reports every readiness component by its agreed name', async () => {
    const reporter = monitor({
      local: READINESS_COMPONENTS.map((name) => ({ name, result: healthy })),
    });

    const report = await reporter.ready();

    expect(report.dependencies.map((d) => d.name).sort()).toEqual([...READINESS_COMPONENTS].sort());
    expect(report.status).toBe('healthy');
  });

  it('covers the vendors in deep, not in ready', async () => {
    // A vendor being slow is not a reason to take a healthy pod out of
    // rotation.
    const reporter = monitor({
      local: [{ name: 'database', result: healthy }],
      remote: [
        { name: 'ai_providers', result: healthy },
        { name: 'payment_provider', result: healthy },
      ],
    });

    const ready = await reporter.ready();
    const deep = await reporter.deep();

    expect(ready.dependencies.map((d) => d.name)).toEqual(['database']);
    expect(deep.remote.map((d) => d.name).sort()).toEqual(['ai_providers', 'payment_provider']);
  });

  it('takes the whole report to the worst component', async () => {
    const reporter = monitor({
      local: [
        { name: 'database', result: healthy },
        { name: 'redis', result: () => Promise.resolve({ status: 'degraded' as const }) },
      ],
    });

    expect((await reporter.ready()).status).toBe('degraded');
  });

  it('reports unhealthy when a readiness component is down', async () => {
    const reporter = monitor({
      local: [
        { name: 'database', result: () => Promise.resolve({ status: 'unhealthy' as const }) },
        { name: 'redis', result: healthy },
      ],
    });

    expect((await reporter.ready()).status).toBe('unhealthy');
  });

  it('stays live while a dependency is down', async () => {
    // Restarting a pod does not fix somebody else's database.
    const reporter = monitor({
      local: [
        { name: 'database', result: () => Promise.resolve({ status: 'unhealthy' as const }) },
      ],
    });

    expect(reporter.live().status).toBe('healthy');
    expect((await reporter.ready()).status).toBe('unhealthy');
  });

  it('names only components the vocabulary knows', async () => {
    const reporter = monitor({
      local: READINESS_COMPONENTS.map((name) => ({ name, result: healthy })),
      remote: [{ name: 'payment_provider', result: healthy }],
    });

    const deep = await reporter.deep();
    for (const report of [...deep.dependencies, ...deep.remote]) {
      expect(OBSERVED_COMPONENTS as readonly string[]).toContain(report.name);
    }
  });

  it('repairs nothing: a failing check is still failing when asked twice', async () => {
    let calls = 0;
    const reporter = monitor({
      local: [
        {
          name: 'database',
          result: () => {
            calls += 1;
            return Promise.resolve({ status: 'unhealthy' as const });
          },
        },
      ],
    });

    expect((await reporter.ready()).status).toBe('unhealthy');
    expect((await reporter.ready()).status).toBe('unhealthy');
    expect(calls).toBe(2);
  });
});
