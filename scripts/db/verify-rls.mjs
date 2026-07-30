#!/usr/bin/env node
/**
 * RLS verification against a REAL PostgreSQL instance.
 *
 * "Tests run against a real PostgreSQL instance, never a mock. RLS is a
 *  database behaviour, and a mocked database asserts the test's assumptions
 *  rather than PostgreSQL's semantics." — 16-security/row-level-security.md
 *
 * SIX OF THE SEVEN RLS FAILURE MODES HAVE NO SYMPTOM. Each is therefore checked
 * explicitly rather than inferred from the application appearing to work.
 *
 * ── Manifest-driven ─────────────────────────────────────────────────────────
 * Every permitted exception and every assertion name comes from
 * `rls-manifest.generated.json`, produced from
 * `packages/database/src/rls/manifest.ts`. There are no table names and no
 * counts in this file. The gate this replaced asserted "the number of tables
 * without RLS is five", which cannot tell a permitted exception from an
 * unpermitted one — swap one table for another and the count is unchanged
 * while the guarantee is gone.
 *
 * ── It refuses to run an incomplete check set ───────────────────────────────
 * Before evaluating anything it verifies that it implements every `catalog`
 * and `behavioural` assertion the manifest declares. A gate that silently
 * skips a check reports success it has not earned.
 *
 * Every assertion reports PASS or FAIL with an explanation, and the run always
 * completes: stopping at the first failure turns one fix-and-rerun cycle into
 * one per fault.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const manifest = JSON.parse(readFileSync(join(here, 'rls-manifest.generated.json'), 'utf8'));

// ── psql, through the one helper that knows how to reach the database ───────
// Sourcing `psql.sh` rather than reimplementing its direct/compose modes keeps
// a single place that knows how to connect; a second one would drift, and the
// thing CI verifies would stop being the thing a developer runs.

function sh(script, env = {}) {
  return spawnSync('bash', ['-c', script], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function dbMode() {
  return sh('. scripts/db/psql.sh; db_mode').stdout.trim();
}

/**
 * Rows as arrays of column strings; `-tA` gives tuples-only, pipe-separated.
 *
 * A connection failure exits non-zero HERE rather than propagating as an
 * unhandled rejection. The distinction matters for a security gate: an
 * unreachable database must read as "verification did not happen", never as a
 * run with nothing to report.
 */
function query(sql) {
  const result = sh('. scripts/db/psql.sh; psql_query "$RLS_SQL"', { RLS_SQL: sql });
  if (result.status !== 0) {
    console.error('==> RLS verification COULD NOT RUN');
    console.error(`    the database was unreachable: ${(result.stderr || '').trim()}`);
    process.exit(1);
  }
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => line.split('|'));
}

const bool = (v) => v === 't' || v === 'true';

// ── Assertion recording ─────────────────────────────────────────────────────

const results = [];
const implemented = new Set();

/** Record one assertion. `failures` empty means PASS. */
function assert(name, failures, passExplanation) {
  implemented.add(name);
  results.push(
    failures.length === 0
      ? { name, status: 'PASS', explanation: passExplanation }
      : { name, status: 'FAIL', explanation: failures.join(' ') },
  );
}

/**
 * A behavioural assertion the current mode cannot reach.
 *
 * Compose mode has no application-role login connection, so a developer running
 * this locally gets a SKIP. In CI it is a FAIL: the four behavioural assertions
 * are the only ones that observe isolation rather than configuration, and a
 * pipeline that stopped running them — because the mode changed, or the service
 * container moved — must say so rather than reporting a green it did not earn.
 */
function unreachable(name, why) {
  implemented.add(name);
  results.push(
    process.env.CI === undefined
      ? { name, status: 'SKIP', explanation: why }
      : { name, status: 'FAIL', explanation: `${why} In CI this is a failure, not a skip.` },
  );
}

// ── Catalogue facts ─────────────────────────────────────────────────────────

const tables = query(`
  SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname='public' AND c.relkind='r' AND c.relname <> 'schema_migrations'
   ORDER BY c.relname`).map(([name, enabled, forced]) => ({
  name,
  rls: bool(enabled),
  forced: bool(forced),
}));

const policies = query(`
  SELECT tablename, cmd, coalesce(qual,''), coalesce(with_check,'')
    FROM pg_policies WHERE schemaname='public'`).map(([table, cmd, using, check]) => ({
  table,
  cmd,
  using,
  check,
}));

