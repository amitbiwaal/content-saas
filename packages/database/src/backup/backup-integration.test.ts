/**
 * The three services against in-memory ports.
 *
 * The unit suite checks each model on values. This runs the whole cycle —
 * record a manifest, approve a plan against it, record the result, read both
 * reports, ask the posture — and asserts the thing only the wiring can show:
 * that a plan is validated against the manifest the SERVICE loaded, not one the
 * caller supplied, and that nothing anywhere touches a store.
 */

import { describe, expect, it } from 'vitest';

import { BackupError } from './errors.js';
import { BACKUP_SCHEMA_VERSION, type BackupManifest, type BackupSnapshot } from './model.js';
import { PRODUCTION_PITR_WINDOW_DAYS, type DisasterRecoveryPlan } from './recovery.js';
import type {
  BackupRepository,
  BackupSlice,
  RecoveryPlanRepository,
  RestoreRepository,
  RestoreSlice,
} from './repository.js';
import { VERIFICATION_CHECKS, type RestorePlan, type RestoreResult } from './restore.js';
import {
  BACKUP_ACTIONS,
  createBackupService,
  createDisasterRecoveryService,
  createRestoreService,
  toAuditEvent,
} from './service.js';

const NOW = '2026-03-10T12:00:00.000Z';
const DIGEST = 'b'.repeat(64);

/** In-memory ports. They model uniqueness and window selection, nothing else. */
function stores() {
  const manifests: BackupManifest[] = [];
  const plans: RestorePlan[] = [];
  const results: RestoreResult[] = [];
  const recoveryPlans: DisasterRecoveryPlan[] = [];
  const calls: string[] = [];

  const backups: BackupRepository = {
    recordManifest(manifest) {
      calls.push('backups.recordManifest');
      if (manifests.some((m) => m.backup.backupId === manifest.backup.backupId)) {
        throw new BackupError('MalformedManifest', 'backupId', 'That backup is already recorded.');
      }
      manifests.push(manifest);
      return Promise.resolve(manifest);
    },
    loadManifest(backupId) {
      calls.push('backups.loadManifest');
      return Promise.resolve(manifests.find((m) => m.backup.backupId === backupId) ?? null);
    },
    findManifestsCovering(environment, at) {
      calls.push('backups.findManifestsCovering');
      const instant = Date.parse(at);
      return Promise.resolve(
        manifests.filter(
          (m) =>
            m.backup.metadata.environment === environment &&
            Date.parse(m.recoveryPoint.earliestAvailable) <= instant &&
            Date.parse(m.recoveryPoint.latestAvailable) >= instant,
        ),
      );
    },
    listManifests(): Promise<BackupSlice> {
      calls.push('backups.listManifests');
      return Promise.resolve({ manifests: [...manifests], next: null });
    },
  };

  const restores: RestoreRepository = {
    recordPlan(plan) {
      calls.push('restores.recordPlan');
      if (plans.some((p) => p.planId === plan.planId)) {
        throw new BackupError('IncompatibleRestorePlan', 'planId', 'That plan already exists.');
      }
      plans.push(plan);
      return Promise.resolve(plan);
    },
    loadPlan(planId) {
      calls.push('restores.loadPlan');
      return Promise.resolve(plans.find((p) => p.planId === planId) ?? null);
    },
    recordResult(result) {
      calls.push('restores.recordResult');
      results.push(result);
      return Promise.resolve(result);
    },
    loadResult(planId) {
      calls.push('restores.loadResult');
      return Promise.resolve(results.find((r) => r.planId === planId) ?? null);
    },
    listResults(): Promise<RestoreSlice> {
      calls.push('restores.listResults');
      return Promise.resolve({ results: [...results] });
    },
  };

  const plansRepo: RecoveryPlanRepository = {
    savePlan(plan) {
      calls.push('plans.savePlan');
      recoveryPlans.push(plan);
      return Promise.resolve(plan);
    },
    loadPlan(environment) {
      calls.push('plans.loadPlan');
      return Promise.resolve(recoveryPlans.find((p) => p.environment === environment) ?? null);
    },
  };

  return { backups, restores, plansRepo, manifests, plans, results, calls };
}

