/**
 * The Feature Flag Resolver.
 *
 * Wired over the REAL Settings Resolver, not a stand-in for it — the whole
 * design claim is that flags reuse that machinery, and a fake settings resolver
 * would test the claim away. The fake below is the two layer tables and their
 * `version` columns, which is what the settings resolver reads.
 *
 * Four properties carry this file: the hierarchy evaluates in the declared
 * order, a scope a flag forbids is ignored rather than honoured, the cache is
 * the settings resolver's own, and a snapshot cannot be altered by a holder.
 */
import { describe, expect, it } from 'vitest';

import type { DomainEvent, EventPublisher, Transaction } from '@contentos/contracts';

import {
  createFeatureFlagRegistry,
  FeatureFlagError,
  settingKeyFor,
  type FeatureFlagDeclaration,
} from './registry.js';
import { createFeatureFlagResolver, type FeatureFlagResolver } from './resolver.js';
import { BUILT_IN_SETTINGS, createSettingsRegistry } from '../settings/registry.js';
import {
  createSettingsResolver,
  type ResolutionScope,
  type SettingsResolutionExecutor,
  type SettingsResolver,
} from '../settings/resolver.js';

const ORG = '018f7a1e-0000-7000-8000-0000000000aa';
const WS = '018f7a1e-0000-7000-8000-0000000000bb';
const CORRELATION = '018f7a1e-0000-7000-8000-0000000000dd';
const NOW = new Date('2026-07-30T12:00:00.000Z');

const workspaceScope: ResolutionScope = {
  type: 'workspace',
  workspaceId: WS,
  organizationId: ORG,
};
const organizationScope: ResolutionScope = { type: 'organization', organizationId: ORG };

/** Three flags, one per scope, so precedence and scope are both exercisable. */
const FLAGS: readonly FeatureFlagDeclaration[] = [
  {
    key: 'release.wide',
    description: 'A workspace-scoped release flag.',
    defaultValue: false,
    scope: 'workspace',
    owner: 'engineering',
    kind: 'release',
  },
  {
    key: 'plan.gated',
    description: 'An organization-scoped entitlement.',
    defaultValue: false,
    scope: 'organization',
    owner: 'platform.billing',
    kind: 'entitlement',
  },
  {
    key: 'ops.kill_switch',
    description: 'A platform-scoped kill switch.',
    defaultValue: true,
    scope: 'platform',
    owner: 'on-call',
    kind: 'operational',
  },
];

interface Layers {
  workspace: Record<string, unknown>;
  organization: Record<string, unknown>;
  workspaceVersion: number;
  organizationVersion: number;
}

interface Rig {
  readonly tx: SettingsResolutionExecutor;
  readonly resolver: FeatureFlagResolver;
  readonly settings: SettingsResolver;
  readonly layers: Layers;
  readonly published: DomainEvent<unknown>[];
}

function rig(
  options: {
    workspace?: Record<string, unknown>;
    organization?: Record<string, unknown>;
    platformDefaults?: Record<string, boolean>;
    flags?: readonly FeatureFlagDeclaration[];
  } = {},
): Rig {
  const layers: Layers = {
    workspace: options.workspace ?? {},
    organization: options.organization ?? {},
    workspaceVersion: 1,
    organizationVersion: 1,
  };
  const published: DomainEvent<unknown>[] = [];

  const tx = {
    query<T>(sql: string): Promise<readonly T[]> {
      const forWorkspace = sql.includes('FROM workspaces');
      const loading = sql.includes('settings');
      const versions = forWorkspace
        ? {
            workspaceVersion: layers.workspaceVersion,
            organizationVersion: layers.organizationVersion,
          }
        : { organizationVersion: layers.organizationVersion };
      if (!loading) return Promise.resolve([versions] as unknown as T[]);
      return Promise.resolve([
        {
          ...versions,
          ...(forWorkspace ? { workspaceSettings: layers.workspace } : {}),
          organizationSettings: layers.organization,
        },
      ] as unknown as T[]);
    },
  } as unknown as SettingsResolutionExecutor;

  const publisher: EventPublisher = {
    publish<T>(_tx: Transaction, event: DomainEvent<T>): Promise<void> {
      published.push(event as DomainEvent<unknown>);
      return Promise.resolve();
    },
  };

  const flags = createFeatureFlagRegistry(options.flags ?? FLAGS);
  // The composition a real root performs: the settings registry declares the
  // built-in settings AND the flag projections.
  const settingsRegistry = createSettingsRegistry([
    ...BUILT_IN_SETTINGS,
    ...flags.settingDeclarations(),
  ]);
  let seq = 0;
  const newEventId = (): string =>
    `018f7a1e-0000-7000-9000-${String((seq += 1)).padStart(12, '0')}`;

  const settings = createSettingsResolver({
    registry: settingsRegistry,
    publisher,
    now: () => NOW,
    newEventId,
  });

  return {
    tx,
    layers,
    published,
    settings,
    resolver: createFeatureFlagResolver({
      flags,
      settings,
      settingsRegistry,
      publisher,
      ...(options.platformDefaults === undefined
        ? {}
        : { platformDefaults: options.platformDefaults }),
      now: () => NOW,
      newEventId,
    }),
  };
}

