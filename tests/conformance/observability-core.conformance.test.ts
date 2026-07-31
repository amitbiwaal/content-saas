/**
 * The observability package against the rest of the system.
 *
 * ── What only this file can check ───────────────────────────────────────────
 *
 * 1. THERE IS ONE OF EACH. One logger, one metrics registry, one tracing model,
 *    one health pipeline — and this increment added a port for two of them
 *    rather than a second implementation of either.
 *
 * 2. EVERY MODULE REPORTS THROUGH IT. Nothing outside this package writes to a
 *    logging backend, and `console` is not a logging backend either.
 *
 * 3. NO BACKEND, ANYWHERE. No OpenTelemetry, no Prometheus, no Sentry, no
 *    Datadog, no driver, no client — in the package or in its manifest.
 *
 * 4. IT OBSERVES AND OWNS NO BUSINESS LOGIC.
 *
 * 5. THE DEVIATIONS, recorded so they cannot be forgotten.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CORE_METRIC_DEFINITIONS,
  HEALTH_STATUSES,
  HealthMonitor,
  isHealthStatus,
  isLogLevel,
  isMetricKind,
  isObservedComponent,
  isOutcome,
  LOG_LEVELS,
  MetricRegistry,
  OBSERVED_COMPONENTS,
  type HealthReporter,
  type MetricsCollector,
} from '@contentos/observability';
import { describe, expect, it } from 'vitest';

const packageDir = new URL('../../packages/observability/', import.meta.url);

const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, packageDir)), 'utf8');

const sourceOf = (relative: string): string =>
  read(relative)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

/** The modules this increment added. */
const ADDED = ['src/components.ts', 'src/ports.ts', 'src/metrics/definitions.ts'] as const;

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

const readRepo = (relative: string): string => readFileSync(join(repoRoot, relative), 'utf8');

/**
 * Every `.ts` file that SHIPS — no tests, no fixtures, no build output.
 *
 * A test may `console.log` while somebody is debugging it; shipped code may
 * not, because that line ends up in production with no redaction on it.
 */
function shippedSources(): string[] {
  const roots = ['packages', 'services', 'workers'];
  const found: string[] = [];

  const walk = (dir: string): void => {
    for (const entry of readdirSync(join(repoRoot, dir), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist') continue;
        walk(path);
      } else if (
        entry.name.endsWith('.ts') &&
        !entry.name.endsWith('.test.ts') &&
        !entry.name.endsWith('.fixture.ts')
      ) {
        found.push(path);
      }
    }
  };

  for (const root of roots) walk(root);
  return found;
}

// ── 1 · One of each ─────────────────────────────────────────────────────────