const snapshot = (overrides: Partial<BackupSnapshot> = {}): BackupSnapshot => ({
  snapshotId: 'snap-pg-001',
  store: 'postgresql',
  format: 'physical_base',
  takenAt: '2026-03-10T02:00:00.000Z',
  sizeBytes: 2_097_152,
  checksum: DIGEST,
  encryptionKeyId: 'kms.key-v3',
  ...overrides,
});

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
      snapshot({ snapshotId: 'snap-obj', store: 'object_storage', format: 'object_version' }),
      snapshot({ snapshotId: 'snap-sec', store: 'secrets', format: 'escrow' }),
      snapshot({ snapshotId: 'snap-cfg', store: 'config', format: 'logical' }),
      snapshot({ snapshotId: 'snap-tmp', store: 'temporal', format: 'logical' }),
      snapshot({ snapshotId: 'snap-rdq', store: 'redis_queues', format: 'logical' }),
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
  completedAt: '2026-03-10T03:30:00.000Z',
  results: VERIFICATION_CHECKS.map((check) => ({ check, passed: true, detail: null })),
  rebuilt: ['vector_index'],
  ...overrides,
});

const drPlan = (): DisasterRecoveryPlan => ({
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
});

// ── One cycle ───────────────────────────────────────────────────────────────

describe('one backup and restore cycle, end to end', () => {
  it('records a manifest, approves a plan against it and reports on both', async () => {
    const s = stores();
    const backupService = createBackupService({ backups: s.backups });
    const restoreService = createRestoreService({ restores: s.restores, backups: s.backups });

    await backupService.recordManifest(manifest(), NOW);
    const approved = await restoreService.approvePlan(plan());
    await restoreService.recordResult(result());

    expect(approved.planId).toBe('restore-001');
    expect(s.manifests).toHaveLength(1);
    expect(s.plans).toHaveLength(1);
    expect(s.results).toHaveLength(1);

    const inventory = await backupService.report('backup-2026-03-10');
    expect(inventory?.snapshotCount).toBe(6);
    expect(inventory?.storesMissing).toEqual([]);

    const recovery = await restoreService.report('restore-001');
    expect(recovery?.outcome).toBe('verified');
    expect(recovery?.durationSeconds).toBe(1800);
    expect(recovery?.safeToResume).toBe(true);
  });

  it('loads the manifest itself rather than trusting the caller', async () => {
    // A plan approved against a manifest the caller constructed would be a
    // restore from a backup nobody checked.
    const s = stores();
    const restoreService = createRestoreService({ restores: s.restores, backups: s.backups });

    await expect(restoreService.approvePlan(plan())).rejects.toBeInstanceOf(BackupError);
    expect(s.calls).toContain('backups.loadManifest');
    expect(s.plans).toHaveLength(0);
  });

  it('refuses a result for a plan nobody approved', async () => {
    const s = stores();
    const restoreService = createRestoreService({ restores: s.restores, backups: s.backups });

    await expect(restoreService.recordResult(result())).rejects.toMatchObject({
      code: 'IncompatibleRestorePlan',
    });
    expect(s.results).toHaveLength(0);
  });

  it('refuses a plan that omits the mandatory RLS check, after loading the manifest', async () => {
    const s = stores();
    await createBackupService({ backups: s.backups }).recordManifest(manifest(), NOW);
    const restoreService = createRestoreService({ restores: s.restores, backups: s.backups });

    await expect(
      restoreService.approvePlan(plan({ verification: ['row_counts'] })),
    ).rejects.toMatchObject({ code: 'IncompatibleRestorePlan' });
    expect(s.plans).toHaveLength(0);
  });

  it('refuses a result that claims verified with a failing check', async () => {
    const s = stores();
    await createBackupService({ backups: s.backups }).recordManifest(manifest(), NOW);
    const restoreService = createRestoreService({ restores: s.restores, backups: s.backups });
    await restoreService.approvePlan(plan());

    await expect(
      restoreService.recordResult(
        result({
          results: VERIFICATION_CHECKS.map((check) => ({
            check,
            passed: check !== 'rls_policies_present',
            detail: null,
          })),
        }),
      ),
    ).rejects.toMatchObject({ code: 'InconsistentMetadata' });
    expect(s.results).toHaveLength(0);
  });

  it('writes nothing when it refuses', async () => {
    const s = stores();
    const backupService = createBackupService({ backups: s.backups });

    await expect(
      backupService.recordManifest(
        { ...manifest(), backup: { ...manifest().backup, snapshots: [] } },
        NOW,
      ),
    ).rejects.toBeInstanceOf(BackupError);

    expect(s.manifests).toHaveLength(0);
    expect(s.calls).not.toContain('backups.recordManifest');
  });

  it('returns null rather than an empty report for an unknown backup', async () => {
    const s = stores();
    expect(await createBackupService({ backups: s.backups }).report('nope')).toBeNull();
  });
});

