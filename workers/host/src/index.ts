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
