/**
 * Deployments, plans and rollbacks — `14-operations/deployment.md` §10.
 *
 * ── It PLANS a deployment. It never performs one ──────────────────────────
 * No shell, no Docker, no Kubernetes, no Terraform, no Helm, no cloud SDK, no
 * CI call. A plan says what WOULD ship, in what order, to which environment,
 * and what would happen if it failed. Something with credentials does the rest.
 *
 * ── The state machine is §10's ────────────────────────────────────────────
 * ```
 * [*] --> deploying
 * deploying   --> verifying     : instances healthy
 * deploying   --> rolling_back  : health checks fail
 * verifying   --> live          : smoke + SLO probes pass
 * verifying   --> rolling_back  : verification fails
 * live        --> rolling_back  : SLO burn within 30 min of the deploy
 * rolling_back--> previous_live : previous digest redeployed
 * ```
 * Transcribed, not designed. `live` has an outbound edge because §10 gives it
 * one: a deploy that looked fine can still burn its error budget half an hour
 * later, and a machine with no edge out of `live` could not express that.
 *
 * ── A contract migration makes rollback impossible ────────────────────────
 * §6: "Rolling back code is trivial; rolling back a *contract* migration is
 * not." A rollback plan for a release that already contracted is refused here,
 * with the escalation §10 names, rather than attempted and discovered stuck.
 */

import {
  assertIdentifier,
  assertInstant,
  assertText,
  deepFreeze,
  DeploymentError,
} from './errors.js';
import {
  blocksRollback,
  holdsRealData,
  isCorrectlyOrdered,
  isDeploymentEnvironment,
  isDeploymentTarget,
  isReleaseStrategy,
  ZERO_DOWNTIME_STRATEGIES,
  type DeploymentEnvironment,
  type DeploymentTarget,
  type Release,
  type ReleaseId,
  type ReleaseStrategy,
} from './release.js';

/** The states of §10's diagram, in the order it reads. */
export const DEPLOYMENT_STATES = Object.freeze([
  'planned',
  'deploying',
  'verifying',
  'live',
  'rolling_back',
  'previous_live',
] as const);

export type DeploymentState = (typeof DEPLOYMENT_STATES)[number];

export function isDeploymentState(value: unknown): value is DeploymentState {
  return typeof value === 'string' && (DEPLOYMENT_STATES as readonly string[]).includes(value);
}

export const DEPLOYMENT_TRANSITIONS = Object.freeze([
  'start',
  'instances_healthy',
  'health_checks_failed',
  'verification_passed',
  'verification_failed',
  'slo_burn',
  'previous_digest_redeployed',
] as const);

export type DeploymentTransition = (typeof DEPLOYMENT_TRANSITIONS)[number];

export interface DeploymentTransitionRule {
  readonly from: readonly DeploymentState[];
  readonly to: DeploymentState;
}

export const DEPLOYMENT_TRANSITION_RULES: Readonly<
  Record<DeploymentTransition, DeploymentTransitionRule>
> = Object.freeze({
  start: { from: ['planned'], to: 'deploying' },
  instances_healthy: { from: ['deploying'], to: 'verifying' },
  health_checks_failed: { from: ['deploying'], to: 'rolling_back' },
  verification_passed: { from: ['verifying'], to: 'live' },
  verification_failed: { from: ['verifying'], to: 'rolling_back' },
  // §10: a deploy that looked fine can still burn its budget half an hour later.
  slo_burn: { from: ['live'], to: 'rolling_back' },
  previous_digest_redeployed: { from: ['rolling_back'], to: 'previous_live' },
});

export function canTransition(from: DeploymentState, transition: DeploymentTransition): boolean {
  return DEPLOYMENT_TRANSITION_RULES[transition].from.includes(from);
}

export function transitionsFrom(state: DeploymentState): readonly DeploymentTransition[] {
  return Object.freeze(DEPLOYMENT_TRANSITIONS.filter((t) => canTransition(state, t)));
}

export function assertTransitionAllowed(
  from: DeploymentState,
  transition: DeploymentTransition,
): DeploymentState {
  if (!canTransition(from, transition)) {
    throw new DeploymentError(
      'IncompatibleRollback',
      'state',
      `Cannot '${transition}' a deployment in '${from}'. Available from '${from}': ${transitionsFrom(from).join(', ') || '(none — terminal)'}.`,
    );
  }
  return DEPLOYMENT_TRANSITION_RULES[transition].to;
}

export type DeploymentId = string;

/**
 * What a deployment would do.
 *
 * `targets` is ordered, and the order is validated: §3.3's sequence is a rule,
 * not a preference.
 */
export interface DeploymentPlan {
  readonly planId: DeploymentId;
  readonly releaseId: ReleaseId;
  readonly environment: DeploymentEnvironment;
  readonly strategy: ReleaseStrategy;
  /** In deploy order. Migrations, workers, API, web. */
  readonly targets: readonly DeploymentTarget[];
  /**
   * Whether a human approved it. §3.2: auto for green non-breaking, manual for
   * a schema or infra change.
   */
  readonly approved: boolean;
  /** How long §3.2's soak runs before promotion. Thirty minutes on staging. */
  readonly soakMinutes: number;
  readonly createdAt: string;
}

