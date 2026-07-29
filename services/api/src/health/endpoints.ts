/**
 * Health endpoints — `14-operations/monitoring.md` §9.
 *
 *   /health/live     process is running; NO dependency checks
 *   /health/ready    local dependencies + migration version
 *   /health/startup  one-time boot completion
 *
 * ALL health LOGIC lives in `@contentos/observability`'s `HealthMonitor`. This
 * module maps its reports to HTTP and nothing else — duplicating the semantics
 * here would let the two drift, and the probe that matters would be the one
 * nobody tested.
 */

import type { HealthMonitor } from '@contentos/observability';

export interface HealthHttpResponse {
  readonly status: number;
  readonly body: unknown;
}

/**
 * Liveness is 200 unless the process is gone, in which case nothing answers.
 * It consults no dependency: a liveness probe that fails on a database blip
 * makes the orchestrator restart healthy processes during an outage, turning a
 * degradation into an outage.
 */
export function live(monitor: HealthMonitor): HealthHttpResponse {
  return { status: 200, body: monitor.live() };
}

/**
 * Readiness is 200 when local dependencies are reachable and the migration
 * version is current; 503 otherwise, which removes the instance from the load
 * balancer without killing it.
 *
 * `degraded` is deliberately READY. A degraded dependency means reduced
 * capability, not inability to serve — marking every instance unready would
 * take the whole platform down for a partial failure.
 */
export async function ready(monitor: HealthMonitor): Promise<HealthHttpResponse> {
  const report = await monitor.ready();
  return { status: report.status === 'unhealthy' ? 503 : 200, body: report };
}

/**
 * Startup gates the other two during boot. An orchestrator that polls liveness
 * during a slow migration will kill the process mid-migration; a startup probe
 * gives it a bounded window to finish.
 */
export interface StartupState {
  readonly complete: boolean;
  readonly completedAt: Date | null;
}

export class StartupTracker {
  #complete = false;
  #completedAt: Date | null = null;
  readonly #now: () => Date;

  constructor(now: () => Date = (): Date => new Date()) {
    this.#now = now;
  }

  /** Idempotent: the first completion wins, so a re-entrant boot cannot reset it. */
  markComplete(): void {
    if (this.#complete) return;
    this.#complete = true;
    this.#completedAt = this.#now();
  }

  state(): StartupState {
    return { complete: this.#complete, completedAt: this.#completedAt };
  }
}

export function startup(tracker: StartupTracker): HealthHttpResponse {
  const state = tracker.state();
  return {
    status: state.complete ? 200 : 503,
    body: { status: state.complete ? 'started' : 'starting', completedAt: state.completedAt },
  };
}

/** The three probe paths. Health endpoints are the ONLY unauthenticated routes. */
export const HEALTH_PATHS = {
  live: '/health/live',
  ready: '/health/ready',
  startup: '/health/startup',
} as const;

export function isHealthPath(path: string): boolean {
  return Object.values(HEALTH_PATHS).includes(
    path as (typeof HEALTH_PATHS)[keyof typeof HEALTH_PATHS],
  );
}
