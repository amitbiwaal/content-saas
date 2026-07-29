-- 0015_infrastructure.sql
--
-- Spec: 03-database/migrations.md — 0015 infrastructure:
--   "outbox_events, processed_events, audit_log, idempotency_keys".
-- Table detail: 03-database/tables.md §8. Events: ADR-020.
--
-- "PostgreSQL is truth; Redis is transport." An event exists if and only if
-- its producing transaction committed, because the event is written to
-- `outbox_events` inside that transaction and the relay reads it afterwards.
--
-- ROLLBACK: DROP TABLE idempotency_keys, audit_log, processed_events, outbox_events;

SET LOCAL ROLE contentos_migrator;

-- ── outbox_events (ADR-020) ─────────────────────────────────────────────────
-- NO FOREIGN KEYS BY DESIGN: it must be writable alongside any table and must
-- survive deletion of the aggregate it describes (tables.md §8).
CREATE TABLE outbox_events (
  id               BIGSERIAL   PRIMARY KEY,          -- publication order
  event_id         UUID        NOT NULL,             -- the consumer dedupe key
  tenant_id        UUID        NOT NULL,
  organization_id  UUID        NOT NULL,
  event_type       TEXT        NOT NULL,
  event_version    INTEGER     NOT NULL,
  aggregate_type   TEXT        NOT NULL,
  aggregate_id     UUID        NOT NULL,             -- the ONLY ordering key
  correlation_id   UUID        NOT NULL,
  causation_id     UUID        NULL,                 -- null for root events
  producer         TEXT        NOT NULL,             -- event-apis.md D-3
  payload          JSONB       NOT NULL,
  occurred_at      TIMESTAMPTZ NOT NULL,
  published_at     TIMESTAMPTZ NULL,                 -- the ONE mutable column
  publish_attempts INTEGER     NOT NULL DEFAULT 0,   -- ADR-020 expansion

  CONSTRAINT uq_outbox_events__event_id UNIQUE (event_id),
  CONSTRAINT ck_outbox_events__version_positive CHECK (event_version >= 1),
  CONSTRAINT ck_outbox_events__attempts_non_negative CHECK (publish_attempts >= 0),
  -- Payloads carry identifiers and immutable values, never content or blobs.
  CONSTRAINT ck_outbox_events__payload_object CHECK (jsonb_typeof(payload) = 'object')
);

-- The relay's claim query: unpublished rows in publication order.
CREATE INDEX ix_outbox_events__pending
  ON outbox_events (id) WHERE published_at IS NULL;
-- Per-aggregate ordering, and the incident query.
CREATE INDEX ix_outbox_events__tenant_aggregate
  ON outbox_events (tenant_id, aggregate_id, id);
CREATE INDEX ix_outbox_events__correlation ON outbox_events (correlation_id);

COMMENT ON COLUMN outbox_events.published_at IS
  'NULL = pending. The only mutable column on this table.';

-- ── processed_events ────────────────────────────────────────────────────────
-- The PRIMARY KEY *is* the exactly-once-effect guarantee: the marker and the
-- handler's writes commit in one transaction, so a redelivery collides.
--
-- DEVIATION, RECORDED: tables.md §8 lists the key as (consumer_group,
-- event_id) with no tenant column. A table without `tenant_id` cannot carry
-- the canonical policy and would become a SIXTH RLS exception, which the
-- conformance suite fails by design. The marker is always written under the
-- consumer's tenant context (idempotency.md), so the tenant is known — it is
-- carried here and the documented key is preserved as a UNIQUE constraint.
CREATE TABLE processed_events (
  tenant_id       UUID        NOT NULL,
  organization_id UUID        NOT NULL,
  consumer_group  TEXT        NOT NULL,
  event_id        UUID        NOT NULL,
  processed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT pk_processed_events PRIMARY KEY (consumer_group, event_id)
);

CREATE INDEX ix_processed_events__tenant_processed
  ON processed_events (tenant_id, processed_at DESC);

