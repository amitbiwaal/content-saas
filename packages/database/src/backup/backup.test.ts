import { describe, expect, it } from 'vitest';

import {
  assertChecksum,
  assertIdentifier,
  BackupError,
  MAX_IDENTIFIER_LENGTH,
  type BackupErrorCode,
} from './errors.js';
import {
  assertValidManifest,
  assertValidRecoveryPoint,
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
  type BackupManifest,
  type BackupSnapshot,
} from './model.js';
import {
  BACKUP_EXPORT_SCHEMA_VERSION,
  buildBackupExportMetadata,
  buildBackupReport,
  buildRecoveryReport,
  createRecoveryPlan,
  PRODUCTION_PITR_WINDOW_DAYS,
  uncoveredStores,
  type DisasterRecoveryPlan,
} from './recovery.js';
import {
  assertValidRestorePlan,
  assertValidRestoreResult,
  createRestorePlan,
  createRestoreResult,
  MANDATORY_CHECKS,
  mandatoryChecksPassed,
  PLATFORM_RESTORE_APPROVALS,
  RESTORE_SCOPES,
  RLS_CHECK_THREAT_ID,
  VERIFICATION_CHECKS,
  type RestorePlan,
  type RestoreResult,
} from './restore.js';

const NOW = '2026-03-10T12:00:00.000Z';
const TAKEN = '2026-03-10T02:00:00.000Z';
const DIGEST = 'a'.repeat(64);

const codeOf = (call: () => unknown): BackupErrorCode | null => {
  try {
    call();
    return null;
  } catch (error) {
    if (error instanceof BackupError) return error.code;
    throw error;
  }
};

const snapshot = (overrides: Partial<BackupSnapshot> = {}): BackupSnapshot => ({
  snapshotId: 'snap-pg-001',
  store: 'postgresql',
  format: 'physical_base',
  takenAt: TAKEN,
  sizeBytes: 1_048_576,
  checksum: DIGEST,
  encryptionKeyId: 'kms.key-v3',
  ...overrides,
});

/** A manifest covering every restorable store — five snapshots, one excluded. */
const manifest = (overrides: Partial<BackupManifest> = {}): BackupManifest => ({
  backup: {
    backupId: 'backup-2026-03-10',
    metadata: {
      schemaVersion: BACKUP_SCHEMA_VERSION,
      environment: 'production',
      migrationVersion: '0025_ai_jobs',
      retainedFrom: '2026-02-24T00:00:00.000Z',
      retainedUntil: '2026-03-10T02:00:00.000Z',
    },
    startedAt: '2026-03-10T01:00:00.000Z',
    completedAt: '2026-03-10T02:30:00.000Z',
    snapshots: [
      snapshot(),
      snapshot({ snapshotId: 'snap-obj-001', store: 'object_storage', format: 'object_version' }),
      snapshot({ snapshotId: 'snap-sec-001', store: 'secrets', format: 'escrow' }),
      snapshot({ snapshotId: 'snap-cfg-001', store: 'config', format: 'logical' }),
      snapshot({ snapshotId: 'snap-tmp-001', store: 'temporal', format: 'logical' }),
      snapshot({ snapshotId: 'snap-rdq-001', store: 'redis_queues', format: 'logical' }),
    ],
  },
  recoveryPoint: {
    at: '2026-03-10T02:00:00.000Z',
    earliestAvailable: '2026-02-24T00:00:00.000Z',
    latestAvailable: '2026-03-10T02:00:00.000Z',
  },
  excluded: [],
  ...overrides,
});

const plan = (overrides: Partial<RestorePlan> = {}): RestorePlan => ({
  planId: 'restore-001',
  backupId: 'backup-2026-03-10',
  scope: 'full_platform',
  tenantId: null,
  targetPoint: {
    at: '2026-03-10T01:30:00.000Z',
    earliestAvailable: '2026-02-24T00:00:00.000Z',
    latestAvailable: '2026-03-10T02:00:00.000Z',
  },
  stores: ['postgresql', 'object_storage'],
  freezeWrites: true,
  verification: [...VERIFICATION_CHECKS],
  approvals: 2,
  createdAt: NOW,
  ...overrides,
});

