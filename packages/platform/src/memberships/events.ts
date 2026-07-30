/**
 * Membership domain events — `02-domain-design/organizations.md` and
 * `02-domain-design/workspace.md` §"Domain Events".
 *
 * ── The invitee is a userId, not an email ────────────────────────────────────
 * Both docs table the invited payload as `{ …, inviteeEmail, … }`. It is a
 * userId here, for two independent reasons and neither is a preference:
 *
 *  1. The FROZEN envelope validator rejects an email-shaped payload value
 *     outright — "payloads carry opaque identifiers, not personal data". An
 *     event with `inviteeEmail` cannot reach the outbox at all.
 *  2. There is nowhere to put an email anyway. Both membership tables declare
 *     `user_id UUID NOT NULL REFERENCES users(id)`, so an invitation is issued
 *     to an existing user record, not to an address.
 *
 * The platform's own convention agrees: `UserRegistered` carries `emailHash`,
 * "hash, not address", "because event payloads reach more consumers than the
 * user record does". Inviting an address that has no user yet is a Users
 * concern and is not part of this increment.
 *
 * ── The aggregate is the membership ─────────────────────────────────────────
 * Both docs list OrganizationMembership and Membership as aggregate roots in
 * their own right — "high-frequency independent writes". So `aggregateId` is
 * the membership row, which is what orders one person's
 * invited → accepted → role-changed → revoked sequence.
 */

import type { DomainEvent } from '@contentos/contracts';
import type { OrganizationRole, WorkspaceRole } from '@contentos/security';

// The organization-event tenant convention is decided in exactly one place.
// Re-deriving it here would fork it.
import { organizationEventTenantId } from '../organizations/events.js';

export const MEMBERSHIP_PRODUCER = 'platform.memberships';

export const ORGANIZATION_MEMBERSHIP_AGGREGATE = 'OrganizationMembership';
export const WORKSPACE_MEMBERSHIP_AGGREGATE = 'WorkspaceMembership';

export const ORGANIZATION_MEMBERSHIP_EVENT_TYPES = [
  'OrgMembershipInvited',
  'OrgMembershipAccepted',
  'OrgMembershipRoleChanged',
  'OrgMembershipRevoked',
] as const;

export const WORKSPACE_MEMBERSHIP_EVENT_TYPES = [
  'MembershipInvited',
  'MembershipAccepted',
  'MembershipRoleChanged',
  'MembershipRevoked',
] as const;

export type OrganizationMembershipEventType = (typeof ORGANIZATION_MEMBERSHIP_EVENT_TYPES)[number];
export type WorkspaceMembershipEventType = (typeof WORKSPACE_MEMBERSHIP_EVENT_TYPES)[number];

export interface MembershipEventContext {
  readonly eventId: string;
  readonly correlationId: string;
  /**
   * Null for a root event. The cascade sets it to the `OrgMembershipRevoked`
   * event's id, which is what ties a revoked workspace membership back to the
   * organization decision that caused it.
   */
  readonly causationId: string | null;
  readonly occurredAt: string;
}

// ── Organization membership ─────────────────────────────────────────────────

export interface OrgMembershipInvitedPayload {
  readonly organizationId: string;
  readonly userId: string;
  readonly role: OrganizationRole;
  readonly invitedBy: string;
  readonly expiresAt: string;
}

export interface OrgMembershipAcceptedPayload {
  readonly organizationId: string;
  readonly userId: string;
  readonly role: OrganizationRole;
}

export interface OrgMembershipRoleChangedPayload {
  readonly organizationId: string;
  readonly userId: string;
  readonly previousRole: OrganizationRole;
  readonly role: OrganizationRole;
  readonly changedBy: string;
}

export interface OrgMembershipRevokedPayload {
  readonly organizationId: string;
  readonly userId: string;
  readonly revokedBy: string;
}

function organizationEnvelope<T>(
  membershipId: string,
  organizationId: string,
  eventType: OrganizationMembershipEventType,
  ctx: MembershipEventContext,
  payload: T,
): DomainEvent<T> {
  return {
    eventId: ctx.eventId,
    eventType,
    eventVersion: 1,
    aggregateType: ORGANIZATION_MEMBERSHIP_AGGREGATE,
    aggregateId: membershipId,
    tenantId: organizationEventTenantId(organizationId),
    organizationId,
    correlationId: ctx.correlationId,
    causationId: ctx.causationId,
    producer: MEMBERSHIP_PRODUCER,
    occurredAt: ctx.occurredAt,
    payload,
  };
}

