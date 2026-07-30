/**
 * The Settings Resolver.
 *
 * Three properties carry this file: the hierarchy resolves in the declared
 * order with honest provenance, a version change is never served from cache,
 * and a snapshot two holders share cannot be altered by either of them.
 *
 * The fake below models the two layer tables and their `version` columns —
 * which is the whole mechanism the cache correctness rests on. A fake that
 * ignored versions would let a stale-read bug pass.
 */
import { describe, expect, it } from 'vitest';

import type { DomainEvent, EventPublisher, Transaction } from '@contentos/contracts';

import { createSettingsRegistry, SettingsError, type SettingValue } from './registry.js';
import {
  createSettingsResolver,
  type ResolutionScope,
  type SettingsResolutionExecutor,
  type SettingsResolver,
} from './resolver.js';

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

interface Layers {
  workspace: Record<string, unknown>;
  organization: Record<string, unknown>;
  workspaceVersion: number;
  organizationVersion: number;
  /** Set to make the scope look absent. */
  missing: boolean;
}

interface Rig {
  readonly tx: SettingsResolutionExecutor;
  readonly resolver: SettingsResolver;
  readonly layers: Layers;
  readonly published: DomainEvent<unknown>[];
  readonly queries: string[];
}

function rig(
  options: {
    workspace?: Record<string, unknown>;
    organization?: Record<string, unknown>;
    platformDefaults?: Record<string, SettingValue>;
  } = {},
): Rig {
  const layers: Layers = {
    workspace: options.workspace ?? {},
    organization: options.organization ?? {},
    workspaceVersion: 1,
    organizationVersion: 1,
    missing: false,
  };
  const published: DomainEvent<unknown>[] = [];
  const queries: string[] = [];

  const tx = {
    query<T>(sql: string): Promise<readonly T[]> {
      const forWorkspace = sql.includes('FROM workspaces');
      const loading = sql.includes('settings');
      queries.push(`${loading ? 'load' : 'probe'}:${forWorkspace ? 'ws' : 'org'}`);
      if (layers.missing) return Promise.resolve([]);

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

  return {
    tx,
    layers,
    published,
    queries,
    resolver: createSettingsResolver({
      registry: createSettingsRegistry(),
      publisher,
      ...(options.platformDefaults === undefined
        ? {}
        : { platformDefaults: options.platformDefaults }),
      now: () => NOW,
      newEventId: () => '018f7a1e-0000-7000-8000-0000000000ee',
    }),
  };
}

describe('hierarchy — most specific wins', () => {
  it('falls all the way through to the built-in default', async () => {
    const r = rig();
    const result = await r.resolver.resolve(r.tx, workspaceScope, 'content.locale');
    expect(result.value).toBe('en-US');
    expect(result.source).toBe('built-in');
  });

  it('prefers the platform default over the built-in', async () => {
    const r = rig({ platformDefaults: { 'content.locale': 'en-GB' } });
    const result = await r.resolver.resolve(r.tx, workspaceScope, 'content.locale');
    expect(result.value).toBe('en-GB');
    expect(result.source).toBe('platform');
  });

  it('prefers the organization over the platform default', async () => {
    const r = rig({
      organization: { 'content.locale': 'de-DE' },
      platformDefaults: { 'content.locale': 'en-GB' },
    });
    const result = await r.resolver.resolve(r.tx, workspaceScope, 'content.locale');
    expect(result.value).toBe('de-DE');
    expect(result.source).toBe('organization');
  });

  // A customer's explicit choice outranks an operator's default, always.
  it('prefers the workspace over everything below it', async () => {
    const r = rig({
      workspace: { 'content.locale': 'fr-FR' },
      organization: { 'content.locale': 'de-DE' },
      platformDefaults: { 'content.locale': 'en-GB' },
    });
    const result = await r.resolver.resolve(r.tx, workspaceScope, 'content.locale');
    expect(result.value).toBe('fr-FR');
    expect(result.source).toBe('workspace');
  });

  it('walks the four layers in the declared order', async () => {
    const sequence: [Parameters<typeof rig>[0], string, string][] = [
      [{}, 'en-US', 'built-in'],
      [{ platformDefaults: { 'content.locale': 'en-GB' } }, 'en-GB', 'platform'],
      [{ organization: { 'content.locale': 'de-DE' } }, 'de-DE', 'organization'],
      [{ workspace: { 'content.locale': 'fr-FR' } }, 'fr-FR', 'workspace'],
    ];
    for (const [options, value, source] of sequence) {
      const r = rig(options);
      const result = await r.resolver.resolve(r.tx, workspaceScope, 'content.locale');
      expect(result.value, source).toBe(value);
      expect(result.source, source).toBe(source);
    }
  });
});

describe('inheritance — absence falls through, per key', () => {
  // Rule 4: an unset value is not a value. A layer that sets one key does not
  // shadow the layers below it for every other key.
  it('inherits keys the workspace does not set', async () => {
    const r = rig({
      workspace: { 'content.locale': 'fr-FR' },
      organization: { 'content.reading_grade_min': 6, 'content.locale': 'de-DE' },
    });
    const resolved = await r.resolver.resolveMany(r.tx, workspaceScope, [
      'content.locale',
      'content.reading_grade_min',
      'content.reading_grade_max',
    ]);

    expect(resolved.map((s) => [s.key, s.value, s.source])).toEqual([
      ['content.locale', 'fr-FR', 'workspace'],
      ['content.reading_grade_min', 6, 'organization'],
      ['content.reading_grade_max', 10, 'built-in'],
    ]);
  });

  it('resolves every declared type', async () => {
    const r = rig({
      workspace: {
        'content.reading_grade_min': 6,
        'content.locale': 'fr-FR',
        'review.approval_required': true,
        'review.gate_threshold': '0.950000',
        'routing.tier_preferences': { draft: 'fast' },
      },
    });
    const resolved = await r.resolver.resolveMany(r.tx, workspaceScope, [
      'content.reading_grade_min',
      'content.locale',
      'review.approval_required',
      'review.gate_threshold',
      'routing.tier_preferences',
    ]);
    expect(resolved.map((s) => s.value)).toEqual([6, 'fr-FR', true, '0.950000', { draft: 'fast' }]);
    expect(resolved.every((s) => s.source === 'workspace')).toBe(true);
  });

  // An organization scope has no workspace layer at all.
  it('resolves an organization scope without a workspace layer', async () => {
    const r = rig({
      workspace: { 'retention.days': 9999 },
      organization: { 'retention.days': 30 },
    });
    const result = await r.resolver.resolve(r.tx, organizationScope, 'retention.days');
    expect(result.value).toBe(30);
    expect(result.source).toBe('organization');
    expect(result.version).toBe('o1');
  });
});

describe('scope violations are ignored, never honoured', () => {
  // Rule 2: a workspace admin must not extend their own retention past what the
  // organization bought. Falling through is the SAFE direction.
  it('passes over a workspace value for an organization-only key', async () => {
    const r = rig({
      workspace: { 'retention.days': 9999 },
      organization: { 'retention.days': 30 },
    });
    const result = await r.resolver.resolve(r.tx, workspaceScope, 'retention.days');
    expect(result.value).toBe(30);
    expect(result.source).toBe('organization');
  });

  it('falls to the built-in rather than honouring it', async () => {
    const r = rig({ workspace: { 'security.sso_required': false } });
    const result = await r.resolver.resolve(r.tx, workspaceScope, 'security.sso_required');
    expect(result.source).toBe('built-in');
  });

  it('reports the violation on the snapshot', async () => {
    const r = rig({ workspace: { 'retention.days': 9999 } });
    const snapshot = await r.resolver.resolveSnapshot(r.tx, workspaceScope);
    const anomaly = snapshot.anomalies.find((a) => a.key === 'retention.days');
    expect(anomaly?.reason).toBe('scope-violation');
    expect(anomaly?.layer).toBe('workspace');
    expect(anomaly?.detail).toContain('organization-only');
  });
});

describe('a stored value the registry disagrees with is ignored', () => {
  // "Registry wins; the stored value is ignored and reported."
  it('passes over a type mismatch and falls through', async () => {
    const r = rig({
      workspace: { 'content.reading_grade_min': 'six' },
      organization: { 'content.reading_grade_min': 7 },
    });
    const result = await r.resolver.resolve(r.tx, workspaceScope, 'content.reading_grade_min');
    expect(result.value).toBe(7);
    expect(result.source).toBe('organization');
  });

  it('reports the mismatch', async () => {
    const r = rig({ workspace: { 'review.gate_threshold': 0.9 } });
    const snapshot = await r.resolver.resolveSnapshot(r.tx, workspaceScope);
    const anomaly = snapshot.anomalies.find((a) => a.key === 'review.gate_threshold');
    expect(anomaly?.reason).toBe('type-mismatch');
    expect(snapshot.get('review.gate_threshold')).toBe('0.850000');
  });

  // Usually a key removed in an earlier release. Resolution is on every run
  // start; refusing to answer would take the platform down for a dead key.
  it('reports an undeclared stored key without failing', async () => {
    const r = rig({ workspace: { 'content.removed_in_v1': 'x' } });
    const snapshot = await r.resolver.resolveSnapshot(r.tx, workspaceScope);
    const anomaly = snapshot.anomalies.find((a) => a.key === 'content.removed_in_v1');
    expect(anomaly?.reason).toBe('unknown-key');
    expect(snapshot.values['content.locale']).toBe('en-US');
  });
});

describe('unknown keys are refused', () => {
  it('rejects a resolve for an undeclared key', async () => {
    const r = rig();
    await expect(r.resolver.resolve(r.tx, workspaceScope, 'nope.nothing')).rejects.toThrow(
      SettingsError,
    );
  });

  // A programming error should not cost a query to discover.
  it('rejects it before touching the database', async () => {
    const r = rig();
    await r.resolver.resolve(r.tx, workspaceScope, 'content.locale').catch(() => undefined);
    r.queries.length = 0;
    await r.resolver
      .resolveMany(r.tx, workspaceScope, ['content.locale', 'nope.nothing'])
      .catch(() => undefined);
    expect(r.queries).toEqual([]);
  });

  it('rejects an unknown key in an invalidation', async () => {
    const r = rig();
    await expect(
      r.resolver.invalidate(r.tx, {
        scope: workspaceScope,
        changedKeys: ['nope.nothing'],
        correlationId: CORRELATION,
      }),
    ).rejects.toThrow(/not a declared setting/);
  });

  it('refuses a platform default for an undeclared key, at construction', () => {
    expect(() =>
      createSettingsResolver({
        registry: createSettingsRegistry(),
        publisher: { publish: () => Promise.resolve() },
        platformDefaults: { 'nope.nothing': 'x' },
      }),
    ).toThrow(/not a declared setting/);
  });

  it('refuses a platform default of the wrong type, at construction', () => {
    expect(() =>
      createSettingsResolver({
        registry: createSettingsRegistry(),
        publisher: { publish: () => Promise.resolve() },
        platformDefaults: { 'content.reading_grade_min': 'six' as never },
      }),
    ).toThrow(/declared integer/);
  });
});

describe('provenance and version accompany every answer', () => {
  it('reports the composite version of both layers', async () => {
    const r = rig();
    r.layers.workspaceVersion = 7;
    r.layers.organizationVersion = 3;
    const result = await r.resolver.resolve(r.tx, workspaceScope, 'content.locale');
    expect(result.version).toBe('w7.o3');
  });

  it('gives every key in a batch the same version', async () => {
    const r = rig();
    const resolved = await r.resolver.resolveMany(r.tx, workspaceScope, [
      'content.locale',
      'retention.days',
    ]);
    expect(new Set(resolved.map((s) => s.version)).size).toBe(1);
  });

  it('names the source layer for every key on a snapshot', async () => {
    const r = rig({ workspace: { 'content.locale': 'fr-FR' } });
    const snapshot = await r.resolver.resolveSnapshot(r.tx, workspaceScope);
    expect(snapshot.sourceOf('content.locale')).toBe('workspace');
    expect(snapshot.sourceOf('retention.days')).toBe('built-in');
    expect(Object.keys(snapshot.sources).sort()).toEqual(Object.keys(snapshot.values).sort());
  });
});

describe('caching — never stale after a version change', () => {
  it('serves a repeat read from cache', async () => {
    const r = rig({ workspace: { 'content.locale': 'fr-FR' } });
    await r.resolver.resolve(r.tx, workspaceScope, 'content.locale');
    await r.resolver.resolve(r.tx, workspaceScope, 'content.locale');

    expect(r.resolver.stats).toEqual({ hits: 1, misses: 1 });
    // A hit costs the version probe and nothing else.
    expect(r.queries).toEqual(['probe:ws', 'load:ws', 'probe:ws']);
  });

  // The property the whole design exists for.
  it('reloads when the workspace version moves', async () => {
    const r = rig({ workspace: { 'content.locale': 'fr-FR' } });
    const before = await r.resolver.resolve(r.tx, workspaceScope, 'content.locale');
    expect(before.value).toBe('fr-FR');

    r.layers.workspace = { 'content.locale': 'it-IT' };
    r.layers.workspaceVersion = 2;

    const after = await r.resolver.resolve(r.tx, workspaceScope, 'content.locale');
    expect(after.value).toBe('it-IT');
    expect(after.version).toBe('w2.o1');
  });

  // The layer an admin edits for five hundred workspaces at once.
  it('reloads when the ORGANIZATION version moves', async () => {
    const r = rig({ organization: { 'content.locale': 'de-DE' } });
    await r.resolver.resolve(r.tx, workspaceScope, 'content.locale');

    r.layers.organization = { 'content.locale': 'es-ES' };
    r.layers.organizationVersion = 2;

    const after = await r.resolver.resolve(r.tx, workspaceScope, 'content.locale');
    expect(after.value).toBe('es-ES');
    expect(after.source).toBe('organization');
  });

  // No invalidation was delivered here — the version check alone is enough.
  it('cannot serve a stale value even with no invalidation at all', async () => {
    const r = rig({ workspace: { 'review.approval_required': false } });
    await r.resolver.resolveSnapshot(r.tx, workspaceScope);

    r.layers.workspace = { 'review.approval_required': true };
    r.layers.workspaceVersion = 2;

    const snapshot = await r.resolver.resolveSnapshot(r.tx, workspaceScope);
    expect(snapshot.get('review.approval_required')).toBe(true);
  });

  it('keeps separate entries per scope', async () => {
    const r = rig({
      workspace: { 'content.locale': 'fr-FR' },
      organization: { 'content.locale': 'de-DE' },
    });
    const ws = await r.resolver.resolve(r.tx, workspaceScope, 'content.locale');
    const org = await r.resolver.resolve(r.tx, organizationScope, 'content.locale');

    expect(ws.value).toBe('fr-FR');
    expect(org.value).toBe('de-DE');
    expect(r.resolver.stats.misses).toBe(2);
  });

  it('drops the entry on invalidate', async () => {
    const r = rig();
    await r.resolver.resolve(r.tx, workspaceScope, 'content.locale');
    await r.resolver.invalidate(r.tx, {
      scope: workspaceScope,
      changedKeys: ['content.locale'],
      correlationId: CORRELATION,
    });
    await r.resolver.resolve(r.tx, workspaceScope, 'content.locale');
    expect(r.resolver.stats.misses).toBe(2);
  });

  it('refuses to resolve for a scope that does not exist', async () => {
    const r = rig();
    r.layers.missing = true;
    await expect(r.resolver.resolve(r.tx, workspaceScope, 'content.locale')).rejects.toThrow(
      /does not exist or is deleted/,
    );
  });
});

describe('snapshots are immutable and complete', () => {
  it('covers every declared key', async () => {
    const r = rig();
    const registry = createSettingsRegistry();
    const snapshot = await r.resolver.resolveSnapshot(r.tx, workspaceScope);
    expect(Object.keys(snapshot.values).sort()).toEqual([...registry.keys].sort());
  });

  it('is frozen at the top level', async () => {
    const r = rig();
    const snapshot = await r.resolver.resolveSnapshot(r.tx, workspaceScope);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.values)).toBe(true);
    expect(Object.isFrozen(snapshot.sources)).toBe(true);
  });

  // "Multiple services using one request must observe identical settings." A
  // shallow freeze would promise that about the first level only.
  it('is frozen all the way down, so a json value cannot be edited', async () => {
    const r = rig({ workspace: { 'routing.tier_preferences': { draft: 'fast' } } });
    const snapshot = await r.resolver.resolveSnapshot(r.tx, workspaceScope);
    const routing = snapshot.get('routing.tier_preferences') as Record<string, unknown>;

    expect(Object.isFrozen(routing)).toBe(true);
    expect(() => {
      'use strict';
      routing['draft'] = 'slow';
    }).toThrow(TypeError);
    expect(snapshot.get('routing.tier_preferences')).toEqual({ draft: 'fast' });
  });

  it('cannot have a value added to it', async () => {
    const r = rig();
    const snapshot = await r.resolver.resolveSnapshot(r.tx, workspaceScope);
    expect(() => {
      'use strict';
      (snapshot.values as Record<string, SettingValue>)['content.locale'] = 'xx';
    }).toThrow(TypeError);
  });

  // A mid-run change cannot alter behaviour, because there is nothing here that
  // can be altered — settings.md §"Run snapshotting", workspace.md rule 12.
  it('does not move when the underlying layers change', async () => {
    const r = rig({ workspace: { 'content.locale': 'fr-FR' } });
    const snapshot = await r.resolver.resolveSnapshot(r.tx, workspaceScope);

    r.layers.workspace = { 'content.locale': 'it-IT' };
    r.layers.workspaceVersion = 2;
    // A later reader sees the change; the snapshot does not.
    const fresh = await r.resolver.resolve(r.tx, workspaceScope, 'content.locale');

    expect(fresh.value).toBe('it-IT');
    expect(snapshot.get('content.locale')).toBe('fr-FR');
    expect(snapshot.version).toBe('w1.o1');
  });

  it('gives two holders the same values at the same version', async () => {
    const r = rig({ workspace: { 'content.locale': 'fr-FR' } });
    const first = await r.resolver.resolveSnapshot(r.tx, workspaceScope);
    const second = await r.resolver.resolveSnapshot(r.tx, workspaceScope);
    expect(first.values).toEqual(second.values);
    expect(first.version).toBe(second.version);
  });

  it('refuses a key it does not hold', async () => {
    const r = rig();
    const snapshot = await r.resolver.resolveSnapshot(r.tx, workspaceScope);
    expect(() => snapshot.get('nope.nothing')).toThrow(SettingsError);
    expect(() => snapshot.sourceOf('nope.nothing')).toThrow(/not in this snapshot/);
  });
});

