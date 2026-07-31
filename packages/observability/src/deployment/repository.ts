/**
 * The deployment and operations ports — interfaces, and nothing else.
 *
 * ── They store DESCRIPTIONS, never infrastructure ─────────────────────────
 * A `DeploymentRepository` holds release records, plans and deployments: §5's
 * outputs, so an incident can answer "did we just ship something?" and a
 * dashboard can draw a deploy line. It reaches no orchestrator, no registry and
 * no CI system, and there is no `deploy`, `apply`, `scale` or `rollback` method
 * on either interface — nor any way to add one without changing this file.
 *
 * ── Append-only, with one transition ──────────────────────────────────────
 * A release record and a deployment are historical facts. The only thing that
 * changes is a deployment's STATE, and that has its own method so an audit
 * record can be written beside it — §Security: "every deploy, rollback, flag
 * change, and manual migration is append-only audit-logged".
 *
 * ── No database, no clock, no SQL ────────────────────────────────────────
 * Keyset positions, explicit nulls, supplied instants — the shapes
 * `AuditQuery`, `FindingQuery`, `BackupQuery` and `SettlementQuery` already
 * established.
 */

import type {
  Deployment,
  DeploymentId,
  DeploymentPlan,
  DeploymentState,
  RollbackPlan,
} from './deployment.js';
import type {
  MaintenanceWindow,
  MaintenanceWindowId,
  OperationalRunbook,
  RunbookId,
} from './operations.js';
import type { ProductionReadinessReport } from './readiness.js';
import type { DeploymentEnvironment, Release, ReleaseId } from './release.js';

/** Where a page of deployments continues from. Keyset, never an offset. */
export interface DeploymentPosition {
  readonly startedAt: string;
  readonly deploymentId: DeploymentId;
}

export interface DeploymentQuery {
  /** Required: "what is running in production" is the usual question. */
  readonly environment: DeploymentEnvironment;
  readonly releaseId: ReleaseId | null;
  /** Match any. Null lists every state. Never an empty array. */
  readonly states: readonly DeploymentState[] | null;
  /** Inclusive. */
  readonly startedAfter: string | null;
  /** Exclusive, so adjacent windows never count one deploy twice. */
  readonly startedBefore: string | null;
  readonly after: DeploymentPosition | null;
  readonly limit: number;
}

export interface DeploymentSlice {
  /** Newest first: "did we just ship something?" is asked about the last one. */
  readonly deployments: readonly Deployment[];
  readonly next: DeploymentPosition | null;
}

export interface DeploymentRepository {
  /**
   * Record a release.
   *
   * Must refuse a duplicate id: two releases under one id would make an
   * incident timeline ambiguous about which artifact was running.
   */
  recordRelease(release: Release): Promise<Release>;

  loadRelease(releaseId: ReleaseId): Promise<Release | null>;

  /** Record an approved plan. Storing a plan is not executing one. */
  recordPlan(plan: DeploymentPlan): Promise<DeploymentPlan>;

  loadPlan(planId: DeploymentId): Promise<DeploymentPlan | null>;

  /** Record that a deployment began. Must refuse a duplicate id. */
  recordDeployment(deployment: Deployment): Promise<Deployment>;

  loadDeployment(deploymentId: DeploymentId): Promise<Deployment | null>;

  /**
   * Move a deployment to a new state.
   *
   * The ONLY mutation on this interface. `at` is supplied so the transition and
   * whatever audits it agree about when it happened.
   */
  transitionDeployment(input: {
    readonly deploymentId: DeploymentId;
    readonly state: DeploymentState;
    readonly at: string;
  }): Promise<Deployment>;

  /** The release currently live in an environment, or null. */
  findLiveDeployment(environment: DeploymentEnvironment): Promise<Deployment | null>;

  listDeployments(query: DeploymentQuery): Promise<DeploymentSlice>;

  /** Record an approved rollback plan. It performs nothing. */
  recordRollbackPlan(plan: RollbackPlan): Promise<RollbackPlan>;

  /** Append a readiness report. There is no path to amend one. */
  recordReadinessReport(report: ProductionReadinessReport): Promise<ProductionReadinessReport>;

  loadReadinessReport(releaseId: ReleaseId): Promise<ProductionReadinessReport | null>;
}

// ── Operations ──────────────────────────────────────────────────────────────

export interface MaintenanceQuery {
  readonly environment: DeploymentEnvironment;
  /** Only windows open at this instant. Null lists every declared one. */
  readonly activeAt: string | null;
  readonly limit: number;
}

export interface MaintenanceSlice {
  readonly windows: readonly MaintenanceWindow[];
}

export interface OperationsRepository {
  /**
   * Declare a window.
   *
   * Declaring is not entering: nothing on this interface puts the platform into
   * maintenance, and a method that could would be able to take it down.
   */
  declareWindow(window: MaintenanceWindow): Promise<MaintenanceWindow>;

  loadWindow(windowId: MaintenanceWindowId): Promise<MaintenanceWindow | null>;

  listWindows(query: MaintenanceQuery): Promise<MaintenanceSlice>;

  saveRunbook(runbook: OperationalRunbook): Promise<OperationalRunbook>;

  loadRunbook(runbookId: RunbookId): Promise<OperationalRunbook | null>;

  /** Every runbook for a scenario. What a readiness gate checks exists. */
  findRunbooksFor(scenario: string): Promise<readonly OperationalRunbook[]>;
}
