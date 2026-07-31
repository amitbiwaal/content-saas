/**
 * Disaster-recovery plans and the two reports — `backup-recovery.md` §5.
 *
 * ── A plan is a statement of intent, checked against the objectives ────────
 * §3.2 fixes an RPO and an RTO per store. A DR plan that claimed a four-hour
 * RPO for PostgreSQL would be a commitment nobody agreed to and one the
 * mechanism cannot deliver, so a plan is validated AGAINST the table rather
 * than merely stored beside it.
 *
 * ── Nothing here schedules, executes or drills ────────────────────────────
 * "Monthly logical restore, quarterly full-cluster restore" is an ops calendar.
 * This layer records that a drill happened and what it achieved; it has no
 * timer, no scheduler and no way to start one.
 *
 * ── Reports are projections, not measurements ─────────────────────────────
 * `buildBackupReport` and `buildRecoveryReport` fold values they are given. The
 * measuring happened elsewhere, by something with credentials.
 */

import { assertIdentifier, assertInstant, BackupError, deepFreeze } from './errors.js';
import {
  isBackupStore,
  objectiveOf,
  STORE_OBJECTIVES,
  type BackupManifest,
  type BackupStore,
} from './model.js';
import {
  mandatoryChecksPassed,
  type RestoreResult,
  type VerificationCheckName,
} from './restore.js';

/** What a plan commits to for one store. Compared against `STORE_OBJECTIVES`. */
export interface RecoveryObjective {
  readonly store: BackupStore;
  readonly rpoSeconds: number | null;
  readonly rtoSeconds: number;
}

export type DisasterRecoveryPlanId = string;

/**
 * The plan for recovering the platform.
 *
 * `drillCadenceDays` records the calendar §4 names — monthly logical, quarterly
 * full — as a number a report can check a drill against. It schedules nothing.
 */
export interface DisasterRecoveryPlan {
  readonly planId: DisasterRecoveryPlanId;
  readonly environment: string;
  readonly objectives: readonly RecoveryObjective[];
  /** The PITR window this environment maintains. 14 days production. */
  readonly pitrWindowDays: number;
  readonly drillCadenceDays: number;
  readonly createdAt: string;
}

export const PRODUCTION_PITR_WINDOW_DAYS = 14;
export const STAGING_PITR_WINDOW_DAYS = 3;

export function assertValidRecoveryPlan(plan: DisasterRecoveryPlan): DisasterRecoveryPlan {
  assertIdentifier(plan.planId, 'planId');
  assertIdentifier(plan.environment, 'environment');
  assertInstant(plan.createdAt, 'createdAt', 'InvalidRecoveryPoint');

  if (!Number.isSafeInteger(plan.pitrWindowDays) || plan.pitrWindowDays <= 0) {
    throw new BackupError(
      'InvalidRecoveryPoint',
      'pitrWindowDays',
      'A PITR window is a whole number of days above zero. A window of zero is no window.',
    );
  }
  if (!Number.isSafeInteger(plan.drillCadenceDays) || plan.drillCadenceDays <= 0) {
    throw new BackupError(
      'InconsistentMetadata',
      'drillCadenceDays',
      'A drill cadence is a whole number of days above zero. An untested restore path is one that silently breaks — most often through an encryption or permission change — and is discovered only when it is needed.',
    );
  }

  if (plan.objectives.length === 0) {
    throw new BackupError(
      'InconsistentMetadata',
      'objectives',
      'A recovery plan commits to at least one store.',
    );
  }

  const seen = new Set<BackupStore>();
  for (const objective of plan.objectives) {
    if (!isBackupStore(objective.store)) {
      throw new BackupError(
        'UnknownStore',
        'objectives',
        `'${String(objective.store)}' is not a store this build classifies.`,
      );
    }
    if (seen.has(objective.store)) {
      throw new BackupError(
        'InconsistentMetadata',
        'objectives',
        `Store '${objective.store}' has two objectives; a drill could not say which it missed.`,
      );
    }
    seen.add(objective.store);

    const declared = objectiveOf(objective.store);
    if (declared === null) continue;

    // A plan may commit to something TIGHTER than the document, never looser:
    // a looser commitment is a promise the mechanism cannot keep.
    if (objective.rtoSeconds > declared.rtoSeconds) {
      throw new BackupError(
        'InconsistentMetadata',
        'objectives',
        `The plan allows ${String(objective.rtoSeconds)}s to recover '${objective.store}'; the objective is ${String(declared.rtoSeconds)}s. A plan cannot commit to less than the platform already promises.`,
      );
    }
    if (declared.rpoSeconds !== null) {
      if (objective.rpoSeconds === null) {
        throw new BackupError(
          'InconsistentMetadata',
          'objectives',
          `'${objective.store}' is not derived, so it has a recovery point. A null RPO would read as "rebuilt from source", which it is not.`,
        );
      }
      if (objective.rpoSeconds > declared.rpoSeconds) {
        throw new BackupError(
          'InconsistentMetadata',
          'objectives',
          `The plan accepts ${String(objective.rpoSeconds)}s of loss for '${objective.store}'; the objective is ${String(declared.rpoSeconds)}s.`,
        );
      }
    }
  }

  return plan;
}

export function createRecoveryPlan(plan: DisasterRecoveryPlan): DisasterRecoveryPlan {
  assertValidRecoveryPlan(plan);
  return deepFreeze({
    ...plan,
    objectives: plan.objectives.map((objective) => ({ ...objective })),
  });
}

