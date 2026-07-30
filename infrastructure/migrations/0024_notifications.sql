-- 0024_notifications.sql
--
-- The notification record. Spec: `04-platform/notifications.md`.
--
-- NUMBERING: notifications.md sketches `0022_notifications`; 0022 shipped as
-- the credits service. Migrations are append-only, so this lands at the end
-- rather than displacing a number that already means something else — the same
-- note 0021 and 0022 record.
--
-- SCOPE. notifications.md specifies four tables. Only `notifications` is
-- created here:
--
--   `notification_preferences`  needs users and per-workspace preference UI
--   `notification_deliveries`   needs a channel adapter to have attempted one
--   `notification_digest_buckets` needs digest scheduling
--
-- All three are out of scope, and a table nothing can write is a table whose
-- constraints have never been tested against real data.
--
-- ── Immutable, enforced by privilege ────────────────────────────────────────
-- "No editing. No deletion." — but a notification must still record whether it
-- was delivered. Table-level UPDATE is revoked and re-granted on the FOUR
-- delivery columns only, so `type`, `payload`, `tenant_id` and `created_at` are
-- unmodifiable by the application role rather than by convention. DELETE is
-- revoked outright.
--
-- That is the same reasoning the ledger uses, applied to a row that has one
-- legitimately mutable dimension: `outbox_events.published_at` is the existing
-- precedent for "the ONE mutable column".
--
-- ── No recipient ────────────────────────────────────────────────────────────
-- notifications.md keys the row on `recipient_id`, resolved at send time
-- through `permissions.md` — "recipient resolution is role-based, never
-- identity-based". Permissions resolution does not exist yet, and storing a
-- recipient list now is exactly what that rule forbids. A record here is
-- addressed to the TENANT; the recipient arrives with preference resolution.
--
-- ROLLBACK: DROP TABLE notifications;

SET LOCAL ROLE contentos_migrator;

CREATE TABLE notifications (
  id              UUID        PRIMARY KEY DEFAULT uuidv7(),

  -- The isolation key. Today always the organization, because every event this
  -- increment consumes is organization-scoped (ADR-029); the CHECK below admits
  -- a workspace-tenanted notification without a migration when one arrives.
  tenant_id       UUID        NOT NULL,
  organization_id UUID        NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  -- NULL for an account-level notification: a credit balance belongs to the
  -- organization, not to any one workspace.
  workspace_id    UUID        NULL     REFERENCES workspaces(id)    ON DELETE RESTRICT,

  -- The declared notification type. The registry is source-controlled, so
  -- category, priority and channels are derived from this rather than copied
  -- onto the row where they could drift from the declaration.
  type            TEXT        NOT NULL,

  -- "Payloads carry identifiers and short scalars only — never article
  -- content, evidence text, metric values, or settings values."
  payload         JSONB       NOT NULL DEFAULT '{}'::jsonb,

  status          TEXT        NOT NULL DEFAULT 'pending',

  -- The exactly-once guarantee. notifications.md keys it
  -- `(tenant_id, recipient_id, dedupe_key)`; without a recipient the tenant and
  -- the key are the whole of it.
  dedupe_key      TEXT        NOT NULL,

  correlation_id  UUID        NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),   -- server clock, never client

  delivered_at    TIMESTAMPTZ NULL,
  failed_at       TIMESTAMPTZ NULL,
  failure_reason  TEXT        NULL,

  -- Only the states reachable without a channel adapter. notifications.md also
  -- names `sent`, `bounced` and `suppressed`; each needs a delivery attempt or
  -- a preference to have happened, and declaring a state nothing can enter is
  -- a vocabulary nobody can trust.
  CONSTRAINT ck_notifications__status
    CHECK (status IN ('pending', 'delivered', 'failed')),

  -- A terminal state carries its timestamp, and a pending one carries neither.
  CONSTRAINT ck_notifications__delivered_at_matches_status
    CHECK ((status = 'delivered') = (delivered_at IS NOT NULL)),
  CONSTRAINT ck_notifications__failed_at_matches_status
    CHECK ((status = 'failed') = (failed_at IS NOT NULL)),
  -- A failure without a reason is a failure nobody can act on.
  CONSTRAINT ck_notifications__failure_reason_matches_status
    CHECK ((status = 'failed') = (failure_reason IS NOT NULL)),

  -- The tenant is the organization, or the workspace when one is named.
  CONSTRAINT ck_notifications__tenant_is_owner
    CHECK (tenant_id = organization_id OR tenant_id = workspace_id),

  CONSTRAINT ck_notifications__type_present CHECK (btrim(type) <> ''),
  CONSTRAINT ck_notifications__dedupe_key_present CHECK (btrim(dedupe_key) <> ''),
  CONSTRAINT ck_notifications__payload_object CHECK (jsonb_typeof(payload) = 'object'),

  -- THE constraint, not application logic, is what makes a redelivered event
  -- produce one notification — the same reasoning as `idempotency_keys`.
  CONSTRAINT uq_notifications__tenant_dedupe UNIQUE (tenant_id, dedupe_key)
);