export const STAGING_SOAK_MINUTES = 30;

/** §10: rollback complete within ten minutes of the decision. */
export const ROLLBACK_TARGET_MINUTES = 10;

export interface Deployment {
  readonly deploymentId: DeploymentId;
  readonly planId: DeploymentId;
  readonly releaseId: ReleaseId;
  readonly environment: DeploymentEnvironment;
  readonly state: DeploymentState;
  readonly startedAt: string;
  /** Null while it is still moving. */
  readonly completedAt: string | null;
}

/**
 * How a deployment would be undone.
 *
 * `previousDigest` is what makes it possible at all: §10's rollback is "the
 * previous digest redeployed", and a plan without one is a rollback with
 * nowhere to go.
 */
export interface RollbackPlan {
  readonly planId: DeploymentId;
  readonly deploymentId: DeploymentId;
  /** The digest to return to. Never a tag. */
  readonly previousDigest: string;
  /** Whether this can happen without a human. §10: verification failure cannot. */
  readonly automatic: boolean;
  readonly reason: string;
  /** Minutes this rollback is expected to take. Compared against the target. */
  readonly estimatedMinutes: number;
  readonly createdAt: string;
}

const DIGEST = /^sha256:[0-9a-f]{64}$/;

export function assertValidDeploymentPlan(plan: DeploymentPlan): DeploymentPlan {
  assertIdentifier(plan.planId, 'planId');
  assertIdentifier(plan.releaseId, 'releaseId');
  assertInstant(plan.createdAt, 'createdAt', 'FutureReleaseTimestamp');

  if (!isDeploymentEnvironment(plan.environment)) {
    throw new DeploymentError(
      'InvalidEnvironment',
      'environment',
      `'${String(plan.environment)}' is not an environment this build knows.`,
    );
  }
  if (!isReleaseStrategy(plan.strategy)) {
    throw new DeploymentError(
      'UnsupportedStrategy',
      'strategy',
      `'${String(plan.strategy)}' is not a release strategy.`,
    );
  }

  // A `recreate` deployment has no rollback shorter than a redeploy, and §10
  // targets ten minutes.
  if (holdsRealData(plan.environment) && !ZERO_DOWNTIME_STRATEGIES.includes(plan.strategy)) {
    throw new DeploymentError(
      'UnsupportedStrategy',
      'strategy',
      `'${plan.strategy}' takes every instance down at once. Production keeps the previous version running while the new one proves itself, because that is what makes a ten-minute rollback possible.`,
    );
  }

  // §3.2: manual approval for production.
  if (holdsRealData(plan.environment) && !plan.approved) {
    throw new DeploymentError(
      'InvalidEnvironment',
      'approved',
      'A production deployment is approved before it is planned. Promotion is automatic only for a green, non-breaking change into a non-production environment.',
    );
  }

  if (plan.targets.length === 0) {
    throw new DeploymentError(
      'InvalidDeployOrder',
      'targets',
      'A plan deploys at least one target.',
    );
  }

  const seen = new Set<DeploymentTarget>();
  for (const target of plan.targets) {
    if (!isDeploymentTarget(target)) {
      throw new DeploymentError(
        'InvalidDeployOrder',
        'targets',
        `'${String(target)}' is not a deployment target.`,
      );
    }
    if (seen.has(target)) {
      throw new DeploymentError(
        'InvalidDeployOrder',
        'targets',
        `Target '${target}' is listed twice; a deploy could not say which pass it meant.`,
      );
    }
    seen.add(target);
  }

  if (!isCorrectlyOrdered(plan.targets)) {
    throw new DeploymentError(
      'InvalidDeployOrder',
      'targets',
      'Targets ship in order: migrations, workers, API, web. Workers go before the API because they must be able to handle any job the new API can enqueue; the web app goes last so no user sees a UI referencing an endpoint that is not yet live.',
    );
  }

  if (!Number.isSafeInteger(plan.soakMinutes) || plan.soakMinutes < 0) {
    throw new DeploymentError(
      'InvalidReleaseVersion',
      'soakMinutes',
      'A soak is a non-negative whole number of minutes.',
    );
  }
  if (plan.environment === 'staging' && plan.soakMinutes < STAGING_SOAK_MINUTES) {
    throw new DeploymentError(
      'InvalidReleaseVersion',
      'soakMinutes',
      `Staging soaks for ${String(STAGING_SOAK_MINUTES)} minutes before promotion; this plan allows ${String(plan.soakMinutes)}. The soak is what catches an error-rate or queue-depth regression that a smoke test does not.`,
    );
  }

  return plan;
}

export function createDeploymentPlan(plan: DeploymentPlan): DeploymentPlan {
  assertValidDeploymentPlan(plan);
  return deepFreeze({ ...plan, targets: [...plan.targets] });
}

