/**
 * The two services — validate, describe, coordinate, report.
 *
 * ── Neither executes anything ─────────────────────────────────────────────
 * No shell, no Docker, no Kubernetes, no Terraform, no Helm, no cloud SDK, no
 * CI call, no HTTP, no filesystem, no timer. `DeploymentService` validates a
 * plan against the release it names and records what a deployment reported;
 * `ProductionOperationsService` answers whether the platform is ready and what
 * maintenance is in force.
 *
 * A deployment changes what customers are running and a rollback is the thing
 * reached for at 3am. A service that could perform either would make §3.2's
 * manual approval and §Security's audit requirement advisory rather than
 * structural.
 *
 * ── Auditing is the caller's, in the caller's transaction ─────────────────
 * §Security: "every deploy, rollback, flag change, and manual migration is
 * append-only audit-logged with actor and artifact digest." `toAuditEvent`
 * projects one onto the frozen `AuditEvent` shape; the caller records it
 * through `AuditService`. This layer takes no transaction handle, so writing an
 * audit record here is unrepresentable rather than merely discouraged.
 *
 * ── No clock, no ids, no globals ──────────────────────────────────────────
 * Every instant and identifier arrives with the request.
 */

import { deepFreeze, DeploymentError } from './errors.js';
import {
  createDeployment,
  createDeploymentPlan,
  createRollbackPlan,
  DEPLOYMENT_TRANSITION_RULES,
  type Deployment,
  type DeploymentId,
  type DeploymentPlan,
  type DeploymentState,
  type RollbackPlan,
} from './deployment.js';
import {
  createMaintenanceWindow,
  createRunbook,
  isRehearsed,
  modeAt,
  type MaintenanceMode,
  type MaintenanceWindow,
  type OperationalRunbook,
} from './operations.js';
import {
  buildDeploymentReport,
  buildReadinessReport,
  blockingChecks,
  projectEnvironment,
  type DeploymentReport,
  type EnvironmentProjection,
  type HealthProjection,
  type ProductionReadinessReport,
  type ReadinessCheck,
  type ReadinessCheckName,
} from './readiness.js';
import {
  createRelease,
  type DeploymentEnvironment,
  type Release,
  type ReleaseId,
} from './release.js';
import type { DeploymentRepository, OperationsRepository } from './repository.js';

// ── Deployments ─────────────────────────────────────────────────────────────

export interface DeploymentServiceOptions {
  readonly deployments: DeploymentRepository;
}

export interface DeploymentService {
  /** Validate a release and record it. Refuses a tag, a branch or a future date. */
  recordRelease(release: Release, now: string): Promise<Release>;

  /**
   * Validate a plan against the release it names, and record it.
   *
   * The release is LOADED rather than supplied, so a plan cannot be approved
   * against a release the caller constructed.
   */
  approvePlan(plan: DeploymentPlan): Promise<DeploymentPlan>;

  /** Record that a deployment began. */
  recordDeployment(deployment: Deployment): Promise<Deployment>;

  /**
   * Move a deployment through §10's state machine.
   *
   * The transition is validated before the store is reached, so an
   * implementation cannot be handed a move the machine forbids.
   */
  transition(input: {
    readonly deploymentId: DeploymentId;
    readonly state: DeploymentState;
    readonly at: string;
  }): Promise<Deployment>;

  /**
   * Validate a rollback against the deployment and release it undoes.
   *
   * Refuses one for a release that applied a contract migration: the old code
   * cannot read the current schema, and §10 escalates rather than attempting it.
   */
  approveRollback(plan: RollbackPlan): Promise<RollbackPlan>;

  /** §5's verification report, or null when there is no such deployment. */
  report(deploymentId: DeploymentId, generatedAt: string): Promise<DeploymentReport | null>;
}

