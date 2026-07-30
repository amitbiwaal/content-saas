/**
 * Manifest-driven verification — the assertions T3.3 added or strengthened.
 *
 * `conformance.test.ts` covers the checks that predate this increment. These
 * cover the ones that replaced the count: set validation by name in both
 * directions, the closed identity class, and the ADR-025 criteria for a
 * reference-data class that is legitimately still empty.
 */
import { describe, expect, it } from 'vitest';

import { runRlsConformance, type ConformanceOptions, type SqlExecutor } from './conformance.js';
import { IDENTITY_EXCEPTION_TABLES } from './exceptions.js';
import { assertionsOfSurface, type RlsExceptionEntry } from './manifest.js';

const CANON = "(tenant_id = (current_setting('app.tenant_id'::text, true))::uuid)";

interface Table {
  table_name: string;
  rls_enabled: boolean;
  rls_forced: boolean;
}
interface Privilege {
  table_name: string;
  can_select: boolean;
  can_insert: boolean;
  can_update: boolean;
  can_delete: boolean;
}

function tenantTable(name: string, over: Partial<Table> = {}): Table {
  return { table_name: name, rls_enabled: true, rls_forced: true, ...over };
}

function canonicalPolicy(name: string) {
  return {
    table_name: name,
    policy_name: `${name}_tenant_isolation`,
    command: 'ALL',
    using_expr: CANON,
    check_expr: CANON,
    roles: 'contentos_app',
  };
}

/** Synthetic catalog. The suite's logic, without a live database. */
function db(opts: {
  tables?: Table[];
  policies?: ReturnType<typeof canonicalPolicy>[];
  roles?: { rolname: string; rolbypassrls: boolean }[];
  owners?: { table_name: string; owner: string }[];
  columns?: { table_name: string; column_name: string }[];
  privileges?: Privilege[];
  omitIdentity?: boolean;
}): SqlExecutor {
  const exceptions = (opts.omitIdentity ? [] : IDENTITY_EXCEPTION_TABLES).map((t) => ({
    table_name: t,
    rls_enabled: false,
    rls_forced: false,
  }));
  const tables = [...exceptions, ...(opts.tables ?? [])];
  return {
    query<T>(sql: string): Promise<readonly T[]> {
      if (sql.includes('relrowsecurity')) return Promise.resolve(tables as unknown as T[]);
      if (sql.includes('pg_policies'))
        return Promise.resolve((opts.policies ?? []) as unknown as T[]);
      if (sql.includes('rolbypassrls')) {
        return Promise.resolve(
          (opts.roles ?? [{ rolname: 'contentos_app', rolbypassrls: false }]) as unknown as T[],
        );
      }
      if (sql.includes('information_schema.columns'))
        return Promise.resolve((opts.columns ?? []) as unknown as T[]);
      if (sql.includes('has_table_privilege'))
        return Promise.resolve((opts.privileges ?? []) as unknown as T[]);
      return Promise.resolve(
        (opts.owners ?? [
          { table_name: 'workspaces', owner: 'contentos_migrator' },
        ]) as unknown as T[],
      );
    },
  };
}

const clean = (): SqlExecutor =>
  db({ tables: [tenantTable('a')], policies: [canonicalPolicy('a')] });

const statusOf = (
  assertions: Awaited<ReturnType<typeof runRlsConformance>>['assertions'],
  name: string,
): string | undefined => assertions.find((a) => a.assertion === name)?.status;

describe('the existing schema shape still passes', () => {
  it('reports every catalogue assertion as passing', async () => {
    const report = await runRlsConformance(clean());
    expect(report.passed).toBe(true);
    expect(report.assertions).toHaveLength(assertionsOfSurface('catalog').length);
    for (const a of report.assertions) expect(a.status, a.assertion).toBe('pass');
  });

  it('gives every result a name and an explanation, passing or failing', async () => {
    const report = await runRlsConformance(
      db({ tables: [tenantTable('a', { rls_forced: false })] }),
    );
    for (const a of report.assertions) {
      expect(a.assertion, JSON.stringify(a)).not.toBe('');
      expect(a.explanation, a.assertion).not.toBe('');
    }
  });
});

describe('the exception set is validated by NAME, in both directions', () => {
  // The count this replaced could not tell these apart: swap one table out for
  // another and "five" is still five while the guarantee is gone.
  it('FAILS on a table without RLS that the manifest does not name', async () => {
    const report = await runRlsConformance(
      db({ tables: [tenantTable('rogue', { rls_enabled: false })] }),
    );
    expect(report.passed).toBe(false);
    const assertion = report.assertions.find((a) => a.assertion === 'exception-set-closed');
    expect(assertion?.status).toBe('fail');
    expect(assertion?.explanation).toContain('rogue');
  });

  it('FAILS when a manifest table has RLS enabled — the two disagree', async () => {
    const report = await runRlsConformance(
      db({
        omitIdentity: true,
        tables: IDENTITY_EXCEPTION_TABLES.map((t) => tenantTable(t)),
        policies: IDENTITY_EXCEPTION_TABLES.map((t) => canonicalPolicy(t)),
      }),
    );
    expect(statusOf(report.assertions, 'exception-set-complete')).toBe('fail');
  });

  // Both directions clean is the only way the set is actually closed.
  it('passes both directions on the real schema shape', async () => {
    const report = await runRlsConformance(clean());
    expect(statusOf(report.assertions, 'exception-set-closed')).toBe('pass');
    expect(statusOf(report.assertions, 'exception-set-complete')).toBe('pass');
  });
});

