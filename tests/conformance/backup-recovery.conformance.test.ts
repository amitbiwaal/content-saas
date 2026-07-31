/**
 * The backup layer against the platform it describes.
 *
 * ── What only this file can check ───────────────────────────────────────────
 *
 * 1. IT DESCRIBES AND NEVER PERFORMS. No filesystem, no cloud SDK, no
 *    connection, no command, no scheduler. A module that could execute a
 *    restore would make the two-person approval `backup-recovery.md` §4
 *    requires advisory rather than structural.
 *
 * 2. THE CLASSIFICATION AND THE OBJECTIVES ARE THE DOCUMENT'S. Nine stores,
 *    three classes, an RPO and an RTO each — transcribed, and asserted against
 *    the file itself.
 *
 * 3. THE RLS CHECK IS MANDATORY. A restore that loses policies silently
 *    disables tenant isolation, so a plan that omits the check is refused.
 *
 * 4. NO SQL, NO ORM, NO DRIVER, NO HTTP, NO TIMER, NO GLOBAL.
 *
 * 5. THE DEVIATIONS, recorded so they cannot be forgotten.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  assertValidRestorePlan,
  BACKUP_ACTIONS,
  BACKUP_FORMATS,
  BACKUP_SCHEMA_VERSION,
  BACKUP_STORES,
  BackupError,
  createBackupManifest,
  DATA_CLASSES,
  isRestorable,
  MANDATORY_CHECKS,
  objectiveOf,
  PLATFORM_RESTORE_APPROVALS,
  PRODUCTION_PITR_WINDOW_DAYS,
  RLS_CHECK_THREAT_ID,
  STORE_OBJECTIVES,
  VERIFICATION_CHECKS,
  type BackupManifest,
  type BackupRepository,
  type BackupSnapshot,
  type RecoveryPlanRepository,
  type RestorePlan,
  type RestoreRepository,
} from '@contentos/database';
import { isKnownThreat, threatOf } from '@contentos/security';
import { describe, expect, it } from 'vitest';

const backupDir = new URL('../../packages/database/src/backup/', import.meta.url);

const codeOf = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, backupDir)), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

/** Every module this increment added. */
const MODULES = [
  'errors.ts',
  'model.ts',
  'restore.ts',
  'recovery.ts',
  'repository.ts',
  'service.ts',
] as const;

const NOW = '2026-03-10T12:00:00.000Z';
const DIGEST = 'c'.repeat(64);

const snapshot = (overrides: Partial<BackupSnapshot> = {}): BackupSnapshot => ({
  snapshotId: 'snap-pg',
  store: 'postgresql',
  format: 'physical_base',
  takenAt: '2026-03-10T02:00:00.000Z',
  sizeBytes: 1024,
  checksum: DIGEST,
  encryptionKeyId: 'kms.key-v3',
  ...overrides,
});

