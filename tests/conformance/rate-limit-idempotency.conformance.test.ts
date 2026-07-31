/**
 * Rate limiting and idempotency against the documents that constrain them, and
 * against the code they are wired into.
 *
 * ── What only this file can check ───────────────────────────────────────────
 *
 * 1. THE FROZEN PORT IS THE ONE USED. `pipeline/stages.ts` declared
 *    `RateLimiter` in Sprint 0 and `rateLimitPreAuth` / `rateLimitPostAuth`
 *    already call it. If this increment had introduced a second limiter
 *    interface, the pre-auth stage and the new enforcer would be enforcing
 *    against different contracts. Asserted by USING the new implementation
 *    through the old stages.
 *
 * 2. THE KEY RULES. `16-security/tenant-isolation.md` freezes
 *    `cos:{tenantId}:{namespace}:{key}` and reserves `cos:global:`. A key that
 *    drifted from that is not visible to any unit test of the limiter, because
 *    the limiter treats a key as opaque.
 *
 * 3. NO SECOND CACHE, NO SECOND EXECUTION TRACKER. Structural: the way "no
 *    duplicate caching layer" stops being true is one Map at a time.
 *
 * 4. THE DIVERGENCES, recorded so they cannot be forgotten.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  API_ERROR_MESSAGES,
  AI_ROUTES,
  canonicalize,
  createIdempotencyGuard,
  createPolicySet,
  createRateLimitEnforcer,
  createRedisIdempotencyStore,
  createRedisRateLimiter,
  fingerprintOf,
  IDEMPOTENCY_TTL_SECONDS,
  idempotencyKeyFor,
  rateLimitHeaders,
  rateLimitKey,
  RATE_LIMIT_CLASSES,
  RATE_LIMIT_SCOPES,
  rateLimitPostAuth,
  rateLimitPreAuth,
  SLIDING_WINDOW_SCRIPT,
  type RateLimitPolicy,
  type RateLimitSubject,
  type RedisCommands,
} from '@contentos/api';
import type { Principal } from '@contentos/security';
import { describe, expect, it } from 'vitest';

const START = Date.UTC(2026, 6, 31, 12, 0, 0);

const sourceOf = (relative: string): string =>
  readFileSync(
    fileURLToPath(new URL(`../../services/api/src/${relative}`, import.meta.url)),
    'utf8',
  );

const codeOf = (relative: string): string =>
  sourceOf(relative)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

const principal = (overrides: Partial<Principal> = {}): Principal => ({
  subjectId: 'user-1',
  kind: 'user',
  method: 'password',
  organizationId: 'org-1',
  workspaceId: 'ws-1',
  roles: ['editor'],
  permissions: ['article:execute'],
  authenticatedAt: new Date(START),
  mfaSatisfied: true,
  sessionId: null,
  ...overrides,
});

const subject: RateLimitSubject = {
  principal: principal(),
  apiKeyId: 'key-1',
  ipAddress: '198.51.100.4',
};

/**
 * A Redis that runs the real scripts.
 *
 * Deliberately re-declared here rather than imported from the service's own
 * fixture: `tests/` is not a workspace package and reaches `@contentos/api`
 * through its public barrel, which does not export test scaffolding. What is
 * shared is the SCRIPT, which is the artefact that ships.
 */
function windowStore(clock: { ms: number }): RedisCommands {
  const sets = new Map<string, { score: number; member: string }[]>();
  const counters = new Map<string, number>();

  return {
    // eslint-disable-next-line @typescript-eslint/require-await
    async eval(script, keys, args): Promise<unknown> {
      if (!script.includes('ZREMRANGEBYSCORE')) throw new Error('unexpected script');
      const key = keys[0] as string;
      const seqKey = keys[1] as string;
      const limit = Number(args[0]);
      const windowMs = Number(args[1]);
      const nowMs = clock.ms;

      const entries = (sets.get(key) ?? []).filter((e) => e.score > nowMs - windowMs);
      let used = entries.length;
      let allowed = 0;
      if (used < limit) {
        const seq = (counters.get(seqKey) ?? 0) + 1;
        counters.set(seqKey, seq);
        entries.push({ score: nowMs, member: `${String(nowMs)}-${String(seq)}` });
        used += 1;
        allowed = 1;
      }
      sets.set(key, entries);
      const oldest = entries[0];
      const resetMs = oldest === undefined ? windowMs : oldest.score + windowMs - nowMs;
      return [allowed, limit - used, Math.max(0, resetMs)];
    },
  };
}

