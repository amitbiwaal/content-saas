/**
 * Organization domain events — `02-domain-design/organizations.md` §"Domain
 * Events" and `04-platform/organizations.md` §Events.
 *
 * Payload shapes are transcribed from those tables and are the contract. They
 * carry identifiers and immutable values only: the envelope validator rejects
 * credentials, content, and personal data, because events reach consumers with
 * weaker controls than the source table.
 *
 * Every event here is published through the transactional outbox in the
 * state-changing transaction (ADR-020). This module BUILDS envelopes; it does
 * not publish them, so it needs no database and no event-platform dependency —
 * `packages/platform` and `packages/events` are both feature-tier and may not
 * import each other (`07-development-guide/project-structure.md` rule 4).
 */

import type { DomainEvent } from '@contentos/contracts';

/** Attribution on DLQ entries and contract ownership. */
export const ORGANIZATION_PRODUCER = 'platform.organizations';

/** The aggregate, and therefore the outbox partition/ordering key. */
export const ORGANIZATION_AGGREGATE = 'Organization';

export const ORGANIZATION_EVENT_TYPES = [
  'OrganizationCreated',
  'OrganizationSuspended',
  'OrganizationReactivated',
  'OrganizationClosureRequested',
  'OrganizationClosed',
] as const;

export type OrganizationEventType = (typeof ORGANIZATION_EVENT_TYPES)[number];

export interface OrganizationCreatedPayload {
  readonly organizationId: string;
  readonly name: string;
  readonly slug: string;
  readonly createdBy: string;
}

export interface OrganizationSuspendedPayload {
  readonly organizationId: string;
  readonly reason: string;
  readonly suspendedAt: string;
}

export interface OrganizationReactivatedPayload {
  readonly organizationId: string;
}

export interface OrganizationClosureRequestedPayload {
  readonly organizationId: string;
  readonly purgeAfter: string;
}

export interface OrganizationClosedPayload {
  readonly organizationId: string;
  readonly closedAt: string;
}

export type OrganizationEventPayload =
  | OrganizationCreatedPayload
  | OrganizationSuspendedPayload
  | OrganizationReactivatedPayload
  | OrganizationClosureRequestedPayload
  | OrganizationClosedPayload;

/**
 * The tenant an organization-scoped event is published under.
 *
 * THIS IS A CONVENTION, AND IT IS THE ONE PLACE IT IS DECIDED.
 *
 * The envelope requires a non-null UUID `tenantId`, `outbox_events.tenant_id`
 * is `NOT NULL`, and its RLS policy admits a row only when the column equals
 * `app.tenant_id`. An organization event has no workspace: `OrganizationCreated`
 * is precisely the event a workspace does not yet exist for. The organization's
 * own id is the only UUID in scope at that moment, and using it means every
 * event about an organization lands under one stable partition that a consumer
 * can re-establish context from.
 *
 * ADR-017 says `organizationId` is never the isolation key FOR WORKSPACE-OWNED
 * DATA, where the workspace is the boundary. For the organization aggregate the
 * organization IS the boundary, so this is the tightest correct scope rather
 * than a widening. It is still a convention this module introduces, which is
 * why it is a named function and not an inline expression: when Workspaces land
 * and the platform decides differently, this is the single line that changes.
 */
export function organizationEventTenantId(organizationId: string): string {
  return organizationId;
}

export interface EventContext {
  readonly eventId: string;
  readonly correlationId: string;
  /** Null for a root event — a user-initiated action rather than a reaction. */
  readonly causationId: string | null;
  readonly occurredAt: string;
}

function envelope<T>(
  organizationId: string,
  eventType: OrganizationEventType,
  ctx: EventContext,
  payload: T,
): DomainEvent<T> {
  return {
    eventId: ctx.eventId,
    eventType,
    eventVersion: 1,
    aggregateType: ORGANIZATION_AGGREGATE,
    aggregateId: organizationId,
    tenantId: organizationEventTenantId(organizationId),
    organizationId,
    correlationId: ctx.correlationId,
    causationId: ctx.causationId,
    producer: ORGANIZATION_PRODUCER,
    occurredAt: ctx.occurredAt,
    payload,
  };
}

export function organizationCreated(
  ctx: EventContext,
  payload: OrganizationCreatedPayload,
): DomainEvent<OrganizationCreatedPayload> {
  return envelope(payload.organizationId, 'OrganizationCreated', ctx, payload);
}

export function organizationSuspended(
  ctx: EventContext,
  payload: OrganizationSuspendedPayload,
): DomainEvent<OrganizationSuspendedPayload> {
  return envelope(payload.organizationId, 'OrganizationSuspended', ctx, payload);
}

export function organizationReactivated(
  ctx: EventContext,
  payload: OrganizationReactivatedPayload,
): DomainEvent<OrganizationReactivatedPayload> {
  return envelope(payload.organizationId, 'OrganizationReactivated', ctx, payload);
}

export function organizationClosureRequested(
  ctx: EventContext,
  payload: OrganizationClosureRequestedPayload,
): DomainEvent<OrganizationClosureRequestedPayload> {
  return envelope(payload.organizationId, 'OrganizationClosureRequested', ctx, payload);
}

export function organizationClosed(
  ctx: EventContext,
  payload: OrganizationClosedPayload,
): DomainEvent<OrganizationClosedPayload> {
  return envelope(payload.organizationId, 'OrganizationClosed', ctx, payload);
}
