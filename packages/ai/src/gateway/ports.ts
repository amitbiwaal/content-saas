/**
 * What the Gateway needs from the Platform Layer, expressed as ports.
 *
 * ── Why these are ports and not imports ─────────────────────────────────────
 * Organizations, workspaces, memberships and feature flags live in
 * `packages/platform`. Two feature packages may not import each other
 * (`07-development-guide/project-structure.md` rule 4), so the Gateway declares
 * the narrow shape it needs and a composition root — which sits above both —
 * supplies the real implementation.
 *
 * This is the same pattern the rest of the platform already uses: the job
 * service takes an `EventPublisher` interface rather than the outbox, and the
 * workflow runtime takes a `PromptCatalogue` rather than building one. The
 * Gateway ORCHESTRATES; it owns none of what it orchestrates.
 *
 * ── The transaction is bound by the adapter, not passed through here ────────
 * Platform's readers take an executor. Threading one through the Gateway would
 * make an admission decision a database concern and put a `tx` parameter on
 * every function in the pipeline. Instead the composition root builds a
 * directory per request with the handle already closed over — so the Gateway
 * asks questions and never learns there is a database.
 *
 * ── The mirrored vocabularies ───────────────────────────────────────────────
 * The status words below are platform's, written out because they cannot be
 * imported. That is a real duplication and it is closed where it can be: the
 * conformance suite imports BOTH packages and asserts these lists still equal
 * platform's own. If a status is ever added there and not here, that test
 * fails — which is the only place the drift is detectable.
 */

/** Mirrors `packages/platform`'s `ORGANIZATION_STATUSES`. */
export const ADMISSION_ORGANIZATION_STATUSES = [
  'active',
  'past_due',
  'suspended',
  'pending_closure',
  'closed',
] as const;

export type AdmissionOrganizationStatus = (typeof ADMISSION_ORGANIZATION_STATUSES)[number];

/** Mirrors `packages/platform`'s `WORKSPACE_STATUSES`. */
export const ADMISSION_WORKSPACE_STATUSES = [
  'active',
  'suspended',
  'archived',
  'pending_deletion',
] as const;

export type AdmissionWorkspaceStatus = (typeof ADMISSION_WORKSPACE_STATUSES)[number];

/** Mirrors `packages/platform`'s `MEMBERSHIP_STATUSES`. */
export const ADMISSION_MEMBERSHIP_STATUSES = ['invited', 'active', 'revoked'] as const;

export type AdmissionMembershipStatus = (typeof ADMISSION_MEMBERSHIP_STATUSES)[number];

/**
 * The only organization state that admits new AI work.
 *
 * `past_due` is deliberately NOT admitted. An organization that has not paid is
 * one the platform should stop spending money on behalf of, and AI spend is the
 * dominant variable cost — continuing to serve it is the failure that shows up
 * as a write-off rather than as an error.
 */
export const ADMITTING_ORGANIZATION_STATUS: AdmissionOrganizationStatus = 'active';

/** The only workspace state that admits new work. */
export const ADMITTING_WORKSPACE_STATUS: AdmissionWorkspaceStatus = 'active';

export interface AdmissionOrganization {
  readonly organizationId: string;
  readonly status: AdmissionOrganizationStatus;
}

export interface AdmissionWorkspace {
  readonly workspaceId: string;
  /** The organization that owns it. Checked against the request's. */
  readonly organizationId: string;
  readonly status: AdmissionWorkspaceStatus;
}

export interface AdmissionMembership {
  readonly workspaceId: string;
  readonly actorId: string;
  readonly status: AdmissionMembershipStatus;
}

/**
 * The tenancy questions admission asks.
 *
 * Every method returns null for "no such thing" rather than throwing: an
 * unknown workspace is a rejection with a reason, not an exception, and the
 * pipeline reports which stage refused.
 */
export interface AdmissionDirectory {
  organization(organizationId: string): Promise<AdmissionOrganization | null>;
  workspace(workspaceId: string): Promise<AdmissionWorkspace | null>;
  /**
   * The actor's membership of the workspace, or null when there is none.
   *
   * Only consulted when the request names an actor. A request made by the
   * platform itself — a scheduled refresh, a background enrichment — has no
   * human behind it and no membership to check.
   */
  membership(workspaceId: string, actorId: string): Promise<AdmissionMembership | null>;
}

/**
 * The feature-flag question admission asks.
 *
 * Narrower than platform's resolver on purpose: admission needs one boolean,
 * and a port shaped like the whole resolver would make the Gateway able to
 * evaluate snapshots, announce changes and read layers it has no business
 * touching.
 */
export interface AdmissionFlags {
  isEnabled(scope: { organizationId: string; workspaceId: string }, key: string): Promise<boolean>;
}
