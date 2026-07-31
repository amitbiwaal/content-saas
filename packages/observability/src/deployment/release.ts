/**
 * Environments, releases and the order things ship in — `14-operations/deployment.md`.
 *
 * ── It DESCRIBES a release. It never ships one ─────────────────────────────
 * Nothing here runs a command, calls an orchestrator, touches a registry or
 * reaches a CI system. The pipeline is CI's; this is the vocabulary for
 * describing what it produced and refusing a description that could not be
 * true.
 *
 * ── An artifact is a digest, never a tag ──────────────────────────────────
 * §4: "Immutable; promotion references the digest, never a tag like `latest`."
 * A tag is a mutable pointer, so a release recorded against one names whatever
 * that pointer happens to mean when somebody looks — which during an incident
 * is the one thing that must not be ambiguous.
 *
 * ── The deploy order is a rule, not a preference ──────────────────────────
 * §3.3: workers before the API, "because they must be able to handle any job
 * the new API can enqueue"; the web app last, "so no user sees a UI referencing
 * an endpoint that is not yet live". A plan in the wrong order is refused here
 * rather than discovered when the first request 404s.
 */

import {
  assertIdentifier,
  assertInstant,
  assertPresent,
  assertText,
  deepFreeze,
  DeploymentError,
} from './errors.js';

/**
 * The four of §3.1, in promotion order.
 *
 * Frozen as well as `as const`: `as const` stops a TypeScript caller, and this
 * catalogue is read by JavaScript ones too. Every catalogue in this layer is
 * frozen for the same reason — a release description that could be edited after
 * verification passed is one that says nothing about which code is running.
 */
export const DEPLOYMENT_ENVIRONMENTS = Object.freeze([
  'local',
  'e2e',
  'staging',
  'production',
] as const);

export type DeploymentEnvironment = (typeof DEPLOYMENT_ENVIRONMENTS)[number];

export function isDeploymentEnvironment(value: unknown): value is DeploymentEnvironment {
  return (
    typeof value === 'string' && (DEPLOYMENT_ENVIRONMENTS as readonly string[]).includes(value)
  );
}

/** How far along the promotion path an environment is. Lower promotes first. */
export function promotionRank(environment: DeploymentEnvironment): number {
  return DEPLOYMENT_ENVIRONMENTS.indexOf(environment);
}

/**
 * What §3.1 says each environment is for.
 *
 * `realData` is the field that matters: it is what makes production's rules
 * different from every other environment's, and a config that claimed real data
 * in staging would put customer records somewhere with weaker controls.
 */
export interface EnvironmentConfiguration {
  readonly environment: DeploymentEnvironment;
  readonly purpose: string;
  /** Only production has real customer data. */
  readonly realData: boolean;
  /** Live vendors, sandbox accounts, or stubs. */
  readonly providers: 'live' | 'sandbox' | 'stub';
  /** Whether a promotion INTO this environment needs a human. */
  readonly requiresApproval: boolean;
}

export const ENVIRONMENT_CONFIGURATIONS: readonly EnvironmentConfiguration[] = Object.freeze(
  (
    [
      {
        environment: 'local',
        purpose: 'Development against synthetic factories',
        realData: false,
        providers: 'stub',
        requiresApproval: false,
      },
      {
        environment: 'e2e',
        purpose: 'Automated journeys against per-run synthetic tenants',
        realData: false,
        providers: 'stub',
        requiresApproval: false,
      },
      {
        environment: 'staging',
        purpose: 'Release-candidate soak, load tests and migration dry-runs',
        realData: false,
        providers: 'sandbox',
        requiresApproval: false,
      },
      {
        environment: 'production',
        purpose: 'Customers',
        realData: true,
        providers: 'live',
        requiresApproval: true,
      },
    ] satisfies readonly EnvironmentConfiguration[]
  ).map((configuration) => Object.freeze(configuration)),
);

const CONFIGURATION_BY_ENVIRONMENT: ReadonlyMap<DeploymentEnvironment, EnvironmentConfiguration> =
  new Map(
    ENVIRONMENT_CONFIGURATIONS.map((configuration) => [configuration.environment, configuration]),
  );

export function configurationOf(
  environment: DeploymentEnvironment,
): EnvironmentConfiguration | null {
  return CONFIGURATION_BY_ENVIRONMENT.get(environment) ?? null;
}

