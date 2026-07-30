/**
 * Event → notification class mapping — `04-platform/notifications.md` §Events.
 *
 * "This service never decides what is worth notifying about. It consumes
 *  domain events and maps them to notification classes."
 *
 * The map is the whole of that decision, in one source-controlled place, so
 * "which events produce a notification?" is answerable by reading a list rather
 * than by grepping handlers.
 *
 * ── What a payload may carry ────────────────────────────────────────────────
 * "Payloads carry identifiers and short scalars only — never article content,
 *  evidence text, metric values, or settings values. A notification says 'the
 *  quality gate blocked article X with 3 issues'; the detail is behind a link
 *  requiring authorization."
 *
 * That rules out a credit BALANCE, which is a metric value: a `CreditsLow`
 * notification names the organization and the state it moved into, and the
 * figure is behind an authorized read. Changed key and flag NAMES are carried,
 * because the events that supply them are already keys-never-values by
 * construction — forwarding a name discloses nothing the source event did not.
 *
 * Each projection is written out rather than spreading the source payload, so
 * a field added to an event upstream cannot silently start appearing in a
 * notification that reaches more consumers than the row does.
 */

/** The events this increment consumes, and the class each produces. */
export const NOTIFICATION_EVENT_MAP: Readonly<Record<string, string>> = {
  CreditsLow: 'billing.credits_low',
  CreditsExhausted: 'billing.credits_exhausted',
  SettingsChanged: 'system.settings_changed',
  FeatureFlagChanged: 'system.feature_flag_changed',
};

export const NOTIFIABLE_EVENT_TYPES: readonly string[] = Object.keys(NOTIFICATION_EVENT_MAP);

export function notificationTypeFor(eventType: string): string | undefined {
  return NOTIFICATION_EVENT_MAP[eventType];
}

/**
 * The dedupe key for an event-produced notification.
 *
 * `type:eventId`. The event id alone would be enough while each event maps to
 * one class, and would silently collide the day one maps to two.
 */
export function dedupeKeyFor(notificationType: string, eventId: string): string {
  return `${notificationType}:${eventId}`;
}

/** Narrow an unknown payload field to a string, or drop it. */
function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Narrow an unknown payload field to an array of strings, or drop it. */
function strings(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.every((v): v is string => typeof v === 'string') ? value : undefined;
}

/**
 * Project a source event's payload onto a notification payload.
 *
 * Unknown event types produce an empty payload rather than throwing: the caller
 * has already looked the type up in the map, and a projection that failed
 * closed here would turn a mapping gap into a dead-lettered event.
 */
export function projectPayload(
  eventType: string,
  payload: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  switch (eventType) {
    case 'CreditsLow':
    case 'CreditsExhausted': {
      // Deliberately NOT `balance` or `threshold` — both are metric values.
      const projected: Record<string, unknown> = {};
      const organizationId = str(payload['organizationId']);
      const previousState = str(payload['previousState']);
      if (organizationId !== undefined) projected['organizationId'] = organizationId;
      if (previousState !== undefined) projected['previousState'] = previousState;
      return projected;
    }
    case 'SettingsChanged': {
      const projected: Record<string, unknown> = {};
      const scopeType = str(payload['scopeType']);
      const scopeId = str(payload['scopeId']);
      const changedKeys = strings(payload['changedKeys']);
      if (scopeType !== undefined) projected['scopeType'] = scopeType;
      if (scopeId !== undefined) projected['scopeId'] = scopeId;
      if (changedKeys !== undefined) projected['changedKeys'] = [...changedKeys];
      return projected;
    }
    case 'FeatureFlagChanged': {
      const projected: Record<string, unknown> = {};
      const scopeType = str(payload['scopeType']);
      const scopeId = str(payload['scopeId']);
      const changedFlags = strings(payload['changedFlags']);
      if (scopeType !== undefined) projected['scopeType'] = scopeType;
      if (scopeId !== undefined) projected['scopeId'] = scopeId;
      if (changedFlags !== undefined) projected['changedFlags'] = [...changedFlags];
      return projected;
    }
    default:
      return {};
  }
}
