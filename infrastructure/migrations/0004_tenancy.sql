-- 0004_tenancy.sql
--
-- Spec: 03-database/tables.md §2 — workspaces, workspace_memberships,
-- workspace_settings_history.
--
-- `workspaces.id` IS `tenant_id` (ADR-017). Not a reference to one, not derived
-- from one — the same value. That is what makes a single-column policy
-- sufficient across the entire schema.
--
-- Every index on a workspace-owned table LEADS WITH tenant_id
-- (03-database/indexes.md; 16-security/row-level-security.md §Performance).
-- The policy predicate then becomes the first index condition rather than a
-- filter applied after retrieval.
--
-- ROLLBACK: DROP TABLE workspace_settings_history, workspace_memberships, workspaces;

SET LOCAL ROLE contentos_migrator;

-- ── workspaces ───────────────────────────────────────────────────────────────
-- The isolation boundary. `id` is referenced as `tenant_id` everywhere downstream.
CREATE TABLE workspaces (
  id              UUID        PRIMARY KEY DEFAULT uuidv7(),
  organization_id UUID        NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  slug            TEXT        NOT NULL,
  name            TEXT        NOT NULL,
  status          TEXT        NOT NULL DEFAULT 'active',
  -- { brandVoice, gateThresholds, routing, locale, approval, retention }
  settings        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  version         INTEGER     NOT NULL DEFAULT 1,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by      UUID        NULL REFERENCES users(id) ON DELETE RESTRICT,
  updated_by      UUID        NULL REFERENCES users(id) ON DELETE RESTRICT,
  deleted_at      TIMESTAMPTZ NULL,

  CONSTRAINT uq_workspaces__org_slug UNIQUE (organization_id, slug),
  CONSTRAINT ck_workspaces__slug_format CHECK (slug ~ '^[a-z0-9-]{3,48}$'),
  CONSTRAINT ck_workspaces__name_length CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  CONSTRAINT ck_workspaces__status
    CHECK (status IN ('active','suspended','archived','pending_deletion'))
);

CREATE INDEX ix_workspaces__org_status
  ON workspaces (organization_id, status) WHERE deleted_at IS NULL;

-- ── workspace_memberships ────────────────────────────────────────────────────
CREATE TABLE workspace_memberships (
  id              UUID        PRIMARY KEY DEFAULT uuidv7(),
  tenant_id       UUID        NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  organization_id UUID        NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  user_id         UUID        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  role            TEXT        NOT NULL,
  status          TEXT        NOT NULL DEFAULT 'invited',
  invited_by      UUID        NULL REFERENCES users(id) ON DELETE RESTRICT,
  expires_at      TIMESTAMPTZ NULL,
  version         INTEGER     NOT NULL DEFAULT 1,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by      UUID        NULL REFERENCES users(id) ON DELETE RESTRICT,
  updated_by      UUID        NULL REFERENCES users(id) ON DELETE RESTRICT,

  CONSTRAINT uq_workspace_memberships__tenant_user UNIQUE (tenant_id, user_id),
  CONSTRAINT ck_workspace_memberships__role
    CHECK (role IN ('workspace_admin','editor','contributor','viewer')),
  CONSTRAINT ck_workspace_memberships__status
    CHECK (status IN ('invited','active','revoked'))
);

-- Leads with tenant_id.
CREATE INDEX ix_workspace_memberships__tenant_status
  ON workspace_memberships (tenant_id, status);
-- Membership resolution reads by user across tenants; secondary, not RLS-bound.
CREATE INDEX ix_workspace_memberships__user
  ON workspace_memberships (user_id, status);

-- ── workspace_settings_history ───────────────────────────────────────────────
-- Append-only: no version, no deleted_at, no updated_*.
-- UPDATE/DELETE are revoked at the role level (tables.md §1.1).
CREATE TABLE workspace_settings_history (
  id              UUID        PRIMARY KEY DEFAULT uuidv7(),
  tenant_id       UUID        NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  organization_id UUID        NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  changed_keys    TEXT[]      NOT NULL,
  before          JSONB       NOT NULL DEFAULT '{}'::jsonb,
  after           JSONB       NOT NULL DEFAULT '{}'::jsonb,
  changed_by      UUID        NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT ck_workspace_settings_history__keys_present
    CHECK (cardinality(changed_keys) > 0)
);

CREATE INDEX ix_workspace_settings_history__tenant_created
  ON workspace_settings_history (tenant_id, created_at DESC);

-- Append-only enforced by privilege, not convention.
REVOKE UPDATE, DELETE ON workspace_settings_history FROM contentos_app;

RESET ROLE;