const result = (overrides: Partial<RestoreResult> = {}): RestoreResult => ({
  planId: 'restore-001',
  outcome: 'verified',
  startedAt: '2026-03-10T03:00:00.000Z',
  completedAt: '2026-03-10T03:40:00.000Z',
  results: VERIFICATION_CHECKS.map((check) => ({ check, passed: true, detail: null })),
  rebuilt: ['vector_index', 'aggregates'],
  ...overrides,
});

// ── The classification ──────────────────────────────────────────────────────

describe('the data classification is the document’s', () => {
  it('names the three classes', () => {
    expect(DATA_CLASSES).toEqual(['authoritative', 'semi_durable', 'derived']);
    expect(isDataClass('cached')).toBe(false);
  });

  it('names every store the objectives table covers', () => {
    expect(BACKUP_STORES).toHaveLength(9);
    expect(STORE_OBJECTIVES).toHaveLength(9);
    for (const objective of STORE_OBJECTIVES) {
      expect(isBackupStore(objective.store)).toBe(true);
      expect(isDataClass(objective.dataClass)).toBe(true);
    }
  });

  it('gives PostgreSQL a five-minute RPO and an hour RTO', () => {
    const pg = objectiveOf('postgresql');
    expect(pg?.rpoSeconds).toBe(300);
    expect(pg?.rtoSeconds).toBe(3600);
    expect(pg?.dataClass).toBe('authoritative');
  });

  it('gives object storage an RPO of zero, because it is versioned', () => {
    expect(objectiveOf('object_storage')?.rpoSeconds).toBe(0);
  });

  it('gives every derived store a NULL RPO, not zero', () => {
    // Zero would read as "loses nothing". A derived store loses everything and
    // then recomputes it.
    for (const store of ['redis_cache', 'vector_index', 'aggregates'] as const) {
      const objective = objectiveOf(store);
      expect(objective?.dataClass).toBe('derived');
      expect(objective?.rpoSeconds).toBeNull();
    }
  });

  it('marks derived stores as not restorable', () => {
    expect(isRestorable('vector_index')).toBe(false);
    expect(isRestorable('aggregates')).toBe(false);
    expect(isRestorable('redis_cache')).toBe(false);
    expect(isRestorable('postgresql')).toBe(true);
    expect(isRestorable('redis_queues')).toBe(true);
  });

  it('is frozen through', () => {
    expect(Object.isFrozen(STORE_OBJECTIVES)).toBe(true);
    expect(Object.isFrozen(STORE_OBJECTIVES[0])).toBe(true);
  });

  it('names the provider’s own formats, not one we invented', () => {
    // A backup nobody but us can read cannot be restored without us.
    expect(BACKUP_FORMATS).toEqual([
      'physical_base',
      'wal_segment',
      'logical',
      'object_version',
      'escrow',
    ]);
    expect(isBackupFormat('contentos_proprietary')).toBe(false);
  });
});

// ── Shared assertions ───────────────────────────────────────────────────────

describe('identifiers and checksums', () => {
  it('accept a dotted or hyphenated identifier', () => {
    expect(assertIdentifier('backup-2026-03-10', 'x')).toBe('backup-2026-03-10');
    expect(assertIdentifier('kms.key-v3', 'x')).toBe('kms.key-v3');
  });

  it('refuse a path, a URL or a hostname', () => {
    // These appear in reports and metric labels; free text here is disclosure
    // there.
    for (const bad of ['/var/backups/db', 's3://bucket/key', 'db.internal:5432', 'Backup 1']) {
      expect(codeOf(() => assertIdentifier(bad, 'x'))).toBe('InvalidBackupId');
    }
  });

  it('refuse an identifier past the limit', () => {
    expect(codeOf(() => assertIdentifier('a'.repeat(MAX_IDENTIFIER_LENGTH + 1), 'x'))).toBe(
      'InvalidBackupId',
    );
  });

  it('accept a SHA-256 digest and refuse anything else', () => {
    expect(assertChecksum(DIGEST, 'x')).toBe(DIGEST);
    expect(codeOf(() => assertChecksum('a'.repeat(63), 'x'))).toBe('MalformedManifest');
    expect(codeOf(() => assertChecksum('A'.repeat(64), 'x'))).toBe('MalformedManifest');
    expect(codeOf(() => assertChecksum('', 'x'))).toBe('MalformedManifest');
  });
});

