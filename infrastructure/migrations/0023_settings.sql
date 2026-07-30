-- 0023_settings.sql
--
-- The organization settings layer. Spec: `04-platform/settings.md`
-- §"Database impact" — "reads `organizations.settings`, `workspaces.settings`".
--
-- `workspaces.settings` has existed since 0004. The organization half was never
-- created: 0003 gave `organizations` only `plan_limits`, which is "a projection
-- from Commerce, never authored here" and therefore cannot serve as the
-- customer-authored layer the resolver needs above the workspace.
--
-- ── Why this is an EXPAND and rewrites nothing ──────────────────────────────
-- `ADD COLUMN ... NOT NULL DEFAULT '{}'::jsonb` with a CONSTANT default does
-- not rewrite the table: PostgreSQL 11+ stores the default in the catalogue and
-- materialises it on read. `03-database/migrations.md` prohibits a VOLATILE
-- default for exactly the reason this one is safe.
--
-- ── No settings_registry table, deliberately ────────────────────────────────
-- settings.md sketches `settings_registry` as seeded reference data. The key
-- catalogue is SOURCE-CONTROLLED here instead, the same decision the event
-- registry took in T3.1: "loaded at startup, never a runtime table". A registry
-- in the database is editable at runtime, and a setting whose type or scope can
-- change under a running process is a validation rule that means nothing. It
-- would also be the platform's first ADR-025 reference-data table, which this
-- increment has no need to introduce.
--
-- `settings_history` is likewise absent: it records WRITES, and settings are
-- read-only in this increment. `workspace_settings_history` already covers the
-- one layer that has a write path.
--
-- ROLLBACK: ALTER TABLE organizations DROP COLUMN settings;

SET LOCAL ROLE contentos_migrator;

-- The organization layer. Empty means "this layer expresses nothing", which is
-- what every organization should say until an admin configures one — rule 4 of
-- settings.md: absence falls through, and a stored explicit null to mean "no
-- constraint" is prohibited.
ALTER TABLE organizations
  ADD COLUMN settings JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE organizations
  ADD CONSTRAINT ck_organizations__settings_object
    CHECK (jsonb_typeof(settings) = 'object');

COMMENT ON COLUMN organizations.settings IS
  'The organization settings LAYER. Precedence across layers belongs to the '
  'resolver (settings.md / ADR-024); no consumer may read this and combine it '
  'with another layer itself.';

-- `organizations` remains RLS EXCEPTION 1/5 — adding a column changes nothing
-- about that, and this asserts it rather than assuming it.
DO $$
DECLARE
  protected BOOLEAN;
BEGIN
  SELECT c.relrowsecurity INTO protected
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'organizations';

  IF protected THEN
    RAISE EXCEPTION
      'organizations gained RLS; it is a documented identity exception and the resolver reads it above the tenant boundary.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'organizations'
       AND column_name = 'settings' AND data_type = 'jsonb'
  ) THEN
    RAISE EXCEPTION 'organizations.settings is missing or is not jsonb.';
  END IF;
END
$$;

RESET ROLE;
