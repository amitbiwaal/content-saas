/**
 * The settings key registry.
 *
 * The registry is the contract, so what is tested here is that it refuses to be
 * an unreliable one: no duplicate keys, no default that violates its own type,
 * and no undeclared key answered by accident.
 */
import { describe, expect, it } from 'vitest';

import {
  BUILT_IN_SETTINGS,
  createSettingsRegistry,
  matchesType,
  SETTING_LAYERS,
  SETTING_TYPES,
  SettingsError,
  type SettingDeclaration,
} from './registry.js';

const declaration = (over: Partial<SettingDeclaration> = {}): SettingDeclaration => ({
  key: 'test.key',
  type: 'string',
  scope: 'workspace',
  defaultValue: 'value',
  description: 'A test setting.',
  ...over,
});

describe('the declared vocabulary', () => {
  it('declares exactly the five value types', () => {
    expect([...SETTING_TYPES].sort()).toEqual(['boolean', 'decimal', 'integer', 'json', 'string']);
  });

  // Also the resolution order, most specific first.
  it('declares the four layers in precedence order', () => {
    expect([...SETTING_LAYERS]).toEqual(['workspace', 'organization', 'platform', 'built-in']);
  });
});

describe('type matching is exact', () => {
  const CASES: [string, unknown, boolean][] = [
    ['string', 'x', true],
    ['string', 1, false],
    ['string', true, false],
    ['integer', 8, true],
    ['integer', 8.5, false],
    ['integer', '8', false],
    ['integer', Number.MAX_SAFE_INTEGER + 1, false],
    ['boolean', true, true],
    ['boolean', 'true', false],
    ['boolean', 1, false],
    ['decimal', '0.850000', true],
    ['decimal', '-1.5', true],
    ['decimal', '1', true],
    // A number would have been through a double already.
    ['decimal', 0.85, false],
    ['decimal', '0.8500001', false],
    ['decimal', '.5', false],
    ['json', {}, true],
    ['json', { a: 1 }, true],
    ['json', [], false],
    ['json', null, false],
    ['json', 'x', false],
  ];

  for (const [type, value, expected] of CASES) {
    it(`${type} ${expected ? 'accepts' : 'rejects'} ${JSON.stringify(value)}`, () => {
      expect(matchesType(type as never, value)).toBe(expected);
    });
  }
});

describe('the built-in registry', () => {
  const registry = createSettingsRegistry();

  it('builds without complaint', () => {
    expect(registry.keys.length).toBe(BUILT_IN_SETTINGS.length);
  });

  // Resolution is total: the default is the floor of every answer, so an
  // invalid one would be returned to every caller.
  it('gives every key a default of its own declared type', () => {
    for (const entry of BUILT_IN_SETTINGS) {
      expect(matchesType(entry.type, entry.defaultValue), entry.key).toBe(true);
    }
  });

  it('describes every key', () => {
    for (const entry of BUILT_IN_SETTINGS) {
      expect(entry.description.trim(), entry.key).not.toBe('');
    }
  });

  it('covers all five types, so the resolver is exercised across them', () => {
    expect(new Set(BUILT_IN_SETTINGS.map((e) => e.type))).toEqual(new Set(SETTING_TYPES));
  });

  // Rule 2, and a security control: a workspace admin must not extend their own
  // retention past what the organization bought.
  it('reserves retention, residency and SSO to the organization', () => {
    for (const key of ['retention.days', 'security.data_residency', 'security.sso_required']) {
      expect(registry.require(key).scope, key).toBe('organization');
      expect(registry.permits(key, 'workspace'), key).toBe(false);
      expect(registry.permits(key, 'organization'), key).toBe(true);
    }
  });

  it('lets a workspace set the workspace-scoped keys', () => {
    for (const key of ['content.locale', 'review.gate_threshold']) {
      expect(registry.permits(key, 'workspace'), key).toBe(true);
    }
  });

  // The scope rule constrains customer-authored layers; the operator default
  // and the floor are not layers a customer can reach.
  it('permits every key at the platform and built-in layers', () => {
    for (const entry of BUILT_IN_SETTINGS) {
      expect(registry.permits(entry.key, 'platform'), entry.key).toBe(true);
      expect(registry.permits(entry.key, 'built-in'), entry.key).toBe(true);
    }
  });
});

