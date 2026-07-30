/**
 * The feature flag registry.
 *
 * What is tested is that it refuses to be an unreliable contract: duplicate
 * keys fail startup, every flag has an owner and a description, and the scope
 * rule that keeps a kill switch out of customer reach holds for all three
 * scopes.
 */
import { describe, expect, it } from 'vitest';

import {
  BUILT_IN_FLAGS,
  createFeatureFlagRegistry,
  FeatureFlagError,
  FLAG_KEY_PREFIX,
  FLAG_KINDS,
  FLAG_LAYERS,
  FLAG_SCOPES,
  settingKeyFor,
  type FeatureFlagDeclaration,
} from './registry.js';
import { createSettingsRegistry, matchesType } from '../settings/registry.js';

const flag = (over: Partial<FeatureFlagDeclaration> = {}): FeatureFlagDeclaration => ({
  key: 'test.flag',
  description: 'A test flag.',
  defaultValue: false,
  scope: 'workspace',
  owner: 'platform',
  kind: 'release',
  ...over,
});

describe('the declared vocabulary', () => {
  it('names the three kinds feature-flags.md distinguishes', () => {
    expect([...FLAG_KINDS].sort()).toEqual(['entitlement', 'operational', 'release']);
  });

  it('names the three targeting levels and nothing more', () => {
    expect([...FLAG_SCOPES].sort()).toEqual(['organization', 'platform', 'workspace']);
  });

  // Also the evaluation order.
  it('declares the four layers in precedence order', () => {
    expect([...FLAG_LAYERS]).toEqual(['workspace', 'organization', 'platform', 'built-in']);
  });
});

describe('the built-in flags', () => {
  const registry = createFeatureFlagRegistry();

  it('builds without complaint', () => {
    expect(registry.keys.length).toBe(BUILT_IN_FLAGS.length);
  });

  it('gives every flag a boolean default, an owner and a description', () => {
    for (const entry of BUILT_IN_FLAGS) {
      expect(typeof entry.defaultValue, entry.key).toBe('boolean');
      expect(entry.owner.trim(), entry.key).not.toBe('');
      expect(entry.description.trim(), entry.key).not.toBe('');
    }
  });

  it('covers all three kinds', () => {
    expect(new Set(BUILT_IN_FLAGS.map((f) => f.kind))).toEqual(new Set(FLAG_KINDS));
  });

  it('covers all three scopes', () => {
    expect(new Set(BUILT_IN_FLAGS.map((f) => f.scope))).toEqual(new Set(FLAG_SCOPES));
  });

  // A kill switch is ours to throw. A customer able to reach it is the failure
  // the platform scope exists to prevent.
  it('makes every operational flag platform-scoped', () => {
    for (const entry of BUILT_IN_FLAGS.filter((f) => f.kind === 'operational')) {
      expect(entry.scope, entry.key).toBe('platform');
    }
  });

  // "Projected from billing.md, never set by hand" — and a plan is bought per
  // account, so a workspace may not vary it.
  it('makes every entitlement flag organization-scoped', () => {
    for (const entry of BUILT_IN_FLAGS.filter((f) => f.kind === 'entitlement')) {
      expect(entry.scope, entry.key).toBe('organization');
    }
  });

  it('defaults the credits kill switch to ON, so metering is complete by default', () => {
    expect(registry.require('credits.enforce_authorization').defaultValue).toBe(true);
  });
});

describe('scope decides which layer may override', () => {
  const registry = createFeatureFlagRegistry([
    flag({ key: 'w', scope: 'workspace' }),
    flag({ key: 'o', scope: 'organization' }),
    flag({ key: 'p', scope: 'platform' }),
  ]);

  it('lets any customer layer override a workspace-scoped flag', () => {
    expect(registry.permits('w', 'workspace')).toBe(true);
    expect(registry.permits('w', 'organization')).toBe(true);
  });

  it('lets only the organization override an organization-scoped flag', () => {
    expect(registry.permits('o', 'workspace')).toBe(false);
    expect(registry.permits('o', 'organization')).toBe(true);
  });

  // The whole point: no customer layer can reach it.
  it('lets no customer layer override a platform-scoped flag', () => {
    expect(registry.permits('p', 'workspace')).toBe(false);
    expect(registry.permits('p', 'organization')).toBe(false);
  });

  it('always permits the platform and built-in layers', () => {
    for (const key of ['w', 'o', 'p']) {
      expect(registry.permits(key, 'platform'), key).toBe(true);
      expect(registry.permits(key, 'built-in'), key).toBe(true);
    }
  });
});

describe('an unknown flag is refused, never guessed', () => {
  const registry = createFeatureFlagRegistry();

  it('reports it as unknown, naming the flag', () => {
    expect(() => registry.require('nope.nothing')).toThrow(FeatureFlagError);
    try {
      registry.require('nope.nothing');
      expect.unreachable('must refuse');
    } catch (error) {
      expect((error as FeatureFlagError).code).toBe('UnknownFlag');
      expect((error as FeatureFlagError).message).toContain('nope.nothing');
    }
  });

  it('answers `has` and `find` without throwing', () => {
    expect(registry.has('entitlements.sso')).toBe(true);
    expect(registry.has('nope')).toBe(false);
    expect(registry.find('nope')).toBeUndefined();
  });

  it('refuses to check a scope for one', () => {
    expect(() => registry.permits('nope', 'workspace')).toThrow(/not a declared feature flag/);
  });
});

