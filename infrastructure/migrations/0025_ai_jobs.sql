-- 0025_ai_jobs.sql
--
-- The job record — the unit of work every future AI workflow executes through.
--
-- NO SPECIFICATION DEFINES THIS TABLE. `03-database/tables.md` has no `jobs`,
-- and `08-ai-platform/` describes the Gateway, router and prompt engine without
-- a persisted job. The increment's own column list is therefore the contract,
-- and this file follows it; the two columns it does not name are justified
-- individually below rather than added because every other table has them.
--
-- ── Workspace-owned ─────────────────────────────────────────────────────────
-- A job is work done IN a workspace, so the workspace is the isolation
-- boundary: `workspaces.id` IS `tenant_id` (ADR-017). The increment lists
-- `tenant_id` and `workspace_id` separately, so both are carried and a CHECK
-- ties them together — a job keyed to anything but its own workspace would be
-- invisible to the worker that must run it.
--
-- ── Lifecycle, guarded by predicate ─────────────────────────────────────────
--   queued → running → completed | failed | cancelled
--
-- Every transition is an UPDATE with the CURRENT state in its predicate, so a
-- repeated call matches nothing rather than moving a terminal job. The CHECK
-- constraints make the illegal SHAPES unrepresentable — a completed job with no
-- completion timestamp, a failed one with no reason — and the state machine in
-- `packages/ai` refuses the illegal MOVES before either is reached.
--
-- ROLLBACK: DROP TABLE jobs;

SET LOCAL ROLE contentos_migrator;

CREATE TABLE jobs (
  id              UUID        PRIMARY KEY DEFAULT uuidv7(),

  -- The isolation key. Always the workspace — see the header note.
  tenant_id       UUID        NOT NULL REFERENCES workspaces(id)    ON DELETE RESTRICT,
  workspace_id    UUID        NOT NULL REFERENCES workspaces(id)    ON DELETE RESTRICT,
  -- NOT in the increment's list, and required anyway: every domain event
  -- envelope carries `organizationId`, and `outbox_events.organization_id` is
  -- NOT NULL. Without it a job row cannot produce its own event.
  organization_id UUID        NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,

  job_type        TEXT        NOT NULL,
  status          TEXT        NOT NULL DEFAULT 'queued',

  correlation_id  UUID        NOT NULL,
  -- Null for a root job — one a user started rather than one an event caused.
  causation_id    UUID        NULL,

  -- Identifiers and scalars. A job payload says WHAT to do, not the content it
  -- will produce; nothing here is model output.
  payload         JSONB       NOT NULL DEFAULT '{}'::jsonb,

  -- Also not in the list. A job that failed or was cancelled without a stated
  -- reason cannot be triaged, and this is the only place the why can live —
  -- events carry no free text.
  reason          TEXT        NULL,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),   -- server clock, never client
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at      TIMESTAMPTZ NULL,
  completed_at    TIMESTAMPTZ NULL,

  -- Lowercase, as every other status column on the platform is. The increment
  -- names the states in capitals; the vocabulary is the same five.
  CONSTRAINT ck_jobs__status
    CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),

  -- A job has started if and only if it left `queued`.
  CONSTRAINT ck_jobs__started_at_matches_status
    CHECK ((status = 'queued') = (started_at IS NULL)),

  -- `completed_at` marks the END of the job, whichever way it ended — the
  -- question "when did this stop?" has one answer, not three columns' worth.
  CONSTRAINT ck_jobs__completed_at_matches_status
    CHECK ((status IN ('completed', 'failed', 'cancelled')) = (completed_at IS NOT NULL)),

  -- A terminal-by-failure job explains itself; a successful one has nothing to
  -- explain, and a reason on it would be a result in disguise.
  CONSTRAINT ck_jobs__reason_matches_status
    CHECK ((status IN ('failed', 'cancelled')) = (reason IS NOT NULL)),

  CONSTRAINT ck_jobs__tenant_is_workspace CHECK (tenant_id = workspace_id),
  CONSTRAINT ck_jobs__job_type_present CHECK (btrim(job_type) <> ''),
  CONSTRAINT ck_jobs__payload_object CHECK (jsonb_typeof(payload) = 'object')
);

-- Every index leads with tenant_id (`03-database/indexes.md`).
CREATE INDEX ix_jobs__tenant_created ON jobs (tenant_id, created_at DESC);

-- What a runner claims. Partial, because a terminal job is never revisited and
-- the queue is the hot read on this table.
CREATE INDEX ix_jobs__queued ON jobs (tenant_id, created_at) WHERE status = 'queued';

-- What an operator looks at during an incident: what is in flight right now.
CREATE INDEX ix_jobs__running ON jobs (tenant_id, started_at) WHERE status = 'running';

CREATE INDEX ix_jobs__tenant_type_created ON jobs (tenant_id, job_type, created_at DESC);
CREATE INDEX ix_jobs__correlation ON jobs (correlation_id);

COMMENT ON TABLE jobs IS
  'The unit of work an AI workflow executes through. Lifecycle: queued -> '
  'running -> completed | failed | cancelled, guarded by predicate on every '
  'transition.';
COMMENT ON COLUMN jobs.completed_at IS
  'When the job STOPPED, whichever way it ended — success, failure or cancellation.';

-- ── RLS ─────────────────────────────────────────────────────────────────────
-- Canonical policy. `jobs` carries `tenant_id` and is not an exception, so the
-- set stays closed at five.
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE jobs FORCE  ROW LEVEL SECURITY;
CREATE POLICY jobs_tenant_isolation ON jobs
  FOR ALL TO contentos_app
  USING      (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- Migrate-time assertion, stated about this table by name. Both properties are
-- silent when absent: without FORCE the owner bypasses every policy, and a job
-- readable across tenants is one workspace's work visible to another.
DO $$
DECLARE
  enabled BOOLEAN;
  forced  BOOLEAN;
BEGIN
  SELECT c.relrowsecurity, c.relforcerowsecurity INTO enabled, forced
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'jobs';

  IF NOT enabled OR NOT forced THEN
    RAISE EXCEPTION
      'jobs must have RLS ENABLEd and FORCEd; got enabled=%, forced=%', enabled, forced;
  END IF;
END
$$;

RESET ROLE;