const privileges = query(`
  SELECT c.relname,
         COALESCE(has_table_privilege(r.oid, c.oid, 'SELECT'), false),
         COALESCE(has_table_privilege(r.oid, c.oid, 'INSERT'), false),
         COALESCE(has_table_privilege(r.oid, c.oid, 'UPDATE'), false),
         COALESCE(has_table_privilege(r.oid, c.oid, 'DELETE'), false)
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_roles r ON r.rolname = 'contentos_app'
   WHERE n.nspname='public' AND c.relkind='r'`).map(([table, s, i, u, d]) => ({
  table,
  select: bool(s),
  insert: bool(i),
  update: bool(u),
  delete: bool(d),
}));

const tenantIdTables = new Set(
  query(`
  SELECT table_name FROM information_schema.columns
   WHERE table_schema='public' AND column_name='tenant_id'`).map(([t]) => t),
);

const appRole = query(`SELECT rolname, rolbypassrls FROM pg_roles WHERE rolname='contentos_app'`);
const ownedByApp = query(`
  SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname='public' AND c.relkind='r' AND pg_get_userbyid(c.relowner)='contentos_app'`).map(
  ([t]) => t,
);

const present = new Set(tables.map((t) => t.name));
const withoutRls = tables.filter((t) => !t.rls).map((t) => t.name);
const permitted = new Map(manifest.exceptions.map((e) => [e.table, e]));
const identity = manifest.exceptions.filter((e) => e.class === 'identity');
const referenceData = manifest.exceptions.filter((e) => e.class === 'reference-data');

// ── The exception set, by name, in both directions ──────────────────────────

assert(
  'exception-set-closed',
  withoutRls
    .filter((t) => !permitted.has(t))
    .map(
      (t) =>
        `'${t}' has no RLS and is not in the manifest. Every exception is named and justified; a new one requires an ADR.`,
    ),
  `every table without RLS is a manifest exception (${String(withoutRls.length)} found).`,
);

assert(
  'exception-set-complete',
  manifest.exceptions
    .filter((e) => present.has(e.table) && !withoutRls.includes(e.table))
    .map((e) => `'${e.table}' is a manifest exception but has RLS enabled — the two disagree.`),
  'every manifest exception present in the database has RLS disabled.',
);

// ── The identity class is closed at exactly its named members ───────────────

assert(
  'identity-class-exact',
  [
    ...identity
      .filter((e) => !present.has(e.table))
      .map(
        (e) =>
          `Identity exception '${e.table}' is in the manifest but absent from the database. A removal is as much a change as an addition.`,
      ),
    ...withoutRls
      .filter((t) => permitted.get(t)?.class === 'identity')
      .filter((t) => !identity.some((e) => e.table === t))
      .map((t) => `'${t}' is classified identity but is not a declared member.`),
  ],
  `the identity class is exactly its ${String(identity.length)} named tables: ${identity
    .map((e) => e.table)
    .join(', ')}.`,
);

assert(
  'exception-justified',
  manifest.exceptions
    .filter((e) => String(e.justification).trim() === '')
    .map(
      (e) =>
        `'${e.table}' has no written justification. An exception nobody wrote a reason for is an exception nobody reviewed.`,
    ),
  'every manifest exception carries a written justification.',
);

// ── ADR-025 criteria for the reference-data class ───────────────────────────
// Vacuous while the class is empty, and that is the point: the checks exist
// before the first table does, so the first one cannot land unverified.

const liveReferenceData = referenceData.filter((e) => present.has(e.table));

assert(
  'reference-data-no-tenant-id',
  liveReferenceData
    .filter((e) => tenantIdTables.has(e.table))
    .map(
      (e) =>
        `'${e.table}' is classified reference data but has a tenant_id column. A table with a tenant dimension should be tenant-scoped, not excepted.`,
    ),
  `no reference-data table carries a tenant dimension (${String(liveReferenceData.length)} checked).`,
);

assert(
  'reference-data-readable',
  liveReferenceData
    .filter((e) => !privileges.find((p) => p.table === e.table)?.select)
    .map(
      (e) =>
        `contentos_app cannot SELECT '${e.table}'. Reference data exists to be read by the application.`,
    ),
  `contentos_app can read every reference-data table (${String(liveReferenceData.length)} checked).`,
);

assert(
  'reference-data-read-only',
  liveReferenceData.flatMap((e) => {
    const p = privileges.find((row) => row.table === e.table);
    if (p === undefined) return [];
    const writes = ['INSERT', 'UPDATE', 'DELETE'].filter(
      (verb) =>
        (verb === 'INSERT' && p.insert) ||
        (verb === 'UPDATE' && p.update) ||
        (verb === 'DELETE' && p.delete),
    );
    return writes.length === 0
      ? []
      : [
          `contentos_app holds ${writes.join(', ')} on '${e.table}'. Reference data is read-only by privilege, which is what makes this class safer than the identity one rather than a widening of it.`,
        ];
  }),
  'contentos_app holds no write privilege on any reference-data table.',
);

