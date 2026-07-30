/**
 * Credit hold-release handlers — ORCHESTRATION ONLY.
 *
 * Both do the same three things: read identifiers off the envelope, call the
 * Credits Service, and turn "nothing happened when something should have" into
 * a retryable failure. No hold logic here, and none duplicated: the service
 * decides which holds close and publishes the events.
 *
 * ── Why releasing is safe to repeat ─────────────────────────────────────────
 * `releaseOpenHolds` is a single guarded UPDATE — `state = 'held'` in the
 * predicate. A redelivery matches nothing and releases nothing, so the second
 * run is a no-op rather than a second release. That is what lets the handler
 * retry freely without a compensating path.
 *
 * ── Two idempotency layers, neither redundant ───────────────────────────────
 *   `processed_events` stops a REDELIVERY of an event already handled.
 *   The `state = 'held'` predicate stops a RETRY from re-releasing.
 * The first never runs during a retry, because the marker was rolled back; the
 * second never runs across deliveries, because the marker suppressed them.
 *
 * ── An organization suspension and a workspace suspension are not the same ──
 * The organization one releases every open hold under the account. The
 * workspace one releases only that workspace's, because the rest of the
 * organization is still running.
 */

import type { DomainEvent, TenantContext } from '@contentos/contracts';
import type { GuardExecutor, RegisteredHandler } from '@contentos/events';
import {
  CREDITS_ORGANIZATION_RELEASE_GROUP,
  CREDITS_WORKSPACE_RELEASE_GROUP,
  type CreditsService,
} from '@contentos/platform';

import type { CreditsRunner } from './ports.js';

/**
 * A release that could not be completed.
 *
 * Deliberately NOT terminal, so the retry engine classifies it transient. A
 * suspended customer with credits still reserved is worth trying again.
 */
export const HOLD_RELEASE_FAILED = 'HoldReleaseFailed';

export class HoldReleaseFailedError extends Error {
  readonly code = HOLD_RELEASE_FAILED;

  constructor(scope: string, id: string, cause: unknown) {
    super(
      `Releasing credit holds for ${scope} '${id}' failed: ${cause instanceof Error ? cause.message : String(cause)}. Retrying re-runs the release; already-released holds are skipped by the state predicate.`,
    );
    this.name = 'HoldReleaseFailedError';
  }
}

/** The actor recorded on every release these handlers drive. */
export const CREDITS_ACTOR = { id: 'workers.host.credits', kind: 'service' as const };

export interface CreditsHandlerDeps {
  readonly credits: CreditsService;
  readonly runner: CreditsRunner;
}

interface SuspendedPayload {
  readonly workspaceId?: unknown;
  readonly organizationId?: unknown;
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

export function createCreditsHandlers(deps: CreditsHandlerDeps): readonly RegisteredHandler[] {
  /**
   * Release, on an organization-scoped transaction of its own.
   *
   * Not the dispatcher's handle: that one carries the EVENT's tenant, which for
   * a workspace suspension is the workspace — and holds are keyed by
   * organization. Running there would match no rows and report success.
   */
  async function release(
    organizationId: string,
    workspaceId: string | null,
    event: DomainEvent<unknown>,
    scope: string,
    scopeId: string,
  ): Promise<void> {
    try {
      await deps.runner.withOrganization(organizationId, (tx) =>
        deps.credits.releaseOpenHolds(tx, {
          organizationId,
          workspaceId,
          cause: 'suspended',
          correlationId: event.correlationId,
          // The cause is the suspension decision itself, which is what ties
          // each release back to it.
          causationId: event.eventId,
        }),
      );
    } catch (error: unknown) {
      throw new HoldReleaseFailedError(scope, scopeId, error);
    }
  }

  const organizationSuspended: RegisteredHandler = {
    eventType: 'OrganizationSuspended',
    version: 1,
    group: CREDITS_ORGANIZATION_RELEASE_GROUP,
    // The event carries the organization as tenantId (ADR-029).
    tenantScope: 'organization',
    handle: async (
      event: DomainEvent<unknown>,
      _ctx: TenantContext,
      _tx: GuardExecutor,
      _signal: AbortSignal,
    ): Promise<void> => {
      const organizationId = event.organizationId;
      // Every open hold under the account: no workspace filter.
      await release(organizationId, null, event, 'organization', organizationId);
    },
  };

  const workspaceSuspended: RegisteredHandler = {
    eventType: 'WorkspaceSuspended',
    version: 1,
    group: CREDITS_WORKSPACE_RELEASE_GROUP,
    // `workspaces.id` IS `tenant_id` (ADR-017), so this one is workspace-scoped
    // even though the work it does is organization-scoped.
    tenantScope: 'workspace',
    handle: async (
      event: DomainEvent<unknown>,
      _ctx: TenantContext,
      _tx: GuardExecutor,
      _signal: AbortSignal,
    ): Promise<void> => {
      const payload = event.payload as SuspendedPayload;
      const workspaceId = requireString(
        payload.workspaceId ?? event.tenantId,
        'workspaceId',
        event.eventId,
      );
      // The envelope's organization, not the payload's: the tenant of the
      // holds is decided by the account the workspace belongs to.
      const organizationId = requireString(event.organizationId, 'organizationId', event.eventId);
      await release(organizationId, workspaceId, event, 'workspace', workspaceId);
    },
  };

  return [organizationSuspended, workspaceSuspended];
}
