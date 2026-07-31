/**
 * The two services against in-memory ports.
 *
 * The unit suite checks each model on values. This runs the whole cycle — record
 * a release, approve a plan against it, start the deployment, walk §10's state
 * machine, approve a rollback, read the report, assess readiness, declare a
 * window, save a runbook — and asserts what only the wiring can show: that a
 * plan is validated against the release the SERVICE loaded rather than one the
 * caller supplied, that the transition is refused before the store is reached,
 * and that nothing anywhere runs a command.
 */

import { describe, expect, it } from 'vitest';

import {
  type Deployment,
  type DeploymentPlan,
  type DeploymentState,
  type RollbackPlan,
} from './deployment.js';
import { DeploymentError } from './errors.js';
import type { MaintenanceWindow, OperationalRunbook } from './operations.js';
import {
  projectHealth,
  READINESS_CHECKS,
  type ProductionReadinessReport,
  type ReadinessCheck,
} from './readiness.js';
import type {
  DeploymentRepository,
  DeploymentSlice,
  MaintenanceSlice,
  OperationsRepository,
} from './repository.js';
import type { Release } from './release.js';
import {
  createDeploymentService,
  createProductionOperationsService,
  DEPLOYMENT_ACTIONS,
  toAuditEvent,
} from './service.js';

const NOW = '2026-03-20T12:00:00.000Z';
const SHA = 'a'.repeat(40);
const DIGEST = `sha256:${'b'.repeat(64)}`;
const PREVIOUS = `sha256:${'c'.repeat(64)}`;

/** In-memory ports. They model uniqueness and selection, nothing else. */
function stores() {
  const releases: Release[] = [];
  const plans: DeploymentPlan[] = [];
  const deployments: Deployment[] = [];
  const rollbacks: RollbackPlan[] = [];
  const reports: ProductionReadinessReport[] = [];
  const windows: MaintenanceWindow[] = [];
  const runbooks: OperationalRunbook[] = [];
  const calls: string[] = [];

  const deploymentRepository: DeploymentRepository = {
    recordRelease(release) {
      calls.push('deployments.recordRelease');
      if (releases.some((r) => r.releaseId === release.releaseId)) {
        throw new DeploymentError(
          'DuplicateDeployment',
          'releaseId',
          'That release is already recorded.',
        );
      }
      releases.push(release);
      return Promise.resolve(release);
    },
    loadRelease(releaseId) {
      calls.push('deployments.loadRelease');
      return Promise.resolve(releases.find((r) => r.releaseId === releaseId) ?? null);
    },
    recordPlan(plan) {
      calls.push('deployments.recordPlan');
      plans.push(plan);
      return Promise.resolve(plan);
    },
    loadPlan(planId) {
      calls.push('deployments.loadPlan');
      return Promise.resolve(plans.find((p) => p.planId === planId) ?? null);
    },
    recordDeployment(deployment) {
      calls.push('deployments.recordDeployment');
      if (deployments.some((d) => d.deploymentId === deployment.deploymentId)) {
        throw new DeploymentError(
          'DuplicateDeployment',
          'deploymentId',
          'That deployment is already recorded.',
        );
      }
      deployments.push(deployment);
      return Promise.resolve(deployment);
    },
    loadDeployment(deploymentId) {
      calls.push('deployments.loadDeployment');
      return Promise.resolve(deployments.find((d) => d.deploymentId === deploymentId) ?? null);
    },
    transitionDeployment(input) {
      calls.push('deployments.transitionDeployment');
      const index = deployments.findIndex((d) => d.deploymentId === input.deploymentId);
      const current = deployments[index];
      if (current === undefined) {
        throw new DeploymentError('DuplicateDeployment', 'deploymentId', 'No such deployment.');
      }
      const atRest = input.state === 'live' || input.state === 'previous_live';
      const moved: Deployment = {
        ...current,
        state: input.state,
        completedAt: atRest ? input.at : null,
      };
      deployments[index] = moved;
      return Promise.resolve(moved);
    },
    findLiveDeployment(environment) {
      calls.push('deployments.findLiveDeployment');
      return Promise.resolve(
        deployments.find((d) => d.environment === environment && d.state === 'live') ?? null,
      );
    },
    listDeployments(query): Promise<DeploymentSlice> {
      calls.push('deployments.listDeployments');
      return Promise.resolve({
        deployments: deployments.filter((d) => d.environment === query.environment),
        next: null,
      });
    },
    recordRollbackPlan(plan) {
      calls.push('deployments.recordRollbackPlan');
      rollbacks.push(plan);
      return Promise.resolve(plan);
    },
    recordReadinessReport(report) {
      calls.push('deployments.recordReadinessReport');
      reports.push(report);
      return Promise.resolve(report);
    },
    loadReadinessReport(releaseId) {
      calls.push('deployments.loadReadinessReport');
      return Promise.resolve(reports.find((r) => r.releaseId === releaseId) ?? null);
    },
  };

  const operationsRepository: OperationsRepository = {
    declareWindow(window) {
      calls.push('operations.declareWindow');
      windows.push(window);
      return Promise.resolve(window);
    },
    loadWindow(windowId) {
      calls.push('operations.loadWindow');
      return Promise.resolve(windows.find((w) => w.windowId === windowId) ?? null);
    },
    listWindows(query): Promise<MaintenanceSlice> {
      calls.push('operations.listWindows');
      return Promise.resolve({
        windows: windows.filter((w) => w.environment === query.environment),
      });
    },
    saveRunbook(runbook) {
      calls.push('operations.saveRunbook');
      runbooks.push(runbook);
      return Promise.resolve(runbook);
    },
    loadRunbook(runbookId) {
      calls.push('operations.loadRunbook');
      return Promise.resolve(runbooks.find((r) => r.runbookId === runbookId) ?? null);
    },
    findRunbooksFor(scenario) {
      calls.push('operations.findRunbooksFor');
      return Promise.resolve(runbooks.filter((r) => r.scenario === scenario));
    },
  };

  return {
    deployments: deploymentRepository,
    operations: operationsRepository,
    calls,
    rows: { releases, plans, deployments, rollbacks, reports, windows, runbooks },
  };
}

