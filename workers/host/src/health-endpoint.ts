/**
 * Worker health probes.
 *
 * Spec: `13-event-platform/workers.md`, `10-operations/observability.md`.
 *
 * LIVENESS AND READINESS ANSWER DIFFERENT QUESTIONS, and conflating them is the
 * classic way to make deploys lose events:
 *
 *   - READINESS: "should this worker be given work?" It must fail the moment
 *     SIGTERM arrives, so the orchestrator takes the worker out of rotation
 *     while it still has its whole termination grace period to drain.
 *
 *   - LIVENESS: "is this process still making progress?" It must KEEP PASSING
 *     while the worker drains. A liveness probe that fails on SIGTERM gets the
 *     draining worker SIGKILLed mid-publish — exactly the outcome graceful
 *     shutdown exists to prevent.
 *
 * So `draining` is deliberately NOT READY BUT STILL ALIVE. That asymmetry is
 * the entire point of splitting the two probes.
 *
 * Probes are pure functions over `WorkerHealth`; the HTTP server is a thin
 * binding over them, so the decision logic is testable without a socket.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import type { WorkerHealth } from './relay-worker.js';

export type ProbeState = 'pass' | 'fail';

export interface ProbeResult {
  readonly state: ProbeState;
  /** 200 when passing, 503 when not — the codes orchestrators act on. */
  readonly httpStatus: 200 | 503;
  readonly reason: string;
  readonly detail: Readonly<Record<string, unknown>>;
}

/**
 * A cycle must complete within this window or the loop is considered wedged.
 *
 * Generous relative to the idle interval on purpose: a probe that trips on
 * normal jitter causes restart storms, which cost more availability than the
 * stall it was meant to catch.
 */
export const DEFAULT_STALL_THRESHOLD_MS = 60_000;

/** Startup gets its own budget: the first cycle may wait on a cold connection. */
export const DEFAULT_STARTUP_GRACE_MS = 30_000;

export interface ProbeOptions {
  readonly stallThresholdMs?: number;
  readonly startupGraceMs?: number;
  readonly now?: () => Date;
}

function pass(reason: string, detail: Readonly<Record<string, unknown>>): ProbeResult {
  return { state: 'pass', httpStatus: 200, reason, detail };
}

function fail(reason: string, detail: Readonly<Record<string, unknown>>): ProbeResult {
  return { state: 'fail', httpStatus: 503, reason, detail };
}

function millisSince(from: Date, to: Date): number {
  return to.getTime() - from.getTime();
}

/**
 * Liveness: is the poll loop still turning?
 *
 * Fails ONLY for a wedged loop — a worker that is `ready` but has not completed
 * a cycle within the stall threshold. Restarting is the only remedy for that,
 * because the loop swallows and reports its own cycle errors, so a stall means
 * something below it is blocked rather than failing.
 *
 * `draining` and `stopped` always pass: the process is doing exactly what it
 * was asked to do, and killing it would abandon in-flight work.
 */
export function livenessProbe(health: WorkerHealth, options: ProbeOptions = {}): ProbeResult {
  const now = (options.now ?? ((): Date => new Date()))();
  const stallMs = options.stallThresholdMs ?? DEFAULT_STALL_THRESHOLD_MS;
  const graceMs = options.startupGraceMs ?? DEFAULT_STARTUP_GRACE_MS;
  const detail = {
    status: health.status,
    cyclesCompleted: health.cyclesCompleted,
    inFlight: health.inFlight,
  };

  if (health.status === 'draining' || health.status === 'stopped') {
    // Shutting down is not a fault. Never let a probe SIGKILL a draining worker.
    return pass('Worker is shutting down; liveness is intentionally unaffected.', detail);
  }

  // Before the first cycle there is no cycle time to measure against, so
  // startup is judged from `startedAt` under its own, larger budget.
  const reference = health.lastCycleAt ?? health.startedAt;
  const budget = health.lastCycleAt === null ? graceMs : stallMs;
  const idleMs = millisSince(reference, now);

  if (idleMs > budget) {
    return fail(
      health.lastCycleAt === null
        ? `No cycle completed within ${String(budget)}ms of start.`
        : `No cycle completed for ${String(idleMs)}ms.`,
      { ...detail, idleMs, budgetMs: budget },
    );
  }

  return pass('Poll loop is turning.', { ...detail, idleMs });
}

/** A dependency the worker cannot do its job without. Readiness only. */
export interface DependencyReport {
  readonly name: string;
  readonly healthy: boolean;
  readonly detail?: string;
}