export function orgMembershipInvited(
  membershipId: string,
  ctx: MembershipEventContext,
  payload: OrgMembershipInvitedPayload,
): DomainEvent<OrgMembershipInvitedPayload> {
  return organizationEnvelope(
    membershipId,
    payload.organizationId,
    'OrgMembershipInvited',
    ctx,
    payload,
  );
}

export function orgMembershipAccepted(
  membershipId: string,
  ctx: MembershipEventContext,
  payload: OrgMembershipAcceptedPayload,
): DomainEvent<OrgMembershipAcceptedPayload> {
  return organizationEnvelope(
    membershipId,
    payload.organizationId,
    'OrgMembershipAccepted',
    ctx,
    payload,
  );
}

export function orgMembershipRoleChanged(
  membershipId: string,
  ctx: MembershipEventContext,
  payload: OrgMembershipRoleChangedPayload,
): DomainEvent<OrgMembershipRoleChangedPayload> {
  return organizationEnvelope(
    membershipId,
    payload.organizationId,
    'OrgMembershipRoleChanged',
    ctx,
    payload,
  );
}

export function orgMembershipRevoked(
  membershipId: string,
  ctx: MembershipEventContext,
  payload: OrgMembershipRevokedPayload,
): DomainEvent<OrgMembershipRevokedPayload> {
  return organizationEnvelope(
    membershipId,
    payload.organizationId,
    'OrgMembershipRevoked',
    ctx,
    payload,
  );
}

// ── Workspace membership ────────────────────────────────────────────────────

export interface MembershipInvitedPayload {
  readonly workspaceId: string;
  readonly userId: string;
  readonly role: WorkspaceRole;
  readonly invitedBy: string;
  readonly expiresAt: string;
}

export interface MembershipAcceptedPayload {
  readonly workspaceId: string;
  readonly userId: string;
  readonly role: WorkspaceRole;
}

export interface MembershipRoleChangedPayload {
  readonly workspaceId: string;
  readonly userId: string;
  readonly previousRole: WorkspaceRole;
  readonly role: WorkspaceRole;
  readonly changedBy: string;
}

export interface MembershipRevokedPayload {
  readonly workspaceId: string;
  readonly userId: string;
  readonly revokedBy: string;
}

function workspaceEnvelope<T>(
  membershipId: string,
  workspaceId: string,
  organizationId: string,
  eventType: WorkspaceMembershipEventType,
  ctx: MembershipEventContext,
  payload: T,
): DomainEvent<T> {
  return {
    eventId: ctx.eventId,
    eventType,
    eventVersion: 1,
    aggregateType: WORKSPACE_MEMBERSHIP_AGGREGATE,
    aggregateId: membershipId,
    // The workspace IS the tenant (ADR-017).
    tenantId: workspaceId,
    organizationId,
    correlationId: ctx.correlationId,
    causationId: ctx.causationId,
    producer: MEMBERSHIP_PRODUCER,
    occurredAt: ctx.occurredAt,
    payload,
  };
}

export function membershipInvited(
  membershipId: string,
  organizationId: string,
  ctx: MembershipEventContext,
  payload: MembershipInvitedPayload,
): DomainEvent<MembershipInvitedPayload> {
  return workspaceEnvelope(
    membershipId,
    payload.workspaceId,
    organizationId,
    'MembershipInvited',
    ctx,
    payload,
  );
}

export function membershipAccepted(
  membershipId: string,
  organizationId: string,
  ctx: MembershipEventContext,
  payload: MembershipAcceptedPayload,
): DomainEvent<MembershipAcceptedPayload> {
  return workspaceEnvelope(
    membershipId,
    payload.workspaceId,
    organizationId,
    'MembershipAccepted',
    ctx,
    payload,
  );
}

export function membershipRoleChanged(
  membershipId: string,
  organizationId: string,
  ctx: MembershipEventContext,
  payload: MembershipRoleChangedPayload,
): DomainEvent<MembershipRoleChangedPayload> {
  return workspaceEnvelope(
    membershipId,
    payload.workspaceId,
    organizationId,
    'MembershipRoleChanged',
    ctx,
    payload,
  );
}

export function membershipRevoked(
  membershipId: string,
  organizationId: string,
  ctx: MembershipEventContext,
  payload: MembershipRevokedPayload,
): DomainEvent<MembershipRevokedPayload> {
  return workspaceEnvelope(
    membershipId,
    payload.workspaceId,
    organizationId,
    'MembershipRevoked',
    ctx,
    payload,
  );
}
