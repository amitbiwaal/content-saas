import type { Principal } from '@contentos/security';
import { describe, expect, it } from 'vitest';

import {
  createPolicySet,
  isRateLimitScope,
  policiesFor,
  RATE_LIMIT_SCOPES,
  rateLimitKey,
  RateLimitConfigError,
  type RateLimitPolicy,
  type RateLimitSubject,
} from './policy.js';

const ORG = 'org-1';
const WS = 'ws-1';

const principal = (overrides: Partial<Principal> = {}): Principal => ({
  subjectId: 'user-1',
  kind: 'user',
  method: 'password',
  organizationId: ORG,
  workspaceId: WS,
  roles: ['editor'],
  permissions: ['article:execute'],
  authenticatedAt: new Date('2026-07-31T12:00:00.000Z'),
  mfaSatisfied: true,
  sessionId: null,
  ...overrides,
});

const subject = (overrides: Partial<RateLimitSubject> = {}): RateLimitSubject => ({
  principal: principal(),
  apiKeyId: 'key-1',
  ipAddress: '198.51.100.4',
  ...overrides,
});

const policy = (overrides: Partial<RateLimitPolicy> = {}): RateLimitPolicy => ({
  name: 'p',
  scope: 'user',
  limit: 10,
  windowSeconds: 60,
  ...overrides,
});

describe('the scope vocabulary', () => {
  it('covers every dimension the increment names', () => {
    expect([...RATE_LIMIT_SCOPES]).toEqual(['api-key', 'user', 'workspace', 'organization', 'ip']);
  });

  it('rejects anything outside it', () => {
    expect(isRateLimitScope('tenant')).toBe(false);
    expect(isRateLimitScope(7)).toBe(false);
  });
});

describe('configuring policies', () => {
  it('accepts a set and freezes it', () => {
    const set = createPolicySet([policy(), policy({ name: 'q', scope: 'ip' })]);
    expect(set).toHaveLength(2);
    expect(Object.isFrozen(set[0])).toBe(true);
  });

  it('refuses an empty set', () => {
    // An unconfigured limiter allows everything while looking installed — the
    // failure mode that only surfaces in an incident review.
    expect(() => createPolicySet([])).toThrow(RateLimitConfigError);
  });

  it('refuses duplicate names, which the 429 could not tell apart', () => {
    expect(() => createPolicySet([policy(), policy()])).toThrow(/Duplicate policy name/);
  });

  it('refuses a nameless policy', () => {
    expect(() => createPolicySet([policy({ name: '  ' })])).toThrow(RateLimitConfigError);
  });

  it('refuses a limit that would block everything', () => {
    for (const limit of [0, -1, 1.5]) {
      expect(() => createPolicySet([policy({ limit })]), String(limit)).toThrow(
        RateLimitConfigError,
      );
    }
  });

  it('refuses a window shorter than a second', () => {
    for (const windowSeconds of [0, -5, 0.5]) {
      expect(() => createPolicySet([policy({ windowSeconds })])).toThrow(RateLimitConfigError);
    }
  });

  it('refuses an unknown scope', () => {
    expect(() =>
      createPolicySet([policy({ scope: 'tenant' as RateLimitPolicy['scope'] })]),
    ).toThrow(/not one of/);
  });

  it('sets no default values, because nothing may invent a commercial limit', () => {
    // `04-platform/rate-limiting.md` owns the numbers and has not set them.
    // A default here would be a constraint nobody agreed to.
    expect(() => createPolicySet([])).toThrow();
  });
});

