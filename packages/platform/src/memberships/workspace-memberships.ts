/**
 * Workspace memberships — `04-platform/workspaces.md` §Membership.
 *
 * Increment C: invite, accept, revoke, change role, remove. Every operation
 * writes the membership row, the audit record and the outbox event on ONE
 * transaction handle.
 *
 * ── Differences from the organization tier ──────────────────────────────────
 * `workspace_memberships` HAS a `version` column and an `invited_by` column,
 * which `organization_memberships` does not. So concurrency here is ordinary
 * optimistic locking on `version` rather than a status compare-and-set, and the
 * inviter is recorded in its own column instead of only in `created_by`.
 *
 * The advisory lock is still taken for last-owner protection, keyed on the
 * WORKSPACE: a count-then-act over active admins is a race exactly as it is at
 * the organization tier.
 *
 * ── Rule 9 ──────────────────────────────────────────────────────────────────
 * "A user must have an active organization membership to hold a workspace
 * membership." Checked on invite. `organization_memberships` is one of the five
 * RLS exceptions, so it is readable from inside a workspace-scoped transaction
 * — which is the whole reason that exception exists.
 */

import type { DomainEvent, EventPublisher } from '@contentos/contracts';
import type { AuditContext, AuditWriter, NewAuditRecord } from '@contentos/security';
import { secureId, WORKSPACE_ROLES, type WorkspaceRole } from '@contentos/security';

import {
  membershipAccepted,
  membershipInvited,
  membershipRevoked,
  membershipRoleChanged,
  type MembershipEventContext,
} from './events.js';
import {
  canGrantWorkspaceRole,
  invitationExpiry,
  isInvitationExpired,
  MembershipError,
  toRoleBinding,
  WORKSPACE_OWNER_ROLE,
  wouldRemoveLastOwner,
  type MembershipStatus,
} from './membership.js';
import type { MembershipActor, MembershipExecutor } from './organization-memberships.js';

export const WORKSPACE_MEMBERSHIP_AUDIT_ACTIONS = {
  invited: 'workspace.membership.invited',
  accepted: 'workspace.membership.accepted',
  roleChanged: 'workspace.membership.role_changed',
  revoked: 'workspace.membership.revoked',
  invitationRevoked: 'workspace.membership.invitation_revoked',
} as const;

export type WorkspaceMembershipAuditAction =
  (typeof WORKSPACE_MEMBERSHIP_AUDIT_ACTIONS)[keyof typeof WORKSPACE_MEMBERSHIP_AUDIT_ACTIONS];

const ADVISORY_LOCK_SQL = `SELECT pg_advisory_xact_lock(hashtext('workspace_membership'), hashtext($1))`;

const SELECT_MEMBERSHIP_SQL = `
  SELECT id, tenant_id, organization_id, user_id, role, status, expires_at, invited_by, version
    FROM workspace_memberships
   WHERE tenant_id = $1 AND user_id = $2`;

/** RLS exception 3/5 — readable from inside a workspace-scoped transaction. */
const SELECT_ORG_MEMBERSHIP_SQL = `
  SELECT role, status
    FROM organization_memberships
   WHERE organization_id = $1 AND user_id = $2`;

const INSERT_INVITATION_SQL = `
  INSERT INTO workspace_memberships (
    tenant_id, organization_id, user_id, role, status, expires_at, invited_by, created_by, updated_by
  ) VALUES ($1,$2,$3,$4,'invited',$5,$6,$6,$6)
  RETURNING id, version`;

const REINVITE_SQL = `
  UPDATE workspace_memberships
     SET role = $1, status = 'invited', expires_at = $2, invited_by = $3,
         version = version + 1, updated_at = now(), updated_by = $3
   WHERE id = $4 AND version = $5
  RETURNING version`;

const ACCEPT_SQL = `
  UPDATE workspace_memberships
     SET status = 'active', expires_at = NULL, version = version + 1,
         updated_at = now(), updated_by = $1
   WHERE id = $2 AND version = $3 AND status = 'invited'
  RETURNING version`;

const CHANGE_ROLE_SQL = `
  UPDATE workspace_memberships
     SET role = $1, version = version + 1, updated_at = now(), updated_by = $2
   WHERE id = $3 AND version = $4 AND status = 'active'
  RETURNING version`;

const REVOKE_SQL = `
  UPDATE workspace_memberships
     SET status = 'revoked', version = version + 1, updated_at = now(), updated_by = $1
   WHERE id = $2 AND version = $3
  RETURNING version`;

