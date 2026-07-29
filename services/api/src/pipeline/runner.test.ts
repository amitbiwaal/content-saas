import { describe, expect, it } from 'vitest';

import { PIPELINE_ORDER, type StageName } from './order.js';
import { runPipeline, type PipelineHooks } from './runner.js';
import { proceed, SECURITY_HEADERS, type PipelineRequest, type StageOutcome } from './stages.js';

const request: PipelineRequest = {
  method: 'POST',
  path: '/v1/articles',
  headers: {},
  ip: '203.0.113.1',
  contentLength: 10,
  body: {},
  cookies: {},
};

const TENANT = '018f7a1e-0000-7000-8000-0000000000bb';
const ORG = '018f7a1e-0000-7000-8000-0000000000aa';

const resource = {
  kind: 'article',
  id: 'a1',
  tenantId: TENANT,
  organizationId: ORG,
  ownerId: null,
};
const identity = { subjectId: 'user-1', cookieAuthenticated: true };

function hooks(over: Partial<PipelineHooks> = {}): PipelineHooks {
  return {
    requestId: () => 'corr-1',
    sizeLimit: () => proceed('size-limit'),
    rateLimitPreAuth: () => Promise.resolve(proceed('rate-limit-pre-auth')),
    authenticate: () => Promise.resolve({ outcome: proceed('authentication'), identity }),
    rateLimitPostAuth: () => Promise.resolve(proceed('rate-limit-post-auth')),
    csrf: () => proceed('csrf'),
    validate: () => proceed('validation'),
    idempotency: () => Promise.resolve(proceed('idempotency')),
    resolveTenant: () => Promise.resolve({ outcome: proceed('tenant-resolution'), resource }),
    authorize: () => Promise.resolve(proceed('authorization')),
    handler: () => Promise.resolve({ id: 'a1' }),
    ...over,
  };
}

const denial = (stage: StageName, status: number, code: string): StageOutcome => ({
  ok: false,
  stage,
  status,
  code,
  message: 'rejected',
});

describe('middleware ordering', () => {
  it('executes every stage in the canonical order', async () => {
    const result = await runPipeline(request, hooks(), SECURITY_HEADERS);
    expect(result.ok).toBe(true);
    expect(result.executed).toEqual(PIPELINE_ORDER);
  });

  it('assigns a correlation id first', async () => {
    const result = await runPipeline(request, hooks(), SECURITY_HEADERS);
    expect(result.executed[0]).toBe('request-id');
    expect(result.correlationId).toBe('corr-1');
  });
});

describe('short-circuiting — the ordering is a control, not a description', () => {
  it('never authenticates a request rejected for size', async () => {
    let authenticated = false;
    const result = await runPipeline(
      request,
      hooks({
        sizeLimit: () => denial('size-limit', 413, 'PAYLOAD_TOO_LARGE'),
        authenticate: () => {
          authenticated = true;
          return Promise.resolve({ outcome: proceed('authentication'), identity });
        },
      }),
      SECURITY_HEADERS,
    );
    expect(result.ok).toBe(false);
    expect(result.rejectedAt).toBe('size-limit');
    expect(authenticated).toBe(false);
    expect(result.executed).not.toContain('authentication');
  });

  it('never validates a request rejected for authentication', async () => {
    let validated = false;
    const result = await runPipeline(
      request,
      hooks({
        authenticate: () =>
          Promise.resolve({ outcome: denial('authentication', 401, 'UNAUTHENTICATED') }),
        validate: () => {
          validated = true;
          return proceed('validation');
        },
      }),
      SECURITY_HEADERS,
    );
    expect(result.rejectedAt).toBe('authentication');
    expect(validated).toBe(false);
  });

  it('never resolves a tenant for an invalid body', async () => {
    let resolved = false;
    const result = await runPipeline(
      request,
      hooks({
        validate: () => denial('validation', 400, 'VALIDATION_FAILED'),
        resolveTenant: () => {
          resolved = true;
          return Promise.resolve({ outcome: proceed('tenant-resolution'), resource });
        },
      }),
      SECURITY_HEADERS,
    );
    expect(result.rejectedAt).toBe('validation');
    expect(resolved).toBe(false);
  });

  it('never reaches the handler when authorization denies', async () => {
    let handled = false;
    const result = await runPipeline(
      request,
      hooks({
        authorize: () => Promise.resolve(denial('authorization', 403, 'FORBIDDEN')),
        handler: () => {
          handled = true;
          return Promise.resolve({});
        },
      }),
      SECURITY_HEADERS,
    );
    expect(result.rejectedAt).toBe('authorization');
    expect(handled).toBe(false);
  });

  it('never reaches the handler when CSRF fails', async () => {
    let handled = false;
    const result = await runPipeline(
      request,
      hooks({
        csrf: () => denial('csrf', 403, 'CSRF_TOKEN_INVALID'),
        handler: () => {
          handled = true;
          return Promise.resolve({});
        },
      }),
      SECURITY_HEADERS,
    );
    expect(result.rejectedAt).toBe('csrf');
    expect(handled).toBe(false);
  });

  it('never spends a post-auth rate slot on an unauthenticated request', async () => {
    let counted = false;
    await runPipeline(
      request,
      hooks({
        authenticate: () =>
          Promise.resolve({ outcome: denial('authentication', 401, 'UNAUTHENTICATED') }),
        rateLimitPostAuth: () => {
          counted = true;
          return Promise.resolve(proceed('rate-limit-post-auth'));
        },
      }),
      SECURITY_HEADERS,
    );
    expect(counted).toBe(false);
  });
});

