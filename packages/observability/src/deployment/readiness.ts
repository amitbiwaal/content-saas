/**
 * Production readiness, the deployment report, and the two projections.
 *
 * ── `ProductionReadinessReport` is not `ReadinessReport` ──────────────────
 * `health/health.ts` already has `ReadinessReport`: the answer to
 * `/health/ready`, asked every few seconds by a load balancer, about one
 * process. This is the launch gate — asked once before a promotion, about the
 * whole platform, and covering things a probe cannot see: whether a backup
 * exists, whether the security posture has open Critical findings, whether a
 * runbook has been written. Two different questions, and merging them would
 * make a load balancer wait on a compliance check.
 *
 * ── The projections read; they never measure ──────────────────────────────
 * `projectHealth` and `projectEnvironment` fold values they are given. The
 * measuring is `HealthMonitor`'s, which is canonical and untouched.
 *
 * ── Nothing here reaches the security or backup packages ──────────────────
 * A readiness gate cares whether the security assessment and the backup
 * manifest EXIST and what they concluded, not what is in them. So those arrive
 * as small supplied facts rather than imports — this package depends on
 * nothing, and it is imported by every layer.
 */

import type { HealthStatus } from '../health/health.js';
import { isHealthStatus } from '../health/health.js';
import type { ObservedComponent } from '../components.js';
import { OBSERVED_COMPONENTS, READINESS_COMPONENTS } from '../components.js';
import { assertIdentifier, assertInstant, deepFreeze, DeploymentError } from './errors.js';
import { holdsRealData, isDeploymentEnvironment, type DeploymentEnvironment } from './release.js';
import type { Deployment, DeploymentPlan } from './deployment.js';

/**
 * The gates a promotion to production is checked against.
 *
 * Each names an existing owner: the health monitor (S6.1), the security
 * posture (S6.3), the backup manifest and DR plan (S6.4), the audit chain
 * (S6.2), and the deploy process itself. Nothing here re-derives any of them.
 */
export const READINESS_CHECKS = Object.freeze([
  /** Every readiness dependency reports healthy. `HealthMonitor`'s answer. */
  'dependencies_healthy',
  /** No open Critical or High security finding. The S6.3 assessment's answer. */
  'no_critical_findings',
  /** A verified backup exists inside the retention window. S6.4's answer. */
  'recent_verified_backup',
  /** A disaster-recovery plan covers every restorable store. S6.4's answer. */
  'recovery_plan_current',
  /** The audit chain verifies over the window. S6.2's answer. */
  'audit_chain_intact',
  /** A rollback is possible from this release. Not a contract migration. */
  'rollback_available',
  /** A runbook exists for this deployment. */
  'runbook_present',
  /** The gate report says `verdict: releasable`. */
  'gate_report_releasable',
] as const);

export type ReadinessCheckName = (typeof READINESS_CHECKS)[number];

export function isReadinessCheck(value: unknown): value is ReadinessCheckName {
  return typeof value === 'string' && (READINESS_CHECKS as readonly string[]).includes(value);
}

/**
 * The checks a production promotion may not skip.
 *
 * All of them. A launch gate with optional gates is a launch gate that gets
 * argued down at 2am — and each of these has a failure mode nobody notices
 * until it matters: no backup, an unverifiable audit trail, a rollback that
 * turns out to be impossible.
 */
export const MANDATORY_FOR_PRODUCTION: readonly ReadinessCheckName[] = Object.freeze([
  ...READINESS_CHECKS,
]);

/** What one gate concluded. `detail` is bounded and never a trace. */
export interface ReadinessCheck {
  readonly check: ReadinessCheckName;
  readonly passed: boolean;
  /** Bounded. Never a stack trace, a query or a hostname. */
  readonly detail: string | null;
}

export interface ProductionReadinessReport {
  readonly reportId: string;
  readonly environment: DeploymentEnvironment;
  readonly releaseId: string;
  readonly checks: readonly ReadinessCheck[];
  /** True only when every check the environment requires passed. */
  readonly ready: boolean;
  readonly generatedAt: string;
}

const MAX_DETAIL_LENGTH = 200;

/**
 * The checks an environment requires.
 *
 * Only production requires all of them: staging exists to find problems, and a
 * gate that blocked staging on a Critical finding would stop the deployment
 * that fixes it.
 */
export function requiredChecks(environment: DeploymentEnvironment): readonly ReadinessCheckName[] {
  return holdsRealData(environment)
    ? MANDATORY_FOR_PRODUCTION
    : Object.freeze(['dependencies_healthy' as const]);
}

