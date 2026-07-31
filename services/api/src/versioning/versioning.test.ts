import { describe, expect, it } from 'vitest';

import {
  API_VERSION_HEADER,
  DEPRECATION_HEADER,
  LINK_HEADER,
  negotiateVersion,
  SUNSET_HEADER,
  versionFromPath,
  versionHeaders,
} from './negotiate.js';
import {
  API_VERSION_STATUSES,
  createVersionRegistry,
  MINIMUM_DEPRECATION_MONTHS,
  VersionRegistryError,
  type ApiVersion,
} from './registry.js';

const V1: ApiVersion = { version: 'v1', status: 'current', releasedAt: '2026-01-01T00:00:00.000Z' };

const DEPRECATED: ApiVersion = {
  version: 'v1',
  status: 'deprecated',
  releasedAt: '2024-01-01T00:00:00.000Z',
  deprecatedAt: '2026-03-01T00:00:00.000Z',
  sunsetAt: '2026-09-01T00:00:00.000Z',
  migrationGuide: 'https://docs.contentos.ai/api/v2/migration',
};

const SUNSET: ApiVersion = { ...DEPRECATED, status: 'sunset' };
const V2: ApiVersion = { version: 'v2', status: 'current', releasedAt: '2026-03-01T00:00:00.000Z' };

describe('the registry', () => {
  it('holds the declared versions in order and names the current one', () => {
    const registry = createVersionRegistry({ versions: [DEPRECATED, V2] });
    expect(registry.versions.map((entry) => entry.version)).toEqual(['v1', 'v2']);
    expect(registry.current.version).toBe('v2');
  });

  it('finds a version and reports null for one it does not have', () => {
    const registry = createVersionRegistry({ versions: [V1] });
    expect(registry.find('v1')?.status).toBe('current');
    expect(registry.find('v2')).toBeNull();
  });

  it('lists only the versions that still serve', () => {
    const registry = createVersionRegistry({ versions: [SUNSET, V2] });
    expect(registry.serving().map((entry) => entry.version)).toEqual(['v2']);
  });

  it('declares the four statuses the increment names', () => {
    expect([...API_VERSION_STATUSES]).toEqual(['current', 'supported', 'deprecated', 'sunset']);
  });
});

describe('what the registry refuses', () => {
  it('refuses an empty set', () => {
    expect(() => createVersionRegistry({ versions: [] })).toThrow(VersionRegistryError);
  });

  it('refuses a version that is not a path segment', () => {
    for (const version of ['1', 'V1', 'v0', 'v1.1', 'latest']) {
      expect(() => {
        createVersionRegistry({ versions: [{ ...V1, version }] });
      }, version).toThrow(/not a version segment/);
    }
  });

  it('refuses a duplicate version', () => {
    expect(() => createVersionRegistry({ versions: [V1, V1] })).toThrow(/declared twice/);
  });

  it('requires exactly one current version', () => {
    expect(() => createVersionRegistry({ versions: [SUNSET] })).toThrow(/must be current/);
    expect(() => createVersionRegistry({ versions: [V1, { ...V2, version: 'v3' }] })).toThrow(
      /only be one/,
    );
  });

  it('refuses a deprecation with no schedule or destination', () => {
    // A deprecation announced without a date and a destination is one nobody
    // can act on, and the header would advertise a window with no end.
    const { sunsetAt, ...noSunset } = DEPRECATED;
    expect(() => createVersionRegistry({ versions: [noSunset, V2] })).toThrow(
      /deprecatedAt, sunsetAt and a migrationGuide/,
    );
    expect(sunsetAt).toBeDefined();

    const { migrationGuide, ...noGuide } = DEPRECATED;
    expect(() => createVersionRegistry({ versions: [noGuide, V2] })).toThrow(VersionRegistryError);
    expect(migrationGuide).toBeDefined();
  });

  it('enforces the six-month migration window', () => {
    // `api-versioning.md` rule 13. A shorter window converts a migration into
    // an incident.
    expect(MINIMUM_DEPRECATION_MONTHS).toBe(6);
    expect(() =>
      createVersionRegistry({
        versions: [{ ...DEPRECATED, sunsetAt: '2026-06-01T00:00:00.000Z' }, V2],
      }),
    ).toThrow(/the minimum is 6/);
  });

  it('accepts exactly six months', () => {
    expect(() =>
      createVersionRegistry({
        versions: [{ ...DEPRECATED, sunsetAt: '2026-09-01T00:00:00.000Z' }, V2],
      }),
    ).not.toThrow();
  });

  it('honours a configured policy over the default', () => {
    expect(() =>
      createVersionRegistry({
        versions: [{ ...DEPRECATED, sunsetAt: '2026-05-01T00:00:00.000Z' }, V2],
        policy: { minimumDeprecationMonths: 2 },
      }),
    ).not.toThrow();
  });

  it('refuses an unparseable date', () => {
    expect(() => createVersionRegistry({ versions: [{ ...V1, releasedAt: 'soon' }] })).toThrow(
      /unparseable/,
    );
  });
});

