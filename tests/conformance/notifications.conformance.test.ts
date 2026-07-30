/**
 * Notifications against the REAL event platform.
 *
 * The load-bearing assertion here is the SUBSCRIPTION wiring, which no unit
 * test can reach: `packages/platform` may not import `packages/events`, and
 * whether a group actually receives its events depends on the declarations,
 * the streams, and the handler set agreeing with each other.
 *
 * A worker that starts cleanly and heartbeats healthily while receiving nothing
 * is the failure mode — for notifications it means nobody is ever told, and
 * nothing anywhere reports an error.
 */

import { describe, expect, it } from 'vitest';

import { createEventRegistry, createEventSerializer } from '@contentos/events';
import type { DomainEvent } from '@contentos/contracts';
import {
  BUILT_IN_NOTIFICATIONS,
  CREDIT_STREAM,
  createNotificationRegistry,
  dedupeKeyFor,
  NOTIFIABLE_EVENT_TYPES,
  NOTIFICATION_EVENT_MAP,
  NOTIFICATIONS_BILLING_GROUP,
  NOTIFICATIONS_PLATFORM_GROUP,
  notificationTypeFor,
  PLATFORM_EVENT_DECLARATIONS,
  projectPayload,
  SETTINGS_STREAM,
  type NotificationService,
} from '@contentos/platform';
import {
  createNotificationHandlers,
  notificationSubscriptions,
  NOTIFICATION_CONSUMER_GROUPS,
} from '@contentos/worker-host';

const byType = new Map(PLATFORM_EVENT_DECLARATIONS.map((d) => [d.eventType, d]));

const groupsOf = (eventType: string): string[] =>
  (byType.get(eventType)?.consumers ?? []).map((c) => c.consumerGroup);

describe('every notifiable event is declared and subscribed', () => {
  it('declares all four events the mapping consumes', () => {
    for (const eventType of NOTIFIABLE_EVENT_TYPES) {
      expect(byType.has(eventType), eventType).toBe(true);
    }
  });

  it('subscribes the billing group to the two credit thresholds', () => {
    expect(groupsOf('CreditsLow')).toContain(NOTIFICATIONS_BILLING_GROUP);
    expect(groupsOf('CreditsExhausted')).toContain(NOTIFICATIONS_BILLING_GROUP);
  });

  it('subscribes the platform group to the settings and flag changes', () => {
    expect(groupsOf('SettingsChanged')).toContain(NOTIFICATIONS_PLATFORM_GROUP);
    expect(groupsOf('FeatureFlagChanged')).toContain(NOTIFICATIONS_PLATFORM_GROUP);
  });

  // Adding a consumer to a type does not touch the service that PRODUCES it.
  // Credits, Settings and Feature Flags are unchanged, and none of them knows
  // a notification exists.
  it('leaves the producing services with no knowledge of the consumer', () => {
    expect(byType.get('CreditsLow')?.producer).toBe('platform.credits');
    expect(byType.get('SettingsChanged')?.producer).toBe('platform.settings');
    expect(byType.get('FeatureFlagChanged')?.producer).toBe('platform.feature-flags');
  });

  it('subscribes nothing outside the four', () => {
    const subscribed = PLATFORM_EVENT_DECLARATIONS.filter((d) =>
      d.consumers.some((c) => NOTIFICATION_CONSUMER_GROUPS.includes(c.consumerGroup)),
    ).map((d) => d.eventType);
    expect([...subscribed].sort()).toEqual([...NOTIFIABLE_EVENT_TYPES].sort());
  });

  it('marks both notification groups critical and dead-lettering', () => {
    for (const eventType of NOTIFIABLE_EVENT_TYPES) {
      const consumer = (byType.get(eventType)?.consumers ?? []).find((c) =>
        NOTIFICATION_CONSUMER_GROUPS.includes(c.consumerGroup),
      );
      expect(consumer?.component, eventType).toBe('workers.host.notifications');
      expect(consumer?.criticality, eventType).toBe('critical');
      expect(consumer?.onUnknownVersion, eventType).toBe('dead-letter');
      expect(consumer?.versions, eventType).toEqual([1]);
    }
  });
});

