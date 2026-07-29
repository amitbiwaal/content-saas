/**
 * The RLS conformance suite.
 *
 * Spec: `16-security/row-level-security.md` §Verification, and Sprint 0's exit
 * criterion — "RLS conformance green; exactly five exception tables; a sixth
 * fails the build".
 *
 * It exists in Sprint 0, before tables accumulate, so a table added in Sprint 1
 * without a policy fails the build immediately rather than accumulating debt
 * (`17-implementation/repository-structure.md`).
 *
 * WHY THIS IS THE SHAPE IT IS: six of the seven RLS failure modes have NO
 * SYMPTOM. They produce no errors, no slow queries, and no alerts — the
 * application keeps working and returns more data than it should. Verification
 * must therefore be automated and continuous, because nothing else will surface
 * it.
 *
 * This module builds the queries and evaluates the results. It opens no
 * connection of its own: the caller supplies a `SqlExecutor`, so the suite runs
 * against a real PostgreSQL instance (never a mock — RLS is a database
 * behaviour, and a mocked database asserts the test's assumptions rather than
 * PostgreSQL's semantics).
 */

import { ALL_EXCEPTION_TABLES, APPROVED_POLICY_VARIANTS } from './exceptions.js';

/** Minimal query port. Any driver satisfies it; the suite depends on no driver. */
export interface SqlExecutor {
  query<T>(sql: string, params?: readonly unknown[]): Promise<readonly T[]>;
}

export interface ConformanceFinding {
  readonly check: string;
  readonly severity: 'error';
  readonly table?: string;
  readonly detail: string;
}

export interface ConformanceReport {
  readonly passed: boolean;
  readonly findings: readonly ConformanceFinding[];
  readonly tablesChecked: number;
  readonly exceptionsFound: readonly string[];
}

interface TableRow {
  readonly table_name: string;
  readonly rls_enabled: boolean;
  readonly rls_forced: boolean;
}

interface PolicyRow {
  readonly table_name: string;
  readonly policy_name: string;
  readonly command: string;
  readonly using_expr: string | null;
  readonly check_expr: string | null;
  readonly roles: string;
}

interface RoleRow {
  readonly rolname: string;
  readonly rolbypassrls: boolean;
}

interface OwnerRow {
  readonly table_name: string;
  readonly owner: string;
}

/** Enumerates `information_schema`/`pg_catalog` rather than a hand-kept list. */
export const TABLES_SQL = `
  SELECT c.relname            AS table_name,
         c.relrowsecurity     AS rls_enabled,
         c.relforcerowsecurity AS rls_forced
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relkind = 'r'
     AND c.relname <> 'schema_migrations'
   ORDER BY c.relname`;

export const POLICIES_SQL = `
  SELECT tablename  AS table_name,
         policyname AS policy_name,
         cmd        AS command,
         qual       AS using_expr,
         with_check AS check_expr,
         array_to_string(roles, ',') AS roles
    FROM pg_policies
   WHERE schemaname = 'public'
   ORDER BY tablename, policyname`;

export const ROLES_SQL = `
  SELECT rolname, rolbypassrls
    FROM pg_roles
   WHERE rolname LIKE 'contentos%'`;

export const OWNERS_SQL = `
  SELECT c.relname AS table_name, pg_get_userbyid(c.relowner) AS owner
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r'`;

const TENANT_PREDICATE = /current_setting\('app\.tenant_id'::text,\s*true\)/;

/**
 * Run the full suite. Returns findings rather than throwing, so a caller can
 * report every failure at once instead of only the first.
 */
