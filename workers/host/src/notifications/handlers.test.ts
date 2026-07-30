/**
 * The notification handlers.
 *
 * Two properties carry this file: the record is written on the DISPATCHER'S
 * transaction — which is what makes exactly-once structural rather than
 * arranged — and the payload that reaches it has been projected, not forwarded.
 */
import { describe, expect, it } from 'vitest';

import type { DomainEvent } from '@contentos/contracts';
import type { GuardExecutor } from '@contentos/events';
import {
  NOTIFIABLE_EVENT_TYPES,
  NOTIFICATIONS_BILLING_GROUP,
  NOTIFICATIONS_PLATFORM_GROUP,
  type CreateNotificationCommand,
  type CreateNotificationResult,
  type NotificationExecutor,
  type NotificationService,
} from '@contentos/platform';

import { createNotificationHandlers, NotificationWriteFailedError } from './handlers.js';

const ORG = '018f7a1e-0000-7000-8000-0000000000aa';
const WS = '018f7a1e-0000-7000-8000-0000000000bb';
const EVENT_ID = '018f7a1e-0000-7000-8000-0000000000ee';
const CORRELATION = '018f7a1e-0000-7000-8000-0000000000dd';

interface Recorded {
  readonly commands: CreateNotificationCommand[];
  readonly executors: unknown[];
}

function harness(options: { fail?: Error } = {}) {
  const recorded: Recorded = { commands: [], executors: [] };

  const notifications = {
    create(tx: NotificationExecutor, command: CreateNotificationCommand) {
      recorded.executors.push(tx);
      recorded.commands.push(command);
      if (options.fail !== undefined) return Promise.reject(options.fail);
      return Promise.resolve({
        created: true,
        notification: { id: 'n1' },
      } as unknown as CreateNotificationResult);
    },
  } as unknown as NotificationService;

  return { handlers: createNotificationHandlers({ notifications }), recorded };
}

function event(
  eventType: string,
  payload: Record<string, unknown>,
  over: Partial<DomainEvent<unknown>> = {},
): DomainEvent<unknown> {
  return {
    eventId: EVENT_ID,
    eventType,
    eventVersion: 1,
    aggregateType: 'CreditAccount',
    aggregateId: ORG,
    tenantId: ORG,
    organizationId: ORG,
    correlationId: CORRELATION,
    causationId: null,
    producer: 'platform.credits',
    occurredAt: '2026-07-30T12:00:00.000Z',
    payload,
    ...over,
  } as DomainEvent<unknown>;
}

const GUARD_TX = { query: () => Promise.resolve([]) } as unknown as GuardExecutor;

async function run(
  handlers: ReturnType<typeof harness>['handlers'],
  e: DomainEvent<unknown>,
  tx: GuardExecutor = GUARD_TX,
): Promise<void> {
  const handler = handlers.find((h) => h.eventType === e.eventType);
  expect(handler, e.eventType).toBeDefined();
  if (handler === undefined) return;
  await handler.handle(
    e,
    { tenantId: e.tenantId, organizationId: e.organizationId, source: 'event' },
    tx,
    new AbortController().signal,
  );
}

describe('the handler set matches the mapping', () => {
  it('handles exactly the four notifiable events', () => {
    const { handlers } = harness();
    expect(handlers.map((h) => h.eventType).sort()).toEqual([...NOTIFIABLE_EVENT_TYPES].sort());
  });

  // The billing thresholds are declared on `credit`; the rest on `settings`.
  // A group reads one stream, so the split is not optional.
  it('puts the billing thresholds in one group and the platform changes in another', () => {
    const { handlers } = harness();
    const groups = new Map(handlers.map((h) => [h.eventType, h.group]));
    expect(groups.get('CreditsLow')).toBe(NOTIFICATIONS_BILLING_GROUP);
    expect(groups.get('CreditsExhausted')).toBe(NOTIFICATIONS_BILLING_GROUP);
    expect(groups.get('SettingsChanged')).toBe(NOTIFICATIONS_PLATFORM_GROUP);
    expect(groups.get('FeatureFlagChanged')).toBe(NOTIFICATIONS_PLATFORM_GROUP);
  });

  // Composition refuses a handler whose scope disagrees with the declaration.
  it('declares every handler organization-scoped, as the events are', () => {
    const { handlers } = harness();
    for (const handler of handlers) {
      expect(handler.tenantScope, handler.eventType).toBe('organization');
      expect(handler.version, handler.eventType).toBe(1);
    }
  });
});

