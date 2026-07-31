import { describe, expect, it } from 'vitest';

import {
  assertTransitionAllowed,
  assertValidDeployment,
  assertValidDeploymentPlan,
  assertValidRollbackPlan,
  canTransition,
  createDeployment,
  createDeploymentPlan,
  createRollbackPlan,
  DEPLOYMENT_STATES,
  DEPLOYMENT_TRANSITION_RULES,
  DEPLOYMENT_TRANSITIONS,
  isRollbackable,
  ROLLBACK_TARGET_MINUTES,
  STAGING_SOAK_MINUTES,
  transitionsFrom,
  type Deployment,
  type DeploymentPlan,
  type RollbackPlan,
} from './deployment.js';
import {
  assertIdentifier,
  assertInstant,
  assertText,
  DeploymentError,
  MAX_IDENTIFIER_LENGTH,
  MAX_TEXT_LENGTH,
  type DeploymentErrorCode,
} from './errors.js';
import {
  assertValidMaintenanceWindow,
  assertValidRunbook,
  blocksReads,
  blocksWrites,
  createMaintenanceWindow,
  createRunbook,
  isRehearsed,
  isWindowActive,
  MAINTENANCE_MODES,
  MAX_RUNBOOK_STEPS,
  MAX_WINDOW_HOURS,
  modeAt,
  type MaintenanceWindow,
  type OperationalRunbook,
} from './operations.js';
import {
  assertValidReadinessReport,
  blockingChecks,
  buildDeploymentReport,
  buildReadinessReport,
  projectEnvironment,
  projectHealth,
  READINESS_CHECKS,
  requiredChecks,
  type ReadinessCheck,
} from './readiness.js';
import {
  assertValidRelease,
  createRelease,
  DEPLOYMENT_ENVIRONMENTS,
  DEPLOYMENT_TARGETS,
  ENVIRONMENT_CONFIGURATIONS,
  configurationOf,
  holdsRealData,
  isCorrectlyOrdered,
  isDeploymentEnvironment,
  MIGRATION_PHASES,
  orderTargets,
  promotionRank,
  RELEASE_STRATEGIES,
  ZERO_DOWNTIME_STRATEGIES,
  type Release,
} from './release.js';

const NOW = '2026-03-20T12:00:00.000Z';
const SHA = 'a'.repeat(40);
const DIGEST = `sha256:${'b'.repeat(64)}`;
const PREVIOUS = `sha256:${'c'.repeat(64)}`;

const codeOf = (call: () => unknown): DeploymentErrorCode | null => {
  try {
    call();
    return null;
  } catch (error) {
    if (error instanceof DeploymentError) return error.code;
    throw error;
  }
};

const release = (overrides: Partial<Release> = {}): Release => ({
  releaseId: 'release-2026-03-20',
  version: '1.4.2',
  commitSha: SHA,
  artifactDigest: DIGEST,
  migrationPhase: 'expand',
  migrations: ['0026_add_column'],
  flagsChanged: [],
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
  state: 'live',
  startedAt: '2026-03-20T11:00:00.000Z',
  completedAt: '2026-03-20T11:12:00.000Z',
  ...overrides,
});

const rollback = (overrides: Partial<RollbackPlan> = {}): RollbackPlan => ({
  planId: 'rollback-001',
  deploymentId: 'deploy-001',
  previousDigest: PREVIOUS,
  automatic: true,
  reason: 'Post-deploy verification failed.',
  estimatedMinutes: 6,
  createdAt: NOW,
  ...overrides,
});

// ── Environments ────────────────────────────────────────────────────────────

describe('the environments are the document’s', () => {
  it('names the four, in promotion order', () => {
    expect(DEPLOYMENT_ENVIRONMENTS).toEqual(['local', 'e2e', 'staging', 'production']);
    expect(promotionRank('staging')).toBeLessThan(promotionRank('production'));
  });

  it('gives each a configuration', () => {
    expect(ENVIRONMENT_CONFIGURATIONS).toHaveLength(4);
    for (const environment of DEPLOYMENT_ENVIRONMENTS) {
      expect(configurationOf(environment)).not.toBeNull();
    }
  });

  it('puts real customer data in exactly one of them', () => {
    // It is what makes production's rules different from every other
    // environment's.
    const withRealData = ENVIRONMENT_CONFIGURATIONS.filter((c) => c.realData);
    expect(withRealData).toHaveLength(1);
    expect(withRealData[0]?.environment).toBe('production');
    expect(holdsRealData('staging')).toBe(false);
  });

  it('uses live providers only in production', () => {
    expect(configurationOf('production')?.providers).toBe('live');
    expect(configurationOf('staging')?.providers).toBe('sandbox');
    expect(configurationOf('local')?.providers).toBe('stub');
  });

  it('requires approval only for production', () => {
    expect(configurationOf('production')?.requiresApproval).toBe(true);
    expect(configurationOf('staging')?.requiresApproval).toBe(false);
  });

  it('rejects anything else', () => {
    expect(isDeploymentEnvironment('prod')).toBe(false);
    expect(isDeploymentEnvironment('Production')).toBe(false);
  });

  it('is frozen through', () => {
    expect(Object.isFrozen(ENVIRONMENT_CONFIGURATIONS)).toBe(true);
    expect(Object.isFrozen(ENVIRONMENT_CONFIGURATIONS[0])).toBe(true);
  });
});

