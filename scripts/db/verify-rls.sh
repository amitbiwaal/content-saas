#!/usr/bin/env bash
# Sprint 0 exit criterion, checked against a REAL PostgreSQL instance.
#
# "Tests run against a real PostgreSQL instance, never a mock. RLS is a database
#  behaviour, and a mocked database asserts the test's assumptions rather than
#  PostgreSQL's semantics." — 16-security/row-level-security.md
#
# SIX OF THE SEVEN RLS FAILURE MODES HAVE NO SYMPTOM. Each is therefore checked
# explicitly rather than inferred from the application appearing to work.
#
# Checks A–E are catalogue assertions. Checks F–H are BEHAVIOURAL: they connect
# as the unprivileged application role and observe what PostgreSQL actually
# does, which is the only way to prove isolation rather than configuration.
set -euo pipefail
cd "$(dirname "$0")/../.."
# shellcheck source=scripts/db/psql.sh
. scripts/db/psql.sh

fail=0
note() { printf '    %-46s %s\n' "$1" "$2"; }
bad() { printf '    FAIL %-41s %s\n' "$1" "$2"; fail=1; }

echo "==> RLS conformance (mode: $(db_mode))"

# ── A · the exception set is exactly five ───────────────────────────────────
count="$(psql_query "SELECT count(*) FROM pg_class c
  JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='public' AND c.relkind='r'
   AND NOT c.relrowsecurity AND c.relname <> 'schema_migrations'" | tr -d '[:space:]')"
if [ "$count" = "5" ]; then note "exception tables" "5"; else
  bad "exception tables" "$count (must be exactly 5; a sixth requires an ADR)"
fi

# ── B · every RLS table is also FORCEd ──────────────────────────────────────
# FORCE omitted has no symptom until something connects as the table owner.
missing_force="$(psql_query "SELECT coalesce(string_agg(c.relname, ','), '') FROM pg_class c
  JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='public' AND c.relkind='r'
   AND c.relrowsecurity AND NOT c.relforcerowsecurity" | tr -d '[:space:]')"
if [ -z "$missing_force" ]; then note "ENABLE + FORCE" "all tables"; else
  bad "missing FORCE" "$missing_force"
fi

# ── C · WITH CHECK on every FOR ALL policy ──────────────────────────────────
# Its absence is worse than a read leak: it permits writing INTO another tenant.
nocheck="$(psql_query "SELECT coalesce(string_agg(tablename, ','), '') FROM pg_policies
 WHERE schemaname='public' AND cmd='ALL' AND with_check IS NULL" | tr -d '[:space:]')"
if [ -z "$nocheck" ]; then note "WITH CHECK on every FOR ALL policy" "present"; else
  bad "policies without WITH CHECK" "$nocheck"
fi

# ── D · contentos_app holds no BYPASSRLS ────────────────────────────────────
bypass="$(psql_query "SELECT rolbypassrls FROM pg_roles WHERE rolname='contentos_app'" | tr -d '[:space:]')"
if [ "$bypass" = "f" ]; then note "contentos_app BYPASSRLS" "no"; else
  bad "contentos_app BYPASSRLS" "'$bypass' — isolation disabled platform-wide"
fi

# ── E · contentos_app owns no tables ────────────────────────────────────────
# A table's owner bypasses RLS by default, which is what FORCE closes.
owned="$(psql_query "SELECT count(*) FROM pg_class c
  JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='public' AND c.relkind='r'
   AND pg_get_userbyid(c.relowner)='contentos_app'" | tr -d '[:space:]')"
if [ "$owned" = "0" ]; then note "contentos_app owns tables" "0"; else
  bad "contentos_app owns tables" "$owned"
fi

# ── Behavioural checks, as the unprivileged application role ────────────────
# Only meaningful in direct mode, where a login connection is available.
if [ "$(db_mode)" != "direct" ]; then
  echo "==> behavioural isolation checks skipped (compose mode)"
else
  APP_URL="${APP_DATABASE_URL:-}"
  if [ -z "$APP_URL" ]; then
    bad "behavioural checks" "APP_DATABASE_URL not set"
  else
    TENANT_A='018f7a1e-0000-7000-8000-0000000000bb'
    TENANT_B='018f7a1e-0000-7000-8000-0000000000cc'
    ORG='018f7a1e-0000-7000-8000-0000000000aa'

    app_sql() { psql -v ON_ERROR_STOP=1 -tA "$APP_URL" -c "$1"; }

    # F · missing context returns ZERO rows rather than everything.
    rows="$(app_sql "SELECT count(*) FROM workspace_memberships" | tr -d '[:space:]')"
    if [ "$rows" = "0" ]; then note "no tenant context -> zero rows" "0"; else
      bad "no tenant context" "returned $rows rows — RLS is not enforcing"
    fi

    # G · with tenant A's context, tenant B's rows are invisible.
    # `psql -c` with a multi-statement string prints a command tag per
    # statement (BEGIN, SET, COMMIT) alongside the result, each on its own
    # line. Select the line that is purely digits rather than stripping
    # whitespace, which would glue the tags to the count.
    visible="$(app_sql "BEGIN; SET LOCAL app.tenant_id='${TENANT_B}';
      SELECT count(*) FROM workspace_memberships WHERE tenant_id='${TENANT_A}'; COMMIT;" \
      | grep -E '^[0-9]+$' | head -1)"
    if [ "${visible}" = "0" ]; then
      note "cross-tenant read blocked" "0 rows"
    else
      bad "cross-tenant read" "tenant B saw '${visible}' of tenant A's rows"
    fi

    # G2 · the positive control. Without this, checks F and G would also pass if
    # the role simply could not read ANYTHING — proving nothing about isolation.
    own="$(app_sql "BEGIN; SET LOCAL app.tenant_id='${TENANT_A}';
      SELECT count(*) FROM workspace_memberships WHERE tenant_id='${TENANT_A}'; COMMIT;" \
      | grep -E '^[0-9]+$' | head -1)"
    if [ "${own}" -ge 1 ] 2>/dev/null; then
      note "own-tenant read permitted (positive control)" "${own} row(s)"
    else
      bad "own-tenant read" "got '${own}' — the role cannot read its own tenant, so the isolation checks prove nothing"
    fi

    # H · WITH CHECK rejects a write carrying another tenant's id.
    # This is the reverse leak, and the writer never sees the result — so it is
    # the failure most likely to go undetected without an explicit test.
    if app_sql "BEGIN; SET LOCAL app.tenant_id='${TENANT_A}';
      INSERT INTO workspace_memberships (tenant_id, organization_id, user_id, role, status)
      VALUES ('${TENANT_B}', '${ORG}', '018f7a1e-0000-7000-8000-000000000001', 'viewer', 'active');
      COMMIT;" >/dev/null 2>&1; then
      bad "cross-tenant WRITE" "accepted — WITH CHECK is not enforcing"
    else
      note "cross-tenant write rejected by WITH CHECK" "rejected"
    fi
  fi
fi

if [ "$fail" = "0" ]; then
  echo "==> RLS conformance GREEN"
else
  echo "==> RLS conformance FAILED"
  exit 1
fi
