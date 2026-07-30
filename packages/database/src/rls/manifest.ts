/**
 * THE RLS exception manifest — the single authoritative source.
 *
 * Spec: `16-security/row-level-security.md` §"The exception set", ADR-007, and
 * **ADR-025** (accepted), which added a second, bounded exception class for
 * global reference data.
 *
 * ── Why a manifest replaced a count ─────────────────────────────────────────
 * The gate used to assert "the number of tables without RLS is five". A count
 * cannot tell a permitted exception from an unpermitted one: swap a table out
 * for a table in and the number is unchanged while the guarantee is gone. Every
 * assertion is now driven by this list, by NAME, in both directions.
 *
 * Nothing else may hold a list of exception tables. The shell gate reads a JSON
 * artifact generated from this file, and a test fails if the two disagree — so
 * there is one place to change and one place to review.
 */

/**
 * The two classes, and they are not equally risky.
 *
 * IDENTITY tables sit above the workspace boundary and are consulted before
 * `tenant_id` is known. They contain customer data, and their isolation rests
 * on application-layer filtering alone — which is why the class is CLOSED at
 * the five named below and why a sixth requires an ADR.
 *
 * REFERENCE-DATA tables (ADR-025) contain no customer data at all, so there is
 * nothing to isolate. Their risk is different — that one tenant could alter
 * global configuration — and that risk is closable mechanically. Every member
 * must be read-only to `contentos_app`, which makes this class strictly safer
 * than the identity class rather than a widening of it.
 */
export type RlsExceptionClass = 'identity' | 'reference-data';

export interface RlsExceptionEntry {
  readonly table: string;
  readonly class: RlsExceptionClass;
  /** Mandatory. An exception nobody wrote a reason for is an exception nobody reviewed. */
  readonly justification: string;
}

/**
 * The identity class — EXACTLY these five, closed.
 *
 * Their common property is the reason: each is consulted at a point in the
 * request lifecycle where `tenant_id` is not yet known, and a tenant-scoped
 * policy on a table needed to DETERMINE the tenant is circular.
 */
const IDENTITY_ENTRIES: readonly RlsExceptionEntry[] = [
  {
    table: 'users',
    class: 'identity',
    justification: 'One person belongs to many organizations; identity spans tenants.',
  },
  {
    table: 'organizations',
    class: 'identity',
    justification: 'The organization contains workspaces; it is above the boundary.',
  },
  {
    table: 'organization_memberships',
    class: 'identity',
    justification:
      'Resolves which tenants a subject may reach — consulted before tenant context exists.',
  },
  {
    table: 'verified_domains',
    class: 'identity',
    justification: 'Domain ownership is organization-level and consulted at login, pre-tenant.',
  },
  {
    table: 'sso_configurations',
    class: 'identity',
    justification: 'SSO is resolved from the email domain before any workspace is known.',
  },
];

/**
 * The reference-data class — ADR-025, currently EMPTY.
 *
 * Accepted but unpopulated: this increment builds the verification, it creates
 * no tables. The members ADR-025 names — `plans`, `settings_registry`,
 * `permission_catalogue`, `role_permissions`, `flags`, `flag_rules`, and
 * `credit_cost_policy` by amendment — arrive with the migrations that create
 * them, each adding one entry here.
 *
 * Verification must pass with this list empty, and it does: every
 * reference-data assertion iterates the list and vacuously passes over nothing.
 */
const REFERENCE_DATA_ENTRIES: readonly RlsExceptionEntry[] = [];

export const RLS_EXCEPTION_MANIFEST: readonly RlsExceptionEntry[] = [
  ...IDENTITY_ENTRIES,
  ...REFERENCE_DATA_ENTRIES,
];

export function exceptionsOfClass(cls: RlsExceptionClass): readonly RlsExceptionEntry[] {
  return RLS_EXCEPTION_MANIFEST.filter((e) => e.class === cls);
}

export function exceptionTables(): readonly string[] {
  return RLS_EXCEPTION_MANIFEST.map((e) => e.table);
}

export function exceptionEntry(table: string): RlsExceptionEntry | undefined {
  return RLS_EXCEPTION_MANIFEST.find((e) => e.table === table);
}

/**
 * The canonical assertion catalogue.
 *
 * Declared as DATA so that both verification engines — the TypeScript one that
 * runs against a catalogue snapshot, and the shell one that runs against the
 * live database — can be checked against the same list. The shell engine
 * refuses to start if it does not implement every `catalog` assertion here,
 * which is what stops a check existing in one place and quietly not the other.
 */
