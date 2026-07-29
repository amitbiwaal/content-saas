import { describe, expect, it } from 'vitest';

import {
  checkCsrf,
  checkSizeLimits,
  CSRF_COOKIE,
  CSRF_HEADER,
  exceedsNestingDepth,
  isUuid,
  rateLimitPostAuth,
  rateLimitPreAuth,
  SECURITY_HEADERS,
  SIZE_LIMITS,
  toErrorResponse,
  validateRequest,
  type PipelineRequest,
  type RateLimiter,
  type SchemaValidator,
} from './stages.js';

const req = (over: Partial<PipelineRequest> = {}): PipelineRequest => ({
  method: 'POST',
  path: '/v1/articles',
  headers: { 'content-type': 'application/json' },
  ip: '203.0.113.1',
  contentLength: 100,
  body: {},
  cookies: {},
  ...over,
});

const eq = (a: string, b: string): boolean => a === b;

describe('request size limits', () => {
  it('accepts a normal request', () => {
    expect(checkSizeLimits(req()).ok).toBe(true);
  });

  it('rejects a JSON body over 1 MB with 413', () => {
    const outcome = checkSizeLimits(req({ contentLength: SIZE_LIMITS.jsonBodyBytes + 1 }));
    expect(outcome.ok).toBe(false);
    expect(outcome.status).toBe(413);
  });

  it('allows a multipart upload up to 25 MB', () => {
    const r = req({
      contentLength: 20 * 1024 * 1024,
      headers: { 'content-type': 'multipart/form-data; boundary=x' },
    });
    expect(checkSizeLimits(r).ok).toBe(true);
  });

  it('rejects a multipart upload over 25 MB', () => {
    const r = req({
      contentLength: SIZE_LIMITS.multipartBytes + 1,
      headers: { 'content-type': 'multipart/form-data; boundary=x' },
    });
    expect(checkSizeLimits(r).status).toBe(413);
  });

  it('rejects a URL over 2 KB with 414', () => {
    expect(checkSizeLimits(req({ path: `/${'a'.repeat(3000)}` })).status).toBe(414);
  });

  it('rejects headers over 16 KB with 431', () => {
    expect(checkSizeLimits(req({ headers: { big: 'x'.repeat(20_000) } })).status).toBe(431);
  });

  // A deeply nested document exhausts the stack before application code runs.
  it('rejects nesting beyond depth 10', () => {
    let deep: unknown = 'leaf';
    for (let i = 0; i < 12; i += 1) deep = { nested: deep };
    expect(exceedsNestingDepth(deep)).toBe(true);
  });

  it('accepts nesting within depth 10', () => {
    let shallow: unknown = 'leaf';
    for (let i = 0; i < 5; i += 1) shallow = { nested: shallow };
    expect(exceedsNestingDepth(shallow)).toBe(false);
  });

  it('counts array nesting too', () => {
    let deep: unknown = 'leaf';
    for (let i = 0; i < 12; i += 1) deep = [deep];
    expect(exceedsNestingDepth(deep)).toBe(true);
  });
});

describe('rate limiting — two stages', () => {
  const limiter = (allowed: boolean): RateLimiter & { keys: string[] } => {
    const keys: string[] = [];
    return {
      keys,
      consume(key) {
        keys.push(key);
        return Promise.resolve({ allowed, remaining: allowed ? 5 : 0, resetSeconds: 30 });
      },
    };
  };

  it('keys the pre-auth limit by IP', async () => {
    const l = limiter(true);
    await rateLimitPreAuth(req(), l, { limit: 10, windowSeconds: 60 });
    expect(l.keys[0]).toBe('ip:203.0.113.1');
  });

  it('keys the post-auth limit by subject AND tenant', async () => {
    const l = limiter(true);
    await rateLimitPostAuth('user-1', 'ws-1', l, { limit: 10, windowSeconds: 60 });
    expect(l.keys[0]).toBe('subject:user-1:tenant:ws-1');
  });

  it('keys by subject alone when no tenant is resolved yet', async () => {
    const l = limiter(true);
    await rateLimitPostAuth('user-1', null, l, { limit: 10, windowSeconds: 60 });
    expect(l.keys[0]).toBe('subject:user-1');
  });

  it('returns 429 with Retry-After when exceeded', async () => {
    const outcome = await rateLimitPreAuth(req(), limiter(false), { limit: 1, windowSeconds: 60 });
    expect(outcome.status).toBe(429);
    expect(outcome.headers?.['Retry-After']).toBe('30');
  });

  it('allows within the limit', async () => {
    expect(
      (await rateLimitPreAuth(req(), limiter(true), { limit: 10, windowSeconds: 60 })).ok,
    ).toBe(true);
  });
});