const wsKey = (flag: string): string => settingKeyFor(flag);

describe('hierarchy — most specific wins', () => {
  it('falls all the way through to the built-in default', async () => {
    const r = rig();
    const result = await r.resolver.evaluate(r.tx, workspaceScope, 'release.wide');
    expect(result.enabled).toBe(false);
    expect(result.source).toBe('built-in');
  });

  it('prefers the platform default over the built-in', async () => {
    const r = rig({ platformDefaults: { 'release.wide': true } });
    const result = await r.resolver.evaluate(r.tx, workspaceScope, 'release.wide');
    expect(result.enabled).toBe(true);
    expect(result.source).toBe('platform');
  });

  it('prefers the organization override over the platform default', async () => {
    const r = rig({
      organization: { [wsKey('release.wide')]: false },
      platformDefaults: { 'release.wide': true },
    });
    const result = await r.resolver.evaluate(r.tx, workspaceScope, 'release.wide');
    expect(result.enabled).toBe(false);
    expect(result.source).toBe('organization');
  });

  it('prefers the workspace override over everything below it', async () => {
    const r = rig({
      workspace: { [wsKey('release.wide')]: true },
      organization: { [wsKey('release.wide')]: false },
      platformDefaults: { 'release.wide': false },
    });
    const result = await r.resolver.evaluate(r.tx, workspaceScope, 'release.wide');
    expect(result.enabled).toBe(true);
    expect(result.source).toBe('workspace');
  });

  it('walks the four layers in the declared order', async () => {
    const sequence: [Parameters<typeof rig>[0], boolean, string][] = [
      [{}, false, 'built-in'],
      [{ platformDefaults: { 'release.wide': true } }, true, 'platform'],
      [{ organization: { [wsKey('release.wide')]: true } }, true, 'organization'],
      [{ workspace: { [wsKey('release.wide')]: true } }, true, 'workspace'],
    ];
    for (const [options, enabled, source] of sequence) {
      const r = rig(options);
      const result = await r.resolver.evaluate(r.tx, workspaceScope, 'release.wide');
      expect(result.enabled, source).toBe(enabled);
      expect(result.source, source).toBe(source);
    }
  });

  // An organization scope has no workspace layer to consult.
  it('evaluates an organization scope with no workspace layer', async () => {
    const r = rig({ organization: { [wsKey('plan.gated')]: true } });
    const result = await r.resolver.evaluate(r.tx, organizationScope, 'plan.gated');
    expect(result.enabled).toBe(true);
    expect(result.source).toBe('organization');
    expect(result.version).toBe('o1');
  });

  it('isEnabled answers the same question more briefly', async () => {
    const r = rig({ workspace: { [wsKey('release.wide')]: true } });
    expect(await r.resolver.isEnabled(r.tx, workspaceScope, 'release.wide')).toBe(true);
    expect(await r.resolver.isEnabled(r.tx, workspaceScope, 'plan.gated')).toBe(false);
  });

  it('evaluates a batch at one version', async () => {
    const r = rig({ workspace: { [wsKey('release.wide')]: true } });
    const results = await r.resolver.evaluateMany(r.tx, workspaceScope, [
      'release.wide',
      'plan.gated',
      'ops.kill_switch',
    ]);
    expect(results.map((f) => [f.key, f.enabled, f.source])).toEqual([
      ['release.wide', true, 'workspace'],
      ['plan.gated', false, 'built-in'],
      ['ops.kill_switch', true, 'built-in'],
    ]);
    expect(new Set(results.map((f) => f.version)).size).toBe(1);
  });
});