describe('SettingsChanged', () => {
  it('is published on invalidation, with the version after the change', async () => {
    const r = rig();
    r.layers.workspaceVersion = 4;
    const event = await r.resolver.invalidate(r.tx, {
      scope: workspaceScope,
      changedKeys: ['content.locale', 'review.approval_required'],
      correlationId: CORRELATION,
    });

    expect(r.published).toHaveLength(1);
    expect(event.eventType).toBe('SettingsChanged');
    expect(event.payload).toMatchObject({
      scopeType: 'workspace',
      scopeId: WS,
      organizationId: ORG,
      changedKeys: ['content.locale', 'review.approval_required'],
      version: 'w4.o1',
    });
  });

  // Organization-owned aggregate: an organization change and a workspace change
  // beneath it must stay ordered against each other.
  it('carries the organization as tenant and aggregate, for both scopes', async () => {
    const r = rig();
    for (const scope of [workspaceScope, organizationScope]) {
      const event = await r.resolver.invalidate(r.tx, {
        scope,
        changedKeys: ['content.locale'],
        correlationId: CORRELATION,
      });
      expect(event).toMatchObject({
        aggregateType: 'SettingsTree',
        aggregateId: ORG,
        tenantId: ORG,
        organizationId: ORG,
        producer: 'platform.settings',
      });
    }
  });

  // Settings hold competitively sensitive configuration, and an event reaches
  // consumers with weaker controls than the row does.
  it('carries keys and never a value', async () => {
    const r = rig({ workspace: { 'content.locale': 'voice-profile-alpha-7731' } });
    const event = await r.resolver.invalidate(r.tx, {
      scope: workspaceScope,
      changedKeys: ['content.locale'],
      correlationId: CORRELATION,
    });
    const serialized = JSON.stringify(event.payload);
    expect(serialized).toContain('content.locale');
    expect(serialized).not.toContain('voice-profile-alpha-7731');
  });

  it('records the causation of the change that triggered it', async () => {
    const r = rig();
    const event = await r.resolver.invalidate(r.tx, {
      scope: organizationScope,
      changedKeys: ['retention.days'],
      correlationId: CORRELATION,
      causationId: '018f7a1e-0000-7000-8000-0000000000c9',
    });
    expect(event.causationId).toBe('018f7a1e-0000-7000-8000-0000000000c9');
  });
});
