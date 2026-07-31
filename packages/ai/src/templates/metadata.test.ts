import { describe, expect, it } from 'vitest';

import {
  compareSemanticVersions,
  formatSemanticVersion,
  isSemanticallyCompatible,
  isTemplateVisibility,
  parseSemanticVersion,
  TEMPLATE_VISIBILITIES,
  type SemanticVersion,
} from './metadata.js';

const at = (value: string): SemanticVersion => {
  const parsed = parseSemanticVersion(value);
  if (parsed === null) throw new Error(`'${value}' should have parsed`);
  return parsed;
};

describe('parsing a semantic version', () => {
  it('reads major, minor and patch', () => {
    expect(parseSemanticVersion('2.10.3')).toEqual({ major: 2, minor: 10, patch: 3 });
    expect(parseSemanticVersion('0.0.0')).toEqual({ major: 0, minor: 0, patch: 0 });
  });

  it('refuses anything that is not exactly three numbers', () => {
    // Ranges, prefixes and pre-releases are refused because they would make
    // resolution a guess — "reject ambiguous versions".
    for (const value of ['1', '1.2', '1.2.3.4', 'v1.2.3', '^1.2.3', '~1.2.3', '1.2.x', '']) {
      expect(parseSemanticVersion(value), value).toBeNull();
    }
  });

  it('refuses a leading zero, which would make two strings one version', () => {
    expect(parseSemanticVersion('01.2.3')).toBeNull();
    expect(parseSemanticVersion('1.02.3')).toBeNull();
  });

  it('refuses a pre-release or build metadata', () => {
    expect(parseSemanticVersion('1.2.3-beta.1')).toBeNull();
    expect(parseSemanticVersion('1.2.3+build.5')).toBeNull();
  });

  it('freezes what it returns', () => {
    expect(Object.isFrozen(at('1.0.0'))).toBe(true);
  });

  it('round-trips through formatting', () => {
    for (const value of ['0.0.1', '1.2.3', '10.20.30']) {
      expect(formatSemanticVersion(at(value)), value).toBe(value);
    }
  });
});

describe('ordering', () => {
  it('orders by major, then minor, then patch', () => {
    expect(compareSemanticVersions(at('1.0.0'), at('2.0.0'))).toBeLessThan(0);
    expect(compareSemanticVersions(at('1.2.0'), at('1.10.0'))).toBeLessThan(0);
    expect(compareSemanticVersions(at('1.2.3'), at('1.2.4'))).toBeLessThan(0);
    expect(compareSemanticVersions(at('2.0.0'), at('1.9.9'))).toBeGreaterThan(0);
  });

  it('reports equality as zero', () => {
    expect(compareSemanticVersions(at('1.2.3'), at('1.2.3'))).toBe(0);
  });

  it('is total, so a sort is stable', () => {
    const sorted = ['1.10.0', '2.0.0', '1.2.0', '1.2.1']
      .map(at)
      .sort(compareSemanticVersions)
      .map(formatSemanticVersion);
    expect(sorted).toEqual(['1.2.0', '1.2.1', '1.10.0', '2.0.0']);
  });
});

describe('compatibility', () => {
  it('accepts a newer version inside the same major', () => {
    expect(isSemanticallyCompatible(at('1.2.0'), at('1.2.0'))).toBe(true);
    expect(isSemanticallyCompatible(at('1.2.0'), at('1.2.5'))).toBe(true);
    expect(isSemanticallyCompatible(at('1.2.0'), at('1.9.0'))).toBe(true);
  });

  it('refuses an older version', () => {
    // A caller built against 1.2.0 does not get 1.1.0: the features it uses may
    // not exist there.
    expect(isSemanticallyCompatible(at('1.2.0'), at('1.1.9'))).toBe(false);
  });

  it('never crosses a major, in either direction', () => {
    // A major bump is what an author declares when a change breaks callers.
    expect(isSemanticallyCompatible(at('1.2.0'), at('2.0.0'))).toBe(false);
    expect(isSemanticallyCompatible(at('2.0.0'), at('1.9.9'))).toBe(false);
  });

  it('treats 0.x as its own major, which is what the numbering means', () => {
    expect(isSemanticallyCompatible(at('0.1.0'), at('0.2.0'))).toBe(true);
    expect(isSemanticallyCompatible(at('0.1.0'), at('1.0.0'))).toBe(false);
  });
});

describe('visibility', () => {
  it('declares exactly the two levels', () => {
    expect([...TEMPLATE_VISIBILITIES]).toEqual(['public', 'internal']);
  });

  it('recognises one and nothing else', () => {
    expect(isTemplateVisibility('public')).toBe(true);
    expect(isTemplateVisibility('internal')).toBe(true);
    expect(isTemplateVisibility('secret')).toBe(false);
    expect(isTemplateVisibility(undefined)).toBe(false);
  });
});
