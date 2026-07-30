/**
 * The Settings Resolver against the REAL event platform.
 *
 * Three things a unit test inside `packages/platform` cannot check, because
 * that package may not import `packages/events`:
 *
 *   - `SettingsChanged` survives the frozen envelope validator, including with
 *     the widest changed-key array the registry can produce;
 *   - a registry built from the platform's own contribution accepts it, and
 *     adding it collided with nothing already declared;
 *   - it replays intact — a consumer rebuilding "which policy is current" from
 *     the stream must get the same version string back.
 *
 * The resolver's own behaviour is unit-tested; what is asserted here is that
 * what it PUBLISHES is something the platform will actually carry.
 */

import { describe, expect, it } from 'vitest';

import { createEventRegistry, createEventSerializer, validateEnvelope } from '@contentos/events';
import type { DomainEvent, EventPublisher, Transaction } from '@contentos/contracts';
import {
  BUILT_IN_SETTINGS,
  createSettingsRegistry,
  createSettingsResolver,
  PLATFORM_EVENT_DECLARATIONS,
  SETTINGS_AGGREGATE,
  SETTINGS_CHANGED,
  SETTINGS_EVENT_TYPES,
  SETTINGS_PRODUCER,
  SETTINGS_STREAM,
  settingsChanged,
  type ResolutionScope,
  type SettingsResolutionExecutor,
} from '@contentos/platform';

const ORG = '018f7a1e-0000-7000-8000-0000000000aa';
const WS = '018f7a1e-0000-7000-8000-0000000000bb';
const EVENT_ID = '018f7a1e-0000-7000-8000-0000000000ee';
const CORRELATION = '018f7a1e-0000-7000-8000-0000000000dd';

const ctx = {
  eventId: EVENT_ID,
  correlationId: CORRELATION,
  causationId: null,
  occurredAt: '2026-07-30T12:00:00.000Z',
};

const event = settingsChanged(ctx, {
  scopeType: 'workspace',
  scopeId: WS,
  organizationId: ORG,
  changedKeys: ['content.locale', 'review.approval_required'],
  version: 'w4.o2',
});

describe('SettingsChanged satisfies the frozen envelope contract', () => {
  it('validates', () => {
    const result = validateEnvelope(event);
    expect(result.ok, JSON.stringify(result)).toBe(true);
  });

  // The payload rules cap arrays, so the widest one the registry can produce is
  // the case worth checking rather than the narrowest.
  it('validates with every declared key changed at once', () => {
    const widest = settingsChanged(ctx, {
      scopeType: 'organization',
      scopeId: ORG,
      organizationId: ORG,
      changedKeys: BUILT_IN_SETTINGS.map((s) => s.key),
      version: 'o9',
    });
    const result = validateEnvelope(widest);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(widest.payload.changedKeys).toHaveLength(BUILT_IN_SETTINGS.length);
  });

  // The settings tree is organization-owned (ADR-029): an organization-layer
  // change and a workspace-layer change beneath it are not independent.
  it('carries the organization as tenant and aggregate for a workspace change', () => {
    expect(event).toMatchObject({
      eventType: SETTINGS_CHANGED,
      eventVersion: 1,
      aggregateType: SETTINGS_AGGREGATE,
      aggregateId: ORG,
      tenantId: ORG,
      organizationId: ORG,
      producer: SETTINGS_PRODUCER,
    });
    // The workspace is attribution, in the payload — not the tenant scope.
    expect(event.payload.scopeId).toBe(WS);
  });

  // settings.md §Security: settings can include competitively sensitive
  // configuration, and events reach more consumers than the tables do.
  it('emits key names only, never a value', () => {
    const withSensitive = settingsChanged(ctx, {
      scopeType: 'workspace',
      scopeId: WS,
      organizationId: ORG,
      changedKeys: ['content.locale', 'routing.tier_preferences'],
      version: 'w1.o1',
    });
    const serialized = JSON.stringify(withSensitive.payload);
    expect(serialized).toContain('content.locale');
    for (const value of ['voice-profile-alpha-7731', 'en-GB', 'gpt-4o', '0.850000']) {
      expect(serialized, value).not.toContain(value);
    }
    expect(Object.keys(withSensitive.payload)).not.toContain('values');
  });
});

