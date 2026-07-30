import { describe, expect, it } from 'vitest';

import { ALL_EXCEPTION_TABLES, IDENTITY_EXCEPTION_TABLES } from './exceptions.js';
import { runRlsConformance, type SqlExecutor } from './conformance.js';

const CANON = "(tenant_id = (current_setting('app.tenant_id'::text, true))::uuid)";

interface Table {
  table_name: string;
  rls_enabled: boolean;
  rls_forced: boolean;
}
interface Policy {
  table_name: string;
  policy_name: string;
  command: string;
  using_expr: string | null;
  check_expr: string | null;
  roles: string;
}

function tenantTable(name: string, over: Partial<Table> = {}): Table {
  return { table_name: name, rls_enabled: true, rls_forced: true, ...over };
}
function canonicalPolicy(name: string, over: Partial<Policy> = {}): Policy {
  return {
    table_name: name,
    policy_name: `${name}_tenant_isolation`,
    command: 'ALL',
    using_expr: CANON,
    check_expr: CANON,
    roles: 'contentos_app',
    ...over,
  };
}

/** Synthetic catalog. Exercises the suite's logic without a live database. */
interface Privilege {
  table_name: string;
  can_select: boolean;
  can_insert: boolean;
  can_update: boolean;
  can_delete: boolean;
}