describe('the registry refuses a declaration set it cannot be trusted with', () => {
  // "Duplicate keys fail startup" — otherwise which default applies is decided
  // by declaration order, and a kill switch on the wrong default is not
  // something to discover during an incident.
  it('rejects a duplicate key at construction', () => {
    expect(() => createFeatureFlagRegistry([flag(), flag()])).toThrow(FeatureFlagError);
    try {
      createFeatureFlagRegistry([flag(), flag()]);
      expect.unreachable('must refuse');
    } catch (error) {
      expect((error as FeatureFlagError).code).toBe('DuplicateFlag');
    }
  });

  it('rejects a non-boolean default', () => {
    expect(() => createFeatureFlagRegistry([flag({ defaultValue: 'yes' as never })])).toThrow(
      /no third answer/,
    );
  });

  it('rejects an unknown scope', () => {
    expect(() => createFeatureFlagRegistry([flag({ scope: 'user' as never })])).toThrow(
      /unknown scope/,
    );
  });

  it('rejects an unknown kind', () => {
    expect(() => createFeatureFlagRegistry([flag({ kind: 'experiment' as never })])).toThrow(
      /unknown kind/,
    );
  });

  it('rejects an undescribed flag', () => {
    expect(() => createFeatureFlagRegistry([flag({ description: ' ' })])).toThrow(/nobody retires/);
  });

  // "Who turned this off?" needs an answer before the incident.
  it('rejects an unowned flag', () => {
    expect(() => createFeatureFlagRegistry([flag({ owner: '' })])).toThrow(/no owner/);
  });

  it('rejects an empty key', () => {
    expect(() => createFeatureFlagRegistry([flag({ key: '  ' })])).toThrow(/must have a key/);
  });

  // `flags.flags.x` would never match a stored override, and would do so
  // silently.
  it('rejects a key that already carries the namespace prefix', () => {
    expect(() => createFeatureFlagRegistry([flag({ key: 'flags.already' })])).toThrow(
      /must not include/,
    );
  });
});

describe('projection into settings declarations', () => {
  const registry = createFeatureFlagRegistry();
  const projected = registry.settingDeclarations();

  it('projects one boolean setting per flag, namespaced', () => {
    expect(projected).toHaveLength(BUILT_IN_FLAGS.length);
    for (const entry of projected) {
      expect(entry.key.startsWith(FLAG_KEY_PREFIX), entry.key).toBe(true);
      expect(entry.type, entry.key).toBe('boolean');
    }
  });

  it('carries each flag default through as the settings default', () => {
    for (const entry of BUILT_IN_FLAGS) {
      const declaration = projected.find((d) => d.key === settingKeyFor(entry.key));
      expect(declaration?.defaultValue, entry.key).toBe(entry.defaultValue);
      expect(matchesType('boolean', declaration?.defaultValue), entry.key).toBe(true);
    }
  });

  // The settings resolver returns only the layer that WON, so the projection
  // has to carry the half of the scope rule `SettingScope` can express — else
  // rejecting a forbidden workspace override afterwards would skip past the
  // legitimate organization value beneath it.
  it('projects the workspace-versus-organization half of the scope', () => {
    const byKey = new Map(projected.map((d) => [d.key, d]));
    for (const flag of BUILT_IN_FLAGS) {
      const declaration = byKey.get(settingKeyFor(flag.key));
      expect(declaration?.scope, flag.key).toBe(
        flag.scope === 'workspace' ? 'workspace' : 'organization',
      );
    }
  });

  // `SettingScope` has no `platform`, so a platform-scoped flag projects as
  // organization-scoped and the flag resolver refuses that layer too.
  it('projects a platform-scoped flag as organization-scoped', () => {
    const registryWithKill = createFeatureFlagRegistry([flag({ key: 'k', scope: 'platform' })]);
    expect(registryWithKill.settingDeclarations()[0]?.scope).toBe('organization');
    expect(registryWithKill.permits('k', 'organization')).toBe(false);
  });

  it('records the kind and owner in the projected description, for the catalogue', () => {
    const sso = projected.find((d) => d.key === settingKeyFor('entitlements.sso'));
    expect(sso?.description).toContain('flag:entitlement');
    expect(sso?.description).toContain('owner:platform.billing');
  });

  // The projections and the settings keys share one namespace; a collision
  // would make one shadow the other.
  it('composes into a settings registry alongside the built-in settings', () => {
    expect(() => createSettingsRegistry([...projected])).not.toThrow();
    const combined = createSettingsRegistry([...projected]);
    expect(combined.keys).toHaveLength(projected.length);
  });

  it('collides with no built-in settings key', () => {
    const settings = createSettingsRegistry();
    for (const entry of projected) {
      expect(settings.has(entry.key), entry.key).toBe(false);
    }
  });
});
