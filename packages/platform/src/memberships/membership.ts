/**
 * Membership domain rules — `02-domain-design/organizations.md` §Business Rules
 * (structure and ownership) and `02-domain-design/workspace.md` §Business Rules
 * (membership).
 *
 * Pure. No SQL, no clock of its own, no events.
 *
 * ONE MEMBERSHIP TABLE PER TIER, AND NO INVITATION TABLE. An invitation is a
 * membership row in status `invited` carrying `expires_at`; accepting it moves
 * the same row to `active`. That is why "a user has at most one membership per
 * workspace" is enforceable by `UNIQUE (tenant_id, user_id)` rather than by
 * reconciling two tables — and why re-inviting is an update, not an insert.
 */

import type { OrganizationRole, RoleBinding, WorkspaceRole } from '@contentos/security';

/** `ck_*_memberships__status` in migrations 0003 and 0004. */
export const MEMBERSHIP_STATUSES = ['invited', 'active', 'revoked'] as const;

export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];

export function isMembershipStatus(value: string): value is MembershipStatus {
  return (MEMBERSHIP_STATUSES as readonly string[]).includes(value);
}

/** `workspace.md` rule 8: "An invitation expires after 14 days." */
export const INVITATION_TTL_DAYS = 14;

export function invitationExpiry(now: Date): Date {
  return new Date(now.getTime() + INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000);
}

/**
 * Expiry is evaluated AT USE, never by a sweep.
 *
 * The same reasoning as `isBindingActive` in the authorization evaluator: a
 * sweep leaves a window in which a lapsed invitation still works, and the width
 * of that window is however long the sweep takes to notice.
 */
export function isInvitationExpired(expiresAt: Date | null, now: Date): boolean {
  return expiresAt !== null && now.getTime() >= expiresAt.getTime();
}

/**
 * Which roles an actor holding a given role may act upon — grant, change, or
 * revoke.
 *
 * `organizations.md` rule 3: "`org_owner` may grant any org role. `org_admin`
 * may manage `org_admin` and members but NOT `org_owner`, and NOT
 * `billing_admin`. `billing_admin` grants no content or membership authority
 * whatsoever — it is a pure separation-of-duties role."
 *
 * The vocabulary is the database's and the permission catalogue's
 * (`billing_admin`), which is where the doc says `billing_owner`.
 */
export const ORGANIZATION_ROLE_GRANTS: Readonly<
  Record<OrganizationRole, readonly OrganizationRole[]>
> = {
  org_owner: ['org_owner', 'org_admin', 'billing_admin', 'org_member'],
  org_admin: ['org_admin', 'org_member'],
  billing_admin: [],
  org_member: [],
};

/**
 * `workspace.md` rule 6: "Only `owner` may grant or revoke `owner`. `admin` may
 * manage `editor` and `viewer`. `editor` and `viewer` may manage nobody."
 *
 * Mapped onto the four roles the schema and catalogue actually define, in which
 * `workspace_admin` is the owner-equivalent: it is the only role with any
 * membership authority, and the remaining three manage nobody.
 */
export const WORKSPACE_ROLE_GRANTS: Readonly<Record<WorkspaceRole, readonly WorkspaceRole[]>> = {
  workspace_admin: ['workspace_admin', 'editor', 'contributor', 'viewer'],
  editor: [],
  contributor: [],
  viewer: [],
};

export function canGrantOrganizationRole(
  actorRole: OrganizationRole,
  targetRole: OrganizationRole,
): boolean {
  return ORGANIZATION_ROLE_GRANTS[actorRole].includes(targetRole);
}

export function canGrantWorkspaceRole(
  actorRole: WorkspaceRole,
  targetRole: WorkspaceRole,
): boolean {
  return WORKSPACE_ROLE_GRANTS[actorRole].includes(targetRole);
}

/** The role a workspace is never allowed to run out of. */
export const WORKSPACE_OWNER_ROLE: WorkspaceRole = 'workspace_admin';

/** The role an organization is never allowed to run out of. */
export const ORGANIZATION_OWNER_ROLE: OrganizationRole = 'org_owner';

export type MembershipErrorCode =
  | 'MembershipNotFound'
  | 'AlreadyMember'
  | 'DuplicateInvitation'
  | 'InvitationExpired'
  | 'InvitationNotPending'
  | 'RoleGrantNotPermitted'
  | 'LastOwnerProtected'
  | 'ConcurrentModification'
  | 'ActorNotMember'
  | 'OrganizationMembershipRequired';

export class MembershipError extends Error {
  readonly code: MembershipErrorCode;

  constructor(code: MembershipErrorCode, message: string) {
    super(message);
    this.name = 'MembershipError';
    this.code = code;
  }
}

/**
 * Last-owner protection.
 *
 * `03-database/tables.md` names the mechanism as a `BEFORE UPDATE OR DELETE`
 * trigger (`ORG_LAST_OWNER` / `WS_LAST_OWNER`) because it is "a cross-row count
 * over a filtered set" and cannot be declared. No migration may be added in
 * this increment, so it is enforced in the application INSIDE the transaction
 * instead — and, because a count-then-act is a race, under the same advisory
 * lock pattern the workspace quota uses.
 *
 * `activeOwners` is the count INCLUDING the membership being changed.
 */
export function wouldRemoveLastOwner(
  currentRole: string,
  nextRole: string | null,
  currentStatus: MembershipStatus,
  activeOwners: number,
  ownerRole: string,
): boolean {
  // Only an ACTIVE owner is holding the position open; an invited or revoked
  // one is not counted and cannot be the last.
  if (currentRole !== ownerRole || currentStatus !== 'active') return false;
  // `null` means the membership is being revoked rather than re-roled.
  const stillOwner = nextRole === ownerRole;
  if (stillOwner) return false;
  return activeOwners <= 1;
}

/**
 * A membership row as the authorization evaluator wants it.
 *
 * This is the seam that makes memberships mean something: `RoleBinding` is what
 * `resolvePermissions` consumes, so a membership that cannot project into one
 * grants nothing anywhere.
 *
 * Returns `null` for any status other than `active`. A binding that grants
 * nothing should not exist rather than exist and be filtered — an `invited`
 * membership is an offer, not an entitlement.
 */
export interface MembershipProjection {
  readonly userId: string;
  readonly role: OrganizationRole | WorkspaceRole;
  readonly status: MembershipStatus;
  readonly organizationId: string;
  /** Null for an organization-tier membership. */
  readonly workspaceId: string | null;
  readonly grantedBy: string;
  readonly grantedAt: Date;
  readonly expiresAt: Date | null;
}

export function toRoleBinding(membership: MembershipProjection): RoleBinding | null {
  if (membership.status !== 'active') return null;

  return {
    subjectId: membership.userId,
    subjectKind: 'user',
    role: membership.role,
    tier: membership.workspaceId === null ? 'organization' : 'workspace',
    organizationId: membership.organizationId,
    workspaceId: membership.workspaceId,
    // Null means all projects. `[]` is invalid and would be rejected by
    // `assertValidBinding`; membership grants no project narrowing.
    projectScope: null,
    grantedBy: membership.grantedBy,
    grantedAt: membership.grantedAt,
    expiresAt: membership.expiresAt,
    status: 'active',
  };
}
