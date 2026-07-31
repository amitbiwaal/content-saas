/**
 * The S6.1 delta: the ports, the component vocabulary, the metric definitions
 * and the four guards.
 *
 * The package's own suites already cover the logger, the tracer, the registry,
 * the health monitor and the request context. This covers only what was added,
 * and — for the ports — the one thing worth asserting about them: that the
 * classes already satisfy them, so nothing was duplicated to make them fit.
 */

import { describe, expect, it } from 'vitest';

import {
  isObservedComponent,
  isReadinessComponent,
  OBSERVED_COMPONENTS,
  READINESS_COMPONENTS,
  type ObservedComponent,
} from './components.js';
import { HealthMonitor, HEALTH_STATUSES, isHealthStatus } from './health/health.js';
import { isLogLevel, isOutcome, LOG_LEVELS, OUTCOMES } from './logging/log-record.js';
import {
  AI_EXECUTION_DURATION,
  CACHE_OPERATIONS,
  CORE_METRIC_DEFINITIONS,
  CREDIT_OPERATIONS,
  PAYMENT_DURATION,
  QUEUE_LATENCY,
  REQUEST_DURATION,
  WEBHOOK_PROCESSING,
} from './metrics/definitions.js';
import { FORBIDDEN_METRIC_LABELS } from './metrics/labels.js';
import {
  assertCompatibleDefinition,
  isMetricKind,
  METRIC_KINDS,
  MetricRegistry,
  type MetricDefinition,
} from './metrics/registry.js';
import type { HealthReporter, MetricsCollector } from './ports.js';

// ── The ports ───────────────────────────────────────────────────────────────

describe('the ports are the shapes the classes already had', () => {
  it('MetricRegistry satisfies MetricsCollector', () => {
    // Assigned, not adapted: if this needed a wrapper, the port would be a
    // second metrics system rather than a description of the one that exists.
    const collector: MetricsCollector = new MetricRegistry();

    expect(typeof collector.counter).toBe('function');
    expect(typeof collector.gauge).toBe('function');
    expect(typeof collector.histogram).toBe('function');
    expect(typeof collector.timer).toBe('function');
    expect(typeof collector.definitions).toBe('function');
    expect(typeof collector.collect).toBe('function');
  });

  it('HealthMonitor satisfies HealthReporter', () => {
    const reporter: HealthReporter = new HealthMonitor({ service: 'api', version: '1.0.0' });

    expect(typeof reporter.live).toBe('function');
    expect(typeof reporter.ready).toBe('function');
    expect(typeof reporter.deep).toBe('function');
  });

  it('a module can take the port and a test can pass a fake', () => {
    // The whole reason the ports exist: this needs no registry.
    const observed: { name: string; value: number }[] = [];
    const fake: MetricsCollector = {
      counter: () => ({ inc: () => undefined }),
      gauge: () => ({ set: () => undefined, inc: () => undefined, dec: () => undefined }),
      histogram: (definition) => ({
        observe: (value) => observed.push({ name: definition.name, value }),
      }),
      timer: () => ({ start: () => () => undefined, observeSeconds: () => undefined }),
      definitions: () => [],
      collect: () => [],
    };

    fake.histogram(REQUEST_DURATION).observe(0.25);
    expect(observed).toEqual([{ name: 'request_duration_seconds', value: 0.25 }]);
  });

  it('the health port reports and cannot repair', () => {
    const reporter: HealthReporter = new HealthMonitor({ service: 'api', version: '1.0.0' });
    const surface = Object.getOwnPropertyNames(Object.getPrototypeOf(reporter) as object);

    for (const forbidden of ['repair', 'reconnect', 'restart', 'heal', 'retry']) {
      expect(surface).not.toContain(forbidden);
    }
  });

  it('liveness checks no dependency, by design', async () => {
    // A liveness probe that failed on a database blip would restart every pod
    // during an incident that had nothing to do with them.
    let checked = false;
    const reporter: HealthReporter = new HealthMonitor({
      service: 'api',
      version: '1.0.0',
      localChecks: [
        {
          name: 'database',
          kind: 'local',
          check: () => {
            checked = true;
            return Promise.resolve({ status: 'healthy' as const });
          },
        },
      ],
    });

    expect(reporter.live().status).toBe('healthy');
    expect(checked).toBe(false);

    await reporter.ready();
    expect(checked).toBe(true);
  });
});

