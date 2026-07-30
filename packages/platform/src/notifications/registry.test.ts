/**
 * The notification class registry and the event mapping.
 *
 * The registry is a catalogue producing services read, so what is tested is
 * that it refuses to be an unreliable one — and that every class it declares is
 * reachable from an event, since a class nothing produces sits in the catalogue
 * looking supported.
 */
import { describe, expect, it } from 'vitest';

import {
  dedupeKeyFor,
  NOTIFIABLE_EVENT_TYPES,
  NOTIFICATION_EVENT_MAP,
  notificationTypeFor,
  projectPayload,
} from './mapping.js';
import {
  BUILT_IN_NOTIFICATIONS,
  createNotificationRegistry,
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_PRIORITIES,
  NotificationError,
  type NotificationDeclaration,
} from './registry.js';

const declaration = (over: Partial<NotificationDeclaration> = {}): NotificationDeclaration => ({
  key: 'system.test',
  description: 'A test class.',
  category: 'system',
  defaultChannels: ['in_app'],
  priority: 'info',
  mandatory: false,
  ...over,
});

describe('the declared vocabulary', () => {
  it('names the six categories notifications.md distinguishes', () => {
    expect([...NOTIFICATION_CATEGORIES].sort()).toEqual([
      'billing',
      'performance',
      'quality',
      'security',
      'system',
      'workflow',
    ]);
  });

  it('names the three priorities', () => {
    expect([...NOTIFICATION_PRIORITIES]).toEqual(['info', 'warning', 'critical']);
  });

  it('names the three channels and no provider', () => {
    expect([...NOTIFICATION_CHANNELS].sort()).toEqual(['email', 'in_app', 'webhook']);
  });
});

describe('the built-in classes', () => {
  const registry = createNotificationRegistry();

  it('builds without complaint', () => {
    expect(registry.keys.length).toBe(BUILT_IN_NOTIFICATIONS.length);
  });

  it('gives every class a description and at least one channel', () => {
    for (const entry of BUILT_IN_NOTIFICATIONS) {
      expect(entry.description.trim(), entry.key).not.toBe('');
      expect(entry.defaultChannels.length, entry.key).toBeGreaterThan(0);
    }
  });

  // A class nothing produces would sit in the catalogue looking supported.
  it('declares exactly the classes the event map produces', () => {
    expect([...registry.keys].sort()).toEqual([...Object.values(NOTIFICATION_EVENT_MAP)].sort());
  });

  // "Mandatory classes cannot be disabled ... billing failures."
  it('marks both billing classes mandatory', () => {
    for (const key of ['billing.credits_low', 'billing.credits_exhausted']) {
      expect(registry.require(key).mandatory, key).toBe(true);
      expect(registry.require(key).category, key).toBe('billing');
    }
  });

  // The deviation from notifications.md, and the reason for it: a class whose
  // priority depends on which event produced it cannot be declared with one.
  it('separates low from exhausted so each can declare its own priority', () => {
    expect(registry.require('billing.credits_low').priority).toBe('warning');
    expect(registry.require('billing.credits_exhausted').priority).toBe('critical');
  });

  it('keeps the platform classes informational and in-app only', () => {
    for (const key of ['system.settings_changed', 'system.feature_flag_changed']) {
      expect(registry.require(key).priority, key).toBe('info');
      expect(registry.channelsFor(key), key).toEqual(['in_app']);
      expect(registry.require(key).mandatory, key).toBe(false);
    }
  });

  it('reports the channels a class would reach', () => {
    expect(registry.channelsFor('billing.credits_low')).toEqual(['in_app', 'email']);
  });
});

describe('an unknown type is refused, never guessed', () => {
  const registry = createNotificationRegistry();

  it('reports it as unknown, naming the type', () => {
    expect(() => registry.require('nope.nothing')).toThrow(NotificationError);
    try {
      registry.require('nope.nothing');
      expect.unreachable('must refuse');
    } catch (error) {
      expect((error as NotificationError).code).toBe('UnknownNotificationType');
      expect((error as NotificationError).message).toContain('nope.nothing');
    }
  });

  it('answers `has` and `find` without throwing', () => {
    expect(registry.has('billing.credits_low')).toBe(true);
    expect(registry.has('nope')).toBe(false);
    expect(registry.find('nope')).toBeUndefined();
  });

  it('refuses to report channels for one', () => {
    expect(() => registry.channelsFor('nope')).toThrow(/not a declared notification type/);
  });
});

