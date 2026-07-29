/**
 * The closed RLS exception sets.
 *
 * Spec: `16-security/row-level-security.md` §"The exception set — exactly five
 * tables", and `03-database/tables.md` §2.
 *
 * This module is the single source the conformance suite checks the live
 * database against. Changing it is how a sixth exception would be introduced,
 * which is exactly why it is small, explicit, and carries the justification
 * inline.
 */

/**
 * The identity exception class — EXACTLY FIVE tables, closed.
 *
 * Their common property is the reason: each is consulted at a point in the
 * request lifecycle where `tenant_id` is not yet known. A tenant-scoped policy
 * on a table needed to *determine* the tenant is circular.
 *
 * A sixth requires an ADR.
 */
export const IDENTITY_EXCEPTION_TABLES = [
  'users',
  'organizations',
  'organization_memberships',
  'verified_domains',
  'sso_configurations',
] as const;

export type IdentityExceptionTable = (typeof IDENTITY_EXCEPTION_TABLES)[number];

export const EXCEPTION_JUSTIFICATIONS: Readonly<Record<IdentityExceptionTable, string>> = {
  users: 'One person belongs to many organizations; identity spans tenants.',
  organizations: 'The organization contains workspaces; it is above the boundary.',
  organization_memberships:
    'Resolves which tenants a subject may reach — consulted before tenant context exists.',
  verified_domains: 'Domain ownership is organization-level and consulted at login, pre-tenant.',
  sso_configurations: 'SSO is resolved from the email domain before any workspace is known.',
};

/**
 * The reference-data exception class proposed by **ADR-025**.
 *
 * DELIBERATELY EMPTY.
 *
 * `16-security/row-level-security.md` states the approved position plainly:
 * ADR-025 "is not accepted, so **no such table exists today**, and any
 * reference data must currently carry `tenant_id` like everything else."
 *
 * The constant exists so the second allowlist category is present and testable
 * the day ADR-025 is accepted, and so its emptiness is asserted rather than
 * assumed. None of ADR-025's candidate tables (`plans`, `settings_registry`,
 * `permission_catalogue`, `role_permissions`, `flags`, `flag_rules`) is part of
 * the Sprint 0 schema — they are Phase 5 / `04-platform/`, so this class is not
 * on the critical path until Sprint 1.
 */
export const REFERENCE_DATA_EXCEPTION_TABLES: readonly string[] = [];

/** Every table permitted to lack RLS, across both classes. */
export const ALL_EXCEPTION_TABLES: readonly string[] = [
  ...IDENTITY_EXCEPTION_TABLES,
  ...REFERENCE_DATA_EXCEPTION_TABLES,
];

/**
 * Tables whose policy deviates from the canonical shape, with the approved
 * justification. A deviation NOT listed here is drift and fails the build.
 */
export const APPROVED_POLICY_VARIANTS: Readonly<Record<string, string>> = {
  workspaces:
    'Keys on `id` rather than `tenant_id` because workspaces.id IS the tenant (ADR-017), plus a read-only org-scoped listing policy so an org admin can list workspaces without entering them (03-database/tables.md §2).',
  audit_log:
    'WITH CHECK admits a NULL tenant_id because pre-tenant actions — authentication, membership resolution — must be audited before a tenant is known (16-security/audit.md). USING does not, so such a record is writable but never visible to a tenant-scoped read; it is read through the operator path.',
  outbox_events:
    'Carries an additional read-only cross-tenant policy for contentos_relay, which drains one queue for the whole platform. Documented and audited (03-database/tables.md §8, 16-security/rbac.md); the contentos_app policy itself is canonical and unchanged.',
};

/**
 * The typed reason a caller must supply to reach an exception table.
 *
 * Drawn from a closed union naming the three legitimate cases
 * (`16-security/row-level-security.md` §Interfaces). An untyped escape hatch
 * would be used for convenience within a month; this one cannot be called for a
 * general query and its uses are countable by grep.
 */
export type ExceptionTableAccess =
  | 'authentication' // users, sso_configurations, verified_domains
  | 'membership-resolution' // organization_memberships
  | 'organization-admin'; // organizations

export function isExceptionTable(table: string): boolean {
  return ALL_EXCEPTION_TABLES.includes(table);
}
