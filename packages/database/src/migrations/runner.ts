/**
 * Migration runner.
 *
 * Spec: `03-database/migrations.md`.
 *
 * Migrations are APPEND-ONLY. An applied migration is never edited: its
 * checksum is recorded at apply time and re-verified on every subsequent run,
 * so an edit to shipped SQL fails the deploy rather than silently diverging
 * environments that applied different content under the same number.
 *
 * Rollback is by FORWARD migration, not by reversal. Each file carries a
 * ROLLBACK note in its header for the operator; `expand → migrate → contract`
 * makes expand and migrate reversible and contract deliberately not — which is
 * why contract ships alone, in its own release, after the expanded shape has
 * run in production for a full release cycle (ADR-015).
 */

import { createHash } from 'node:crypto';

export interface MigrationFile {
  /** Zero-padded sequence, e.g. '0005'. */
  readonly id: string;
  readonly name: string;
  readonly sql: string;
}

export interface AppliedMigration {
  readonly id: string;
  readonly name: string;
  readonly checksum: string;
  readonly appliedAt: string;
}

export interface MigrationExecutor {
  query<T>(sql: string, params?: readonly unknown[]): Promise<readonly T[]>;
  transaction<T>(work: (tx: MigrationExecutor) => Promise<T>): Promise<T>;
}

export const MIGRATIONS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    id          TEXT        PRIMARY KEY,
    name        TEXT        NOT NULL,
    checksum    TEXT        NOT NULL,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;

export function checksum(sql: string): string {
  // Normalise line endings so a checkout on Windows and one on Linux agree.
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

/** Migration ids must be strictly increasing and unique. */
export function assertSequence(files: readonly MigrationFile[]): void {
  const ids = files.map((f) => f.id);
  const sorted = [...ids].sort((a, b) => a.localeCompare(b));
  if (ids.join(',') !== sorted.join(',')) {
    throw new Error('Migration files are not in ascending id order.');
  }
  const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (duplicates.length > 0) {
    throw new Error(`Duplicate migration id(s): ${[...new Set(duplicates)].join(', ')}`);
  }
}

export interface MigrationPlan {
  readonly pending: readonly MigrationFile[];
  readonly applied: readonly AppliedMigration[];
}

/**
 * Compute what would run, and verify nothing already applied has been edited.
 *
 * Two failures are distinguished because their remedies differ entirely:
 *  - a CHECKSUM MISMATCH means shipped SQL was edited — never valid;
 *  - a MISSING FILE means an applied migration is absent from the tree, which
 *    means this build is older than the database.
 */
export function planMigrations(
  files: readonly MigrationFile[],
  applied: readonly AppliedMigration[],
): MigrationPlan {
  assertSequence(files);

  const byId = new Map(files.map((f) => [f.id, f]));
  for (const record of applied) {
    const file = byId.get(record.id);
    if (file === undefined) {
      throw new Error(
        `Migration ${record.id} (${record.name}) is recorded as applied but is missing from the tree. This build is older than the database.`,
      );
    }
    if (checksum(file.sql) !== record.checksum) {
      throw new Error(
        `Migration ${record.id} (${record.name}) has been EDITED after being applied. Migrations are append-only: add a new migration instead.`,
      );
    }
  }

  const appliedIds = new Set(applied.map((a) => a.id));
  return { pending: files.filter((f) => !appliedIds.has(f.id)), applied };
}

/**
 * Apply pending migrations, each in its own transaction so a failure leaves the
 * preceding ones committed and the failing one fully rolled back.
 */
export async function migrate(
  db: MigrationExecutor,
  files: readonly MigrationFile[],
): Promise<readonly MigrationFile[]> {
  await db.query(MIGRATIONS_TABLE_SQL);
  const applied = await db.query<AppliedMigration>(
    `SELECT id, name, checksum, applied_at AS "appliedAt" FROM schema_migrations ORDER BY id`,
  );

  const plan = planMigrations(files, applied);

  for (const file of plan.pending) {
    await db.transaction(async (tx) => {
      await tx.query(file.sql);
      await tx.query(`INSERT INTO schema_migrations (id, name, checksum) VALUES ($1, $2, $3)`, [
        file.id,
        file.name,
        checksum(file.sql),
      ]);
    });
  }

  return plan.pending;
}

/** Current version, for the readiness probe's `migrationCurrent` check. */
export async function currentVersion(db: MigrationExecutor): Promise<string | null> {
  const rows = await db.query<{ id: string }>(
    `SELECT id FROM schema_migrations ORDER BY id DESC LIMIT 1`,
  );
  return rows[0]?.id ?? null;
}