// ── Releases ────────────────────────────────────────────────────────────────

describe('releases', () => {
  it('build when well-formed and freeze through', () => {
    const built = createRelease(release(), NOW);

    expect(Object.isFrozen(built)).toBe(true);
    expect(Object.isFrozen(built.migrations)).toBe(true);
  });

  it('refuse a tag where a digest belongs', () => {
    // A tag is a mutable pointer, and during an incident which code is running
    // is the one thing that must not be ambiguous.
    for (const artifactDigest of ['latest', 'v1.4.2', 'registry/app:latest', 'sha256:short']) {
      expect(codeOf(() => assertValidRelease(release({ artifactDigest }), NOW))).toBe(
        'InvalidReleaseVersion',
      );
    }
  });

  it('refuse a branch where a commit belongs', () => {
    expect(codeOf(() => assertValidRelease(release({ commitSha: 'main' }), NOW))).toBe(
      'InvalidReleaseVersion',
    );
  });

  it('refuse a version that is not semantic', () => {
    for (const version of ['1.4', 'v1.4.2', 'latest', '']) {
      expect(codeOf(() => assertValidRelease(release({ version }), NOW))).toBe(
        'InvalidReleaseVersion',
      );
    }
  });

  it('accept a pre-release version', () => {
    expect(codeOf(() => assertValidRelease(release({ version: '1.4.2-rc.1' }), NOW))).toBeNull();
  });

  it('refuse one cut in the future', () => {
    expect(
      codeOf(() => assertValidRelease(release({ createdAt: '2027-01-01T00:00:00.000Z' }), NOW)),
    ).toBe('FutureReleaseTimestamp');
  });

  it('refuse a contract phase with no migrations', () => {
    // A phase claimed but not taken.
    expect(
      codeOf(() =>
        assertValidRelease(release({ migrationPhase: 'contract', migrations: [] }), NOW),
      ),
    ).toBe('InvalidReleaseVersion');
  });

  it('refuse phase `none` while carrying migrations', () => {
    // Mislabelling would let a contract migration ship as if reversible.
    expect(codeOf(() => assertValidRelease(release({ migrationPhase: 'none' }), NOW))).toBe(
      'InvalidReleaseVersion',
    );
  });

  it('refuse a duplicated migration', () => {
    expect(
      codeOf(() => assertValidRelease(release({ migrations: ['0026_add', '0026_add'] }), NOW)),
    ).toBe('InvalidReleaseVersion');
  });

  it('name the expand/contract phases', () => {
    expect(MIGRATION_PHASES).toEqual(['expand', 'backfill', 'contract', 'none']);
  });
});

// ── Deploy order ────────────────────────────────────────────────────────────

describe('the deploy order is a rule', () => {
  it('is migrations, workers, API, web', () => {
    expect(DEPLOYMENT_TARGETS).toEqual(['migrations', 'workers', 'api', 'web']);
  });

  it('accepts the correct order and any prefix of it', () => {
    expect(isCorrectlyOrdered(['migrations', 'workers', 'api', 'web'])).toBe(true);
    expect(isCorrectlyOrdered(['workers', 'api'])).toBe(true);
    expect(isCorrectlyOrdered(['api'])).toBe(true);
  });

  it('refuses the API before the workers', () => {
    // Workers must be able to handle any job the new API can enqueue.
    expect(isCorrectlyOrdered(['api', 'workers'])).toBe(false);
  });

  it('refuses the web before the API', () => {
    // So no user sees a UI referencing an endpoint that is not yet live.
    expect(isCorrectlyOrdered(['web', 'api'])).toBe(false);
  });

  it('sorts a jumbled set into the required order', () => {
    expect(orderTargets(['web', 'migrations', 'api', 'workers'])).toEqual([
      'migrations',
      'workers',
      'api',
      'web',
    ]);
  });
});

// ── Deployment plans ────────────────────────────────────────────────────────