describe('each event produces its mapped class', () => {
  const CASES: [string, Record<string, unknown>, string][] = [
    ['CreditsLow', { organizationId: ORG, balance: '5.000000' }, 'billing.credits_low'],
    ['CreditsExhausted', { organizationId: ORG, balance: '0.000000' }, 'billing.credits_exhausted'],
    [
      'SettingsChanged',
      { scopeType: 'workspace', scopeId: WS, changedKeys: ['content.locale'] },
      'system.settings_changed',
    ],
    [
      'FeatureFlagChanged',
      { scopeType: 'workspace', scopeId: WS, changedFlags: ['knowledge.vector_search'] },
      'system.feature_flag_changed',
    ],
  ];

  for (const [eventType, payload, expected] of CASES) {
    it(`${eventType} produces ${expected}`, async () => {
      const { handlers, recorded } = harness();
      await run(handlers, event(eventType, payload));

      expect(recorded.commands).toHaveLength(1);
      expect(recorded.commands[0]).toMatchObject({
        organizationId: ORG,
        type: expected,
        dedupeKey: `${expected}:${EVENT_ID}`,
        correlationId: CORRELATION,
      });
    });
  }
});

describe('the record is written on the dispatcher transaction', () => {
  // Not a convenience: the notification and the `processed_events` marker then
  // commit together, so exactly-once is structural. A port would open a second
  // transaction and give that up.
  it('passes the handle it was given, opening no connection of its own', async () => {
    const { handlers, recorded } = harness();
    const tx = { query: () => Promise.resolve([]) } as unknown as GuardExecutor;
    await run(handlers, event('CreditsLow', { organizationId: ORG }), tx);
    expect(recorded.executors).toEqual([tx]);
  });
});

describe('the payload is projected, never forwarded', () => {
  // "Payloads carry identifiers and short scalars only — never metric values."
  it('drops the credit balance', async () => {
    const { handlers, recorded } = harness();
    await run(
      handlers,
      event('CreditsLow', {
        organizationId: ORG,
        balance: '5.000000',
        threshold: '10.000000',
        previousState: 'ok',
      }),
    );
    const payload = recorded.commands[0]?.payload ?? {};
    expect(payload).toEqual({ organizationId: ORG, previousState: 'ok' });
    expect(JSON.stringify(payload)).not.toContain('5.000000');
  });

  it('carries changed key names through', async () => {
    const { handlers, recorded } = harness();
    await run(
      handlers,
      event('SettingsChanged', {
        scopeType: 'workspace',
        scopeId: WS,
        changedKeys: ['content.locale'],
        version: 'w1.o1',
      }),
    );
    expect(recorded.commands[0]?.payload).toEqual({
      scopeType: 'workspace',
      scopeId: WS,
      changedKeys: ['content.locale'],
    });
  });

  it('drops a field the projection does not name', async () => {
    const { handlers, recorded } = harness();
    await run(
      handlers,
      event('FeatureFlagChanged', {
        scopeType: 'organization',
        scopeId: ORG,
        changedFlags: ['ops.kill'],
        secretlyAdded: 'sensitive-7731',
      }),
    );
    expect(JSON.stringify(recorded.commands[0]?.payload)).not.toContain('sensitive-7731');
  });
});

describe('one event produces one notification', () => {
  it('derives the dedupe key from the class and the event id', async () => {
    const { handlers, recorded } = harness();
    await run(handlers, event('CreditsLow', { organizationId: ORG }));
    expect(recorded.commands[0]?.dedupeKey).toBe(`billing.credits_low:${EVENT_ID}`);
  });

  it('gives two different events two different keys', async () => {
    const { handlers, recorded } = harness();
    await run(handlers, event('CreditsLow', {}, { eventId: 'e1' }));
    await run(handlers, event('CreditsLow', {}, { eventId: 'e2' }));
    expect(recorded.commands[0]?.dedupeKey).not.toBe(recorded.commands[1]?.dedupeKey);
  });
});

describe('a failed write retries rather than dead-letters', () => {
  // An event that produced no notification is someone not being told.
  it('wraps the cause in a transient failure', async () => {
    const { handlers } = harness({ fail: new Error('connection reset') });
    await expect(run(handlers, event('CreditsLow', { organizationId: ORG }))).rejects.toThrow(
      NotificationWriteFailedError,
    );
  });

  it('names the event, its id and the underlying cause', async () => {
    const { handlers } = harness({ fail: new Error('connection reset') });
    try {
      await run(handlers, event('CreditsLow', { organizationId: ORG }));
      expect.unreachable('must fail');
    } catch (error) {
      const e = error as NotificationWriteFailedError;
      expect(e.code).toBe('NotificationWriteFailed');
      expect(e.message).toContain('CreditsLow');
      expect(e.message).toContain(EVENT_ID);
      expect(e.message).toContain('connection reset');
    }
  });

  // Not one of the terminal codes, so the retry engine classifies it transient.
  it('uses a code that is not terminal', async () => {
    const { handlers } = harness({ fail: new Error('boom') });
    try {
      await run(handlers, event('CreditsLow', {}));
      expect.unreachable('must fail');
    } catch (error) {
      expect((error as NotificationWriteFailedError).code).toBe('NotificationWriteFailed');
      expect(['SchemaViolation', 'UnknownEventType']).not.toContain(
        (error as NotificationWriteFailedError).code,
      );
    }
  });
});
