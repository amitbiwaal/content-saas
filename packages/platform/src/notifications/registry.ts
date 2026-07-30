/**
 * The notification class registry — `04-platform/notifications.md`.
 *
 * SOURCE-CONTROLLED, like the settings, flag and event registries. The class
 * catalogue is a contract every producing service reads and no runtime writes.
 *
 * ── This service never decides what is worth notifying about ────────────────
 * "The sharpest boundary: this service never decides what is worth notifying
 *  about. It consumes domain events and maps them to notification classes. A
 *  service that wants a user informed emits its event; it does not call
 *  Notifications directly."
 *
 * So a declaration here is a MAPPING TARGET, not a decision. Every entry exists
 * because some already-declared event maps onto it, and there are exactly as
 * many as this increment consumes — a class no event produces is a class that
 * can never be reached, and would sit in the catalogue looking supported.
 *
 * ── Channel metadata only ───────────────────────────────────────────────────
 * `defaultChannels` says where a class WOULD go. Nothing here dispatches, and
 * there is no adapter behind any of the three names. Per-user preferences, which
 * would narrow these, need `permissions.md` and a preference store; until then
 * the declared defaults are the whole answer.
 */

/** `notifications.md` §"Domain model" — the six categories. */
export const NOTIFICATION_CATEGORIES = [
  'security',
  'billing',
  'workflow',
  'quality',
  'performance',
  'system',
] as const;

export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

/**
 * Priority, using the document's `Severity` vocabulary.
 *
 * The increment names the field `priority`; `notifications.md` names the values
 * `info` / `warning` / `critical`. Inventing a second scale so the two words
 * could each have their own would mean translating between them at every call
 * site, so the field takes the increment's name and the document's values.
 */
export const NOTIFICATION_PRIORITIES = ['info', 'warning', 'critical'] as const;

export type NotificationPriority = (typeof NOTIFICATION_PRIORITIES)[number];

/** Metadata only. No adapter exists behind any of these. */
export const NOTIFICATION_CHANNELS = ['in_app', 'email', 'webhook'] as const;

export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export interface NotificationDeclaration {
  readonly key: string;
  readonly description: string;
  readonly category: NotificationCategory;
  /** Where this class would be delivered. At least one. */
  readonly defaultChannels: readonly NotificationChannel[];
  readonly priority: NotificationPriority;
  /**
   * Classes a user cannot disable — security alerts, billing failures, legal
   * notices. Declared now because it is a property of the CLASS, and the
   * preference API that enforces it must not be free to decide otherwise later.
   */
  readonly mandatory: boolean;
}

export type NotificationErrorCode =
  | 'UnknownNotificationType'
  | 'DuplicateNotificationType'
  | 'InvalidDeclaration'
  | 'NotificationNotFound'
  | 'NotPending';

export class NotificationError extends Error {
  readonly code: NotificationErrorCode;

  constructor(code: NotificationErrorCode, message: string) {
    super(message);
    this.name = 'NotificationError';
    this.code = code;
  }
}

/**
 * The built-in classes — one per event this increment consumes.
 *
 * ── DEVIATION, RECORDED: credits low and exhausted are two classes ──────────
 * `notifications.md` maps both `CreditsLow` and `CreditsExhausted` onto a
 * single `billing.credits_low`, the way it maps two publish failures onto one
 * class "(severity `warning`/`critical`)". A class whose priority depends on
 * which event produced it cannot be DECLARED with a priority, and this registry
 * declares one per key. Two keys keeps the declaration truthful; collapsing
 * them would mean either mis-stating the severity of an exhausted balance or
 * carrying a priority the registry does not own.
 */