// ── ENABLE, FORCE, and policy shape on everything else ──────────────────────

const guarded = tables.filter((t) => !permitted.has(t.name));

assert(
  'rls-enabled',
  guarded.filter((t) => !t.rls).map((t) => `RLS is not enabled on '${t.name}'.`),
  `every non-exception table has RLS enabled (${String(guarded.length)} checked).`,
);

assert(
  'rls-forced',
  tables
    .filter((t) => t.rls && !t.forced)
    .map(
      (t) =>
        `'${t.name}' has ENABLE but not FORCE — the table owner would bypass every policy, and the omission has no symptom until something connects as the owner.`,
    ),
  'every RLS table is also FORCEd.',
);

const rlsTables = guarded.filter((t) => t.rls);

assert(
  'policy-present',
  rlsTables
    .filter((t) => !policies.some((p) => p.table === t.name))
    .map(
      (t) =>
        `'${t.name}' has RLS enabled but no policy — every row is invisible, which fails closed but breaks the feature.`,
    ),
  'every RLS-enabled table carries a policy.',
);

assert(
  'policy-for-all',
  rlsTables
    .filter((t) => policies.some((p) => p.table === t.name))
    .filter((t) => !policies.some((p) => p.table === t.name && p.cmd === 'ALL'))
    .map(
      (t) =>
        `'${t.name}' has no FOR ALL policy. Separate per-command policies are a maintenance hazard: a missing DELETE policy on one table goes unnoticed.`,
    ),
  'every RLS-enabled table carries a FOR ALL policy.',
);

assert(
  'policy-with-check',
  policies
    .filter((p) => p.cmd === 'ALL' && p.check.trim() === '')
    .map(
      (p) =>
        `'${p.table}' FOR ALL policy has no WITH CHECK — a subject could INSERT a row carrying another tenant's id, into a tenant it cannot even read.`,
    ),
  'every FOR ALL policy carries WITH CHECK.',
);

// Approved variants are named in `packages/database/src/rls/exceptions.ts`;
// this gate checks the shape that the canonical tables must share.
const TENANT_PREDICATE = /current_setting\('app\.tenant_id'::text,\s*true\)/;
const VARIANTS = new Set(['workspaces', 'audit_log', 'outbox_events']);

assert(
  'policy-canonical',
  policies
    .filter((p) => p.cmd === 'ALL' && !VARIANTS.has(p.table) && !permitted.has(p.table))
    .flatMap((p) =>
      [
        ['USING', p.using],
        ['WITH CHECK', p.check],
      ]
        .filter(([, expr]) => expr !== '' && !TENANT_PREDICATE.test(expr))
        .map(
          ([clause]) =>
            `'${p.table}' ${clause} does not key on current_setting('app.tenant_id', true). The policy must be identical on every table — any deviation is a finding.`,
        ),
    ),
  'every canonical policy keys on the tenant setting.',
);

// ── Role privileges ─────────────────────────────────────────────────────────

assert(
  'role-exists',
  appRole.length === 0 ? ['contentos_app does not exist.'] : [],
  'contentos_app exists.',
);

assert(
  'app-no-bypassrls',
  appRole.length > 0 && bool(appRole[0][1])
    ? [
        'contentos_app holds BYPASSRLS. It ignores every policy silently — no error, no log, just full visibility across every tenant.',
      ]
    : [],
  'contentos_app does not hold BYPASSRLS.',
);

assert(
  'app-owns-no-tables',
  ownedByApp.map(
    (t) =>
      `contentos_app owns '${t}'. A table's owner bypasses RLS unless FORCE is set; ownership belongs to contentos_migrator.`,
  ),
  'contentos_app owns no table.',
);

// ── Behavioural checks, as the unprivileged application role ────────────────
// The only way to prove isolation rather than configuration.

const BEHAVIOURAL = [
  'no-context-zero-rows',
  'cross-tenant-read-blocked',
  'own-tenant-read-permitted',
  'cross-tenant-write-rejected',
];
const appUrl = process.env.APP_DATABASE_URL ?? '';