// ── Manifests ───────────────────────────────────────────────────────────────

describe('backup manifests', () => {
  it('build when well-formed and freeze through', () => {
    const built = createBackupManifest(manifest(), NOW);

    expect(Object.isFrozen(built)).toBe(true);
    expect(Object.isFrozen(built.backup.snapshots)).toBe(true);
    expect(Object.isFrozen(built.backup.snapshots[0])).toBe(true);
    expect(Object.isFrozen(built.recoveryPoint)).toBe(true);
  });

  it('refuse an unsupported schema version', () => {
    // Nothing is upgraded automatically: a manifest misread by an older build
    // is a restore against the wrong data.
    expect(
      codeOf(() =>
        assertValidManifest(
          manifest({
            backup: {
              ...manifest().backup,
              metadata: { ...manifest().backup.metadata, schemaVersion: 99 },
            },
          }),
          NOW,
        ),
      ),
    ).toBe('InvalidBackupVersion');
    expect(SUPPORTED_BACKUP_SCHEMA_VERSIONS).toEqual([1]);
  });

  it('refuse a snapshot of a derived store', () => {
    // Backing up a vector index adds a second recovery path that must itself
    // be tested.
    const withVector = manifest();
    expect(
      codeOf(() =>
        assertValidManifest(
          {
            ...withVector,
            backup: {
              ...withVector.backup,
              snapshots: [
                ...withVector.backup.snapshots,
                snapshot({ snapshotId: 'snap-vec', store: 'vector_index' }),
              ],
            },
          },
          NOW,
        ),
      ),
    ).toBe('InconsistentMetadata');
  });

  it('refuse a duplicate snapshot id', () => {
    const base = manifest();
    expect(
      codeOf(() =>
        assertValidManifest(
          {
            ...base,
            backup: {
              ...base.backup,
              snapshots: [...base.backup.snapshots, snapshot()],
            },
          },
          NOW,
        ),
      ),
    ).toBe('DuplicateSnapshot');
  });

  it('refuse a snapshot taken in the future', () => {
    const base = manifest();
    expect(
      codeOf(() =>
        assertValidManifest(
          {
            ...base,
            backup: {
              ...base.backup,
              snapshots: [snapshot({ takenAt: '2027-01-01T00:00:00.000Z' })],
            },
          },
          NOW,
        ),
      ),
    ).toBe('FutureBackupTimestamp');
  });

  it('refuse a run that completed in the future', () => {
    const base = manifest();
    expect(
      codeOf(() =>
        assertValidManifest(
          { ...base, backup: { ...base.backup, completedAt: '2027-01-01T00:00:00.000Z' } },
          NOW,
        ),
      ),
    ).toBe('FutureBackupTimestamp');
  });

  it('refuse a run that finished before it started', () => {
    const base = manifest();
    expect(
      codeOf(() =>
        assertValidManifest(
          { ...base, backup: { ...base.backup, completedAt: '2026-03-10T00:00:00.000Z' } },
          NOW,
        ),
      ),
    ).toBe('InconsistentMetadata');
  });

  it('refuse a snapshot taken after the run that contains it', () => {
    const base = manifest();
    expect(
      codeOf(() =>
        assertValidManifest(
          {
            ...base,
            backup: {
              ...base.backup,
              snapshots: [snapshot({ takenAt: '2026-03-10T04:00:00.000Z' })],
            },
          },
          NOW,
        ),
      ),
    ).toBe('InconsistentMetadata');
  });

  it('refuse a manifest with no snapshot at all', () => {
    // An empty inventory row is how an unverified chain looks like a healthy
    // one.
    const base = manifest();
    expect(
      codeOf(() =>
        assertValidManifest({ ...base, backup: { ...base.backup, snapshots: [] } }, NOW),
      ),
    ).toBe('MalformedManifest');
  });

  it('refuse a manifest that silently omits a restorable store', () => {
    const base = manifest();
    expect(
      codeOf(() =>
        assertValidManifest({ ...base, backup: { ...base.backup, snapshots: [snapshot()] } }, NOW),
      ),
    ).toBe('MalformedManifest');
  });

  it('accept an omission that is explicitly excluded', () => {
    const base = manifest();
    expect(
      codeOf(() =>
        assertValidManifest(
          {
            ...base,
            backup: { ...base.backup, snapshots: [snapshot()] },
            excluded: [
              { store: 'object_storage', reason: 'covered_elsewhere' },
              { store: 'secrets', reason: 'covered_elsewhere' },
              { store: 'config', reason: 'covered_elsewhere' },
              { store: 'temporal', reason: 'not_deployed' },
              { store: 'redis_queues', reason: 'not_deployed' },
            ],
          },
          NOW,
        ),
      ),
    ).toBeNull();
  });

  it('refuse a retention window that ends before it begins', () => {
    const base = manifest();
    expect(
      codeOf(() =>
        assertValidManifest(
          {
            ...base,
            backup: {
              ...base.backup,
              metadata: { ...base.backup.metadata, retainedUntil: '2026-01-01T00:00:00.000Z' },
            },
          },
          NOW,
        ),
      ),
    ).toBe('InconsistentMetadata');
  });

  it('refuse a negative or fractional snapshot size', () => {
    const base = manifest();
    for (const sizeBytes of [-1, 1.5]) {
      expect(
        codeOf(() =>
          assertValidManifest(
            { ...base, backup: { ...base.backup, snapshots: [snapshot({ sizeBytes })] } },
            NOW,
          ),
        ),
      ).toBe('InconsistentMetadata');
    }
  });

  it('find a snapshot by store, and list what is restorable', () => {
    const built = createBackupManifest(manifest(), NOW);

    expect(snapshotFor(built, 'postgresql')?.snapshotId).toBe('snap-pg-001');
    expect(snapshotFor(built, 'vector_index')).toBeNull();
    expect(restorableStores(built)).toContain('postgresql');
    expect(restorableStores(built)).not.toContain('vector_index');
  });
});

