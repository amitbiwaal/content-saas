/**
 * Restore plans, their verification, and what a restore produced.
 *
 * ── It PLANS a restore. It never performs one ──────────────────────────────
 * There is no connection, no command, no `pg_restore`, no bucket rollback and
 * no write of any kind here. A plan says what WOULD be restored, from which
 * manifest, to which point, and what must be verified afterwards. Something
 * with credentials and a runbook does the rest.
 *
 * A restore is the one operation in this system that can destroy data at
 * scale, and `backup-recovery.md` requires two-person approval for a platform
 * one. A module that could execute it would make that approval advisory.
 *
 * ── Write freeze is part of the plan, not an afterthought ─────────────────
 * §6.2: "Restoring while writes continue produces a split-brain: rows created
 * after the restore point exist in the old cluster and vanish in the new one."
 * So a full-platform plan that does not freeze writes is refused here rather
 * than discovered during the incident.
 *
 * ── The RLS check is mandatory, and the model says so ─────────────────────
 * §8: "RLS policies present on every table (a restore that loses policies would
 * silently disable tenant isolation — this check is mandatory, not optional)."
 * `assertValidRestorePlan` refuses a plan that omits it. That is the one check
 * whose absence is invisible: everything works, and every tenant can read every
 * other tenant's rows.
 */

import {
  assertIdentifier,
  assertInstant,
  assertPresent,
  BackupError,
  deepFreeze,
} from './errors.js';
import {
  assertValidRecoveryPoint,
  isBackupStore,
  isRestorable,
  restorableStores,
  type BackupId,
  type BackupManifest,
  type BackupStore,
  type RecoveryPoint,
} from './model.js';

/**
 * How much is being restored.
 *
 * §6.2 is a SEV1 full-platform restore; §6.4 is a tenant-level one. They have
 * different approvals, different blast radii and different freeze requirements,
 * so a plan that could not distinguish them would apply the wrong rules.
 */
export const RESTORE_SCOPES = ['full_platform', 'tenant', 'single_store'] as const;

export type RestoreScope = (typeof RESTORE_SCOPES)[number];

export function isRestoreScope(value: unknown): value is RestoreScope {
  return typeof value === 'string' && (RESTORE_SCOPES as readonly string[]).includes(value);
}

/**
 * The integrity checks §8 requires after a restore.
 *
 * Transcribed, and `rls_policies_present` is mandatory — see the file header.
 */
export const VERIFICATION_CHECKS = [
  'migration_version',
  'referential_integrity',
  'row_counts',
  'rls_policies_present',
  'credit_ledger_reconciles',
] as const;

export type VerificationCheckName = (typeof VERIFICATION_CHECKS)[number];

export function isVerificationCheck(value: unknown): value is VerificationCheckName {
  return typeof value === 'string' && (VERIFICATION_CHECKS as readonly string[]).includes(value);
}

/**
 * The check no restore may skip.
 *
 * Its threat is `T-06`, cross-tenant data leakage, which `threat-model.md`
 * classifies Critical. Named as an id rather than imported: this package
 * depends on nothing, and a composition root that wants a `SecurityFinding` out
 * of a failed check has the id it needs to make one.
 */
export const MANDATORY_CHECKS: readonly VerificationCheckName[] = Object.freeze([
  'rls_policies_present',
]);

export const RLS_CHECK_THREAT_ID = 'T-06';

export type RestorePlanId = string;

/**
 * What a restore would do.
 *
 * Every field is a description. `freezeWrites` is a REQUIREMENT the plan
 * records, not an action it takes.
 */
export interface RestorePlan {
  readonly planId: RestorePlanId;
  readonly backupId: BackupId;
  readonly scope: RestoreScope;
  /** Null for a full-platform restore; required for a tenant one. */
  readonly tenantId: string | null;
  readonly targetPoint: RecoveryPoint;
  /** Which stores this plan restores. Never a derived one. */
  readonly stores: readonly BackupStore[];
  /**
   * Whether writes are frozen first. §6.2 requires it for a full restore:
   * restoring while writes continue produces a split-brain.
   */
  readonly freezeWrites: boolean;
  /** The checks that must pass afterwards. Must include the mandatory ones. */
  readonly verification: readonly VerificationCheckName[];
  /**
   * How many people authorised it. §4: "Platform restore requires two-person
   * approval." Recorded, never enforced here — the approval is a process, and a
   * number in a plan is evidence of it, not a substitute for it.
   */
  readonly approvals: number;
  readonly createdAt: string;
}

export const PLATFORM_RESTORE_APPROVALS = 2;

/** What one check concluded. `detail` is enumerated, never a query or a trace. */
export interface VerificationResult {
  readonly check: VerificationCheckName;
  readonly passed: boolean;
  /** Bounded. Never a stack trace, a query or a row. */
  readonly detail: string | null;
}