export type RlsAssertionSurface =
  /** Decidable from the PostgreSQL catalogue alone. Both engines implement it. */
  | 'catalog'
  /**
   * Requires connecting AS the unprivileged application role and observing what
   * PostgreSQL actually does. Only the live engine can do this, and it is the
   * only way to prove isolation rather than configuration.
   */
  | 'behavioural';

export interface RlsAssertionSpec {
  readonly name: string;
  readonly surface: RlsAssertionSurface;
  readonly description: string;
}

export const RLS_ASSERTIONS: readonly RlsAssertionSpec[] = [
  {
    name: 'exception-set-closed',
    surface: 'catalog',
    description: 'Every table without RLS appears in the manifest.',
  },
  {
    name: 'exception-set-complete',
    surface: 'catalog',
    description: 'Every manifest table that exists has RLS disabled.',
  },
  {
    name: 'identity-class-exact',
    surface: 'catalog',
    description: 'The identity class is exactly its five named tables — no additions, no removals.',
  },
  {
    name: 'exception-justified',
    surface: 'catalog',
    description: 'Every manifest entry carries a written justification.',
  },
  {
    name: 'reference-data-no-tenant-id',
    surface: 'catalog',
    description:
      'No reference-data table has a tenant_id column; one that does should be tenant-scoped instead.',
  },
  {
    name: 'reference-data-readable',
    surface: 'catalog',
    description: 'contentos_app holds SELECT on every reference-data table.',
  },
  {
    name: 'reference-data-read-only',
    surface: 'catalog',
    description:
      'contentos_app holds no INSERT, UPDATE or DELETE on any reference-data table — isolation by privilege, not by review.',
  },
  {
    name: 'rls-enabled',
    surface: 'catalog',
    description: 'Every non-exception table has RLS enabled.',
  },
  {
    name: 'rls-forced',
    surface: 'catalog',
    description: 'Every RLS table is also FORCEd, so the table owner cannot bypass it.',
  },
  {
    name: 'policy-present',
    surface: 'catalog',
    description: 'Every RLS-enabled table carries at least one policy.',
  },
  {
    name: 'policy-for-all',
    surface: 'catalog',
    description: 'Every RLS-enabled table carries a FOR ALL policy.',
  },
  {
    name: 'policy-with-check',
    surface: 'catalog',
    description:
      'Every FOR ALL policy carries WITH CHECK — its absence permits a cross-tenant write.',
  },
  {
    name: 'policy-canonical',
    surface: 'catalog',
    description: 'Every policy keys on current_setting(app.tenant_id), except approved variants.',
  },
  {
    name: 'role-exists',
    surface: 'catalog',
    description: 'contentos_app exists.',
  },
  {
    name: 'app-no-bypassrls',
    surface: 'catalog',
    description: 'contentos_app does not hold BYPASSRLS.',
  },
  {
    name: 'app-owns-no-tables',
    surface: 'catalog',
    description: 'contentos_app owns no table; an owner bypasses RLS unless FORCE is set.',
  },
  {
    name: 'no-context-zero-rows',
    surface: 'behavioural',
    description: 'With no tenant context set, a tenant-scoped read returns zero rows.',
  },
  {
    name: 'cross-tenant-read-blocked',
    surface: 'behavioural',
    description: "Under tenant B's context, tenant A's rows are invisible.",
  },
  {
    name: 'own-tenant-read-permitted',
    surface: 'behavioural',
    description:
      'The positive control — the role CAN read its own tenant, without which the isolation checks prove nothing.',
  },
  {
    name: 'cross-tenant-write-rejected',
    surface: 'behavioural',
    description: 'WITH CHECK rejects a write carrying another tenant id.',
  },
];

export function assertionsOfSurface(surface: RlsAssertionSurface): readonly RlsAssertionSpec[] {
  return RLS_ASSERTIONS.filter((a) => a.surface === surface);
}

/**
 * The serialisable form the shell engine consumes.
 *
 * Generated into `scripts/db/rls-manifest.generated.json` and compared against
 * this module by a test, so the artifact cannot drift from the source.
 */
export interface RlsManifestDocument {
  readonly exceptions: readonly RlsExceptionEntry[];
  readonly assertions: readonly RlsAssertionSpec[];
}

export function rlsManifestDocument(): RlsManifestDocument {
  return { exceptions: RLS_EXCEPTION_MANIFEST, assertions: RLS_ASSERTIONS };
}