// ── Selection ───────────────────────────────────────────────────────────────

describe('restore point selection', () => {
  it('finds the manifests that can serve an instant', async () => {
    const s = stores();
    const service = createBackupService({ backups: s.backups });
    await service.recordManifest(manifest(), NOW);

    const covering = await service.manifestsCovering('production', '2026-03-01T00:00:00.000Z');
    expect(covering).toHaveLength(1);
  });

  it('returns none for an instant outside every window', async () => {
    // A legitimate answer the caller must handle: §4 requires rejecting with
    // the earliest available time, not serving from the nearest backup.
    const s = stores();
    const service = createBackupService({ backups: s.backups });
    await service.recordManifest(manifest(), NOW);

    expect(await service.manifestsCovering('production', '2025-01-01T00:00:00.000Z')).toHaveLength(
      0,
    );
  });

  it('never offers a staging manifest for a production restore', async () => {
    const s = stores();
    const service = createBackupService({ backups: s.backups });
    await service.recordManifest(
      {
        ...manifest(),
        backup: {
          ...manifest().backup,
          backupId: 'backup-staging',
          metadata: { ...manifest().backup.metadata, environment: 'staging' },
        },
      },
      NOW,
    );

    expect(await service.manifestsCovering('production', '2026-03-01T00:00:00.000Z')).toHaveLength(
      0,
    );
  });
});

// ── Posture ─────────────────────────────────────────────────────────────────

describe('the recovery posture is derived, never asserted', () => {
  it('reports an unprotected environment as unprotected', async () => {
    // An unverified chain can silently break for weeks and be discovered only
    // when it is needed.
    const s = stores();
    const service = createDisasterRecoveryService({ plans: s.plansRepo, backups: s.backups });

    const posture = await service.posture('production', NOW);

    expect(posture.hasPlan).toBe(false);
    expect(posture.hasRecentBackup).toBe(false);
    expect(posture.lastBackupAt).toBeNull();
    expect(Object.isFrozen(posture)).toBe(true);
  });

  it('reports a fully covered environment', async () => {
    const s = stores();
    await createBackupService({ backups: s.backups }).recordManifest(manifest(), NOW);
    const service = createDisasterRecoveryService({ plans: s.plansRepo, backups: s.backups });
    await service.declarePlan(drPlan());

    const posture = await service.posture('production', '2026-03-01T00:00:00.000Z');

    expect(posture.hasPlan).toBe(true);
    expect(posture.uncoveredStores).toEqual([]);
    expect(posture.hasRecentBackup).toBe(true);
    expect(posture.lastBackupAt).toBe('2026-03-10T02:30:00.000Z');
  });

  it('names the stores a partial plan does not commit to', async () => {
    const s = stores();
    const service = createDisasterRecoveryService({ plans: s.plansRepo, backups: s.backups });
    await service.declarePlan({
      ...drPlan(),
      objectives: [{ store: 'postgresql', rpoSeconds: 300, rtoSeconds: 3600 }],
    });

    const posture = await service.posture('production', NOW);

    expect(posture.uncoveredStores).toEqual([
      'object_storage',
      'secrets',
      'config',
      'temporal',
      'redis_queues',
    ]);
  });

  it('refuses a plan looser than the platform’s objectives', async () => {
    const s = stores();
    const service = createDisasterRecoveryService({ plans: s.plansRepo, backups: s.backups });

    await expect(
      service.declarePlan({
        ...drPlan(),
        objectives: [{ store: 'postgresql', rpoSeconds: 7200, rtoSeconds: 3600 }],
      }),
    ).rejects.toBeInstanceOf(BackupError);
  });
});

