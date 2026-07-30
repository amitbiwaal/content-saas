/**
 * Organization memberships — `04-platform/organizations.md` §Responsibilities.
 *
 * Increment C: invite, accept, revoke, change role, remove. Every operation
 * writes the membership row, the audit record and the outbox event on ONE
 * transaction handle.
 *
 * ── An invitation is a membership row ───────────────────────────────────────
 * There is no invitation table. `status = 'invited'` with `expires_at` IS the
 * invitation, so `UNIQUE (organization_id, user_id)` is what enforces "a user
 * has at most one membership", and re-inviting is an UPDATE of the same row.
 *
 * ── Concurrency without a version column ────────────────────────────────────
 * `organization_memberships` has no `version` (unlike `workspace_memberships`),
 * so optimistic concurrency is expressed as a COMPARE-AND-SET: every UPDATE
 * carries the status — and, for a role change, the role — it expects to find.
 * Zero rows updated means someone else moved it first, and that is reported
 * rather than overwritten.
 *
 * ── Last-owner protection ───────────────────────────────────────────────────
 * `03-database/tables.md` names the mechanism as an `ORG_LAST_OWNER` trigger
 * because it is a cross-row count that cannot be declared. No migration may be
 * added here, so it runs in the application inside the transaction — and a
 * count-then-act is a race, so it runs under a transaction-scoped advisory lock
 * on the organization. Without it two concurrent revocations of the last two
 * owners both see a count of two and an organization ends up with none.
 */

import type { DomainEvent, EventPublisher, Transaction } from '@contentos/contracts';
import type {
  AuditActorKind,
  AuditContext,
  AuditWriter,
  NewAuditRecord,
} from '@contentos/security';
import { ORGANIZATION_ROLES, secureId, type OrganizationRole } from '@contentos/security';

import { organizationEventTenantId } from '../organizations/events.js';
import {
  orgMembershipAccepted,
  orgMembershipInvited,
  orgMembershipRevoked,
  orgMembershipRoleChanged,
  type MembershipEventContext,
} from './events.js';
import {
  canGrantOrganizationRole,
  invitationExpiry,
  isInvitationExpired,
  isMembershipStatus,
  MembershipError,
  ORGANIZATION_OWNER_ROLE,
  toRoleBinding,
  wouldRemoveLastOwner,
  type MembershipStatus,
} from './membership.js';

export interface MembershipExecutor extends Transaction {
  query<T>(sql: string, params?: readonly unknown[]): Promise<readonly T[]>;
}

export interface MembershipActor {
  readonly id: string;
  readonly kind: AuditActorKind;
}

export const ORGANIZATION_MEMBERSHIP_AUDIT_ACTIONS = {
  invited: 'organization.membership.invited',
  accepted: 'organization.membership.accepted',
  roleChanged: 'organization.membership.role_changed',
  revoked: 'organization.membership.revoked',
  invitationRevoked: 'organization.membership.invitation_revoked',
} as const;

export type OrganizationMembershipAuditAction =
  (typeof ORGANIZATION_MEMBERSHIP_AUDIT_ACTIONS)[keyof typeof ORGANIZATION_MEMBERSHIP_AUDIT_ACTIONS];

const ADVISORY_LOCK_SQL = `SELECT pg_advisory_xact_lock(hashtext('organization_membership'), hashtext($1))`;

const SELECT_MEMBERSHIP_SQL = `
  SELECT id, organization_id, user_id, role, status, expires_at, created_by, created_at
    FROM organization_memberships
   WHERE organization_id = $1 AND user_id = $2`;

const INSERT_INVITATION_SQL = `
  INSERT INTO organization_memberships (
    organization_id, user_id, role, status, expires_at, created_by, updated_by
  ) VALUES ($1,$2,$3,'invited',$4,$5,$5)
  RETURNING id, created_at`;

/** Re-invitation of an expired or revoked membership — the same row, reissued. */
const REINVITE_SQL = `
  UPDATE organization_memberships
     SET role = $1, status = 'invited', expires_at = $2, updated_at = now(), updated_by = $3
   WHERE id = $4 AND status = $5
  RETURNING id`;

