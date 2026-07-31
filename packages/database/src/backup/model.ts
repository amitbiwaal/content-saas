/**
 * Backups, as data — `14-operations/backup-recovery.md`.
 *
 * ── It DESCRIBES a backup. It never takes one ──────────────────────────────
 * Nothing here reads a file, opens a connection, calls a cloud API or schedules
 * anything. The mechanisms are the provider's — managed PITR, object
 * versioning, the secret manager's own history — and this is the vocabulary for
 * describing what they produced, validating that the description is coherent,
 * and deciding whether a given restore can be satisfied by it.
 *
 * A module that could execute a backup could also execute a restore, and a
 * restore is the one operation in this system that can destroy data at scale.
 * The absence of any I/O here is the control.
 *
 * ── The classification comes from the document ─────────────────────────────
 * §3.1 divides every store into authoritative, semi-durable and derived, and
 * §3.2 gives each an RPO, an RTO and a mechanism. That table is transcribed,
 * not invented: the classification is what decides whether a store is restored
 * or rebuilt, and getting it wrong means either a second recovery path nobody
 * tested, or a rebuild of something that had no source.
 *
 * ── Why derived stores are not backed up ──────────────────────────────────
 * "Every embedding traces to an Evidence Bank row in PostgreSQL and its raw
 * document in object storage. Re-embedding is a bounded, parallelizable batch
 * job… whereas backing up and restoring a large vector index adds a second
 * recovery path that must itself be tested." So a manifest that claimed a
 * snapshot of a derived store is refused rather than stored.
 */

import {
  assertChecksum,
  assertIdentifier,
  assertInstant,
  assertPresent,
  BackupError,
  deepFreeze,
} from './errors.js';

/**
 * How a store is recovered — §3.1.
 *
 * `derived` is the interesting one: it is rebuilt from an authoritative source,
 * never restored, so it has no RPO at all.
 */
export const DATA_CLASSES = ['authoritative', 'semi_durable', 'derived'] as const;

export type DataClass = (typeof DATA_CLASSES)[number];

export function isDataClass(value: unknown): value is DataClass {
  return typeof value === 'string' && (DATA_CLASSES as readonly string[]).includes(value);
}

/** Every store §3.2 gives an objective for, in that table's order. */
export const BACKUP_STORES = [
  'postgresql',
  'object_storage',
  'secrets',
  'config',
  'temporal',
  'redis_queues',
  'redis_cache',
  'vector_index',
  'aggregates',
] as const;

export type BackupStore = (typeof BACKUP_STORES)[number];

export function isBackupStore(value: unknown): value is BackupStore {
  return typeof value === 'string' && (BACKUP_STORES as readonly string[]).includes(value);
}

/**
 * How each store is protected — §3.2, transcribed.
 *
 * `rpoSeconds: null` means the store has no recovery point because it is not
 * recovered: it is rebuilt. Null rather than zero, because zero would read as
 * "loses nothing", and a derived store loses everything and then recomputes it.
 */
export interface StoreObjective {
  readonly store: BackupStore;
  readonly dataClass: DataClass;
  /** Maximum acceptable data loss. Null for a derived store. */
  readonly rpoSeconds: number | null;
  /** Maximum acceptable time to recover. */
  readonly rtoSeconds: number;
  /** What actually protects it. Prose from the document, never a command. */
  readonly mechanism: string;
}

const MINUTE = 60;
const HOUR = 3600;

export const STORE_OBJECTIVES: readonly StoreObjective[] = Object.freeze(
  (
    [
      {
        store: 'postgresql',
        dataClass: 'authoritative',
        rpoSeconds: 5 * MINUTE,
        rtoSeconds: HOUR,
        mechanism: 'Managed daily full plus continuous WAL archiving (PITR)',
      },
      {
        store: 'object_storage',
        dataClass: 'authoritative',
        rpoSeconds: 0,
        rtoSeconds: HOUR,
        mechanism: 'Object versioning, lifecycle, cross-account replication',
      },
      {
        store: 'secrets',
        dataClass: 'authoritative',
        rpoSeconds: 0,
        rtoSeconds: 15 * MINUTE,
        mechanism: "Secret manager's own versioning plus an encrypted offline escrow copy",
      },
      {
        store: 'config',
        dataClass: 'authoritative',
        rpoSeconds: 0,
        rtoSeconds: 15 * MINUTE,
        mechanism: 'Git, mirrored',
      },
      {
        store: 'temporal',
        dataClass: 'semi_durable',
        rpoSeconds: 5 * MINUTE,
        rtoSeconds: HOUR,
        mechanism: 'Persistence store backed up under the same PITR policy',
      },
      {
        store: 'redis_queues',
        dataClass: 'semi_durable',
        rpoSeconds: MINUTE,
        rtoSeconds: 15 * MINUTE,
        mechanism: 'AOF everysec, with queue reconciliation on restart',
      },
      {
        store: 'redis_cache',
        dataClass: 'derived',
        rpoSeconds: null,
        rtoSeconds: 0,
        mechanism: 'Cold start; no restore',
      },
      {
        store: 'vector_index',
        dataClass: 'derived',
        rpoSeconds: null,
        rtoSeconds: 4 * HOUR,
        mechanism: 'Rebuild job from PostgreSQL and object storage',
      },
      {
        store: 'aggregates',
        dataClass: 'derived',
        rpoSeconds: null,
        rtoSeconds: 2 * HOUR,
        mechanism: 'Recompute job',
      },
    ] satisfies readonly StoreObjective[]
  ).map((objective) => Object.freeze(objective)),
);