describe('CSRF', () => {
  const withTokens = (cookie: string, header: string): PipelineRequest =>
    req({ cookies: { [CSRF_COOKIE]: cookie }, headers: { [CSRF_HEADER]: header } });

  it('accepts a matching token pair on a cookie-authenticated mutation', () => {
    expect(checkCsrf(withTokens('tok', 'tok'), true, eq).ok).toBe(true);
  });

  it('rejects a mismatched pair with 403', () => {
    const outcome = checkCsrf(withTokens('tok', 'other'), true, eq);
    expect(outcome.status).toBe(403);
    expect(outcome.code).toBe('CSRF_TOKEN_INVALID');
  });

  it('rejects a missing token', () => {
    expect(checkCsrf(req(), true, eq).code).toBe('CSRF_TOKEN_MISSING');
  });

  it('rejects an empty token rather than treating it as a match', () => {
    expect(checkCsrf(withTokens('', ''), true, eq).ok).toBe(false);
  });

  it('skips safe methods', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      expect(checkCsrf(req({ method }), true, eq).ok).toBe(true);
    }
  });

  // A bearer request cannot be forged cross-site: the browser does not attach
  // an Authorization header automatically.
  it('skips bearer-authenticated requests', () => {
    expect(checkCsrf(req(), false, eq).ok).toBe(true);
  });

  it('uses the injected comparator', () => {
    let called = false;
    checkCsrf(withTokens('a', 'a'), true, (x, y) => {
      called = true;
      return x === y;
    });
    expect(called).toBe(true);
  });
});

describe('validation', () => {
  const strict: SchemaValidator<{ title: string }> = {
    validate(input) {
      if (typeof input !== 'object' || input === null) {
        return { ok: false, issues: [{ path: 'body', code: 'expected_object' }] };
      }
      const keys = Object.keys(input);
      const unknown = keys.filter((k) => k !== 'title');
      if (unknown.length > 0) {
        return {
          ok: false,
          issues: unknown.map((k) => ({ path: `body.${k}`, code: 'unrecognized_key' })),
        };
      }
      const title = (input as { title?: unknown }).title;
      if (typeof title !== 'string') {
        return { ok: false, issues: [{ path: 'body.title', code: 'expected_string' }] };
      }
      return { ok: true, value: { title } };
    },
  };

  it('accepts a valid body', () => {
    const result = validateRequest({ title: 'x' }, strict);
    expect(result.outcome.ok).toBe(true);
    expect(result.value).toEqual({ title: 'x' });
  });

  // Rejecting unknown keys makes mass-assignment structurally impossible.
  it('REJECTS unknown keys', () => {
    const result = validateRequest({ title: 'x', tenantId: 'attacker' }, strict);
    expect(result.outcome.ok).toBe(false);
    expect(result.outcome.message).toContain('body.tenantId');
  });

  it('rejects a wrong type with the field path', () => {
    expect(validateRequest({ title: 1 }, strict).outcome.message).toContain('body.title');
  });

  it('rejects an over-nested body before the schema runs', () => {
    let deep: unknown = 'leaf';
    for (let i = 0; i < 12; i += 1) deep = { nested: deep };
    expect(validateRequest(deep, strict).outcome.code).toBe('NESTING_TOO_DEEP');
  });

  it('validates identifiers as UUIDs', () => {
    expect(isUuid('018f7a1e-0000-7000-8000-000000000001')).toBe(true);
    expect(isUuid('1; DROP TABLE users')).toBe(false);
    expect(isUuid('not-a-uuid')).toBe(false);
  });
});

describe('error responses', () => {
  it('returns a safe code and message with the correlation id', () => {
    const response = toErrorResponse(
      {
        ok: false,
        stage: 'validation',
        status: 400,
        code: 'VALIDATION_FAILED',
        message: 'body.title: required',
      },
      'corr-1',
    );
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_FAILED');
    expect(response.body.correlationId).toBe('corr-1');
  });

  // Never expose a stack trace, a SQL error, a provider internal, or a secret.
  it('collapses an unrecognised failure to an opaque 500', () => {
    const response = toErrorResponse(
      {
        ok: false,
        stage: 'handler',
        status: 500,
        code: 'PG_UNIQUE_VIOLATION',
        message: 'duplicate key value violates unique constraint "uq_users__email"',
      },
      'corr-1',
    );
    expect(response.status).toBe(500);
    expect(response.body.error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(response)).not.toContain('uq_users__email');
  });

  it('keeps the correlation id on an opaque 500 so the incident stays traceable', () => {
    const response = toErrorResponse({ ok: false, stage: 'handler', code: 'BOOM' }, 'corr-9');
    expect(response.body.correlationId).toBe('corr-9');
  });
});

describe('security headers', () => {
  it('sets the expected headers', () => {
    expect(SECURITY_HEADERS['X-Content-Type-Options']).toBe('nosniff');
    expect(SECURITY_HEADERS['X-Frame-Options']).toBe('DENY');
    expect(SECURITY_HEADERS['Strict-Transport-Security']).toContain('includeSubDomains');
    expect(SECURITY_HEADERS['Cache-Control']).toBe('no-store');
  });
});