/** `expires_at` is cleared: it was the invitation's deadline, not the membership's. */
const ACCEPT_SQL = `
  UPDATE organization_memberships
     SET status = 'active', expires_at = NULL, updated_at = now(), updated_by = $1
   WHERE id = $2 AND status = 'invited'
  RETURNING id`;

const CHANGE_ROLE_SQL = `
  UPDATE organization_memberships
     SET role = $1, updated_at = now(), updated_by = $2
   WHERE id = $3 AND role = $4 AND status = 'active'
  RETURNING id`;

const REVOKE_SQL = `
  UPDATE organization_memberships
     SET status = 'revoked', updated_at = now(), updated_by = $1
   WHERE id = $2 AND status = $3
  RETURNING id`;

const COUNT_ACTIVE_OWNERS_SQL = `
  SELECT count(*)::int AS count
    FROM organization_memberships
   WHERE organization_id = $1 AND role = $2 AND status = 'active'`;

interface MembershipRow {
  readonly id: string;
  readonly organization_id: string;
  readonly user_id: string;
  readonly role: string;
  readonly status: string;
  readonly expires_at: unknown;
  readonly created_by: string | null;
  readonly created_at: unknown;
}

function toDate(value: unknown): Date | null {
  if (value instanceof Date) return value;
  if (typeof value === 'string') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

function isOrganizationRole(value: string): value is OrganizationRole {
  return (ORGANIZATION_ROLES as readonly string[]).includes(value);
}

export interface OrganizationMembership {
  readonly membershipId: string;
  readonly organizationId: string;
  readonly userId: string;
  readonly role: OrganizationRole;
  readonly status: MembershipStatus;
  readonly expiresAt: Date | null;
}

export interface OrganizationMembershipServiceOptions {
  readonly publisher: EventPublisher;
  readonly audit: AuditWriter;
  readonly now?: () => Date;
  readonly newEventId?: () => string;
}

interface BaseCommand {
  readonly organizationId: string;
  readonly userId: string;
  readonly actor: MembershipActor;
  readonly correlationId: string;
  readonly causationId?: string | null;
  readonly reason?: string;
  readonly context?: AuditContext;
}

export interface InviteOrganizationMemberCommand extends BaseCommand {
  readonly role: OrganizationRole;
}

export type AcceptOrganizationInvitationCommand = BaseCommand;

export interface ChangeOrganizationRoleCommand extends BaseCommand {
  readonly role: OrganizationRole;
}

export type RevokeOrganizationMembershipCommand = BaseCommand;

export interface MembershipResult {
  readonly membership: OrganizationMembership;
  /** False when the operation was a no-op because the state already matched. */
  readonly changed: boolean;
  readonly event: DomainEvent<unknown> | null;
}

export interface OrganizationMembershipService {
  invite(
    tx: MembershipExecutor,
    command: InviteOrganizationMemberCommand,
  ): Promise<MembershipResult>;
  accept(
    tx: MembershipExecutor,
    command: AcceptOrganizationInvitationCommand,
  ): Promise<MembershipResult>;
  changeRole(
    tx: MembershipExecutor,
    command: ChangeOrganizationRoleCommand,
  ): Promise<MembershipResult>;
  /** Covers both "revoke invitation" and "remove member" — the same terminal status. */
  revoke(
    tx: MembershipExecutor,
    command: RevokeOrganizationMembershipCommand,
  ): Promise<MembershipResult>;
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

export function createOrganizationMembershipService(
  options: OrganizationMembershipServiceOptions,
): OrganizationMembershipService {
  const now = options.now ?? ((): Date => new Date());
  const newEventId = options.newEventId ?? secureId;
  const { publisher, audit } = options;

  function eventContext(command: BaseCommand): MembershipEventContext {
    return {
      eventId: newEventId(),
      correlationId: command.correlationId,
      causationId: command.causationId ?? null,
      occurredAt: now().toISOString(),
    };
  }

  function auditEntry(
    membershipId: string,
    command: BaseCommand,
    action: OrganizationMembershipAuditAction,
    detail: Readonly<Record<string, string>>,
  ): NewAuditRecord {
    const tenantId = organizationEventTenantId(command.organizationId);
    return {
      tenantId,
      organizationId: command.organizationId,
      actorId: command.actor.id,
      actorKind: command.actor.kind,
      correlationId: command.correlationId,
      action,
      target: { kind: 'organization_membership', id: membershipId, tenantId },
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
    organizationId: string,
    userId: string,
  ): Promise<MembershipRow | undefined> {
    const rows = await tx.query<MembershipRow>(SELECT_MEMBERSHIP_SQL, [organizationId, userId]);
    return rows[0];
  }

  /**
   * The actor's own role, read from the database rather than taken from the
   * caller — a claimed role is a claim, and this one decides whether an
   * `org_owner` may be created.
   *
   * Non-user actors (the revocation cascade, an operator support action) hold
   * no membership by construction, so the grant matrix does not apply to them.
   * `actorKind` is recorded on every audit record, so those actions remain
   * attributable.
   */
  async function assertMayGrant(
    tx: MembershipExecutor,
    command: BaseCommand,
    ...targetRoles: readonly string[]
  ): Promise<void> {
    if (command.actor.kind !== 'user') return;

    const actorRow = await readMembership(tx, command.organizationId, command.actor.id);
    if (
      actorRow === undefined ||
      actorRow.status !== 'active' ||
      !isOrganizationRole(actorRow.role)
    ) {
      throw new MembershipError(
        'ActorNotMember',
        `Actor '${command.actor.id}' holds no active membership in organization '${command.organizationId}'.`,
      );
    }

    for (const target of targetRoles) {
      if (!isOrganizationRole(target) || !canGrantOrganizationRole(actorRow.role, target)) {
        throw new MembershipError(
          'RoleGrantNotPermitted',
          `Role '${actorRow.role}' may not act on role '${target}'.`,
        );
      }
    }
  }

  /**
   * Refuses to leave the organization without an active owner.
   *
   * Called under the advisory lock, so the count cannot be read by two
   * transactions that then both proceed.
   */
  async function assertNotLastOwner(
    tx: MembershipExecutor,
    organizationId: string,
    row: MembershipRow,
    nextRole: string | null,
  ): Promise<void> {
    if (row.role !== ORGANIZATION_OWNER_ROLE || row.status !== 'active') return;

    const counted = await tx.query<{ count: number }>(COUNT_ACTIVE_OWNERS_SQL, [
      organizationId,
      ORGANIZATION_OWNER_ROLE,
    ]);
    const activeOwners = counted[0]?.count ?? 0;

    if (wouldRemoveLastOwner(row.role, nextRole, 'active', activeOwners, ORGANIZATION_OWNER_ROLE)) {
      throw new MembershipError(
        'LastOwnerProtected',
        `Organization '${organizationId}' would be left without an active '${ORGANIZATION_OWNER_ROLE}'. Promote another owner first.`,
      );
    }
  }

  function membershipOf(
    row: Pick<MembershipRow, 'id' | 'organization_id' | 'user_id'>,
    role: OrganizationRole,
    status: MembershipStatus,
    expiresAt: Date | null,
  ): OrganizationMembership {
    return {
      membershipId: row.id,
      organizationId: row.organization_id,
      userId: row.user_id,
      role,
      status,
      expiresAt,
    };
  }

  return {
    async invite(tx, command) {
      // Serialises concurrent invitations for the same organization, so two
      // racing invites for one user cannot both insert.
      await tx.query(ADVISORY_LOCK_SQL, [command.organizationId]);
      await assertMayGrant(tx, command, command.role);

      const existing = await readMembership(tx, command.organizationId, command.userId);
      const at = now();
      const expiresAt = invitationExpiry(at);

      let membershipId: string;
      if (existing === undefined) {
        const inserted = await tx.query<{ id: string }>(INSERT_INVITATION_SQL, [
          command.organizationId,
          command.userId,
          command.role,
          expiresAt.toISOString(),
          command.actor.id,
        ]);
        const row = inserted[0];
        if (row === undefined) {
          throw new MembershipError(
            'ConcurrentModification',
            'The invitation insert returned no row.',
          );
        }
        membershipId = row.id;
      } else {
        if (existing.status === 'active') {
          throw new MembershipError(
            'AlreadyMember',
            `User '${command.userId}' is already an active member of organization '${command.organizationId}'; change their role instead of re-inviting.`,
          );
        }
        if (
          existing.status === 'invited' &&
          !isInvitationExpired(toDate(existing.expires_at), at)
        ) {
          throw new MembershipError(
            'DuplicateInvitation',
            `User '${command.userId}' already has a pending invitation to organization '${command.organizationId}'.`,
          );
        }

        // Expired or revoked: the same row is reissued, which is what keeps
        // one membership per user true.
        await assertMayGrant(tx, command, existing.role);
        const updated = await tx.query<{ id: string }>(REINVITE_SQL, [
          command.role,
          expiresAt.toISOString(),
          command.actor.id,
          existing.id,
          existing.status,
        ]);
        if (updated[0] === undefined) {
          throw new MembershipError(
            'ConcurrentModification',
            `Membership '${existing.id}' changed under this transaction; expected status '${existing.status}'.`,
          );
        }
        membershipId = existing.id;
      }

      await audit.record(
        tx,
        auditEntry(membershipId, command, ORGANIZATION_MEMBERSHIP_AUDIT_ACTIONS.invited, {
          role: command.role,
          expiresAt: expiresAt.toISOString(),
          reissued: String(existing !== undefined),
        }),
      );

      const event = orgMembershipInvited(membershipId, eventContext(command), {
        organizationId: command.organizationId,
        userId: command.userId,
        role: command.role,
        invitedBy: command.actor.id,
        expiresAt: expiresAt.toISOString(),
      });
      await publisher.publish(tx, event);

      return {
        membership: membershipOf(
          { id: membershipId, organization_id: command.organizationId, user_id: command.userId },
          command.role,
          'invited',
          expiresAt,
        ),
        changed: true,
        event,
      };
    },

    async accept(tx, command) {
      const existing = await readMembership(tx, command.organizationId, command.userId);
      if (existing === undefined) {
        throw new MembershipError(
          'MembershipNotFound',
          `User '${command.userId}' has no invitation to organization '${command.organizationId}'.`,
        );
      }
      if (!isOrganizationRole(existing.role) || !isMembershipStatus(existing.status)) {
        throw new MembershipError(
          'MembershipNotFound',
          `Membership '${existing.id}' holds an unknown role or status.`,
        );
      }
      if (existing.status !== 'invited') {
        throw new MembershipError(
          'InvitationNotPending',
          `Membership '${existing.id}' is '${existing.status}', not a pending invitation.`,
        );
      }
      // Checked at use. An expired invitation "cannot be accepted and must be
      // reissued" — reissuing is what `invite` does to an expired row.
      if (isInvitationExpired(toDate(existing.expires_at), now())) {
        throw new MembershipError(
          'InvitationExpired',
          `The invitation for user '${command.userId}' expired and must be reissued.`,
        );
      }

      const updated = await tx.query<{ id: string }>(ACCEPT_SQL, [command.actor.id, existing.id]);
      if (updated[0] === undefined) {
        throw new MembershipError(
          'ConcurrentModification',
          `Membership '${existing.id}' is no longer a pending invitation.`,
        );
      }

      await audit.record(
        tx,
        auditEntry(existing.id, command, ORGANIZATION_MEMBERSHIP_AUDIT_ACTIONS.accepted, {
          role: existing.role,
        }),
      );

      const event = orgMembershipAccepted(existing.id, eventContext(command), {
        organizationId: command.organizationId,
        userId: command.userId,
        role: existing.role,
      });
      await publisher.publish(tx, event);

      return {
        membership: membershipOf(existing, existing.role, 'active', null),
        changed: true,
        event,
      };
    },

    async changeRole(tx, command) {
      await tx.query(ADVISORY_LOCK_SQL, [command.organizationId]);

      const existing = await readMembership(tx, command.organizationId, command.userId);
      if (existing === undefined || !isOrganizationRole(existing.role)) {
        throw new MembershipError(
          'MembershipNotFound',
          `User '${command.userId}' holds no membership in organization '${command.organizationId}'.`,
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
        // Idempotent: nothing changed, so nothing is audited or published.
        return {
          membership: membershipOf(existing, previousRole, 'active', null),
          changed: false,
          event: null,
        };
      }

      // Both ends are checked: an org_admin may grant org_member but may not
      // act on an org_owner, so demoting one is refused.
      await assertMayGrant(tx, command, previousRole, command.role);
      await assertNotLastOwner(tx, command.organizationId, existing, command.role);

      const updated = await tx.query<{ id: string }>(CHANGE_ROLE_SQL, [
        command.role,
        command.actor.id,
        existing.id,
        previousRole,
      ]);
      if (updated[0] === undefined) {
        throw new MembershipError(
          'ConcurrentModification',
          `Membership '${existing.id}' changed under this transaction; expected role '${previousRole}'.`,
        );
      }

      await audit.record(
        tx,
        auditEntry(existing.id, command, ORGANIZATION_MEMBERSHIP_AUDIT_ACTIONS.roleChanged, {
          previousRole,
          role: command.role,
        }),
      );

      const event = orgMembershipRoleChanged(existing.id, eventContext(command), {
        organizationId: command.organizationId,
        userId: command.userId,
        previousRole,
        role: command.role,
        changedBy: command.actor.id,
      });
      await publisher.publish(tx, event);

      return {
        membership: membershipOf(existing, command.role, 'active', null),
        changed: true,
        event,
      };
    },

    async revoke(tx, command) {
      await tx.query(ADVISORY_LOCK_SQL, [command.organizationId]);

      const existing = await readMembership(tx, command.organizationId, command.userId);
      if (existing === undefined || !isOrganizationRole(existing.role)) {
        throw new MembershipError(
          'MembershipNotFound',
          `User '${command.userId}' holds no membership in organization '${command.organizationId}'.`,
        );
      }
      if (existing.status === 'revoked') {
        // Already revoked: idempotent, and nothing is published a second time.
        return {
          membership: membershipOf(existing, existing.role, 'revoked', null),
          changed: false,
          event: null,
        };
      }

      await assertMayGrant(tx, command, existing.role);
      await assertNotLastOwner(tx, command.organizationId, existing, null);

      const priorStatus = existing.status;
      const updated = await tx.query<{ id: string }>(REVOKE_SQL, [
        command.actor.id,
        existing.id,
        priorStatus,
      ]);
      if (updated[0] === undefined) {
        throw new MembershipError(
          'ConcurrentModification',
          `Membership '${existing.id}' changed under this transaction; expected status '${priorStatus}'.`,
        );
      }

      // The same terminal status, but a withdrawn offer and a removed member
      // are different events to an investigator.
      const action =
        priorStatus === 'invited'
          ? ORGANIZATION_MEMBERSHIP_AUDIT_ACTIONS.invitationRevoked
          : ORGANIZATION_MEMBERSHIP_AUDIT_ACTIONS.revoked;

      await audit.record(
        tx,
        auditEntry(existing.id, command, action, {
          role: existing.role,
          previousStatus: priorStatus,
        }),
      );

      const event = orgMembershipRevoked(existing.id, eventContext(command), {
        organizationId: command.organizationId,
        userId: command.userId,
        revokedBy: command.actor.id,
      });
      await publisher.publish(tx, event);

      return {
        membership: membershipOf(existing, existing.role, 'revoked', null),
        changed: true,
        event,
      };
    },
  };
}

/** The authorization binding a membership projects into, or null if it grants nothing. */
export function organizationMembershipBinding(
  membership: OrganizationMembership,
  grantedBy: string,
  grantedAt: Date,
): ReturnType<typeof toRoleBinding> {
  return toRoleBinding({
    userId: membership.userId,
    role: membership.role,
    status: membership.status,
    organizationId: membership.organizationId,
    workspaceId: null,
    grantedBy,
    grantedAt,
    expiresAt: membership.expiresAt,
  });
}
