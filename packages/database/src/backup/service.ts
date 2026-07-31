/**
 * The three services — describe, validate, project, coordinate.
 *
 * ── None of them performs a backup or a restore ───────────────────────────
 * There is no connection, no command, no cloud call, no filesystem access and
 * no scheduler in this file. `BackupService` records what a run produced;
 * `RestoreService` validates a plan against the manifest it names and records
 * what a restore reported; `DisasterRecoveryService` answers whether the
 * platform's stated objectives are met.
 *
 * A restore can destroy data at scale, and `backup-recovery.md` §4 requires
 * two-person approval for a platform one. A service that could execute one
 * would make that approval advisory rather than structural.
 *
 * ── Production data is never touched ──────────────────────────────────────
 * Every port these services hold reads or appends DESCRIPTIONS — manifests,
 * plans, results. None of them can reach a tenant table, and none is offered
 * one.
 *
 * ── Auditing is the caller's, in the caller's transaction ─────────────────
 * Authorising a restore is exactly the operator action `audit.md` requires to
 * be recorded, and `threat-model.md` T-25 is about. `toAuditEvent` projects one
 * onto the frozen `AuditEvent` shape; the caller records it through
 * `AuditService` in the same transaction as the change. This layer takes no
 * transaction handle, so writing an audit record here is unrepresentable rather
 * than merely discouraged.
 *
 * ── No clock, no ids, no globals ──────────────────────────────────────────
 * Every instant and identifier arrives with the request.
 */

import { BackupError, deepFreeze } from './errors.js';
import {
  createBackupManifest,
  type BackupId,
  type BackupManifest,
  type BackupStore,
} from './model.js';
import {
  buildBackupReport,
  buildRecoveryReport,
  createRecoveryPlan,
  uncoveredStores,
  type BackupReport,
  type DisasterRecoveryPlan,
  type RecoveryReport,
} from './recovery.js';
import type { BackupRepository, RecoveryPlanRepository, RestoreRepository } from './repository.js';
import {
  createRestorePlan,
  createRestoreResult,
  type RestorePlan,
  type RestorePlanId,
  type RestoreResult,
} from './restore.js';

// ── Backups ─────────────────────────────────────────────────────────────────

export interface BackupServiceOptions {
  readonly backups: BackupRepository;
}

export interface BackupService {
  /**
   * Record what a backup run produced.
   *
   * Validates the manifest — every restorable store snapshotted or excluded, no
   * duplicate snapshot, nothing dated in the future — then stores it. Throws
   * `BackupError` on anything incoherent: an inventory row nobody can trust is
   * worse than none, because it looks like protection.
   */
  recordManifest(manifest: BackupManifest, now: string): Promise<BackupManifest>;

  loadManifest(backupId: BackupId): Promise<BackupManifest | null>;

  /** The §5 inventory report for one run. */
  report(backupId: BackupId): Promise<BackupReport | null>;

  /**
   * The manifests that can serve a point in time, newest first.
   *
   * What restore selection asks. Empty is a legitimate answer and the caller
   * must handle it: §4 requires a target outside the window to be rejected with
   * the earliest available time rather than served from the nearest backup.
   */
  manifestsCovering(environment: string, at: string): Promise<readonly BackupManifest[]>;
}

export function createBackupService(options: BackupServiceOptions): BackupService {
  const { backups } = options;

  return Object.freeze({
    async recordManifest(manifest: BackupManifest, now: string): Promise<BackupManifest> {
      // Validated and frozen before the store is reached, so an implementation
      // cannot be handed a manifest the rules would have refused.
      const validated = createBackupManifest(manifest, now);
      return backups.recordManifest(validated);
    },

    loadManifest(backupId: BackupId): Promise<BackupManifest | null> {
      return backups.loadManifest(backupId);
    },

    async report(backupId: BackupId): Promise<BackupReport | null> {
      const manifest = await backups.loadManifest(backupId);
      return manifest === null ? null : buildBackupReport(manifest);
    },

    manifestsCovering(environment: string, at: string): Promise<readonly BackupManifest[]> {
      return backups.findManifestsCovering(environment, at);
    },
  });
}

