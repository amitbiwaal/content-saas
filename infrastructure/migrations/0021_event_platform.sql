-- 0021_event_platform.sql
--
-- `dead_letter_events` (ADR-027) and `replay_runs` (ADR-028).
--
-- NUMBERING: 03-database/migrations.md fixes an order through 0020. These two
-- tables were introduced by Phase 8 after that list was written — see
-- 13-event-platform/event-apis.md §"Database impact", which records Phase 8's
-- footprint as `outbox_events.publish_attempts`, `dead_letter_events`, and
-- `replay_runs`. They are appended rather than inserted, so no documented
-- number changes meaning.
--
-- ROLLBACK: DROP TABLE replay_runs, dead_letter_events;

SET LOCAL ROLE contentos_migrator;

-- ── dead_letter_events (ADR-027) ────────────────────────────────────────────
-- "No event is silently discarded." Every terminal failure lands here, and
-- there is no delete path — only retention of already-resolved entries.
CREATE TABLE dead_letter_events (
  id                UUID        PRIMARY KEY DEFAULT uuidv7(),
  tenant_id         UUID        NOT NULL,
  organization_id   UUID        NOT NULL,

  event_id          UUID        NOT NULL,
  event_type        TEXT        NOT NULL,
  event_version     INTEGER     NOT NULL,
  aggregate_type    TEXT        NOT NULL,
  aggregate_id      UUID        NOT NULL,
  correlation_id    UUID        NOT NULL,
  causation_id      UUID        NULL,
  producer          TEXT        NOT NULL,
  occurred_at       TIMESTAMPTZ NOT NULL,
  payload           JSONB       NOT NULL,

  -- Publish-side entries use a sentinel group so one uniqueness rule covers
  -- both sources (dead-letter-queue.md).
  source            TEXT        NOT NULL,
  consumer_group    TEXT        NOT NULL,
  failure_code      TEXT        NOT NULL,
  failure_message   TEXT        NOT NULL,
  retry_history     JSONB       NOT NULL DEFAULT '[]'::jsonb,

  status            TEXT        NOT NULL DEFAULT 'quarantined',
  dead_lettered_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at       TIMESTAMPTZ NULL,
  resolved_by       TEXT        NULL,
  resolution_note   TEXT        NULL,

  CONSTRAINT uq_dle__event_group UNIQUE (event_id, consumer_group),
  CONSTRAINT ck_dle__status
    CHECK (status IN ('quarantined','replaying','resolved','discarded')),
  CONSTRAINT ck_dle__source CHECK (source IN ('publish','delivery')),
  -- A terminal transition requires an actor AND a note. Both, or neither.
  CONSTRAINT ck_dle__terminal_requires_actor_and_note
    CHECK ((status IN ('resolved','discarded'))
           = (resolution_note IS NOT NULL AND resolved_by IS NOT NULL)),
  CONSTRAINT ck_dle__source_matches_group
    CHECK ((source = 'delivery') = (consumer_group <> '__publish__')),
  CONSTRAINT ck_dle__history_array CHECK (jsonb_typeof(retry_history) = 'array')
);

CREATE INDEX ix_dle__tenant_status_time
  ON dead_letter_events (tenant_id, status, dead_lettered_at DESC);
CREATE INDEX ix_dle__correlation ON dead_letter_events (correlation_id);
CREATE INDEX ix_dle__type_failure
  ON dead_letter_events (event_type, failure_code) WHERE status = 'quarantined';

-- There is no delete path. Removal happens only through retention of entries
-- already resolved or discarded.
REVOKE DELETE ON dead_letter_events FROM contentos_app;

ALTER TABLE dead_letter_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE dead_letter_events FORCE  ROW LEVEL SECURITY;
CREATE POLICY dead_letter_events_tenant_isolation ON dead_letter_events
  FOR ALL TO contentos_app
  USING      (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- ── replay_runs (ADR-028) ───────────────────────────────────────────────────
-- Operator-scoped rather than workspace-owned; a tenant-filtered replay records
-- `tenant_id` for audit. It still carries the column and the canonical policy,
-- so the exception set stays closed at five.
CREATE TABLE replay_runs (
  id                     UUID        PRIMARY KEY DEFAULT uuidv7(),
  tenant_id              UUID        NOT NULL,
  organization_id        UUID        NOT NULL,

  mode                   TEXT        NOT NULL,
  request                JSONB       NOT NULL,
  target_group           TEXT        NOT NULL,
  status                 TEXT        NOT NULL DEFAULT 'pending',

  delivered              BIGINT      NOT NULL DEFAULT 0,
  skipped                BIGINT      NOT NULL DEFAULT 0,
  skip_reasons           JSONB       NOT NULL DEFAULT '{}'::jsonb,
  suppressed_as_duplicate BIGINT     NOT NULL DEFAULT 0,
  checkpoint             TEXT        NULL,

  started_by             TEXT        NOT NULL,
  started_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at            TIMESTAMPTZ NULL,

  CONSTRAINT ck_replay_runs__status
    CHECK (status IN ('pending','running','paused','completed','aborted','failed')),
  CONSTRAINT ck_replay_runs__counts_non_negative
    CHECK (delivered >= 0 AND skipped >= 0 AND suppressed_as_duplicate >= 0)
);

-- ADR-028's coordination token: one active run per target group, enforced by
-- the database rather than by a lock a caller might forget to take.
CREATE UNIQUE INDEX uq_replay_runs__active_per_group
  ON replay_runs (target_group)
  WHERE status IN ('pending','running','paused');

CREATE INDEX ix_replay_runs__status_started ON replay_runs (status, started_at DESC);

ALTER TABLE replay_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE replay_runs FORCE  ROW LEVEL SECURITY;
CREATE POLICY replay_runs_tenant_isolation ON replay_runs
  FOR ALL TO contentos_app
  USING      (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- The exception set remains closed at five.
DO $$
DECLARE exception_count INT;
BEGIN
  SELECT count(*) INTO exception_count
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r'
     AND NOT c.relrowsecurity
     AND c.relname <> 'schema_migrations';
  IF exception_count <> 5 THEN
    RAISE EXCEPTION
      'RLS exception set must be exactly 5 tables; found %. A sixth requires an ADR.',
      exception_count;
  END IF;
END
$$;

RESET ROLE;
