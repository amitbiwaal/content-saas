/**
 * `@contentos/database` — THE public surface.
 *
 * Specified by `03-database/` (schema, migrations, indexes) and
 * `16-security/row-level-security.md` (roles, policies, exception set).
 *
 * `drizzle-orm` is permitted ONLY inside this package
 * (`07-development-guide/project-structure.md` §"Banned imports") — one schema
 * owner. Nothing above this layer may import it.
 */

// RLS — the closed exception sets and the conformance suite
export type { ExceptionTableAccess } from './rls/exceptions.js';

// THE manifest — the single authoritative source for every RLS exception.
export type {
  RlsAssertionSpec,
  RlsAssertionSurface,
  RlsExceptionClass,
  RlsExceptionEntry,
  RlsManifestDocument,
} from './rls/manifest.js';
export {
  assertionsOfSurface,
  exceptionEntry,
  exceptionsOfClass,
  exceptionTables,
  RLS_ASSERTIONS,
  RLS_EXCEPTION_MANIFEST,
  rlsManifestDocument,
} from './rls/manifest.js';
export {
  ALL_EXCEPTION_TABLES,
  APPROVED_POLICY_VARIANTS,
  EXCEPTION_JUSTIFICATIONS,
  IDENTITY_EXCEPTION_TABLES,
  isExceptionTable,
  REFERENCE_DATA_EXCEPTION_TABLES,
} from './rls/exceptions.js';
export type {
  ConformanceFinding,
  ConformanceReport,
  RlsAssertionResult,
  RlsAssertionStatus,
  SqlExecutor,
} from './rls/conformance.js';
export {
  assertRlsConformance,
  COLUMNS_SQL,
  OWNERS_SQL,
  POLICIES_SQL,
  PRIVILEGES_SQL,
  ROLES_SQL,
  runRlsConformance,
  TABLES_SQL,
} from './rls/conformance.js';

// Connection and transactions
export type {
  ConnectionOptions,
  PoolMode,
  TenantContext,
  TenantScopedConnection,
  Transaction,
  TransactionRunner,
} from './connection/tenant-scoped.js';
export { assertPoolMode, createTenantScopedConnection } from './connection/tenant-scoped.js';

// Migrations
export type {
  AppliedMigration,
  MigrationExecutor,
  MigrationFile,
  MigrationPlan,
} from './migrations/runner.js';
export {
  assertSequence,
  checksum,
  currentVersion,
  migrate,
  MIGRATIONS_TABLE_SQL,
  planMigrations,
} from './migrations/runner.js';

// ── S6.4 · Backup & disaster recovery ───────────────────────────────────────
//
// No backup, restore or recovery code existed anywhere. What this adds is the
// DESCRIPTION layer: the data classification and objectives of
// `14-operations/backup-recovery.md` as data, the manifest that describes what
// a run produced, the plan that says what a restore would do, and the reports
// both fold into.
//
// It performs nothing. There is no filesystem, no cloud SDK, no connection, no
// command and no scheduler here — the mechanisms are the provider's, and a
// module that could execute a restore would make the two-person approval
// `backup-recovery.md` §4 requires advisory rather than structural.

export type { BackupErrorCode } from './backup/errors.js';
export {
  assertChecksum,
  assertIdentifier as assertBackupIdentifier,
  BackupError,
  MAX_IDENTIFIER_LENGTH as MAX_BACKUP_IDENTIFIER_LENGTH,
} from './backup/errors.js';

export type {
  Backup,
  BackupFormat,
  BackupId,
  BackupManifest,
  BackupMetadata,
  BackupSnapshot,
  BackupStore,
  DataClass,
  ExcludedStore,
  RecoveryPoint,
  SnapshotId,
  StoreObjective,
} from './backup/model.js';
export {
  assertValidManifest,
  assertValidMetadata as assertValidBackupMetadata,
  assertValidRecoveryPoint,
  assertValidSnapshot,
  BACKUP_FORMATS,
  BACKUP_SCHEMA_VERSION,
  BACKUP_STORES,
  createBackupManifest,
  DATA_CLASSES,
  isBackupFormat,
  isBackupStore,
  isDataClass,
  isRestorable,
  objectiveOf,
  restorableStores,
  snapshotFor,
  STORE_OBJECTIVES,
  SUPPORTED_BACKUP_SCHEMA_VERSIONS,
} from './backup/model.js';

export type {
  RestoreOutcome,
  RestorePlan,
  RestorePlanId,
  RestoreResult,
  RestoreScope,
  VerificationCheckName,
  VerificationResult,
} from './backup/restore.js';
export {
  assertValidRestorePlan,
  assertValidRestoreResult,
  createRestorePlan,
  createRestoreResult,
  isRestoreOutcome,
  isRestoreScope,
  isVerificationCheck,
  MANDATORY_CHECKS,
  mandatoryChecksPassed,
  PLATFORM_RESTORE_APPROVALS,
  RESTORE_OUTCOMES,
  RESTORE_SCOPES,
  RLS_CHECK_THREAT_ID,
  VERIFICATION_CHECKS,
} from './backup/restore.js';

export type {
  BackupExportMetadata,
  BackupReport,
  DisasterRecoveryPlan,
  DisasterRecoveryPlanId,
  RecoveryObjective,
  RecoveryReport,
} from './backup/recovery.js';
export {
  assertValidRecoveryPlan,
  BACKUP_EXPORT_FORMAT_VERSION,
  BACKUP_EXPORT_SCHEMA_VERSION,
  buildBackupExportMetadata,
  buildBackupReport,
  buildRecoveryReport,
  createRecoveryPlan,
  PRODUCTION_PITR_WINDOW_DAYS,
  STAGING_PITR_WINDOW_DAYS,
  uncoveredStores,
} from './backup/recovery.js';

export type {
  BackupPosition,
  BackupQuery,
  BackupRepository,
  BackupSlice,
  RecoveryPlanRepository,
  RestoreQuery,
  RestoreRepository,
  RestoreSlice,
} from './backup/repository.js';

export type {
  BackupAction,
  BackupAuditEvent,
  BackupService,
  BackupServiceOptions,
  DisasterRecoveryService,
  DisasterRecoveryServiceOptions,
  RecoveryPosture,
  RestoreService,
  RestoreServiceOptions,
} from './backup/service.js';
export {
  BACKUP_ACTIONS,
  createBackupService,
  createDisasterRecoveryService,
  createRestoreService,
  toAuditEvent as toBackupAuditEvent,
} from './backup/service.js';
