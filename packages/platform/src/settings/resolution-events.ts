/**
 * `SettingsChanged` — the resolver's invalidation announcement.
 *
 * Separate from `events.ts`, which belongs to the workspace settings STORAGE
 * layer and whose `WorkspaceSettingsUpdated` says "this workspace's row was
 * written". This one says something different: "the resolved answer for this
 * scope is no longer what it was". A cache invalidation is not a row update,
 * and conflating them would put a storage concern on an event consumers use to
 * decide whether their view of policy is current.
 *
 * ── Why it is ORGANIZATION-scoped even for a workspace change ───────────────
 * The settings tree is an organization-owned aggregate (ADR-029). A change at
 * the organization layer alters the resolved answer for every workspace beneath
 * it, so an organization change and a workspace change are not independent —
 * applied out of order they leave a consumer holding a resolution that never
 * existed. One aggregate id keeps them ordered against each other.
 *
 * The workspace is carried in the payload as `scopeId`, which is attribution,
 * not tenant scope. A consumer must not rebuild workspace tenant context from
 * it.
 *
 * ── Keys, never values ──────────────────────────────────────────────────────
 * "Payloads carry changed keys and scope, never values" — settings.md
 * §Events and §Security. Settings hold brand voice, gate thresholds and routing
 * policy, and an event reaches consumers with weaker controls than the row
 * does. There is deliberately no field here a value could travel in.
 */

import type { DomainEvent } from '@contentos/contracts';

/** Attribution on DLQ entries and contract ownership. */
export const SETTINGS_PRODUCER = 'platform.settings';

/** One settings tree per organization — see the note above. */
export const SETTINGS_AGGREGATE = 'SettingsTree';

export const SETTINGS_CHANGED = 'SettingsChanged';

export const SETTINGS_EVENT_TYPES = [SETTINGS_CHANGED] as const;

export type SettingsEventType = (typeof SETTINGS_EVENT_TYPES)[number];

export interface SettingsChangedPayload {
  /** Which layer moved. */
  readonly scopeType: 'workspace' | 'organization';
  /** The workspace or organization whose layer moved. Attribution, not scope. */
  readonly scopeId: string;
  readonly organizationId: string;
  /** Names only. There is nowhere to put a value. */
  readonly changedKeys: readonly string[];
  /** The composite layer version after the change. */
  readonly version: string;
}

export interface SettingsResolutionEventContext {
  readonly eventId: string;
  readonly correlationId: string;
  /** Null for a root event — an operator action rather than a reaction. */
  readonly causationId: string | null;
  readonly occurredAt: string;
}

export function settingsChanged(
  ctx: SettingsResolutionEventContext,
  payload: SettingsChangedPayload,
): DomainEvent<SettingsChangedPayload> {
  return {
    eventId: ctx.eventId,
    eventType: SETTINGS_CHANGED,
    eventVersion: 1,
    aggregateType: SETTINGS_AGGREGATE,
    aggregateId: payload.organizationId,
    tenantId: payload.organizationId,
    organizationId: payload.organizationId,
    correlationId: ctx.correlationId,
    causationId: ctx.causationId,
    producer: SETTINGS_PRODUCER,
    occurredAt: ctx.occurredAt,
    payload,
  };
}
