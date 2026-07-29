/**
 * Health instrumentation — `14-operations/monitoring.md` §9.
 *
 *   /health/live   process is running; NO dependency checks
 *   /health/ready  local dependencies reachable + migration version as expected
 *   /health/deep   per-dependency status, internal and authenticated
 *
 * This module supplies the semantics. The HTTP endpoints are `services/api`'s
 * (Sprint 0, Task 4) — observability defines no API layer.
 */

export type HealthStatus = 'healthy' | 'degraded' | 'unhealthy';

/**
 * LOCAL dependencies only — database, Redis. Checked by readiness.
 *
 * REMOTE dependencies — model providers, research APIs — are `deep` only.
 * "A readiness check that calls a provider turns a provider outage into a full
 * platform outage as every instance is marked unready" (monitoring.md §9). The
 * two kinds are separate types so a remote check cannot be registered as a
 * readiness check by mistake.
 */
export interface LocalDependencyCheck {
  readonly name: string;
  readonly kind: 'local';
  /** Must be cheap and short-timeout. */
  check(signal: AbortSignal): Promise<DependencyResult>;
}

export interface RemoteDependencyCheck {
  readonly name: string;
  readonly kind: 'remote';
  check(signal: AbortSignal): Promise<DependencyResult>;
}

export type DependencyCheck = LocalDependencyCheck | RemoteDependencyCheck;

export interface DependencyResult {
  readonly status: HealthStatus;
  readonly detail?: string;
}

export interface DependencyReport extends DependencyResult {
  readonly name: string;
  readonly kind: 'local' | 'remote';
  readonly latencyMs: number;
}

export interface LivenessReport {
  readonly status: 'healthy';
  readonly service: string;
  readonly version: string;
  readonly uptimeSeconds: number;
}

export interface ReadinessReport {
  readonly status: HealthStatus;
  readonly dependencies: readonly DependencyReport[];
  readonly migrationVersion: string | null;
  readonly migrationCurrent: boolean;
}

export interface DeepHealthReport extends ReadinessReport {
  readonly remote: readonly DependencyReport[];
}

export interface HealthOptions {
  readonly service: string;
  readonly version: string;
  /** Readiness accepts LOCAL checks only — enforced by type. */
  readonly localChecks?: readonly LocalDependencyCheck[];
  readonly remoteChecks?: readonly RemoteDependencyCheck[];
  readonly migrationVersion?: () => Promise<{ version: string; current: boolean }>;
  readonly timeoutMs?: number;
  readonly now?: () => number;
  readonly startedAtMs?: number;
}

async function runCheck(
  check: DependencyCheck,
  timeoutMs: number,
  now: () => number,
): Promise<DependencyReport> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  const startedAt = now();
  try {
    const result = await check.check(controller.signal);
    return { name: check.name, kind: check.kind, ...result, latencyMs: now() - startedAt };
  } catch (error) {
    return {
      name: check.name,
      kind: check.kind,
      status: 'unhealthy',
      // Sanitised — never raw provider or database output (logging-guide.md).
      detail: error instanceof Error ? error.name : 'CheckFailed',
      latencyMs: now() - startedAt,
    };
  } finally {
    clearTimeout(timer);
  }
}

function worst(reports: readonly DependencyReport[]): HealthStatus {
  if (reports.some((r) => r.status === 'unhealthy')) return 'unhealthy';
  if (reports.some((r) => r.status === 'degraded')) return 'degraded';
  return 'healthy';
}

export class HealthMonitor {
  readonly #options: HealthOptions;
  readonly #now: () => number;
  readonly #startedAtMs: number;
  readonly #timeoutMs: number;

  constructor(options: HealthOptions) {
    this.#options = options;
    this.#now = options.now ?? ((): number => Date.now());
    this.#startedAtMs = options.startedAtMs ?? this.#now();
    this.#timeoutMs = options.timeoutMs ?? 1000;
  }

  /** Process is running. No dependency checks, by design. */
  live(): LivenessReport {
    return {
      status: 'healthy',
      service: this.#options.service,
      version: this.#options.version,
      uptimeSeconds: Math.max(0, Math.floor((this.#now() - this.#startedAtMs) / 1000)),
    };
  }

  /** Local dependencies plus migration version. Cheap, and must not cascade. */
  async ready(): Promise<ReadinessReport> {
    const dependencies = await Promise.all(
      (this.#options.localChecks ?? []).map((c) => runCheck(c, this.#timeoutMs, this.#now)),
    );

    let migrationVersion: string | null = null;
    let migrationCurrent = true;
    if (this.#options.migrationVersion !== undefined) {
      try {
        const migration = await this.#options.migrationVersion();
        migrationVersion = migration.version;
        migrationCurrent = migration.current;
      } catch {
        migrationCurrent = false;
      }
    }

    const dependencyStatus = worst(dependencies);
    const status: HealthStatus = !migrationCurrent ? 'unhealthy' : dependencyStatus;
    return { status, dependencies, migrationVersion, migrationCurrent };
  }

  /** Internal and authenticated — local plus remote, with latencies. */
  async deep(): Promise<DeepHealthReport> {
    const [readiness, remote] = await Promise.all([
      this.ready(),
      Promise.all(
        (this.#options.remoteChecks ?? []).map((c) => runCheck(c, this.#timeoutMs, this.#now)),
      ),
    ]);
    return { ...readiness, remote };
  }
}