describe('deployment plans', () => {
  it('build when well-formed and freeze through', () => {
    const built = createDeploymentPlan(plan());

    expect(Object.isFrozen(built)).toBe(true);
    expect(Object.isFrozen(built.targets)).toBe(true);
  });

  it('refuse an out-of-order target list', () => {
    expect(codeOf(() => assertValidDeploymentPlan(plan({ targets: ['api', 'workers'] })))).toBe(
      'InvalidDeployOrder',
    );
  });

  it('refuse a duplicated target', () => {
    expect(codeOf(() => assertValidDeploymentPlan(plan({ targets: ['api', 'api'] })))).toBe(
      'InvalidDeployOrder',
    );
  });

  it('refuse an unapproved production deployment', () => {
    expect(codeOf(() => assertValidDeploymentPlan(plan({ approved: false })))).toBe(
      'InvalidEnvironment',
    );
  });

  it('accept an unapproved staging deployment', () => {
    // Promotion is automatic for a green, non-breaking, non-production change.
    expect(
      codeOf(() => assertValidDeploymentPlan(plan({ environment: 'staging', approved: false }))),
    ).toBeNull();
  });

  it('refuse a strategy that takes production down at once', () => {
    // `recreate` has no rollback shorter than a redeploy, and §10 targets ten
    // minutes.
    expect(codeOf(() => assertValidDeploymentPlan(plan({ strategy: 'recreate' })))).toBe(
      'UnsupportedStrategy',
    );
    expect(ZERO_DOWNTIME_STRATEGIES).toEqual(['rolling', 'canary', 'blue_green']);
  });

  it('accept `recreate` outside production', () => {
    expect(
      codeOf(() =>
        assertValidDeploymentPlan(
          plan({ environment: 'local', strategy: 'recreate', approved: false, soakMinutes: 0 }),
        ),
      ),
    ).toBeNull();
  });

  it('refuse a staging soak shorter than the document’s', () => {
    // The soak catches an error-rate or queue-depth regression a smoke test
    // does not.
    expect(
      codeOf(() =>
        assertValidDeploymentPlan(
          plan({ environment: 'staging', approved: false, soakMinutes: 5 }),
        ),
      ),
    ).toBe('InvalidReleaseVersion');
    expect(STAGING_SOAK_MINUTES).toBe(30);
  });

  it('refuse an unknown strategy', () => {
    expect(codeOf(() => assertValidDeploymentPlan(plan({ strategy: 'yolo' as 'rolling' })))).toBe(
      'UnsupportedStrategy',
    );
    expect(RELEASE_STRATEGIES).toEqual(['rolling', 'canary', 'blue_green', 'recreate']);
  });

  it('refuse a plan with no target', () => {
    expect(codeOf(() => assertValidDeploymentPlan(plan({ targets: [] })))).toBe(
      'InvalidDeployOrder',
    );
  });
});

// ── The state machine ───────────────────────────────────────────────────────

describe('the deployment state machine is §10’s', () => {
  it('names the six states', () => {
    expect(DEPLOYMENT_STATES).toEqual([
      'planned',
      'deploying',
      'verifying',
      'live',
      'rolling_back',
      'previous_live',
    ]);
  });

  it('transcribes the document’s edges', () => {
    expect(canTransition('planned', 'start')).toBe(true);
    expect(canTransition('deploying', 'instances_healthy')).toBe(true);
    expect(canTransition('deploying', 'health_checks_failed')).toBe(true);
    expect(canTransition('verifying', 'verification_passed')).toBe(true);
    expect(canTransition('verifying', 'verification_failed')).toBe(true);
    expect(canTransition('rolling_back', 'previous_digest_redeployed')).toBe(true);
  });

  it('gives `live` an edge out, because §10 does', () => {
    // A deploy that looked fine can still burn its budget half an hour later.
    expect(canTransition('live', 'slo_burn')).toBe(true);
    expect(assertTransitionAllowed('live', 'slo_burn')).toBe('rolling_back');
  });

  it('has no edge the document does not', () => {
    expect(canTransition('planned', 'verification_passed')).toBe(false);
    expect(canTransition('deploying', 'slo_burn')).toBe(false);
    expect(canTransition('previous_live', 'start')).toBe(false);
  });

  it('leaves `previous_live` terminal by absence', () => {
    expect(transitionsFrom('previous_live')).toEqual([]);
  });

  it('refuses an illegal transition by name', () => {
    expect(codeOf(() => assertTransitionAllowed('planned', 'slo_burn'))).toBe(
      'IncompatibleRollback',
    );
  });

  it('only ever names real states', () => {
    for (const transition of DEPLOYMENT_TRANSITIONS) {
      const rule = DEPLOYMENT_TRANSITION_RULES[transition];
      expect(DEPLOYMENT_STATES).toContain(rule.to);
      for (const from of rule.from) expect(DEPLOYMENT_STATES).toContain(from);
    }
  });
});

describe('deployments', () => {
  it('build when well-formed', () => {
    expect(Object.isFrozen(createDeployment(deployment()))).toBe(true);
  });

  it('require a completion once at rest', () => {
    // Without it no deploy marker can be placed on a dashboard.
    for (const state of ['live', 'previous_live'] as const) {
      expect(codeOf(() => assertValidDeployment(deployment({ state, completedAt: null })))).toBe(
        'IncompatibleRollback',
      );
    }
  });

  it('refuse a completion while still moving', () => {
    for (const state of ['deploying', 'verifying', 'rolling_back'] as const) {
      expect(codeOf(() => assertValidDeployment(deployment({ state })))).toBe(
        'IncompatibleRollback',
      );
    }
  });

  it('refuse one that finished before it started', () => {
    expect(
      codeOf(() => assertValidDeployment(deployment({ completedAt: '2026-03-20T10:00:00.000Z' }))),
    ).toBe('IncompatibleRollback');
  });
});

// ── Rollback ────────────────────────────────────────────────────────────────