/** Synthetic catalog. Exercises the suite's logic without a live database. */
function db(opts: {
  tables?: Table[];
  policies?: Policy[];
  roles?: { rolname: string; rolbypassrls: boolean }[];
  owners?: { table_name: string; owner: string }[];
  columns?: { table_name: string; column_name: string }[];
  privileges?: Privilege[];
  /** Omit the identity exceptions, to prove their ABSENCE is a failure. */
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

describe('RLS conformance — the clean baseline', () => {
  it('passes with the five exceptions and a canonical tenant table', async () => {
    const report = await runRlsConformance(
      db({
        tables: [tenantTable('workspace_memberships')],
        policies: [canonicalPolicy('workspace_memberships')],
      }),
    );
    expect(report.passed).toBe(true);
    expect(report.findings).toEqual([]);
    expect(report.exceptionsFound).toHaveLength(5);
  });

  it('holds the exception set at exactly five', () => {
    expect(IDENTITY_EXCEPTION_TABLES).toHaveLength(5);
    expect(ALL_EXCEPTION_TABLES).toHaveLength(5);
  });
});

// Six of the seven RLS failure modes have NO SYMPTOM. Each gets a test.
describe('RLS conformance — catches the symptomless failure modes', () => {
  it('FAILS when a sixth exception table appears', async () => {
    const report = await runRlsConformance(
      db({ tables: [tenantTable('projects', { rls_enabled: false, rls_forced: false })] }),
    );
    expect(report.passed).toBe(false);
    expect(
      report.findings.some((f) => f.check === 'exception-set-closed' && f.table === 'projects'),
    ).toBe(true);
  });

  it('FAILS when an approved exception unexpectedly has RLS enabled', async () => {
    const executor: SqlExecutor = {
      query<T>(sql: string): Promise<readonly T[]> {
        if (sql.includes('relrowsecurity')) {
          return Promise.resolve(
            IDENTITY_EXCEPTION_TABLES.map((t) => ({
              table_name: t,
              rls_enabled: t === 'users',
              rls_forced: t === 'users',
            })) as unknown as T[],
          );
        }
        if (sql.includes('pg_policies'))
          return Promise.resolve([canonicalPolicy('users')] as unknown as T[]);
        if (sql.includes('rolbypassrls')) {
          return Promise.resolve([
            { rolname: 'contentos_app', rolbypassrls: false },
          ] as unknown as T[]);
        }
        return Promise.resolve([] as unknown as T[]);
      },
    };
    const report = await runRlsConformance(executor);
    expect(report.findings.some((f) => f.check === 'exception-set-complete')).toBe(true);
  });

  it('FAILS when RLS is enabled but FORCE is missing', async () => {
    const report = await runRlsConformance(
      db({
        tables: [tenantTable('workspace_memberships', { rls_forced: false })],
        policies: [canonicalPolicy('workspace_memberships')],
      }),
    );
    expect(report.passed).toBe(false);
    const finding = report.findings.find((f) => f.check === 'rls-forced');
    expect(finding?.detail).toContain('table owner would bypass');
  });

  it('FAILS when RLS is not enabled on a non-exception table', async () => {
    const report = await runRlsConformance(
      db({ tables: [tenantTable('audit_log', { rls_enabled: false, rls_forced: false })] }),
    );
    // Reported both as an unapproved exception and as RLS-not-enabled.
    expect(report.findings.some((f) => f.check === 'exception-set-closed')).toBe(true);
  });

  it('FAILS when WITH CHECK is omitted — the worse-than-a-read-leak case', async () => {
    const report = await runRlsConformance(
      db({
        tables: [tenantTable('workspace_memberships')],
        policies: [canonicalPolicy('workspace_memberships', { check_expr: null })],
      }),
    );
    expect(report.passed).toBe(false);
    const finding = report.findings.find((f) => f.check === 'policy-with-check');
    expect(finding?.detail).toContain('another tenant');
  });

  it('FAILS when a table has RLS but no policy at all', async () => {
    const report = await runRlsConformance(
      db({ tables: [tenantTable('workspace_memberships')], policies: [] }),
    );
    expect(report.findings.some((f) => f.check === 'policy-present')).toBe(true);
  });

  it('FAILS when there is no FOR ALL policy', async () => {
    const report = await runRlsConformance(
      db({
        tables: [tenantTable('workspace_memberships')],
        policies: [canonicalPolicy('workspace_memberships', { command: 'SELECT' })],
      }),
    );
    expect(report.findings.some((f) => f.check === 'policy-for-all')).toBe(true);
  });

  it('FAILS when the policy predicate is not the canonical one', async () => {
    const report = await runRlsConformance(
      db({
        tables: [tenantTable('workspace_memberships')],
        policies: [
          canonicalPolicy('workspace_memberships', {
            using_expr: '(tenant_id = current_user_tenant())',
            check_expr: '(tenant_id = current_user_tenant())',
          }),
        ],
      }),
    );
    expect(report.findings.some((f) => f.check === 'policy-canonical')).toBe(true);
  });

  it('FAILS when contentos_app holds BYPASSRLS', async () => {
    const report = await runRlsConformance(
      db({
        tables: [tenantTable('workspace_memberships')],
        policies: [canonicalPolicy('workspace_memberships')],
        roles: [{ rolname: 'contentos_app', rolbypassrls: true }],
      }),
    );
    expect(report.passed).toBe(false);
    expect(report.findings.find((f) => f.check === 'app-no-bypassrls')?.detail).toContain(
      'silently',
    );
  });

  it('FAILS when contentos_app owns a table', async () => {
    const report = await runRlsConformance(
      db({
        tables: [tenantTable('workspace_memberships')],
        policies: [canonicalPolicy('workspace_memberships')],
        owners: [{ table_name: 'workspace_memberships', owner: 'contentos_app' }],
      }),
    );
    expect(report.findings.some((f) => f.check === 'app-owns-no-tables')).toBe(true);
  });

  it('FAILS when contentos_app does not exist', async () => {
    const report = await runRlsConformance(
      db({
        tables: [tenantTable('workspace_memberships')],
        policies: [canonicalPolicy('workspace_memberships')],
        roles: [],
      }),
    );
    expect(report.findings.some((f) => f.check === 'role-exists')).toBe(true);
  });
});

describe('RLS conformance — approved variants', () => {
  // workspaces keys on `id` because workspaces.id IS the tenant (ADR-017).
  it('accepts the workspaces variant without flagging drift', async () => {
    const wsPolicy = canonicalPolicy('workspaces', {
      using_expr: "(id = (current_setting('app.tenant_id'::text, true))::uuid)",
      check_expr: "(id = (current_setting('app.tenant_id'::text, true))::uuid)",
    });
    const report = await runRlsConformance(
      db({ tables: [tenantTable('workspaces')], policies: [wsPolicy] }),
    );
    expect(report.findings.filter((f) => f.check === 'policy-canonical')).toEqual([]);
    expect(report.passed).toBe(true);
  });

  // A variant is still not excused from WITH CHECK.
  it('still requires WITH CHECK on an approved variant', async () => {
    const report = await runRlsConformance(
      db({
        tables: [tenantTable('workspaces')],
        policies: [
          canonicalPolicy('workspaces', {
            using_expr: "(id = (current_setting('app.tenant_id'::text, true))::uuid)",
            check_expr: null,
          }),
        ],
      }),
    );
    expect(report.findings.some((f) => f.check === 'policy-with-check')).toBe(true);
  });
});

describe('RLS conformance — reporting', () => {
  it('reports every finding at once rather than only the first', async () => {
    const report = await runRlsConformance(
      db({
        tables: [tenantTable('a', { rls_forced: false }), tenantTable('b', { rls_forced: false })],
        policies: [canonicalPolicy('a'), canonicalPolicy('b', { check_expr: null })],
        roles: [{ rolname: 'contentos_app', rolbypassrls: true }],
      }),
    );
    expect(report.findings.length).toBeGreaterThanOrEqual(4);
  });

  // Superseded deliberately. This used to tolerate an absent identity table on
  // the grounds that a later migration might create it — but all five come from
  // migration 0003 and the gate runs after every migration, so an absent one is
  // a REMOVAL. "No removals" is half of "exactly five".
  it('FAILS when an identity table is absent from the database', async () => {
    const executor: SqlExecutor = {
      query<T>(sql: string): Promise<readonly T[]> {
        if (sql.includes('relrowsecurity')) {
          return Promise.resolve([
            { table_name: 'users', rls_enabled: false, rls_forced: false },
          ] as unknown as T[]);
        }
        if (sql.includes('rolbypassrls')) {
          return Promise.resolve([
            { rolname: 'contentos_app', rolbypassrls: false },
          ] as unknown as T[]);
        }
        return Promise.resolve([] as unknown as T[]);
      },
    };
    const report = await runRlsConformance(executor);
    expect(report.passed).toBe(false);
    expect(report.findings.map((f) => f.check)).toContain('identity-class-exact');
  });
});