function services() {
  const store = stores();
  return {
    ...store,
    deployment: createDeploymentService({ deployments: store.deployments }),
    ops: createProductionOperationsService({
      operations: store.operations,
      deployments: store.deployments,
    }),
  };
}

const release = (overrides: Partial<Release> = {}): Release => ({
  releaseId: 'release-2026-03-20',
  version: '1.4.2',
  commitSha: SHA,
  artifactDigest: DIGEST,
  migrationPhase: 'expand',
  migrations: ['0026_add_column'],
  flagsChanged: ['ai.new_model'],
  actor: 'ci.pipeline',
  createdAt: '2026-03-20T10:00:00.000Z',
  ...overrides,
});

const plan = (overrides: Partial<DeploymentPlan> = {}): DeploymentPlan => ({
  planId: 'plan-001',
  releaseId: 'release-2026-03-20',
  environment: 'production',
  strategy: 'rolling',
  targets: ['migrations', 'workers', 'api', 'web'],
  approved: true,
  soakMinutes: 30,
  createdAt: NOW,
  ...overrides,
});

const deployment = (overrides: Partial<Deployment> = {}): Deployment => ({
  deploymentId: 'deploy-001',
  planId: 'plan-001',
  releaseId: 'release-2026-03-20',
  environment: 'production',
  state: 'planned',
  startedAt: '2026-03-20T11:00:00.000Z',
  completedAt: null,
  ...overrides,
});

const allPassing = (): ReadinessCheck[] =>
  READINESS_CHECKS.map((check) => ({ check, passed: true, detail: null }));

// ── The cycle ───────────────────────────────────────────────────────────────

