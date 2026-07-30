/**
 * The RLS conformance engine.
 *
 * Spec: `16-security/row-level-security.md` §Verification, ADR-007, ADR-025.
 *
 * WHY THIS IS THE SHAPE IT IS: six of the seven RLS failure modes have NO
 * SYMPTOM. They produce no errors, no slow queries, and no alerts — the
 * application keeps working and returns more data than it should. Verification
 * must therefore be automated and continuous, because nothing else will
 * surface it.
 *
 * ── Manifest-driven, never count-driven ─────────────────────────────────────
 * Every assertion is decided by NAME against `./manifest.ts`. The gate this
 * replaced asserted that the number of tables without RLS was five, which
 * cannot distinguish a permitted exception from an unpermitted one: swap one
 * table for another and the count is unchanged while the guarantee is gone.
 *
 * ── Every assertion reports, and none of them stops the run ─────────────────
 * A result is produced for each catalogue assertion whether it passed or
 * failed, and the run always completes. Stopping at the first failure turns one
 * fix-and-rerun cycle into one per fault, and a gate nobody wants to run is a
 * gate that gets skipped.
 *
 * This module opens no connection: the caller supplies a `SqlExecutor`, so the
 * suite runs against a real PostgreSQL instance — never a mock, because RLS is
 * a database behaviour and a mocked database asserts the test's assumptions
 * rather than PostgreSQL's semantics.
 */

import { APPROVED_POLICY_VARIANTS } from './exceptions.js';
import { assertionsOfSurface, RLS_EXCEPTION_MANIFEST, type RlsExceptionEntry } from './manifest.js';

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

export type RlsAssertionStatus = 'pass' | 'fail';

export interface RlsAssertionResult {
  readonly assertion: string;
  readonly status: RlsAssertionStatus;
  readonly explanation: string;
}

export interface ConformanceOptions {
  /**
   * The manifest to verify against. Defaults to the real one.
   *
   * A parameter rather than a hidden import so the reference-data assertions
   * are testable while that class is legitimately empty — the alternative is
   * creating a table nobody needs purely so its checks can be exercised, which
   * is how verification ends up tested against something other than itself.
   */
  readonly manifest?: readonly RlsExceptionEntry[];
}

