/**
 * Notification handlers — ORCHESTRATION ONLY.
 *
 * Read the mapping, project the payload, write the record. No decision about
 * whether something is worth notifying about is taken here: that lives in the
 * source-controlled map, which is the whole of it.
 *
 * ── The record is written on the DISPATCHER'S transaction ───────────────────
 * Unlike the cascade and credit-release handlers, these need no port and no
 * second connection. Every event they consume is organization-scoped, and a
 * notification is keyed on the organization too, so the dispatcher's handle
 * already carries the right tenant.
 *
 * That is worth doing rather than merely convenient: the notification and the
 * `processed_events` marker then commit in ONE transaction. Exactly-once is
 * structural — there is no window in which the marker is written and the
 * notification is not, and no retry can produce a second record. The dedupe
 * unique index is the backstop for anything arriving by another path.
 *
 * ── Failing to notify does not fail anything else ───────────────────────────
 * "A notification failure never fails the operation that triggered it." The
 * operation is long committed by the time an event reaches here; what a throw
 * costs is a retry of the delivery of THIS event, which is the correct blast
 * radius.
 */

import type { DomainEvent, TenantContext } from '@contentos/contracts';
import type { GuardExecutor, RegisteredHandler } from '@contentos/events';
import {
  dedupeKeyFor,
  NOTIFIABLE_EVENT_TYPES,
  NOTIFICATIONS_BILLING_GROUP,
  NOTIFICATIONS_PLATFORM_GROUP,
  notificationTypeFor,
  projectPayload,
  type NotificationExecutor,
  type NotificationService,
} from '@contentos/platform';

/**
 * A record that could not be written.
 *
 * Deliberately NOT terminal, so the retry engine classifies it transient. An
 * event that produced no notification is someone not being told.
 */
export const NOTIFICATION_WRITE_FAILED = 'NotificationWriteFailed';

export class NotificationWriteFailedError extends Error {
  readonly code = NOTIFICATION_WRITE_FAILED;

  constructor(eventType: string, eventId: string, cause: unknown) {
    super(
      `Recording a notification for ${eventType} '${eventId}' failed: ${cause instanceof Error ? cause.message : String(cause)}. Retrying re-writes it; the dedupe key makes that a no-op if the first attempt committed.`,
    );
    this.name = 'NotificationWriteFailedError';
  }
}

/** The actor recorded on every notification these handlers drive. */
export const NOTIFICATIONS_ACTOR = { id: 'workers.host.notifications', kind: 'service' as const };

export interface NotificationHandlerDeps {
  readonly notifications: NotificationService;
}

/** Which group reads which stream — the billing thresholds are on `credit`. */
const GROUP_FOR: Readonly<Record<string, string>> = {
  CreditsLow: NOTIFICATIONS_BILLING_GROUP,
  CreditsExhausted: NOTIFICATIONS_BILLING_GROUP,
  SettingsChanged: NOTIFICATIONS_PLATFORM_GROUP,
  FeatureFlagChanged: NOTIFICATIONS_PLATFORM_GROUP,
};

export function createNotificationHandlers(
  deps: NotificationHandlerDeps,
): readonly RegisteredHandler[] {
  function handlerFor(eventType: string): RegisteredHandler {
    const group = GROUP_FOR[eventType];
    if (group === undefined) {
      // Unreachable via NOTIFIABLE_EVENT_TYPES, and a loud failure beats a
      // handler silently registered against no group.
      throw new Error(`No consumer group is declared for notifiable event '${eventType}'.`);
    }

    return {
      eventType,
      version: 1,
      group,
      // Every one of these carries the organization as tenantId (ADR-029),
      // which is also the tenant the notification is keyed on.
      tenantScope: 'organization',
      handle: async (
        event: DomainEvent<unknown>,
        _ctx: TenantContext,
        tx: GuardExecutor,
        _signal: AbortSignal,
      ): Promise<void> => {
        const type = notificationTypeFor(event.eventType);
        if (type === undefined) {
          // The registry validated the subscription at startup, so this means
          // the map and the handler set have diverged.
          throw Object.assign(
            new Error(`Event '${event.eventType}' has no notification class mapped.`),
            { code: 'SchemaViolation' },
          );
        }

        try {
          await deps.notifications.create(tx as NotificationExecutor, {
            organizationId: event.organizationId,
            type,
            payload: projectPayload(
              event.eventType,
              event.payload as Readonly<Record<string, unknown>>,
            ),
            // One event, one notification — and a redelivery converges on it.
            dedupeKey: dedupeKeyFor(type, event.eventId),
            correlationId: event.correlationId,
          });
        } catch (error: unknown) {
          throw new NotificationWriteFailedError(event.eventType, event.eventId, error);
        }
      },
    };
  }

  return NOTIFIABLE_EVENT_TYPES.map((eventType) => handlerFor(eventType));
}