-- ── audit_log ───────────────────────────────────────────────────────────────
-- Append-only. UPDATE and DELETE are revoked at the role level, not merely
-- discouraged (16-security/audit.md).
CREATE TABLE audit_log (
  id               UUID        PRIMARY KEY DEFAULT uuidv7(),
  -- NULL only for pre-tenant actions: authentication, membership resolution.
  tenant_id        UUID        NULL,
  organization_id  UUID        NOT NULL,
  actor_id         UUID        NULL REFERENCES users(id) ON DELETE RESTRICT,
  actor_kind       TEXT        NOT NULL,
  correlation_id   UUID        NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),   -- server clock, never client
  action           TEXT        NOT NULL,                 -- enumerated, never free text
  target_kind      TEXT        NOT NULL,
  target_id        TEXT        NOT NULL,
  target_tenant_id UUID        NULL,
  result           TEXT        NOT NULL,
  reason           TEXT        NOT NULL,
  context          JSONB       NOT NULL DEFAULT '{}'::jsonb,
  previous_hash    TEXT        NOT NULL,                 -- tamper-evidence chain
  hash             TEXT        NOT NULL,

  CONSTRAINT ck_audit_log__actor_kind
    CHECK (actor_kind IN ('user','api-key','service','operator')),
  CONSTRAINT ck_audit_log__result
    CHECK (result IN ('success','failure','denied')),
  CONSTRAINT ck_audit_log__hash_shape CHECK (hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ck_audit_log__previous_hash_shape CHECK (previous_hash ~ '^[0-9a-f]{64}$')
);

CREATE INDEX ix_audit_log__tenant_created ON audit_log (tenant_id, created_at DESC);
CREATE INDEX ix_audit_log__correlation ON audit_log (correlation_id);
CREATE INDEX ix_audit_log__actor ON audit_log (actor_id, created_at DESC);

-- ── idempotency_keys ────────────────────────────────────────────────────────
-- The CONSTRAINT, not application logic, is what makes concurrent duplicate
-- submissions safe (tables.md §8).
CREATE TABLE idempotency_keys (
  id              UUID        PRIMARY KEY DEFAULT uuidv7(),
  tenant_id       UUID        NOT NULL,
  organization_id UUID        NOT NULL,
  endpoint        TEXT        NOT NULL,
  key             TEXT        NOT NULL,
  response        JSONB       NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL,

  CONSTRAINT uq_idempotency_keys__tenant_endpoint_key UNIQUE (tenant_id, endpoint, key)
);

CREATE INDEX ix_idempotency_keys__expiry ON idempotency_keys (expires_at);

-- Append-only enforced by privilege.
REVOKE UPDATE, DELETE ON audit_log FROM contentos_app;
REVOKE UPDATE, DELETE ON processed_events FROM contentos_app;

-- ─────────────────────────────────────────────────────────────────────────────
-- RLS. ENABLE and FORCE on every table; the canonical policy except where a
-- deviation is documented below and registered in the conformance suite.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE outbox_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox_events FORCE  ROW LEVEL SECURITY;
CREATE POLICY outbox_events_tenant_isolation ON outbox_events
  FOR ALL TO contentos_app
  USING      (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- The relay reads across tenants by design: it drains one queue for the whole
-- platform. Documented and audited (tables.md §8, 16-security/rbac.md).
-- Read-only, and it may only mark rows published.
CREATE POLICY outbox_events_relay_read ON outbox_events
  FOR SELECT TO contentos_relay USING (true);
CREATE POLICY outbox_events_relay_mark ON outbox_events
  FOR UPDATE TO contentos_relay USING (true) WITH CHECK (true);
GRANT SELECT, UPDATE ON outbox_events TO contentos_relay;

ALTER TABLE processed_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE processed_events FORCE  ROW LEVEL SECURITY;
CREATE POLICY processed_events_tenant_isolation ON processed_events
  FOR ALL TO contentos_app
  USING      (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- audit_log — DOCUMENTED DEVIATION.
--
-- `tenant_id` is nullable because pre-tenant actions (authentication,
-- membership resolution) must be audited before a tenant is known
-- (16-security/audit.md). The canonical WITH CHECK would reject those rows:
-- `NULL = <uuid>` is NULL, not true.
--
-- WITH CHECK therefore admits a NULL tenant; USING does NOT, so a pre-tenant
-- record is writable but never visible to a tenant-scoped read. Those records
-- are read through the operator path, not by customers.
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE  ROW LEVEL SECURITY;
CREATE POLICY audit_log_tenant_isolation ON audit_log
  FOR ALL TO contentos_app
  USING      (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id IS NULL
              OR tenant_id = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_keys FORCE  ROW LEVEL SECURITY;
CREATE POLICY idempotency_keys_tenant_isolation ON idempotency_keys
  FOR ALL TO contentos_app
  USING      (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- Migrate-time assertion: the exception set is unchanged at five.
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