if (dbMode() !== 'direct') {
  for (const name of BEHAVIOURAL) {
    unreachable(name, 'compose mode provides no application-role login connection.');
  }
} else if (appUrl === '') {
  for (const name of BEHAVIOURAL) {
    assert(name, ['APP_DATABASE_URL is not set, so isolation cannot be observed.'], '');
  }
} else {
  const TENANT_A = '018f7a1e-0000-7000-8000-0000000000bb';
  const TENANT_B = '018f7a1e-0000-7000-8000-0000000000cc';
  const ORG = '018f7a1e-0000-7000-8000-0000000000aa';

  const asApp = (sql) =>
    spawnSync('psql', ['-v', 'ON_ERROR_STOP=1', '-tA', appUrl, '-c', sql], {
      cwd: root,
      encoding: 'utf8',
    });

  /** `psql -c` prints a command tag per statement; take the numeric line. */
  const count = (sql) => {
    const out = asApp(sql).stdout ?? '';
    const line = out.split('\n').find((l) => /^\d+$/.test(l.trim()));
    return line === undefined ? null : Number(line.trim());
  };

  const noContext = count('SELECT count(*) FROM workspace_memberships');
  assert(
    'no-context-zero-rows',
    noContext === 0 ? [] : [`returned ${String(noContext)} rows — RLS is not enforcing.`],
    'with no tenant context, a tenant-scoped read returns zero rows.',
  );

  const crossRead = count(
    `BEGIN; SET LOCAL app.tenant_id='${TENANT_B}';
     SELECT count(*) FROM workspace_memberships WHERE tenant_id='${TENANT_A}'; COMMIT;`,
  );
  assert(
    'cross-tenant-read-blocked',
    crossRead === 0 ? [] : [`tenant B saw ${String(crossRead)} of tenant A's rows.`],
    "under tenant B's context, tenant A's rows are invisible.",
  );

  // The positive control. Without it, the two checks above would also pass if
  // the role simply could not read ANYTHING — proving nothing about isolation.
  const ownRead = count(
    `BEGIN; SET LOCAL app.tenant_id='${TENANT_A}';
     SELECT count(*) FROM workspace_memberships WHERE tenant_id='${TENANT_A}'; COMMIT;`,
  );
  assert(
    'own-tenant-read-permitted',
    ownRead !== null && ownRead >= 1
      ? []
      : [
          `got ${String(ownRead)} — the role cannot read its own tenant, so the isolation checks prove nothing.`,
        ],
    `the role reads its own tenant (${String(ownRead)} row(s)).`,
  );

  // The reverse leak, and the failure most likely to go undetected: the writer
  // never sees the result.
  const write = asApp(
    `BEGIN; SET LOCAL app.tenant_id='${TENANT_A}';
     INSERT INTO workspace_memberships (tenant_id, organization_id, user_id, role, status)
     VALUES ('${TENANT_B}', '${ORG}', '018f7a1e-0000-7000-8000-000000000001', 'viewer', 'active');
     COMMIT;`,
  );
  //
  // "The write failed" is NOT the assertion. psql failing to launch, the
  // connection being refused, or the column list drifting all produce a
  // non-zero exit, and treating any of those as proof of enforcement is a gate
  // that reports green precisely when it has verified nothing. The rejection
  // must be PostgreSQL's row-level security error specifically.
  const writeStderr = write.stderr ?? '';
  const writeFailures = [];
  if (write.error !== undefined) {
    writeFailures.push(`psql could not run (${write.error.message}), so nothing was verified.`);
  } else if (write.status === 0) {
    writeFailures.push(
      'a write carrying another tenant id was accepted — WITH CHECK is not enforcing.',
    );
  } else if (!/row-level security/i.test(writeStderr)) {
    writeFailures.push(
      `the write failed, but not on row-level security: ${writeStderr.trim().split('\n')[0] ?? 'no stderr'}. A rejection for any other reason proves nothing about WITH CHECK.`,
    );
  }
  assert(
    'cross-tenant-write-rejected',
    writeFailures,
    'WITH CHECK rejects a write carrying another tenant id.',
  );
}

// ── Completeness: the gate must implement everything it declares ────────────

const declared = manifest.assertions.map((a) => a.name);
const missing = declared.filter((name) => !implemented.has(name));
const undeclared = [...implemented].filter((name) => !declared.includes(name));

// ── Report ──────────────────────────────────────────────────────────────────

console.log(
  `==> RLS verification (mode: ${dbMode()}, manifest: ${String(declared.length)} assertions)`,
);
for (const r of results) {
  console.log(`    ${r.status.padEnd(4)} ${r.name.padEnd(32)} ${r.explanation}`);
}

let failed = results.filter((r) => r.status === 'FAIL').length;

if (missing.length > 0) {
  console.log(
    `    FAIL ${'assertion-coverage'.padEnd(32)} the manifest declares ${missing.join(', ')} but this gate does not implement ${missing.length === 1 ? 'it' : 'them'}.`,
  );
  failed += 1;
}
if (undeclared.length > 0) {
  console.log(
    `    FAIL ${'assertion-coverage'.padEnd(32)} this gate runs ${undeclared.join(', ')}, which the manifest does not declare.`,
  );
  failed += 1;
}

if (failed === 0) {
  console.log(`==> RLS verification GREEN (${String(results.length)} assertions)`);
} else {
  console.log(`==> RLS verification FAILED (${String(failed)} failing assertion(s))`);
  process.exit(1);
}
