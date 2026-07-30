/**
 * Cascade handlers — ORCHESTRATION ONLY.
 *
 * Every one of these does the same three things: read identifiers off the
 * envelope, call a cascade library that already exists and is already tested,
 * and turn "not finished" into a retryable failure. There is no cascade logic
 * here, and there must not be: the libraries in `packages/platform` decide
 * which workspaces to touch and what to skip.
 *
 * ── Why an incomplete cascade THROWS ────────────────────────────────────────
 * The dispatcher runs the handler inside the transaction that writes the
 * `processed_events` marker. The cascade's own work does NOT run in that
 * transaction — it cannot, because each workspace needs its own tenant context.
 * So the marker is the only thing that transaction commits, and committing it
 * while workspaces remain unprocessed would record the event as handled and
 * suppress every redelivery.
 *
 * Throwing on `complete: false` rolls the marker back, and the retry re-runs
 * the WHOLE cascade. That is the intended shape: the workspaces already done
 * take the library's skip path, so re-running converges instead of repeating.
 *
 * ── Two idempotency layers, neither redundant ───────────────────────────────
 *   `processed_events` stops a REDELIVERY of an event already handled.
 *   The cascade's skip logic stops a RETRY from redoing finished workspaces.
 * The first never runs during a retry, because the marker was rolled back; the
 * second never runs across deliveries, because the marker suppressed them.
 */

import type { DomainEvent, TenantContext } from '@contentos/contracts';
import type { GuardExecutor, RegisteredHandler } from '@contentos/events';
import {
  ORGANIZATION_LIFECYCLE_CASCADE_GROUP,
  ORGANIZATION_MEMBERSHIP_CASCADE_GROUP,
  type MembershipCascade,
  type SuspensionCascade,
} from '@contentos/platform';

/**
 * The failure code for a cascade that did not finish.
 *
 * Deliberately NOT one of `TERMINAL_CODES`, so the retry engine classifies it
 * transient and retries. A partially applied cascade is the definition of
 * something worth trying again.
 */
export const CASCADE_INCOMPLETE = 'CascadeIncomplete';

export class CascadeIncompleteError extends Error {
  readonly code = CASCADE_INCOMPLETE;

  constructor(action: string, organizationId: string, failed: readonly string[]) {
    super(
      `${action} for organization '${organizationId}' left ${String(failed.length)} workspace(s) unprocessed: ${failed.join(', ')}. Retrying re-runs the cascade; finished workspaces skip.`,
    );
    this.name = 'CascadeIncompleteError';
  }
}

/** The actor recorded on every cascade-driven write. */
export const CASCADE_ACTOR = { id: 'workers.host.cascade', kind: 'service' as const };

export interface CascadeHandlerDeps {
  readonly suspension: SuspensionCascade;
  readonly memberships: MembershipCascade;
}

interface RevokedPayload {
  readonly organizationId?: unknown;
  readonly userId?: unknown;
}

function requireString(value: unknown, field: string, eventId: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    // A malformed payload is a contract violation, not a transient fault. The
    // code is terminal so it dead-letters rather than retrying forever.
    throw Object.assign(new Error(`Event '${eventId}' has no '${field}' in its payload.`), {
      code: 'SchemaViolation',
    });
  }
  return value;
}

/**
 * The three handlers, and nothing else subscribes.
 *
 * All are `organization`-scoped: their events carry the organization as
 * `tenantId` (ADR-029), and composition refuses to register them against a
 * workspace-scoped declaration.
 */
export function createCascadeHandlers(deps: CascadeHandlerDeps): readonly RegisteredHandler[] {
  function request(event: DomainEvent<unknown>, organizationId: string) {
    return {
      organizationId,
      actor: CASCADE_ACTOR,
      correlationId: event.correlationId,
      // The cause is the organization decision itself, which is what ties each
      // per-workspace event back to it.
      causationId: event.eventId,
    };
  }

  const lifecycle = (
    eventType: 'OrganizationSuspended' | 'OrganizationReactivated',
  ): RegisteredHandler => ({
    eventType,
    version: 1,
    group: ORGANIZATION_LIFECYCLE_CASCADE_GROUP,
    tenantScope: 'organization',
    handle: async (
      event: DomainEvent<unknown>,
      _ctx: TenantContext,
      _tx: GuardExecutor,
      _signal: AbortSignal,
    ): Promise<void> => {
      const organizationId = event.organizationId;
      const result =
        eventType === 'OrganizationSuspended'
          ? await deps.suspension.suspend(request(event, organizationId))
          : await deps.suspension.reactivate(request(event, organizationId));

      if (!result.complete) {
        throw new CascadeIncompleteError(
          eventType,
          organizationId,
          result.failed.map((f) => f.workspaceId),
        );
      }
    },
  });

  const membershipRevoked: RegisteredHandler = {
    eventType: 'OrgMembershipRevoked',
    version: 1,
    group: ORGANIZATION_MEMBERSHIP_CASCADE_GROUP,
    tenantScope: 'organization',
    handle: async (
      event: DomainEvent<unknown>,
      _ctx: TenantContext,
      _tx: GuardExecutor,
      _signal: AbortSignal,
    ): Promise<void> => {
      const payload = event.payload as RevokedPayload;
      const organizationId = requireString(
        payload.organizationId ?? event.organizationId,
        'organizationId',
        event.eventId,
      );
      const userId = requireString(payload.userId, 'userId', event.eventId);

      const result = await deps.memberships.revokeAcrossWorkspaces({
        ...request(event, organizationId),
        userId,
      });

      if (!result.complete) {
        throw new CascadeIncompleteError(
          'OrgMembershipRevoked',
          organizationId,
          result.failed.map((f) => f.workspaceId),
        );
      }
    },
  };

  return [
    lifecycle('OrganizationSuspended'),
    lifecycle('OrganizationReactivated'),
    membershipRevoked,
  ];
}