describe('a release goes out and comes to rest', () => {
  it('walks the whole §10 machine', async () => {
    const { deployment: service, calls } = services();

    await service.recordRelease(release(), NOW);
    await service.approvePlan(plan());
    await service.recordDeployment(deployment());

    let current = await service.transition({
      deploymentId: 'deploy-001',
      state: 'deploying',
      at: '2026-03-20T11:01:00.000Z',
    });
    expect(current.state).toBe('deploying');

    current = await service.transition({
      deploymentId: 'deploy-001',
      state: 'verifying',
      at: '2026-03-20T11:06:00.000Z',
    });
    expect(current.state).toBe('verifying');

    current = await service.transition({
      deploymentId: 'deploy-001',
      state: 'live',
      at: '2026-03-20T11:12:00.000Z',
    });
    expect(current.state).toBe('live');
    expect(current.completedAt).toBe('2026-03-20T11:12:00.000Z');

    // Nothing but reads, records and one transition per move.
    expect(calls.filter((call) => call === 'deployments.transitionDeployment')).toHaveLength(3);
  });

  it('can still roll back after going live, because §10 says so', async () => {
    const { deployment: service } = services();

    await service.recordRelease(release(), NOW);
    await service.approvePlan(plan());
    await service.recordDeployment(deployment());
    await service.transition({ deploymentId: 'deploy-001', state: 'deploying', at: NOW });
    await service.transition({ deploymentId: 'deploy-001', state: 'verifying', at: NOW });
    await service.transition({ deploymentId: 'deploy-001', state: 'live', at: NOW });

    // An SLO burn half an hour after a green deploy.
    const rollingBack = await service.transition({
      deploymentId: 'deploy-001',
      state: 'rolling_back',
      at: '2026-03-20T11:45:00.000Z',
    });
    expect(rollingBack.state).toBe('rolling_back');

    const settled = await service.transition({
      deploymentId: 'deploy-001',
      state: 'previous_live',
      at: '2026-03-20T11:52:00.000Z',
    });
    expect(settled.state).toBe('previous_live');
  });
});

describe('the plan is checked against the release the service loaded', () => {
  it('refuses a plan naming a release nobody recorded', async () => {
    const { deployment: service, calls } = services();

    await expect(service.approvePlan(plan())).rejects.toBeInstanceOf(DeploymentError);
    // It loaded before it recorded — and never recorded.
    expect(calls).toContain('deployments.loadRelease');
    expect(calls).not.toContain('deployments.recordPlan');
  });

  it('refuses a deployment whose plan was never approved', async () => {
    const { deployment: service, calls } = services();

    await service.recordRelease(release(), NOW);
    await expect(service.recordDeployment(deployment())).rejects.toBeInstanceOf(DeploymentError);
    expect(calls).not.toContain('deployments.recordDeployment');
  });

  it('refuses a deployment recorded against the wrong environment', async () => {
    // The plan was approved for staging; the deployment claims production.
    const { deployment: service } = services();

    await service.recordRelease(release(), NOW);
    await service.approvePlan(plan({ environment: 'staging', approved: false }));

    await expect(
      service.recordDeployment(deployment({ environment: 'production' })),
    ).rejects.toThrow(/wrong environment/u);
  });
});

