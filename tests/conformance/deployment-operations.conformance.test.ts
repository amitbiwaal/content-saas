/**
 * The deployment layer against the process it describes.
 *
 * ── What only this file can check ───────────────────────────────────────────
 *
 * 1. IT DESCRIBES AND NEVER PERFORMS. No shell, no Docker, no Kubernetes, no
 *    Terraform, no Helm, no cloud SDK, no CI system, no HTTP, no filesystem, no
 *    timer, no global. A module that could perform a deployment would make
 *    `14-operations/deployment.md` §3.2's manual approval and §Security's audit
 *    requirement advisory rather than structural.
 *
 * 2. THE ENVIRONMENTS, THE DEPLOY ORDER AND THE STATE MACHINE ARE THE
 *    DOCUMENT'S. Four environments, four ordered targets, seven edges —
 *    transcribed, and asserted against the file itself so a later edit to
 *    either has to change both.
 *
 * 3. A CONTRACT MIGRATION MAKES ROLLBACK IMPOSSIBLE, and the refusal names
 *    §10's escalation rather than being discovered stuck halfway.
 *
 * 4. REPOSITORY INTERFACES ONLY. No SQL, no ORM, no driver — and no method on
 *    either port that could deploy, apply, scale or roll anything back.
 *
 * 5. THE PACKAGE STAYS ZERO-DEPENDENCY. Every import in the layer is relative;
 *    the audit bridge is structurally typed rather than imported.
 *
 * 6. THE DEVIATIONS, recorded so they cannot be forgotten.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  assertValidDeploymentPlan,
  assertValidRelease,
  assertValidRollbackPlan,
  blockingChecks,
  blocksReads,
  blocksRollback,
  blocksWrites,
  buildReadinessReport,
  canDeploymentTransition,
  configurationOf,
  createDeploymentService,
  createMaintenanceWindow,
  createProductionOperationsService,
  createRelease,
  createRunbook,
  DEPLOYMENT_ACTIONS,
  DEPLOYMENT_ENVIRONMENTS,
  DEPLOYMENT_STATES,
  DEPLOYMENT_TARGETS,
  DEPLOYMENT_TRANSITION_RULES,
  DEPLOYMENT_TRANSITIONS,
  DeploymentError,
  ENVIRONMENT_CONFIGURATIONS,
  holdsRealData,
  isCorrectlyOrdered,
  isRollbackable,
  MAINTENANCE_MODES,
  MANDATORY_FOR_PRODUCTION,
  MIGRATION_PHASES,
  projectEnvironment,
  projectHealth,
  READINESS_CHECKS,
  RELEASE_STRATEGIES,
  ROLLBACK_TARGET_MINUTES,
  STAGING_SOAK_MINUTES,
  toDeploymentAuditEvent,
  ZERO_DOWNTIME_STRATEGIES,
  type Deployment,
  type DeploymentPlan,
  type DeploymentRepository,
  type OperationsRepository,
  type ReadinessCheck,
  type Release,
  type RollbackPlan,
} from '@contentos/observability';
import { describe, expect, it } from 'vitest';

const deploymentDir = new URL('../../packages/observability/src/deployment/', import.meta.url);

/** Source with comments stripped, so prose never satisfies a structural check. */
const codeOf = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, deploymentDir)), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

const rawOf = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, deploymentDir)), 'utf8');

const doc = readFileSync(
  fileURLToPath(new URL('../../contentos-docs/14-operations/deployment.md', import.meta.url)),
  'utf8',
);

/** Every module this increment added. */
const MODULES = [
  'errors.ts',
  'release.ts',
  'deployment.ts',
  'readiness.ts',
  'operations.ts',
  'repository.ts',
  'service.ts',
] as const;

const ALL_CODE = MODULES.map(codeOf).join('\n');

const NOW = '2026-03-20T12:00:00.000Z';
const SHA = 'a'.repeat(40);
const DIGEST = `sha256:${'b'.repeat(64)}`;
const PREVIOUS = `sha256:${'c'.repeat(64)}`;

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

// ────────────────────────────────────────────────────────────────────────────
// 1. It executes nothing
// ────────────────────────────────────────────────────────────────────────────