// ── Restores ────────────────────────────────────────────────────────────────

export interface RestoreServiceOptions {
  readonly restores: RestoreRepository;
  readonly backups: BackupRepository;
}

export interface RestoreService {
  /**
   * Validate a plan against the backup it names, and record it.
   *
   * The manifest is LOADED rather than supplied, so a plan cannot be approved
   * against a manifest the caller constructed. Refuses a plan whose target is
   * outside the window, whose stores the backup does not hold, that omits the
   * mandatory RLS check, or that would restore the platform without freezing
   * writes.
   */
  approvePlan(plan: RestorePlan): Promise<RestorePlan>;

  loadPlan(planId: RestorePlanId): Promise<RestorePlan | null>;

  /**
   * Record what a restore reported.
   *
   * The plan is loaded and the result validated against it: a result that
   * omits a planned check, or claims `verified` with a failing one, is refused.
   */
  recordResult(result: RestoreResult): Promise<RestoreResult>;

  /** The §5 restore report, or null when there is no result yet. */
  report(planId: RestorePlanId): Promise<RecoveryReport | null>;
}

export function createRestoreService(options: RestoreServiceOptions): RestoreService {
  const { restores, backups } = options;

  return Object.freeze({
    async approvePlan(plan: RestorePlan): Promise<RestorePlan> {
      const manifest = await backups.loadManifest(plan.backupId);
      if (manifest === null) {
        throw new BackupError(
          'IncompatibleRestorePlan',
          'backupId',
          `Backup '${plan.backupId}' has no recorded manifest. A plan against an unrecorded backup is one nobody can verify was ever taken.`,
        );
      }

      const validated = createRestorePlan(plan, manifest);
      return restores.recordPlan(validated);
    },

    loadPlan(planId: RestorePlanId): Promise<RestorePlan | null> {
      return restores.loadPlan(planId);
    },

    async recordResult(result: RestoreResult): Promise<RestoreResult> {
      const plan = await restores.loadPlan(result.planId);
      if (plan === null) {
        throw new BackupError(
          'IncompatibleRestorePlan',
          'planId',
          `Plan '${result.planId}' was never approved. A result with no plan behind it is a restore nobody authorised.`,
        );
      }

      const validated = createRestoreResult(result, plan);
      return restores.recordResult(validated);
    },

    async report(planId: RestorePlanId): Promise<RecoveryReport | null> {
      const [plan, result] = await Promise.all([
        restores.loadPlan(planId),
        restores.loadResult(planId),
      ]);
      if (plan === null || result === null) return null;

      return buildRecoveryReport({ result, stores: plan.stores });
    },
  });
}

// ── Disaster recovery ───────────────────────────────────────────────────────

export interface DisasterRecoveryServiceOptions {
  readonly plans: RecoveryPlanRepository;
  readonly backups: BackupRepository;
}

/**
 * Whether an environment is actually protected.
 *
 * Derived, never asserted: "an unverified backup chain can silently break for
 * weeks — most often through an encryption or permission change — and be
 * discovered only when it is needed."
 */
export interface RecoveryPosture {
  readonly environment: string;
  readonly hasPlan: boolean;
  /** Restorable stores the plan does not commit to. Should be empty. */
  readonly uncoveredStores: readonly BackupStore[];
  /** Whether a manifest exists that can serve the instant asked about. */
  readonly hasRecentBackup: boolean;
  /** The most recent completion, or null when nothing is recorded. */
  readonly lastBackupAt: string | null;
}

export interface DisasterRecoveryService {
  declarePlan(plan: DisasterRecoveryPlan): Promise<DisasterRecoveryPlan>;

  loadPlan(environment: string): Promise<DisasterRecoveryPlan | null>;