describe('a real registry accepts it', () => {
  const registry = createEventRegistry([...PLATFORM_EVENT_DECLARATIONS]);

  it('registers and validates', () => {
    expect(registry.isRegistered(SETTINGS_CHANGED, 1)).toBe(true);
    const result = registry.validate(event);
    expect(result.ok, JSON.stringify(result)).toBe(true);
  });

  it('routes it to the settings stream', () => {
    for (const eventType of SETTINGS_EVENT_TYPES) {
      expect(registry.streamFor(eventType), eventType).toBe(SETTINGS_STREAM);
    }
  });

  it('builds without a collision against everything already declared', () => {
    expect(() => createEventRegistry([...PLATFORM_EVENT_DECLARATIONS])).not.toThrow();
  });

  // T3.8 subscribed the platform notification group. The Settings Resolver is
  // unchanged by that: a consumer is declared against the TYPE, and the service
  // that emits it does not know a consumer exists.
  it('is consumed only by the notification group', () => {
    const declaration = PLATFORM_EVENT_DECLARATIONS.find((d) => d.eventType === SETTINGS_CHANGED);
    expect(declaration?.consumers.map((c) => c.consumerGroup)).toEqual(['notifications-platform']);
    expect(declaration?.tenantScope).toBe('organization');
  });
});

describe('replay compatibility', () => {
  const serializer = createEventSerializer();

  it('survives serialize → deserialize unchanged', () => {
    expect(serializer.deserialize(serializer.serialize(event))).toEqual(event);
  });

  it('survives the Redis Streams field encoding', () => {
    expect(serializer.fromStreamFields(serializer.toStreamFields(event))).toEqual(event);
  });

  // A consumer rebuilding "is my policy current?" compares this string. If it
  // does not come back exactly, every consumer re-resolves forever or never.
  it('preserves the composite version string exactly', () => {
    const restored = serializer.deserialize(serializer.serialize(event));
    expect((restored.payload as { version: string }).version).toBe('w4.o2');
  });

  it('preserves the changed-key order', () => {
    const restored = serializer.deserialize(serializer.serialize(event));
    expect((restored.payload as { changedKeys: string[] }).changedKeys).toEqual([
      'content.locale',
      'review.approval_required',
    ]);
  });
});

describe('the resolver emits what the registry accepts', () => {
  const registry = createEventRegistry([...PLATFORM_EVENT_DECLARATIONS]);

  /** Minimal executor: the wiring is under test, not the SQL. */
  function wiring(): { tx: SettingsResolutionExecutor; published: DomainEvent<unknown>[] } {
    const published: DomainEvent<unknown>[] = [];
    const tx = {
      query<T>(sql: string): Promise<readonly T[]> {
        const forWorkspace = sql.includes('FROM workspaces');
        return Promise.resolve([
          forWorkspace
            ? {
                workspaceVersion: 4,
                organizationVersion: 2,
                workspaceSettings: {},
                organizationSettings: {},
              }
            : { organizationVersion: 2, organizationSettings: {} },
        ] as unknown as T[]);
      },
    } as unknown as SettingsResolutionExecutor;
    return { tx, published };
  }

  const SCOPES: [string, ResolutionScope][] = [
    ['workspace', { type: 'workspace', workspaceId: WS, organizationId: ORG }],
    ['organization', { type: 'organization', organizationId: ORG }],
  ];

  for (const [label, scope] of SCOPES) {
    it(`the event invalidate() publishes for a ${label} scope passes the real registry`, async () => {
      const w = wiring();
      const publisher: EventPublisher = {
        publish<T>(_tx: Transaction, published: DomainEvent<T>): Promise<void> {
          w.published.push(published as DomainEvent<unknown>);
          return Promise.resolve();
        },
      };
      const resolver = createSettingsResolver({
        registry: createSettingsRegistry(),
        publisher,
        now: () => new Date('2026-07-30T12:00:00.000Z'),
        newEventId: () => EVENT_ID,
      });

      await resolver.invalidate(w.tx, {
        scope,
        changedKeys: ['content.locale'],
        correlationId: CORRELATION,
      });

      expect(w.published).toHaveLength(1);
      const emitted = w.published[0];
      expect(emitted).toBeDefined();
      if (emitted === undefined) return;

      const result = registry.validate(emitted);
      expect(result.ok, JSON.stringify(result)).toBe(true);
      expect(serializer().deserialize(serializer().serialize(emitted))).toEqual(emitted);
    });
  }

  function serializer() {
    return createEventSerializer();
  }
});