const OBJECTIVE_BY_STORE: ReadonlyMap<BackupStore, StoreObjective> = new Map(
  STORE_OBJECTIVES.map((objective) => [objective.store, objective]),
);

export function objectiveOf(store: BackupStore): StoreObjective | null {
  return OBJECTIVE_BY_STORE.get(store) ?? null;
}

/** Is this store restored from a backup, or rebuilt from a source? */
export function isRestorable(store: BackupStore): boolean {
  return OBJECTIVE_BY_STORE.get(store)?.dataClass !== 'derived';
}

/**
 * How a snapshot is encoded.
 *
 * Deliberately the provider's own forms rather than a format this platform
 * invented: a backup nobody but us can read is one that cannot be restored
 * without us, which is the opposite of what a disaster-recovery artefact is
 * for. `logical` is the nightly dump the verification job restores into a
 * scratch database.
 */
export const BACKUP_FORMATS = [
  'physical_base',
  'wal_segment',
  'logical',
  'object_version',
  'escrow',
] as const;

export type BackupFormat = (typeof BACKUP_FORMATS)[number];

export function isBackupFormat(value: unknown): value is BackupFormat {
  return typeof value === 'string' && (BACKUP_FORMATS as readonly string[]).includes(value);
}

/**
 * The manifest schema version.
 *
 * Mirrors the export convention (S4.8): every artefact carries its schema
 * version, unsupported versions are refused, and nothing is upgraded
 * automatically. A manifest written by a newer build and silently misread by an
 * older one is a restore that appears to succeed against the wrong data.
 */
export const BACKUP_SCHEMA_VERSION = 1;

export const SUPPORTED_BACKUP_SCHEMA_VERSIONS: readonly number[] = Object.freeze([1]);

export type BackupId = string;
export type SnapshotId = string;

/**
 * The inventory row §5 requires: store, timestamp, size, checksum, key id.
 *
 * `encryptionKeyId` is an identifier, never a key: "keys rotated annually;
 * older backups remain decryptable via retained key versions", so which VERSION
 * decrypts this snapshot is the fact worth recording, and the key itself is
 * never in this system.
 */
export interface BackupSnapshot {
  readonly snapshotId: SnapshotId;
  readonly store: BackupStore;
  readonly format: BackupFormat;
  /** When the snapshot was taken. Never when it was recorded. */
  readonly takenAt: string;
  readonly sizeBytes: number;
  readonly checksum: string;
  readonly encryptionKeyId: string;
}

/**
 * What a backup run produced, beyond its snapshots.
 *
 * Separate from `Backup` because it is the part an operator reads first when
 * choosing a restore point, and the part a compliance export needs on its own.
 */
export interface BackupMetadata {
  readonly schemaVersion: number;
  /** Where it came from. `production`, `staging` — an identifier, not a URL. */
  readonly environment: string;
  /** What the platform was at, so a restore knows which migrations to expect. */
  readonly migrationVersion: string;
  /** The oldest instant this backup set can restore to. */
  readonly retainedFrom: string;
  /** The newest. Together these are the PITR window. */
  readonly retainedUntil: string;
}

/**
 * One backup run.
 *
 * `completedAt` is when the run finished; each snapshot carries its own
 * `takenAt`, because a run that spans stores does not take them all at the same
 * instant and pretending otherwise would overstate the recovery point.
 */
export interface Backup {
  readonly backupId: BackupId;
  readonly metadata: BackupMetadata;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly snapshots: readonly BackupSnapshot[];
}

/**
 * A backup and everything needed to select and verify it.
 *
 * The manifest is what a restore reads. It is deliberately not the backup
 * itself: bytes live at the provider, and this system holds only their
 * description.
 */
export interface BackupManifest {
  readonly backup: Backup;
  /** The earliest recovery point this manifest can serve. */
  readonly recoveryPoint: RecoveryPoint;
  /** Stores this run deliberately did not snapshot, and why. */
  readonly excluded: readonly ExcludedStore[];
}