describe('an unknown key is refused, never guessed', () => {
  const registry = createSettingsRegistry();

  it('reports it as unknown, naming the key', () => {
    expect(() => registry.require('content.nonexistent')).toThrow(SettingsError);
    try {
      registry.require('content.nonexistent');
      expect.unreachable('must refuse');
    } catch (error) {
      expect((error as SettingsError).code).toBe('UnknownKey');
      expect((error as SettingsError).message).toContain('content.nonexistent');
    }
  });

  it('answers `has` and `find` without throwing', () => {
    expect(registry.has('content.locale')).toBe(true);
    expect(registry.has('nope')).toBe(false);
    expect(registry.find('nope')).toBeUndefined();
  });

  it('refuses to check a scope or a type for one', () => {
    expect(() => registry.permits('nope', 'workspace')).toThrow(/not a declared setting/);
    expect(() => registry.accepts('nope', 1)).toThrow(/not a declared setting/);
  });
});

describe('the registry refuses a declaration set it cannot be trusted with', () => {
  // Which type and scope apply would otherwise be decided by declaration order.
  it('rejects a duplicate key', () => {
    expect(() => createSettingsRegistry([declaration(), declaration()])).toThrow(SettingsError);
    try {
      createSettingsRegistry([declaration(), declaration()]);
      expect.unreachable('must refuse');
    } catch (error) {
      expect((error as SettingsError).code).toBe('DuplicateKey');
    }
  });

  it('rejects a default that violates its own declared type', () => {
    expect(() =>
      createSettingsRegistry([declaration({ type: 'integer', defaultValue: 'eight' })]),
    ).toThrow(/is not a valid integer/);
  });

  it('rejects a decimal default written as a number', () => {
    expect(() =>
      createSettingsRegistry([declaration({ type: 'decimal', defaultValue: 0.85 })]),
    ).toThrow(/not a valid decimal/);
  });

  it('rejects an unknown type', () => {
    expect(() => createSettingsRegistry([declaration({ type: 'timestamp' as never })])).toThrow(
      /unknown type/,
    );
  });

  it('rejects an undescribed key', () => {
    expect(() => createSettingsRegistry([declaration({ description: '  ' })])).toThrow(
      /nobody can discover/,
    );
  });

  // Failing at construction rather than at first use: this is a deployment
  // error, and the process should refuse to start.
  it('fails at construction, not at the first read', () => {
    let built = false;
    try {
      createSettingsRegistry([declaration(), declaration()]);
      built = true;
    } catch {
      built = false;
    }
    expect(built).toBe(false);
  });
});

describe('coercion narrows or refuses', () => {
  const registry = createSettingsRegistry();

  it('returns a value of the declared type unchanged', () => {
    expect(registry.coerce('content.reading_grade_min', 9)).toBe(9);
    expect(registry.coerce('review.gate_threshold', '0.900000')).toBe('0.900000');
    expect(registry.coerce('routing.tier_preferences', { draft: 'fast' })).toEqual({
      draft: 'fast',
    });
  });

  it('refuses a value of the wrong type, naming both', () => {
    try {
      registry.coerce('content.reading_grade_min', '9');
      expect.unreachable('must refuse');
    } catch (error) {
      expect((error as SettingsError).code).toBe('InvalidType');
      expect((error as SettingsError).message).toContain('integer');
      expect((error as SettingsError).message).toContain('string');
    }
  });

  it('describes an array and a null distinctly', () => {
    expect(() => registry.coerce('routing.tier_preferences', [])).toThrow(/an array/);
    expect(() => registry.coerce('routing.tier_preferences', null)).toThrow(/null/);
  });
});