const manifest = (): BackupManifest =>
  createBackupManifest(
    {
      backup: {
        backupId: 'backup-001',
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
    },
    NOW,
  );

const plan = (overrides: Partial<RestorePlan> = {}): RestorePlan => ({
  planId: 'restore-001',
  backupId: 'backup-001',
  scope: 'full_platform',
  tenantId: null,
  targetPoint: {
    at: '2026-03-10T01:30:00.000Z',
    earliestAvailable: '2026-02-24T00:00:00.000Z',
    latestAvailable: '2026-03-10T02:00:00.000Z',
  },
  stores: ['postgresql'],
  freezeWrites: true,
  verification: [...VERIFICATION_CHECKS],
  approvals: 2,
  createdAt: NOW,
  ...overrides,
});

// ── 1 · It describes and never performs ─────────────────────────────────────

describe('the backup layer performs nothing', () => {
  it('touches no filesystem', () => {
    for (const file of MODULES) {
      const code = codeOf(file);
      expect(code).not.toMatch(/node:fs|node:path|readFile|writeFile|createReadStream|mkdir/);
    }
  });

  it('imports no cloud SDK — AWS, Azure or GCP', () => {
    for (const file of MODULES) {
      const code = codeOf(file);
      expect(code).not.toMatch(
        /@aws-sdk|aws-sdk|@azure\/|@google-cloud|googleapis|s3|blobservice/i,
      );
    }
  });

  it('opens no connection and writes no SQL', () => {
    for (const file of MODULES) {
      const code = codeOf(file);
      expect(code).not.toMatch(/from '(pg|postgres|mysql2|knex|drizzle|prisma|ioredis|redis)/);
      expect(code).not.toMatch(
        /SELECT .+ FROM |INSERT INTO|UPDATE .+ SET |DROP |pg_restore|pg_dump/i,
      );
    }
  });

  it('makes no HTTP call', () => {
    for (const file of MODULES) {
      expect(codeOf(file)).not.toMatch(/fetch\(|axios|got\(|https?:\/\/[a-z]/);
    }
  });

  it('sets no timer and schedules nothing', () => {
    // "Monthly logical restore, quarterly full-cluster restore" is an ops
    // calendar, not a cron this layer owns.
    for (const file of MODULES) {
      const code = codeOf(file);
      expect(code).not.toMatch(/setTimeout|setInterval|cron|schedule\(|Date\.now\(|new Date\(\)/);
    }
  });

  it('holds no global and no singleton state', () => {
    for (const file of MODULES) {
      const code = codeOf(file);
      expect(code).not.toMatch(/globalThis|process\.env/);
      expect(code).not.toMatch(/^(?:let|var) /m);
    }
  });

  it('imports no AI runtime, no Stripe and no feature package', () => {
    for (const file of MODULES) {
      const code = codeOf(file);
      expect(code).not.toMatch(/@contentos\/(ai|platform|content|events|storage)/);
      expect(code).not.toMatch(/stripe|openai|@anthropic/i);
    }
  });

  it('keeps the database package dependency-free', () => {
    const manifestJson = JSON.parse(read('../../packages/database/package.json')) as {
      dependencies?: Record<string, string>;
    };
    expect(manifestJson.dependencies ?? {}).toEqual({});
  });

  it('offers no execute, run or perform anywhere', () => {
    for (const file of MODULES) {
      const code = codeOf(file);
      expect(code).not.toMatch(/\b(?:executeRestore|runBackup|performRestore|takeBackup)\b/);
    }
  });

  it('ships repository interfaces only', () => {
    const repository = codeOf('repository.ts');
    expect(repository).toMatch(/interface BackupRepository/);
    expect(repository).toMatch(/interface RestoreRepository/);
    expect(repository).not.toMatch(/^export (?:async )?function/m);
    expect(repository).not.toMatch(/^export const/m);
    expect(repository).not.toMatch(/^export class/m);
  });

  it('offers no read of bytes and no delete on either port', () => {
    // §8 puts a retention lock on backup storage and requires two-person
    // approval for a deletion; a method here would be a way around it.
    const repository = codeOf('repository.ts');
    expect(repository).not.toMatch(/download|readBytes|stream|deleteManifest|deletePlan|purge/i);
  });

  it('are reachable as types from the barrel', () => {
    const backups: BackupRepository | null = null;
    const restores: RestoreRepository | null = null;
    const plans: RecoveryPlanRepository | null = null;

    expect([backups, restores, plans]).toEqual([null, null, null]);
  });
});

// ── 2 · The classification is the document's ────────────────────────────────

describe('the classification and objectives are transcribed', () => {
  const spec = read('../../contentos-docs/14-operations/backup-recovery.md');

  it('names the three classes the document uses', () => {
    expect(DATA_CLASSES).toEqual(['authoritative', 'semi_durable', 'derived']);
    expect(spec).toContain('Authoritative');
    expect(spec).toContain('Semi-durable');
    expect(spec).toContain('Derived');
  });

  it('gives an objective for every store, and no store without one', () => {
    expect(STORE_OBJECTIVES).toHaveLength(BACKUP_STORES.length);
    for (const store of BACKUP_STORES) {
      expect(objectiveOf(store)).not.toBeNull();
    }
  });

  it('matches the document’s PostgreSQL objective', () => {
    expect(spec).toContain('**≤ 5 min**');
    expect(objectiveOf('postgresql')?.rpoSeconds).toBe(300);
    expect(objectiveOf('postgresql')?.rtoSeconds).toBe(3600);
  });

  it('matches the document’s PITR window', () => {
    expect(spec).toContain('**14 days**');
    expect(PRODUCTION_PITR_WINDOW_DAYS).toBe(14);
  });

  it('classifies vectors, cache and aggregates as derived', () => {
    // "Backing up and restoring a large vector index adds a second recovery
    // path that must itself be tested."
    expect(spec).toContain('Derived - rebuilt, not restored');
    for (const store of ['vector_index', 'redis_cache', 'aggregates'] as const) {
      expect(objectiveOf(store)?.dataClass).toBe('derived');
      expect(isRestorable(store)).toBe(false);
    }
  });

  it('refuses a snapshot of a derived store', () => {
    expect(() =>
      createBackupManifest(
        {
          ...manifest(),
          backup: {
            ...manifest().backup,
            snapshots: [snapshot({ snapshotId: 'snap-vec', store: 'vector_index' })],
          },
        },
        NOW,
      ),
    ).toThrow(BackupError);
  });

  it('names the provider’s formats, never one this platform invented', () => {
    // A backup nobody but us can read cannot be restored without us.
    expect(BACKUP_FORMATS).not.toContain('contentos');
    for (const format of BACKUP_FORMATS) {
      expect(format).toMatch(/^[a-z_]+$/);
    }
  });
});

// ── 3 · The RLS check is mandatory ──────────────────────────────────────────

describe('a restore cannot skip the check that keeps tenants apart', () => {
  it('the document says it is mandatory, not optional', () => {
    const spec = read('../../contentos-docs/14-operations/backup-recovery.md');
    expect(spec).toContain('this check is mandatory, not optional');
    expect(spec).toContain('RLS policies present on every table');
  });

  it('and the model refuses a plan that omits it', () => {
    // Everything works, and every tenant can read every other tenant's rows.
    expect(() =>
      assertValidRestorePlan(plan({ verification: ['migration_version'] }), manifest()),
    ).toThrow(BackupError);
    expect(MANDATORY_CHECKS).toEqual(['rls_policies_present']);
  });

  it('names a threat the security model actually declares', () => {
    // T-06, cross-tenant data leakage — Critical.
    expect(isKnownThreat(RLS_CHECK_THREAT_ID)).toBe(true);
    expect(threatOf(RLS_CHECK_THREAT_ID)?.severity).toBe('critical');
    expect(threatOf(RLS_CHECK_THREAT_ID)?.category).toBe('tenant_isolation');
  });

  it('declares every check the document requires after a restore', () => {
    const spec = read('../../contentos-docs/14-operations/backup-recovery.md');
    expect(VERIFICATION_CHECKS).toEqual([
      'migration_version',
      'referential_integrity',
      'row_counts',
      'rls_policies_present',
      'credit_ledger_reconciles',
    ]);
    expect(spec).toContain('Migration version matches');
    expect(spec).toContain('referential integrity');
    expect(spec).toContain('credit ledger sum reconciles');
  });

  it('refuses a platform restore that does not freeze writes', () => {
    // Restoring while writes continue produces a split-brain.
    expect(() => assertValidRestorePlan(plan({ freezeWrites: false }), manifest())).toThrow(
      BackupError,
    );
  });

  it('refuses a platform restore with one approval', () => {
    expect(() => assertValidRestorePlan(plan({ approvals: 1 }), manifest())).toThrow(BackupError);
    expect(PLATFORM_RESTORE_APPROVALS).toBe(2);
  });
});

// ── 4 · Everything is immutable ─────────────────────────────────────────────

describe('every exported value is immutable', () => {
  it('freezes the objectives', () => {
    expect(Object.isFrozen(STORE_OBJECTIVES)).toBe(true);
    expect(Object.isFrozen(STORE_OBJECTIVES[0])).toBe(true);
  });

  it('freezes a manifest through', () => {
    const built = manifest();

    expect(Object.isFrozen(built)).toBe(true);
    expect(Object.isFrozen(built.backup)).toBe(true);
    expect(Object.isFrozen(built.backup.snapshots)).toBe(true);
    expect(Object.isFrozen(built.backup.snapshots[0])).toBe(true);
    expect(Object.isFrozen(built.recoveryPoint)).toBe(true);
  });

  it('refuses an edit to a recorded checksum', () => {
    // Editing one after verification passed is precisely the tampering the
    // checksum exists to detect.
    const built = manifest();
    expect(() => {
      (built.backup.snapshots[0] as { checksum: string }).checksum = 'd'.repeat(64);
    }).toThrow();
  });

  it('every builder validates before it freezes', () => {
    // A frozen invalid manifest would be permanently wrong.
    expect(() =>
      createBackupManifest({ ...manifest(), backup: { ...manifest().backup, snapshots: [] } }, NOW),
    ).toThrow(BackupError);
  });
});

// ── 5 · Deviations ──────────────────────────────────────────────────────────

describe('recorded deviations', () => {
  it('DEVIATION: this lives in packages/database, a CORE package', () => {
    // Backup describes the persistence tier, and the mandatory verification
    // checks — migration version, RLS policies present — are this package's
    // own knowledge. Core is also universally importable, which a restore
    // report read by operations tooling, the API and workers needs.
    const cruiser = read('../../.dependency-cruiser.cjs');
    expect(cruiser).toContain('security|database|domain|integrations|observability');
  });

  it('DEVIATION: export models are MIRRORED, not imported', () => {
    // `ContentExport` and `ExportMetadata` live in `packages/ai`, a FEATURE
    // package this core one may not import — `core-never-imports-feature`. So
    // the CONVENTION is followed (schema version, format version, exportedAt,
    // unsupported versions refused) without the import.
    expect(codeOf('recovery.ts')).toMatch(/interface BackupExportMetadata/);
    expect(codeOf('recovery.ts')).toMatch(/exportSchemaVersion/);

    // The IMPORT, not the substring: `BackupExportMetadata` legitimately
    // contains the feature package's type name, which is the point — it is the
    // same convention under this package's own name.
    for (const file of MODULES) {
      const code = codeOf(file);
      expect(code).not.toMatch(/^import[^;]*\b(?:ContentExport|ExportMetadata)\b/m);
      expect(code).not.toMatch(/exports\/model\.js|@contentos\/ai/);
    }
  });

  it('DEVIATION: the audit event is structurally typed, not imported', () => {
    // `AuditEvent` is `@contentos/security`'s. This package declares nothing as
    // a dependency and that is worth keeping, so `BackupAuditEvent` is the same
    // shape and the composition root passes it to `AuditService`.
    expect(codeOf('service.ts')).toMatch(/interface BackupAuditEvent/);
    expect(codeOf('service.ts')).not.toMatch(/@contentos\/security/);

    // And it must satisfy the audit service's own action-shape rule, or the
    // record would be refused at the door and the action would go unaudited.
    for (const action of Object.values(BACKUP_ACTIONS)) {
      expect(action).toMatch(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:_[a-z0-9]+)*)+$/);
    }
  });

  it('DEVIATION: the RLS threat is an ID, not a SecurityFinding', () => {
    // Projecting a failed check into a `SecurityFinding` would need
    // `@contentos/security`. The threat id is enough for a composition root to
    // build one, and it is asserted here to be a threat that exists.
    expect(codeOf('restore.ts')).toMatch(/RLS_CHECK_THREAT_ID = 'T-06'/);
    expect(codeOf('restore.ts')).not.toMatch(/SecurityFinding/);
  });

  it('DEVIATION: a DR plan may be tighter than the objectives, never looser', () => {
    // A looser commitment is a promise the mechanism cannot keep.
    expect(codeOf('recovery.ts')).toMatch(/objective\.rtoSeconds > declared\.rtoSeconds/);
    expect(codeOf('recovery.ts')).toMatch(/objective\.rpoSeconds > declared\.rpoSeconds/);
  });

  it('DEVIATION: a derived store has a NULL RPO, not zero', () => {
    // Zero would read as "loses nothing"; a derived store loses everything and
    // then recomputes it.
    expect(objectiveOf('vector_index')?.rpoSeconds).toBeNull();
    expect(objectiveOf('object_storage')?.rpoSeconds).toBe(0);
  });

  it('DEVIATION: a manifest must account for every restorable store', () => {
    // Snapshotted or explicitly excluded. A store silently absent is one nobody
    // notices is unprotected until a restore needs it.
    expect(codeOf('model.ts')).toMatch(/neither snapshotted nor excluded/);
  });

  it('DEVIATION: no seeded manifest or plan catalogue', () => {
    // A built-in manifest would be this increment asserting that a backup
    // exists, which is what a recorded manifest establishes.
    for (const file of MODULES) {
      expect(codeOf(file)).not.toMatch(/BUILT_IN_MANIFESTS|DEFAULT_BACKUPS|SEED_/);
    }
  });
});