export interface ExcludedStore {
  readonly store: BackupStore;
  /** Enumerated, never free text — a report groups on it. */
  readonly reason: 'derived_rebuilt' | 'not_deployed' | 'covered_elsewhere';
}

/**
 * An instant a restore can target.
 *
 * Carries its window, because "can we restore to T" is unanswerable without it
 * and §4 requires a request outside the window to be "rejected with the
 * earliest available time" rather than merely refused.
 */
export interface RecoveryPoint {
  readonly at: string;
  readonly earliestAvailable: string;
  readonly latestAvailable: string;
}

const MAX_TEXT_LENGTH = 512;

function assertText(value: unknown, field: string, why: string): string {
  assertPresent(value, field, why);
  const text = value as string;
  if (text.length > MAX_TEXT_LENGTH) {
    throw new BackupError(
      'MalformedManifest',
      field,
      `'${field}' is longer than ${String(MAX_TEXT_LENGTH)} characters. A report field that wide eventually holds a connection string.`,
    );
  }
  return text;
}

export function assertValidSnapshot(snapshot: BackupSnapshot, now: string): BackupSnapshot {
  assertIdentifier(snapshot.snapshotId, 'snapshotId');
  assertIdentifier(snapshot.encryptionKeyId, 'encryptionKeyId');
  assertInstant(snapshot.takenAt, 'takenAt', 'FutureBackupTimestamp');
  assertChecksum(snapshot.checksum, 'checksum');

  if (!isBackupStore(snapshot.store)) {
    throw new BackupError(
      'UnknownStore',
      'store',
      `'${String(snapshot.store)}' is not a store this build classifies. Available: ${BACKUP_STORES.join(', ')}.`,
    );
  }
  if (!isBackupFormat(snapshot.format)) {
    throw new BackupError(
      'UnsupportedFormat',
      'format',
      `'${String(snapshot.format)}' is not a backup format. Available: ${BACKUP_FORMATS.join(', ')}.`,
    );
  }
  if (!isRestorable(snapshot.store)) {
    // "Backing up and restoring a large vector index adds a second recovery
    // path that must itself be tested." A snapshot of a derived store is a
    // recovery path nobody planned for.
    throw new BackupError(
      'InconsistentMetadata',
      'store',
      `'${snapshot.store}' is a derived store: it is rebuilt from its source, never restored. A snapshot of it is a second recovery path nobody tested.`,
    );
  }
  if (!Number.isSafeInteger(snapshot.sizeBytes) || snapshot.sizeBytes < 0) {
    throw new BackupError(
      'InconsistentMetadata',
      'sizeBytes',
      'A snapshot size is a non-negative whole number of bytes.',
    );
  }
  if (
    Date.parse(snapshot.takenAt) > Date.parse(assertInstant(now, 'now', 'InvalidRecoveryPoint'))
  ) {
    throw new BackupError(
      'FutureBackupTimestamp',
      'takenAt',
      'A snapshot cannot have been taken in the future. That is a clock skew or a fabricated inventory row, and either makes a restore target data that does not exist.',
    );
  }

  return snapshot;
}

export function assertValidMetadata(metadata: BackupMetadata): BackupMetadata {
  if (!SUPPORTED_BACKUP_SCHEMA_VERSIONS.includes(metadata.schemaVersion)) {
    throw new BackupError(
      'InvalidBackupVersion',
      'schemaVersion',
      `Manifest schema version ${String(metadata.schemaVersion)} is not supported by this build. Supported: ${SUPPORTED_BACKUP_SCHEMA_VERSIONS.join(', ')}. Nothing is upgraded automatically: a manifest misread by an older build is a restore against the wrong data.`,
    );
  }

  assertIdentifier(metadata.environment, 'environment');
  assertText(metadata.migrationVersion, 'migrationVersion', 'a restore verifies against it.');
  assertInstant(metadata.retainedFrom, 'retainedFrom', 'InvalidRecoveryPoint');
  assertInstant(metadata.retainedUntil, 'retainedUntil', 'InvalidRecoveryPoint');

  if (Date.parse(metadata.retainedUntil) < Date.parse(metadata.retainedFrom)) {
    throw new BackupError(
      'InconsistentMetadata',
      'retainedUntil',
      'A retention window cannot end before it begins.',
    );
  }

  return metadata;
}