/**
 * Readiness: should this worker be handed work?
 *
 * Only `ready` qualifies. `starting` has not recovered pending entries yet, and
 * `draining` has already committed to stopping — sending either more work is
 * how a rolling deploy strands events in a pending list.
 */
export function readinessProbe(
  health: WorkerHealth,
  dependencies: readonly DependencyReport[] = [],
): ProbeResult {
  const detail = {
    status: health.status,
    hostedGroups: health.hostedGroups,
    dependencies: dependencies.map((d) => ({ name: d.name, healthy: d.healthy })),
  };

  if (health.status !== 'ready') {
    return fail(`Worker is '${health.status}', not ready for work.`, detail);
  }

  const unhealthy = dependencies.filter((d) => !d.healthy);
  if (unhealthy.length > 0) {
    return fail(
      `Unavailable dependencies: ${unhealthy.map((d) => d.name).join(', ')}.`,
      // The detail names WHICH dependency failed; an operator paged at 3am
      // should not have to guess between Postgres and Redis.
      { ...detail, unhealthy: unhealthy.map((d) => ({ name: d.name, detail: d.detail })) },
    );
  }

  return pass('Worker is ready.', detail);
}

export interface HealthServerDeps {
  readonly health: () => WorkerHealth;
  /**
   * Checked on readiness only, and expected to be CHEAP — a probe runs every
   * few seconds. A check that fails must resolve to an unhealthy report rather
   * than reject, so an unreachable dependency reads as "not ready" instead of
   * crashing the probe.
   */
  readonly checkDependencies?: () => Promise<readonly DependencyReport[]>;
  readonly probeOptions?: ProbeOptions;
  readonly onProbeError?: (error: unknown) => void;
}

export const HEALTH_ROUTES = Object.freeze({
  live: '/health/live',
  ready: '/health/ready',
  status: '/health',
});

async function dependencyReports(deps: HealthServerDeps): Promise<readonly DependencyReport[]> {
  if (deps.checkDependencies === undefined) return [];
  try {
    return await deps.checkDependencies();
  } catch (error) {
    deps.onProbeError?.(error);
    // An exception is itself evidence the dependency is unusable. Reporting it
    // as unhealthy keeps the probe answering 503 instead of hanging or 500ing,
    // which is what the orchestrator knows how to act on.
    return [
      {
        name: 'dependencies',
        healthy: false,
        detail: error instanceof Error ? error.message : String(error),
      },
    ];
  }
}

/**
 * Build the HTTP handler. Exported separately from the server so it can be
 * exercised directly, and mounted into another server if a worker ever needs to
 * share a port.
 */
export function createHealthHandler(
  deps: HealthServerDeps,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res): void => {
    const url = (req.url ?? '/').split('?')[0] ?? '/';

    const respond = (result: ProbeResult, extra: Record<string, unknown> = {}): void => {
      res.writeHead(result.httpStatus, {
        'content-type': 'application/json',
        // Probe responses are point-in-time facts; a cached one is a lie.
        'cache-control': 'no-store',
      });
      res.end(
        JSON.stringify({ state: result.state, reason: result.reason, ...result.detail, ...extra }),
      );
    };

    if (url === HEALTH_ROUTES.live) {
      respond(livenessProbe(deps.health(), deps.probeOptions));
      return;
    }

    if (url === HEALTH_ROUTES.ready) {
      void dependencyReports(deps).then(
        (reports) => {
          respond(readinessProbe(deps.health(), reports));
        },
        (error: unknown) => {
          deps.onProbeError?.(error);
          respond(fail('Readiness check failed.', {}));
        },
      );
      return;
    }

    if (url === HEALTH_ROUTES.status) {
      const health = deps.health();
      const live = livenessProbe(health, deps.probeOptions);
      // The status page reports liveness only, so it never blocks on a
      // dependency check; readiness has its own route for that.
      respond(live, {
        hostedGroups: health.hostedGroups,
        lastCycleAt: health.lastCycleAt?.toISOString() ?? null,
        startedAt: health.startedAt.toISOString(),
      });
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'NotFound' }));
  };
}

export interface HealthServer {
  listen(port: number, host?: string): Promise<number>;
  close(): Promise<void>;
  readonly server: Server;
}

export function createHealthServer(deps: HealthServerDeps): HealthServer {
  const server = createServer(createHealthHandler(deps));

  return {
    server,

    listen(port, host = '0.0.0.0'): Promise<number> {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          const address = server.address();
          // Port 0 asks the OS to choose; the caller needs to learn which.
          resolve(typeof address === 'object' && address !== null ? address.port : port);
        });
      });
    },

    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.close((error) => {
          if (error !== undefined && error.message !== 'Server is not running.') reject(error);
          else resolve();
        });
      });
    },
  };
}
