-- 0014_platform.sql
--
-- Spec: 03-database/migrations.md — 0014 platform. Table detail:
-- 03-database/tables.md §8. Service contract: 04-platform/credits.md.
--
-- SCOPE. migrations.md lists 0014 as `credit_holds, credit_ledger_entries,
-- ai_call_costs, media_assets`. This increment delivers the LEDGER only —
-- the immutable financial record everything else in Commerce is built on.
-- `credit_holds` belongs with the hold→consume→settle protocol, `ai_call_costs`
-- with the AI Gateway, and `media_assets` with Storage; each arrives with the
-- service that owns it. Migrations are append-only, so those land as later
-- numbered files rather than as edits to this one.
--
-- ── Why the ledger is append-only at the ROLE level ─────────────────────────
-- "Corrections are compensating entries, never edits. The ledger has no UPDATE
--  path — UPDATE and DELETE are revoked at the role level."
--   — 04-platform/credits.md §Ledger
--
-- A convention that says "don't update" is enforced by whoever remembers it.
-- A revoked privilege is enforced by PostgreSQL against every caller including
-- an administrative one, which is what makes the balance auditable to any point
-- in time: no row that was ever true can stop being true.
--
-- ROLLBACK: DROP TABLE credit_ledger_entries;

SET LOCAL ROLE contentos_migrator;

-- ── credit_ledger_entries ───────────────────────────────────────────────────
--
-- TENANT KEY. `tenant_id` is the ORGANIZATION id here, not a workspace id.
--
-- "Balance resolves at the organization level, because that is what was
--  purchased; consumption is attributed at the workspace level, because that is
--  where the work happened." — 04-platform/credits.md §"Domain boundaries"
--
-- The credit account is an organization-owned aggregate, so the organization is
-- its isolation scope (ADR-029). ADR-017 makes the WORKSPACE the tenant for
-- workspace-owned data; a ledger keyed that way could not serve
-- `GET /v1/organizations/{id}/credits/ledger` without a cross-tenant read, and
-- an agency could not report across its clients without one either. The
-- workspace travels as an ATTRIBUTION column instead, which is what
-- tables.md §8 means by "both identifiers on every ledger row".
--
-- The equality is a CHECK rather than a comment because a row written under a
-- workspace tenant context would be invisible to every organization-level
-- balance read — silently, and forever, since it can never be corrected by
-- UPDATE.
CREATE TABLE credit_ledger_entries (
  id                 UUID          PRIMARY KEY DEFAULT uuidv7(),

  tenant_id          UUID          NOT NULL,
  organization_id    UUID          NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  -- NULL for organization-level entries: a purchase grants to the organization,
  -- and an allowance expires from it. Consumption always names a workspace.
  workspace_id       UUID          NULL     REFERENCES workspaces(id)    ON DELETE RESTRICT,

  entry_type         TEXT          NOT NULL,
  -- Sign is carried by `entry_type`/`direction`, never by the magnitude:
  -- "Prevents a negative grant masquerading as a charge" (tables.md §8).
  amount             NUMERIC(20,6) NOT NULL,
  direction          TEXT          NOT NULL,

  -- A retried AI call must not double-charge (credits.md §Security). NULL where
  -- the write has no natural key — a support adjustment, a manual grant.
  idempotency_key    TEXT          NULL,

  -- The compensating-entry link: a refund names the charge it reverses.
  reference_entry_id UUID          NULL REFERENCES credit_ledger_entries(id) ON DELETE RESTRICT,

  reason             TEXT          NOT NULL,
  correlation_id     UUID          NOT NULL,
  created_by         UUID          NULL REFERENCES users(id) ON DELETE RESTRICT,
  metadata           JSONB         NOT NULL DEFAULT '{}'::jsonb,
  created_at         TIMESTAMPTZ   NOT NULL DEFAULT now(),   -- server clock, never client

  CONSTRAINT ck_credit_ledger_entries__entry_type
    CHECK (entry_type IN ('grant','consumption','refund','adjustment','expiry')),

  CONSTRAINT ck_credit_ledger_entries__amount_non_negative CHECK (amount >= 0),

  CONSTRAINT ck_credit_ledger_entries__direction
    CHECK (direction IN ('credit','debit')),

  -- Four of the five types determine their own direction. An `adjustment` does
  -- not: support may add or remove, which is exactly why it is audited and
  -- carries a mandatory reason. Leaving it free here is deliberate; the
  -- alternative is a negative amount, which the constraint above forbids.
  CONSTRAINT ck_credit_ledger_entries__direction_matches_type
    CHECK (CASE entry_type
             WHEN 'grant'       THEN direction = 'credit'
             WHEN 'refund'      THEN direction = 'credit'
             WHEN 'consumption' THEN direction = 'debit'
             WHEN 'expiry'      THEN direction = 'debit'
             WHEN 'adjustment'  THEN true
             -- A CASE with no ELSE yields NULL, and a CHECK that evaluates to
             -- NULL PASSES. The constraint above already confines entry_type,
             -- so this is unreachable — but it means relaxing that constraint
             -- cannot silently switch this one off.
             ELSE false
           END),

  -- The credit account is organization-owned; see the header note.
  CONSTRAINT ck_credit_ledger_entries__tenant_is_organization
    CHECK (tenant_id = organization_id),

  -- Consumption is attributed; organization-level entries are not.
  CONSTRAINT ck_credit_ledger_entries__consumption_names_workspace
    CHECK (entry_type <> 'consumption' OR workspace_id IS NOT NULL),

  CONSTRAINT ck_credit_ledger_entries__reason_present CHECK (btrim(reason) <> ''),

  CONSTRAINT ck_credit_ledger_entries__metadata_object
    CHECK (jsonb_typeof(metadata) = 'object'),

  -- THE constraint, not application logic, is what makes a concurrent duplicate
  -- safe — the same reasoning as `idempotency_keys` (tables.md §8). Scoped to
  -- the tenant so two organizations cannot collide; PostgreSQL treats NULLs as
  -- distinct, so keyless entries are unaffected.
  CONSTRAINT uq_credit_ledger_entries__tenant_idempotency_key
    UNIQUE (tenant_id, idempotency_key)
);