export function createDeploymentService(options: DeploymentServiceOptions): DeploymentService {
  const { deployments } = options;

  return Object.freeze({
    async recordRelease(release: Release, now: string): Promise<Release> {
      return deployments.recordRelease(createRelease(release, now));
    },

    async approvePlan(plan: DeploymentPlan): Promise<DeploymentPlan> {
      const release = await deployments.loadRelease(plan.releaseId);
      if (release === null) {
        throw new DeploymentError(
          'InvalidReleaseVersion',
          'releaseId',
          `Release '${plan.releaseId}' has no record. A plan against an unrecorded release is one nobody can trace to an artifact digest.`,
        );
      }

      return deployments.recordPlan(createDeploymentPlan(plan));
    },

    async recordDeployment(deployment: Deployment): Promise<Deployment> {
      const plan = await deployments.loadPlan(deployment.planId);
      if (plan === null) {
        throw new DeploymentError(
          'DuplicateDeployment',
          'planId',
          `Plan '${deployment.planId}' was never approved. A deployment with no plan behind it is one nobody authorised.`,
        );
      }
      if (plan.environment !== deployment.environment) {
        throw new DeploymentError(
          'InvalidEnvironment',
          'environment',
          `The plan targets ${plan.environment} and the deployment claims ${deployment.environment}. A deployment recorded against the wrong environment would put a deploy marker on the wrong dashboard.`,
        );
      }

      return deployments.recordDeployment(createDeployment(deployment));
    },

    async transition(input: {
      readonly deploymentId: DeploymentId;
      readonly state: DeploymentState;
      readonly at: string;
    }): Promise<Deployment> {
      const current = await deployments.loadDeployment(input.deploymentId);
      if (current === null) {
        throw new DeploymentError(
          'DuplicateDeployment',
          'deploymentId',
          `Deployment '${input.deploymentId}' has no record.`,
        );
      }

      // The machine decides, not the caller: a state set directly could move a
      // deployment from `planned` straight to `live` with nothing verified.
      // The table is the ONE in `deployment.ts`; a second copy here could
      // disagree with it, and the copy every caller hit would be this one.
      const legal = Object.values(DEPLOYMENT_TRANSITION_RULES).some(
        (rule) => rule.from.includes(current.state) && rule.to === input.state,
      );
      if (!legal) {
        throw new DeploymentError(
          'IncompatibleRollback',
          'state',
          `A deployment in '${current.state}' cannot move to '${input.state}'. §10's machine has no such edge, and taking it would record a deploy as live with nothing verified.`,
        );
      }

      return deployments.transitionDeployment(input);
    },

    async approveRollback(plan: RollbackPlan): Promise<RollbackPlan> {
      const deployment = await deployments.loadDeployment(plan.deploymentId);
      if (deployment === null) {
        throw new DeploymentError(
          'IncompatibleRollback',
          'deploymentId',
          `Deployment '${plan.deploymentId}' has no record.`,
        );
      }

      const release = await deployments.loadRelease(deployment.releaseId);
      if (release === null) {
        throw new DeploymentError(
          'IncompatibleRollback',
          'releaseId',
          `Release '${deployment.releaseId}' has no record, so its migration phase is unknown. A rollback that cannot check for a contract migration is one that may get stuck halfway.`,
        );
      }

      return deployments.recordRollbackPlan(createRollbackPlan(plan, deployment, release));
    },

    async report(
      deploymentId: DeploymentId,
      generatedAt: string,
    ): Promise<DeploymentReport | null> {
      const deployment = await deployments.loadDeployment(deploymentId);
      if (deployment === null) return null;

      const plan = await deployments.loadPlan(deployment.planId);
      if (plan === null) return null;

      const readiness = await deployments.loadReadinessReport(deployment.releaseId);

      return buildDeploymentReport({ deployment, plan, readiness, generatedAt });
    },
  });
}

// ── Production operations ───────────────────────────────────────────────────

export interface ProductionOperationsServiceOptions {
  readonly operations: OperationsRepository;
  readonly deployments: DeploymentRepository;
}

export interface ProductionOperationsService {
  /**
   * Assess whether a release may be promoted.
   *
   * The checks arrive already evaluated: their owners are the health monitor,
   * the security assessment, the backup manifest and the audit chain, and this
   * layer re-derives none of them. What it does is refuse a report that omits
   * a required gate or claims ready with one failing.
   */
  assessReadiness(input: {
    readonly reportId: string;
    readonly environment: DeploymentEnvironment;
    readonly releaseId: ReleaseId;
    readonly checks: readonly ReadinessCheck[];
    readonly generatedAt: string;
  }): Promise<ProductionReadinessReport>;

  /** What blocks this release, named. Empty when nothing does. */
  blockers(releaseId: ReleaseId): Promise<readonly ReadinessCheckName[]>;

  declareWindow(window: MaintenanceWindow, now: string): Promise<MaintenanceWindow>;

  /** The mode in force, across every declared window. Strictest wins. */
  maintenanceMode(environment: DeploymentEnvironment, at: string): Promise<MaintenanceMode>;

  saveRunbook(runbook: OperationalRunbook, now: string): Promise<OperationalRunbook>;

  /** Runbooks for a scenario that have not been rehearsed recently enough. */
  staleRunbooks(scenario: string, now: string): Promise<readonly OperationalRunbook[]>;

  /** What is true of one environment right now. */
  environment(input: {
    readonly environment: DeploymentEnvironment;
    readonly health: HealthProjection;
    readonly at: string;
  }): Promise<EnvironmentProjection>;
}

