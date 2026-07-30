/**
 * `@contentos/worker-host` — the single worker binary.
 *
 * Specified by `13-event-platform/workers.md`. One program hosts any set of
 * registered handlers, selected by configuration; there is no per-domain worker
 * build. Composition of relay, dispatcher, bus and DLQ happens at the process
 * edge, so this package holds lifecycle only.
 */

export type {
  CycleOutcome,
  RelayWorker,
  RelayWorkerDeps,
  WorkerHealth,
  WorkerStatus,
} from './relay-worker.js';
export {
  bindShutdownSignals,
  createRelayWorker,
  DEFAULT_BUSY_INTERVAL_MS,
  DEFAULT_IDLE_INTERVAL_MS,
  DEFAULT_RECOVER_EVERY_CYCLES,
} from './relay-worker.js';

// Event registry composition root — one registry per process, built at startup.
export { createWorkerEventRegistry, WORKER_REGISTRY_CONTRIBUTIONS } from './events/registry.js';

// Health probes. Liveness and readiness are deliberately separate: a draining
// worker must be taken out of rotation WITHOUT being killed mid-publish.
export type {
  DependencyReport,
  HealthServer,
  HealthServerDeps,
  ProbeOptions,
  ProbeResult,
  ProbeState,
} from './health-endpoint.js';
export {
  createHealthHandler,
  createHealthServer,
  DEFAULT_STALL_THRESHOLD_MS,
  DEFAULT_STARTUP_GRACE_MS,
  HEALTH_ROUTES,
  livenessProbe,
  readinessProbe,
} from './health-endpoint.js';

// Cascade consumer workers — runtime execution for the two cascade libraries.
export type {
  ConsumerGroupHealth,
  ConsumerSubscription,
  ConsumerWorker,
  ConsumerWorkerDeps,
  ConsumerWorkerHealth,
  ConsumerWorkerStatus,
  QuarantineDeps,
  RetryHistory,
} from './cascade/consumer-worker.js';
export {
  assertSubscriptionsMatchRegistry,
  createConsumerWorker,
  createQuarantine,
  createRetryHistory,
  DEFAULT_BATCH_SIZE,
  DEFAULT_BLOCK_MS,
  DEFAULT_IDLE_INTERVAL_MS as DEFAULT_CONSUMER_IDLE_INTERVAL_MS,
  SubscriptionValidationError,
} from './cascade/consumer-worker.js';

export type { CascadeHandlerDeps } from './cascade/handlers.js';
export {
  CASCADE_ACTOR,
  CASCADE_INCOMPLETE,
  CascadeIncompleteError,
  createCascadeHandlers,
} from './cascade/handlers.js';

export type { CascadeRunners } from './cascade/ports.js';
export { createCascadeRunners } from './cascade/ports.js';

export type { CascadeWorkerComposition, CascadeWorkerOptions } from './cascade/composition.js';
export {
  CASCADE_CONSUMER_GROUPS,
  composeCascadeWorker,
  subscriptionsFor,
} from './cascade/composition.js';

// Credits hold-release consumers — runtime execution for the Credits Service.
export type { CreditsHandlerDeps } from './credits/handlers.js';
export {
  CREDITS_ACTOR,
  createCreditsHandlers,
  HOLD_RELEASE_FAILED,
  HoldReleaseFailedError,
} from './credits/handlers.js';

export type { CreditsRunner } from './credits/ports.js';
export { createCreditsRunner } from './credits/ports.js';

export type { CreditsWorkerComposition, CreditsWorkerOptions } from './credits/composition.js';
export {
  composeCreditsWorker,
  CREDITS_CONSUMER_GROUPS,
  creditsSubscriptions,
} from './credits/composition.js';