describe('the identity class is exactly five', () => {
  it('FAILS when an identity table is missing from the database', async () => {
    const report = await runRlsConformance(db({ omitIdentity: true }));
    expect(statusOf(report.assertions, 'identity-class-exact')).toBe('fail');
  });

  it('names the missing table in the explanation', async () => {
    const report = await runRlsConformance(db({ omitIdentity: true }));
    const assertion = report.assertions.find((a) => a.assertion === 'identity-class-exact');
    expect(assertion?.explanation).toContain('users');
    expect(assertion?.explanation).toContain('as much a change as an addition');
  });

  it('passes when all five are present and unprotected', async () => {
    const report = await runRlsConformance(clean());
    expect(statusOf(report.assertions, 'identity-class-exact')).toBe('pass');
  });
});

describe('aggregation — never stop at the first failure', () => {
  it('reports every failing assertion in one run', async () => {
    const report = await runRlsConformance(
      db({
        tables: [tenantTable('a', { rls_forced: false }), tenantTable('b', { rls_enabled: false })],
        roles: [{ rolname: 'contentos_app', rolbypassrls: true }],
        owners: [{ table_name: 'a', owner: 'contentos_app' }],
      }),
    );
    const failed = report.assertions.filter((a) => a.status === 'fail').map((a) => a.assertion);
    expect(failed).toContain('rls-forced');
    expect(failed).toContain('exception-set-closed');
    expect(failed).toContain('app-no-bypassrls');
    expect(failed).toContain('app-owns-no-tables');
  });

  it('still reports the assertions that passed alongside them', async () => {
    const report = await runRlsConformance(
      db({ tables: [tenantTable('a', { rls_forced: false })] }),
    );
    expect(report.assertions.some((a) => a.status === 'pass')).toBe(true);
    expect(report.assertions.some((a) => a.status === 'fail')).toBe(true);
  });
});

describe('reference-data validation — ADR-025', () => {
  // The class is legitimately empty, so it is exercised through the manifest
  // seam rather than by creating a table nobody needs. Verification tested
  // against something other than itself is not verification.
  const REFERENCE_MANIFEST: readonly RlsExceptionEntry[] = [
    ...IDENTITY_EXCEPTION_TABLES.map((table) => ({
      table,
      class: 'identity' as const,
      justification: 'Above the workspace boundary.',
    })),
    { table: 'flags', class: 'reference-data' as const, justification: 'Global reference data.' },
  ];

  const withManifest: ConformanceOptions = { manifest: REFERENCE_MANIFEST };

  const readOnly: Privilege = {
    table_name: 'flags',
    can_select: true,
    can_insert: false,
    can_update: false,
    can_delete: false,
  };

  function withFlags(
    over: {
      columns?: { table_name: string; column_name: string }[];
      privileges?: Privilege[];
    } = {},
  ): SqlExecutor {
    return db({
      tables: [tenantTable('flags', { rls_enabled: false, rls_forced: false })],
      columns: over.columns ?? [{ table_name: 'flags', column_name: 'key' }],
      privileges: over.privileges ?? [readOnly],
    });
  }

  it('passes for a table meeting every criterion', async () => {
    const report = await runRlsConformance(withFlags(), withManifest);
    expect(report.passed).toBe(true);
  });

  // A table with a tenant dimension should be tenant-scoped, not excepted.
  it('FAILS when a reference-data table has a tenant_id column', async () => {
    const report = await runRlsConformance(
      withFlags({
        columns: [
          { table_name: 'flags', column_name: 'key' },
          { table_name: 'flags', column_name: 'tenant_id' },
        ],
      }),
      withManifest,
    );
    expect(statusOf(report.assertions, 'reference-data-no-tenant-id')).toBe('fail');
  });

  // Isolation by privilege, not by review — the property that makes this class
  // safer than the identity one rather than a widening of it.
  const WRITES = [
    ['INSERT', { can_insert: true }],
    ['UPDATE', { can_update: true }],
    ['DELETE', { can_delete: true }],
  ] as const;

  for (const [verb, grant] of WRITES) {
    it(`FAILS when contentos_app holds ${verb}`, async () => {
      const report = await runRlsConformance(
        withFlags({ privileges: [{ ...readOnly, ...grant }] }),
        withManifest,
      );
      const assertion = report.assertions.find((a) => a.assertion === 'reference-data-read-only');
      expect(assertion?.status).toBe('fail');
      expect(assertion?.explanation).toContain(verb);
    });
  }

  it('FAILS when contentos_app cannot read it', async () => {
    const report = await runRlsConformance(
      withFlags({ privileges: [{ ...readOnly, can_select: false }] }),
      withManifest,
    );
    expect(statusOf(report.assertions, 'reference-data-readable')).toBe('fail');
  });

  it('FAILS when the entry carries no written justification', async () => {
    const report = await runRlsConformance(withFlags(), {
      manifest: [
        ...REFERENCE_MANIFEST.slice(0, -1),
        { table: 'flags', class: 'reference-data', justification: '   ' },
      ],
    });
    const assertion = report.assertions.find((a) => a.assertion === 'exception-justified');
    expect(assertion?.status).toBe('fail');
    expect(assertion?.explanation).toContain('nobody reviewed');
  });

  // Verification must pass with the class empty, and it does — every
  // reference-data assertion iterates the list and vacuously passes over none.
  it('passes with no reference-data tables at all', async () => {
    const report = await runRlsConformance(clean());
    for (const name of [
      'reference-data-no-tenant-id',
      'reference-data-readable',
      'reference-data-read-only',
    ]) {
      expect(statusOf(report.assertions, name), name).toBe('pass');
    }
  });

  // The class is populated ahead of the migration that creates its tables.
  it('tolerates a reference-data entry the database does not have yet', async () => {
    const report = await runRlsConformance(clean(), withManifest);
    expect(report.passed).toBe(true);
  });
});