describe('the registry is immutable', () => {
  const registry = createVersionRegistry({ versions: [DEPRECATED, V2] });

  it('is frozen through', () => {
    expect(Object.isFrozen(registry)).toBe(true);
    expect(Object.isFrozen(registry.versions)).toBe(true);
    expect(Object.isFrozen(registry.versions[0])).toBe(true);
    expect(Object.isFrozen(registry.policy)).toBe(true);
  });

  it('refuses a write rather than accepting one a cast made legal', () => {
    // A version set that changed under a running process would make two
    // identical requests get different answers about what the API even is.
    expect(() => {
      (registry as unknown as { current: unknown }).current = V1;
    }).toThrow(TypeError);
    expect(() => {
      (registry.versions as unknown as { push: (v: unknown) => void }).push(V1);
    }).toThrow(TypeError);
  });

  it('does not alias the array it was built from', () => {
    const versions = [V1];
    const built = createVersionRegistry({ versions });
    versions.push(V2);
    expect(built.versions).toHaveLength(1);
  });
});

describe('reading the version from a path', () => {
  it('takes the first segment', () => {
    expect(versionFromPath('/v1/ai/execute')).toBe('v1');
    expect(versionFromPath('v1/ai/execute')).toBe('v1');
  });

  it('ignores a query string', () => {
    expect(versionFromPath('/v1/ai/stream?resumeToken=x')).toBe('v1');
  });

  it('reads only the FIRST segment, so a later `v2` is a resource name', () => {
    expect(versionFromPath('/v1/ai/jobs/v2')).toBe('v1');
  });

  it('reports nothing for a path with no segments', () => {
    expect(versionFromPath('/')).toBeNull();
    expect(versionFromPath('')).toBeNull();
  });
});

describe('negotiation', () => {
  const registry = createVersionRegistry({ versions: [DEPRECATED, V2] });

  it('serves a current version', () => {
    const result = negotiateVersion(createVersionRegistry({ versions: [V1] }), '/v1/ai/execute');
    expect(result.outcome).toBe('serve');
    expect(result.headers[API_VERSION_HEADER]).toBe('v1');
  });

  it('serves a supported version', () => {
    const supported = createVersionRegistry({
      versions: [
        { ...V1, status: 'supported' },
        { ...V2, version: 'v2' },
      ],
    });
    expect(negotiateVersion(supported, '/v1/ai/execute').outcome).toBe('serve');
  });

  it('serves a deprecated version, with the whole schedule announced', () => {
    const result = negotiateVersion(registry, '/v1/ai/execute');
    expect(result.outcome).toBe('serve');
    expect(result.headers).toEqual({
      [API_VERSION_HEADER]: 'v1',
      [DEPRECATION_HEADER]: 'Sun, 01 Mar 2026 00:00:00 GMT',
      [SUNSET_HEADER]: 'Tue, 01 Sep 2026 00:00:00 GMT',
      [LINK_HEADER]: '<https://docs.contentos.ai/api/v2/migration>; rel="deprecation"',
    });
  });

  it('retires a sunset version rather than serving it', () => {
    const sunset = createVersionRegistry({ versions: [SUNSET, V2] });
    const result = negotiateVersion(sunset, '/v1/ai/execute');

    expect(result.outcome).toBe('retired');
    // The schedule still rides along: a client hitting a 410 needs the link.
    expect(result.headers[LINK_HEADER]).toContain('rel="deprecation"');
  });

  it('rejects an unknown version rather than defaulting to the newest', () => {
    // "Defaulting to the newest lets an attacker probe for a version with
    // weaker checks."
    const result = negotiateVersion(registry, '/v99/ai/execute');
    expect(result).toMatchObject({ outcome: 'unsupported', requested: 'v99' });
  });

  it('names the current version even when refusing, which is the actionable part', () => {
    const result = negotiateVersion(registry, '/v99/ai/execute');
    expect(result.headers[API_VERSION_HEADER]).toBe('v2');
  });

  it('rejects a path carrying no version at all', () => {
    expect(negotiateVersion(registry, '/')).toMatchObject({
      outcome: 'unsupported',
      requested: null,
    });
  });

  it('produces no deprecation headers for a live version', () => {
    const headers = versionHeaders(V1);
    expect(Object.keys(headers)).toEqual([API_VERSION_HEADER]);
  });

  it('is deterministic', () => {
    expect(negotiateVersion(registry, '/v1/ai/execute')).toEqual(
      negotiateVersion(registry, '/v1/ai/execute'),
    );
  });
});