describe('the state machine is enforced before the store is reached', () => {
  it('refuses an illegal move without touching the store', async () => {
    const { deployment: service, calls } = services();

    await service.recordRelease(release(), NOW);
    await service.approvePlan(plan());
    await service.recordDeployment(deployment());

    // `planned` has one edge out, and it is not this one.
    await expect(
      service.transition({ deploymentId: 'deploy-001', state: 'live', at: NOW }),
    ).rejects.toThrow(/no such edge/u);

    expect(calls).not.toContain('deployments.transitionDeployment');
  });

  it('refuses a transition on a deployment that has no record', async () => {
    const { deployment: service } = services();

    await expect(
      service.transition({ deploymentId: 'deploy-404', state: 'deploying', at: NOW }),
    ).rejects.toBeInstanceOf(DeploymentError);
  });

  it('refuses every move the machine has no edge for', async () => {
    const { deployment: service } = services();

    await service.recordRelease(release(), NOW);
    await service.approvePlan(plan());
    await service.recordDeployment(deployment());

    const illegal: DeploymentState[] = ['verifying', 'live', 'previous_live', 'planned'];
    for (const state of illegal) {
      await expect(
        service.transition({ deploymentId: 'deploy-001', state, at: NOW }),
      ).rejects.toBeInstanceOf(DeploymentError);
    }
  });
});

describe('rollback approval reads the release it undoes', () => {
  const rollback = (overrides: Partial<RollbackPlan> = {}): RollbackPlan => ({
    planId: 'rollback-001',
    deploymentId: 'deploy-001',
    previousDigest: PREVIOUS,
    automatic: true,
    reason: 'Verification failed on the canary.',
    estimatedMinutes: 6,
    createdAt: NOW,
    ...overrides,
  });

  async function live(migrationPhase: Release['migrationPhase'] = 'expand') {
    const context = services();
    await context.deployment.recordRelease(
      release({ migrationPhase, migrations: migrationPhase === 'none' ? [] : ['0026_x'] }),
      NOW,
    );
    await context.deployment.approvePlan(plan());
    await context.deployment.recordDeployment(deployment());
    await context.deployment.transition({
      deploymentId: 'deploy-001',
      state: 'deploying',
      at: NOW,
    });
    return context;
  }

  it('approves a rollback of an expand migration', async () => {
    const context = await live('expand');

    const approved = await context.deployment.approveRollback(rollback());
    expect(approved.previousDigest).toBe(PREVIOUS);
    expect(context.rows.rollbacks).toHaveLength(1);
  });

  it('refuses a rollback of a contract migration', async () => {
    // The caller does not supply the release; the service loads it, so the
    // phase cannot be misreported.
    const context = await live('contract');

    await expect(context.deployment.approveRollback(rollback())).rejects.toThrow(
      /Recover forward with a hotfix/u,
    );
    expect(context.calls).not.toContain('deployments.recordRollbackPlan');
  });

  it('refuses a rollback for a deployment that has no record', async () => {
    const context = services();

    await expect(context.deployment.approveRollback(rollback())).rejects.toBeInstanceOf(
      DeploymentError,
    );
    expect(context.calls).not.toContain('deployments.recordRollbackPlan');
  });

  it('refuses a rollback whose release has no record', async () => {
    const context = services();
    // A deployment recorded straight into the store, with no release behind it.
    await context.deployments.recordDeployment(deployment({ state: 'live', completedAt: NOW }));

    await expect(context.deployment.approveRollback(rollback())).rejects.toBeInstanceOf(
      DeploymentError,
    );
  });
});

