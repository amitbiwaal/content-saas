/**
 * The closed RLS exception sets — DERIVED, never restated.
 *
 * Spec: `16-security/row-level-security.md` §"The exception set — exactly five
 * tables", `03-database/tables.md` §2, and ADR-025 for the second class.
 *
 * Everything here is computed from `./manifest.ts`, which is the one
 * authoritative source. This module used to hold its own copies of the table
 * names and their justifications; two lists of the same thing is exactly how a
 * table gets added to one and not the other, and the coverage gate is only
 * meaningful if there is nothing to disagree with.
 */

import {
  exceptionsOfClass,
  exceptionTables,
  RLS_EXCEPTION_MANIFEST,
  type RlsExceptionEntry,
} from './manifest.js';

/**
 * The identity exception class — EXACTLY FIVE tables, closed.
 *
 * Their common property is the reason: each is consulted at a point in the
 * request lifecycle where `tenant_id` is not yet known. A tenant-scoped policy
 * on a table needed to *determine* the tenant is circular.
 *
 * A sixth requires an ADR.
 */
export const IDENTITY_EXCEPTION_TABLES: readonly string[] = exceptionsOfClass('identity').map(
  (e) => e.table,
);

/**
 * The reference-data exception class — ADR-025, ACCEPTED.
 *
 * Currently empty, and verification passes with it empty. Membership requires
 * all four criteria: seeded by migration, identical for every customer, no
 * customer data, and read-only to the application role. The last is checked
 * mechanically rather than asserted in review, which is what makes this class
 * safer than the identity one rather than a relaxation of it.
 */
export const REFERENCE_DATA_EXCEPTION_TABLES: readonly string[] = exceptionsOfClass(
  'reference-data',
).map((e) => e.table);

/** Every table permitted to lack RLS, across both classes. */
export const ALL_EXCEPTION_TABLES: readonly string[] = exceptionTables();

/** The written reason for every exception, keyed by table. */
export const EXCEPTION_JUSTIFICATIONS: Readonly<Record<string, string>> = Object.fromEntries(
  RLS_EXCEPTION_MANIFEST.map((e: RlsExceptionEntry) => [e.table, e.justification]),
);

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