export interface ConformanceReport {
  readonly passed: boolean;
  /** One entry per catalogue assertion, passing or failing. */
  readonly assertions: readonly RlsAssertionResult[];
  /** Per-subject detail behind the failing assertions. */
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

interface ColumnRow {
  readonly table_name: string;
  readonly column_name: string;
}

interface PrivilegeRow {
  readonly table_name: string;
  readonly can_select: boolean;
  readonly can_insert: boolean;
  readonly can_update: boolean;
  readonly can_delete: boolean;
}

/** Enumerates `pg_catalog` rather than a hand-kept list. */
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

/** ADR-025 criterion: a reference-data table has no tenant dimension. */
export const COLUMNS_SQL = `
  SELECT table_name, column_name
    FROM information_schema.columns
   WHERE table_schema = 'public'
   ORDER BY table_name, column_name`;

/**
 * ADR-025 criterion: reference data is READ-ONLY to the application role.
 *
 * `LEFT JOIN pg_roles` rather than calling `has_table_privilege('contentos_app', …)`
 * directly, because that form RAISES when the role does not exist — and a
 * missing role must be reported as its own failing assertion, not as an error
 * that aborts the whole run.
 */
export const PRIVILEGES_SQL = `
  SELECT c.relname AS table_name,
         COALESCE(has_table_privilege(r.oid, c.oid, 'SELECT'), false) AS can_select,
         COALESCE(has_table_privilege(r.oid, c.oid, 'INSERT'), false) AS can_insert,
         COALESCE(has_table_privilege(r.oid, c.oid, 'UPDATE'), false) AS can_update,
         COALESCE(has_table_privilege(r.oid, c.oid, 'DELETE'), false) AS can_delete
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_roles r ON r.rolname = 'contentos_app'
   WHERE n.nspname = 'public' AND c.relkind = 'r'
   ORDER BY c.relname`;

const TENANT_PREDICATE = /current_setting\('app\.tenant_id'::text,\s*true\)/;

/**
 * Run the full suite.
 *
 * Returns results rather than throwing, so a caller reports every failure at
 * once instead of only the first.
 */
export async function runRlsConformance(
  db: SqlExecutor,
  options: ConformanceOptions = {},
): Promise<ConformanceReport> {
  const manifest = options.manifest ?? RLS_EXCEPTION_MANIFEST;
  const entryFor = (table: string): RlsExceptionEntry | undefined =>
    manifest.find((e) => e.table === table);
  const ofClass = (cls: RlsExceptionEntry['class']): readonly RlsExceptionEntry[] =>
    manifest.filter((e) => e.class === cls);

  const findings: ConformanceFinding[] = [];
  const fail = (check: string, detail: string, table?: string): void => {
    findings.push({
      check,
      severity: 'error',
      detail,
      ...(table === undefined ? {} : { table }),
    });
  };

  const tables = await db.query<TableRow>(TABLES_SQL);
  const policies = await db.query<PolicyRow>(POLICIES_SQL);
  const roles = await db.query<RoleRow>(ROLES_SQL);
  const owners = await db.query<OwnerRow>(OWNERS_SQL);
  const columns = await db.query<ColumnRow>(COLUMNS_SQL);
  const privileges = await db.query<PrivilegeRow>(PRIVILEGES_SQL);

  const permitted = new Set(manifest.map((e) => e.table));
  const present = new Set(tables.map((t) => t.table_name));
  const actualExceptions = tables.filter((t) => !t.rls_enabled).map((t) => t.table_name);

  // ── The exception set, both directions and by NAME. ───────────────────────
  for (const table of actualExceptions) {
    if (!permitted.has(table)) {
      fail(
        'exception-set-closed',
        `'${table}' has no RLS and is not in the manifest. Every exception is named and justified; a new one requires an ADR.`,
        table,
      );
    }
  }
  for (const entry of manifest) {
    // A manifest entry whose table does not exist yet is not a failure — the
    // reference-data class is populated ahead of the migrations that create it.
    if (!present.has(entry.table)) continue;
    if (!actualExceptions.includes(entry.table)) {
      fail(
        'exception-set-complete',
        `'${entry.table}' is a manifest exception but has RLS enabled — the manifest and the database disagree.`,
        entry.table,
      );
    }
  }

  // ── The identity class is closed at exactly its named members. ────────────
  for (const entry of ofClass('identity')) {
    if (!present.has(entry.table)) {
      fail(
        'identity-class-exact',
        `Identity exception '${entry.table}' is in the manifest but absent from the database. The class is closed at its five named tables — a removal is as much a change as an addition.`,
        entry.table,
      );
    }
  }
  for (const table of actualExceptions) {
    const entry = entryFor(table);
    if (entry !== undefined && entry.class !== 'identity' && !present.has(table)) {
      fail('identity-class-exact', `'${table}' is classified '${entry.class}'.`, table);
    }
  }

  // ── Every exception carries a written reason. ─────────────────────────────
  for (const entry of manifest) {
    if (entry.justification.trim() === '') {
      fail(
        'exception-justified',
        `'${entry.table}' has no written justification. An exception nobody wrote a reason for is an exception nobody reviewed.`,
        entry.table,
      );
    }
  }

  // ── ADR-025 criteria for the reference-data class. ────────────────────────
  // Vacuous while the class is empty, and that is the point: the checks exist
  // before the first table does, so the first one cannot land unverified.
  const referenceData = ofClass('reference-data');
  for (const entry of referenceData) {
    if (!present.has(entry.table)) continue;

    const hasTenantId = columns.some(
      (c) => c.table_name === entry.table && c.column_name === 'tenant_id',
    );
    if (hasTenantId) {
      fail(
        'reference-data-no-tenant-id',
        `'${entry.table}' is classified reference data but has a tenant_id column. A table with a tenant dimension should be tenant-scoped, not excepted.`,
        entry.table,
      );
    }

    const privilege = privileges.find((p) => p.table_name === entry.table);
    if (privilege === undefined || !privilege.can_select) {
      fail(
        'reference-data-readable',
        `contentos_app cannot SELECT '${entry.table}'. Reference data exists to be read by the application.`,
        entry.table,
      );
    }
    const writes =
      privilege === undefined
        ? []
        : (['INSERT', 'UPDATE', 'DELETE'] as const).filter((verb) =>
            verb === 'INSERT'
              ? privilege.can_insert
              : verb === 'UPDATE'
                ? privilege.can_update
                : privilege.can_delete,
          );
    if (writes.length > 0) {
      fail(
        'reference-data-read-only',
        `contentos_app holds ${writes.join(', ')} on '${entry.table}'. Reference data is read-only to the application role by privilege, which is what makes this class safer than the identity one rather than a widening of it.`,
        entry.table,
      );
    }
  }

  // ── ENABLE and FORCE on every non-exception table. ────────────────────────
  for (const table of tables) {
    if (permitted.has(table.table_name)) continue;

    if (!table.rls_enabled) {
      fail('rls-enabled', `RLS is not enabled on '${table.table_name}'.`, table.table_name);
      continue;
    }
    // FORCE omitted has NO symptom until something connects as the owner.
    if (!table.rls_forced) {
      fail(
        'rls-forced',
        `'${table.table_name}' has ENABLE but not FORCE ROW LEVEL SECURITY — the table owner would bypass every policy.`,
        table.table_name,
      );
    }
  }

  // ── Canonical policy shape. ───────────────────────────────────────────────
  for (const table of tables) {
    if (permitted.has(table.table_name) || !table.rls_enabled) continue;

    const own = policies.filter((p) => p.table_name === table.table_name);
    if (own.length === 0) {
      fail(
        'policy-present',
        `'${table.table_name}' has RLS enabled but no policy — every row is invisible, which fails closed but breaks the feature.`,
        table.table_name,
      );
      continue;
    }

    const isVariant = Object.prototype.hasOwnProperty.call(
      APPROVED_POLICY_VARIANTS,
      table.table_name,
    );
    const primary = own.find((p) => p.command === 'ALL');

    if (primary === undefined) {
      fail(
        'policy-for-all',
        `'${table.table_name}' has no FOR ALL policy. Separate per-command policies are a maintenance hazard: a missing DELETE policy on one table goes unnoticed.`,
        table.table_name,
      );
      continue;
    }

    // WITH CHECK is the clause that gets forgotten, and its absence is worse
    // than a read leak — it permits writing rows into another tenant.
    if (primary.check_expr === null || primary.check_expr.trim() === '') {
      fail(
        'policy-with-check',
        `'${table.table_name}' policy has no WITH CHECK — a subject could INSERT a row carrying another tenant's id, into a tenant they cannot even read.`,
        table.table_name,
      );
    }

    if (!isVariant) {
      for (const [clause, expr] of [
        ['USING', primary.using_expr],
        ['WITH CHECK', primary.check_expr],
      ] as const) {
        if (expr !== null && expr !== '' && !TENANT_PREDICATE.test(expr)) {
          fail(
            'policy-canonical',
            `'${table.table_name}' ${clause} does not use current_setting('app.tenant_id', true). The policy must be identical on every table — any deviation is a finding.`,
            table.table_name,
          );
        }
      }
    }
  }

  // ── Role privileges. ──────────────────────────────────────────────────────
  const app = roles.find((r) => r.rolname === 'contentos_app');
  if (app === undefined) {
    fail('role-exists', 'contentos_app does not exist.');
  } else if (app.rolbypassrls) {
    // The single most important privilege statement in the platform.
    fail(
      'app-no-bypassrls',
      'contentos_app holds BYPASSRLS. It ignores every policy silently — no error, no log, just full visibility across every tenant.',
    );
  }

  // A table's owner bypasses RLS by default; the app must own nothing.
  for (const owner of owners) {
    if (owner.owner === 'contentos_app') {
      fail(
        'app-owns-no-tables',
        `contentos_app owns '${owner.table_name}'. A table's owner bypasses RLS unless FORCE is set; ownership belongs to contentos_migrator.`,
        owner.table_name,
      );
    }
  }

  return {
    passed: findings.length === 0,
    assertions: summarize(findings),
    findings,
    tablesChecked: tables.length,
    exceptionsFound: actualExceptions,
  };
}

/**
 * One result per catalogue assertion, passing or failing.
 *
 * Driven by the catalogue rather than by the findings, so an assertion that
 * produced no findings is reported as PASSING rather than silently absent —
 * the difference between "checked and clean" and "never ran" is the whole
 * value of the report.
 */
function summarize(findings: readonly ConformanceFinding[]): readonly RlsAssertionResult[] {
  return assertionsOfSurface('catalog').map((spec) => {
    const failures = findings.filter((f) => f.check === spec.name);
    return failures.length === 0
      ? { assertion: spec.name, status: 'pass' as const, explanation: spec.description }
      : {
          assertion: spec.name,
          status: 'fail' as const,
          explanation: failures.map((f) => f.detail).join(' '),
        };
  });
}

/** Assert form — throws with every failing assertion listed, for use as a gate. */
export async function assertRlsConformance(
  db: SqlExecutor,
  options: ConformanceOptions = {},
): Promise<void> {
  const report = await runRlsConformance(db, options);
  if (report.passed) return;
  const lines = report.assertions
    .filter((a) => a.status === 'fail')
    .map((a) => `  FAIL ${a.assertion}: ${a.explanation}`);
  throw new Error(
    `RLS conformance failed with ${String(report.findings.length)} finding(s):\n${lines.join('\n')}`,
  );
}