describe('a layer the flag forbids is ignored, never honoured', () => {
  // The whole point of a platform-scoped kill switch: the customer it is
  // protecting cannot reach it.
  it('ignores a workspace override of a platform-scoped flag', async () => {
    const r = rig({ workspace: { [wsKey('ops.kill_switch')]: false } });
    const result = await r.resolver.evaluate(r.tx, workspaceScope, 'ops.kill_switch');
    expect(result.enabled).toBe(true);
    expect(result.source).toBe('built-in');
  });

  it('ignores an ORGANIZATION override of a platform-scoped flag too', async () => {
    const r = rig({ organization: { [wsKey('ops.kill_switch')]: false } });
    const result = await r.resolver.evaluate(r.tx, workspaceScope, 'ops.kill_switch');
    expect(result.enabled).toBe(true);
    expect(result.source).toBe('built-in');
  });

  it('still honours the platform layer for a platform-scoped flag', async () => {
    const r = rig({
      workspace: { [wsKey('ops.kill_switch')]: true },
      platformDefaults: { 'ops.kill_switch': false },
    });
    const result = await r.resolver.evaluate(r.tx, workspaceScope, 'ops.kill_switch');
    expect(result.enabled).toBe(false);
    expect(result.source).toBe('platform');
  });

  // A plan is bought per account, so a workspace may not vary it.
  it('ignores a workspace override of an organization-scoped flag', async () => {
    const r = rig({
      workspace: { [wsKey('plan.gated')]: true },
      organization: { [wsKey('plan.gated')]: false },
    });
    const result = await r.resolver.evaluate(r.tx, workspaceScope, 'plan.gated');
    expect(result.enabled).toBe(false);
    expect(result.source).toBe('organization');
  });

  it('reports the violation on the snapshot', async () => {
    const r = rig({ workspace: { [wsKey('ops.kill_switch')]: false } });
    const snapshot = await r.resolver.evaluateSnapshot(r.tx, workspaceScope);
    const anomaly = snapshot.anomalies.find((a) => a.key === 'ops.kill_switch');
    expect(anomaly?.reason).toBe('scope-violation');
    expect(anomaly?.layer).toBe('workspace');
    expect(anomaly?.detail).toContain('platform-scoped');
  });

  // Falling through is the SAFE direction: the flag lands on our value, not
  // the customer's.
  it('reports no anomaly when the override was permitted', async () => {
    const r = rig({ workspace: { [wsKey('release.wide')]: true } });
    const snapshot = await r.resolver.evaluateSnapshot(r.tx, workspaceScope);
    expect(snapshot.anomalies).toEqual([]);
  });
});