describe('rollback plans', () => {
  it('build when the release can be rolled back', () => {
    expect(Object.isFrozen(createRollbackPlan(rollback(), deployment(), release()))).toBe(true);
  });

  it('refuse a rollback of a contract migration', () => {
    // The old code cannot read the current schema; §10 escalates rather than
    // attempting it.
    expect(
      codeOf(() =>
        assertValidRollbackPlan(
          rollback(),
          deployment(),
          release({ migrationPhase: 'contract', migrations: ['0027_drop'] }),
        ),
      ),
    ).toBe('IncompatibleRollback');
  });

  it('say what to do instead', () => {
    let message = '';
    try {
      assertValidRollbackPlan(
        rollback(),
        deployment(),
        release({ migrationPhase: 'contract', migrations: ['0027_drop'] }),
      );
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('Recover forward with a hotfix');
  });

  it('refuse a target that is the digest already running', () => {
    // Redeploying the same artifact changes nothing and costs the ten minutes
    // a real rollback had.
    expect(
      codeOf(() =>
        assertValidRollbackPlan(rollback({ previousDigest: DIGEST }), deployment(), release()),
      ),
    ).toBe('IncompatibleRollback');
  });

  it('refuse a tag as the rollback target', () => {
    expect(
      codeOf(() =>
        assertValidRollbackPlan(rollback({ previousDigest: 'previous' }), deployment(), release()),
      ),
    ).toBe('IncompatibleRollback');
  });

  it('refuse an estimate past the ten-minute target', () => {
    expect(
      codeOf(() =>
        assertValidRollbackPlan(rollback({ estimatedMinutes: 45 }), deployment(), release()),
      ),
    ).toBe('IncompatibleRollback');
    expect(ROLLBACK_TARGET_MINUTES).toBe(10);
  });

  it('refuse a plan for a different deployment', () => {
    expect(
      codeOf(() =>
        assertValidRollbackPlan(rollback({ deploymentId: 'other' }), deployment(), release()),
      ),
    ).toBe('IncompatibleRollback');
  });

  it('answer whether a rollback is possible at all', () => {
    expect(isRollbackable(deployment(), release())).toBe(true);
    expect(
      isRollbackable(deployment(), release({ migrationPhase: 'contract', migrations: ['x'] })),
    ).toBe(false);
  });
});

// ── Readiness ───────────────────────────────────────────────────────────────

describe('production readiness', () => {
  const allChecks = (passed = true): ReadinessCheck[] =>
    READINESS_CHECKS.map((check) => ({ check, passed, detail: null }));

  it('names eight gates, each owned elsewhere', () => {
    expect(READINESS_CHECKS).toHaveLength(8);
    expect(READINESS_CHECKS).toContain('recent_verified_backup');
    expect(READINESS_CHECKS).toContain('no_critical_findings');
    expect(READINESS_CHECKS).toContain('audit_chain_intact');
  });

  it('requires every gate for production and only health elsewhere', () => {
    // Staging exists to find problems; a gate blocking it on a Critical finding
    // would stop the deployment that fixes it.
    expect(requiredChecks('production')).toHaveLength(8);
    expect(requiredChecks('staging')).toEqual(['dependencies_healthy']);
  });

  it('derives `ready` rather than trusting it', () => {
    const report = buildReadinessReport({
      reportId: 'readiness-001',
      environment: 'production',
      releaseId: 'release-2026-03-20',
      checks: allChecks(),
      generatedAt: NOW,
    });

    expect(report.ready).toBe(true);
    expect(Object.isFrozen(report)).toBe(true);
  });

  it('is not ready when any required gate failed', () => {
    const report = buildReadinessReport({
      reportId: 'readiness-001',
      environment: 'production',
      releaseId: 'release-2026-03-20',
      checks: allChecks().map((check) =>
        check.check === 'recent_verified_backup' ? { ...check, passed: false } : check,
      ),
      generatedAt: NOW,
    });

    expect(report.ready).toBe(false);
    expect(blockingChecks(report)).toEqual(['recent_verified_backup']);
  });

  it('refuses a report that omits a required gate', () => {
    // An unreported gate is an unrun one.
    expect(
      codeOf(() =>
        buildReadinessReport({
          reportId: 'readiness-001',
          environment: 'production',
          releaseId: 'r',
          checks: [{ check: 'dependencies_healthy', passed: true, detail: null }],
          generatedAt: NOW,
        }),
      ),
    ).toBe('InconsistentReadiness');
  });

  it('refuses a duplicated gate', () => {
    expect(
      codeOf(() =>
        buildReadinessReport({
          reportId: 'readiness-001',
          environment: 'staging',
          releaseId: 'r',
          checks: [
            { check: 'dependencies_healthy', passed: true, detail: null },
            { check: 'dependencies_healthy', passed: false, detail: null },
          ],
          generatedAt: NOW,
        }),
      ),
    ).toBe('InconsistentReadiness');
  });

  it('refuses a detail wide enough for a stack trace', () => {
    expect(
      codeOf(() =>
        buildReadinessReport({
          reportId: 'readiness-001',
          environment: 'staging',
          releaseId: 'r',
          checks: [{ check: 'dependencies_healthy', passed: true, detail: 'x'.repeat(201) }],
          generatedAt: NOW,
        }),
      ),
    ).toBe('InconsistentReadiness');
  });
});

// ── Projections ─────────────────────────────────────────────────────────────

describe('the health projection', () => {
  it('folds to the worst status', () => {
    expect(
      projectHealth([
        { component: 'database', status: 'healthy' },
        { component: 'redis', status: 'degraded' },
      ]).status,
    ).toBe('degraded');

    expect(
      projectHealth([
        { component: 'database', status: 'unhealthy' },
        { component: 'redis', status: 'degraded' },
      ]).status,
    ).toBe('unhealthy');
  });

  it('is ready to serve only when every readiness component is healthy', () => {
    expect(
      projectHealth([
        { component: 'database', status: 'healthy' },
        { component: 'redis', status: 'healthy' },
        { component: 'queue', status: 'healthy' },
      ]).readyToServe,
    ).toBe(true);

    expect(
      projectHealth([
        { component: 'database', status: 'healthy' },
        { component: 'redis', status: 'degraded' },
        { component: 'queue', status: 'healthy' },
      ]).readyToServe,
    ).toBe(false);
  });

  it('is not ready when a readiness component is missing entirely', () => {
    expect(projectHealth([{ component: 'database', status: 'healthy' }]).readyToServe).toBe(false);
  });

  it('names what is degraded', () => {
    expect(
      projectHealth([
        { component: 'database', status: 'healthy' },
        { component: 'ai_providers', status: 'degraded' },
      ]).degraded,
    ).toEqual(['ai_providers']);
  });

  it('refuses a malformed status', () => {
    // A malformed state flowing through a fold reads as healthy, and an outage
    // reads green.
    expect(
      codeOf(() => projectHealth([{ component: 'database', status: 'ok' as 'healthy' }])),
    ).toBe('InconsistentReadiness');
  });

  it('refuses a component nobody declared', () => {
    expect(
      codeOf(() => projectHealth([{ component: 'cache' as 'redis', status: 'healthy' }])),
    ).toBe('InconsistentReadiness');
  });

  it('is frozen', () => {
    expect(Object.isFrozen(projectHealth([]))).toBe(true);
  });
});

describe('the environment projection', () => {
  const health = () => projectHealth([{ component: 'database', status: 'healthy' }]);

  it('names what is live', () => {
    const projection = projectEnvironment({
      environment: 'production',
      deployments: [deployment()],
      health: health(),
    });

    expect(projection.liveReleaseId).toBe('release-2026-03-20');
    expect(projection.liveSince).toBe('2026-03-20T11:12:00.000Z');
    expect(projection.realData).toBe(true);
  });

  it('does not count a rolled-back deployment as live', () => {
    const projection = projectEnvironment({
      environment: 'production',
      deployments: [deployment({ state: 'previous_live' })],
      health: health(),
    });

    expect(projection.liveReleaseId).toBeNull();
  });

  it('names a deployment still in flight', () => {
    const projection = projectEnvironment({
      environment: 'production',
      deployments: [deployment({ state: 'verifying', completedAt: null })],
      health: health(),
    });

    expect(projection.inFlightDeploymentId).toBe('deploy-001');
  });

  it('ignores another environment’s deployments', () => {
    const projection = projectEnvironment({
      environment: 'staging',
      deployments: [deployment()],
      health: health(),
    });

    expect(projection.liveReleaseId).toBeNull();
  });

  it('takes the most recent live deployment', () => {
    const projection = projectEnvironment({
      environment: 'production',
      deployments: [
        deployment({
          deploymentId: 'old',
          releaseId: 'r-old',
          completedAt: '2026-03-01T00:00:00.000Z',
        }),
        deployment({ deploymentId: 'new', releaseId: 'r-new' }),
      ],
      health: health(),
    });

    expect(projection.liveReleaseId).toBe('r-new');
  });

  it('is frozen', () => {
    expect(
      Object.isFrozen(
        projectEnvironment({ environment: 'production', deployments: [], health: health() }),
      ),
    ).toBe(true);
  });
});

describe('the deployment report', () => {
  it('measures the duration and reports success', () => {
    const report = buildDeploymentReport({
      deployment: deployment(),
      plan: plan(),
      readiness: null,
      generatedAt: NOW,
    });

    expect(report.durationSeconds).toBe(720);
    expect(report.succeeded).toBe(true);
    expect(report.targets).toEqual(['migrations', 'workers', 'api', 'web']);
  });

  it('does not call a rolled-back deployment a success', () => {
    expect(
      buildDeploymentReport({
        deployment: deployment({ state: 'previous_live' }),
        plan: plan(),
        readiness: null,
        generatedAt: NOW,
      }).succeeded,
    ).toBe(false);
  });

  it('reports a null duration while still moving', () => {
    expect(
      buildDeploymentReport({
        deployment: deployment({ state: 'verifying', completedAt: null }),
        plan: plan(),
        readiness: null,
        generatedAt: NOW,
      }).durationSeconds,
    ).toBeNull();
  });
});

// ── Maintenance ─────────────────────────────────────────────────────────────

describe('maintenance windows', () => {
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

  it('build when well-formed and freeze', () => {
    expect(Object.isFrozen(createMaintenanceWindow(window(), NOW))).toBe(true);
  });

  it('name the three modes', () => {
    expect(MAINTENANCE_MODES).toEqual(['off', 'read_only', 'full']);
    expect(blocksWrites('read_only')).toBe(true);
    expect(blocksReads('read_only')).toBe(false);
    expect(blocksReads('full')).toBe(true);
    expect(blocksWrites('off')).toBe(false);
  });

  it('refuse a window in mode `off`', () => {
    // Declaring one would put a maintenance banner on a platform that is up.
    expect(codeOf(() => assertValidMaintenanceWindow(window({ mode: 'off' }), NOW))).toBe(
      'InvalidMaintenanceWindow',
    );
  });

  it('refuse one that ends before it begins', () => {
    expect(
      codeOf(() =>
        assertValidMaintenanceWindow(window({ endsAt: '2026-03-21T01:00:00.000Z' }), NOW),
      ),
    ).toBe('InvalidMaintenanceWindow');
  });

  it('refuse one longer than the limit', () => {
    // Longer than that is an outage with a nicer name.
    expect(
      codeOf(() =>
        assertValidMaintenanceWindow(window({ endsAt: '2026-03-22T02:00:00.000Z' }), NOW),
      ),
    ).toBe('InvalidMaintenanceWindow');
    expect(MAX_WINDOW_HOURS).toBe(8);
  });

  it('refuse one already over', () => {
    expect(
      codeOf(() =>
        assertValidMaintenanceWindow(
          window({ startsAt: '2026-03-01T00:00:00.000Z', endsAt: '2026-03-01T02:00:00.000Z' }),
          NOW,
        ),
      ),
    ).toBe('InvalidMaintenanceWindow');
  });

  it('are half-open, so adjacent windows never overlap', () => {
    const w = createMaintenanceWindow(window(), NOW);

    expect(isWindowActive(w, '2026-03-21T02:00:00.000Z')).toBe(true);
    expect(isWindowActive(w, '2026-03-21T03:59:59.999Z')).toBe(true);
    expect(isWindowActive(w, '2026-03-21T04:00:00.000Z')).toBe(false);
  });

  it('take the strictest mode when two overlap', () => {
    // Taking the looser would let a read through during a restore.
    const windows = [
      createMaintenanceWindow(window(), NOW),
      createMaintenanceWindow(window({ windowId: 'window-002', mode: 'full' }), NOW),
    ];

    expect(modeAt(windows, 'production', '2026-03-21T03:00:00.000Z')).toBe('full');
    expect(modeAt(windows, 'production', '2026-03-21T05:00:00.000Z')).toBe('off');
    expect(modeAt(windows, 'staging', '2026-03-21T03:00:00.000Z')).toBe('off');
  });
});

// ── Runbooks ────────────────────────────────────────────────────────────────

describe('runbooks', () => {
  const runbook = (overrides: Partial<OperationalRunbook> = {}): OperationalRunbook => ({
    runbookId: 'runbook-rollback',
    title: 'Roll back a production release.',
    scenario: 'rollback',
    steps: [
      {
        order: 1,
        action: 'Identify the previous digest.',
        verification: 'It differs from the live one.',
      },
      {
        order: 2,
        action: 'Redeploy the previous digest.',
        verification: 'Instances report healthy.',
      },
    ],
    owner: 'ops.platform',
    lastRehearsedAt: '2026-02-01T00:00:00.000Z',
    updatedAt: NOW,
    ...overrides,
  });

  it('build when well-formed and freeze through', () => {
    const built = createRunbook(runbook(), NOW);

    expect(Object.isFrozen(built)).toBe(true);
    expect(Object.isFrozen(built.steps)).toBe(true);
    expect(Object.isFrozen(built.steps[0])).toBe(true);
  });

  it('refuse one with no steps', () => {
    // During an incident that is worse than nothing, because it looks like
    // preparation.
    expect(codeOf(() => assertValidRunbook(runbook({ steps: [] }), NOW))).toBe('MalformedRunbook');
  });

  it('refuse a step with no verification', () => {
    // A step nobody can verify is one nobody can safely skip or repeat.
    expect(
      codeOf(() =>
        assertValidRunbook(
          runbook({ steps: [{ order: 1, action: 'Do the thing.', verification: '' }] }),
          NOW,
        ),
      ),
    ).toBe('MissingField');
  });

  it('refuse a gap in the numbering', () => {
    // Whoever follows it under pressure will wonder what they skipped.
    expect(
      codeOf(() =>
        assertValidRunbook(
          runbook({
            steps: [
              { order: 1, action: 'A', verification: 'a' },
              { order: 3, action: 'C', verification: 'c' },
            ],
          }),
          NOW,
        ),
      ),
    ).toBe('MalformedRunbook');
  });

  it('refuse two steps with the same number', () => {
    expect(
      codeOf(() =>
        assertValidRunbook(
          runbook({
            steps: [
              { order: 1, action: 'A', verification: 'a' },
              { order: 1, action: 'B', verification: 'b' },
            ],
          }),
          NOW,
        ),
      ),
    ).toBe('MalformedRunbook');
  });

  it('refuse more steps than anybody finishes under pressure', () => {
    const steps = Array.from({ length: MAX_RUNBOOK_STEPS + 1 }, (_, index) => ({
      order: index + 1,
      action: 'A',
      verification: 'a',
    }));

    expect(codeOf(() => assertValidRunbook(runbook({ steps }), NOW))).toBe('MalformedRunbook');
  });

  it('sort the steps into order', () => {
    const built = createRunbook(
      runbook({
        steps: [
          { order: 2, action: 'B', verification: 'b' },
          { order: 1, action: 'A', verification: 'a' },
        ],
      }),
      NOW,
    );

    expect(built.steps.map((step) => step.order)).toEqual([1, 2]);
  });

  it('refuse a rehearsal in the future', () => {
    expect(
      codeOf(() =>
        assertValidRunbook(runbook({ lastRehearsedAt: '2027-01-01T00:00:00.000Z' }), NOW),
      ),
    ).toBe('MalformedRunbook');
  });

  it('call an unrehearsed runbook unrehearsed', () => {
    // An unrehearsed runbook is a document, not a capability.
    expect(isRehearsed(runbook({ lastRehearsedAt: null }), NOW)).toBe(false);
    expect(isRehearsed(runbook(), NOW)).toBe(true);
    expect(isRehearsed(runbook({ lastRehearsedAt: '2025-01-01T00:00:00.000Z' }), NOW)).toBe(false);
  });
});

// ── Shared assertions ───────────────────────────────────────────────────────

describe('identifiers', () => {
  it('accept a dotted or hyphenated identifier', () => {
    expect(assertIdentifier('release-2026-03-20', 'x')).toBe('release-2026-03-20');
    expect(assertIdentifier('ci.pipeline', 'x')).toBe('ci.pipeline');
  });

  it('refuse a hostname, a URL or free text', () => {
    for (const bad of ['api.internal:8080', 'https://ci/build/1', 'Release 1', '/var/app']) {
      expect(codeOf(() => assertIdentifier(bad, 'x'))).toBe('InvalidDeploymentId');
    }
  });

  it('refuse one past the limit', () => {
    expect(codeOf(() => assertIdentifier('a'.repeat(MAX_IDENTIFIER_LENGTH + 1), 'x'))).toBe(
      'InvalidDeploymentId',
    );
  });
});

describe('instants', () => {
  it('accept a UTC ISO-8601 instant, with or without milliseconds', () => {
    expect(assertInstant(NOW, 'at', 'MissingField')).toBe(NOW);
    expect(assertInstant('2026-03-20T12:00:00Z', 'at', 'MissingField')).toBe(
      '2026-03-20T12:00:00Z',
    );
  });

  it('refuse a local-time string, an offset or a date alone', () => {
    // A local-time string names a different moment depending on where it is
    // read, and a deploy marker an hour out is one nobody can line up against
    // an incident.
    for (const bad of [
      '2026-03-20 12:00:00',
      '2026-03-20T12:00:00+01:00',
      '2026-03-20',
      17,
      null,
    ]) {
      expect(codeOf(() => assertInstant(bad, 'at', 'FutureReleaseTimestamp'))).toBe(
        'FutureReleaseTimestamp',
      );
    }
  });

  it('refuse one that is shaped right but is not a real moment', () => {
    // The shape check passes and the parse does not. February 31st is not one
    // of these — V8 rolls it forward to March — but a thirteenth month is.
    for (const bad of [
      '2026-13-01T00:00:00.000Z',
      '2026-01-32T00:00:00.000Z',
      '2026-01-01T25:00:00.000Z',
    ]) {
      expect(codeOf(() => assertInstant(bad, 'at', 'MissingField'))).toBe('MissingField');
    }
  });

  it('carries the caller’s code, so each module keeps its own taxonomy', () => {
    expect(codeOf(() => assertInstant('nope', 'at', 'InvalidMaintenanceWindow'))).toBe(
      'InvalidMaintenanceWindow',
    );
  });
});

describe('text', () => {
  it('refuses a field wide enough to hold a stack trace', () => {
    expect(codeOf(() => assertText('x'.repeat(MAX_TEXT_LENGTH + 1), 'reason', 'why.'))).toBe(
      'MalformedRunbook',
    );
  });

  it('refuses an empty or absent one', () => {
    for (const bad of ['', '   ', undefined, 42]) {
      expect(codeOf(() => assertText(bad, 'reason', 'why.'))).toBe('MissingField');
    }
  });
});

// ── Malformed input is refused everywhere it can arrive ─────────────────────

describe('a value outside its vocabulary is refused wherever it arrives', () => {
  it('refuses an unknown migration phase on a release', () => {
    expect(
      codeOf(() => assertValidRelease(release({ migrationPhase: 'drop' as 'expand' }), NOW)),
    ).toBe('InvalidReleaseVersion');
  });

  it('refuses an unknown environment on a plan, a deployment and a window', () => {
    expect(
      codeOf(() => assertValidDeploymentPlan(plan({ environment: 'prod' as 'staging' }))),
    ).toBe('InvalidEnvironment');
    expect(
      codeOf(() => assertValidDeployment(deployment({ environment: 'prod' as 'staging' }))),
    ).toBe('InvalidEnvironment');
    expect(
      codeOf(() =>
        assertValidMaintenanceWindow(
          {
            windowId: 'window-001',
            environment: 'prod' as 'staging',
            mode: 'read_only',
            startsAt: '2026-03-21T02:00:00.000Z',
            endsAt: '2026-03-21T04:00:00.000Z',
            reason: 'Drill.',
            declaredBy: 'ops.oncall',
            declaredAt: NOW,
          },
          NOW,
        ),
      ),
    ).toBe('InvalidEnvironment');
  });

  it('refuses an unknown deploy target', () => {
    expect(
      codeOf(() => assertValidDeploymentPlan(plan({ targets: ['database' as 'migrations'] }))),
    ).toBe('InvalidDeployOrder');
  });

  it('refuses an unknown environment on a readiness report', () => {
    expect(
      codeOf(() =>
        buildReadinessReport({
          reportId: 'readiness-001',
          environment: 'prod' as 'staging',
          releaseId: 'r',
          checks: [{ check: 'dependencies_healthy', passed: true, detail: null }],
          generatedAt: NOW,
        }),
      ),
    ).toBe('InvalidEnvironment');
  });

  it('refuses an unknown state on a deployment', () => {
    expect(codeOf(() => assertValidDeployment(deployment({ state: 'done' as 'live' })))).toBe(
      'IncompatibleRollback',
    );
  });

  it('refuses an unknown maintenance mode', () => {
    expect(
      codeOf(() =>
        assertValidMaintenanceWindow(
          {
            windowId: 'window-001',
            environment: 'production',
            mode: 'paused' as 'full',
            startsAt: '2026-03-21T02:00:00.000Z',
            endsAt: '2026-03-21T04:00:00.000Z',
            reason: 'Drill.',
            declaredBy: 'ops.oncall',
            declaredAt: NOW,
          },
          NOW,
        ),
      ),
    ).toBe('InvalidMaintenanceWindow');
  });

  it('refuses an unknown readiness check', () => {
    expect(
      codeOf(() =>
        buildReadinessReport({
          reportId: 'readiness-001',
          environment: 'staging',
          releaseId: 'r',
          checks: [
            { check: 'dependencies_healthy', passed: true, detail: null },
            { check: 'vibes_good' as 'audit_chain_intact', passed: true, detail: null },
          ],
          generatedAt: NOW,
        }),
      ),
    ).toBe('InconsistentReadiness');
  });

  it('refuses an unknown environment on the projection', () => {
    expect(
      codeOf(() =>
        projectEnvironment({
          environment: 'prod' as 'staging',
          deployments: [],
          health: projectHealth([]),
        }),
      ),
    ).toBe('InvalidEnvironment');
  });

  it('refuses a fractional soak and a fractional rollback estimate', () => {
    // A whole number of minutes, or the comparison against the target is
    // against something nobody agreed the units of.
    expect(codeOf(() => assertValidDeploymentPlan(plan({ soakMinutes: 1.5 })))).toBe(
      'InvalidReleaseVersion',
    );
    expect(codeOf(() => assertValidDeploymentPlan(plan({ soakMinutes: -1 })))).toBe(
      'InvalidReleaseVersion',
    );
    expect(
      codeOf(() =>
        assertValidRollbackPlan(rollback({ estimatedMinutes: 1.5 }), deployment(), release()),
      ),
    ).toBe('IncompatibleRollback');
  });

  it('refuses a step numbered zero or fractionally', () => {
    for (const order of [0, -1, 1.5]) {
      expect(
        codeOf(() =>
          assertValidRunbook(
            {
              runbookId: 'runbook-x',
              title: 'A runbook.',
              scenario: 'rollback',
              steps: [{ order, action: 'Do it.', verification: 'It worked.' }],
              owner: 'ops.platform',
              lastRehearsedAt: null,
              updatedAt: NOW,
            },
            NOW,
          ),
        ),
      ).toBe('MalformedRunbook');
    }
  });

  it('refuses a report that claims not-ready with everything passing', () => {
    // `ready` is derived, so the only way to reach the mismatch is to hand
    // `assertValidReadinessReport` a report somebody else built.
    expect(
      codeOf(() =>
        assertValidReadinessReport({
          reportId: 'readiness-001',
          environment: 'staging',
          releaseId: 'r',
          checks: [{ check: 'dependencies_healthy', passed: true, detail: null }],
          ready: false,
          generatedAt: NOW,
        }),
      ),
    ).toBe('InconsistentReadiness');
  });

  it('refuses a report that claims ready with a gate failing', () => {
    expect(
      codeOf(() =>
        assertValidReadinessReport({
          reportId: 'readiness-001',
          environment: 'staging',
          releaseId: 'r',
          checks: [{ check: 'dependencies_healthy', passed: false, detail: null }],
          ready: true,
          generatedAt: NOW,
        }),
      ),
    ).toBe('InconsistentReadiness');
  });
});
