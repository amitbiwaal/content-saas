import type { Principal } from '@contentos/security';
import { describe, expect, it } from 'vitest';

import type { ErrorBody } from '../ai/http.js';
import { createFakeRedis } from '../ratelimit/fake-redis.fixture.js';
import { canonicalize, FINGERPRINT_EXCLUDED_FIELDS, fingerprintOf } from './fingerprint.js';
import {
  createIdempotencyGuard,
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENT_REPLAY_HEADER,
  withIdempotencyKey,
  type IdempotencyGuard,
} from './guard.js';
import {
  createRedisIdempotencyStore,
  idempotencyKeyFor,
  IDEMPOTENCY_TTL_SECONDS,
  IdempotencyStoreUnavailableError,
} from './store.js';

const START = Date.UTC(2026, 6, 31, 12, 0, 0);

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

const BODY = { taskType: 'planning.outline', variables: { topic: 'espresso' } };

const fingerprint = (overrides: Partial<Parameters<typeof fingerprintOf>[0]> = {}): string =>
  fingerprintOf({
    principal: principal(),
    endpoint: '/v1/ai/execute',
    method: 'POST',
    body: BODY,
    ...overrides,
  });

// ── Fingerprinting ───────────────────────────────────────────────────────────

describe('canonical form', () => {
  it('sorts object keys at every depth', () => {
    expect(canonicalize({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it('keeps array order, which is data rather than presentation', () => {
    expect(canonicalize([3, 1, 2])).toBe('[3,1,2]');
    expect(canonicalize([1, 2, 3])).not.toBe(canonicalize([3, 2, 1]));
  });

  it('drops undefined members exactly as a serializer would', () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('renders values that JSON cannot as null rather than throwing', () => {
    expect(canonicalize(Number.NaN)).toBe('null');
    expect(canonicalize(Number.POSITIVE_INFINITY)).toBe('null');
    expect(canonicalize(null)).toBe('null');
  });

  it('is stable for structurally equal bodies serialized differently', () => {
    // `JSON.stringify` alone is not: it preserves insertion order, and a client
    // rebuilding a request from a map can reorder it between attempts.
    expect(canonicalize({ a: 1, b: 2 })).toBe(canonicalize({ b: 2, a: 1 }));
  });
});

describe('the fingerprint', () => {
  it('is deterministic', () => {
    expect(fingerprint()).toBe(fingerprint());
  });

  it('changes with the body', () => {
    expect(fingerprint()).not.toBe(fingerprint({ body: { taskType: 'other' } }));
  });

  it('changes with the endpoint and the method', () => {
    expect(fingerprint()).not.toBe(fingerprint({ endpoint: '/v1/ai/stream' }));
    expect(fingerprint()).not.toBe(fingerprint({ method: 'GET' }));
  });

  it('is case-insensitive about the method, which HTTP is', () => {
    expect(fingerprint({ method: 'post' })).toBe(fingerprint({ method: 'POST' }));
  });

  it('separates two tenants that picked the same key', () => {
    // Without the principal in it, one tenant's retry could return another
    // tenant's stored response — a cross-tenant disclosure dressed as a hit.
    expect(fingerprint()).not.toBe(fingerprint({ principal: principal({ workspaceId: 'ws-2' }) }));
    expect(fingerprint()).not.toBe(
      fingerprint({ principal: principal({ organizationId: 'org-2' }) }),
    );
    expect(fingerprint()).not.toBe(fingerprint({ principal: principal({ subjectId: 'user-2' }) }));
  });

  it('ignores everything that changes between retries', () => {
    // The failure mode this prevents looks like it works: every retry would be
    // a different request, so idempotency would never fire and only the
    // duplicate-charge case would be broken.
    const base = fingerprint();
    for (const field of FINGERPRINT_EXCLUDED_FIELDS) {
      const withVolatile = fingerprint({ body: { ...BODY, [field]: 'anything' } });
      // They are not in the accepted body at all after S3.3, so a caller that
      // sends one is refused before this — but if that ever changed, this fails.
      expect(withVolatile, field).not.toBe(base);
    }
    // The ones that actually reach here — the request and correlation ids —
    // never enter the input at all.
    expect(
      fingerprintOf({
        principal: principal(),
        endpoint: '/v1/ai/execute',
        method: 'POST',
        body: BODY,
      }),
    ).toBe(base);
  });

  it('never appears in anything a caller could see', () => {
    expect(fingerprint()).toMatch(/^[0-9a-f]{64}$/);
  });

  it('treats an absent body as null rather than failing', () => {
    expect(fingerprint({ body: undefined })).toBe(fingerprint({ body: null }));
  });
});

// ── The store ────────────────────────────────────────────────────────────────

function storeAt(clock: { ms: number }) {
  const redis = createFakeRedis({ now: () => clock.ms });
  return { redis, store: createRedisIdempotencyStore({ redis }) };
}

describe('the store', () => {
  it('tenant-prefixes the key and sanitises what a client sent', () => {
    expect(idempotencyKeyFor('ws-1', 'abc-123')).toBe('cos:ws-1:idempotency:abc-123');
    // An unescaped separator would let a caller address a prefix it was never
    // scoped to.
    expect(idempotencyKeyFor('ws-1', 'a:cos:ws-2:idempotency:victim')).toBe(
      'cos:ws-1:idempotency:acosws-2idempotencyvictim',
    );
  });

  it('claims a free key', async () => {
    const { store } = storeAt({ ms: START });
    await expect(store.begin('k', 'fp')).resolves.toEqual({ outcome: 'claimed' });
  });

  it('reports the pending record to whoever loses the race', async () => {
    const { store } = storeAt({ ms: START });
    await store.begin('k', 'fp');
    await expect(store.begin('k', 'fp')).resolves.toEqual({
      outcome: 'existing',
      record: { state: 'pending', fingerprint: 'fp' },
    });
  });

  it('lets exactly one of many concurrent claims win', async () => {
    const { store } = storeAt({ ms: START });
    const results = await Promise.all(Array.from({ length: 20 }, () => store.begin('k', 'fp')));
    expect(results.filter((r) => r.outcome === 'claimed')).toHaveLength(1);
  });

  it('stores a response and replays it', async () => {
    const { store } = storeAt({ ms: START });
    await store.begin('k', 'fp');
    await store.complete('k', 'fp', { status: 201, headers: { a: 'b' }, body: { id: 7 } });

    await expect(store.begin('k', 'fp')).resolves.toEqual({
      outcome: 'existing',
      record: {
        state: 'completed',
        fingerprint: 'fp',
        response: { status: 201, headers: { a: 'b' }, body: { id: 7 } },
      },
    });
  });

  it('refuses to complete a claim it does not hold', async () => {
    // A key whose claim expired mid-flight must not be resurrected as
    // completed: the client has long since retried, and a stored response for a
    // key nobody is waiting on replays stale output to whoever holds it next.
    const { store } = storeAt({ ms: START });
    await store.complete('k', 'fp', { status: 200, headers: {}, body: null });
    await expect(store.begin('k', 'fp')).resolves.toEqual({ outcome: 'claimed' });
  });

  it('refuses to complete with a fingerprint that does not match the claim', async () => {
    const { store } = storeAt({ ms: START });
    await store.begin('k', 'fp');
    await store.complete('k', 'different', { status: 200, headers: {}, body: 'wrong' });

    const again = await store.begin('k', 'fp');
    expect(again).toMatchObject({ outcome: 'existing', record: { state: 'pending' } });
  });

  it('releases a claim so a retry is not blocked for the window', async () => {
    const { store } = storeAt({ ms: START });
    await store.begin('k', 'fp');
    await store.release('k');
    await expect(store.begin('k', 'fp')).resolves.toEqual({ outcome: 'claimed' });
  });

  it('never releases a completed record', async () => {
    const { store } = storeAt({ ms: START });
    await store.begin('k', 'fp');
    await store.complete('k', 'fp', { status: 200, headers: {}, body: 'kept' });
    await store.release('k');

    expect(await store.begin('k', 'fp')).toMatchObject({
      outcome: 'existing',
      record: { state: 'completed' },
    });
  });

  it('expires after the 24-hour window the spec sets', async () => {
    const clock = { ms: START };
    const { store } = storeAt(clock);

    await store.begin('k', 'fp');
    await store.complete('k', 'fp', { status: 200, headers: {}, body: null });

    clock.ms = START + IDEMPOTENCY_TTL_SECONDS * 1000 - 1;
    expect(await store.begin('k', 'fp')).toMatchObject({ outcome: 'existing' });

    // Expiry is Redis's TTL, not a swept marker — a sweep that fell behind
    // would leave keys reading as blocked long after they should be free.
    clock.ms = START + IDEMPOTENCY_TTL_SECONDS * 1000;
    expect(await store.begin('k', 'fp')).toEqual({ outcome: 'claimed' });
  });

  it('treats a record it cannot read as a free key', async () => {
    // A corrupt value would otherwise refuse a legitimate request for 24 hours.
    const store = createRedisIdempotencyStore({
      redis: { eval: () => Promise.resolve([0, 'not json']) },
    });
    await expect(store.begin('k', 'fp')).resolves.toEqual({ outcome: 'claimed' });
  });

  it('raises a typed failure when Redis cannot answer', async () => {
    const { redis, store } = storeAt({ ms: START });
    redis.fail();
    await expect(store.begin('k', 'fp')).rejects.toBeInstanceOf(IdempotencyStoreUnavailableError);
  });

  it('recovers with its records intact once Redis returns', async () => {
    const { redis, store } = storeAt({ ms: START });
    await store.begin('k', 'fp');
    await store.complete('k', 'fp', { status: 200, headers: {}, body: 'kept' });

    redis.fail();
    await expect(store.begin('k', 'fp')).rejects.toBeInstanceOf(IdempotencyStoreUnavailableError);

    redis.fail(null);
    expect(await store.begin('k', 'fp')).toMatchObject({
      outcome: 'existing',
      record: { state: 'completed', response: { body: 'kept' } },
    });
  });
});

// ── The guard ────────────────────────────────────────────────────────────────

function guardAt(clock: { ms: number }): {
  guard: IdempotencyGuard;
  redis: ReturnType<typeof createFakeRedis>;
} {
  const { redis, store } = storeAt(clock);
  return { redis, guard: createIdempotencyGuard({ store }) };
}

const beginInput = (overrides: Record<string, unknown> = {}) => ({
  principal: principal(),
  method: 'POST',
  endpoint: '/v1/ai/execute',
  body: BODY,
  clientKey: 'idem-1',
  requestId: 'req-1',
  ...overrides,
});

describe('the guard', () => {
  it('skips a request that carries no key', async () => {
    const { guard } = guardAt({ ms: START });
    await expect(guard.begin(beginInput({ clientKey: null }))).resolves.toEqual({
      outcome: 'skipped',
    });
  });

  it('skips a GET, which is already repeatable', async () => {
    const { guard } = guardAt({ ms: START });
    await expect(guard.begin(beginInput({ method: 'GET' }))).resolves.toEqual({
      outcome: 'skipped',
    });
  });

  it('claims on the first request', async () => {
    const { guard } = guardAt({ ms: START });
    const claim = await guard.begin(beginInput());
    expect(claim).toMatchObject({
      outcome: 'proceed',
      storageKey: 'cos:ws-1:idempotency:idem-1',
      clientKey: 'idem-1',
    });
  });

  it('replays the original response, status included', async () => {
    const { guard } = guardAt({ ms: START });
    const claim = await guard.begin(beginInput());
    if (claim.outcome !== 'proceed') throw new Error('expected a claim');

    await guard.complete(claim.storageKey, claim.fingerprint, {
      status: 201,
      headers: { 'content-type': 'application/json' },
      body: { id: 'run-1' },
    });

    const replay = await guard.begin(beginInput());
    expect(replay).toMatchObject({ outcome: 'replay' });
    if (replay.outcome !== 'replay') return;
    expect(replay.response.status).toBe(201);
    expect(replay.response.body).toEqual({ id: 'run-1' });
    expect(replay.response.headers).toMatchObject({
      'content-type': 'application/json',
      [IDEMPOTENCY_KEY_HEADER]: 'idem-1',
      [IDEMPOTENT_REPLAY_HEADER]: 'true',
    });
  });

  it('marks only a replay as one', async () => {
    const { guard } = guardAt({ ms: START });
    const claim = await guard.begin(beginInput());
    if (claim.outcome !== 'proceed') throw new Error('expected a claim');
    expect(claim).not.toHaveProperty('response');
  });

  it('refuses the same key with a different payload', async () => {
    const { guard } = guardAt({ ms: START });
    const claim = await guard.begin(beginInput());
    if (claim.outcome !== 'proceed') throw new Error('expected a claim');
    await guard.complete(claim.storageKey, claim.fingerprint, {
      status: 200,
      headers: {},
      body: 'first',
    });

    const conflict = await guard.begin(beginInput({ body: { taskType: 'something.else' } }));
    expect(conflict.outcome).toBe('refused');
    if (conflict.outcome !== 'refused') return;
    expect(conflict.response.status).toBe(409);
    expect((conflict.response.body as ErrorBody).error.code).toBe('idempotency_conflict');
  });

  it('never says what differed', async () => {
    // The stored fingerprint is internal, and echoing the first request's shape
    // would disclose it to whoever guessed the key.
    const { guard } = guardAt({ ms: START });
    const claim = await guard.begin(beginInput());
    if (claim.outcome !== 'proceed') throw new Error('expected a claim');
    await guard.complete(claim.storageKey, claim.fingerprint, {
      status: 200,
      headers: {},
      body: 'first',
    });

    const conflict = await guard.begin(beginInput({ body: { secret: 'other-payload' } }));
    if (conflict.outcome !== 'refused') throw new Error('expected a refusal');
    const serialized = JSON.stringify(conflict.response.body);
    expect(serialized).not.toContain(claim.fingerprint);
    expect(serialized).not.toContain('espresso');
    expect(serialized).not.toContain('cos:');
  });

  it('refuses a duplicate while the first is still in flight, and says to retry', async () => {
    const { guard } = guardAt({ ms: START });
    await guard.begin(beginInput());

    const pending = await guard.begin(beginInput());
    expect(pending.outcome).toBe('refused');
    if (pending.outcome !== 'refused') return;
    expect(pending.response.status).toBe(409);
    expect((pending.response.body as ErrorBody).error.code).toBe('idempotency_in_progress');
    expect(pending.response.headers['retry-after']).toBe('1');
  });

  it('tells the two conflicts apart by code, which is where clients branch', async () => {
    const { guard } = guardAt({ ms: START });
    const claim = await guard.begin(beginInput());
    if (claim.outcome !== 'proceed') throw new Error('expected a claim');

    const pending = await guard.begin(beginInput());
    const mismatched = await guard.begin(beginInput({ body: { other: true } }));
    if (pending.outcome !== 'refused' || mismatched.outcome !== 'refused') throw new Error('!');

    expect(pending.response.status).toBe(mismatched.response.status);
    expect((pending.response.body as ErrorBody).error.code).not.toBe(
      (mismatched.response.body as ErrorBody).error.code,
    );
    // Only the retryable one carries a Retry-After: waiting will not fix a
    // mismatched payload.
    expect(pending.response.headers['retry-after']).toBeDefined();
    expect(mismatched.response.headers['retry-after']).toBeUndefined();
  });

  it('lets a retry through once a released claim is free', async () => {
    const { guard } = guardAt({ ms: START });
    const claim = await guard.begin(beginInput());
    if (claim.outcome !== 'proceed') throw new Error('expected a claim');

    await guard.release(claim.storageKey);
    await expect(guard.begin(beginInput())).resolves.toMatchObject({ outcome: 'proceed' });
  });

  it('refuses rather than executing unguarded when the store is down', async () => {
    // Proceeding without the claim is how a retry storm during a Redis blip
    // becomes a duplicate charge.
    const { redis, guard } = guardAt({ ms: START });
    redis.fail();

    const refused = await guard.begin(beginInput());
    expect(refused.outcome).toBe('refused');
    if (refused.outcome !== 'refused') return;
    expect(refused.response.status).toBe(503);
    expect((refused.response.body as ErrorBody).error.code).toBe('service_unavailable');
    expect(refused.response.headers['retry-after']).toBe('1');
  });

  it('does not fail a computed response because the store went down', async () => {
    const { redis, guard } = guardAt({ ms: START });
    const claim = await guard.begin(beginInput());
    if (claim.outcome !== 'proceed') throw new Error('expected a claim');

    redis.fail();
    // The caller has already paid for this work; discarding it would be worse
    // than losing the ability to replay it.
    await expect(
      guard.complete(claim.storageKey, claim.fingerprint, {
        status: 200,
        headers: {},
        body: 'done',
      }),
    ).resolves.toBeUndefined();
    await expect(guard.release(claim.storageKey)).resolves.toBeUndefined();
  });

  it('separates two tenants that chose the same key', async () => {
    const { guard } = guardAt({ ms: START });
    await guard.begin(beginInput());

    const otherTenant = await guard.begin(
      beginInput({ principal: principal({ workspaceId: 'ws-2' }) }),
    );
    expect(otherTenant).toMatchObject({ outcome: 'proceed' });
  });

  it('separates two endpoints that chose the same key', async () => {
    const { guard } = guardAt({ ms: START });
    const first = await guard.begin(beginInput());
    if (first.outcome !== 'proceed') throw new Error('expected a claim');
    await guard.complete(first.storageKey, first.fingerprint, {
      status: 200,
      headers: {},
      body: 'execute',
    });

    // Same key, same tenant, different endpoint: a conflict rather than a
    // replay of another endpoint's response.
    const second = await guard.begin(beginInput({ endpoint: '/v1/ai/stream' }));
    expect(second.outcome).toBe('refused');
  });
});

describe('a response that carries its key back', () => {
  it('echoes the key without disturbing anything else', () => {
    const response = withIdempotencyKey(
      { status: 200, headers: { 'content-type': 'application/json' }, body: { a: 1 } },
      'idem-1',
    );
    expect(response).toEqual({
      status: 200,
      headers: { 'content-type': 'application/json', [IDEMPOTENCY_KEY_HEADER]: 'idem-1' },
      body: { a: 1 },
    });
  });

  it('does not claim to be a replay', () => {
    const response = withIdempotencyKey({ status: 200, headers: {}, body: null }, 'idem-1');
    expect(response.headers).not.toHaveProperty(IDEMPOTENT_REPLAY_HEADER);
  });
});