export function assertValidReadinessReport(
  report: ProductionReadinessReport,
): ProductionReadinessReport {
  assertIdentifier(report.reportId, 'reportId');
  assertIdentifier(report.releaseId, 'releaseId');
  assertInstant(report.generatedAt, 'generatedAt', 'InconsistentReadiness');

  if (!isDeploymentEnvironment(report.environment)) {
    throw new DeploymentError(
      'InvalidEnvironment',
      'environment',
      `'${String(report.environment)}' is not an environment.`,
    );
  }

  const reported = new Set<ReadinessCheckName>();
  for (const check of report.checks) {
    if (!isReadinessCheck(check.check)) {
      throw new DeploymentError(
        'InconsistentReadiness',
        'checks',
        `'${String(check.check)}' is not a readiness check. Available: ${READINESS_CHECKS.join(', ')}.`,
      );
    }
    if (reported.has(check.check)) {
      throw new DeploymentError(
        'InconsistentReadiness',
        'checks',
        `Check '${check.check}' is reported twice; a report could not say which result stood.`,
      );
    }
    reported.add(check.check);

    if (check.detail !== null && check.detail.length > MAX_DETAIL_LENGTH) {
      throw new DeploymentError(
        'InconsistentReadiness',
        'checks',
        `Detail for '${check.check}' is longer than ${String(MAX_DETAIL_LENGTH)} characters. A field that wide eventually holds a stack trace.`,
      );
    }
  }

  // Every check the environment requires must be reported. An unreported gate
  // is an unrun one, and a report that omitted it would read as passing.
  for (const required of requiredChecks(report.environment)) {
    if (!reported.has(required)) {
      throw new DeploymentError(
        'InconsistentReadiness',
        'checks',
        `'${required}' is required for ${report.environment} and the report does not carry it. An unreported gate is an unrun one.`,
      );
    }
  }

  // `ready` must mean every required check passed.
  const allRequiredPassed = requiredChecks(report.environment).every((required) =>
    report.checks.some((check) => check.check === required && check.passed),
  );
  if (report.ready !== allRequiredPassed) {
    throw new DeploymentError(
      'InconsistentReadiness',
      'ready',
      allRequiredPassed
        ? 'Every required check passed and the report says it is not ready.'
        : 'The report claims ready with a required check failing. Ready means every required gate passed; anything else blocks the promotion.',
    );
  }

  return report;
}

/** Build a readiness report, with `ready` DERIVED rather than trusted. */
export function buildReadinessReport(input: {
  readonly reportId: string;
  readonly environment: DeploymentEnvironment;
  readonly releaseId: string;
  readonly checks: readonly ReadinessCheck[];
  readonly generatedAt: string;
}): ProductionReadinessReport {
  // Derived, not supplied: a caller that could set `ready` could set it true.
  const ready = requiredChecks(input.environment).every((required) =>
    input.checks.some((check) => check.check === required && check.passed),
  );

  const report: ProductionReadinessReport = {
    ...input,
    checks: input.checks.map((check) => ({ ...check })),
    ready,
  };
  assertValidReadinessReport(report);
  return deepFreeze(report);
}

/** Which gates failed. What blocks the promotion, named. */
export function blockingChecks(report: ProductionReadinessReport): readonly ReadinessCheckName[] {
  const required = new Set(requiredChecks(report.environment));
  return Object.freeze(
    report.checks
      .filter((check) => required.has(check.check) && !check.passed)
      .map((check) => check.check),
  );
}

// ── Projections ─────────────────────────────────────────────────────────────

/**
 * The health of a deployment's dependencies, folded to one answer.
 *
 * A projection over reports `HealthMonitor` produced. It measures nothing: the
 * measuring is the monitor's, and a second prober here would be a second source
 * of truth about whether a dependency is up.
 */
export interface HealthProjection {
  readonly status: HealthStatus;
  readonly components: readonly {
    readonly component: ObservedComponent;
    readonly status: HealthStatus;
  }[];
  /** Components that are not healthy. What an operator looks at first. */
  readonly degraded: readonly ObservedComponent[];
  /** True when every READINESS component is healthy — the promotion gate. */
  readonly readyToServe: boolean;
}