// ── 1 · The frozen port is the one used ─────────────────────────────────────

describe('the limiter implements the port Sprint 0 froze', () => {
  it('satisfies `RateLimiter`, so the pre-auth stage can use this very object', async () => {
    // If a second interface had been introduced, this would not compile — and
    // the pre-auth IP stage would be enforcing against a different contract
    // from the post-auth policies.
    const clock = { ms: START };
    const limiter = createRedisRateLimiter({ redis: windowStore(clock) });

    const first = await rateLimitPreAuth(
      {
        method: 'POST',
        path: '/v1/ai/execute',
        headers: {},
        ip: '198.51.100.4',
        contentLength: 0,
        body: null,
        cookies: {},
      },
      limiter,
      { limit: 1, windowSeconds: 60 },
    );
    expect(first.ok).toBe(true);

    const second = await rateLimitPreAuth(
      {
        method: 'POST',
        path: '/v1/ai/execute',
        headers: {},
        ip: '198.51.100.4',
        contentLength: 0,
        body: null,
        cookies: {},
      },
      limiter,
      { limit: 1, windowSeconds: 60 },
    );
    expect(second).toMatchObject({ ok: false, status: 429, code: 'RATE_LIMITED' });
    expect(second.headers?.['Retry-After']).toBeDefined();
  });

  it('drives the post-auth stage too, on the same window', async () => {
    const clock = { ms: START };
    const limiter = createRedisRateLimiter({ redis: windowStore(clock) });

    expect(
      (await rateLimitPostAuth('user-1', 'ws-1', limiter, { limit: 1, windowSeconds: 60 })).ok,
    ).toBe(true);
    expect(
      (await rateLimitPostAuth('user-1', 'ws-1', limiter, { limit: 1, windowSeconds: 60 })).ok,
    ).toBe(false);
  });

  it('declares no second limiter interface anywhere in the service', () => {
    for (const file of ['ratelimit/redis-limiter.ts', 'ratelimit/enforcer.ts']) {
      expect(codeOf(file), file).not.toMatch(/interface\s+RateLimiter\b/);
      expect(codeOf(file), file).not.toMatch(/interface\s+RateLimitDecision\b/);
    }
    expect(codeOf('ratelimit/redis-limiter.ts')).toContain("from '../pipeline/stages.js'");
  });
});

// ── 2 · Key rules ───────────────────────────────────────────────────────────

describe('every key obeys `16-security/tenant-isolation.md`', () => {
  const policy = (over: Partial<RateLimitPolicy> = {}): RateLimitPolicy => ({
    name: 'p',
    scope: 'user',
    limit: 10,
    windowSeconds: 60,
    ...over,
  });

  it('begins with `cos:` and names a namespace', () => {
    for (const scope of RATE_LIMIT_SCOPES) {
      const key = rateLimitKey(policy({ scope }), subject);
      expect(key, scope).toMatch(/^cos:[^:]+:[a-z]+:/);
    }
    expect(idempotencyKeyFor('ws-1', 'k')).toMatch(/^cos:ws-1:idempotency:/);
  });

  it('uses the reserved global namespace only for data owned by no tenant', () => {
    const globals = RATE_LIMIT_SCOPES.filter((scope) =>
      rateLimitKey(policy({ scope }), subject).startsWith('cos:global:'),
    );
    // A workspace bucket IS tenant data; the other four are owned by a key, a
    // person, a customer and an address respectively.
    expect([...globals].sort()).toEqual(['api-key', 'ip', 'organization', 'user']);
  });

  it('tenant-prefixes the idempotency record, so two tenants never collide', () => {
    expect(idempotencyKeyFor('ws-1', 'same-key')).not.toBe(idempotencyKeyFor('ws-2', 'same-key'));
  });

  it('constructs keys rather than accepting them', () => {
    // "A client-supplied path segment permits traversal into another tenant's
    // prefix" — so no separator from any input survives.
    const forged = idempotencyKeyFor('ws-1', '../../cos:ws-2:idempotency:victim');
    expect(forged.split(':')).toHaveLength(4);
    expect(forged.startsWith('cos:ws-1:idempotency:')).toBe(true);
  });
});

