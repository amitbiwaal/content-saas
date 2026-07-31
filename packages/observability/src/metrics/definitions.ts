/**
 * The metrics the system agrees to emit. Definitions, and nothing else.
 *
 * ── Why named definitions and not just the registry ────────────────────────
 * `MetricRegistry` already builds any metric a caller describes. What it has no
 * opinion about is WHAT to describe, so the API service could name request
 * duration `http_request_seconds` while the worker names it
 * `request_duration_ms` — two series measuring one thing, in different units,
 * that no dashboard can put on one axis.
 *
 * These are the seven the increment names, declared once. Registering one is
 * `registry.timer(REQUEST_DURATION)`; nothing here registers anything itself.
 *
 * ── Seconds, never milliseconds ────────────────────────────────────────────
 * Every duration here is in seconds, matching `DEFAULT_DURATION_BUCKETS_SECONDS`
 * and the convention every metrics backend expects. A metric whose unit has to
 * be read out of its name is one somebody eventually reads wrong.
 *
 * ── No identifier is ever a label ──────────────────────────────────────────
 * `assertLabelsAllowed` refuses `organizationId`, `userId`, `correlationId` and
 * the rest — an unbounded label is a cardinality explosion that takes the
 * metrics backend down, and it puts tenant identity somewhere with weaker
 * controls than the source table. The labels below are bounded sets by
 * construction: a method, an outcome, a component, a tier.
 *
 * ── Definitions only ───────────────────────────────────────────────────────
 * No registry is created here, nothing is incremented, and no default
 * collector exists to be reached by accident.
 */

import { DEFAULT_DURATION_BUCKETS_SECONDS, type MetricDefinition } from './registry.js';

/**
 * How long the platform took to answer a request.
 *
 * `route` rather than `path`: a templated route is a bounded set, and a raw
 * path contains ids.
 */
export const REQUEST_DURATION: MetricDefinition = Object.freeze({
  name: 'request_duration_seconds',
  help: 'Time to serve an inbound request, by route, method and outcome.',
  kind: 'histogram',
  labelNames: Object.freeze(['route', 'method', 'status', 'outcome']),
  buckets: DEFAULT_DURATION_BUCKETS_SECONDS,
});

/**
 * How long a model call took.
 *
 * `provider` and `tier`, never a model identifier: `ADR-013` routes on tier, and
 * a model name is a moving target that would fragment the series every release.
 */
export const AI_EXECUTION_DURATION: MetricDefinition = Object.freeze({
  name: 'ai_execution_duration_seconds',
  help: 'Time for one model execution, by provider, tier and outcome.',
  kind: 'histogram',
  labelNames: Object.freeze(['provider', 'tier', 'capability', 'outcome']),
  buckets: DEFAULT_DURATION_BUCKETS_SECONDS,
});

/**
 * How long a payment provider took to answer.
 *
 * `operation` is the port's method — `createCheckoutSession`, `cancelSubscription`
 * — and never an amount or a customer.
 */
export const PAYMENT_DURATION: MetricDefinition = Object.freeze({
  name: 'payment_duration_seconds',
  help: 'Time for one payment provider call, by provider, operation and outcome.',
  kind: 'histogram',
  labelNames: Object.freeze(['provider', 'operation', 'outcome']),
  buckets: DEFAULT_DURATION_BUCKETS_SECONDS,
});

/**
 * How long a job waited before a consumer picked it up.
 *
 * Latency, not duration: the wait is what says the workers are behind, and it
 * is the number an autoscaler acts on. How long the job then RAN is a different
 * question and a different metric.
 */
export const QUEUE_LATENCY: MetricDefinition = Object.freeze({
  name: 'queue_latency_seconds',
  help: 'Time a job spent queued before a consumer started it, by queue.',
  kind: 'histogram',
  labelNames: Object.freeze(['queue', 'priority']),
  buckets: DEFAULT_DURATION_BUCKETS_SECONDS,
});

/**
 * Credit operations, counted.
 *
 * A counter, not a gauge of the balance: the balance is the ledger's and
 * publishing a second one here would be a second source of truth about money.
 * `operation` is the ledger's own vocabulary — authorize, consume, settle,
 * release, expire — so the series lines up with what the audit trail says.
 */
export const CREDIT_OPERATIONS: MetricDefinition = Object.freeze({
  name: 'credit_operations_total',
  help: 'Credit operations attempted, by operation and outcome. Never an amount.',
  kind: 'counter',
  labelNames: Object.freeze(['operation', 'outcome']),
});

/**
 * How long a webhook took to process, once received.
 *
 * `monitoring.md` alerts on webhook lag; this is the measurement it reads.
 * `result` distinguishes accepted from ignored, because an endpoint that
 * suddenly ignores everything looks healthy on a success rate alone.
 */
export const WEBHOOK_PROCESSING: MetricDefinition = Object.freeze({
  name: 'webhook_processing_seconds',
  help: 'Time to verify and translate one inbound webhook, by provider and result.',
  kind: 'histogram',
  labelNames: Object.freeze(['provider', 'event_type', 'result']),
  buckets: DEFAULT_DURATION_BUCKETS_SECONDS,
});

/**
 * Cache hits and misses.
 *
 * A counter of both rather than a gauge of the ratio: a ratio computed here
 * would be a ratio over the lifetime of one process, which is not the number
 * anybody wants. The backend divides two counters over a window, which is.
 */
export const CACHE_OPERATIONS: MetricDefinition = Object.freeze({
  name: 'cache_operations_total',
  help: 'Cache lookups by result (hit or miss) and cache name. Divide for a ratio.',
  kind: 'counter',
  labelNames: Object.freeze(['cache', 'result']),
});

/**
 * The seven, together.
 *
 * Frozen and enumerable so a conformance test can check every one against the
 * label rules, and so a process edge can declare them all at startup rather
 * than discovering them when the first request happens to take a code path.
 */
export const CORE_METRIC_DEFINITIONS: readonly MetricDefinition[] = Object.freeze([
  REQUEST_DURATION,
  AI_EXECUTION_DURATION,
  PAYMENT_DURATION,
  QUEUE_LATENCY,
  CREDIT_OPERATIONS,
  WEBHOOK_PROCESSING,
  CACHE_OPERATIONS,
]);
