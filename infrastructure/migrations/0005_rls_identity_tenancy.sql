-- 0005_rls_identity_tenancy.sql
--
-- Spec: 03-database/migrations.md — 0005 rls_identity_tenancy:
--   "policies + the five documented exceptions".
-- Canonical model: 16-security/row-level-security.md.
--
-- Both ENABLE and FORCE are required on every RLS-protected table.
--   ENABLE activates policies for ordinary roles.
--   FORCE additionally applies them to the TABLE OWNER.
-- Without FORCE, any connection as the owning role sees every tenant's rows —
-- including migrations and maintenance scripts. Its absence is invisible until
-- it matters.
--
-- The policy is IDENTICAL on every table. Not similar — identical, differing
-- only in table name. Uniformity is what makes automated verification possible:
-- any deviation is a finding, without a human deciding whether a variation is
-- legitimate.
--
-- ROLLBACK: ALTER TABLE <t> DISABLE ROW LEVEL SECURITY;
--           DROP POLICY <t>_tenant_isolation ON <t>;
--   NOTE: rolling this back removes tenant isolation. It is listed for
--   completeness; the correct recovery from a bad policy is to roll forward.

SET LOCAL ROLE contentos_migrator;

-- ─────────────────────────────────────────────────────────────────────────────
-- Tenant-scoped tables: the canonical policy.
--
-- USING      governs which rows are VISIBLE to SELECT/UPDATE/DELETE.
-- WITH CHECK governs which rows may be WRITTEN by INSERT/UPDATE.
--
-- WITH CHECK is the clause that gets forgotten, and its absence is worse than a
-- read leak: with USING alone a subject can INSERT a row carrying another
-- tenant's tenant_id — injecting data into a tenant they cannot even read, and
-- never seeing the result.
--
-- current_setting('app.tenant_id', true) returns NULL when unset rather than
-- raising, and a NULL tenant matches no row. A connection that forgot to set
-- context therefore reads zero rows and writes nothing — failing closed.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE workspace_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_memberships FORCE  ROW LEVEL SECURITY;
CREATE POLICY workspace_memberships_tenant_isolation ON workspace_memberships
  FOR ALL
  TO contentos_app
  USING      (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE workspace_settings_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_settings_history FORCE  ROW LEVEL SECURITY;
CREATE POLICY workspace_settings_history_tenant_isolation ON workspace_settings_history
  FOR ALL
  TO contentos_app
  USING      (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- ─────────────────────────────────────────────────────────────────────────────
-- workspaces — DOCUMENTED DEVIATION.
--
-- tables.md §2: "RLS: keys on `id = current_setting('app.tenant_id')`, plus an
-- org-scoped read policy so an org admin can list workspaces without entering
-- them."
--
-- The key column is `id`, not `tenant_id`, because workspaces.id IS the tenant.
-- The second policy is READ-ONLY (FOR SELECT) and org-scoped; it deliberately
-- carries no WITH CHECK because it grants no write path.
--
-- The conformance suite records this as an approved variant rather than
-- treating it as drift — see packages/database/src/rls/exceptions.ts.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspaces FORCE  ROW LEVEL SECURITY;

CREATE POLICY workspaces_tenant_isolation ON workspaces
  FOR ALL
  TO contentos_app
  USING      (id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (id = current_setting('app.tenant_id', true)::uuid);

-- Org-scoped listing. Read-only by construction.
CREATE POLICY workspaces_org_read ON workspaces
  FOR SELECT
  TO contentos_app
  USING (organization_id = current_setting('app.organization_id', true)::uuid);

-- ─────────────────────────────────────────────────────────────────────────────
-- The five RLS exceptions.
--
-- These are NOT given policies. Each is consulted at a point in the request
-- lifecycle where tenant_id is not yet known — during authentication, or while
-- determining which tenants the subject may access. A tenant-scoped policy on a
-- table needed to DETERMINE the tenant is circular.
--
-- Isolation for these rests on explicit application-layer filtering, reached
-- only through TenantScopedConnection.withoutTenant(reason), whose reason is a
-- closed union so the call sites are countable by grep.
--
-- The set is CLOSED at five. A sixth requires an ADR. The conformance suite
-- fails the build on a sixth, and equally on a missing one.
-- ─────────────────────────────────────────────────────────────────────────────

COMMENT ON TABLE users IS
  'RLS EXCEPTION (1/5, identity class) — identity spans tenants; read before tenant context exists. Closed set; a sixth requires an ADR.';
COMMENT ON TABLE organizations IS
  'RLS EXCEPTION (2/5, identity class) — above the workspace boundary. Closed set; a sixth requires an ADR.';
COMMENT ON TABLE organization_memberships IS
  'RLS EXCEPTION (3/5, identity class) — resolves which tenants a subject may reach. Closed set; a sixth requires an ADR.';
COMMENT ON TABLE verified_domains IS
  'RLS EXCEPTION (4/5, identity class) — organization-level, consulted at login pre-tenant. Closed set; a sixth requires an ADR.';
COMMENT ON TABLE sso_configurations IS
  'RLS EXCEPTION (5/5, identity class) — resolved from email domain before any workspace is known. Closed set; a sixth requires an ADR.';

-- ─────────────────────────────────────────────────────────────────────────────
-- Migrate-time assertions. The conformance suite re-checks all of these on
-- every CI run; asserting here as well means a bad migration fails at apply
-- rather than at the next test run.
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  missing_force TEXT;
  exception_count INT;
BEGIN
  -- Every RLS-enabled table must also be FORCEd.
  SELECT string_agg(c.relname, ', ')
    INTO missing_force
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relkind = 'r'
     AND c.relrowsecurity
     AND NOT c.relforcerowsecurity;

  IF missing_force IS NOT NULL THEN
    RAISE EXCEPTION 'RLS enabled without FORCE on: %', missing_force;
  END IF;

  -- The exception set is exactly five.
  SELECT count(*)
    INTO exception_count
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relkind = 'r'
     AND NOT c.relrowsecurity;

  IF exception_count <> 5 THEN
    RAISE EXCEPTION
      'RLS exception set must be exactly 5 tables; found %. A sixth requires an ADR.',
      exception_count;
  END IF;
END
$$;

RESET ROLE;