describe('recovery points', () => {
  it('accept one inside its window', () => {
    expect(
      codeOf(() =>
        assertValidRecoveryPoint({
          at: '2026-03-01T00:00:00.000Z',
          earliestAvailable: '2026-02-24T00:00:00.000Z',
          latestAvailable: '2026-03-10T00:00:00.000Z',
        }),
      ),
    ).toBeNull();
  });

  it('refuse one before the window, naming the earliest available', () => {
    // §4 requires the refusal to carry it rather than merely say no.
    let message = '';
    try {
      assertValidRecoveryPoint({
        at: '2026-01-01T00:00:00.000Z',
        earliestAvailable: '2026-02-24T00:00:00.000Z',
        latestAvailable: '2026-03-10T00:00:00.000Z',
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('2026-02-24T00:00:00.000Z');
  });

  it('refuse one after the window', () => {
    expect(
      codeOf(() =>
        assertValidRecoveryPoint({
          at: '2027-01-01T00:00:00.000Z',
          earliestAvailable: '2026-02-24T00:00:00.000Z',
          latestAvailable: '2026-03-10T00:00:00.000Z',
        }),
      ),
    ).toBe('InvalidRecoveryPoint');
  });

  it('refuse a local-time instant', () => {
    expect(
      codeOf(() =>
        assertValidRecoveryPoint({
          at: '2026-03-01T00:00:00',
          earliestAvailable: '2026-02-24T00:00:00.000Z',
          latestAvailable: '2026-03-10T00:00:00.000Z',
        }),
      ),
    ).toBe('InvalidRecoveryPoint');
  });
});

// ── Restore plans ───────────────────────────────────────────────────────────

describe('restore plans', () => {
  const m = () => createBackupManifest(manifest(), NOW);

  it('build when well-formed and freeze through', () => {
    const built = createRestorePlan(plan(), m());

    expect(Object.isFrozen(built)).toBe(true);
    expect(Object.isFrozen(built.stores)).toBe(true);
    expect(Object.isFrozen(built.verification)).toBe(true);
  });

  it('refuse a full-platform restore that does not freeze writes', () => {
    // Restoring while writes continue produces a split-brain: rows created
    // after the restore point exist in the old cluster and vanish in the new.
    expect(codeOf(() => assertValidRestorePlan(plan({ freezeWrites: false }), m()))).toBe(
      'IncompatibleRestorePlan',
    );
  });

  it('refuse a plan that omits the mandatory RLS check', () => {
    // A restore that loses RLS silently disables tenant isolation: everything
    // works, and every tenant can read every other tenant's rows.
    expect(
      codeOf(() =>
        assertValidRestorePlan(plan({ verification: ['migration_version', 'row_counts'] }), m()),
      ),
    ).toBe('IncompatibleRestorePlan');
    expect(MANDATORY_CHECKS).toEqual(['rls_policies_present']);
  });

  it('names the threat the RLS check exists for', () => {
    // T-06, cross-tenant data leakage, which threat-model.md classifies
    // Critical.
    expect(RLS_CHECK_THREAT_ID).toBe('T-06');
  });

  it('refuse a platform restore with fewer than two approvals', () => {
    expect(codeOf(() => assertValidRestorePlan(plan({ approvals: 1 }), m()))).toBe(
      'IncompatibleRestorePlan',
    );
    expect(PLATFORM_RESTORE_APPROVALS).toBe(2);
  });

  it('refuse a plan whose backup id is not the manifest’s', () => {
    // Validating against the wrong manifest would approve a restore from a
    // backup nobody checked.
    expect(codeOf(() => assertValidRestorePlan(plan({ backupId: 'backup-other' }), m()))).toBe(
      'IncompatibleRestorePlan',
    );
  });

  it('refuse a plan naming a derived store', () => {
    expect(
      codeOf(() => assertValidRestorePlan(plan({ stores: ['postgresql', 'vector_index'] }), m())),
    ).toBe('IncompatibleRestorePlan');
  });

  it('refuse a plan naming a store the backup does not hold', () => {
    const thin = createBackupManifest(
      {
        ...manifest(),
        backup: { ...manifest().backup, snapshots: [snapshot()] },
        excluded: [
          { store: 'object_storage', reason: 'not_deployed' },
          { store: 'secrets', reason: 'not_deployed' },
          { store: 'config', reason: 'not_deployed' },
          { store: 'temporal', reason: 'not_deployed' },
          { store: 'redis_queues', reason: 'not_deployed' },
        ],
      },
      NOW,
    );

    expect(
      codeOf(() =>
        assertValidRestorePlan(plan({ stores: ['postgresql', 'object_storage'] }), thin),
      ),
    ).toBe('IncompatibleRestorePlan');
  });

  it('refuse a target outside the manifest’s window', () => {
    expect(
      codeOf(() =>
        assertValidRestorePlan(
          plan({
            targetPoint: {
              at: '2026-02-01T00:00:00.000Z',
              earliestAvailable: '2026-01-01T00:00:00.000Z',
              latestAvailable: '2026-03-10T00:00:00.000Z',
            },
          }),
          m(),
        ),
      ),
    ).toBe('InvalidRecoveryPoint');
  });

  it('require a tenant on a tenant restore, and refuse one elsewhere', () => {
    expect(
      codeOf(() =>
        assertValidRestorePlan(
          plan({ scope: 'tenant', tenantId: null, freezeWrites: false, approvals: 1 }),
          m(),
        ),
      ),
    ).toBe('MissingField');

    expect(
      codeOf(() =>
        assertValidRestorePlan(
          plan({ scope: 'single_store', tenantId: 'tenant-1', freezeWrites: false, approvals: 1 }),
          m(),
        ),
      ),
    ).toBe('IncompatibleRestorePlan');
  });

  it('accept a tenant restore without a write freeze', () => {
    // §6.4 is scoped; the freeze requirement is the platform restore's.
    expect(
      codeOf(() =>
        assertValidRestorePlan(
          plan({
            scope: 'tenant',
            tenantId: 'tenant-1',
            freezeWrites: false,
            approvals: 1,
            stores: ['postgresql'],
          }),
          m(),
        ),
      ),
    ).toBeNull();
  });

  it('name the three scopes', () => {
    expect(RESTORE_SCOPES).toEqual(['full_platform', 'tenant', 'single_store']);
  });
});

// ── Restore results ─────────────────────────────────────────────────────────

describe('restore results', () => {
  it('build when consistent with their plan', () => {
    const built = createRestoreResult(result(), plan());

    expect(Object.isFrozen(built)).toBe(true);
    expect(Object.isFrozen(built.results)).toBe(true);
  });

  it('refuse a result for a different plan', () => {
    expect(codeOf(() => assertValidRestoreResult(result({ planId: 'other' }), plan()))).toBe(
      'IncompatibleRestorePlan',
    );
  });

  it('refuse a result that omits a planned check', () => {
    // An unreported check is an unrun one.
    expect(
      codeOf(() =>
        assertValidRestoreResult(
          result({ results: [{ check: 'row_counts', passed: true, detail: null }] }),
          plan(),
        ),
      ),
    ).toBe('InconsistentMetadata');
  });

  it('refuse "verified" when a check failed', () => {
    // Otherwise a report says a restore was verified while a mandatory check
    // failed.
    expect(
      codeOf(() =>
        assertValidRestoreResult(
          result({
            results: VERIFICATION_CHECKS.map((check) => ({
              check,
              passed: check !== 'rls_policies_present',
              detail: null,
            })),
          }),
          plan(),
        ),
      ),
    ).toBe('InconsistentMetadata');
  });

  it('accept a failed verification that says so', () => {
    expect(
      codeOf(() =>
        assertValidRestoreResult(
          result({
            outcome: 'failed_verification',
            results: VERIFICATION_CHECKS.map((check) => ({
              check,
              passed: check !== 'rls_policies_present',
              detail: null,
            })),
          }),
          plan(),
        ),
      ),
    ).toBeNull();
  });

  it('refuse a duplicated check', () => {
    expect(
      codeOf(() =>
        assertValidRestoreResult(
          result({
            results: [
              ...VERIFICATION_CHECKS.map((check) => ({ check, passed: true, detail: null })),
              { check: 'row_counts' as const, passed: false, detail: null },
            ],
          }),
          plan(),
        ),
      ),
    ).toBe('InconsistentMetadata');
  });

  it('refuse a detail wide enough for a row of customer data', () => {
    expect(
      codeOf(() =>
        assertValidRestoreResult(
          result({
            results: VERIFICATION_CHECKS.map((check) => ({
              check,
              passed: true,
              detail: check === 'row_counts' ? 'x'.repeat(201) : null,
            })),
          }),
          plan(),
        ),
      ),
    ).toBe('InconsistentMetadata');
  });

  it('refuse a restorable store reported as rebuilt', () => {
    // It would hide that the store was never restored.
    expect(
      codeOf(() => assertValidRestoreResult(result({ rebuilt: ['postgresql'] }), plan())),
    ).toBe('InconsistentMetadata');
  });

  it('refuse a restore that finished before it started', () => {
    expect(
      codeOf(() =>
        assertValidRestoreResult(result({ completedAt: '2026-03-10T02:00:00.000Z' }), plan()),
      ),
    ).toBe('InconsistentMetadata');
  });

  it('answer whether the mandatory checks passed', () => {
    expect(mandatoryChecksPassed(result())).toBe(true);
    expect(
      mandatoryChecksPassed(
        result({
          results: VERIFICATION_CHECKS.map((check) => ({
            check,
            passed: check !== 'rls_policies_present',
            detail: null,
          })),
        }),
      ),
    ).toBe(false);
  });
});

// ── Disaster-recovery plans ─────────────────────────────────────────────────

describe('disaster-recovery plans', () => {
  const drPlan = (overrides: Partial<DisasterRecoveryPlan> = {}): DisasterRecoveryPlan => ({
    planId: 'dr-production',
    environment: 'production',
    objectives: [
      { store: 'postgresql', rpoSeconds: 300, rtoSeconds: 3600 },
      { store: 'object_storage', rpoSeconds: 0, rtoSeconds: 3600 },
      { store: 'secrets', rpoSeconds: 0, rtoSeconds: 900 },
      { store: 'config', rpoSeconds: 0, rtoSeconds: 900 },
      { store: 'temporal', rpoSeconds: 300, rtoSeconds: 3600 },
      { store: 'redis_queues', rpoSeconds: 60, rtoSeconds: 900 },
    ],
    pitrWindowDays: PRODUCTION_PITR_WINDOW_DAYS,
    drillCadenceDays: 30,
    createdAt: NOW,
    ...overrides,
  });

  it('build when they match the objectives, and freeze through', () => {
    const built = createRecoveryPlan(drPlan());

    expect(Object.isFrozen(built)).toBe(true);
    expect(Object.isFrozen(built.objectives)).toBe(true);
  });

  it('accept a plan tighter than the document', () => {
    expect(
      codeOf(() =>
        createRecoveryPlan(
          drPlan({
            objectives: [
              { store: 'postgresql', rpoSeconds: 60, rtoSeconds: 1800 },
              { store: 'object_storage', rpoSeconds: 0, rtoSeconds: 3600 },
              { store: 'secrets', rpoSeconds: 0, rtoSeconds: 900 },
              { store: 'config', rpoSeconds: 0, rtoSeconds: 900 },
              { store: 'temporal', rpoSeconds: 300, rtoSeconds: 3600 },
              { store: 'redis_queues', rpoSeconds: 60, rtoSeconds: 900 },
            ],
          }),
        ),
      ),
    ).toBeNull();
  });

  it('refuse a plan looser than the document', () => {
    // A looser commitment is a promise the mechanism cannot keep.
    expect(
      codeOf(() =>
        createRecoveryPlan(
          drPlan({ objectives: [{ store: 'postgresql', rpoSeconds: 3600, rtoSeconds: 3600 }] }),
        ),
      ),
    ).toBe('InconsistentMetadata');

    expect(
      codeOf(() =>
        createRecoveryPlan(
          drPlan({ objectives: [{ store: 'postgresql', rpoSeconds: 300, rtoSeconds: 7200 }] }),
        ),
      ),
    ).toBe('InconsistentMetadata');
  });

  it('refuse a null RPO on a store that is not derived', () => {
    expect(
      codeOf(() =>
        createRecoveryPlan(
          drPlan({ objectives: [{ store: 'postgresql', rpoSeconds: null, rtoSeconds: 3600 }] }),
        ),
      ),
    ).toBe('InconsistentMetadata');
  });

  it('refuse a duplicated store', () => {
    expect(
      codeOf(() =>
        createRecoveryPlan(
          drPlan({
            objectives: [
              { store: 'postgresql', rpoSeconds: 300, rtoSeconds: 3600 },
              { store: 'postgresql', rpoSeconds: 300, rtoSeconds: 3600 },
            ],
          }),
        ),
      ),
    ).toBe('InconsistentMetadata');
  });

  it('refuse a zero PITR window or drill cadence', () => {
    expect(codeOf(() => createRecoveryPlan(drPlan({ pitrWindowDays: 0 })))).toBe(
      'InvalidRecoveryPoint',
    );
    expect(codeOf(() => createRecoveryPlan(drPlan({ drillCadenceDays: 0 })))).toBe(
      'InconsistentMetadata',
    );
  });

  it('report which restorable stores a plan does not commit to', () => {
    const partial = createRecoveryPlan(
      drPlan({ objectives: [{ store: 'postgresql', rpoSeconds: 300, rtoSeconds: 3600 }] }),
    );

    expect(uncoveredStores(partial)).toEqual([
      'object_storage',
      'secrets',
      'config',
      'temporal',
      'redis_queues',
    ]);
    expect(uncoveredStores(createRecoveryPlan(drPlan()))).toEqual([]);
  });

  it('never counts a derived store as uncovered', () => {
    expect(uncoveredStores(createRecoveryPlan(drPlan()))).not.toContain('vector_index');
  });
});

// ── Reports ─────────────────────────────────────────────────────────────────

describe('the backup report', () => {
  it('folds the inventory', () => {
    const report = buildBackupReport(createBackupManifest(manifest(), NOW));

    expect(report.backupId).toBe('backup-2026-03-10');
    expect(report.snapshotCount).toBe(6);
    expect(report.totalBytes).toBe(6 * 1_048_576);
    expect(report.storesCovered).toContain('postgresql');
    expect(report.storesMissing).toEqual([]);
    expect(Object.isFrozen(report)).toBe(true);
  });

  it('names a restorable store that is neither snapshotted nor excluded', () => {
    // This is the number that says the platform is less protected than it looks.
    const thin = manifest();
    const report = buildBackupReport({
      ...thin,
      backup: { ...thin.backup, snapshots: [snapshot()] },
    });

    expect(report.storesMissing).toEqual([
      'object_storage',
      'secrets',
      'config',
      'temporal',
      'redis_queues',
    ]);
  });

  it('carries the recovery window', () => {
    const report = buildBackupReport(createBackupManifest(manifest(), NOW));

    expect(report.recoveryWindow.from).toBe('2026-02-24T00:00:00.000Z');
    expect(report.recoveryWindow.to).toBe('2026-03-10T02:00:00.000Z');
  });
});

describe('the recovery report', () => {
  it('measures the achieved RTO against the tightest target', () => {
    // A restore is only as fast as the store with the least headroom.
    const report = buildRecoveryReport({
      result: result(),
      stores: ['postgresql', 'secrets'],
    });

    expect(report.durationSeconds).toBe(2400);
    expect(report.rtoTargetSeconds).toBe(900);
    expect(report.rtoMet).toBe(false);
  });

  it('reports the target met when it was', () => {
    const report = buildRecoveryReport({
      result: result({ completedAt: '2026-03-10T03:10:00.000Z' }),
      stores: ['postgresql'],
    });

    expect(report.durationSeconds).toBe(600);
    expect(report.rtoMet).toBe(true);
  });

  it('gates resuming traffic on the mandatory checks', () => {
    expect(buildRecoveryReport({ result: result(), stores: ['postgresql'] }).safeToResume).toBe(
      true,
    );

    const failed = buildRecoveryReport({
      result: result({
        outcome: 'failed_verification',
        results: VERIFICATION_CHECKS.map((check) => ({
          check,
          passed: check !== 'rls_policies_present',
          detail: null,
        })),
      }),
      stores: ['postgresql'],
    });

    expect(failed.safeToResume).toBe(false);
    expect(failed.checksFailed).toEqual(['rls_policies_present']);
  });

  it('lists the stores that were rebuilt rather than restored', () => {
    expect(buildRecoveryReport({ result: result(), stores: ['postgresql'] }).rebuiltStores).toEqual(
      ['vector_index', 'aggregates'],
    );
  });

  it('reports a null target when no store had one', () => {
    const report = buildRecoveryReport({ result: result(), stores: [] });

    expect(report.rtoTargetSeconds).toBeNull();
    expect(report.rtoMet).toBeNull();
  });

  it('is frozen', () => {
    expect(Object.isFrozen(buildRecoveryReport({ result: result(), stores: ['postgresql'] }))).toBe(
      true,
    );
  });
});

describe('backup export metadata', () => {
  it('mirrors the export convention', () => {
    const metadata = buildBackupExportMetadata({
      manifest: createBackupManifest(manifest(), NOW),
      exportedAt: NOW,
      checksum: DIGEST,
    });

    expect(metadata.exportSchemaVersion).toBe(BACKUP_EXPORT_SCHEMA_VERSION);
    expect(metadata.formatVersion).toBe(1);
    expect(metadata.exportedAt).toBe(NOW);
    expect(metadata.backupId).toBe('backup-2026-03-10');
    expect(Object.isFrozen(metadata)).toBe(true);
  });

  it('refuses a malformed export instant', () => {
    expect(
      codeOf(() =>
        buildBackupExportMetadata({
          manifest: createBackupManifest(manifest(), NOW),
          exportedAt: 'now',
          checksum: DIGEST,
        }),
      ),
    ).toBe('InvalidRecoveryPoint');
  });
});