export const RESTORE_OUTCOMES = ['verified', 'failed_verification', 'aborted'] as const;

export type RestoreOutcome = (typeof RESTORE_OUTCOMES)[number];

export function isRestoreOutcome(value: unknown): value is RestoreOutcome {
  return typeof value === 'string' && (RESTORE_OUTCOMES as readonly string[]).includes(value);
}

/**
 * What a restore produced — the §5 restore report: scope, target time,
 * duration, verification results.
 *
 * A record of something that already happened elsewhere. This layer never
 * produces one by acting; it validates and projects one it is handed.
 */
export interface RestoreResult {
  readonly planId: RestorePlanId;
  readonly outcome: RestoreOutcome;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly results: readonly VerificationResult[];
  /** Stores that were rebuilt rather than restored. Derived, by definition. */
  readonly rebuilt: readonly BackupStore[];
}

const MAX_DETAIL_LENGTH = 200;

export function assertValidRestorePlan(plan: RestorePlan, manifest: BackupManifest): RestorePlan {
  assertIdentifier(plan.planId, 'planId');
  assertIdentifier(plan.backupId, 'backupId');
  assertInstant(plan.createdAt, 'createdAt', 'InvalidRecoveryPoint');
  assertValidRecoveryPoint(plan.targetPoint);

  if (!isRestoreScope(plan.scope)) {
    throw new BackupError(
      'IncompatibleRestorePlan',
      'scope',
      `'${String(plan.scope)}' is not a restore scope. Available: ${RESTORE_SCOPES.join(', ')}.`,
    );
  }

  if (plan.backupId !== manifest.backup.backupId) {
    throw new BackupError(
      'IncompatibleRestorePlan',
      'backupId',
      `The plan names backup '${plan.backupId}' and the manifest supplied is '${manifest.backup.backupId}'. Validating a plan against the wrong manifest would approve a restore from a backup nobody checked.`,
    );
  }

  // §6.2. A split-brain is rows created after the restore point existing in the
  // old cluster and vanishing in the new one.
  if (plan.scope === 'full_platform' && !plan.freezeWrites) {
    throw new BackupError(
      'IncompatibleRestorePlan',
      'freezeWrites',
      'A full-platform restore freezes writes first. Restoring while writes continue produces a split-brain: rows created after the restore point exist in the old cluster and vanish in the new one.',
    );
  }

  if (plan.scope === 'tenant') {
    assertPresent(plan.tenantId, 'tenantId', 'a tenant restore names the tenant it is for.');
  } else if (plan.tenantId !== null) {
    throw new BackupError(
      'IncompatibleRestorePlan',
      'tenantId',
      `A ${plan.scope} restore names no tenant. A plan that carried one would read as scoped when it is not.`,
    );
  }

  if (plan.scope === 'full_platform' && plan.approvals < PLATFORM_RESTORE_APPROVALS) {
    throw new BackupError(
      'IncompatibleRestorePlan',
      'approvals',
      `A platform restore requires ${String(PLATFORM_RESTORE_APPROVALS)} approvals; this plan records ${String(plan.approvals)}.`,
    );
  }
  if (!Number.isSafeInteger(plan.approvals) || plan.approvals < 0) {
    throw new BackupError(
      'IncompatibleRestorePlan',
      'approvals',
      'An approval count is a non-negative whole number.',
    );
  }

  if (plan.stores.length === 0) {
    throw new BackupError(
      'IncompatibleRestorePlan',
      'stores',
      'A restore plan names at least one store.',
    );
  }

  const available = new Set(restorableStores(manifest));
  for (const store of plan.stores) {
    if (!isBackupStore(store)) {
      throw new BackupError('UnknownStore', 'stores', `'${String(store)}' is not a store.`);
    }
    if (!isRestorable(store)) {
      throw new BackupError(
        'IncompatibleRestorePlan',
        'stores',
        `'${store}' is a derived store: it is rebuilt from its source, not restored. Planning to restore it is a recovery path with no backup behind it.`,
      );
    }
    if (!available.has(store)) {
      throw new BackupError(
        'IncompatibleRestorePlan',
        'stores',
        `Backup '${manifest.backup.backupId}' holds no snapshot of '${store}'. A plan that names it would fail partway through, with some stores already restored.`,
      );
    }
  }

  // The target must fall inside the window the MANIFEST can serve, not merely
  // inside the one the plan claims.
  const target = Date.parse(plan.targetPoint.at);
  if (
    target < Date.parse(manifest.recoveryPoint.earliestAvailable) ||
    target > Date.parse(manifest.recoveryPoint.latestAvailable)
  ) {
    throw new BackupError(
      'InvalidRecoveryPoint',
      'targetPoint',
      `${plan.targetPoint.at} is outside the window backup '${manifest.backup.backupId}' can serve. The earliest available point is ${manifest.recoveryPoint.earliestAvailable}.`,
    );
  }

  const checks = new Set<VerificationCheckName>();
  for (const check of plan.verification) {
    if (!isVerificationCheck(check)) {
      throw new BackupError(
        'IncompatibleRestorePlan',
        'verification',
        `'${String(check)}' is not a verification check. Available: ${VERIFICATION_CHECKS.join(', ')}.`,
      );
    }
    checks.add(check);
  }

  for (const mandatory of MANDATORY_CHECKS) {
    if (!checks.has(mandatory)) {
      throw new BackupError(
        'IncompatibleRestorePlan',
        'verification',
        `'${mandatory}' is mandatory and this plan omits it. A restore that loses RLS policies silently disables tenant isolation — everything works, and every tenant can read every other tenant's rows.`,
      );
    }
  }

  return plan;
}

