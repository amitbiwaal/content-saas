/**
 * Feature flags against the REAL event platform, and against the real Settings
 * Resolver they are built on.
 *
 * Four things a unit test inside `packages/platform` cannot check:
 *
 *   - `FeatureFlagChanged` survives the frozen envelope validator, with the
 *     widest flag list the registry can produce;
 *   - a registry built from the platform's own contribution accepts it, and it
 *     shares the settings aggregate and stream as intended;
 *   - it replays intact — a consumer purging its cache from the stream must get
 *     the same version string back;
 *   - the two registries COMPOSE: the settings registry a real root builds must
 *     declare every flag projection, or every override is invisible.
 */

import { describe, expect, it } from 'vitest';

import { createEventRegistry, createEventSerializer, validateEnvelope } from '@contentos/events';
import type { DomainEvent, EventPublisher, Transaction } from '@contentos/contracts';
import {
  BUILT_IN_FLAGS,
  BUILT_IN_SETTINGS,
  createFeatureFlagRegistry,
  createFeatureFlagResolver,
  createSettingsRegistry,
  createSettingsResolver,
  FEATURE_FLAG_CHANGED,
  FEATURE_FLAG_EVENT_TYPES,
  FEATURE_FLAG_PRODUCER,
  featureFlagChanged,
  PLATFORM_EVENT_DECLARATIONS,
  SETTINGS_AGGREGATE,
  SETTINGS_CHANGED,
  SETTINGS_STREAM,
  settingKeyFor,
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

const event = featureFlagChanged(ctx, {
  scopeType: 'workspace',
  scopeId: WS,
  organizationId: ORG,
  changedFlags: ['knowledge.vector_search', 'publishing.wordpress_connector'],
  version: 'w4.o2',
});

describe('FeatureFlagChanged satisfies the frozen envelope contract', () => {
  it('validates', () => {
    const result = validateEnvelope(event);
    expect(result.ok, JSON.stringify(result)).toBe(true);
  });

  it('validates with every declared flag changed at once', () => {
    const widest = featureFlagChanged(ctx, {
      scopeType: 'organization',
      scopeId: ORG,
      organizationId: ORG,
      changedFlags: BUILT_IN_FLAGS.map((f) => f.key),
      version: 'o9',
    });
    expect(validateEnvelope(widest).ok).toBe(true);
    expect(widest.payload.changedFlags).toHaveLength(BUILT_IN_FLAGS.length);
  });

  // A flag override and a setting live in the same JSONB column and advance the
  // same version. Two aggregates would let a consumer apply them in an order
  // that never happened.
  it('shares the settings aggregate, so the two stay ordered', () => {
    expect(event).toMatchObject({
      eventType: FEATURE_FLAG_CHANGED,
      eventVersion: 1,
      aggregateType: SETTINGS_AGGREGATE,
      aggregateId: ORG,
      tenantId: ORG,
      organizationId: ORG,
      producer: FEATURE_FLAG_PRODUCER,
    });
    expect(event.payload.scopeId).toBe(WS);
  });

  // "The flag set is a roadmap and a probe map for anyone reading it."
  it('carries flag names and no evaluated state', () => {
    const serialized = JSON.stringify(event.payload);
    expect(serialized).toContain('knowledge.vector_search');
    for (const leak of ['enabled', 'true', 'false']) {
      expect(serialized, leak).not.toContain(`"${leak}"`);
    }
  });
});

describe('a real registry accepts it', () => {
  const registry = createEventRegistry([...PLATFORM_EVENT_DECLARATIONS]);

  it('registers and validates', () => {
    expect(registry.isRegistered(FEATURE_FLAG_CHANGED, 1)).toBe(true);
    const result = registry.validate(event);
    expect(result.ok, JSON.stringify(result)).toBe(true);
  });

  // A consumer purging its cache wants both; separate streams would make each
  // read past the other's traffic.
  it('rides the settings stream alongside SettingsChanged', () => {
    for (const eventType of FEATURE_FLAG_EVENT_TYPES) {
      expect(registry.streamFor(eventType), eventType).toBe(SETTINGS_STREAM);
    }
    expect(registry.streamFor(SETTINGS_CHANGED)).toBe(SETTINGS_STREAM);
  });

  it('builds without a collision against everything already declared', () => {
    expect(() => createEventRegistry([...PLATFORM_EVENT_DECLARATIONS])).not.toThrow();
  });

  // T3.8 subscribed the platform notification group; Feature Flags is unchanged
  // by that, and does not know a consumer exists.
  it('is consumed only by the notification group', () => {
    const declaration = PLATFORM_EVENT_DECLARATIONS.find(
      (d) => d.eventType === FEATURE_FLAG_CHANGED,
    );
    expect(declaration?.consumers.map((c) => c.consumerGroup)).toEqual(['notifications-platform']);
    expect(declaration?.tenantScope).toBe('organization');
  });

  // Same aggregate, same stream, DIFFERENT producer: the settings service does
  // not emit flag changes and vice versa.
  it('is attributed to the flags producer, not the settings one', () => {
    const flagDeclaration = PLATFORM_EVENT_DECLARATIONS.find(
      (d) => d.eventType === FEATURE_FLAG_CHANGED,
    );
    const settingsDeclaration = PLATFORM_EVENT_DECLARATIONS.find(
      (d) => d.eventType === SETTINGS_CHANGED,
    );
    expect(flagDeclaration?.producer).toBe(FEATURE_FLAG_PRODUCER);
    expect(flagDeclaration?.producer).not.toBe(settingsDeclaration?.producer);
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

  it('preserves the composite version string exactly', () => {
    const restored = serializer.deserialize(serializer.serialize(event));
    expect((restored.payload as { version: string }).version).toBe('w4.o2');
  });

  it('preserves the changed-flag order', () => {
    const restored = serializer.deserialize(serializer.serialize(event));
    expect((restored.payload as { changedFlags: string[] }).changedFlags).toEqual([
      'knowledge.vector_search',
      'publishing.wordpress_connector',
    ]);
  });
});

describe('the two registries compose, and the resolver emits what is accepted', () => {
  const eventRegistry = createEventRegistry([...PLATFORM_EVENT_DECLARATIONS]);

  /** The composition a real root performs. */
  function compose(options: { platformDefaults?: Record<string, boolean> } = {}) {
    const published: DomainEvent<unknown>[] = [];
    const flags = createFeatureFlagRegistry();
    const settingsRegistry = createSettingsRegistry([
      ...BUILT_IN_SETTINGS,
      ...flags.settingDeclarations(),
    ]);
    const publisher: EventPublisher = {
      publish<T>(_tx: Transaction, e: DomainEvent<T>): Promise<void> {
        published.push(e as DomainEvent<unknown>);
        return Promise.resolve();
      },
    };
    let seq = 0;
    const newEventId = (): string =>
      `018f7a1e-0000-7000-9000-${String((seq += 1)).padStart(12, '0')}`;
    const settings = createSettingsResolver({
      registry: settingsRegistry,
      publisher,
      now: () => new Date('2026-07-30T12:00:00.000Z'),
      newEventId,
    });
    const resolver = createFeatureFlagResolver({
      flags,
      settings,
      settingsRegistry,
      publisher,
      ...(options.platformDefaults === undefined
        ? {}
        : { platformDefaults: options.platformDefaults }),
      now: () => new Date('2026-07-30T12:00:00.000Z'),
      newEventId,
    });

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

    return { flags, settingsRegistry, settings, resolver, published, tx };
  }

  // Every flag must be declared in the settings registry, or its overrides are
  // invisible — including a kill switch someone believes they have thrown.
  it('declares every flag projection in the composed settings registry', () => {
    const { flags, settingsRegistry } = compose();
    for (const key of flags.keys) {
      expect(settingsRegistry.has(settingKeyFor(key)), key).toBe(true);
    }
  });

  it('keeps the flag namespace disjoint from the settings keys', () => {
    const settingsOnly = createSettingsRegistry();
    for (const flag of BUILT_IN_FLAGS) {
      expect(settingsOnly.has(settingKeyFor(flag.key)), flag.key).toBe(false);
    }
  });

  const SCOPES: [string, ResolutionScope][] = [
    ['workspace', { type: 'workspace', workspaceId: WS, organizationId: ORG }],
    ['organization', { type: 'organization', organizationId: ORG }],
  ];

  for (const [label, scope] of SCOPES) {
    it(`the event announceChange publishes for a ${label} scope passes the real registry`, async () => {
      const c = compose();
      await c.resolver.announceChange(c.tx, {
        scope,
        changedFlags: ['knowledge.vector_search'],
        correlationId: CORRELATION,
      });

      const emitted = c.published.find((e) => e.eventType === FEATURE_FLAG_CHANGED);
      expect(emitted).toBeDefined();
      if (emitted === undefined) return;

      const result = eventRegistry.validate(emitted);
      expect(result.ok, JSON.stringify(result)).toBe(true);

      const serializer = createEventSerializer();
      expect(serializer.deserialize(serializer.serialize(emitted))).toEqual(emitted);
    });
  }

  // Both go through one path, so the registry has to accept both.
  it('emits a settings invalidation the registry also accepts', async () => {
    const c = compose();
    await c.resolver.announceChange(c.tx, {
      scope: { type: 'workspace', workspaceId: WS, organizationId: ORG },
      changedFlags: ['knowledge.vector_search'],
      correlationId: CORRELATION,
    });

    expect(c.published.map((e) => e.eventType)).toEqual([SETTINGS_CHANGED, FEATURE_FLAG_CHANGED]);
    for (const emitted of c.published) {
      expect(eventRegistry.validate(emitted).ok, emitted.eventType).toBe(true);
    }
  });

  it('evaluates every built-in flag through the composed stack', async () => {
    const c = compose();
    const snapshot = await c.resolver.evaluateSnapshot(c.tx, {
      type: 'workspace',
      workspaceId: WS,
      organizationId: ORG,
    });
    expect(Object.keys(snapshot.flags).sort()).toEqual(BUILT_IN_FLAGS.map((f) => f.key).sort());
    expect(snapshot.version).toBe('w4.o2');
    for (const flag of BUILT_IN_FLAGS) {
      expect(snapshot.isEnabled(flag.key), flag.key).toBe(flag.defaultValue);
      expect(snapshot.sourceOf(flag.key), flag.key).toBe('built-in');
    }
  });

  it('honours a platform default through the composed stack', async () => {
    const c = compose({ platformDefaults: { 'knowledge.vector_search': true } });
    const result = await c.resolver.evaluate(
      c.tx,
      { type: 'workspace', workspaceId: WS, organizationId: ORG },
      'knowledge.vector_search',
    );
    expect(result.enabled).toBe(true);
    expect(result.source).toBe('platform');
  });
});
