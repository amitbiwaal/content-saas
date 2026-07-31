/**
 * The backup and restore ports — interfaces, and nothing else.
 *
 * ── They store DESCRIPTIONS, never bytes ──────────────────────────────────
 * A `BackupRepository` holds manifests: the inventory rows §5 requires, so an
 * operator can choose a restore point and a compliance export can prove the
 * chain existed. The bytes live at the provider and never pass through here —
 * there is no `read`, no `download`, no stream and no path on either interface,
 * and no way to add one without changing this file.
 *
 * ── Append-only, both of them ─────────────────────────────────────────────
 * A backup manifest and a restore result are records of things that already
 * happened. There is no update and no delete: §8 puts a retention lock on
 * backup storage and requires two-person approval for a deletion, so a method
 * that could remove a manifest would be a way around a control that exists
 * precisely because deleting backups is how a ransomware incident becomes
 * unrecoverable.
 *
 * ── No database, no clock, no SQL ────────────────────────────────────────
 * No driver, no query text, no transaction handle. Keyset positions, explicit
 * nulls, supplied instants — the shapes `AuditQuery`, `FindingQuery` and
 * `SettlementQuery` already established.
 */

import type { BackupId, BackupManifest, BackupStore } from './model.js';
import type { DisasterRecoveryPlan } from './recovery.js';
import type { RestorePlan, RestorePlanId, RestoreResult, RestoreScope } from './restore.js';

/** Where a page of manifests continues from. Keyset, never an offset. */
export interface BackupPosition {
  readonly completedAt: string;
  readonly backupId: BackupId;
}

export interface BackupQuery {
  /** Required: a staging manifest must never be offered for a production restore. */
  readonly environment: string;
  /** Match any. Null lists every store. Never an empty array. */
  readonly stores: readonly BackupStore[] | null;
  /** Inclusive. */
  readonly completedAfter: string | null;
  /** Exclusive, so adjacent windows never count one run twice. */
  readonly completedBefore: string | null;
  readonly after: BackupPosition | null;
  readonly limit: number;
}

export interface BackupSlice {
  /** Newest first: "what can we restore to" starts at the most recent run. */
  readonly manifests: readonly BackupManifest[];
  readonly next: BackupPosition | null;
}

export interface BackupRepository {
  /**
   * Record a manifest.
   *
   * Idempotent on `backupId`: a run reported twice is one backup, and two rows
   * would let an operator choose a restore point that does not exist.
   */
  recordManifest(manifest: BackupManifest): Promise<BackupManifest>;

  loadManifest(backupId: BackupId): Promise<BackupManifest | null>;

  /**
   * The manifests that can serve a point in time.
   *
   * The selection question, asked directly: §4 requires a target outside the
   * window to be rejected with the earliest available time, which needs the
   * windows rather than the manifests.
   */
  findManifestsCovering(environment: string, at: string): Promise<readonly BackupManifest[]>;

  listManifests(query: BackupQuery): Promise<BackupSlice>;
}

// ── Restores ────────────────────────────────────────────────────────────────

export interface RestoreQuery {
  readonly scope: RestoreScope | null;
  readonly tenantId: string | null;
  readonly startedAfter: string | null;
  readonly startedBefore: string | null;
  readonly limit: number;
}

export interface RestoreSlice {
  /** Newest first: "when did we last restore" is the usual question. */
  readonly results: readonly RestoreResult[];
}

export interface RestoreRepository {
  /**
   * Record an approved plan.
   *
   * Storing a plan is not executing one. A store must refuse a duplicate id:
   * two plans under one id would make a restore report ambiguous about what was
   * approved.
   */
  recordPlan(plan: RestorePlan): Promise<RestorePlan>;

  loadPlan(planId: RestorePlanId): Promise<RestorePlan | null>;

  /** Record what a restore produced. Appended once; never amended. */
  recordResult(result: RestoreResult): Promise<RestoreResult>;

  loadResult(planId: RestorePlanId): Promise<RestoreResult | null>;

  listResults(query: RestoreQuery): Promise<RestoreSlice>;
}

// ── Disaster-recovery plans ─────────────────────────────────────────────────

export interface RecoveryPlanRepository {
  savePlan(plan: DisasterRecoveryPlan): Promise<DisasterRecoveryPlan>;

  /** The plan in force for an environment, or null. */
  loadPlan(environment: string): Promise<DisasterRecoveryPlan | null>;
}