  /**
   * Is this environment protected, at this instant?
   *
   * A projection over the plan and the recorded manifests. It measures nothing
   * itself and reaches no store.
   */
  posture(environment: string, at: string): Promise<RecoveryPosture>;
}

export function createDisasterRecoveryService(
  options: DisasterRecoveryServiceOptions,
): DisasterRecoveryService {
  const { plans, backups } = options;

  return Object.freeze({
    async declarePlan(plan: DisasterRecoveryPlan): Promise<DisasterRecoveryPlan> {
      const validated = createRecoveryPlan(plan);
      return plans.savePlan(validated);
    },

    loadPlan(environment: string): Promise<DisasterRecoveryPlan | null> {
      return plans.loadPlan(environment);
    },

    async posture(environment: string, at: string): Promise<RecoveryPosture> {
      const plan = await plans.loadPlan(environment);
      const covering = await backups.findManifestsCovering(environment, at);

      let latest: string | null = null;
      for (const manifest of covering) {
        if (latest === null || manifest.backup.completedAt > latest) {
          latest = manifest.backup.completedAt;
        }
      }

      return deepFreeze({
        environment,
        hasPlan: plan !== null,
        uncoveredStores: plan === null ? [] : uncoveredStores(plan),
        hasRecentBackup: covering.length > 0,
        lastBackupAt: latest,
      });
    },
  });
}

// ── The bridge to audit ─────────────────────────────────────────────────────

/** The backup actions privileged enough to be audited. */
export const BACKUP_ACTIONS = {
  manifestRecorded: 'backup.manifest.recorded',
  restoreApproved: 'backup.restore.approved',
  restoreCompleted: 'backup.restore.completed',
  recoveryPlanDeclared: 'backup.recovery_plan.declared',
} as const;

export type BackupAction = (typeof BACKUP_ACTIONS)[keyof typeof BACKUP_ACTIONS];

/**
 * A backup action, in the shape the frozen `AuditEvent` takes.
 *
 * Structurally typed rather than imported: this package depends on nothing, and
 * `@contentos/security` is where `AuditEvent` lives. The caller passes this
 * straight to `AuditService.record` inside the action's own transaction.
 *
 * The category is `administration` — authorising a restore is the operator
 * action `threat-model.md` T-25 is about, and the one an investigation most
 * needs attributed.
 */
export interface BackupAuditEvent {
  readonly category: 'administration';
  readonly action: BackupAction;
  readonly tenantId: string | null;
  readonly organizationId: string;
  readonly actor: { readonly id: string; readonly kind: 'user' | 'service' | 'operator' };
  readonly correlationId: string;
  readonly target: { readonly kind: string; readonly id: string; readonly tenantId: string | null };
  readonly result: 'success';
  readonly reason: string;
  readonly ipAddress: null;
  readonly userAgent: null;
  readonly sessionId: null;
  readonly stepUpSatisfied: boolean;
  readonly metadata?: Readonly<Record<string, string>>;
}

export function toAuditEvent(input: {
  readonly action: BackupAction;
  readonly actorId: string;
  readonly actorKind: 'user' | 'service' | 'operator';
  readonly organizationId: string;
  readonly tenantId: string | null;
  readonly correlationId: string;
  readonly targetKind: string;
  readonly targetId: string;
  readonly reason: string;
  /** True for a platform restore: two-person approval is a step-up in practice. */
  readonly stepUpSatisfied?: boolean;
  readonly metadata?: Readonly<Record<string, string>>;
}): BackupAuditEvent {
  return deepFreeze({
    category: 'administration' as const,
    action: input.action,
    tenantId: input.tenantId,
    organizationId: input.organizationId,
    actor: { id: input.actorId, kind: input.actorKind },
    correlationId: input.correlationId,
    target: { kind: input.targetKind, id: input.targetId, tenantId: input.tenantId },
    result: 'success' as const,
    reason: input.reason,
    ipAddress: null,
    userAgent: null,
    sessionId: null,
    stepUpSatisfied: input.stepUpSatisfied ?? false,
    ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
  });
}