export const BUILT_IN_NOTIFICATIONS: readonly NotificationDeclaration[] = [
  {
    key: 'billing.credits_low',
    description:
      'The organization is approaching its credit threshold. Runs still start; the customer needs to know before they stop.',
    category: 'billing',
    defaultChannels: ['in_app', 'email'],
    priority: 'warning',
    // "Mandatory classes cannot be disabled ... billing failures."
    mandatory: true,
  },
  {
    key: 'billing.credits_exhausted',
    description:
      'The organization has no credits left. Every run start is now refused, so this is not something to leave in an inbox.',
    category: 'billing',
    defaultChannels: ['in_app', 'email'],
    priority: 'critical',
    mandatory: true,
  },
  {
    key: 'system.settings_changed',
    description:
      'Effective settings changed for a scope. Carries the changed keys only; the values are behind an authorized read.',
    category: 'system',
    defaultChannels: ['in_app'],
    priority: 'info',
    mandatory: false,
  },
  {
    key: 'system.feature_flag_changed',
    description:
      'A feature flag override changed for a scope. Carries flag names only — the flag set is a roadmap and a probe map.',
    category: 'system',
    defaultChannels: ['in_app'],
    priority: 'info',
    mandatory: false,
  },
];

export interface NotificationRegistry {
  readonly declarations: readonly NotificationDeclaration[];
  readonly keys: readonly string[];
  has(key: string): boolean;
  /** Throws `UnknownNotificationType` rather than returning undefined. */
  require(key: string): NotificationDeclaration;
  find(key: string): NotificationDeclaration | undefined;
  /** Where this class would be delivered. */
  channelsFor(key: string): readonly NotificationChannel[];
}

/**
 * Build a registry, refusing a declaration set that cannot be trusted.
 *
 * "Duplicate keys fail startup" — checked here rather than at first use,
 * because which category and priority apply would otherwise be decided by
 * declaration order, and a mandatory billing alert quietly taking a
 * non-mandatory declaration is not something to find out from a customer.
 */
export function createNotificationRegistry(
  declarations: readonly NotificationDeclaration[] = BUILT_IN_NOTIFICATIONS,
): NotificationRegistry {
  const byKey = new Map<string, NotificationDeclaration>();

  for (const declaration of declarations) {
    if (byKey.has(declaration.key)) {
      throw new NotificationError(
        'DuplicateNotificationType',
        `Notification type '${declaration.key}' is declared twice; which category and priority apply would be decided by declaration order.`,
      );
    }
    if (declaration.key.trim() === '') {
      throw new NotificationError('InvalidDeclaration', 'A notification type must have a key.');
    }
    if (!(NOTIFICATION_CATEGORIES as readonly string[]).includes(declaration.category)) {
      throw new NotificationError(
        'InvalidDeclaration',
        `Notification type '${declaration.key}' declares unknown category '${declaration.category}'.`,
      );
    }
    if (!(NOTIFICATION_PRIORITIES as readonly string[]).includes(declaration.priority)) {
      throw new NotificationError(
        'InvalidDeclaration',
        `Notification type '${declaration.key}' declares unknown priority '${declaration.priority}'.`,
      );
    }
    if (declaration.defaultChannels.length === 0) {
      throw new NotificationError(
        'InvalidDeclaration',
        `Notification type '${declaration.key}' declares no channel; a class that can reach nobody is a class nobody receives.`,
      );
    }
    for (const channel of declaration.defaultChannels) {
      if (!(NOTIFICATION_CHANNELS as readonly string[]).includes(channel)) {
        throw new NotificationError(
          'InvalidDeclaration',
          `Notification type '${declaration.key}' declares unknown channel '${channel}'.`,
        );
      }
    }
    if (new Set(declaration.defaultChannels).size !== declaration.defaultChannels.length) {
      throw new NotificationError(
        'InvalidDeclaration',
        `Notification type '${declaration.key}' lists a channel twice; a duplicate is a second delivery of one message.`,
      );
    }
    if (declaration.description.trim() === '') {
      throw new NotificationError(
        'InvalidDeclaration',
        `Notification type '${declaration.key}' has no description; a class nobody can explain is a class nobody maps an event onto correctly.`,
      );
    }
    byKey.set(declaration.key, declaration);
  }

  const require_ = (key: string): NotificationDeclaration => {
    const declaration = byKey.get(key);
    if (declaration === undefined) {
      throw new NotificationError(
        'UnknownNotificationType',
        `'${key}' is not a declared notification type. Add a registry entry with its category, priority and channels before producing it.`,
      );
    }
    return declaration;
  };

  return {
    declarations: [...declarations],
    keys: [...byKey.keys()],
    has: (key) => byKey.has(key),
    require: require_,
    find: (key) => byKey.get(key),
    channelsFor: (key) => [...require_(key).defaultChannels],
  };
}
