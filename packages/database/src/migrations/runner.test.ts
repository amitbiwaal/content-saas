import { describe, expect, it } from 'vitest';

import {
  assertSequence,
  checksum,
  currentVersion,
  migrate,
  planMigrations,
  type AppliedMigration,
  type MigrationExecutor,
  type MigrationFile,
} from './runner.js';

const f = (id: string, sql: string): MigrationFile => ({ id, name: `${id}_test`, sql });
const applied = (file: MigrationFile, sql = file.sql): AppliedMigration => ({
  id: file.id,
  name: file.name,
  checksum: checksum(sql),
  appliedAt: '2026-07-29T00:00:00.000Z',
});

function fakeDb(rows: AppliedMigration[]): MigrationExecutor & { executed: string[] } {
  const executed: string[] = [];
  const db: MigrationExecutor & { executed: string[] } = {
    executed,
    query<T>(sql: string): Promise<readonly T[]> {
      executed.push(sql);
      if (sql.includes('SELECT id, name, checksum')) return Promise.resolve(rows as unknown as T[]);
      if (sql.includes('ORDER BY id DESC')) {
        const last = [...rows].sort((a, b) => a.id.localeCompare(b.id)).at(-1);
        return Promise.resolve((last ? [{ id: last.id }] : []) as unknown as T[]);
      }
      return Promise.resolve([] as unknown as T[]);
    },
    transaction<T>(work: (tx: MigrationExecutor) => Promise<T>): Promise<T> {
      return work(db);
    },
  };
  return db;
}

describe('checksum', () => {
  it('is stable and content-addressed', () => {
    expect(checksum('SELECT 1')).toBe(checksum('SELECT 1'));
    expect(checksum('SELECT 1')).not.toBe(checksum('SELECT 2'));
  });

  it('normalises line endings so Windows and Linux checkouts agree', () => {
    expect(checksum('a\r\nb')).toBe(checksum('a\nb'));
  });
});

describe('sequence', () => {
  it('accepts ascending unique ids', () => {
    expect(() => {
      assertSequence([f('0001', 'a'), f('0002', 'b')]);
    }).not.toThrow();
  });

  it('rejects out-of-order ids', () => {
    expect(() => {
      assertSequence([f('0002', 'a'), f('0001', 'b')]);
    }).toThrow(/ascending/);
  });

  it('rejects duplicate ids', () => {
    expect(() => {
      assertSequence([f('0001', 'a'), f('0001', 'b')]);
    }).toThrow(/Duplicate/);
  });
});

describe('planMigrations — append-only enforcement', () => {
  it('returns only unapplied migrations', () => {
    const files = [f('0001', 'a'), f('0002', 'b'), f('0003', 'c')];
    const plan = planMigrations(files, [applied(files[0]!), applied(files[1]!)]);
    expect(plan.pending.map((p) => p.id)).toEqual(['0003']);
  });

  it('returns everything on a fresh database', () => {
    const files = [f('0001', 'a'), f('0002', 'b')];
    expect(planMigrations(files, []).pending).toHaveLength(2);
  });

  // Never edit old migrations. Only append.
  it('REFUSES an applied migration whose SQL has been edited', () => {
    const file = f('0001', 'ALTER TABLE t ADD COLUMN a INT');
    const record = applied(file, 'ALTER TABLE t ADD COLUMN b INT'); // shipped content differed
    expect(() => planMigrations([file], [record])).toThrow(/EDITED after being applied/);
  });

  it('names the offending migration in the edit error', () => {
    const file = f('0007', 'new');
    expect(() => planMigrations([file], [applied(file, 'old')])).toThrow(/0007/);
  });

  it('REFUSES when an applied migration is missing from the tree', () => {
    expect(() => planMigrations([f('0002', 'b')], [applied(f('0001', 'a'))])).toThrow(
      /older than the database/,
    );
  });

  it('distinguishes an edit from a missing file', () => {
    const file = f('0001', 'x');
    expect(() => planMigrations([file], [applied(file, 'y')])).toThrow(/append-only/);
    expect(() => planMigrations([], [applied(file)])).toThrow(/missing from the tree/);
  });
});

describe('migrate', () => {
  it('creates the tracking table before anything else', async () => {
    const db = fakeDb([]);
    await migrate(db, [f('0001', 'CREATE TABLE t ()')]);
    expect(db.executed[0]).toContain('CREATE TABLE IF NOT EXISTS schema_migrations');
  });

  it('applies pending migrations and records each one', async () => {
    const db = fakeDb([]);
    const ran = await migrate(db, [f('0001', 'SQL_ONE'), f('0002', 'SQL_TWO')]);
    expect(ran.map((r) => r.id)).toEqual(['0001', '0002']);
    expect(db.executed).toContain('SQL_ONE');
    expect(db.executed).toContain('SQL_TWO');
    expect(db.executed.filter((s) => s.includes('INSERT INTO schema_migrations'))).toHaveLength(2);
  });

  it('is a no-op when everything is applied', async () => {
    const file = f('0001', 'SQL');
    const db = fakeDb([applied(file)]);
    expect(await migrate(db, [file])).toHaveLength(0);
    expect(db.executed).not.toContain('SQL');
  });

  it('refuses to run when an applied migration was edited', async () => {
    const file = f('0001', 'EDITED');
    const db = fakeDb([applied(file, 'ORIGINAL')]);
    await expect(migrate(db, [file])).rejects.toThrow(/append-only/);
  });
});

describe('currentVersion', () => {
  it('returns null on a fresh database', async () => {
    expect(await currentVersion(fakeDb([]))).toBeNull();
  });

  it('returns the highest applied id', async () => {
    const db = fakeDb([applied(f('0001', 'a')), applied(f('0005', 'b'))]);
    expect(await currentVersion(db)).toBe('0005');
  });
});