/** Does this environment hold real customer data? Only one does. */
export function holdsRealData(environment: DeploymentEnvironment): boolean {
  return CONFIGURATION_BY_ENVIRONMENT.get(environment)?.realData === true;
}

/**
 * What is being deployed, in the order §3.3 requires.
 *
 * The order is the point: migrations expand first, then workers, then the API,
 * then the web app.
 */
export const DEPLOYMENT_TARGETS = Object.freeze(['migrations', 'workers', 'api', 'web'] as const);

export type DeploymentTarget = (typeof DEPLOYMENT_TARGETS)[number];

export function isDeploymentTarget(value: unknown): value is DeploymentTarget {
  return typeof value === 'string' && (DEPLOYMENT_TARGETS as readonly string[]).includes(value);
}

export function deployRank(target: DeploymentTarget): number {
  return DEPLOYMENT_TARGETS.indexOf(target);
}

/**
 * The expand/contract sequence of §6 — "the core mechanic that makes rollback
 * safe".
 *
 * `contract` is the phase that makes a rollback impossible, which is why §6
 * ships it alone, in its own release, after the expanded shape has run in
 * production for a full cycle.
 */
export const MIGRATION_PHASES = Object.freeze(['expand', 'backfill', 'contract', 'none'] as const);

export type MigrationPhase = (typeof MIGRATION_PHASES)[number];

export function isMigrationPhase(value: unknown): value is MigrationPhase {
  return typeof value === 'string' && (MIGRATION_PHASES as readonly string[]).includes(value);
}

/** Is this phase one a code rollback cannot undo? */
export function blocksRollback(phase: MigrationPhase): boolean {
  return phase === 'contract';
}

/**
 * How a release reaches instances.
 *
 * `rolling` is today's, per §7. `canary` is §Future improvements — "canary at
 * 5% → 25% → 100% with automatic promotion on SLO health" — declared because a
 * strategy type with one member could never be unsupported, which the increment
 * requires it to be able to be.
 */
export const RELEASE_STRATEGIES = Object.freeze([
  'rolling',
  'canary',
  'blue_green',
  'recreate',
] as const);

export type ReleaseStrategy = (typeof RELEASE_STRATEGIES)[number];

export function isReleaseStrategy(value: unknown): value is ReleaseStrategy {
  return typeof value === 'string' && (RELEASE_STRATEGIES as readonly string[]).includes(value);
}

/**
 * The strategies that keep the previous version running while the new one
 * proves itself.
 *
 * `recreate` does not, so a production deployment using it has no rollback
 * shorter than a redeploy — which §10 targets at ten minutes and this cannot
 * meet.
 */
export const ZERO_DOWNTIME_STRATEGIES: readonly ReleaseStrategy[] = Object.freeze([
  'rolling',
  'canary',
  'blue_green',
]);

export type ReleaseId = string;

/** `1.2.3`, optionally pre-release. Not a tag, not a branch, not `latest`. */
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9a-z.-]+)?$/;

/** A registry digest — `sha256:` and sixty-four hex characters. */
const DIGEST = /^sha256:[0-9a-f]{64}$/;

/**
 * One release record — §5: `{ sha, digest, migrations[], flags_changed[],
 * actor, timestamp }`.
 *
 * Every field the document names, and nothing else. `flagsChanged` is here
 * because §Overview decouples deploys from releases: "code ships dark behind
 * flags; enabling a feature is a configuration change with its own, faster
 * rollback", and an incident needs to know which of the two happened.
 */
export interface Release {
  readonly releaseId: ReleaseId;
  readonly version: string;
  /** The commit. A full SHA, never a branch name. */
  readonly commitSha: string;
  /** The immutable artifact. A digest, never a tag. */
  readonly artifactDigest: string;
  readonly migrationPhase: MigrationPhase;
  readonly migrations: readonly string[];
  readonly flagsChanged: readonly string[];
  /** Who cut it. An identifier, never a name or an email. */
  readonly actor: string;
  readonly createdAt: string;
}

const COMMIT_SHA = /^[0-9a-f]{40}$/;

