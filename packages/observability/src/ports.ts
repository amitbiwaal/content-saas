/**
 * The two ports the package was missing.
 *
 * ── Why these two and not four ─────────────────────────────────────────────
 * `Logger` and `Tracer` are ALREADY interfaces — a module that takes one
 * depends on a shape, and a test passes a fake. `MetricRegistry` and
 * `HealthMonitor` are concrete classes, so a module that takes either depends
 * on an implementation, and a test has to build a real one.
 *
 * These are the interfaces those two classes already satisfy. Nothing about
 * them changes: `MetricRegistry implements MetricsCollector` is true today,
 * structurally, and the conformance test asserts it. What is new is that a
 * caller can now say so in a type.
 *
 * ── They are ports, not a second system ────────────────────────────────────
 * There is no new registry, no new monitor and no new pipeline here. Adding
 * either would be the "second metrics system" the increment rules out; the one
 * that exists is the one that stays.
 *
 * ── Read-only, both of them ────────────────────────────────────────────────
 * A `HealthReporter` reports. There is no repair, no reconnect, no retry and no
 * way to add one without changing this file — `monitoring.md` §9 is explicit,
 * and a health check that reconnected would make an outage invisible by fixing
 * it just long enough to answer.
 */

import type { DeepHealthReport, LivenessReport, ReadinessReport } from './health/health.js';
import type {
  Counter,
  Gauge,
  Histogram,
  MetricDefinition,
  MetricSample,
  Timer,
} from './metrics/registry.js';

/**
 * Where a module reports measurements.
 *
 * The shape `MetricRegistry` already has. A module takes this rather than the
 * class so that a test can count observations without a registry, and so that
 * the process edge can bind an exporter without every module knowing.
 *
 * `kind` is omitted from each declaration because the method IS the kind: a
 * counter declared through `histogram()` would be a mistake the type system
 * can prevent rather than a runtime check.
 */
export interface MetricsCollector {
  counter(definition: Omit<MetricDefinition, 'kind'>): Counter;
  gauge(definition: Omit<MetricDefinition, 'kind'>): Gauge;
  histogram(definition: Omit<MetricDefinition, 'kind'>): Histogram;
  /** A histogram in seconds, with a `start()` that returns its own stop. */
  timer(definition: Omit<MetricDefinition, 'kind'>): Timer;
  /** Every definition declared so far. What an exporter enumerates. */
  definitions(): MetricDefinition[];
  /** Every series' current value. Read-only; collecting changes nothing. */
  collect(): MetricSample[];
}

/**
 * Where a deployment's health is read from.
 *
 * The shape `HealthMonitor` already has: three questions with three different
 * costs and three different consumers.
 *
 * `live` answers "is this process running" and checks no dependency, by
 * design — a liveness probe that failed on a database blip would restart every
 * pod during an incident that had nothing to do with them.
 *
 * `ready` answers "can this process serve a request" and covers local
 * dependencies only. `deep` adds the remote ones and is for an operator, not
 * for a load balancer.
 */
export interface HealthReporter {
  live(): LivenessReport;
  ready(): Promise<ReadinessReport>;
  deep(): Promise<DeepHealthReport>;
}
