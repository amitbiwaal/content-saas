-- Development seed. Idempotent, versioned, safe to run repeatedly.
--
-- Seeds ONLY the identity and tenancy tables that exist at migration 0005.
-- This is NOT a test fixture: tests build their own data, because a shared seed
-- that tests depend on becomes a schema neither can change.
--
-- Role names follow `16-security/rbac.md`, which owns the role catalogue.
--
-- No explicit BEGIN/COMMIT: the file is applied with psql --single-transaction,
-- so it is already atomic. A nested BEGIN would make the COMMIT close the
-- outer transaction early.

INSERT INTO users (id, email, name, status, email_verified)
VALUES ('018f7a1e-0000-7000-8000-000000000001', 'dev@contentos.local', 'Dev User', 'active', true)
ON CONFLICT (email) DO NOTHING;

INSERT INTO organizations (id, slug, name, status, plan_limits)
VALUES ('018f7a1e-0000-7000-8000-0000000000aa', 'dev-org', 'Dev Organization', 'active', '{}'::jsonb)
ON CONFLICT (slug) DO NOTHING;

INSERT INTO organization_memberships (organization_id, user_id, role, status)
VALUES ('018f7a1e-0000-7000-8000-0000000000aa', '018f7a1e-0000-7000-8000-000000000001',
        'org_owner', 'active')
ON CONFLICT (organization_id, user_id) DO NOTHING;

INSERT INTO workspaces (id, organization_id, slug, name, status)
VALUES ('018f7a1e-0000-7000-8000-0000000000bb', '018f7a1e-0000-7000-8000-0000000000aa',
        'dev-workspace', 'Dev Workspace', 'active')
ON CONFLICT (organization_id, slug) DO NOTHING;

INSERT INTO workspace_memberships (tenant_id, organization_id, user_id, role, status)
VALUES ('018f7a1e-0000-7000-8000-0000000000bb', '018f7a1e-0000-7000-8000-0000000000aa',
        '018f7a1e-0000-7000-8000-000000000001', 'workspace_admin', 'active')
ON CONFLICT (tenant_id, user_id) DO NOTHING;

-- A SECOND workspace, deliberately with NO membership.
--
-- It exists so the cross-tenant WRITE check is meaningful: inserting a row
-- carrying this tenant's id must be rejected by the RLS `WITH CHECK` clause.
-- Without this row the insert would fail on the foreign key instead, and the
-- test would pass for entirely the wrong reason — proving nothing about RLS.
INSERT INTO workspaces (id, organization_id, slug, name, status)
VALUES ('018f7a1e-0000-7000-8000-0000000000cc', '018f7a1e-0000-7000-8000-0000000000aa',
        'other-workspace', 'Other Workspace', 'active')
ON CONFLICT (organization_id, slug) DO NOTHING;