const COUNT_ACTIVE_ADMINS_SQL = `
  SELECT count(*)::int AS count
    FROM workspace_memberships
   WHERE tenant_id = $1 AND role = $2 AND status = 'active'`;

interface WorkspaceMembershipRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly organization_id: string;
  readonly user_id: string;
  readonly role: string;
  readonly status: string;
  readonly expires_at: unknown;
  readonly invited_by: string | null;
  readonly version: number;
}

function toDate(value: unknown): Date | null {
  if (value instanceof Date) return value;
  if (typeof value === 'string') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

function isWorkspaceRole(value: string): value is WorkspaceRole {
  return (WORKSPACE_ROLES as readonly string[]).includes(value);
}

export interface WorkspaceMembership {
  readonly membershipId: string;
  readonly workspaceId: string;
  readonly organizationId: string;
  readonly userId: string;
  readonly role: WorkspaceRole;
  readonly status: MembershipStatus;
  readonly expiresAt: Date | null;
  readonly version: number;
}

export interface WorkspaceMembershipServiceOptions {
  readonly publisher: EventPublisher;
  readonly audit: AuditWriter;
  readonly now?: () => Date;
  readonly newEventId?: () => string;
}

interface BaseWorkspaceCommand {
  /** The workspace, which IS the tenant the transaction runs under. */
  readonly workspaceId: string;
  readonly organizationId: string;
  readonly userId: string;
  readonly actor: MembershipActor;
  readonly correlationId: string;
  readonly causationId?: string | null;
  readonly reason?: string;
  readonly context?: AuditContext;
  /** An explicit precondition. Omitted, the version read in this transaction is used. */
  readonly expectedVersion?: number;
}

export interface InviteWorkspaceMemberCommand extends BaseWorkspaceCommand {
  readonly role: WorkspaceRole;
}

export type AcceptWorkspaceInvitationCommand = BaseWorkspaceCommand;

export interface ChangeWorkspaceRoleCommand extends BaseWorkspaceCommand {
  readonly role: WorkspaceRole;
}

export interface RevokeWorkspaceMembershipCommand extends BaseWorkspaceCommand {
  /**
   * Revoke even when it removes the last active `workspace_admin`.
   *
   * SET BY THE ORGANIZATION-REVOCATION CASCADE, AND NOTHING ELSE.
   *
   * Two documented rules collide there: organizations rule 9 requires that
   * removing someone from an organization revokes every workspace membership
   * they hold within it, and workspace rule 5 refuses to remove the last
   * administrator. Security decides it. Leaving an ex-member with live access
   * to a workspace inside an organization they no longer belong to is an
   * access-control failure happening now; an administrator-less workspace is an
   * administrative problem an `org_admin` can fix, since organization roles
   * carry `workspace:*` without carrying content access.
   *
   * It is recorded in the audit detail, so an override is never silent.
   */
  readonly overrideLastAdminProtection?: boolean;
}

export interface WorkspaceMembershipResult {
  readonly membership: WorkspaceMembership;
  readonly changed: boolean;
  readonly event: DomainEvent<unknown> | null;
}

export interface WorkspaceMembershipService {
  invite(
    tx: MembershipExecutor,
    command: InviteWorkspaceMemberCommand,
  ): Promise<WorkspaceMembershipResult>;
  accept(
    tx: MembershipExecutor,
    command: AcceptWorkspaceInvitationCommand,
  ): Promise<WorkspaceMembershipResult>;
  changeRole(
    tx: MembershipExecutor,
    command: ChangeWorkspaceRoleCommand,
  ): Promise<WorkspaceMembershipResult>;
  /** Covers both "revoke invitation" and "remove member". */
  revoke(
    tx: MembershipExecutor,
    command: RevokeWorkspaceMembershipCommand,
  ): Promise<WorkspaceMembershipResult>;
}

const EMPTY_CONTEXT: AuditContext = {
  ipAddress: null,
  userAgent: null,
  sessionId: null,
  stepUpSatisfied: false,
};

function withDetail(base: AuditContext, detail: Readonly<Record<string, string>>): AuditContext {
  return { ...base, detail: { ...base.detail, ...detail } };
}

export function createWorkspaceMembershipService(
  options: WorkspaceMembershipServiceOptions,
): WorkspaceMembershipService {
  const now = options.now ?? ((): Date => new Date());
  const newEventId = options.newEventId ?? secureId;
  const { publisher, audit } = options;

  function eventContext(command: BaseWorkspaceCommand): MembershipEventContext {
    return {
      eventId: newEventId(),
      correlationId: command.correlationId,
      causationId: command.causationId ?? null,
      occurredAt: now().toISOString(),
    };
  }

  function auditEntry(
    membershipId: string,
    command: BaseWorkspaceCommand,
    action: WorkspaceMembershipAuditAction,
    detail: Readonly<Record<string, string>>,
  ): NewAuditRecord {
    return {
      tenantId: command.workspaceId,
      organizationId: command.organizationId,
      actorId: command.actor.id,
      actorKind: command.actor.kind,
      correlationId: command.correlationId,
      action,
      target: {
        kind: 'workspace_membership',
        id: membershipId,
        tenantId: command.workspaceId,
      },
      result: 'success',
      reason: command.reason ?? action,
      context: withDetail(command.context ?? EMPTY_CONTEXT, {
        ...detail,
        subjectUserId: command.userId,
      }),
    };
  }

  async function readMembership(
    tx: MembershipExecutor,
    workspaceId: string,
    userId: string,
  ): Promise<WorkspaceMembershipRow | undefined> {
    const rows = await tx.query<WorkspaceMembershipRow>(SELECT_MEMBERSHIP_SQL, [
      workspaceId,
      userId,
    ]);
    return rows[0];
  }

  async function assertMayGrant(
    tx: MembershipExecutor,
    command: BaseWorkspaceCommand,
    ...targetRoles: readonly string[]
  ): Promise<void> {
    if (command.actor.kind !== 'user') return;

    const actorRow = await readMembership(tx, command.workspaceId, command.actor.id);
    if (actorRow === undefined || actorRow.status !== 'active' || !isWorkspaceRole(actorRow.role)) {
      throw new MembershipError(
        'ActorNotMember',
        `Actor '${command.actor.id}' holds no active membership in workspace '${command.workspaceId}'.`,
      );
    }
    for (const target of targetRoles) {
      if (!isWorkspaceRole(target) || !canGrantWorkspaceRole(actorRow.role, target)) {
        throw new MembershipError(
          'RoleGrantNotPermitted',
          `Role '${actorRow.role}' may not act on role '${target}'.`,
        );
      }
    }
  }

  /**
   * Last-admin protection.
   *
   * `workspace.md` rule 5 and the `WS_LAST_OWNER` trigger named in
   * `03-database/tables.md`. It is a security control, not a convenience: "a
   * workspace with no owner is unadministrable and its data unreachable through
   * normal paths".
   */
  async function assertNotLastAdmin(
    tx: MembershipExecutor,
    workspaceId: string,
    row: WorkspaceMembershipRow,
    nextRole: string | null,
  ): Promise<void> {
    if (row.role !== WORKSPACE_OWNER_ROLE || row.status !== 'active') return;

    const counted = await tx.query<{ count: number }>(COUNT_ACTIVE_ADMINS_SQL, [
      workspaceId,
      WORKSPACE_OWNER_ROLE,
    ]);
    const activeAdmins = counted[0]?.count ?? 0;

    if (wouldRemoveLastOwner(row.role, nextRole, 'active', activeAdmins, WORKSPACE_OWNER_ROLE)) {
      throw new MembershipError(
        'LastOwnerProtected',
        `Workspace '${workspaceId}' would be left without an active '${WORKSPACE_OWNER_ROLE}'. Promote another administrator first.`,
      );
    }
  }

  function membershipOf(
    row: WorkspaceMembershipRow,
    role: WorkspaceRole,
    status: MembershipStatus,
    expiresAt: Date | null,
    version: number,
  ): WorkspaceMembership {
    return {
      membershipId: row.id,
      workspaceId: row.tenant_id,
      organizationId: row.organization_id,
      userId: row.user_id,
      role,
      status,
      expiresAt,
      version,
    };
  }

  return {
    async invite(tx, command) {
      await tx.query(ADVISORY_LOCK_SQL, [command.workspaceId]);
      await assertMayGrant(tx, command, command.role);

      // Rule 9. Without an organization membership the invitee could hold
      // workspace access inside an organization they do not belong to.
      const orgRows = await tx.query<{ role: string; status: string }>(SELECT_ORG_MEMBERSHIP_SQL, [
        command.organizationId,
        command.userId,
      ]);
      if (orgRows[0]?.status !== 'active') {
        throw new MembershipError(
          'OrganizationMembershipRequired',
          `User '${command.userId}' needs an active membership in organization '${command.organizationId}' before joining a workspace within it.`,
        );
      }

      const existing = await readMembership(tx, command.workspaceId, command.userId);
      const at = now();
      const expiresAt = invitationExpiry(at);

      let row: WorkspaceMembershipRow;
      let version: number;

      if (existing === undefined) {
        const inserted = await tx.query<{ id: string; version: number }>(INSERT_INVITATION_SQL, [
          command.workspaceId,
          command.organizationId,
          command.userId,
          command.role,
          expiresAt.toISOString(),
          command.actor.id,
        ]);
        const created = inserted[0];
        if (created === undefined) {
          throw new MembershipError(
            'ConcurrentModification',
            'The invitation insert returned no row.',
          );
        }
        row = {
          id: created.id,
          tenant_id: command.workspaceId,
          organization_id: command.organizationId,
          user_id: command.userId,
          role: command.role,
          status: 'invited',
          expires_at: expiresAt,
          invited_by: command.actor.id,
          version: created.version,
        };
        version = created.version;
      } else {
        if (existing.status === 'active') {
          throw new MembershipError(
            'AlreadyMember',
            `User '${command.userId}' is already an active member of workspace '${command.workspaceId}'; change their role instead of re-inviting.`,
          );
        }
        if (
          existing.status === 'invited' &&
          !isInvitationExpired(toDate(existing.expires_at), at)
        ) {
          throw new MembershipError(
            'DuplicateInvitation',
            `User '${command.userId}' already has a pending invitation to workspace '${command.workspaceId}'.`,
          );
        }

        await assertMayGrant(tx, command, existing.role);
        const expectedVersion = command.expectedVersion ?? existing.version;
        const updated = await tx.query<{ version: number }>(REINVITE_SQL, [
          command.role,
          expiresAt.toISOString(),
          command.actor.id,
          existing.id,
          expectedVersion,
        ]);
        const next = updated[0]?.version;
        if (next === undefined) {
          throw new MembershipError(
            'ConcurrentModification',
            `Membership '${existing.id}' changed under this transaction; expected version ${String(expectedVersion)}.`,
          );
        }
        row = existing;
        version = next;
      }

      await audit.record(
        tx,
        auditEntry(row.id, command, WORKSPACE_MEMBERSHIP_AUDIT_ACTIONS.invited, {
          role: command.role,
          expiresAt: expiresAt.toISOString(),
          reissued: String(existing !== undefined),
        }),
      );

      const event = membershipInvited(row.id, command.organizationId, eventContext(command), {
        workspaceId: command.workspaceId,
        userId: command.userId,
        role: command.role,
        invitedBy: command.actor.id,
        expiresAt: expiresAt.toISOString(),
      });
      await publisher.publish(tx, event);

      return {
        membership: membershipOf(row, command.role, 'invited', expiresAt, version),
        changed: true,
        event,
      };
    },

    async accept(tx, command) {
      const existing = await readMembership(tx, command.workspaceId, command.userId);
      if (existing === undefined || !isWorkspaceRole(existing.role)) {
        throw new MembershipError(
          'MembershipNotFound',
          `User '${command.userId}' has no invitation to workspace '${command.workspaceId}'.`,
        );
      }
      if (existing.status !== 'invited') {
        throw new MembershipError(
          'InvitationNotPending',
          `Membership '${existing.id}' is '${existing.status}', not a pending invitation.`,
        );
      }
      if (isInvitationExpired(toDate(existing.expires_at), now())) {
        throw new MembershipError(
          'InvitationExpired',
          `The invitation for user '${command.userId}' expired and must be reissued.`,
        );
      }

      const expectedVersion = command.expectedVersion ?? existing.version;
      const updated = await tx.query<{ version: number }>(ACCEPT_SQL, [
        command.actor.id,
        existing.id,
        expectedVersion,
      ]);
      const version = updated[0]?.version;
      if (version === undefined) {
        throw new MembershipError(
          'ConcurrentModification',
          `Membership '${existing.id}' is no longer a pending invitation at version ${String(expectedVersion)}.`,
        );
      }

      await audit.record(
        tx,
        auditEntry(existing.id, command, WORKSPACE_MEMBERSHIP_AUDIT_ACTIONS.accepted, {
          role: existing.role,
        }),
      );

      const event = membershipAccepted(existing.id, command.organizationId, eventContext(command), {
        workspaceId: command.workspaceId,
        userId: command.userId,
        role: existing.role,
      });
      await publisher.publish(tx, event);

      return {
        membership: membershipOf(existing, existing.role, 'active', null, version),
        changed: true,
        event,
      };
    },

    async changeRole(tx, command) {
      await tx.query(ADVISORY_LOCK_SQL, [command.workspaceId]);

      const existing = await readMembership(tx, command.workspaceId, command.userId);
      if (existing === undefined || !isWorkspaceRole(existing.role)) {
        throw new MembershipError(
          'MembershipNotFound',
          `User '${command.userId}' holds no membership in workspace '${command.workspaceId}'.`,
        );
      }
      if (existing.status !== 'active') {
        throw new MembershipError(
          'InvitationNotPending',
          `Membership '${existing.id}' is '${existing.status}'; only an active membership has a role to change.`,
        );
      }

      const previousRole = existing.role;
      if (previousRole === command.role) {
        return {
          membership: membershipOf(existing, previousRole, 'active', null, existing.version),
          changed: false,
          event: null,
        };
      }

      await assertMayGrant(tx, command, previousRole, command.role);
      await assertNotLastAdmin(tx, command.workspaceId, existing, command.role);

      const expectedVersion = command.expectedVersion ?? existing.version;
      const updated = await tx.query<{ version: number }>(CHANGE_ROLE_SQL, [
        command.role,
        command.actor.id,
        existing.id,
        expectedVersion,
      ]);
      const version = updated[0]?.version;
      if (version === undefined) {
        throw new MembershipError(
          'ConcurrentModification',
          `Membership '${existing.id}' changed under this transaction; expected version ${String(expectedVersion)}.`,
        );
      }

      await audit.record(
        tx,
        auditEntry(existing.id, command, WORKSPACE_MEMBERSHIP_AUDIT_ACTIONS.roleChanged, {
          previousRole,
          role: command.role,
        }),
      );

      const event = membershipRoleChanged(
        existing.id,
        command.organizationId,
        eventContext(command),
        {
          workspaceId: command.workspaceId,
          userId: command.userId,
          previousRole,
          role: command.role,
          changedBy: command.actor.id,
        },
      );
      await publisher.publish(tx, event);

      return {
        membership: membershipOf(existing, command.role, 'active', null, version),
        changed: true,
        event,
      };
    },

    async revoke(tx, command) {
      await tx.query(ADVISORY_LOCK_SQL, [command.workspaceId]);

      const existing = await readMembership(tx, command.workspaceId, command.userId);
      if (existing === undefined || !isWorkspaceRole(existing.role)) {
        throw new MembershipError(
          'MembershipNotFound',
          `User '${command.userId}' holds no membership in workspace '${command.workspaceId}'.`,
        );
      }
      if (existing.status === 'revoked') {
        // Idempotent — the cascade depends on this.
        return {
          membership: membershipOf(existing, existing.role, 'revoked', null, existing.version),
          changed: false,
          event: null,
        };
      }

      await assertMayGrant(tx, command, existing.role);
      const override = command.overrideLastAdminProtection ?? false;
      if (!override) {
        await assertNotLastAdmin(tx, command.workspaceId, existing, null);
      }

      const priorStatus = existing.status;
      const expectedVersion = command.expectedVersion ?? existing.version;
      const updated = await tx.query<{ version: number }>(REVOKE_SQL, [
        command.actor.id,
        existing.id,
        expectedVersion,
      ]);
      const version = updated[0]?.version;
      if (version === undefined) {
        throw new MembershipError(
          'ConcurrentModification',
          `Membership '${existing.id}' changed under this transaction; expected version ${String(expectedVersion)}.`,
        );
      }

      const action =
        priorStatus === 'invited'
          ? WORKSPACE_MEMBERSHIP_AUDIT_ACTIONS.invitationRevoked
          : WORKSPACE_MEMBERSHIP_AUDIT_ACTIONS.revoked;

      await audit.record(
        tx,
        auditEntry(existing.id, command, action, {
          role: existing.role,
          previousStatus: priorStatus,
          // Recorded so an override is visible in the trail rather than silent.
          lastAdminProtectionOverridden: String(override),
        }),
      );

      const event = membershipRevoked(existing.id, command.organizationId, eventContext(command), {
        workspaceId: command.workspaceId,
        userId: command.userId,
        revokedBy: command.actor.id,
      });
      await publisher.publish(tx, event);

      return {
        membership: membershipOf(existing, existing.role, 'revoked', null, version),
        changed: true,
        event,
      };
    },
  };
}

/** The authorization binding a workspace membership projects into. */
export function workspaceMembershipBinding(
  membership: WorkspaceMembership,
  grantedBy: string,
  grantedAt: Date,
): ReturnType<typeof toRoleBinding> {
  return toRoleBinding({
    userId: membership.userId,
    role: membership.role,
    status: membership.status,
    organizationId: membership.organizationId,
    workspaceId: membership.workspaceId,
    grantedBy,
    grantedAt,
    expiresAt: membership.expiresAt,
  });
}