-- Reconciliation and the organization ledger history, newest first.
CREATE INDEX ix_credit_ledger_entries__tenant_created
  ON credit_ledger_entries (tenant_id, created_at DESC);

-- Per-workspace attribution. Leads with tenant_id (indexes.md), and is partial
-- because organization-level entries have no workspace to attribute to.
CREATE INDEX ix_credit_ledger_entries__workspace_created
  ON credit_ledger_entries (tenant_id, workspace_id, created_at DESC)
  WHERE workspace_id IS NOT NULL;

CREATE INDEX ix_credit_ledger_entries__correlation
  ON credit_ledger_entries (correlation_id);

-- Following a correction chain back to the charge it reverses.
CREATE INDEX ix_credit_ledger_entries__reference
  ON credit_ledger_entries (reference_entry_id) WHERE reference_entry_id IS NOT NULL;

COMMENT ON TABLE credit_ledger_entries IS
  'Immutable financial record. Append-only: UPDATE and DELETE are revoked from '
  'contentos_app. Corrections are compensating rows referencing the original.';
COMMENT ON COLUMN credit_ledger_entries.tenant_id IS
  'The organization id. The credit account is organization-owned (ADR-029); '
  'workspace_id carries attribution.';

-- ── Append-only, enforced by privilege ──────────────────────────────────────
-- 0002 grants SELECT, INSERT, UPDATE, DELETE by default privilege. Two of those
-- are taken straight back: no application code path can mutate a ledger row,
-- including an administrative one (credits.md §Security).
REVOKE UPDATE, DELETE ON credit_ledger_entries FROM contentos_app;

-- ── RLS ─────────────────────────────────────────────────────────────────────
-- Canonical policy, no deviation: the table carries `tenant_id` and is not an
-- exception. The exception set stays closed at five.
ALTER TABLE credit_ledger_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_ledger_entries FORCE  ROW LEVEL SECURITY;
CREATE POLICY credit_ledger_entries_tenant_isolation ON credit_ledger_entries
  FOR ALL TO contentos_app
  USING      (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- Migrate-time assertion, stated about THIS table by name rather than as a
-- count of something else. Both properties are silent when absent: a ledger
-- without FORCE is mutable by its owner, and one where the app kept UPDATE is
-- append-only by convention only.
DO $$
DECLARE
  enabled  BOOLEAN;
  forced   BOOLEAN;
  writable TEXT;
BEGIN
  SELECT c.relrowsecurity, c.relforcerowsecurity INTO enabled, forced
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'credit_ledger_entries';

  IF NOT enabled OR NOT forced THEN
    RAISE EXCEPTION
      'credit_ledger_entries must have RLS ENABLEd and FORCEd; got enabled=%, forced=%',
      enabled, forced;
  END IF;

  -- Read straight out of the ACL rather than through has_table_privilege():
  -- this block runs as contentos_migrator, which is not a member of
  -- contentos_app, and the catalog is answerable without membership in the role
  -- being asked about. A NULL relacl means owner-only, which is also a pass.
  SELECT string_agg(a.privilege_type, ', ') INTO writable
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN LATERAL aclexplode(c.relacl) AS a
    JOIN pg_roles r ON r.oid = a.grantee
   WHERE n.nspname = 'public'
     AND c.relname = 'credit_ledger_entries'
     AND r.rolname = 'contentos_app'
     AND a.privilege_type IN ('UPDATE', 'DELETE');

  IF writable IS NOT NULL THEN
    RAISE EXCEPTION
      'The ledger is append-only, but contentos_app still holds % on credit_ledger_entries.',
      writable;
  END IF;
END
$$;

RESET ROLE;
