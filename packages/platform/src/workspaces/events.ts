/**
 * Workspace domain events — `02-domain-design/workspace.md` §"Domain Events".
 *
 * Payload shapes are transcribed from that table and are the contract.
 *
 * Unlike organization events, these need no tenant convention: `workspaces.id`
 * IS `tenant_id` (ADR-017), so the envelope's `tenantId` is simply the
 * workspace. "Code that converts between them, or holds both, indicates a
 * modelling error" (`04-platform/workspaces.md` §"Implementation notes"), which
 * is why there is one identifier below and not two.
 *
 * NOT here, deliberately:
 *  - `WorkspacePurged` — its producer is the RETENTION WORKER, not this service.
 *  - `WorkspaceRenamed` / `WorkspaceSettingsUpdated` — rename and settings
 *    updates are not in this increment; provisioning writes the default layer
 *    and nothing else mutates it yet.
 */

import type { DomainEvent } from '@contentos/contracts';

export const WORKSPACE_PRODUCER = 'platform.workspaces';

export const WORKSPACE_AGGREGATE = 'Workspace';

export const WORKSPACE_EVENT_TYPES = [
  'WorkspaceCreated',
  'WorkspaceSuspended',
  'WorkspaceReactivated',
  'WorkspaceArchived',
  'WorkspaceDeletionRequested',
] as const;

export type WorkspaceEventType = (typeof WORKSPACE_EVENT_TYPES)[number];

export interface WorkspaceCreatedPayload {
  readonly workspaceId: string;
  readonly organizationId: string;
  readonly name: string;
  readonly slug: string;
  readonly createdBy: string;
}

export interface WorkspaceSuspendedPayload {
  readonly workspaceId: string;
  readonly reason: string;
  readonly suspendedAt: string;
}

/**
 * Carries `previousStatus` by contract — the payload is shaped for a restoring
 * transition, which is why all three of them publish it.
 */
export interface WorkspaceReactivatedPayload {
  readonly workspaceId: string;
  readonly previousStatus: string;
}

export interface WorkspaceArchivedPayload {
  readonly workspaceId: string;
  readonly archivedBy: string;
}

export interface WorkspaceDeletionRequestedPayload {
  readonly workspaceId: string;
  readonly purgeAfter: string;
}

export type WorkspaceEventPayload =
  | WorkspaceCreatedPayload
  | WorkspaceSuspendedPayload
  | WorkspaceReactivatedPayload
  | WorkspaceArchivedPayload
  | WorkspaceDeletionRequestedPayload;

export interface WorkspaceEventContext {
  readonly eventId: string;
  readonly correlationId: string;
  /**
   * Null for a root event. A cascade from `OrganizationSuspended` sets this to
   * that event's id, which is what makes an incident reconstructable across the
   * organization/workspace seam.
   */
  readonly causationId: string | null;
  readonly occurredAt: string;
  readonly organizationId: string;
}

function envelope<T>(
  workspaceId: string,
  eventType: WorkspaceEventType,
  ctx: WorkspaceEventContext,
  payload: T,
): DomainEvent<T> {
  return {
    eventId: ctx.eventId,
    eventType,
    eventVersion: 1,
    aggregateType: WORKSPACE_AGGREGATE,
    aggregateId: workspaceId,
    // The workspace IS the tenant. No conversion, no second identifier.
    tenantId: workspaceId,
    organizationId: ctx.organizationId,
    correlationId: ctx.correlationId,
    causationId: ctx.causationId,
    producer: WORKSPACE_PRODUCER,
    occurredAt: ctx.occurredAt,
    payload,
  };
}

export function workspaceCreated(
  ctx: WorkspaceEventContext,
  payload: WorkspaceCreatedPayload,
): DomainEvent<WorkspaceCreatedPayload> {
  return envelope(payload.workspaceId, 'WorkspaceCreated', ctx, payload);
}

export function workspaceSuspended(
  ctx: WorkspaceEventContext,
  payload: WorkspaceSuspendedPayload,
): DomainEvent<WorkspaceSuspendedPayload> {
  return envelope(payload.workspaceId, 'WorkspaceSuspended', ctx, payload);
}

export function workspaceReactivated(
  ctx: WorkspaceEventContext,
  payload: WorkspaceReactivatedPayload,
): DomainEvent<WorkspaceReactivatedPayload> {
  return envelope(payload.workspaceId, 'WorkspaceReactivated', ctx, payload);
}

export function workspaceArchived(
  ctx: WorkspaceEventContext,
  payload: WorkspaceArchivedPayload,
): DomainEvent<WorkspaceArchivedPayload> {
  return envelope(payload.workspaceId, 'WorkspaceArchived', ctx, payload);
}

export function workspaceDeletionRequested(
  ctx: WorkspaceEventContext,
  payload: WorkspaceDeletionRequestedPayload,
): DomainEvent<WorkspaceDeletionRequestedPayload> {
  return envelope(payload.workspaceId, 'WorkspaceDeletionRequested', ctx, payload);
}