describe('the layer performs no deployment', () => {
  it('runs no shell command', () => {
    // A module that could shell out could deploy, and §3.2's approval would be
    // a convention rather than a structure.
    for (const forbidden of [
      /\bchild_process\b/,
      /\bexecSync\b/,
      /\bexecFile\b/,
      /\bspawnSync\b/,
      /\bspawn\s*\(/,
      /\bnode:child_process\b/,
    ]) {
      expect(ALL_CODE).not.toMatch(forbidden);
    }
  });

  it('reaches no orchestrator or infrastructure tool', () => {
    for (const forbidden of [/docker/i, /kubernetes/i, /kubectl/i, /terraform/i, /\bhelm\b/i]) {
      expect(ALL_CODE).not.toMatch(forbidden);
    }
  });

  it('imports no cloud SDK', () => {
    for (const forbidden of [/aws-sdk/i, /@azure\//i, /google-cloud/i, /\bgcloud\b/i]) {
      expect(ALL_CODE).not.toMatch(forbidden);
    }
  });

  it('reaches no CI system', () => {
    for (const forbidden of [/octokit/i, /@actions\//i, /github\.com/i, /workflow_dispatch/i]) {
      expect(ALL_CODE).not.toMatch(forbidden);
    }
  });

  it('makes no network call', () => {
    for (const forbidden of [
      /\bfetch\s*\(/,
      /\baxios\b/,
      /\bnode:https?\b/,
      /\bXMLHttpRequest\b/,
      /\bWebSocket\b/,
    ]) {
      expect(ALL_CODE).not.toMatch(forbidden);
    }
  });

  it('touches no filesystem', () => {
    for (const forbidden of [
      /\bnode:fs\b/,
      /\breadFileSync\b/,
      /\bwriteFileSync\b/,
      /\bnode:path\b/,
    ]) {
      expect(ALL_CODE).not.toMatch(forbidden);
    }
  });

  it('sets no timer and schedules nothing', () => {
    // Scheduling a deploy is the deploy system's; a timer here would make this
    // layer act on its own.
    for (const forbidden of [
      /\bsetTimeout\b/,
      /\bsetInterval\b/,
      /\bsetImmediate\b/,
      /\bqueueMicrotask\b/,
      /\bcron\b/i,
    ]) {
      expect(ALL_CODE).not.toMatch(forbidden);
    }
  });

  it('reads no clock', () => {
    // Every instant is supplied, so two readers never disagree about when a
    // deploy happened. `Date.parse` of a supplied string is pure.
    expect(ALL_CODE).not.toMatch(/Date\.now\s*\(/);
    expect(ALL_CODE).not.toMatch(/new Date\s*\(/);
  });

  it('reads no environment and holds no global', () => {
    for (const forbidden of [/process\.env/, /\bglobalThis\b/, /\bprocess\.\w/]) {
      expect(ALL_CODE).not.toMatch(forbidden);
    }
  });

  it('holds no module-level mutable state', () => {
    // A singleton would make one caller's deployment visible to another's.
    for (const module of MODULES) {
      expect(codeOf(module)).not.toMatch(/^(let|var)\s/m);
    }
  });

  it('exposes no method that could execute one', () => {
    const deployments = {} as DeploymentRepository;
    const operations = {} as OperationsRepository;
    const service = createDeploymentService({ deployments });
    const ops = createProductionOperationsService({ operations, deployments });

    for (const name of ['deploy', 'apply', 'scale', 'rollback', 'restart', 'exec', 'run']) {
      expect(name in service).toBe(false);
      expect(name in ops).toBe(false);
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 2. Repository interfaces only
// ────────────────────────────────────────────────────────────────────────────

describe('the ports are interfaces and nothing else', () => {
  it('declares no class, no implementation and no driver', () => {
    const repository = codeOf('repository.ts');

    expect(repository).not.toMatch(/^export\s+(?:abstract\s+)?class\b/m);
    expect(repository).not.toMatch(/\bfunction\b/);
    expect(repository).toMatch(/export interface DeploymentRepository/);
    expect(repository).toMatch(/export interface OperationsRepository/);
  });

  it('imports only types', () => {
    // A port that imported a value could reach an implementation.
    const repository = codeOf('repository.ts');
    const imports = [...repository.matchAll(/^import\s+(\w+)/gm)].map((match) => match[1]);

    expect(imports.every((keyword) => keyword === 'type')).toBe(true);
  });

  it('writes no SQL and names no ORM', () => {
    for (const forbidden of [
      /\bSELECT\s+\w+\s+FROM\b/i,
      /\bINSERT\s+INTO\b/i,
      /\bDELETE\s+FROM\b/i,
      /\bCREATE\s+TABLE\b/i,
      /\bdrizzle\b/i,
      /\bprisma\b/i,
      /\btypeorm\b/i,
      /\bknex\b/i,
      /\bpg\b\s*from/,
    ]) {
      expect(ALL_CODE).not.toMatch(forbidden);
    }
  });

  it('has no method that could perform an operation', () => {
    // The refusal is structural: there is no `deploy` on the interface, and no
    // way to add one without changing this file.
    const repository = codeOf('repository.ts');

    for (const forbidden of [
      /^\s+deploy\s*\(/m,
      /^\s+apply\s*\(/m,
      /^\s+scale\s*\(/m,
      /^\s+rollback\s*\(/m,
      /^\s+enterMaintenance\s*\(/m,
    ]) {
      expect(repository).not.toMatch(forbidden);
    }
  });

  it('pages by keyset, never by offset', () => {
    const repository = codeOf('repository.ts');

    expect(repository).toMatch(/interface DeploymentPosition/);
    expect(repository).not.toMatch(/\boffset\b/i);
    expect(repository).not.toMatch(/\bpageNumber\b/);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 3. The environments are the document's
// ────────────────────────────────────────────────────────────────────────────

describe('the environments are §3.1’s', () => {
  it('names the four the document tabulates', () => {
    expect(DEPLOYMENT_ENVIRONMENTS).toEqual(['local', 'e2e', 'staging', 'production']);

    for (const environment of DEPLOYMENT_ENVIRONMENTS) {
      expect(doc).toContain(`\`${environment}\``);
    }
  });

  it('holds real data only where the document says customers are', () => {
    // §3.1: staging is synthetic; production is `Real`. A config claiming real
    // data in staging would put customer records somewhere with weaker controls.
    expect(doc).toMatch(/Staging deliberately holds no production data/);

    expect(ENVIRONMENT_CONFIGURATIONS.filter((c) => c.realData).map((c) => c.environment)).toEqual([
      'production',
    ]);
    for (const environment of ['local', 'e2e', 'staging'] as const) {
      expect(holdsRealData(environment)).toBe(false);
    }
  });

  it('uses live providers only in production, per the document’s table', () => {
    expect(doc).toMatch(/\| `production` \| Customers \| Real \| Live providers/);

    expect(configurationOf('production')?.providers).toBe('live');
    expect(configurationOf('staging')?.providers).toBe('sandbox');
  });

  it('requires a human only where the document does', () => {
    // §3.2: "auto for green non-breaking", "manual for schema or infra change".
    expect(doc).toMatch(/manual for schema or infra change/);

    expect(configurationOf('production')?.requiresApproval).toBe(true);
    expect(
      ENVIRONMENT_CONFIGURATIONS.filter((c) => c.requiresApproval).map((c) => c.environment),
    ).toEqual(['production']);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 4. The deploy order is the document's
// ────────────────────────────────────────────────────────────────────────────

describe('the deploy order is §3.3’s', () => {
  it('ships migrations, workers, the API, then the web', () => {
    expect(DEPLOYMENT_TARGETS).toEqual(['migrations', 'workers', 'api', 'web']);

    // The document's sequence diagram, in the order it reads.
    const sequence = doc.slice(doc.indexOf('### 3.3 Deploy order'), doc.indexOf('## 4. Inputs'));
    const positions = [
      sequence.indexOf('CI->>DB:'),
      sequence.indexOf('CI->>W:'),
      sequence.indexOf('CI->>API:'),
      sequence.indexOf('CI->>WEB:'),
    ];
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('refuses a plan that would ship the API before the workers', () => {
    expect(isCorrectlyOrdered(['api', 'workers'])).toBe(false);
    expect(() => assertValidDeploymentPlan(plan({ targets: ['api', 'workers'] }))).toThrow(
      DeploymentError,
    );
  });

  it('refuses one that would ship the web app before the API', () => {
    expect(() => assertValidDeploymentPlan(plan({ targets: ['web', 'api'] }))).toThrow(
      DeploymentError,
    );
  });

  it('carries the document’s reasons in the refusal', () => {
    // §3.3's reasons, so whoever hits this reads why rather than reordering
    // until it passes.
    let message = '';
    try {
      assertValidDeploymentPlan(plan({ targets: ['api', 'workers'] }));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('handle any job the new API can enqueue');
    expect(message).toContain('not yet live');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 5. The state machine is the document's
// ────────────────────────────────────────────────────────────────────────────

describe('the rollback state machine is §10’s', () => {
  const diagram = doc.slice(doc.indexOf('## 10. Error Handling'), doc.indexOf('## 11. Security'));

  it('has an edge for each the document draws, and no more', () => {
    const drawn = [...diagram.matchAll(/^\s*(\w+)\s*-->\s*(\w+)(?::\s*(.+))?$/gm)]
      .filter(([, from]) => from !== '[*]')
      .filter(([, , to]) => to !== '[*]');

    // Six edges in the diagram, plus `[*] --> Deploying` which this build names
    // `start` out of an explicit `planned` state.
    expect(drawn).toHaveLength(6);
    expect(DEPLOYMENT_TRANSITIONS).toHaveLength(drawn.length + 1);
  });

  it('transcribes each edge by name', () => {
    const snake = (pascal: string): string =>
      pascal.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();

    const expected: readonly (readonly [string, string])[] = [
      ['Deploying', 'Verifying'],
      ['Deploying', 'RollingBack'],
      ['Verifying', 'Live'],
      ['Verifying', 'RollingBack'],
      ['Live', 'RollingBack'],
      ['RollingBack', 'PreviousLive'],
    ];

    for (const [from, to] of expected) {
      expect(diagram).toContain(`${from} --> ${to}`);

      const edge = Object.values(DEPLOYMENT_TRANSITION_RULES).find(
        (rule) => rule.from.includes(snake(from) as never) && rule.to === snake(to),
      );
      expect(edge, `no edge ${snake(from)} → ${snake(to)}`).toBeDefined();
    }
  });

  it('gives `live` the edge out the document gives it', () => {
    // §10: "Live --> RollingBack: SLO burn alert within 30 min of deploy". A
    // machine with no edge out of `live` could not express a deploy that looked
    // fine and burned its budget half an hour later.
    expect(diagram).toMatch(/Live --> RollingBack: SLO burn alert within 30 min of deploy/);
    expect(canDeploymentTransition('live', 'slo_burn')).toBe(true);
  });

  it('names every state the diagram does', () => {
    expect(DEPLOYMENT_STATES).toEqual([
      'planned',
      'deploying',
      'verifying',
      'live',
      'rolling_back',
      'previous_live',
    ]);
  });

  it('leaves `previous_live` terminal, as the diagram does', () => {
    expect(diagram).toContain('PreviousLive --> [*]');
    expect(
      DEPLOYMENT_TRANSITIONS.filter((t) => canDeploymentTransition('previous_live', t)),
    ).toEqual([]);
  });

  it('has ONE transition table, so no caller can hit a second one', () => {
    // The service imports it rather than restating it; a second copy could
    // disagree, and the copy every caller hit would be the service's.
    const service = codeOf('service.ts');

    expect(service).toMatch(
      /import[\s\S]*?DEPLOYMENT_TRANSITION_RULES[\s\S]*?from '\.\/deployment/,
    );
    expect(service).not.toMatch(/DEPLOYMENT_TRANSITION_RULES\s*[:=]/);
    expect([...ALL_CODE.matchAll(/DEPLOYMENT_TRANSITION_RULES\s*:/g)].length).toBe(1);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 6. A contract migration makes rollback impossible
// ────────────────────────────────────────────────────────────────────────────

describe('the expand/contract asymmetry is enforced', () => {
  it('names the three phases §6 tabulates', () => {
    expect(MIGRATION_PHASES).toEqual(['expand', 'backfill', 'contract', 'none']);
    expect(doc).toMatch(/\*\*Expand\*\*/);
    expect(doc).toMatch(/Backfill/);
    expect(doc).toMatch(/\*\*Contract\*\*/);
  });

  it('blocks rollback for exactly the phase the document says it cannot undo', () => {
    // §6: "Rolling back code is trivial; rolling back a *contract* migration is
    // not."
    expect(doc).toMatch(/rolling back a \*contract\* migration is not/);

    expect(MIGRATION_PHASES.filter((phase) => blocksRollback(phase))).toEqual(['contract']);
  });

  it('refuses a rollback of a contracted release, with §10’s escalation', () => {
    expect(doc).toMatch(/Rollback impossible \(contract migration already applied\)/);
    expect(doc).toMatch(/recover forward with a hotfix/i);

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
    expect(message).toContain('last resort');
    expect(
      isRollbackable(deployment(), release({ migrationPhase: 'contract', migrations: ['x'] })),
    ).toBe(false);
  });

  it('holds the document’s ten-minute rollback target', () => {
    expect(doc).toMatch(/rollback complete within \*\*10 minutes\*\*/);
    expect(ROLLBACK_TARGET_MINUTES).toBe(10);

    expect(() =>
      assertValidRollbackPlan(rollback({ estimatedMinutes: 45 }), deployment(), release()),
    ).toThrow(DeploymentError);
  });

  it('holds the document’s thirty-minute staging soak', () => {
    expect(doc).toMatch(/30-minute soak/);
    expect(STAGING_SOAK_MINUTES).toBe(30);

    expect(() =>
      assertValidDeploymentPlan(plan({ environment: 'staging', approved: false, soakMinutes: 5 })),
    ).toThrow(DeploymentError);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 7. An artifact is a digest, never a tag
// ────────────────────────────────────────────────────────────────────────────

describe('a release names an immutable artifact', () => {
  it('carries every field §5 requires of a release record', () => {
    // §5: `{ sha, digest, migrations[], flags_changed[], actor, timestamp }`.
    expect(doc).toMatch(/`\{ sha, digest, migrations\[\], flags_changed\[\], actor, timestamp \}`/);

    const built = createRelease(release(), NOW);
    for (const field of [
      'commitSha',
      'artifactDigest',
      'migrations',
      'flagsChanged',
      'actor',
      'createdAt',
    ]) {
      expect(field in built).toBe(true);
    }
  });

  it('refuses a tag, because §4 promotes by digest', () => {
    expect(doc).toMatch(/promotion references the digest, never a tag like `latest`/);

    for (const artifactDigest of ['latest', 'v1.4.2', 'app:latest']) {
      expect(() => assertValidRelease(release({ artifactDigest }), NOW)).toThrow(DeploymentError);
    }
  });

  it('refuses a rollback target that is a tag', () => {
    expect(() =>
      assertValidRollbackPlan(rollback({ previousDigest: 'latest' }), deployment(), release()),
    ).toThrow(DeploymentError);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 8. Production readiness
// ────────────────────────────────────────────────────────────────────────────

describe('the readiness gate', () => {
  const allChecks = (): ReadinessCheck[] =>
    READINESS_CHECKS.map((check) => ({ check, passed: true, detail: null }));

  it('requires every gate for production and argues none of them down', () => {
    expect(MANDATORY_FOR_PRODUCTION).toEqual(READINESS_CHECKS);
  });

  it('names the gate report §4 requires', () => {
    expect(doc).toMatch(/`verdict: releasable`/);
    expect(READINESS_CHECKS).toContain('gate_report_releasable');
  });

  it('derives readiness rather than accepting it', () => {
    // A caller that could set `ready` could set it true.
    const readiness = codeOf('readiness.ts');
    expect(readiness).toMatch(/const ready = requiredChecks/);

    const report = buildReadinessReport({
      reportId: 'readiness-001',
      environment: 'production',
      releaseId: 'release-2026-03-20',
      checks: allChecks().map((check) =>
        check.check === 'audit_chain_intact' ? { ...check, passed: false } : check,
      ),
      generatedAt: NOW,
    });

    expect(report.ready).toBe(false);
    expect(blockingChecks(report)).toEqual(['audit_chain_intact']);
  });

  it('re-derives none of the gates it reports', () => {
    // Their owners are the health monitor (S6.1), the security assessment
    // (S6.3), the backup manifest (S6.4) and the audit chain (S6.2). A second
    // derivation here would be a second source of truth.
    const readiness = codeOf('readiness.ts');

    expect(readiness).not.toMatch(/from '@contentos\//);
    expect(readiness).not.toMatch(/\bSecurityFinding\b/);
    expect(readiness).not.toMatch(/\bBackupManifest\b/);
    expect(readiness).not.toMatch(/\bAuditService\b/);
  });

  it('measures no health itself', () => {
    // `HealthMonitor` is canonical and untouched; these fold what it produced.
    const readiness = codeOf('readiness.ts');

    expect(readiness).not.toMatch(/\bping\b/i);
    expect(readiness).not.toMatch(/\bprobe\s*\(/i);
    expect(projectHealth([{ component: 'database', status: 'degraded' }]).status).toBe('degraded');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 9. Maintenance is declared, never entered
// ────────────────────────────────────────────────────────────────────────────

describe('maintenance', () => {
  it('declares a window without being able to enter one', () => {
    const operations = codeOf('operations.ts');

    expect(operations).not.toMatch(/\benterMaintenance\b/);
    expect(operations).not.toMatch(/\bsetMaintenance\b/);
    expect(operations).not.toMatch(/\btoggle\w*\s*\(/);
    expect(codeOf('repository.ts')).toMatch(/declareWindow\(/);
  });

  it('has a read-only mode, because a restore freezes writes', () => {
    // `backup-recovery.md` §6.2 freezes writes before a restore, and that is a
    // state in which the platform still answers questions. A single on/off flag
    // could not express it.
    expect(MAINTENANCE_MODES).toEqual(['off', 'read_only', 'full']);
    expect(blocksWrites('read_only')).toBe(true);
    expect(blocksReads('read_only')).toBe(false);
  });

  it('is half-open, so adjacent windows never overlap', () => {
    const window = createMaintenanceWindow(
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

    expect(Object.isFrozen(window)).toBe(true);
    expect(codeOf('operations.ts')).toMatch(
      /instant >= Date\.parse\([\s\S]*?\) && instant < Date\.parse/,
    );
  });
});

describe('runbooks are prose for a person', () => {
  it('holds no command, because a script in a data structure is one nobody reviews', () => {
    const operations = codeOf('operations.ts');

    expect(operations).not.toMatch(/\bcommand\b/i);
    expect(operations).not.toMatch(/\bscript\b/i);
    expect(operations).not.toMatch(/\bshell\b/i);
    expect(operations).toMatch(/readonly action: string/);
    expect(operations).toMatch(/readonly verification: string/);
  });

  it('is rehearsed on the document’s cadence', () => {
    // §10: "rehearsed quarterly alongside the restore drill".
    expect(doc).toMatch(/rehearsed quarterly alongside the restore drill/);

    const runbook = createRunbook(
      {
        runbookId: 'runbook-rollback',
        title: 'Roll back a production release.',
        scenario: 'rollback',
        steps: [{ order: 1, action: 'Redeploy the previous digest.', verification: 'Healthy.' }],
        owner: 'ops.platform',
        lastRehearsedAt: '2026-02-01T00:00:00.000Z',
        updatedAt: NOW,
      },
      NOW,
    );

    expect(Object.isFrozen(runbook.steps)).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 10. Audit is the caller's, in the caller's transaction
// ────────────────────────────────────────────────────────────────────────────

describe('the audit bridge', () => {
  it('names every action §Security requires audited', () => {
    // §Security: "every deploy, rollback, flag change, and manual migration is
    // append-only audit-logged with actor and artifact digest."
    expect(doc).toMatch(/every deploy, rollback, flag change, and manual migration is/);

    expect(Object.values(DEPLOYMENT_ACTIONS)).toContain('deployment.started');
    expect(Object.values(DEPLOYMENT_ACTIONS)).toContain('deployment.rollback.approved');
    for (const action of Object.values(DEPLOYMENT_ACTIONS)) {
      expect(action.startsWith('deployment.')).toBe(true);
    }
  });

  it('carries the artifact digest, because a version alone cannot say which bytes ran', () => {
    const event = toDeploymentAuditEvent({
      action: DEPLOYMENT_ACTIONS.deploymentStarted,
      actorId: 'ci.pipeline',
      actorKind: 'service',
      organizationId: 'org-01',
      correlationId: 'corr-01',
      targetKind: 'deployment',
      targetId: 'deploy-001',
      reason: 'Release 1.4.2.',
      artifactDigest: DIGEST,
    });

    expect(event.metadata?.['artifact_digest']).toBe(DIGEST);
    expect(Object.isFrozen(event)).toBe(true);
  });

  it('takes no transaction handle, so writing a record here is unrepresentable', () => {
    // Not merely forbidden — there is nothing to write one through.
    const service = codeOf('service.ts');

    expect(service).not.toMatch(/\bAuditService\b/);
    expect(service).not.toMatch(/\bauditRepository\b/);
    expect(service).not.toMatch(/\brecordAudit\b/);
    expect(service).not.toMatch(/\btransaction\b/i);
    expect(service).not.toMatch(/\bwithTx\b/);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 11. The package stays core, and stays zero-dependency
// ────────────────────────────────────────────────────────────────────────────

describe('the layer stays where core layers live', () => {
  it('imports nothing outside its own package', () => {
    // `@contentos/observability` declares `dependencies: {}`, and every layer
    // imports it. An import here would give the whole tree a new edge.
    // Anchored to a statement, not to the word `from`: an error message reading
    // `Available from '${from}'` is prose, not an edge.
    const specifiers = MODULES.flatMap((module) =>
      [...codeOf(module).matchAll(/^(?:import|export)\b[\s\S]*?\bfrom\s+'([^']+)';/gm)].map(
        (match) => match[1] ?? '',
      ),
    );

    // `errors.ts` imports nothing at all; the rest import only each other.
    expect(specifiers.length).toBeGreaterThan(5);
    for (const specifier of specifiers) {
      expect(specifier.startsWith('./') || specifier.startsWith('../')).toBe(true);
    }
  });

  it('keeps the package’s empty dependency block', () => {
    const manifest: unknown = JSON.parse(
      readFileSync(
        fileURLToPath(new URL('../../packages/observability/package.json', import.meta.url)),
        'utf8',
      ),
    );
    const dependencies = (manifest as { dependencies?: Record<string, string> }).dependencies ?? {};

    expect(Object.keys(dependencies)).toEqual([]);
  });

  it('imports no feature package', () => {
    for (const forbidden of [
      /@contentos\/content/,
      /@contentos\/knowledge/,
      /@contentos\/ai/,
      /@contentos\/platform/,
      /@contentos\/storage/,
      /@contentos\/events/,
      /@contentos\/security/,
      /@contentos\/database/,
    ]) {
      expect(ALL_CODE).not.toMatch(forbidden);
    }
  });

  it('names no AI runtime and no payment provider', () => {
    for (const forbidden of [/\bstripe\b/i, /\bopenai\b/i, /\banthropic\b/i, /\bllm\b/i]) {
      expect(ALL_CODE).not.toMatch(forbidden);
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 12. Every exported value is immutable
// ────────────────────────────────────────────────────────────────────────────

describe('nothing returned can be edited afterwards', () => {
  it('freezes every exported catalogue', () => {
    for (const value of [
      DEPLOYMENT_ENVIRONMENTS,
      DEPLOYMENT_TARGETS,
      DEPLOYMENT_STATES,
      DEPLOYMENT_TRANSITIONS,
      DEPLOYMENT_TRANSITION_RULES,
      MIGRATION_PHASES,
      RELEASE_STRATEGIES,
      ZERO_DOWNTIME_STRATEGIES,
      READINESS_CHECKS,
      MANDATORY_FOR_PRODUCTION,
      MAINTENANCE_MODES,
      ENVIRONMENT_CONFIGURATIONS,
      DEPLOYMENT_ACTIONS,
    ]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
  });

  it('freezes what every constructor returns, through', () => {
    // A release that came back mutable could have its digest edited after
    // verification passed — and the digest is the only thing that says which
    // code is running.
    const built = createRelease(release(), NOW);

    expect(Object.isFrozen(built)).toBe(true);
    expect(Object.isFrozen(built.migrations)).toBe(true);
    expect(() => {
      (built as { version: string }).version = '9.9.9';
    }).toThrow(TypeError);
  });

  it('freezes both projections', () => {
    const health = projectHealth([{ component: 'database', status: 'healthy' }]);

    expect(Object.isFrozen(health)).toBe(true);
    expect(
      Object.isFrozen(projectEnvironment({ environment: 'production', deployments: [], health })),
    ).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 13. Errors name the problem, never the machine
// ────────────────────────────────────────────────────────────────────────────

describe('the errors disclose nothing', () => {
  it('carries no hostname, path, URL or credential in any message', () => {
    const messages = [...ALL_CODE.matchAll(/'([^'\\]{40,})'/g)].map((match) => match[1] ?? '');

    expect(messages.length).toBeGreaterThan(10);
    for (const message of messages) {
      expect(message).not.toMatch(/https?:\/\//);
      expect(message).not.toMatch(/\b\d{1,3}(?:\.\d{1,3}){3}\b/);
      expect(message).not.toMatch(/[A-Za-z]:\\/);
      expect(message).not.toMatch(/\bpassword\b/i);
      expect(message).not.toMatch(/\bsecret\b/i);
      expect(message).not.toMatch(/\btoken\b/i);
    }
  });

  it('refuses an identifier that could carry one', () => {
    // Identifiers land on dashboards and in metric labels, so a hostname here
    // becomes disclosure there.
    for (const bad of ['api.internal:8080', 'https://ci/build/1', '/var/app']) {
      expect(() => assertValidRelease(release({ actor: bad }), NOW)).toThrow(DeploymentError);
    }
  });

  it('gives every module one taxonomy', () => {
    for (const module of MODULES) {
      const thrown = [...codeOf(module).matchAll(/throw new (\w+)/g)].map((match) => match[1]);
      for (const name of thrown) expect(name).toBe('DeploymentError');
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 14. The deviations
// ────────────────────────────────────────────────────────────────────────────

describe('the deviations, recorded', () => {
  it('DEVIATION 1: the layer lives in packages/observability, not a new package', () => {
    // It is the operations-facing core package — it already owns health,
    // metrics, logging and tracing, and a deployment description belongs beside
    // them. A new package would have to depend on this one to reuse
    // `HealthStatus` and `OBSERVED_COMPONENTS`, and would be the first feature
    // package every layer imported.
    expect(rawOf('readiness.ts')).toMatch(/from '\.\.\/health\/health\.js'/);
    expect(rawOf('readiness.ts')).toMatch(/from '\.\.\/components\.js'/);
  });

  it('DEVIATION 2: `ProductionReadinessReport` is NOT the existing `ReadinessReport`', () => {
    // `health/health.ts`'s is the answer to `/health/ready`, asked every few
    // seconds by a load balancer about one process. This is the launch gate,
    // asked once before a promotion, about the whole platform, covering things
    // a probe cannot see. Merging them would make a load balancer wait on a
    // compliance check.
    const health = readFileSync(
      fileURLToPath(new URL('../../packages/observability/src/health/health.ts', import.meta.url)),
      'utf8',
    );

    expect(health).toMatch(/interface ReadinessReport/);
    expect(codeOf('readiness.ts')).toMatch(/interface ProductionReadinessReport/);
    expect(codeOf('readiness.ts')).not.toMatch(/interface ReadinessReport\b/);
  });

  it('DEVIATION 3: the audit event is structurally typed, never imported', () => {
    // `AuditEvent` lives in `@contentos/security`, and this package depends on
    // nothing. The shape is restated so the caller can pass it straight to
    // `AuditService.record` inside the action's own transaction.
    expect(codeOf('service.ts')).toMatch(/interface DeploymentAuditEvent/);
    expect(codeOf('service.ts')).not.toMatch(/from '@contentos\/security'/);
  });

  it('DEVIATION 4: `canary` and `blue_green` are declared though §7 uses rolling', () => {
    // §Future improvements names "canary at 5% → 25% → 100% with automatic
    // promotion on SLO health". They are declared because a strategy type with
    // one member could never be unsupported — which the layer must be able to
    // refuse.
    expect(doc).toMatch(/canary/i);
    expect(RELEASE_STRATEGIES).toContain('canary');
    expect(ZERO_DOWNTIME_STRATEGIES).toContain('canary');

    expect(() => assertValidDeploymentPlan(plan({ strategy: 'recreate' }))).toThrow(
      DeploymentError,
    );
  });

  it('DEVIATION 5: `planned` is a state the diagram does not name', () => {
    // §10 starts at `[*] --> Deploying`. A stored deployment needs a state
    // before it starts, so `planned` is the explicit initial one and `start` is
    // the edge out of it. No other edge was added.
    expect(DEPLOYMENT_STATES[0]).toBe('planned');
    expect(DEPLOYMENT_TRANSITION_RULES.start).toEqual({ from: ['planned'], to: 'deploying' });
  });

  it('DEVIATION 6: nothing here emits the deploy marker §5 requires', () => {
    // The marker is an event, and events are `@contentos/events`. This layer
    // produces the record the marker is built from; emitting one would give a
    // zero-dependency core package an event-bus edge.
    expect(doc).toMatch(/Deploy marker event/);
    expect(ALL_CODE).not.toMatch(/\bpublish\s*\(/);
    expect(ALL_CODE).not.toMatch(/\bemit\s*\(/);
  });
});