describe('tenant propagation', () => {
  it('passes the resolved resource to authorization, not a client value', async () => {
    let seen: string | null = null;
    await runPipeline(
      request,
      hooks({
        authorize: (_id, res) => {
          seen = res.tenantId;
          return Promise.resolve(proceed('authorization'));
        },
      }),
      SECURITY_HEADERS,
    );
    expect(seen).toBe(TENANT);
  });

  it('passes the resolved resource to the handler', async () => {
    let seen: string | null = null;
    await runPipeline(
      request,
      hooks({
        handler: (_id, res) => {
          seen = res.tenantId;
          return Promise.resolve({});
        },
      }),
      SECURITY_HEADERS,
    );
    expect(seen).toBe(TENANT);
  });

  it('stops when the tenant cannot be resolved', async () => {
    const result = await runPipeline(
      request,
      hooks({
        resolveTenant: () =>
          Promise.resolve({ outcome: denial('tenant-resolution', 404, 'NOT_FOUND') }),
      }),
      SECURITY_HEADERS,
    );
    expect(result.rejectedAt).toBe('tenant-resolution');
    expect(result.executed).not.toContain('authorization');
  });
});

describe('responses', () => {
  it('applies security headers on success', async () => {
    const result = await runPipeline(request, hooks(), SECURITY_HEADERS);
    expect(result.headers['X-Content-Type-Options']).toBe('nosniff');
  });

  it('applies security headers on rejection too', async () => {
    const result = await runPipeline(
      request,
      hooks({ authorize: () => Promise.resolve(denial('authorization', 403, 'FORBIDDEN')) }),
      SECURITY_HEADERS,
    );
    expect(result.headers['X-Frame-Options']).toBe('DENY');
  });

  it('merges stage headers such as Retry-After', async () => {
    const result = await runPipeline(
      request,
      hooks({
        rateLimitPreAuth: () =>
          Promise.resolve({
            ok: false,
            stage: 'rate-limit-pre-auth',
            status: 429,
            code: 'RATE_LIMITED',
            headers: { 'Retry-After': '30' },
          }),
      }),
      SECURITY_HEADERS,
    );
    expect(result.headers['Retry-After']).toBe('30');
  });

  it('applies the output filter to the handler result', async () => {
    const result = await runPipeline(
      request,
      hooks({
        handler: () => Promise.resolve({ id: 'a1', internalSecret: 'x' }),
        outputFilter: (payload) => ({ id: (payload as { id: string }).id }),
      }),
      SECURITY_HEADERS,
    );
    expect(result.payload).toEqual({ id: 'a1' });
    expect(JSON.stringify(result.payload)).not.toContain('internalSecret');
  });

  it('treats an omitted optional stage as a pass without reordering', async () => {
    const { validate: _v, idempotency: _i, ...withoutOptional } = hooks();
    const result = await runPipeline(request, withoutOptional, SECURITY_HEADERS);
    expect(result.ok).toBe(true);
    expect(result.executed).toEqual(PIPELINE_ORDER);
  });
});
