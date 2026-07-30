-- 0022_credits_service.sql
--
-- `credit_holds` and `credit_balances` — the hold protocol and the balance read
-- model. Service contract: 04-platform/credits.md. Ledger: 0014_platform.sql.
--
-- NUMBERING: 03-database/migrations.md lists `credit_holds` under 0014, which
-- has shipped. Migrations are append-only, so the table arrives here rather
-- than as an edit to a file already applied — the same reasoning 0021 records.
-- No documented number changes meaning.
--
-- NOTHING IN 0014 IS TOUCHED. The ledger schema is frozen; this migration only
-- adds tables that read from it.
--
-- ── Why a hold exists at all ────────────────────────────────────────────────
-- "AI spend is unbounded by nature. Without a hold placed before work begins, a
--  single runaway pipeline could consume a month of margin, and a customer
--  could be charged for work that never completed." — credits.md §Purpose
--
-- ── Why the balance is a table and never a column ───────────────────────────
-- "Balance is never stored as a mutable column. It is computed from the ledger
--  and cached in a read model with a watermark; a stored balance would
--  eventually drift from its own history, and the drift would be undetectable."
--   — credits.md §"Database impact"
--
-- `credit_balances` is that cache. It holds the two SUMS and a watermark, never
-- an authoritative figure: everything in it is derivable from the ledger, and
-- the watermark is what lets a reader notice it is behind and aggregate instead.
--
-- ROLLBACK: DROP TABLE credit_balances, credit_holds;

SET LOCAL ROLE contentos_migrator;

-- ── credit_holds ────────────────────────────────────────────────────────────
--
-- TENANT KEY: the organization, matching the ledger. Balance resolves per
-- organization, so a reservation against it belongs to the same scope
-- (ADR-029). `workspace_id` is where the work happens, and is what a workspace
-- suspension releases against.
CREATE TABLE credit_holds (
  id              UUID          PRIMARY KEY DEFAULT uuidv7(),

  tenant_id       UUID          NOT NULL,
  organization_id UUID          NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  workspace_id    UUID          NOT NULL REFERENCES workspaces(id)    ON DELETE RESTRICT,

  -- One hold per run. `authorizeSpend` is retried by Temporal, so the
  -- CONSTRAINT is what makes the retry converge rather than reserve twice
  -- (credits.md §"Implementation notes").
  run_id          TEXT          NOT NULL,

  -- The reserved maximum. This is the bound on worst-case spend, which is the
  -- entire reason the hold is taken before any provider is called.
  amount          NUMERIC(20,6) NOT NULL,
  -- Actual spend recorded against the hold so far, advanced ONLY when a ledger
  -- row was really written. The CHECK below is what makes the bound real.
  consumed        NUMERIC(20,6) NOT NULL DEFAULT 0,

  state           TEXT          NOT NULL DEFAULT 'held',

  -- "A crashed orchestrator could otherwise strand a hold forever, silently
  --  reducing a customer's available balance" (credits.md §"Hold lifecycle").
  expires_at      TIMESTAMPTZ   NOT NULL,

  reason          TEXT          NOT NULL,
  correlation_id  UUID          NOT NULL,
  created_by      UUID          NULL REFERENCES users(id) ON DELETE RESTRICT,
  metadata        JSONB         NOT NULL DEFAULT '{}'::jsonb,

  created_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),
  -- Set together with the terminal state, never before it.
  settled_at      TIMESTAMPTZ   NULL,
  released_at     TIMESTAMPTZ   NULL,

  CONSTRAINT ck_credit_holds__state
    CHECK (state IN ('held', 'settled', 'released', 'expired')),

  CONSTRAINT ck_credit_holds__amount_non_negative CHECK (amount >= 0),
  CONSTRAINT ck_credit_holds__consumed_non_negative CHECK (consumed >= 0),

  -- The bound, enforced by the database rather than by the caller remembering.
  -- Without it a runaway pipeline spends past its reservation and the hold
  -- protocol guarantees nothing.
  CONSTRAINT ck_credit_holds__consumed_within_hold CHECK (consumed <= amount),

  -- A terminal state carries its timestamp, and a live one carries neither.
  CONSTRAINT ck_credit_holds__settled_at_matches_state
    CHECK ((state = 'settled') = (settled_at IS NOT NULL)),
  CONSTRAINT ck_credit_holds__released_at_matches_state
    CHECK ((state IN ('released', 'expired')) = (released_at IS NOT NULL)),

  CONSTRAINT ck_credit_holds__tenant_is_organization CHECK (tenant_id = organization_id),
  CONSTRAINT ck_credit_holds__reason_present CHECK (btrim(reason) <> ''),
  CONSTRAINT ck_credit_holds__run_id_present CHECK (btrim(run_id) <> ''),
  CONSTRAINT ck_credit_holds__metadata_object CHECK (jsonb_typeof(metadata) = 'object'),

  -- DEVIATION, RECORDED: tables.md §8 specifies `UNIQUE (run_id)` globally.
  -- Scoped to the tenant here for the same reason `idempotency_keys` is: a
  -- global constraint makes a cross-tenant collision observable as a unique
  -- violation, which discloses that another organization holds that id. Run ids
  -- are uuids, so tenant scoping costs nothing.
  CONSTRAINT uq_credit_holds__tenant_run UNIQUE (tenant_id, run_id)
);