describe('unknown flags are refused', () => {
  it('rejects an evaluation for an undeclared flag', async () => {
    const r = rig();
    await expect(r.resolver.evaluate(r.tx, workspaceScope, 'nope.nothing')).rejects.toThrow(
      FeatureFlagError,
    );
    await expect(r.resolver.isEnabled(r.tx, workspaceScope, 'nope.nothing')).rejects.toThrow(
      /not a declared feature flag/,
    );
  });

  it('rejects an unknown flag inside a batch', async () => {
    const r = rig();
    await expect(
      r.resolver.evaluateMany(r.tx, workspaceScope, ['release.wide', 'nope.nothing']),
    ).rejects.toThrow(FeatureFlagError);
  });

  it('rejects an unknown flag in a change announcement', async () => {
    const r = rig();
    await expect(
      r.resolver.announceChange(r.tx, {
        scope: workspaceScope,
        changedFlags: ['nope.nothing'],
        correlationId: CORRELATION,
      }),
    ).rejects.toThrow(/not a declared feature flag/);
  });

  it('refuses a platform default for an undeclared flag, at construction', () => {
    const flags = createFeatureFlagRegistry(FLAGS);
    const settingsRegistry = createSettingsRegistry([...flags.settingDeclarations()]);
    expect(() =>
      createFeatureFlagResolver({
        flags,
        settingsRegistry,
        settings: createSettingsResolver({
          registry: settingsRegistry,
          publisher: { publish: () => Promise.resolve() },
        }),
        publisher: { publish: () => Promise.resolve() },
        platformDefaults: { 'nope.nothing': true },
      }),
    ).toThrow(/not a declared feature flag/);
  });

  it('refuses a non-boolean platform default, at construction', () => {
    const flags = createFeatureFlagRegistry(FLAGS);
    const settingsRegistry = createSettingsRegistry([...flags.settingDeclarations()]);
    expect(() =>
      createFeatureFlagResolver({
        flags,
        settingsRegistry,
        settings: createSettingsResolver({
          registry: settingsRegistry,
          publisher: { publish: () => Promise.resolve() },
        }),
        publisher: { publish: () => Promise.resolve() },
        platformDefaults: { 'release.wide': 'yes' as never },
      }),
    ).toThrow(/not a boolean/);
  });
});

describe('the wiring is checked at startup', () => {
  // A settings registry built without the projections would resolve nothing:
  // every flag would sit silently at its built-in default, including a kill
  // switch someone believes they have thrown.
  it('refuses to build when the settings registry lacks the flag projections', () => {
    const flags = createFeatureFlagRegistry(FLAGS);
    const settingsRegistry = createSettingsRegistry();
    expect(() =>
      createFeatureFlagResolver({
        flags,
        settingsRegistry,
        settings: createSettingsResolver({
          registry: settingsRegistry,
          publisher: { publish: () => Promise.resolve() },
        }),
        publisher: { publish: () => Promise.resolve() },
      }),
    ).toThrow(/is not in the settings registry/);
  });

  it('names the missing key and how to fix it', () => {
    const flags = createFeatureFlagRegistry(FLAGS);
    const settingsRegistry = createSettingsRegistry();
    try {
      createFeatureFlagResolver({
        flags,
        settingsRegistry,
        settings: createSettingsResolver({
          registry: settingsRegistry,
          publisher: { publish: () => Promise.resolve() },
        }),
        publisher: { publish: () => Promise.resolve() },
      });
      expect.unreachable('must refuse');
    } catch (error) {
      expect((error as FeatureFlagError).code).toBe('RegistryMismatch');
      expect((error as FeatureFlagError).message).toContain('settingDeclarations()');
    }
  });
});

