-- 0003_identity.sql
--
-- Spec: 03-database/tables.md §2 "Identity and tenancy".
--   users, organizations, organization_memberships, sso_configurations,
--   verified_domains.
--
-- All five are the COMPLETE AND CLOSED set of RLS exceptions
-- (16-security/row-level-security.md §"The exception set — exactly five
-- tables"). Each is consulted at a point in the request lifecycle where
-- tenant_id is not yet known, so a tenant-scoped policy on them is circular.
-- A sixth requires an ADR.
--
-- Conventions (tables.md §1.1): UUID v7 ids, TIMESTAMPTZ in UTC, TEXT + CHECK
-- rather than native ENUM, TEXT with CHECK rather than VARCHAR(n).
--
-- ROLLBACK: DROP TABLE verified_domains, sso_configurations,
--           organization_memberships, organizations, users;

SET LOCAL ROLE contentos_migrator;

-- ── users ────────────────────────────────────────────────────────────────────
-- Global identity; a user exists above and across organizations.
CREATE TABLE users (
  id             UUID        PRIMARY KEY DEFAULT uuidv7(),
  email          CITEXT      NOT NULL,
  name           TEXT        NOT NULL,
  status         TEXT        NOT NULL DEFAULT 'active',
  email_verified BOOLEAN     NOT NULL DEFAULT false,
  -- { enrolled, factors[] } — secrets are held by the auth provider, never here.
  mfa_state      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by     UUID        NULL,
  updated_by     UUID        NULL,
  deleted_at     TIMESTAMPTZ NULL,

  CONSTRAINT uq_users__email UNIQUE (email),
  CONSTRAINT ck_users__name_length CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  CONSTRAINT ck_users__status CHECK (status IN ('active','deactivated','erased'))
);

-- Self-referencing audit FKs, added after the table exists.
ALTER TABLE users
  ADD CONSTRAINT fk_users__created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT,
  ADD CONSTRAINT fk_users__updated_by FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE RESTRICT;

COMMENT ON TABLE users IS
  'RLS EXCEPTION 1/5 — identity spans tenants; consulted before tenant context exists.';

-- ── organizations ────────────────────────────────────────────────────────────
-- Commercial and administrative boundary (ADR-017). Never the isolation key.
CREATE TABLE organizations (
  id           UUID        PRIMARY KEY DEFAULT uuidv7(),
  slug         TEXT        NOT NULL,
  name         TEXT        NOT NULL,
  status       TEXT        NOT NULL DEFAULT 'active',
  -- Projection from Commerce, never authored here.
  plan_limits  JSONB       NOT NULL DEFAULT '{}'::jsonb,
  billing_ref  TEXT        NULL,
  version      INTEGER     NOT NULL DEFAULT 1,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by   UUID        NULL REFERENCES users(id) ON DELETE RESTRICT,
  updated_by   UUID        NULL REFERENCES users(id) ON DELETE RESTRICT,
  deleted_at   TIMESTAMPTZ NULL,

  CONSTRAINT uq_organizations__slug UNIQUE (slug),
  CONSTRAINT ck_organizations__slug_format CHECK (slug ~ '^[a-z0-9-]{3,48}$'),
  CONSTRAINT ck_organizations__name_length CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  CONSTRAINT ck_organizations__status
    CHECK (status IN ('active','past_due','suspended','pending_closure','closed'))
);

COMMENT ON TABLE organizations IS
  'RLS EXCEPTION 2/5 — the organization contains workspaces; it is above the boundary.';

-- ── organization_memberships ─────────────────────────────────────────────────
-- Resolves which tenants a subject may reach — consulted BEFORE tenant context
-- exists. The most sensitive exception: an unfiltered read reveals the
-- membership graph across all customers.
CREATE TABLE organization_memberships (
  id              UUID        PRIMARY KEY DEFAULT uuidv7(),
  organization_id UUID        NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  user_id         UUID        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  role            TEXT        NOT NULL,
  status          TEXT        NOT NULL DEFAULT 'invited',
  expires_at      TIMESTAMPTZ NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by      UUID        NULL REFERENCES users(id) ON DELETE RESTRICT,
  updated_by      UUID        NULL REFERENCES users(id) ON DELETE RESTRICT,

  CONSTRAINT uq_org_memberships__org_user UNIQUE (organization_id, user_id),
  CONSTRAINT ck_org_memberships__role
    CHECK (role IN ('org_owner','org_admin','billing_admin','org_member')),
  CONSTRAINT ck_org_memberships__status
    CHECK (status IN ('invited','active','revoked'))
);

COMMENT ON TABLE organization_memberships IS
  'RLS EXCEPTION 3/5 — resolves which tenants a subject may reach; read before tenant context exists.';

-- ── verified_domains ─────────────────────────────────────────────────────────
-- Domain ownership is organization-level and consulted at login, pre-tenant.
CREATE TABLE verified_domains (
  id              UUID        PRIMARY KEY DEFAULT uuidv7(),
  organization_id UUID        NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  domain          TEXT        NOT NULL,
  verified_at     TIMESTAMPTZ NULL,
  method          TEXT        NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by      UUID        NULL REFERENCES users(id) ON DELETE RESTRICT,
  updated_by      UUID        NULL REFERENCES users(id) ON DELETE RESTRICT,

  -- Globally unique: one organization per domain, enforced by the database
  -- (02-domain-design/organizations.md rule 9).
  CONSTRAINT uq_verified_domains__domain UNIQUE (domain),
  CONSTRAINT ck_verified_domains__method CHECK (method IN ('dns','file','meta'))
);

COMMENT ON TABLE verified_domains IS
  'RLS EXCEPTION 4/5 — domain ownership is organization-level, consulted at login pre-tenant.';

-- ── sso_configurations ───────────────────────────────────────────────────────
-- SSO is resolved from the email domain before any workspace is known.
CREATE TABLE sso_configurations (
  id              UUID        PRIMARY KEY DEFAULT uuidv7(),
  organization_id UUID        NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  protocol        TEXT        NOT NULL,
  -- Holds references, never secrets (16-security/secrets-management.md).
  config          JSONB       NOT NULL DEFAULT '{}'::jsonb,
  enforced        BOOLEAN     NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by      UUID        NULL REFERENCES users(id) ON DELETE RESTRICT,
  updated_by      UUID        NULL REFERENCES users(id) ON DELETE RESTRICT,

  CONSTRAINT uq_sso_configurations__org UNIQUE (organization_id),
  CONSTRAINT ck_sso_configurations__protocol CHECK (protocol IN ('saml','oidc'))
);

COMMENT ON TABLE sso_configurations IS
  'RLS EXCEPTION 5/5 — SSO resolved from the email domain before any workspace is known.';

RESET ROLE;