describe('the key a policy counts against', () => {
  it('tenant-prefixes the one scope that is genuinely tenant data', () => {
    // `cos:{tenantId}:{namespace}:{key}` — begins with the tenant, so a whole
    // tenant is scannable and deletable with one pattern.
    expect(rateLimitKey(policy({ scope: 'workspace' }), subject())).toBe(
      'cos:ws-1:ratelimit:p:workspace',
    );
  });

  it('puts every scope owned by no tenant in the reserved global namespace', () => {
    expect(rateLimitKey(policy({ scope: 'ip' }), subject())).toBe(
      'cos:global:ratelimit:p:ip:198.51.100.4',
    );
    expect(rateLimitKey(policy({ scope: 'organization' }), subject())).toBe(
      'cos:global:ratelimit:p:organization:org-1',
    );
    expect(rateLimitKey(policy({ scope: 'user' }), subject())).toBe(
      'cos:global:ratelimit:p:user:user-1',
    );
    expect(rateLimitKey(policy({ scope: 'api-key' }), subject())).toBe(
      'cos:global:ratelimit:p:api-key:key-1',
    );
  });

  it('gives one user one bucket, not one per workspace they belong to', () => {
    // A workspace-prefixed user key would hand a member of ten workspaces ten
    // times the quota, and let them reset a spent one by switching.
    for (const scope of ['user', 'api-key'] as const) {
      const here = rateLimitKey(policy({ scope }), subject());
      const elsewhere = rateLimitKey(
        policy({ scope }),
        subject({ principal: principal({ workspaceId: 'ws-2' }) }),
      );
      expect(here, scope).toBe(elsewhere);
    }
  });

  it('keeps an organization in one bucket rather than one per workspace', () => {
    const first = rateLimitKey(policy({ scope: 'organization' }), subject());
    const second = rateLimitKey(
      policy({ scope: 'organization' }),
      subject({ principal: principal({ workspaceId: 'ws-2' }) }),
    );
    expect(first).toBe(second);
  });

  it('gives one address one bucket across every tenant', () => {
    // A per-workspace IP key would let a caller reset its own IP quota by
    // switching workspace, which is the evasion the scope exists to close.
    const first = rateLimitKey(policy({ scope: 'ip' }), subject());
    const second = rateLimitKey(
      policy({ scope: 'ip' }),
      subject({ principal: principal({ workspaceId: 'ws-2', organizationId: 'org-2' }) }),
    );
    expect(first).toBe(second);
  });

  it('counts a bearer token under its subject when there is no key id', () => {
    expect(rateLimitKey(policy({ scope: 'api-key' }), subject({ apiKeyId: null }))).toBe(
      'cos:global:ratelimit:p:api-key:user-1',
    );
  });

  it('gives one workspace one bucket regardless of who is calling', () => {
    const first = rateLimitKey(policy({ scope: 'workspace' }), subject());
    const second = rateLimitKey(
      policy({ scope: 'workspace' }),
      subject({ principal: principal({ subjectId: 'user-2' }) }),
    );
    expect(first).toBe(second);
  });

  it('strips separators, so no value can forge a prefix boundary', () => {
    // A colon in a segment would let a crafted id address another tenant's
    // bucket — either to read its budget or to exhaust it.
    const forged = rateLimitKey(
      policy({ scope: 'workspace' }),
      subject({ principal: principal({ workspaceId: 'a:cos:ws-2:ratelimit:p:workspace' }) }),
    );
    expect(forged).toBe('cos:acosws-2ratelimitpworkspace:ratelimit:p:workspace');
  });

  it('is deterministic', () => {
    expect(rateLimitKey(policy(), subject())).toBe(rateLimitKey(policy(), subject()));
  });
});

describe('which policies apply', () => {
  it('applies an unclassed policy to every class', () => {
    const set = [policy({ name: 'all' })];
    expect(policiesFor(set, 'read')).toHaveLength(1);
    expect(policiesFor(set, 'expensive')).toHaveLength(1);
  });

  it('applies a classed policy only to its class', () => {
    const set = [
      policy({ name: 'reads', appliesTo: 'read' }),
      policy({ name: 'spend', appliesTo: 'expensive' }),
    ];
    expect(policiesFor(set, 'read').map((p) => p.name)).toEqual(['reads']);
    expect(policiesFor(set, 'expensive').map((p) => p.name)).toEqual(['spend']);
  });

  it('returns nothing when no policy covers a class', () => {
    expect(policiesFor([policy({ appliesTo: 'auth' })], 'read')).toEqual([]);
  });
});