export function assertValidRecoveryPoint(point: RecoveryPoint): RecoveryPoint {
  assertInstant(point.at, 'at', 'InvalidRecoveryPoint');
  assertInstant(point.earliestAvailable, 'earliestAvailable', 'InvalidRecoveryPoint');
  assertInstant(point.latestAvailable, 'latestAvailable', 'InvalidRecoveryPoint');

  const at = Date.parse(point.at);
  const earliest = Date.parse(point.earliestAvailable);
  const latest = Date.parse(point.latestAvailable);

  if (latest < earliest) {
    throw new BackupError(
      'InvalidRecoveryPoint',
      'latestAvailable',
      'A recovery window cannot end before it begins.',
    );
  }
  if (at < earliest || at > latest) {
    // §4: a request outside the window is "rejected with the earliest
    // available time" — so the message carries it.
    throw new BackupError(
      'InvalidRecoveryPoint',
      'at',
      `${point.at} is outside the recovery window. The earliest available point is ${point.earliestAvailable} and the latest is ${point.latestAvailable}.`,
    );
  }

  return point;
}

export function assertValidManifest(manifest: BackupManifest, now: string): BackupManifest {
  const { backup } = manifest;

  assertIdentifier(backup.backupId, 'backupId');
  assertInstant(backup.startedAt, 'startedAt', 'FutureBackupTimestamp');
  assertInstant(backup.completedAt, 'completedAt', 'FutureBackupTimestamp');
  assertValidMetadata(backup.metadata);
  assertValidRecoveryPoint(manifest.recoveryPoint);

  if (Date.parse(backup.completedAt) < Date.parse(backup.startedAt)) {
    throw new BackupError(
      'InconsistentMetadata',
      'completedAt',
      'A backup cannot finish before it started.',
    );
  }
  if (
    Date.parse(backup.completedAt) > Date.parse(assertInstant(now, 'now', 'InvalidRecoveryPoint'))
  ) {
    throw new BackupError(
      'FutureBackupTimestamp',
      'completedAt',
      'A backup cannot have completed in the future.',
    );
  }

  if (backup.snapshots.length === 0) {
    throw new BackupError(
      'MalformedManifest',
      'snapshots',
      'A manifest with no snapshot describes no backup. An empty inventory row is how an unverified chain looks like a healthy one.',
    );
  }

  const seen = new Set<SnapshotId>();
  const stores = new Set<BackupStore>();
  for (const snapshot of backup.snapshots) {
    assertValidSnapshot(snapshot, now);
    if (seen.has(snapshot.snapshotId)) {
      throw new BackupError(
        'DuplicateSnapshot',
        'snapshots',
        `Snapshot '${snapshot.snapshotId}' appears twice. A restore selecting it could not say which one it meant.`,
      );
    }
    seen.add(snapshot.snapshotId);
    stores.add(snapshot.store);

    if (Date.parse(snapshot.takenAt) > Date.parse(backup.completedAt)) {
      throw new BackupError(
        'InconsistentMetadata',
        'snapshots',
        `Snapshot '${snapshot.snapshotId}' was taken after the run that contains it completed.`,
      );
    }
  }

  // Every restorable store is either snapshotted or explicitly excluded. A
  // store that is silently absent is one nobody notices is unprotected until a
  // restore needs it.
  const excluded = new Set(manifest.excluded.map((entry) => entry.store));
  for (const objective of STORE_OBJECTIVES) {
    if (objective.dataClass === 'derived') continue;
    if (!stores.has(objective.store) && !excluded.has(objective.store)) {
      throw new BackupError(
        'MalformedManifest',
        'snapshots',
        `Store '${objective.store}' is neither snapshotted nor excluded. A store missing from a manifest without a reason is one nobody notices is unprotected until a restore needs it.`,
      );
    }
  }

  for (const entry of manifest.excluded) {
    if (!isBackupStore(entry.store)) {
      throw new BackupError(
        'UnknownStore',
        'excluded',
        `'${String(entry.store)}' is not a store this build classifies.`,
      );
    }
  }

  return manifest;
}

/** Build a manifest, validated and deep-frozen. The only way to make one. */
export function createBackupManifest(manifest: BackupManifest, now: string): BackupManifest {
  assertValidManifest(manifest, now);
  return deepFreeze({
    ...manifest,
    backup: {
      ...manifest.backup,
      metadata: { ...manifest.backup.metadata },
      snapshots: manifest.backup.snapshots.map((snapshot) => ({ ...snapshot })),
    },
    recoveryPoint: { ...manifest.recoveryPoint },
    excluded: manifest.excluded.map((entry) => ({ ...entry })),
  });
}

/** The snapshot for one store in a manifest, or null. */
export function snapshotFor(manifest: BackupManifest, store: BackupStore): BackupSnapshot | null {
  return manifest.backup.snapshots.find((snapshot) => snapshot.store === store) ?? null;
}

/** Every store this manifest can restore. What a plan may name. */
export function restorableStores(manifest: BackupManifest): readonly BackupStore[] {
  return Object.freeze([...new Set(manifest.backup.snapshots.map((s) => s.store))]);
}