-- `authorizeSpend` sums the OPEN holds for an organization on the critical path
-- of every run start, so that sum must not scan settled history.
CREATE INDEX ix_credit_holds__open_by_tenant
  ON credit_holds (tenant_id, created_at DESC) WHERE state = 'held';

-- What a workspace suspension releases against.
CREATE INDEX ix_credit_holds__open_by_workspace
  ON credit_holds (tenant_id, workspace_id) WHERE state = 'held';

-- The expiry sweep. Partial, because an expired hold is never revisited.
CREATE INDEX ix_credit_holds__expiring ON credit_holds (expires_at) WHERE state = 'held';

CREATE INDEX ix_credit_holds__correlation ON credit_holds (correlation_id);

COMMENT ON COLUMN credit_holds.consumed IS
  'Advanced only when a ledger row was actually written. The ledger is the '
  'record of what was charged; this is the running total against the bound.';

-- ── credit_balances ─────────────────────────────────────────────────────────
--
-- A CACHE OF TWO SUMS, plus where in the ledger they were computed from.
-- Nothing here is authoritative: a reader compares the watermark against the
-- ledger and aggregates directly when it is behind, which is what makes a stale
-- projection a slow answer rather than a wrong one.
CREATE TABLE credit_balances (
  tenant_id            UUID          PRIMARY KEY,
  organization_id      UUID          NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,

  -- Kept separately rather than as one net figure: a net balance cannot be
  -- reconciled against the ledger without recomputing both halves anyway, and
  -- the pair is what the reconciliation job compares.
  credited             NUMERIC(20,6) NOT NULL DEFAULT 0,
  debited              NUMERIC(20,6) NOT NULL DEFAULT 0,
  entries_projected    BIGINT        NOT NULL DEFAULT 0,

  -- The watermark: the (created_at, id) of the last ledger entry incorporated,
  -- matching the ledger's own ordering. NULL means nothing projected yet.
  projected_through_at TIMESTAMPTZ   NULL,
  projected_through_id UUID          NULL,
  projected_at         TIMESTAMPTZ   NOT NULL DEFAULT now(),

  -- Which threshold event was last published. `CreditsLow` and
  -- `CreditsExhausted` fire on the TRANSITION into a state, so the state has to
  -- be remembered — otherwise every consumption past the threshold re-publishes
  -- and the notification becomes noise nobody reads.
  threshold_state      TEXT          NOT NULL DEFAULT 'ok',

  updated_at           TIMESTAMPTZ   NOT NULL DEFAULT now(),

  CONSTRAINT ck_credit_balances__tenant_is_organization
    CHECK (tenant_id = organization_id),
  CONSTRAINT ck_credit_balances__credited_non_negative CHECK (credited >= 0),
  CONSTRAINT ck_credit_balances__debited_non_negative CHECK (debited >= 0),
  CONSTRAINT ck_credit_balances__entries_non_negative CHECK (entries_projected >= 0),
  CONSTRAINT ck_credit_balances__threshold_state
    CHECK (threshold_state IN ('ok', 'low', 'exhausted')),
  -- Both halves of the watermark, or neither. One without the other cannot be
  -- compared against `(created_at, id)` and would silently read as "nothing
  -- projected", re-aggregating the whole ledger on every request.
  CONSTRAINT ck_credit_balances__watermark_complete
    CHECK ((projected_through_at IS NULL) = (projected_through_id IS NULL)),
  CONSTRAINT ck_credit_balances__watermark_matches_count
    CHECK ((entries_projected = 0) = (projected_through_id IS NULL))
);

COMMENT ON TABLE credit_balances IS
  'Read model. Every column is derivable from credit_ledger_entries; the '
  'watermark is what lets a reader detect that it is behind and aggregate.';

-- ── RLS ─────────────────────────────────────────────────────────────────────
-- Canonical policy on both. Neither is an exception, so the set stays at five.
ALTER TABLE credit_holds ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_holds FORCE  ROW LEVEL SECURITY;
CREATE POLICY credit_holds_tenant_isolation ON credit_holds
  FOR ALL TO contentos_app
  USING      (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE credit_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_balances FORCE  ROW LEVEL SECURITY;
CREATE POLICY credit_balances_tenant_isolation ON credit_balances
  FOR ALL TO contentos_app
  USING      (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- Migrate-time assertion, stated about these tables by name. Both properties
-- are silent when absent: without FORCE the owner bypasses every policy.
DO $$
DECLARE
  unprotected TEXT;
BEGIN
  SELECT string_agg(c.relname, ', ') INTO unprotected
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relname IN ('credit_holds', 'credit_balances')
     AND NOT (c.relrowsecurity AND c.relforcerowsecurity);

  IF unprotected IS NOT NULL THEN
    RAISE EXCEPTION 'Credits tables missing RLS ENABLE or FORCE: %', unprotected;
  END IF;

  -- The ledger must still be append-only. This migration does not touch it, and
  -- this is what proves a later edit to this file could not quietly re-grant.
  IF EXISTS (
    SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL aclexplode(c.relacl) AS a
      JOIN pg_roles r ON r.oid = a.grantee
     WHERE n.nspname = 'public'
       AND c.relname = 'credit_ledger_entries'
       AND r.rolname = 'contentos_app'
       AND a.privilege_type IN ('UPDATE', 'DELETE')
  ) THEN
    RAISE EXCEPTION
      'credit_ledger_entries is no longer append-only: contentos_app holds UPDATE or DELETE.';
  END IF;
END
$$;

RESET ROLE;