export function assertValidDeployment(deployment: Deployment): Deployment {
  assertIdentifier(deployment.deploymentId, 'deploymentId');
  assertIdentifier(deployment.planId, 'planId');
  assertIdentifier(deployment.releaseId, 'releaseId');
  assertInstant(deployment.startedAt, 'startedAt', 'FutureReleaseTimestamp');

  if (!isDeploymentEnvironment(deployment.environment)) {
    throw new DeploymentError(
      'InvalidEnvironment',
      'environment',
      `'${String(deployment.environment)}' is not an environment.`,
    );
  }
  if (!isDeploymentState(deployment.state)) {
    throw new DeploymentError(
      'IncompatibleRollback',
      'state',
      `'${String(deployment.state)}' is not a deployment state. Available: ${DEPLOYMENT_STATES.join(', ')}.`,
    );
  }
  if (deployment.completedAt !== null) {
    assertInstant(deployment.completedAt, 'completedAt', 'FutureReleaseTimestamp');
    if (Date.parse(deployment.completedAt) < Date.parse(deployment.startedAt)) {
      throw new DeploymentError(
        'IncompatibleRollback',
        'completedAt',
        'A deployment cannot finish before it started.',
      );
    }
  }

  // A deployment still moving has not completed; one that has reached rest has.
  const settled = deployment.state === 'live' || deployment.state === 'previous_live';
  if (settled && deployment.completedAt === null) {
    throw new DeploymentError(
      'IncompatibleRollback',
      'completedAt',
      `A deployment in '${deployment.state}' has come to rest and records when. Without it, no deploy marker can be placed on a dashboard.`,
    );
  }
  if (!settled && deployment.completedAt !== null) {
    throw new DeploymentError(
      'IncompatibleRollback',
      'completedAt',
      `A deployment in '${deployment.state}' is still moving; recording a completion would put a deploy marker on a deploy that has not finished.`,
    );
  }

  return deployment;
}

export function createDeployment(deployment: Deployment): Deployment {
  assertValidDeployment(deployment);
  return deepFreeze({ ...deployment });
}

/**
 * Validate a rollback against the deployment and release it undoes.
 *
 * The release is required: whether a rollback is possible at all is a property
 * of its migration phase, not of the rollback plan.
 */
export function assertValidRollbackPlan(
  plan: RollbackPlan,
  deployment: Deployment,
  release: Release,
): RollbackPlan {
  assertIdentifier(plan.planId, 'planId');
  assertIdentifier(plan.deploymentId, 'deploymentId');
  assertInstant(plan.createdAt, 'createdAt', 'FutureReleaseTimestamp');
  assertText(plan.reason, 'reason', 'a rollback is recorded with why it happened.');

  if (plan.deploymentId !== deployment.deploymentId) {
    throw new DeploymentError(
      'IncompatibleRollback',
      'deploymentId',
      `The plan names deployment '${plan.deploymentId}' and the deployment supplied is '${deployment.deploymentId}'.`,
    );
  }
  if (typeof plan.previousDigest !== 'string' || !DIGEST.test(plan.previousDigest)) {
    throw new DeploymentError(
      'IncompatibleRollback',
      'previousDigest',
      'A rollback returns to a digest, never a tag. A rollback plan without one is a rollback with nowhere to go.',
    );
  }
  if (plan.previousDigest === release.artifactDigest) {
    throw new DeploymentError(
      'IncompatibleRollback',
      'previousDigest',
      'The rollback target is the digest currently deployed. Redeploying the same artifact changes nothing and costs the ten minutes a real rollback had.',
    );
  }

  // §6/§10: rolling back code is trivial; rolling back a contract migration is
  // not, and §10 escalates rather than attempting it.
  if (blocksRollback(release.migrationPhase)) {
    throw new DeploymentError(
      'IncompatibleRollback',
      'migrationPhase',
      'This release applied a contract migration, so the old code cannot read the current schema. Recover forward with a hotfix; restoring from PITR is the last resort, and this is an incident-response escalation rather than a rollback.',
    );
  }

  if (!Number.isSafeInteger(plan.estimatedMinutes) || plan.estimatedMinutes < 0) {
    throw new DeploymentError(
      'IncompatibleRollback',
      'estimatedMinutes',
      'An estimate is a non-negative whole number of minutes.',
    );
  }
  if (plan.estimatedMinutes > ROLLBACK_TARGET_MINUTES) {
    throw new DeploymentError(
      'IncompatibleRollback',
      'estimatedMinutes',
      `The plan estimates ${String(plan.estimatedMinutes)} minutes; the target is ${String(ROLLBACK_TARGET_MINUTES)}. A rollback slower than the target is one that will not be reached for in an incident.`,
    );
  }

  return plan;
}

export function createRollbackPlan(
  plan: RollbackPlan,
  deployment: Deployment,
  release: Release,
): RollbackPlan {
  assertValidRollbackPlan(plan, deployment, release);
  return deepFreeze({ ...plan });
}

/** Can this deployment still be rolled back at all? */
export function isRollbackable(deployment: Deployment, release: Release): boolean {
  return (
    !blocksRollback(release.migrationPhase) &&
    canTransition(
      deployment.state,
      deployment.state === 'live' ? 'slo_burn' : 'verification_failed',
    )
  );
}