describe('the increment added ports, not second implementations', () => {
  it('declares no second logger', () => {
    for (const file of ADDED) {
      expect(sourceOf(file)).not.toMatch(/createLogger|class \w*Logger|LogSink/);
    }
  });

  it('declares no second registry, monitor or tracer', () => {
    for (const file of ADDED) {
      const code = sourceOf(file);
      expect(code).not.toMatch(/class \w*(?:Registry|Monitor|Tracer|Collector|Reporter)/);
      expect(code).not.toMatch(/createTracer|new MetricRegistry|new HealthMonitor/);
    }
  });

  it('the ports are types only — they construct nothing', () => {
    const ports = sourceOf('src/ports.ts');
    expect(ports).toMatch(/interface MetricsCollector/);
    expect(ports).toMatch(/interface HealthReporter/);
    expect(ports).not.toMatch(/^export (?:const|class|function)/m);
  });

  it('the classes satisfy the ports with no adapter', () => {
    // If either needed a wrapper, the port would be a second system rather than
    // a description of the one that exists.
    const collector: MetricsCollector = new MetricRegistry();
    const reporter: HealthReporter = new HealthMonitor({ service: 'api', version: '1.0.0' });

    expect(collector.definitions()).toEqual([]);
    expect(reporter.live().status).toBe('healthy');
  });

  it('the component vocabulary is a list of names, not a pipeline', () => {
    const components = sourceOf('src/components.ts');
    expect(components).not.toMatch(/check\(|Promise|async|await/);
    expect(components).not.toMatch(/import .* from/);
  });

  it('the definitions register nothing themselves', () => {
    // A module that registered on import would create a default collector,
    // which is the global the increment rules out.
    const definitions = sourceOf('src/metrics/definitions.ts');
    expect(definitions).not.toMatch(/new MetricRegistry|\.counter\(|\.histogram\(|\.gauge\(/);
  });
});

// ── 2 · Every module reports through the abstraction ────────────────────────

describe('nothing writes to a logging backend directly', () => {
  it('no shipped source anywhere calls console', () => {
    // `logging-guide.md`: services write structured JSON through the logger. A
    // `console.log` bypasses redaction, correlation and the level filter — and
    // the redaction backstop is the thing standing between a credential in a
    // variable and a credential in a log aggregator.
    const offenders = shippedSources()
      .filter((file) => /(^|[^.\w])console\s*\./.test(readRepo(file)))
      .map((file) => file.replace(/\\/g, '/'));

    expect(offenders).toEqual([]);
  });

  it('the package itself writes to one sink and no further', () => {
    const logger = sourceOf('src/logging/logger.ts');
    expect(logger).toMatch(/process\.stdout\.write/);
    // Exactly one place, and it is the sink a caller can replace.
    expect(logger.match(/process\.stdout\.write/g)).toHaveLength(1);
    expect(logger).not.toMatch(/console\./);
  });
});

// ── 3 · No backend anywhere ─────────────────────────────────────────────────

describe('no telemetry backend is reachable from this package', () => {
  it('the manifest declares no backend dependency', () => {
    const manifest = read('package.json');
    for (const backend of [
      '@opentelemetry',
      'prom-client',
      'prometheus',
      '@sentry',
      'datadog',
      'dd-trace',
      'newrelic',
      'aws-sdk',
      'winston',
      'pino',
      'bunyan',
    ]) {
      expect(manifest).not.toContain(backend);
    }
  });

  it('the manifest declares no driver or client', () => {
    const manifest = read('package.json');
    for (const client of ['pg', 'postgres', 'ioredis', 'redis', 'bullmq', 'stripe', 'openai']) {
      expect(manifest).not.toMatch(new RegExp(`"${client}"`));
    }
  });

  it('no source file imports one', () => {
    for (const file of [
      ...ADDED,
      'src/index.ts',
      'src/logging/logger.ts',
      'src/metrics/registry.ts',
      'src/tracing/tracer.ts',
      'src/health/health.ts',
    ]) {
      const code = sourceOf(file);
      expect(code).not.toMatch(/@opentelemetry|prom-client|@sentry|dd-trace|winston|pino/);
      expect(code).not.toMatch(/from '(pg|postgres|ioredis|redis|bullmq|stripe|openai)'/);
    }
  });

  it('the tracing model is W3C, implemented here rather than imported', () => {
    // "No OpenTelemetry dependency" — the trace context format is a standard,
    // and using it is not the same as taking the SDK.
    const trace = sourceOf('src/tracing/trace-context.ts');
    expect(trace).not.toMatch(/@opentelemetry/);
    expect(trace).toMatch(/traceparent/i);
  });
});

// ── 4 · It observes, and owns no business logic ─────────────────────────────

describe('the observability layer owns nothing', () => {
  it('imports no domain package', () => {
    for (const file of [...ADDED, 'src/index.ts']) {
      const code = sourceOf(file);
      expect(code).not.toMatch(/@contentos\/(platform|ai|content|events|database|storage)/);
    }
  });

  it('names no business concept in the component vocabulary', () => {
    // A domain module cannot be unreachable, only wrong.
    for (const domain of [
      'billing',
      'credits',
      'content',
      'commerce',
      'workspace',
      'subscription',
    ]) {
      expect(isObservedComponent(domain)).toBe(false);
    }
  });

  it('never labels a metric with an identifier', () => {
    // An unbounded label is a cardinality explosion, and it puts tenant
    // identity somewhere with weaker controls than the source table.
    const forbidden = /organizationId|organization_id|userId|user_id|tenantId|correlationId/;
    for (const definition of CORE_METRIC_DEFINITIONS) {
      for (const label of definition.labelNames) {
        expect(label).not.toMatch(forbidden);
      }
    }
  });

  it('publishes no balance, no amount and no price', () => {
    // The ledger is the source of truth about money; a metric carrying an
    // amount would be a second one.
    for (const definition of CORE_METRIC_DEFINITIONS) {
      expect(definition.name).not.toMatch(/balance|amount|price|revenue|mrr/i);
      for (const label of definition.labelNames) {
        expect(label).not.toMatch(/amount|price|balance/i);
      }
    }
  });

  it('repairs nothing and reconnects to nothing', () => {
    // `monitoring.md` §9: a health check is read-only.
    const health = sourceOf('src/health/health.ts');
    expect(health).not.toMatch(/reconnect|repair|restart\(|\.connect\(|retryConnection/i);

    // Word-anchored: `Health` contains "heal", and a substring match here would
    // fail on the very type the port is named for.
    for (const file of ADDED) {
      expect(sourceOf(file)).not.toMatch(/\b(?:reconnect|repair|restart|remediate)\b/i);
    }
  });

  it('the health ports offer no way to act', () => {
    const ports = sourceOf('src/ports.ts');
    const reporterBlock = ports.slice(ports.indexOf('interface HealthReporter'));
    expect(reporterBlock).toMatch(/live\(\)/);
    expect(reporterBlock).toMatch(/ready\(\)/);
    expect(reporterBlock).toMatch(/deep\(\)/);
    expect(reporterBlock).not.toMatch(/set|update|write|repair|reset/i);
  });
});

// ── 5 · The guards ──────────────────────────────────────────────────────────

describe('the four guards refuse what a wire or an environment can carry', () => {
  it('reject an invalid severity', () => {
    expect(isLogLevel('trace')).toBe(false);
    expect(LOG_LEVELS.every((level) => isLogLevel(level))).toBe(true);
  });

  it('reject a malformed health state', () => {
    expect(isHealthStatus('ok')).toBe(false);
    expect(HEALTH_STATUSES.every((status) => isHealthStatus(status))).toBe(true);
  });

  it('reject an unknown metric kind', () => {
    expect(isMetricKind('summary')).toBe(false);
    expect(isMetricKind('counter')).toBe(true);
  });

  it('reject an unknown outcome', () => {
    expect(isOutcome('ok')).toBe(false);
    expect(isOutcome('denied')).toBe(true);
  });

  it('leave every vocabulary exactly as it was', () => {
    // The guards are additive. A new member would be a second model.
    expect(LOG_LEVELS).toEqual(['error', 'warn', 'info', 'debug']);
    expect(HEALTH_STATUSES).toEqual(['healthy', 'degraded', 'unhealthy']);
  });
});

// ── 6 · Deviations ──────────────────────────────────────────────────────────

describe('recorded deviations', () => {
  it('DEVIATION: the models existed under the package’s own names', () => {
    // `LogEvent` is `LogRecord`, `MetricEvent` is `MetricSample`, `TraceEvent`
    // is `FinishedSpan`, `ComponentHealth` is `DependencyReport`,
    // `OperationResult` is `Outcome`. Renaming five canonical types to match an
    // increment's wording would be a second vocabulary for the same facts.
    const barrel = sourceOf('src/index.ts');
    for (const existing of [
      'LogRecord',
      'MetricSample',
      'FinishedSpan',
      'DependencyReport',
      'Outcome',
      'HealthStatus',
    ]) {
      expect(barrel).toContain(existing);
    }
    for (const invented of ['LogEvent', 'MetricEvent', 'TraceEvent', 'ComponentHealth']) {
      expect(barrel).not.toContain(invented);
    }
  });

  it('DEVIATION: `Logger` and `Tracer` needed no new port', () => {
    // Both were already interfaces. Only the two classes needed one.
    expect(sourceOf('src/logging/logger.ts')).toMatch(/export interface Logger/);
    expect(sourceOf('src/tracing/tracer.ts')).toMatch(/export interface Tracer/);
    expect(sourceOf('src/ports.ts')).not.toMatch(/interface (?:Logger|Tracer)\b/);
  });

  it('DEVIATION: an identical metric redeclaration is still accepted', () => {
    // "Reject duplicate metric definition" means reject a CONFLICTING one. Two
    // modules both wanting the same counter is the ordinary idiom, and the
    // existing suite asserts it.
    const registry = new MetricRegistry();
    registry.counter({ name: 'x_total', help: 'x', labelNames: ['a'] });

    expect(() => registry.counter({ name: 'x_total', help: 'x', labelNames: ['a'] })).not.toThrow();
    expect(() => registry.counter({ name: 'x_total', help: 'x', labelNames: ['b'] })).toThrow();
  });

  it('DEVIATION: `help` is not compared on redeclaration', () => {
    // Prose for an operator. A startup crash over a reworded sentence would be
    // worse than the drift it prevents.
    const registry = new MetricRegistry();
    registry.counter({ name: 'y_total', help: 'One wording.', labelNames: [] });

    expect(() =>
      registry.counter({ name: 'y_total', help: 'Another wording.', labelNames: [] }),
    ).not.toThrow();
  });

  it('DEVIATION: AI providers are one component, not one per vendor', () => {
    // A per-vendor component would invite a probe on a timer, which is a second
    // source of truth about a vendor's health beside the calls actually failing.
    expect(OBSERVED_COMPONENTS).toContain('ai_providers');
    expect(isObservedComponent('openai')).toBe(false);
    expect(isObservedComponent('anthropic')).toBe(false);
  });

  it('DEVIATION: the cache metric counts, and publishes no ratio', () => {
    // A ratio computed in-process is a ratio over one process's lifetime.
    const cache = CORE_METRIC_DEFINITIONS.find((d) => d.name === 'cache_operations_total');
    expect(cache?.kind).toBe('counter');
    expect(CORE_METRIC_DEFINITIONS.map((d) => d.name)).not.toContain('cache_hit_ratio');
  });
});