describe('the deployment report', () => {
  it('joins the deployment, its plan and its readiness report', async () => {
    const context = services();

    await context.deployment.recordRelease(release(), NOW);
    await context.deployment.approvePlan(plan());
    await context.deployment.recordDeployment(deployment());
    await context.deployment.transition({
      deploymentId: 'deploy-001',
      state: 'deploying',
      at: '2026-03-20T11:01:00.000Z',
    });
    await context.deployment.transition({
      deploymentId: 'deploy-001',
      state: 'verifying',
      at: '2026-03-20T11:06:00.000Z',
    });
    await context.deployment.transition({
      deploymentId: 'deploy-001',
      state: 'live',
      at: '2026-03-20T11:12:00.000Z',
    });
    await context.ops.assessReadiness({
      reportId: 'readiness-001',
      environment: 'production',
      releaseId: 'release-2026-03-20',
      checks: allPassing(),
      generatedAt: NOW,
    });

    const report = await context.deployment.report('deploy-001', NOW);

    expect(report?.succeeded).toBe(true);
    expect(report?.durationSeconds).toBe(720);
    expect(report?.readiness?.ready).toBe(true);
    expect(report?.targets).toEqual(['migrations', 'workers', 'api', 'web']);
  });

  it('does not call it a success when a gate failed', async () => {
    const context = services();

    await context.deployment.recordRelease(release(), NOW);
    await context.deployment.approvePlan(plan());
    await context.deployment.recordDeployment(deployment({ state: 'live', completedAt: NOW }));
    await context.ops.assessReadiness({
      reportId: 'readiness-001',
      environment: 'production',
      releaseId: 'release-2026-03-20',
      checks: allPassing().map((check) =>
        check.check === 'rollback_available' ? { ...check, passed: false } : check,
      ),
      generatedAt: NOW,
    });

    const report = await context.deployment.report('deploy-001', NOW);
    expect(report?.succeeded).toBe(false);
  });

  it('is null for a deployment nobody recorded', async () => {
    const { deployment: service } = services();
    expect(await service.report('deploy-404', NOW)).toBeNull();
  });
});

// ── Production operations ───────────────────────────────────────────────────

describe('readiness assessment', () => {
  it('records a report with `ready` derived', async () => {
    const context = services();

    const report = await context.ops.assessReadiness({
      reportId: 'readiness-001',
      environment: 'production',
      releaseId: 'release-2026-03-20',
      checks: allPassing(),
      generatedAt: NOW,
    });

    expect(report.ready).toBe(true);
    expect(context.rows.reports).toHaveLength(1);
  });

  it('names what blocks a promotion', async () => {
    const context = services();

    await context.ops.assessReadiness({
      reportId: 'readiness-001',
      environment: 'production',
      releaseId: 'release-2026-03-20',
      checks: allPassing().map((check) =>
        check.check === 'recent_verified_backup' || check.check === 'audit_chain_intact'
          ? { ...check, passed: false }
          : check,
      ),
      generatedAt: NOW,
    });

    expect(await context.ops.blockers('release-2026-03-20')).toEqual([
      'recent_verified_backup',
      'audit_chain_intact',
    ]);
  });

  it('blocks nothing when there is no report, because there is nothing to say', async () => {
    const context = services();
    expect(await context.ops.blockers('release-unknown')).toEqual([]);
  });

  it('refuses to record a report that omits a required gate', async () => {
    const context = services();

    await expect(
      context.ops.assessReadiness({
        reportId: 'readiness-001',
        environment: 'production',
        releaseId: 'release-2026-03-20',
        checks: [{ check: 'dependencies_healthy', passed: true, detail: null }],
        generatedAt: NOW,
      }),
    ).rejects.toBeInstanceOf(DeploymentError);

    expect(context.calls).not.toContain('deployments.recordReadinessReport');
  });
});

describe('maintenance', () => {
  const window = (overrides: Partial<MaintenanceWindow> = {}): MaintenanceWindow => ({
    windowId: 'window-001',
    environment: 'production',
    mode: 'read_only',
    startsAt: '2026-03-21T02:00:00.000Z',
    endsAt: '2026-03-21T04:00:00.000Z',
    reason: 'Database restore drill.',
    declaredBy: 'ops.oncall',
    declaredAt: NOW,
    ...overrides,
  });

  it('declares a window and answers the mode in force', async () => {
    const context = services();

    await context.ops.declareWindow(window(), NOW);

    expect(await context.ops.maintenanceMode('production', '2026-03-21T03:00:00.000Z')).toBe(
      'read_only',
    );
    expect(await context.ops.maintenanceMode('production', '2026-03-21T05:00:00.000Z')).toBe('off');
  });

  it('takes the strictest of two overlapping windows', async () => {
    const context = services();

    await context.ops.declareWindow(window(), NOW);
    await context.ops.declareWindow(window({ windowId: 'window-002', mode: 'full' }), NOW);

    expect(await context.ops.maintenanceMode('production', '2026-03-21T03:00:00.000Z')).toBe(
      'full',
    );
  });

  it('keeps one environment’s windows out of another’s answer', async () => {
    const context = services();

    await context.ops.declareWindow(window(), NOW);

    expect(await context.ops.maintenanceMode('staging', '2026-03-21T03:00:00.000Z')).toBe('off');
  });

  it('refuses an invalid window before the store is reached', async () => {
    const context = services();

    await expect(context.ops.declareWindow(window({ mode: 'off' }), NOW)).rejects.toBeInstanceOf(
      DeploymentError,
    );
    expect(context.calls).not.toContain('operations.declareWindow');
  });
});