export function assertValidRelease(release: Release, now: string): Release {
  assertIdentifier(release.releaseId, 'releaseId');
  assertIdentifier(release.actor, 'actor');
  assertInstant(release.createdAt, 'createdAt', 'FutureReleaseTimestamp');
  assertInstant(now, 'now', 'FutureReleaseTimestamp');

  if (typeof release.version !== 'string' || !SEMVER.test(release.version)) {
    throw new DeploymentError(
      'InvalidReleaseVersion',
      'version',
      `'${String(release.version)}' is not a semantic version. A release nobody can order against another cannot be rolled back to.`,
    );
  }
  if (typeof release.commitSha !== 'string' || !COMMIT_SHA.test(release.commitSha)) {
    throw new DeploymentError(
      'InvalidReleaseVersion',
      'commitSha',
      'A commit SHA is forty hex characters. A branch name moves, and a release recorded against one names whatever it happens to point at later.',
    );
  }
  if (typeof release.artifactDigest !== 'string' || !DIGEST.test(release.artifactDigest)) {
    throw new DeploymentError(
      'InvalidReleaseVersion',
      'artifactDigest',
      'An artifact is pinned by digest — `sha256:` and sixty-four hex characters — never by a tag like `latest`. A tag is a mutable pointer, and during an incident which code is running is the one thing that must not be ambiguous.',
    );
  }
  if (!isMigrationPhase(release.migrationPhase)) {
    throw new DeploymentError(
      'InvalidReleaseVersion',
      'migrationPhase',
      `'${String(release.migrationPhase)}' is not a migration phase. Available: ${MIGRATION_PHASES.join(', ')}.`,
    );
  }
  if (Date.parse(release.createdAt) > Date.parse(now)) {
    throw new DeploymentError(
      'FutureReleaseTimestamp',
      'createdAt',
      'A release cannot have been cut in the future. That is a clock skew or a fabricated record, and either breaks the incident timeline it exists to anchor.',
    );
  }

  // §6: the contract phase ships alone, after the expanded shape has run for a
  // full cycle. A contract release carrying other migrations is one nobody can
  // roll back partway.
  if (release.migrationPhase === 'contract' && release.migrations.length === 0) {
    throw new DeploymentError(
      'InvalidReleaseVersion',
      'migrations',
      'A contract release names the migrations it drops. A contract phase with none is a phase claimed but not taken.',
    );
  }
  if (release.migrationPhase === 'none' && release.migrations.length > 0) {
    throw new DeploymentError(
      'InvalidReleaseVersion',
      'migrationPhase',
      'A release carrying migrations is not phase `none`. Mislabelling it would let a contract migration ship as if it were reversible.',
    );
  }

  const seen = new Set<string>();
  for (const migration of release.migrations) {
    assertIdentifier(migration, 'migrations');
    if (seen.has(migration)) {
      throw new DeploymentError(
        'InvalidReleaseVersion',
        'migrations',
        `Migration '${migration}' is listed twice.`,
      );
    }
    seen.add(migration);
  }

  for (const flag of release.flagsChanged) {
    assertPresent(flag, 'flagsChanged', 'a flag change is recorded by key.');
    assertText(flag, 'flagsChanged', 'a flag key.');
  }

  return release;
}

export function createRelease(release: Release, now: string): Release {
  assertValidRelease(release, now);
  return deepFreeze({
    ...release,
    migrations: [...release.migrations],
    flagsChanged: [...release.flagsChanged],
  });
}

/**
 * The targets a release must ship to, in the required order.
 *
 * §3.3, as a function: migrations, then workers, then the API, then the web.
 */
export function orderTargets(targets: readonly DeploymentTarget[]): readonly DeploymentTarget[] {
  return Object.freeze([...targets].sort((a, b) => deployRank(a) - deployRank(b)));
}

/**
 * Is this sequence in the order the document requires?
 *
 * Workers before the API "because they must be able to handle any job the new
 * API can enqueue"; the web last "so no user sees a UI referencing an endpoint
 * that is not yet live".
 */
export function isCorrectlyOrdered(targets: readonly DeploymentTarget[]): boolean {
  for (let index = 1; index < targets.length; index += 1) {
    const previous = targets[index - 1];
    const current = targets[index];
    if (previous === undefined || current === undefined) return false;
    if (deployRank(previous) >= deployRank(current)) return false;
  }
  return true;
}