// ── Nothing is executed ─────────────────────────────────────────────────────

describe('the services perform nothing', () => {
  it('freeze all three', () => {
    const s = stores();
    expect(Object.isFrozen(createBackupService({ backups: s.backups }))).toBe(true);
    expect(
      Object.isFrozen(createRestoreService({ restores: s.restores, backups: s.backups })),
    ).toBe(true);
    expect(
      Object.isFrozen(createDisasterRecoveryService({ plans: s.plansRepo, backups: s.backups })),
    ).toBe(true);
  });

  it('offer no execute, run or schedule on any surface', () => {
    const s = stores();
    const surface = [
      ...Object.keys(createBackupService({ backups: s.backups })),
      ...Object.keys(createRestoreService({ restores: s.restores, backups: s.backups })),
      ...Object.keys(createDisasterRecoveryService({ plans: s.plansRepo, backups: s.backups })),
    ];

    for (const forbidden of [
      'execute',
      'run',
      'perform',
      'schedule',
      'start',
      'restore',
      'backup',
    ]) {
      expect(surface).not.toContain(forbidden);
    }
  });

  it('reach only the description ports, never a store', async () => {
    const s = stores();
    await createBackupService({ backups: s.backups }).recordManifest(manifest(), NOW);

    for (const call of s.calls) {
      expect(call).toMatch(/^(?:backups|restores|plans)\./);
    }
  });
});

// ── The audit bridge ────────────────────────────────────────────────────────

describe('a backup action projects onto the frozen audit shape', () => {
  const event = () =>
    toAuditEvent({
      action: BACKUP_ACTIONS.restoreApproved,
      actorId: '018f7a1e-0000-7000-8000-000000000001',
      actorKind: 'operator',
      organizationId: '018f7a1e-0000-7000-8000-0000000000aa',
      tenantId: null,
      correlationId: '018f7a1e-0000-7000-8000-0000000000dd',
      targetKind: 'restore_plan',
      targetId: 'restore-001',
      reason: 'SEV1 restore authorised by two approvers.',
      stepUpSatisfied: true,
    });

  it('files under administration, per T-25', () => {
    expect(event().category).toBe('administration');
  });

  it('produces actions the frozen audit validator accepts', () => {
    // Dot-namespaced, at least two segments — or the record would be refused at
    // the door and the action would go unaudited.
    for (const action of Object.values(BACKUP_ACTIONS)) {
      expect(action).toMatch(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:_[a-z0-9]+)*)+$/);
    }
  });

  it('records the two-person approval as a step-up', () => {
    expect(event().stepUpSatisfied).toBe(true);
  });

  it('is deep-frozen', () => {
    const built = event();
    expect(Object.isFrozen(built)).toBe(true);
    expect(Object.isFrozen(built.target)).toBe(true);
    expect(Object.isFrozen(built.actor)).toBe(true);
  });

  it('takes no transaction handle, so it cannot write the record itself', () => {
    // `audit.md` requires the record in the ACTION's transaction; that handle
    // is deliberately absent here.
    expect(Object.keys(event())).not.toContain('tx');
  });
});