describe('runbooks', () => {
  const runbook = (overrides: Partial<OperationalRunbook> = {}): OperationalRunbook => ({
    runbookId: 'runbook-rollback',
    title: 'Roll back a production release.',
    scenario: 'rollback',
    steps: [
      {
        order: 1,
        action: 'Identify the previously live artifact digest.',
        verification: 'It differs from the digest currently live.',
      },
    ],
    owner: 'ops.platform',
    lastRehearsedAt: '2026-02-01T00:00:00.000Z',
    updatedAt: NOW,
    ...overrides,
  });

  it('saves a runbook and finds the stale ones for a scenario', async () => {
    const context = services();

    await context.ops.saveRunbook(runbook(), NOW);
    await context.ops.saveRunbook(
      runbook({ runbookId: 'runbook-restore', scenario: 'restore', lastRehearsedAt: null }),
      NOW,
    );

    expect(await context.ops.staleRunbooks('rollback', NOW)).toHaveLength(0);
    expect(await context.ops.staleRunbooks('restore', NOW)).toHaveLength(1);
  });

  it('calls a runbook rehearsed a year ago stale', async () => {
    const context = services();

    await context.ops.saveRunbook(runbook({ lastRehearsedAt: '2025-03-01T00:00:00.000Z' }), NOW);

    expect(await context.ops.staleRunbooks('rollback', NOW)).toHaveLength(1);
  });

  it('refuses an empty runbook before the store is reached', async () => {
    const context = services();

    await expect(context.ops.saveRunbook(runbook({ steps: [] }), NOW)).rejects.toBeInstanceOf(
      DeploymentError,
    );
    expect(context.calls).not.toContain('operations.saveRunbook');
  });
});

describe('the environment projection reads what the store holds', () => {
  const health = () =>
    projectHealth([
      { component: 'database', status: 'healthy' },
      { component: 'redis', status: 'healthy' },
      { component: 'queue', status: 'healthy' },
    ]);

  it('names the live release and the health together', async () => {
    const context = services();

    await context.deployment.recordRelease(release(), NOW);
    await context.deployment.approvePlan(plan());
    await context.deployment.recordDeployment(deployment({ state: 'live', completedAt: NOW }));

    const projection = await context.ops.environment({
      environment: 'production',
      health: health(),
      at: NOW,
    });

    expect(projection.liveReleaseId).toBe('release-2026-03-20');
    expect(projection.realData).toBe(true);
    expect(projection.requiresApproval).toBe(true);
    expect(projection.health.readyToServe).toBe(true);
  });

  it('reads a bounded page', async () => {
    const context = services();

    await context.ops.environment({ environment: 'production', health: health(), at: NOW });

    expect(context.calls).toContain('deployments.listDeployments');
  });

  it('says nothing is live when nothing has been deployed', async () => {
    const context = services();

    const projection = await context.ops.environment({
      environment: 'production',
      health: health(),
      at: NOW,
    });

    expect(projection.liveReleaseId).toBeNull();
    expect(projection.inFlightDeploymentId).toBeNull();
  });
});

// ── The bridge to audit ─────────────────────────────────────────────────────