// ── The component vocabulary ────────────────────────────────────────────────

describe('observed components', () => {
  it('name the five the increment lists', () => {
    expect(OBSERVED_COMPONENTS).toEqual([
      'database',
      'redis',
      'queue',
      'ai_providers',
      'payment_provider',
    ]);
  });

  it('reject a name nothing declares', () => {
    // Two services naming Redis differently produce two rows no dashboard can
    // join, and an alert that fires for one deployment and never the other.
    expect(isObservedComponent('cache')).toBe(false);
    expect(isObservedComponent('Redis')).toBe(false);
    expect(isObservedComponent(null)).toBe(false);
    expect(isObservedComponent('redis')).toBe(true);
  });

  it('name no domain module', () => {
    // A domain module cannot be unreachable, only wrong. Putting one in a
    // health report would invite a check that ran business logic to decide.
    for (const domain of ['billing', 'credits', 'content', 'commerce', 'workspaces']) {
      expect(isObservedComponent(domain)).toBe(false);
    }
  });

  it('put only the local dependencies in readiness', () => {
    // A remote vendor being slow is not a reason to take a healthy pod out of
    // rotation, which is what an unhealthy `ready` would do.
    expect(READINESS_COMPONENTS).toEqual(['database', 'redis', 'queue']);
    expect(isReadinessComponent('payment_provider')).toBe(false);
    expect(isReadinessComponent('ai_providers')).toBe(false);
  });

  it('keep readiness a subset of the whole vocabulary', () => {
    for (const component of READINESS_COMPONENTS) {
      expect(OBSERVED_COMPONENTS).toContain(component);
    }
  });

  it('are frozen', () => {
    expect(Object.isFrozen(READINESS_COMPONENTS)).toBe(true);
  });

  it('classify every component one way or the other', () => {
    for (const component of OBSERVED_COMPONENTS) {
      expect(typeof isReadinessComponent(component)).toBe('boolean');
    }
  });
});

// ── The metric definitions ──────────────────────────────────────────────────