export function createRestorePlan(plan: RestorePlan, manifest: BackupManifest): RestorePlan {
  assertValidRestorePlan(plan, manifest);
  return deepFreeze({
    ...plan,
    targetPoint: { ...plan.targetPoint },
    stores: [...plan.stores],
    verification: [...plan.verification],
  });
}

export function assertValidRestoreResult(result: RestoreResult, plan: RestorePlan): RestoreResult {
  assertIdentifier(result.planId, 'planId');
  assertInstant(result.startedAt, 'startedAt', 'InvalidRecoveryPoint');
  assertInstant(result.completedAt, 'completedAt', 'InvalidRecoveryPoint');

  if (result.planId !== plan.planId) {
    throw new BackupError(
      'IncompatibleRestorePlan',
      'planId',
      `The result reports plan '${result.planId}' and the plan supplied is '${plan.planId}'.`,
    );
  }
  if (!isRestoreOutcome(result.outcome)) {
    throw new BackupError(
      'IncompatibleRestorePlan',
      'outcome',
      `'${String(result.outcome)}' is not a restore outcome. Available: ${RESTORE_OUTCOMES.join(', ')}.`,
    );
  }
  if (Date.parse(result.completedAt) < Date.parse(result.startedAt)) {
    throw new BackupError(
      'InconsistentMetadata',
      'completedAt',
      'A restore cannot finish before it started.',
    );
  }

  const reported = new Set<VerificationCheckName>();
  for (const entry of result.results) {
    if (!isVerificationCheck(entry.check)) {
      throw new BackupError(
        'IncompatibleRestorePlan',
        'results',
        `'${String(entry.check)}' is not a verification check.`,
      );
    }
    if (reported.has(entry.check)) {
      throw new BackupError(
        'InconsistentMetadata',
        'results',
        `Check '${entry.check}' is reported twice; a report could not say which result stood.`,
      );
    }
    reported.add(entry.check);

    if (entry.detail !== null && entry.detail.length > MAX_DETAIL_LENGTH) {
      throw new BackupError(
        'InconsistentMetadata',
        'results',
        `Detail for '${entry.check}' is longer than ${String(MAX_DETAIL_LENGTH)} characters. A field that wide eventually holds a row of customer data.`,
      );
    }
  }

  // A result that omits a planned check is one nobody can call verified.
  for (const planned of plan.verification) {
    if (!reported.has(planned)) {
      throw new BackupError(
        'InconsistentMetadata',
        'results',
        `The plan required '${planned}' and the result does not report it. An unreported check is an unrun one.`,
      );
    }
  }

  // `verified` must mean every check passed. Otherwise a report can say a
  // restore was verified while a mandatory check failed.
  const allPassed = result.results.every((entry) => entry.passed);
  if (result.outcome === 'verified' && !allPassed) {
    throw new BackupError(
      'InconsistentMetadata',
      'outcome',
      'A restore reported as verified has a failing check. Verified means every check passed; anything else is failed_verification.',
    );
  }

  for (const store of result.rebuilt) {
    if (!isBackupStore(store)) {
      throw new BackupError('UnknownStore', 'rebuilt', `'${String(store)}' is not a store.`);
    }
    if (isRestorable(store)) {
      throw new BackupError(
        'InconsistentMetadata',
        'rebuilt',
        `'${store}' is restorable, not derived. Reporting it as rebuilt would hide that it was never restored.`,
      );
    }
  }

  return result;
}

export function createRestoreResult(result: RestoreResult, plan: RestorePlan): RestoreResult {
  assertValidRestoreResult(result, plan);
  return deepFreeze({
    ...result,
    results: result.results.map((entry) => ({ ...entry })),
    rebuilt: [...result.rebuilt],
  });
}

/** Did every mandatory check pass? The question that gates resuming traffic. */
export function mandatoryChecksPassed(result: RestoreResult): boolean {
  return MANDATORY_CHECKS.every((mandatory) =>
    result.results.some((entry) => entry.check === mandatory && entry.passed),
  );
}