describe('the audit projection', () => {
  it('carries the artifact digest §Security requires', () => {
    const event = toAuditEvent({
      action: DEPLOYMENT_ACTIONS.deploymentStarted,
      actorId: 'ci.pipeline',
      actorKind: 'service',
      organizationId: 'org-01',
      correlationId: 'corr-01',
      targetKind: 'deployment',
      targetId: 'deploy-001',
      reason: 'Release 1.4.2 to production.',
      artifactDigest: DIGEST,
    });

    expect(event.metadata?.['artifact_digest']).toBe(DIGEST);
    expect(event.category).toBe('administration');
    expect(event.tenantId).toBeNull();
    expect(Object.isFrozen(event)).toBe(true);
  });

  it('omits the metadata entirely when there is no digest', () => {
    // `exactOptionalPropertyTypes`: absent, never `undefined`.
    const event = toAuditEvent({
      action: DEPLOYMENT_ACTIONS.maintenanceDeclared,
      actorId: 'ops.oncall',
      actorKind: 'operator',
      organizationId: 'org-01',
      correlationId: 'corr-02',
      targetKind: 'maintenance_window',
      targetId: 'window-001',
      reason: 'Restore drill.',
    });

    expect('metadata' in event).toBe(false);
  });

  it('never reports a failure, because it projects actions that happened', () => {
    const event = toAuditEvent({
      action: DEPLOYMENT_ACTIONS.rollbackApproved,
      actorId: 'ops.oncall',
      actorKind: 'operator',
      organizationId: 'org-01',
      correlationId: 'corr-03',
      targetKind: 'deployment',
      targetId: 'deploy-001',
      reason: 'SLO burn.',
    });

    expect(event.result).toBe('success');
  });

  it('names every action §Security lists', () => {
    expect(Object.values(DEPLOYMENT_ACTIONS)).toEqual([
      'deployment.release.recorded',
      'deployment.plan.approved',
      'deployment.started',
      'deployment.completed',
      'deployment.rollback.approved',
      'deployment.maintenance.declared',
    ]);
  });
});

// ── What the services do NOT do ─────────────────────────────────────────────

describe('neither service executes anything', () => {
  it('only ever calls the ports it was given', async () => {
    const context = services();

    await context.deployment.recordRelease(release(), NOW);
    await context.deployment.approvePlan(plan());
    await context.deployment.recordDeployment(deployment());
    await context.ops.declareWindow(
      {
        windowId: 'window-001',
        environment: 'production',
        mode: 'read_only',
        startsAt: '2026-03-21T02:00:00.000Z',
        endsAt: '2026-03-21T04:00:00.000Z',
        reason: 'Restore drill.',
        declaredBy: 'ops.oncall',
        declaredAt: NOW,
      },
      NOW,
    );

    // Every call went to a port. There is no other way out of this module.
    for (const call of context.calls) {
      expect(call).toMatch(/^(deployments|operations)\./u);
    }
  });

  it('exposes no method that could perform a deployment', () => {
    const context = services();

    for (const name of ['deploy', 'apply', 'scale', 'rollback', 'exec', 'run', 'restart']) {
      expect(name in context.deployment).toBe(false);
      expect(name in context.ops).toBe(false);
      expect(name in context.deployments).toBe(false);
      expect(name in context.operations).toBe(false);
    }
  });

  it('is frozen, so nothing can be attached to it later', () => {
    const context = services();

    expect(Object.isFrozen(context.deployment)).toBe(true);
    expect(Object.isFrozen(context.ops)).toBe(true);
  });

  it('takes no transaction handle, so it cannot write an audit record', () => {
    const context = services();

    // §Security's audit is the caller's, in the caller's transaction. There is
    // nothing here to write one through.
    for (const key of Object.keys(context.deployment)) {
      expect(key).not.toMatch(/audit|transaction|tx\b/iu);
    }
    for (const key of Object.keys(context.ops)) {
      expect(key).not.toMatch(/audit|transaction|tx\b/iu);
    }
  });
});
