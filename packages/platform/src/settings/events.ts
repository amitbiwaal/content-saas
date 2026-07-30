/**
 * `WorkspaceSettingsUpdated` — `02-domain-design/workspace.md` §"Domain Events".
 *
 * Payload: `{ workspaceId, changedKeys[], changedBy }` — "**values excluded**,
 * keys only".
 *
 * That exclusion is a security control, not tidiness. Settings hold brand
 * voice, gate thresholds and routing policy, which `04-platform/workspaces.md`
 * §Security calls "competitively sensitive configuration", and an event reaches
 * notification channels and webhook subscribers with weaker controls than the
 * row does. The payload type below has no field a value could travel in, so
 * leaking one is not an oversight anyone can make here — it is unrepresentable.
 *
 * This event lives outside `workspaces/events.ts` because that module is frozen
 * for this increment; it is otherwise an ordinary workspace event and carries
 * the workspace as its tenant.
 */

import type { DomainEvent } from '@contentos/contracts';

import { WORKSPACE_AGGREGATE, WORKSPACE_PRODUCER } from '../workspaces/events.js';

export const WORKSPACE_SETTINGS_UPDATED = 'WorkspaceSettingsUpdated';

export interface WorkspaceSettingsUpdatedPayload {
  readonly workspaceId: string;
  /** Names only. There is deliberately nowhere to put a value. */
  readonly changedKeys: readonly string[];
  readonly changedBy: string;
}

export interface SettingsEventContext {
  readonly eventId: string;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly occurredAt: string;
  readonly organizationId: string;
}

export function workspaceSettingsUpdated(
  ctx: SettingsEventContext,
  payload: WorkspaceSettingsUpdatedPayload,
): DomainEvent<WorkspaceSettingsUpdatedPayload> {
  return {
    eventId: ctx.eventId,
    eventType: WORKSPACE_SETTINGS_UPDATED,
    eventVersion: 1,
    aggregateType: WORKSPACE_AGGREGATE,
    aggregateId: payload.workspaceId,
    // The workspace IS the tenant (ADR-017).
    tenantId: payload.workspaceId,
    organizationId: ctx.organizationId,
    correlationId: ctx.correlationId,
    causationId: ctx.causationId,
    producer: WORKSPACE_PRODUCER,
    occurredAt: ctx.occurredAt,
    payload,
  };
}