/** Every store the document classifies that this plan does not commit to. */
export function uncoveredStores(plan: DisasterRecoveryPlan): readonly BackupStore[] {
  const committed = new Set(plan.objectives.map((objective) => objective.store));
  return Object.freeze(
    STORE_OBJECTIVES.filter(
      (objective) => objective.dataClass !== 'derived' && !committed.has(objective.store),
    ).map((objective) => objective.store),
  );
}

// ── Reports ─────────────────────────────────────────────────────────────────

/**
 * The §5 backup inventory, folded.
 *
 * What compliance evidence and restore selection both read. Sizes are summed
 * rather than listed: an inventory of ten thousand WAL segments is not a
 * report, and the per-snapshot detail is in the manifest for whoever needs it.
 */
export interface BackupReport {
  readonly backupId: string;
  readonly environment: string;
  readonly completedAt: string;
  readonly snapshotCount: number;
  readonly totalBytes: number;
  readonly storesCovered: readonly BackupStore[];
  /** Restorable stores neither snapshotted nor excluded. Should be empty. */
  readonly storesMissing: readonly BackupStore[];
  readonly recoveryWindow: { readonly from: string; readonly to: string };
}

export function buildBackupReport(manifest: BackupManifest): BackupReport {
  const covered = [...new Set(manifest.backup.snapshots.map((snapshot) => snapshot.store))];
  const excluded = new Set(manifest.excluded.map((entry) => entry.store));

  return deepFreeze({
    backupId: manifest.backup.backupId,
    environment: manifest.backup.metadata.environment,
    completedAt: manifest.backup.completedAt,
    snapshotCount: manifest.backup.snapshots.length,
    totalBytes: manifest.backup.snapshots.reduce((sum, s) => sum + s.sizeBytes, 0),
    storesCovered: covered,
    storesMissing: STORE_OBJECTIVES.filter(
      (objective) =>
        objective.dataClass !== 'derived' &&
        !covered.includes(objective.store) &&
        !excluded.has(objective.store),
    ).map((objective) => objective.store),
    recoveryWindow: {
      from: manifest.recoveryPoint.earliestAvailable,
      to: manifest.recoveryPoint.latestAvailable,
    },
  });
}

/**
 * The §5 restore and drill report: scope, target time, duration, verification.
 *
 * `rtoAchievedSeconds` against `rtoTargetSeconds` is the whole point of a
 * drill — "RPO/RTO achieved vs target, deviations, remediation" — and a report
 * that only said "it worked" would not tell a quarterly review anything.
 */
export interface RecoveryReport {
  readonly planId: string;
  readonly outcome: RestoreResult['outcome'];
  readonly durationSeconds: number;
  /** The worst objective among the stores restored, or null if none had one. */
  readonly rtoTargetSeconds: number | null;
  readonly rtoMet: boolean | null;
  readonly checksRun: readonly VerificationCheckName[];
  readonly checksFailed: readonly VerificationCheckName[];
  /** False when any mandatory check failed. Gates resuming traffic. */
  readonly safeToResume: boolean;
  readonly rebuiltStores: readonly BackupStore[];
}

export function buildRecoveryReport(input: {
  readonly result: RestoreResult;
  readonly stores: readonly BackupStore[];
}): RecoveryReport {
  const { result } = input;
  const durationSeconds = Math.round(
    (Date.parse(result.completedAt) - Date.parse(result.startedAt)) / 1000,
  );

  // The tightest target among the stores restored: a restore is only as fast
  // as the store with the least headroom.
  let target: number | null = null;
  for (const store of input.stores) {
    const objective = objectiveOf(store);
    if (objective === null) continue;
    target = target === null ? objective.rtoSeconds : Math.min(target, objective.rtoSeconds);
  }

  const failed = result.results.filter((entry) => !entry.passed).map((entry) => entry.check);

  return deepFreeze({
    planId: result.planId,
    outcome: result.outcome,
    durationSeconds,
    rtoTargetSeconds: target,
    rtoMet: target === null ? null : durationSeconds <= target,
    checksRun: result.results.map((entry) => entry.check),
    checksFailed: failed,
    safeToResume: result.outcome === 'verified' && mandatoryChecksPassed(result),
    rebuiltStores: [...result.rebuilt],
  });
}

/**
 * The export envelope for a manifest.
 *
 * Mirrors the S4.8 export convention rather than reusing `ExportMetadata`,
 * which lives in a feature package this core one may not import: every artefact
 * carries its schema version, its format version and when it was produced, and
 * an unsupported version is refused rather than upgraded.
 */
export interface BackupExportMetadata {
  readonly exportSchemaVersion: number;
  readonly formatVersion: number;
  readonly exportedAt: string;
  readonly backupId: string;
  readonly checksum: string;
}

export const BACKUP_EXPORT_SCHEMA_VERSION = 1;
export const BACKUP_EXPORT_FORMAT_VERSION = 1;

export function buildBackupExportMetadata(input: {
  readonly manifest: BackupManifest;
  readonly exportedAt: string;
  readonly checksum: string;
}): BackupExportMetadata {
  assertInstant(input.exportedAt, 'exportedAt', 'InvalidRecoveryPoint');

  return deepFreeze({
    exportSchemaVersion: BACKUP_EXPORT_SCHEMA_VERSION,
    formatVersion: BACKUP_EXPORT_FORMAT_VERSION,
    exportedAt: input.exportedAt,
    backupId: input.manifest.backup.backupId,
    checksum: input.checksum,
  });
}