export async function runRlsConformance(db: SqlExecutor): Promise<ConformanceReport> {
  const findings: ConformanceFinding[] = [];

  const tables = await db.query<TableRow>(TABLES_SQL);
  const policies = await db.query<PolicyRow>(POLICIES_SQL);
  const roles = await db.query<RoleRow>(ROLES_SQL);
  const owners = await db.query<OwnerRow>(OWNERS_SQL);

  const expected = new Set(ALL_EXCEPTION_TABLES);
  const actualExceptions = tables.filter((t) => !t.rls_enabled).map((t) => t.table_name);

  // ── Exception set: exactly the approved tables, no more and no fewer. ──────
  // "The exception-count test is the one that prevents drift."
  for (const table of actualExceptions) {
    if (!expected.has(table)) {
      findings.push({
        check: 'exception-set-closed',
        severity: 'error',
        table,
        detail: `'${table}' has no RLS and is not an approved exception. The set is closed at ${String(ALL_EXCEPTION_TABLES.length)}; a sixth requires an ADR.`,
      });
    }
  }
  for (const table of expected) {
    const present = tables.some((t) => t.table_name === table);
    if (!present) continue; // not yet created by a later migration
    if (!actualExceptions.includes(table)) {
      findings.push({
        check: 'exception-set-complete',
        severity: 'error',
        table,
        detail: `'${table}' is an approved RLS exception but has RLS enabled — the registry and the database disagree.`,
      });
    }
  }

  // ── ENABLE and FORCE on every non-exception table. ─────────────────────────
  for (const table of tables) {
    if (expected.has(table.table_name)) continue;

    if (!table.rls_enabled) {
      findings.push({
        check: 'rls-enabled',
        severity: 'error',
        table: table.table_name,
        detail: `RLS is not enabled on '${table.table_name}'.`,
      });
      continue;
    }
    // FORCE omitted has NO symptom until something connects as the owner.
    if (!table.rls_forced) {
      findings.push({
        check: 'rls-forced',
        severity: 'error',
        table: table.table_name,
        detail: `'${table.table_name}' has ENABLE but not FORCE ROW LEVEL SECURITY — the table owner would bypass every policy.`,
      });
    }
  }

  // ── Canonical policy shape. ───────────────────────────────────────────────
  for (const table of tables) {
    if (expected.has(table.table_name) || !table.rls_enabled) continue;

    const own = policies.filter((p) => p.table_name === table.table_name);
    if (own.length === 0) {
      findings.push({
        check: 'policy-present',
        severity: 'error',
        table: table.table_name,
        detail: `'${table.table_name}' has RLS enabled but no policy — every row is invisible, which fails closed but breaks the feature.`,
      });
      continue;
    }

    const isVariant = Object.prototype.hasOwnProperty.call(
      APPROVED_POLICY_VARIANTS,
      table.table_name,
    );
    const primary = own.find((p) => p.command === 'ALL');

    if (primary === undefined) {
      findings.push({
        check: 'policy-for-all',
        severity: 'error',
        table: table.table_name,
        detail: `'${table.table_name}' has no FOR ALL policy. Separate per-command policies are a maintenance hazard: a missing DELETE policy on one table goes unnoticed.`,
      });
      continue;
    }

    // WITH CHECK is the clause that gets forgotten, and its absence is worse
    // than a read leak — it permits writing rows into another tenant.
    if (primary.check_expr === null || primary.check_expr.trim() === '') {
      findings.push({
        check: 'policy-with-check',
        severity: 'error',
        table: table.table_name,
        detail: `'${table.table_name}' policy has no WITH CHECK — a subject could INSERT a row carrying another tenant's id, into a tenant they cannot even read.`,
      });
    }

    if (!isVariant) {
      for (const [clause, expr] of [
        ['USING', primary.using_expr],
        ['WITH CHECK', primary.check_expr],
      ] as const) {
        if (expr !== null && expr !== '' && !TENANT_PREDICATE.test(expr)) {
          findings.push({
            check: 'policy-canonical',
            severity: 'error',
            table: table.table_name,
            detail: `'${table.table_name}' ${clause} does not use current_setting('app.tenant_id', true). The policy must be identical on every table — any deviation is a finding.`,
          });
        }
      }
    }
  }

  // ── Role privileges. ──────────────────────────────────────────────────────
  const app = roles.find((r) => r.rolname === 'contentos_app');
  if (app === undefined) {
    findings.push({
      check: 'role-exists',
      severity: 'error',
      detail: 'contentos_app does not exist.',
    });
  } else if (app.rolbypassrls) {
    // The single most important privilege statement in the platform.
    findings.push({
      check: 'app-no-bypassrls',
      severity: 'error',
      detail:
        'contentos_app holds BYPASSRLS. It ignores every policy silently — no error, no log, just full visibility across every tenant.',
    });
  }

  // A table's owner bypasses RLS by default; the app must own nothing.
  for (const owner of owners) {
    if (owner.owner === 'contentos_app') {
      findings.push({
        check: 'app-owns-no-tables',
        severity: 'error',
        table: owner.table_name,
        detail: `contentos_app owns '${owner.table_name}'. A table's owner bypasses RLS unless FORCE is set; ownership belongs to contentos_migrator.`,
      });
    }
  }

  return {
    passed: findings.length === 0,
    findings,
    tablesChecked: tables.length,
    exceptionsFound: actualExceptions,
  };
}

/** Assert form — throws with every finding listed, for use as a CI gate. */
export async function assertRlsConformance(db: SqlExecutor): Promise<void> {
  const report = await runRlsConformance(db);
  if (report.passed) return;
  const lines = report.findings.map((f) => `  [${f.check}] ${f.table ?? '-'}: ${f.detail}`);
  throw new Error(
    `RLS conformance failed with ${String(report.findings.length)} finding(s):\n${lines.join('\n')}`,
  );
}