describe('the seven core metric definitions', () => {
  it('cover exactly what the increment names', () => {
    expect(CORE_METRIC_DEFINITIONS.map((d) => d.name)).toEqual([
      'request_duration_seconds',
      'ai_execution_duration_seconds',
      'payment_duration_seconds',
      'queue_latency_seconds',
      'credit_operations_total',
      'webhook_processing_seconds',
      'cache_operations_total',
    ]);
  });

  it('never use an identifier as a label', () => {
    // An unbounded label is a cardinality explosion that takes the metrics
    // backend down, and it puts tenant identity somewhere with weaker controls
    // than the source table.
    for (const definition of CORE_METRIC_DEFINITIONS) {
      for (const label of definition.labelNames) {
        expect(FORBIDDEN_METRIC_LABELS as readonly string[]).not.toContain(label);
      }
    }
  });

  it('are all registerable against the real registry', () => {
    // The label rules are enforced at declaration; if any definition broke
    // them, this would throw rather than a service failing at startup.
    const registry = new MetricRegistry();
    for (const definition of CORE_METRIC_DEFINITIONS) {
      expect(() => {
        if (definition.kind === 'counter') registry.counter(definition);
        else if (definition.kind === 'gauge') registry.gauge(definition);
        else registry.histogram(definition);
      }).not.toThrow();
    }
    expect(registry.definitions()).toHaveLength(7);
  });

  it('measure every duration in seconds', () => {
    // A metric whose unit has to be read out of its name is one somebody
    // eventually reads wrong.
    for (const definition of CORE_METRIC_DEFINITIONS) {
      if (definition.kind === 'histogram') {
        expect(definition.name).toMatch(/_seconds$/);
        expect(definition.buckets).toBeDefined();
      }
    }
  });

  it('name every counter with a _total suffix', () => {
    for (const definition of CORE_METRIC_DEFINITIONS) {
      if (definition.kind === 'counter') expect(definition.name).toMatch(/_total$/);
    }
  });

  it('count credit operations without ever carrying an amount', () => {
    // The balance is the ledger's; a second one here would be a second source
    // of truth about money.
    expect(CREDIT_OPERATIONS.kind).toBe('counter');
    expect(CREDIT_OPERATIONS.labelNames).toEqual(['operation', 'outcome']);
    expect(CREDIT_OPERATIONS.labelNames).not.toContain('amount');
  });

  it('count cache hits and misses rather than publishing a ratio', () => {
    // A ratio computed in-process is a ratio over one process's lifetime,
    // which is not the number anybody wants.
    expect(CACHE_OPERATIONS.kind).toBe('counter');
    expect(CACHE_OPERATIONS.labelNames).toContain('result');
  });

  it('label AI executions by tier, never by model identifier', () => {
    // Routing is on tier (ADR-013); a model name would fragment the series
    // every release.
    expect(AI_EXECUTION_DURATION.labelNames).toContain('tier');
    expect(AI_EXECUTION_DURATION.labelNames).not.toContain('model');
  });

  it('measure how long a job WAITED, not how long it ran', () => {
    expect(QUEUE_LATENCY.name).toBe('queue_latency_seconds');
    expect(QUEUE_LATENCY.help).toContain('queued before');
  });

  it('distinguish an ignored webhook from an accepted one', () => {
    // An endpoint that suddenly ignores everything looks healthy on a success
    // rate alone.
    expect(WEBHOOK_PROCESSING.labelNames).toContain('result');
  });

  it('label payments by operation, never by amount or customer', () => {
    expect(PAYMENT_DURATION.labelNames).toEqual(['provider', 'operation', 'outcome']);
  });

  it('are every one frozen, labels included', () => {
    for (const definition of CORE_METRIC_DEFINITIONS) {
      expect(Object.isFrozen(definition)).toBe(true);
      expect(Object.isFrozen(definition.labelNames)).toBe(true);
    }
    expect(Object.isFrozen(CORE_METRIC_DEFINITIONS)).toBe(true);
  });

  it('have a help string on every one', () => {
    for (const definition of CORE_METRIC_DEFINITIONS) {
      expect(definition.help.trim().length).toBeGreaterThan(10);
    }
  });

  it('have no duplicate names', () => {
    const names = CORE_METRIC_DEFINITIONS.map((d) => d.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

// ── Duplicate definitions ───────────────────────────────────────────────────

describe('assertCompatibleDefinition', () => {
  const base: MetricDefinition = {
    name: 'thing_total',
    help: 'A thing.',
    kind: 'counter',
    labelNames: ['a', 'b'],
  };

  it('accepts an identical redeclaration', () => {
    // Two modules both wanting the same counter is the ordinary idiom.
    expect(() => {
      assertCompatibleDefinition(base, { ...base });
    }).not.toThrow();
  });

  it('accepts the same labels in a different order', () => {
    expect(() => {
      assertCompatibleDefinition(base, { ...base, labelNames: ['b', 'a'] });
    }).not.toThrow();
  });

  it('accepts a reworded help string', () => {
    // Prose for an operator. A startup crash over a typo would be worse.
    expect(() => {
      assertCompatibleDefinition(base, { ...base, help: 'A thing, restated.' });
    }).not.toThrow();
  });

  it('refuses a different kind', () => {
    expect(() => {
      assertCompatibleDefinition(base, { ...base, kind: 'gauge' });
    }).toThrow(/already registered as a counter/);
  });

  it('refuses a different label set', () => {
    // The second caller would silently observe against the first one's labels,
    // and the series it thinks it is writing would not exist.
    expect(() => {
      assertCompatibleDefinition(base, { ...base, labelNames: ['a', 'b', 'c'] });
    }).toThrow(/already registered with labels/);
  });

  it('refuses a renamed label', () => {
    expect(() => {
      assertCompatibleDefinition(base, { ...base, labelNames: ['a', 'z'] });
    }).toThrow(/already registered with labels/);
  });

  it('refuses different histogram buckets', () => {
    // A bucket mismatch makes two callers' percentiles incomparable while
    // looking fine.
    const histogram: MetricDefinition = {
      name: 'thing_seconds',
      help: 'A duration.',
      kind: 'histogram',
      labelNames: [],
      buckets: [0.1, 1],
    };

    expect(() => {
      assertCompatibleDefinition(histogram, { ...histogram, buckets: [0.1, 2] });
    }).toThrow(/different histogram buckets/);
  });

  it('names both label sets so the conflict is actionable', () => {
    let message = '';
    try {
      assertCompatibleDefinition(base, { ...base, labelNames: ['a', 'z'] });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('a, b');
    expect(message).toContain('a, z');
  });
});

describe('the registry rejects a conflicting redeclaration', () => {
  it('still shares one instrument for an identical one', () => {
    // Two modules both wanting the same counter both get it, and both write to
    // ONE series — the handles differ, the instrument behind them does not.
    const registry = new MetricRegistry();
    const first = registry.counter({ name: 'x_total', help: 'x', labelNames: ['a'] });
    const second = registry.counter({ name: 'x_total', help: 'x', labelNames: ['a'] });

    first.inc({ a: 'one' });
    second.inc({ a: 'one' }, 2);

    expect(registry.definitions()).toHaveLength(1);
    const samples = registry.collect().filter((sample) => sample.name === 'x_total');
    expect(samples).toHaveLength(1);
    expect(samples[0]?.value).toBe(3);
  });

  it('refuses one with different labels', () => {
    const registry = new MetricRegistry();
    registry.counter({ name: 'x_total', help: 'x', labelNames: ['a'] });

    expect(() => registry.counter({ name: 'x_total', help: 'x', labelNames: ['a', 'b'] })).toThrow(
      /already registered with labels/,
    );
  });

  it('refuses one with a different kind, as it always did', () => {
    const registry = new MetricRegistry();
    registry.counter({ name: 'x_total', help: 'x', labelNames: [] });

    expect(() => registry.gauge({ name: 'x_total', help: 'x', labelNames: [] })).toThrow(
      /already registered as a counter/,
    );
  });
});

// ── The guards ──────────────────────────────────────────────────────────────

describe('the guards refuse what a wire or an environment can carry', () => {
  it('accept every severity and nothing else', () => {
    // A process that started at a level nobody declared would log the wrong
    // amount for as long as it ran.
    for (const level of LOG_LEVELS) expect(isLogLevel(level)).toBe(true);
    expect(isLogLevel('trace')).toBe(false);
    expect(isLogLevel('INFO')).toBe(false);
    expect(isLogLevel('')).toBe(false);
    expect(isLogLevel(null)).toBe(false);
    expect(isLogLevel(1)).toBe(false);
  });

  it('accept every health state and nothing else', () => {
    // A malformed state flowing through `worst()` would be treated as healthy,
    // and an outage would read green.
    for (const status of HEALTH_STATUSES) expect(isHealthStatus(status)).toBe(true);
    expect(isHealthStatus('ok')).toBe(false);
    expect(isHealthStatus('down')).toBe(false);
    expect(isHealthStatus('HEALTHY')).toBe(false);
    expect(isHealthStatus(undefined)).toBe(false);
  });

  it('accept every metric kind and nothing else', () => {
    for (const kind of METRIC_KINDS) expect(isMetricKind(kind)).toBe(true);
    expect(isMetricKind('summary')).toBe(false);
    expect(isMetricKind('timer')).toBe(false);
  });

  it('accept every outcome and nothing else', () => {
    for (const outcome of OUTCOMES) expect(isOutcome(outcome)).toBe(true);
    expect(isOutcome('ok')).toBe(false);
    expect(isOutcome('error')).toBe(false);
  });

  it('leave the vocabularies exactly as they were', () => {
    // The guards are additive; naming a state the machine does not have would
    // be a second health model.
    expect(HEALTH_STATUSES).toEqual(['healthy', 'degraded', 'unhealthy']);
    expect(LOG_LEVELS).toEqual(['error', 'warn', 'info', 'debug']);
    expect(METRIC_KINDS).toEqual(['counter', 'gauge', 'histogram']);
    expect(OUTCOMES).toEqual(['success', 'failure', 'denied', 'suppressed']);
  });

  it('are usable to narrow an unknown', () => {
    const fromTheWire: unknown = 'degraded';
    if (isHealthStatus(fromTheWire)) {
      const status: 'healthy' | 'degraded' | 'unhealthy' = fromTheWire;
      expect(status).toBe('degraded');
    } else {
      throw new Error('expected the guard to narrow');
    }
  });

  it('narrow a component too', () => {
    const fromConfig: unknown = 'queue';
    if (isObservedComponent(fromConfig)) {
      const component: ObservedComponent = fromConfig;
      expect(component).toBe('queue');
    } else {
      throw new Error('expected the guard to narrow');
    }
  });
});