describe('caching is the settings resolver’s, not a second one', () => {
  // The compatibility requirement, asserted directly: a repeat evaluation must
  // register as a HIT on the settings resolver. A second cache here would leave
  // its statistics untouched.
  it('registers a hit on the settings resolver for a repeat evaluation', async () => {
    const r = rig();
    await r.resolver.evaluate(r.tx, workspaceScope, 'release.wide');
    await r.resolver.evaluate(r.tx, workspaceScope, 'release.wide');
    expect(r.settings.stats).toEqual({ hits: 1, misses: 1 });
  });

  it('shares one cache entry across flags in one scope', async () => {
    const r = rig();
    await r.resolver.evaluate(r.tx, workspaceScope, 'release.wide');
    await r.resolver.evaluate(r.tx, workspaceScope, 'plan.gated');
    await r.resolver.evaluate(r.tx, workspaceScope, 'ops.kill_switch');
    expect(r.settings.stats.misses).toBe(1);
    expect(r.settings.stats.hits).toBe(2);
  });

  it('reloads when the workspace version moves', async () => {
    const r = rig({ workspace: { [wsKey('release.wide')]: false } });
    expect((await r.resolver.evaluate(r.tx, workspaceScope, 'release.wide')).enabled).toBe(false);

    r.layers.workspace = { [wsKey('release.wide')]: true };
    r.layers.workspaceVersion = 2;

    const after = await r.resolver.evaluate(r.tx, workspaceScope, 'release.wide');
    expect(after.enabled).toBe(true);
    expect(after.version).toBe('w2.o1');
  });

  it('reloads when the organization version moves', async () => {
    const r = rig({ organization: { [wsKey('release.wide')]: false } });
    await r.resolver.evaluate(r.tx, workspaceScope, 'release.wide');

    r.layers.organization = { [wsKey('release.wide')]: true };
    r.layers.organizationVersion = 2;

    expect((await r.resolver.evaluate(r.tx, workspaceScope, 'release.wide')).enabled).toBe(true);
  });

  // No invalidation was delivered — the version check alone is enough.
  it('cannot serve a stale evaluation even with no invalidation at all', async () => {
    const r = rig({ workspace: { [wsKey('ops.kill_switch')]: false } });
    await r.resolver.evaluateSnapshot(r.tx, workspaceScope);

    r.layers.organization = { [wsKey('release.wide')]: true };
    r.layers.organizationVersion = 5;

    const snapshot = await r.resolver.evaluateSnapshot(r.tx, workspaceScope);
    expect(snapshot.isEnabled('release.wide')).toBe(true);
    expect(snapshot.version).toBe('w1.o5');
  });

  it('keeps separate entries per scope', async () => {
    const r = rig({
      workspace: { [wsKey('release.wide')]: true },
      organization: { [wsKey('release.wide')]: false },
    });
    expect((await r.resolver.evaluate(r.tx, workspaceScope, 'release.wide')).enabled).toBe(true);
    expect((await r.resolver.evaluate(r.tx, organizationScope, 'release.wide')).enabled).toBe(
      false,
    );
    expect(r.settings.stats.misses).toBe(2);
  });
});

describe('snapshots are immutable and complete', () => {
  it('covers every declared flag', async () => {
    const r = rig();
    const snapshot = await r.resolver.evaluateSnapshot(r.tx, workspaceScope);
    expect(Object.keys(snapshot.flags).sort()).toEqual(FLAGS.map((f) => f.key).sort());
  });

  it('names the source layer for every flag', async () => {
    const r = rig({ workspace: { [wsKey('release.wide')]: true } });
    const snapshot = await r.resolver.evaluateSnapshot(r.tx, workspaceScope);
    expect(snapshot.sourceOf('release.wide')).toBe('workspace');
    expect(snapshot.sourceOf('plan.gated')).toBe('built-in');
    expect(Object.keys(snapshot.sources).sort()).toEqual(Object.keys(snapshot.flags).sort());
  });

  it('is frozen all the way down', async () => {
    const r = rig();
    const snapshot = await r.resolver.evaluateSnapshot(r.tx, workspaceScope);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.flags)).toBe(true);
    expect(Object.isFrozen(snapshot.sources)).toBe(true);
    expect(Object.isFrozen(snapshot.anomalies)).toBe(true);
  });

  it('cannot have a flag flipped in it', async () => {
    const r = rig();
    const snapshot = await r.resolver.evaluateSnapshot(r.tx, workspaceScope);
    expect(() => {
      'use strict';
      (snapshot.flags as Record<string, boolean>)['release.wide'] = true;
    }).toThrow(TypeError);
    expect(snapshot.isEnabled('release.wide')).toBe(false);
  });

  // A mid-request change cannot alter behaviour, because there is nothing here
  // that can be altered.
  it('does not move when the underlying layers change', async () => {
    const r = rig({ workspace: { [wsKey('release.wide')]: false } });
    const snapshot = await r.resolver.evaluateSnapshot(r.tx, workspaceScope);

    r.layers.workspace = { [wsKey('release.wide')]: true };
    r.layers.workspaceVersion = 2;
    const fresh = await r.resolver.evaluate(r.tx, workspaceScope, 'release.wide');

    expect(fresh.enabled).toBe(true);
    expect(snapshot.isEnabled('release.wide')).toBe(false);
    expect(snapshot.version).toBe('w1.o1');
  });

  it('gives two holders the same evaluation at the same version', async () => {
    const r = rig({ workspace: { [wsKey('release.wide')]: true } });
    const first = await r.resolver.evaluateSnapshot(r.tx, workspaceScope);
    const second = await r.resolver.evaluateSnapshot(r.tx, workspaceScope);
    expect(first.flags).toEqual(second.flags);
    expect(first.version).toBe(second.version);
  });

  it('refuses a flag it does not hold', async () => {
    const r = rig();
    const snapshot = await r.resolver.evaluateSnapshot(r.tx, workspaceScope);
    expect(() => snapshot.isEnabled('nope.nothing')).toThrow(FeatureFlagError);
    expect(() => snapshot.sourceOf('nope.nothing')).toThrow(/not in this snapshot/);
  });
});