// ── 3 · No second cache, no second execution tracker ────────────────────────

describe('no duplicate infrastructure', () => {
  const FILES = [
    'ratelimit/policy.ts',
    'ratelimit/redis-limiter.ts',
    'ratelimit/enforcer.ts',
    'idempotency/fingerprint.ts',
    'idempotency/store.ts',
    'idempotency/guard.ts',
  ];

  it('keeps no in-memory production state', () => {
    // "No in-memory production state" — two API instances counting separately
    // would each allow the full limit, which is the whole reason the counter is
    // shared. A Map here would be exactly that.
    for (const file of FILES) {
      expect(codeOf(file), file).not.toMatch(/new Map\(|new Set\(|new WeakMap\(/);
    }
  });

  it('tracks execution only through the idempotency claim', () => {
    // No second registry of what has run: the claim IS the record.
    for (const file of FILES) {
      expect(codeOf(file), file).not.toMatch(/\bexecuted\b|\bseenRequests\b|\bcache\b/i);
    }
  });

  it('imports no provider adapter, workflow runtime or database driver', () => {
    for (const file of FILES) {
      const imports = [...codeOf(file).matchAll(/from '([^']+)'/g)].map((match) => match[1]);
      for (const forbidden of ['@contentos/ai', '@contentos/database', 'ioredis', 'pg']) {
        expect(imports, `${file} / ${String(forbidden)}`).not.toContain(forbidden);
      }
    }
  });

  it('reads no clock of its own in the limiter — Redis owns the window', () => {
    // Several API instances with drifting clocks would otherwise disagree about
    // where a window starts, and the effective limit would depend on which
    // instance a request landed on.
    expect(codeOf('ratelimit/redis-limiter.ts')).not.toContain('Date.now()');
    expect(SLIDING_WINDOW_SCRIPT).toContain("redis.call('TIME')");
  });

  it('keeps controllers unaware that a limiter or a claim exists', () => {
    // `idempotencyKey` on an admitted AIRequest is a different thing entirely —
    // it identifies the ATTEMPT to a provider. What must not appear is any
    // import of, or reference to, the middleware that guards the pipeline.
    const controllers = codeOf('ai/controllers.ts');
    const imports = [...controllers.matchAll(/from '([^']+)'/g)].map((match) => match[1]);

    expect(imports).not.toContain('../ratelimit/enforcer.js');
    expect(imports).not.toContain('../idempotency/guard.js');
    expect(imports.some((path) => path?.includes('ratelimit'))).toBe(false);
    expect(imports.some((path) => path?.includes('idempotency'))).toBe(false);
    expect(controllers).not.toContain('x-ratelimit');
    expect(controllers).not.toContain('IdempotencyGuard');
    expect(controllers).not.toContain('RateLimitEnforcer');
  });
});

// ── The contract, as the documents state it ─────────────────────────────────

describe('the canonical headers match `06-api/api-principles.md`', () => {
  it('is exactly the three the document shows', () => {
    const headers = rateLimitHeaders(
      { name: 'p', scope: 'user', limit: 1000, windowSeconds: 60 },
      { allowed: true, remaining: 847, resetSeconds: 30 },
      new Date(START),
    );
    expect(Object.keys(headers).sort()).toEqual([
      'x-ratelimit-limit',
      'x-ratelimit-remaining',
      'x-ratelimit-reset',
    ]);
    expect(headers['x-ratelimit-limit']).toBe('1000');
    expect(headers['x-ratelimit-remaining']).toBe('847');
  });

  it('reports the reset as a Unix timestamp, as the example does', () => {
    const headers = rateLimitHeaders(
      { name: 'p', scope: 'user', limit: 1, windowSeconds: 60 },
      { allowed: true, remaining: 0, resetSeconds: 30 },
      new Date(START),
    );
    const reset = Number(headers['x-ratelimit-reset']);
    expect(reset).toBe(Math.floor(START / 1000) + 30);
    expect(reset).toBeGreaterThan(1_700_000_000);
  });

  it('declares the four classes the document declares', () => {
    expect([...RATE_LIMIT_CLASSES]).toEqual(['read', 'write', 'expensive', 'auth']);
  });

  it('gives every route a class, so none is limited by accident', () => {
    for (const route of AI_ROUTES) {
      expect(RATE_LIMIT_CLASSES, route.pattern).toContain(route.rateLimitClass);
    }
  });
});

describe('idempotency matches the frozen contract, except where flagged', () => {
  it('uses the 24-hour window the document sets', () => {
    expect(IDEMPOTENCY_TTL_SECONDS).toBe(24 * 60 * 60);
  });

  it('scopes per tenant and per endpoint, as the document requires', () => {
    const base = { principal: principal(), method: 'POST', body: { a: 1 } };
    const here = fingerprintOf({ ...base, endpoint: '/v1/ai/execute' });

    expect(here).not.toBe(fingerprintOf({ ...base, endpoint: '/v1/ai/stream' }));
    expect(here).not.toBe(
      fingerprintOf({
        ...base,
        endpoint: '/v1/ai/execute',
        principal: principal({ workspaceId: 'ws-2' }),
      }),
    );
  });

  it('is deterministic across serialization order', () => {
    expect(canonicalize({ z: 1, a: { y: 2, b: 3 } })).toBe(
      canonicalize({ a: { b: 3, y: 2 }, z: 1 }),
    );
  });

  it('RECORDS THE DIVERGENCE: the spec says 422, this increment says 409', () => {
    // `06-api/api-principles.md` ("Retry, same key, different body → 422") and
    // `16-security/api-security.md` rule 7 both freeze 422 for a reused key
    // with a different body. This increment specifies 409 explicitly, and 409
    // is what ships. The assertion exists so the divergence is a decision on
    // the record rather than something discovered by a client.
    const store = createRedisIdempotencyStore({
      redis: {
        eval: () =>
          Promise.resolve([
            0,
            JSON.stringify({
              state: 'completed',
              fingerprint: 'a-different-request',
              response: { status: 200, headers: {}, body: 'the first response' },
            }),
          ]),
      },
    });
    const guard = createIdempotencyGuard({ store });

    return guard
      .begin({
        principal: principal(),
        method: 'POST',
        endpoint: '/v1/ai/execute',
        body: { a: 1 },
        clientKey: 'idem-1',
        requestId: 'req-1',
      })
      .then((outcome) => {
        expect(outcome.outcome).toBe('refused');
        if (outcome.outcome !== 'refused') return;
        expect(outcome.response.status).toBe(409);
        expect(outcome.response.status).not.toBe(422);
      });
  });
});

describe('what a caller is never told', () => {
  it('has a safe message for every new code, derived from the code', () => {
    for (const code of [
      'rate_limited',
      'idempotency_conflict',
      'idempotency_in_progress',
      'service_unavailable',
    ] as const) {
      expect(API_ERROR_MESSAGES[code]).toBeTruthy();
      expect(API_ERROR_MESSAGES[code]).not.toContain('cos:');
      expect(API_ERROR_MESSAGES[code]).not.toContain('Redis');
      expect(API_ERROR_MESSAGES[code]).not.toContain('sliding');
    }
  });

  it('names no Redis key, algorithm or fingerprint in any message', () => {
    for (const message of Object.values(API_ERROR_MESSAGES)) {
      expect(message).not.toMatch(/redis|lua|zadd|sha256|fingerprint|window/i);
    }
  });

  it('keeps the policy set out of the enforcer response a router returns', async () => {
    const clock = { ms: START };
    const enforcer = createRateLimitEnforcer({
      limiter: createRedisRateLimiter({ redis: windowStore(clock) }),
      policies: createPolicySet([
        { name: 'internal-name', scope: 'user', limit: 1, windowSeconds: 60 },
      ]),
      now: () => new Date(clock.ms),
    });

    await enforcer.check(subject, 'read');
    const limited = await enforcer.check(subject, 'read');
    expect(limited.outcome).toBe('limited');
    if (limited.outcome !== 'limited') return;
    // The name exists for operators and appears in the OUTCOME, never in a
    // header — the router is what decides it does not travel.
    expect(JSON.stringify(limited.headers)).not.toContain('internal-name');
  });
});