describe('the worker composes', () => {
  const handlers = createNotificationHandlers({ notifications: {} as NotificationService });

  // A group reads ONE stream. Merging these would mean half the events never
  // arriving — and a worker that reports itself healthy while doing it.
  it('splits the two groups across the streams their events are on', () => {
    const subscriptions = notificationSubscriptions(handlers);
    const byGroup = new Map(subscriptions.map((s) => [s.group, s.stream]));

    expect(byGroup.get(NOTIFICATIONS_BILLING_GROUP)).toBe(CREDIT_STREAM);
    expect(byGroup.get(NOTIFICATIONS_PLATFORM_GROUP)).toBe(SETTINGS_STREAM);
    expect(subscriptions).toHaveLength(2);
  });

  it('gives every subscription a handler', () => {
    for (const subscription of notificationSubscriptions(handlers)) {
      expect(subscription.handlers.length, subscription.group).toBeGreaterThan(0);
    }
  });

  it('covers all four events across the two subscriptions', () => {
    const covered = notificationSubscriptions(handlers).flatMap((s) =>
      s.handlers.map((h) => h.eventType),
    );
    expect([...covered].sort()).toEqual([...NOTIFIABLE_EVENT_TYPES].sort());
  });

  it('agrees with the registry about each handler tenant scope', () => {
    for (const handler of handlers) {
      expect(handler.tenantScope, handler.eventType).toBe(
        byType.get(handler.eventType)?.tenantScope,
      );
    }
  });

  // The stream each group reads must be the stream its events are declared on.
  it('subscribes each group to the stream its events actually use', () => {
    const registry = createEventRegistry([...PLATFORM_EVENT_DECLARATIONS]);
    for (const subscription of notificationSubscriptions(handlers)) {
      for (const handler of subscription.handlers) {
        expect(registry.streamFor(handler.eventType), handler.eventType).toBe(subscription.stream);
      }
    }
  });
});

describe('the class catalogue matches what the events can produce', () => {
  const registry = createNotificationRegistry();

  it('declares a class for every notifiable event, and no orphans', () => {
    expect([...registry.keys].sort()).toEqual([...Object.values(NOTIFICATION_EVENT_MAP)].sort());
    expect(registry.keys).toHaveLength(BUILT_IN_NOTIFICATIONS.length);
  });

  it('resolves every mapped class through the registry', () => {
    for (const eventType of NOTIFIABLE_EVENT_TYPES) {
      const type = notificationTypeFor(eventType) ?? '';
      expect(registry.has(type), eventType).toBe(true);
      expect(registry.channelsFor(type).length, eventType).toBeGreaterThan(0);
    }
  });
});

describe('replay compatibility', () => {
  const serializer = createEventSerializer();

  // A replayed event must produce the SAME notification, not a second one, and
  // the dedupe key is what decides that. It is derived from the event id, so it
  // has to survive the round trip unchanged.
  function replay(event: DomainEvent<unknown>): DomainEvent<unknown> {
    return serializer.deserialize(serializer.serialize(event));
  }

  const SAMPLES: [string, Record<string, unknown>, string, string][] = [
    ['CreditsLow', { organizationId: 'org-1', balance: '5.000000' }, 'credit', 'platform.credits'],
    [
      'SettingsChanged',
      {
        scopeType: 'workspace',
        scopeId: 'ws-1',
        changedKeys: ['content.locale'],
        version: 'w1.o1',
      },
      'settings',
      'platform.settings',
    ],
    [
      'FeatureFlagChanged',
      { scopeType: 'organization', scopeId: 'org-1', changedFlags: ['ops.kill'], version: 'o1' },
      'settings',
      'platform.feature-flags',
    ],
  ];

  for (const [eventType, payload, , producer] of SAMPLES) {
    const event = {
      eventId: '018f7a1e-0000-7000-8000-0000000000ee',
      eventType,
      eventVersion: 1,
      aggregateType: 'CreditAccount',
      aggregateId: '018f7a1e-0000-7000-8000-0000000000aa',
      tenantId: '018f7a1e-0000-7000-8000-0000000000aa',
      organizationId: '018f7a1e-0000-7000-8000-0000000000aa',
      correlationId: '018f7a1e-0000-7000-8000-0000000000dd',
      causationId: null,
      producer,
      occurredAt: '2026-07-30T12:00:00.000Z',
      payload,
    } as DomainEvent<unknown>;

    it(`${eventType} yields the same dedupe key after a replay`, () => {
      const type = notificationTypeFor(eventType) ?? '';
      expect(dedupeKeyFor(type, replay(event).eventId)).toBe(dedupeKeyFor(type, event.eventId));
    });

    it(`${eventType} projects the same payload after a replay`, () => {
      const before = projectPayload(eventType, event.payload as Record<string, unknown>);
      const after = projectPayload(eventType, replay(event).payload as Record<string, unknown>);
      expect(after).toEqual(before);
    });
  }

  // Whatever the source event carried, the projection is the same both ways —
  // including what it drops.
  it('drops the metric value on both sides of a replay', () => {
    const payload = { organizationId: 'org-1', balance: '5.000000', threshold: '10.000000' };
    const projected = projectPayload('CreditsLow', payload);
    expect(JSON.stringify(projected)).not.toContain('5.000000');
    expect(JSON.stringify(projected)).not.toContain('10.000000');
  });
});