describe('FeatureFlagChanged', () => {
  it('is published on a change announcement, with the version after it', async () => {
    const r = rig();
    r.layers.workspaceVersion = 4;
    const event = await r.resolver.announceChange(r.tx, {
      scope: workspaceScope,
      changedFlags: ['release.wide', 'plan.gated'],
      correlationId: CORRELATION,
    });

    expect(event.eventType).toBe('FeatureFlagChanged');
    expect(event.payload).toMatchObject({
      scopeType: 'workspace',
      scopeId: WS,
      organizationId: ORG,
      changedFlags: ['release.wide', 'plan.gated'],
      version: 'w4.o1',
    });
  });

  // The settings resolver owns the cache, so the invalidation has to go through
  // it. Announcing a change while its cache stays populated would tell
  // consumers about something nothing acted on.
  it('invalidates through the settings resolver as well', async () => {
    const r = rig();
    await r.resolver.evaluate(r.tx, workspaceScope, 'release.wide');
    await r.resolver.announceChange(r.tx, {
      scope: workspaceScope,
      changedFlags: ['release.wide'],
      correlationId: CORRELATION,
    });
    await r.resolver.evaluate(r.tx, workspaceScope, 'release.wide');

    expect(r.settings.stats.misses).toBe(2);
    expect(r.published.map((e) => e.eventType)).toEqual(['SettingsChanged', 'FeatureFlagChanged']);
  });

  it('links the flag event to the settings invalidation that carried it', async () => {
    const r = rig();
    const event = await r.resolver.announceChange(r.tx, {
      scope: workspaceScope,
      changedFlags: ['release.wide'],
      correlationId: CORRELATION,
    });
    const invalidation = r.published.find((e) => e.eventType === 'SettingsChanged');
    expect(event.causationId).toBe(invalidation?.eventId);
  });

  it('namespaces the changed keys for the settings invalidation', async () => {
    const r = rig();
    await r.resolver.announceChange(r.tx, {
      scope: workspaceScope,
      changedFlags: ['release.wide'],
      correlationId: CORRELATION,
    });
    const invalidation = r.published.find((e) => e.eventType === 'SettingsChanged');
    expect((invalidation?.payload as { changedKeys: string[] }).changedKeys).toEqual([
      wsKey('release.wide'),
    ]);
  });

  // Shared with SettingsChanged: they mutate the same row and the same version,
  // so they must be ordered against each other.
  it('carries the settings aggregate and the organization tenant', async () => {
    const r = rig();
    for (const scope of [workspaceScope, organizationScope]) {
      const event = await r.resolver.announceChange(r.tx, {
        scope,
        changedFlags: ['release.wide'],
        correlationId: CORRELATION,
      });
      expect(event).toMatchObject({
        aggregateType: 'SettingsTree',
        aggregateId: ORG,
        tenantId: ORG,
        organizationId: ORG,
        producer: 'platform.feature-flags',
      });
    }
  });

  // The flag set is a roadmap and a probe map.
  it('carries flag names and no evaluated state', async () => {
    const r = rig();
    const event = await r.resolver.announceChange(r.tx, {
      scope: workspaceScope,
      changedFlags: ['ops.kill_switch'],
      correlationId: CORRELATION,
    });
    const serialized = JSON.stringify(event.payload);
    expect(serialized).toContain('ops.kill_switch');
    expect(Object.keys(event.payload)).not.toContain('enabled');
    expect(Object.keys(event.payload)).not.toContain('values');
  });
});