describe('the registry refuses a declaration set it cannot be trusted with', () => {
  // "Duplicate keys fail startup" — a mandatory billing alert quietly taking a
  // non-mandatory declaration is not something to find out from a customer.
  it('rejects a duplicate key at construction', () => {
    expect(() => createNotificationRegistry([declaration(), declaration()])).toThrow(
      NotificationError,
    );
    try {
      createNotificationRegistry([declaration(), declaration()]);
      expect.unreachable('must refuse');
    } catch (error) {
      expect((error as NotificationError).code).toBe('DuplicateNotificationType');
    }
  });

  it('rejects an unknown category', () => {
    expect(() =>
      createNotificationRegistry([declaration({ category: 'marketing' as never })]),
    ).toThrow(/unknown category/);
  });

  it('rejects an unknown priority', () => {
    expect(() =>
      createNotificationRegistry([declaration({ priority: 'urgent' as never })]),
    ).toThrow(/unknown priority/);
  });

  it('rejects an unknown channel', () => {
    expect(() =>
      createNotificationRegistry([declaration({ defaultChannels: ['sms' as never] })]),
    ).toThrow(/unknown channel/);
  });

  it('rejects a class that can reach nobody', () => {
    expect(() => createNotificationRegistry([declaration({ defaultChannels: [] })])).toThrow(
      /reach nobody/,
    );
  });

  // A duplicate is a second delivery of one message.
  it('rejects a channel listed twice', () => {
    expect(() =>
      createNotificationRegistry([declaration({ defaultChannels: ['email', 'email'] })]),
    ).toThrow(/lists a channel twice/);
  });

  it('rejects an undescribed class', () => {
    expect(() => createNotificationRegistry([declaration({ description: ' ' })])).toThrow(
      /nobody can explain/,
    );
  });

  it('rejects an empty key', () => {
    expect(() => createNotificationRegistry([declaration({ key: '  ' })])).toThrow(
      /must have a key/,
    );
  });
});

describe('the event mapping', () => {
  it('maps exactly the four events this increment consumes', () => {
    expect([...NOTIFIABLE_EVENT_TYPES].sort()).toEqual([
      'CreditsExhausted',
      'CreditsLow',
      'FeatureFlagChanged',
      'SettingsChanged',
    ]);
  });

  it('maps every event onto a declared class', () => {
    const registry = createNotificationRegistry();
    for (const eventType of NOTIFIABLE_EVENT_TYPES) {
      const type = notificationTypeFor(eventType);
      expect(type, eventType).toBeDefined();
      expect(registry.has(type ?? ''), eventType).toBe(true);
    }
  });

  it('returns undefined for an event it does not map', () => {
    expect(notificationTypeFor('OrganizationSuspended')).toBeUndefined();
  });

  // The event id alone would be enough while each event maps to one class, and
  // would silently collide the day one maps to two.
  it('builds a dedupe key from the class and the event', () => {
    expect(dedupeKeyFor('billing.credits_low', 'event-1')).toBe('billing.credits_low:event-1');
    expect(dedupeKeyFor('billing.credits_low', 'event-1')).not.toBe(
      dedupeKeyFor('billing.credits_exhausted', 'event-1'),
    );
  });
});

describe('payload projection carries identifiers, never values', () => {
  // "Payloads carry identifiers and short scalars only — never ... metric
  // values." A credit balance is a metric value.
  it('drops the balance and the threshold from a credit notification', () => {
    const projected = projectPayload('CreditsLow', {
      organizationId: 'org-1',
      balance: '5.000000',
      threshold: '10.000000',
      previousState: 'ok',
    });
    expect(projected).toEqual({ organizationId: 'org-1', previousState: 'ok' });
    expect(JSON.stringify(projected)).not.toContain('5.000000');
    expect(JSON.stringify(projected)).not.toContain('10.000000');
  });

  it('does the same for an exhausted balance', () => {
    const projected = projectPayload('CreditsExhausted', {
      organizationId: 'org-1',
      balance: '0.000000',
      threshold: '10.000000',
      previousState: 'low',
    });
    expect(Object.keys(projected).sort()).toEqual(['organizationId', 'previousState']);
  });

  // Key and flag NAMES are identifiers; the source events are already
  // keys-never-values, so forwarding a name discloses nothing new.
  it('carries changed settings keys through', () => {
    const projected = projectPayload('SettingsChanged', {
      scopeType: 'workspace',
      scopeId: 'ws-1',
      changedKeys: ['content.locale'],
      version: 'w1.o1',
    });
    expect(projected).toEqual({
      scopeType: 'workspace',
      scopeId: 'ws-1',
      changedKeys: ['content.locale'],
    });
  });

  it('carries changed flag names through', () => {
    const projected = projectPayload('FeatureFlagChanged', {
      scopeType: 'organization',
      scopeId: 'org-1',
      changedFlags: ['knowledge.vector_search'],
      version: 'o1',
    });
    expect(projected).toEqual({
      scopeType: 'organization',
      scopeId: 'org-1',
      changedFlags: ['knowledge.vector_search'],
    });
  });

  // Written out field by field, so a field added upstream cannot start
  // appearing in a notification that reaches more consumers than the row does.
  it('drops a field the projection does not name', () => {
    const projected = projectPayload('SettingsChanged', {
      scopeType: 'workspace',
      scopeId: 'ws-1',
      changedKeys: ['content.locale'],
      secretlyAdded: 'competitively-sensitive-7731',
    });
    expect(JSON.stringify(projected)).not.toContain('competitively-sensitive-7731');
  });

  it('drops a malformed field rather than carrying it', () => {
    const projected = projectPayload('SettingsChanged', {
      scopeType: 42,
      scopeId: 'ws-1',
      changedKeys: ['ok', 7],
    });
    expect(projected).toEqual({ scopeId: 'ws-1' });
  });

  // A mapping gap must not dead-letter an event.
  it('returns an empty payload for an unmapped event', () => {
    expect(projectPayload('SomethingElse', { a: 1 })).toEqual({});
  });
});