-- The inbox read: newest first, per tenant.
CREATE INDEX ix_notifications__tenant_created
  ON notifications (tenant_id, created_at DESC);

-- Per-workspace filtering, partial because account-level rows have no workspace.
CREATE INDEX ix_notifications__workspace_created
  ON notifications (tenant_id, workspace_id, created_at DESC)
  WHERE workspace_id IS NOT NULL;

-- The delivery sweep: what has not reached a terminal state.
CREATE INDEX ix_notifications__pending
  ON notifications (tenant_id, created_at) WHERE status = 'pending';

CREATE INDEX ix_notifications__correlation ON notifications (correlation_id);

COMMENT ON TABLE notifications IS
  'Immutable except for the four delivery columns. UPDATE is revoked at table '
  'level and re-granted column-wise; DELETE is revoked outright.';

-- ── Immutability, enforced by privilege ─────────────────────────────────────
-- 0002 grants SELECT, INSERT, UPDATE, DELETE by default privilege. UPDATE is
-- taken back and returned only for the delivery outcome; DELETE is not returned
-- at all. No application path can rewrite what a notification SAID, only
-- whether it arrived.
REVOKE UPDATE, DELETE ON notifications FROM contentos_app;
GRANT UPDATE (status, delivered_at, failed_at, failure_reason)
  ON notifications TO contentos_app;

-- ── RLS ─────────────────────────────────────────────────────────────────────
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications FORCE  ROW LEVEL SECURITY;
CREATE POLICY notifications_tenant_isolation ON notifications
  FOR ALL TO contentos_app
  USING      (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- Migrate-time assertion, stated about this table by name. Both properties are
-- silent when absent: without FORCE the owner bypasses every policy, and a
-- column-level grant that quietly became table-level makes the payload
-- rewritable with no error anywhere.
DO $$
DECLARE
  enabled   BOOLEAN;
  forced    BOOLEAN;
  wide_open TEXT;
BEGIN
  SELECT c.relrowsecurity, c.relforcerowsecurity INTO enabled, forced
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'notifications';

  IF NOT enabled OR NOT forced THEN
    RAISE EXCEPTION
      'notifications must have RLS ENABLEd and FORCEd; got enabled=%, forced=%', enabled, forced;
  END IF;

  -- Read from the ACL directly: this block runs as contentos_migrator, which is
  -- not a member of contentos_app, and the catalog answers without membership.
  -- A TABLE-level UPDATE or any DELETE grant is the failure.
  SELECT string_agg(a.privilege_type, ', ') INTO wide_open
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN LATERAL aclexplode(c.relacl) AS a
    JOIN pg_roles r ON r.oid = a.grantee
   WHERE n.nspname = 'public'
     AND c.relname = 'notifications'
     AND r.rolname = 'contentos_app'
     AND a.privilege_type IN ('UPDATE', 'DELETE');

  IF wide_open IS NOT NULL THEN
    RAISE EXCEPTION
      'notifications is meant to be immutable, but contentos_app holds table-level % on it.',
      wide_open;
  END IF;
END
$$;

RESET ROLE;