export function projectHealth(
  reports: readonly { readonly component: ObservedComponent; readonly status: HealthStatus }[],
): HealthProjection {
  for (const report of reports) {
    if (!isHealthStatus(report.status)) {
      throw new DeploymentError(
        'InconsistentReadiness',
        'status',
        `'${String(report.status)}' is not a health status. A malformed state flowing through a fold is treated as healthy, and an outage reads green.`,
      );
    }
    if (!(OBSERVED_COMPONENTS as readonly string[]).includes(report.component)) {
      throw new DeploymentError(
        'InconsistentReadiness',
        'component',
        `'${String(report.component)}' is not a component this build observes. Two names for one dependency produce two rows no dashboard can join.`,
      );
    }
  }

  const degraded = reports
    .filter((report) => report.status !== 'healthy')
    .map((report) => report.component);

  // Worst wins, and `unhealthy` beats `degraded`.
  const status: HealthStatus = reports.some((r) => r.status === 'unhealthy')
    ? 'unhealthy'
    : reports.some((r) => r.status === 'degraded')
      ? 'degraded'
      : 'healthy';

  return deepFreeze({
    status,
    components: reports.map((report) => ({ ...report })),
    degraded,
    readyToServe: READINESS_COMPONENTS.every((component) =>
      reports.some((report) => report.component === component && report.status === 'healthy'),
    ),
  });
}

/**
 * What is true of one environment right now.
 *
 * The answer to "what is running where", which during an incident is the
 * question asked before any other.
 */
export interface EnvironmentProjection {
  readonly environment: DeploymentEnvironment;
  readonly realData: boolean;
  readonly requiresApproval: boolean;
  /** The release currently live, or null when nothing has been deployed. */
  readonly liveReleaseId: string | null;
  readonly liveSince: string | null;
  /** A deployment still moving, or null. */
  readonly inFlightDeploymentId: string | null;
  readonly health: HealthProjection;
}

export function projectEnvironment(input: {
  readonly environment: DeploymentEnvironment;
  readonly deployments: readonly Deployment[];
  readonly health: HealthProjection;
}): EnvironmentProjection {
  if (!isDeploymentEnvironment(input.environment)) {
    throw new DeploymentError(
      'InvalidEnvironment',
      'environment',
      `'${String(input.environment)}' is not an environment.`,
    );
  }

  const mine = input.deployments.filter(
    (deployment) => deployment.environment === input.environment,
  );

  // The most recent one that came to rest LIVE. A `previous_live` deployment
  // rolled back, so it is not what is running.
  let live: Deployment | null = null;
  for (const deployment of mine) {
    if (deployment.state !== 'live') continue;
    if (live === null || (deployment.completedAt ?? '') > (live.completedAt ?? '')) {
      live = deployment;
    }
  }

  const inFlight =
    mine.find(
      (deployment) =>
        deployment.state === 'deploying' ||
        deployment.state === 'verifying' ||
        deployment.state === 'rolling_back',
    ) ?? null;

  return deepFreeze({
    environment: input.environment,
    realData: holdsRealData(input.environment),
    requiresApproval: holdsRealData(input.environment),
    liveReleaseId: live?.releaseId ?? null,
    liveSince: live?.completedAt ?? null,
    inFlightDeploymentId: inFlight?.deploymentId ?? null,
    health: input.health,
  });
}

// ── The deployment report ───────────────────────────────────────────────────

/**
 * What a deployment did — §5's verification report, which feeds the rollback
 * decision.
 */
export interface DeploymentReport {
  readonly deploymentId: string;
  readonly releaseId: string;
  readonly environment: DeploymentEnvironment;
  readonly state: Deployment['state'];
  readonly durationSeconds: number | null;
  readonly targets: readonly string[];
  readonly readiness: ProductionReadinessReport | null;
  /** False when a required gate failed, or the deployment rolled back. */
  readonly succeeded: boolean;
  readonly generatedAt: string;
}

export function buildDeploymentReport(input: {
  readonly deployment: Deployment;
  readonly plan: DeploymentPlan;
  readonly readiness: ProductionReadinessReport | null;
  readonly generatedAt: string;
}): DeploymentReport {
  assertInstant(input.generatedAt, 'generatedAt', 'InconsistentReadiness');

  const { deployment } = input;
  const durationSeconds =
    deployment.completedAt === null
      ? null
      : Math.round((Date.parse(deployment.completedAt) - Date.parse(deployment.startedAt)) / 1000);

  return deepFreeze({
    deploymentId: deployment.deploymentId,
    releaseId: deployment.releaseId,
    environment: deployment.environment,
    state: deployment.state,
    durationSeconds,
    targets: [...input.plan.targets],
    readiness: input.readiness,
    // A deployment that rolled back did not succeed, whatever its gates said.
    succeeded: deployment.state === 'live' && (input.readiness?.ready ?? true),
    generatedAt: input.generatedAt,
  });
}