export function createProductionOperationsService(
  options: ProductionOperationsServiceOptions,
): ProductionOperationsService {
  const { operations, deployments } = options;

  return Object.freeze({
    async assessReadiness(input: {
      readonly reportId: string;
      readonly environment: DeploymentEnvironment;
      readonly releaseId: ReleaseId;
      readonly checks: readonly ReadinessCheck[];
      readonly generatedAt: string;
    }): Promise<ProductionReadinessReport> {
      // `ready` is derived inside the builder, never taken from the caller.
      return deployments.recordReadinessReport(buildReadinessReport(input));
    },

    async blockers(releaseId: ReleaseId): Promise<readonly ReadinessCheckName[]> {
      const report = await deployments.loadReadinessReport(releaseId);
      return report === null ? Object.freeze([]) : blockingChecks(report);
    },

    async declareWindow(window: MaintenanceWindow, now: string): Promise<MaintenanceWindow> {
      return operations.declareWindow(createMaintenanceWindow(window, now));
    },

    async maintenanceMode(
      environment: DeploymentEnvironment,
      at: string,
    ): Promise<MaintenanceMode> {
      const slice = await operations.listWindows({
        environment,
        activeAt: at,
        limit: MAINTENANCE_PAGE,
      });
      return modeAt(slice.windows, environment, at);
    },

    async saveRunbook(runbook: OperationalRunbook, now: string): Promise<OperationalRunbook> {
      return operations.saveRunbook(createRunbook(runbook, now));
    },

    async staleRunbooks(scenario: string, now: string): Promise<readonly OperationalRunbook[]> {
      const found = await operations.findRunbooksFor(scenario);
      return Object.freeze(found.filter((runbook) => !isRehearsed(runbook, now)));
    },

    async environment(input: {
      readonly environment: DeploymentEnvironment;
      readonly health: HealthProjection;
      readonly at: string;
    }): Promise<EnvironmentProjection> {
      const slice = await deployments.listDeployments({
        environment: input.environment,
        releaseId: null,
        states: null,
        startedAfter: null,
        startedBefore: null,
        after: null,
        limit: DEPLOYMENT_PAGE,
      });

      return projectEnvironment({
        environment: input.environment,
        deployments: slice.deployments,
        health: input.health,
      });
    },
  });
}

/**
 * Bounded reads.
 *
 * A projection is a page somebody looks at; an unbounded read would make one
 * environment's answer arbitrarily slow during the incident it is needed for.
 */
const DEPLOYMENT_PAGE = 100;
const MAINTENANCE_PAGE = 50;

// ── The bridge to audit ─────────────────────────────────────────────────────

/** The deployment actions §Security requires to be audited. */
export const DEPLOYMENT_ACTIONS = Object.freeze({
  releaseRecorded: 'deployment.release.recorded',
  planApproved: 'deployment.plan.approved',
  deploymentStarted: 'deployment.started',
  deploymentCompleted: 'deployment.completed',
  rollbackApproved: 'deployment.rollback.approved',
  maintenanceDeclared: 'deployment.maintenance.declared',
} as const);

export type DeploymentAction = (typeof DEPLOYMENT_ACTIONS)[keyof typeof DEPLOYMENT_ACTIONS];

/**
 * A deployment action, in the shape the frozen `AuditEvent` takes.
 *
 * Structurally typed rather than imported: this package depends on nothing, and
 * `AuditEvent` lives in `@contentos/security`. The caller passes this straight
 * to `AuditService.record` inside the action's own transaction.
 *
 * §Security requires the artifact DIGEST on the record, so it rides in the
 * metadata — an audit entry naming a version but not a digest cannot say which
 * bytes were running.
 */
export interface DeploymentAuditEvent {
  readonly category: 'administration';
  readonly action: DeploymentAction;
  readonly tenantId: null;
  readonly organizationId: string;
  readonly actor: { readonly id: string; readonly kind: 'user' | 'service' | 'operator' };
  readonly correlationId: string;
  readonly target: { readonly kind: string; readonly id: string; readonly tenantId: null };
  readonly result: 'success';
  readonly reason: string;
  readonly ipAddress: null;
  readonly userAgent: null;
  readonly sessionId: null;
  readonly stepUpSatisfied: boolean;
  readonly metadata?: Readonly<Record<string, string>>;
}

export function toAuditEvent(input: {
  readonly action: DeploymentAction;
  readonly actorId: string;
  readonly actorKind: 'user' | 'service' | 'operator';
  readonly organizationId: string;
  readonly correlationId: string;
  readonly targetKind: string;
  readonly targetId: string;
  readonly reason: string;
  /** The artifact digest. §Security records it on every deploy. */
  readonly artifactDigest?: string;
  readonly stepUpSatisfied?: boolean;
}): DeploymentAuditEvent {
  return deepFreeze({
    category: 'administration' as const,
    action: input.action,
    // A deployment is platform-wide, not tenant-scoped: §Deploy order ships one
    // artifact for every customer at once.
    tenantId: null,
    organizationId: input.organizationId,
    actor: { id: input.actorId, kind: input.actorKind },
    correlationId: input.correlationId,
    target: { kind: input.targetKind, id: input.targetId, tenantId: null },
    result: 'success' as const,
    reason: input.reason,
    ipAddress: null,
    userAgent: null,
    sessionId: null,
    stepUpSatisfied: input.stepUpSatisfied ?? false,
    ...(input.artifactDigest === undefined
      ? {}
      : { metadata: { artifact_digest: input.artifactDigest } }),
  });
}
