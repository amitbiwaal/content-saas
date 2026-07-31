import { describe, expect, it } from 'vitest';

import type { ApiRequest } from './http.js';
import { readResumeToken, toGatewayRequest, toScopedRead } from './validation.js';

const ORG = '11111111-1111-4111-8111-111111111111';
const WORKSPACE = '22222222-2222-4222-8222-222222222222';

const validBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  taskType: 'planning.outline',
  capability: 'chat',
  providerId: 'openai',
  model: 'gpt-4o',
  template: { id: 'planning.outline', version: 7 },
  variables: { topic: 'kettles' },
  organizationId: ORG,
  workspaceId: WORKSPACE,
  ...overrides,
});

const request = (
  body: unknown,
  headers: Record<string, string> = { 'idempotency-key': 'idem-1' },
): ApiRequest => ({
  method: 'POST',
  path: '/v1/ai/execute',
  params: {},
  query: {},
  headers,
  body,
});

const pathsOf = (outcome: ReturnType<typeof toGatewayRequest>): readonly string[] =>
  outcome.ok ? [] : outcome.issues.map((issue) => issue.path);

describe('mapping an execution request to a GatewayRequest', () => {
  it('maps every field a caller sent', () => {
    const outcome = toGatewayRequest(
      request(
        validBody({
          actorId: 'user-1',
          params: { temperature: 0.2, maxOutputTokens: 900, topP: 0.9, stopSequences: ['END'] },
          timeoutMs: 30_000,
          featureFlag: 'ai.outlines',
        }),
        { 'idempotency-key': 'idem-1', 'x-correlation-id': 'corr-1' },
      ),
    );

    expect(outcome).toEqual({
      ok: true,
      value: {
        taskType: 'planning.outline',
        capability: 'chat',
        providerId: 'openai',
        model: 'gpt-4o',
        templateRef: { id: 'planning.outline', version: 7 },
        variables: { topic: 'kettles' },
        organizationId: ORG,
        workspaceId: WORKSPACE,
        actorId: 'user-1',
        correlationId: 'corr-1',
        idempotencyKey: 'idem-1',
        params: { temperature: 0.2, maxOutputTokens: 900, topP: 0.9, stopSequences: ['END'] },
        timeoutMs: 30_000,
        featureFlag: 'ai.outlines',
      },
    });
  });

  it('omits optional fields rather than sending undefined', () => {
    const outcome = toGatewayRequest(request(validBody()));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    for (const key of ['params', 'timeoutMs', 'featureFlag'] as const) {
      expect(key in outcome.value).toBe(false);
    }
    expect('version' in outcome.value.templateRef).toBe(true);
  });

  it('omits the template version when the caller did not pin one', () => {
    const outcome = toGatewayRequest(request(validBody({ template: { id: 'planning.outline' } })));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect('version' in outcome.value.templateRef).toBe(false);
  });

  it('treats a missing actor as null, not as an error', () => {
    // Platform-initiated work has no membership to check; requiring one would
    // make background execution impossible rather than more secure.
    const outcome = toGatewayRequest(request(validBody()));
    expect(outcome.ok && outcome.value.actorId).toBeNull();

    const explicit = toGatewayRequest(request(validBody({ actorId: null })));
    expect(explicit.ok && explicit.value.actorId).toBeNull();
  });
});

describe('what transport validation refuses', () => {
  it('requires an idempotency key on the header', () => {
    expect(pathsOf(toGatewayRequest(request(validBody(), {})))).toContain(
      'headers.idempotency-key',
    );
  });

  it('refuses a body that is not an object', () => {
    for (const body of [null, 'text', 42, ['a']]) {
      expect(pathsOf(toGatewayRequest(request(body)))).toContain('body');
    }
  });

  it('refuses unknown keys, one issue per key', () => {
    const paths = pathsOf(
      toGatewayRequest(request(validBody({ tenantId: 'x', role: 'admin', credits: 10 }))),
    );
    expect(paths).toEqual(expect.arrayContaining(['body.tenantId', 'body.role', 'body.credits']));
  });

  it('refuses an identifier that is not a UUID', () => {
    const paths = pathsOf(toGatewayRequest(request(validBody({ workspaceId: 'not-a-uuid' }))));
    expect(paths).toEqual(['body.workspaceId']);
  });

  it('reports a missing identifier as REQUIRED, not as a bad UUID', () => {
    const body = validBody();
    delete body['organizationId'];
    const outcome = toGatewayRequest(request(body));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues).toContainEqual({ path: 'body.organizationId', code: 'REQUIRED' });
  });

  it('refuses a capability outside the fixed set', () => {
    expect(pathsOf(toGatewayRequest(request(validBody({ capability: 'telepathy' }))))).toEqual([
      'body.capability',
    ]);
  });

  it('refuses a malformed template reference', () => {
    expect(pathsOf(toGatewayRequest(request(validBody({ template: 'planning.outline' }))))).toEqual(
      ['body.template'],
    );
    expect(
      pathsOf(toGatewayRequest(request(validBody({ template: { id: '', version: 0 } })))),
    ).toEqual(['body.template.id', 'body.template.version']);
    expect(
      pathsOf(toGatewayRequest(request(validBody({ template: { id: 'a', unknown: 1 } })))),
    ).toContain('body.template.unknown');
  });

  it('refuses variables that are not an object', () => {
    expect(pathsOf(toGatewayRequest(request(validBody({ variables: ['a'] }))))).toEqual([
      'body.variables',
    ]);
  });

  it('refuses malformed sampling parameters', () => {
    expect(pathsOf(toGatewayRequest(request(validBody({ params: 'hot' }))))).toEqual([
      'body.params',
    ]);
    expect(
      pathsOf(toGatewayRequest(request(validBody({ params: { temperature: 'hot' } })))),
    ).toEqual(expect.arrayContaining(['body.params.temperature', 'body.params.maxOutputTokens']));
    expect(
      pathsOf(
        toGatewayRequest(
          request(
            validBody({
              params: {
                temperature: 0.2,
                maxOutputTokens: 10,
                topP: 'x',
                seed: 1.5,
                stopSequences: [1],
              },
            }),
          ),
        ),
      ),
    ).toEqual(['body.params.topP', 'body.params.seed', 'body.params.stopSequences']);
    expect(
      pathsOf(
        toGatewayRequest(
          request(validBody({ params: { temperature: 0.2, maxOutputTokens: 10, nope: 1 } })),
        ),
      ),
    ).toEqual(['body.params.nope']);
  });

  it('refuses a body nested deeply enough to exhaust a parser', () => {
    let nested: unknown = 'leaf';
    for (let depth = 0; depth < 15; depth += 1) nested = { nested };
    expect(pathsOf(toGatewayRequest(request(validBody({ variables: nested }))))).toEqual(['body']);
  });

  it('refuses the wrong type on every optional field', () => {
    expect(pathsOf(toGatewayRequest(request(validBody({ actorId: 42 }))))).toEqual([
      'body.actorId',
    ]);
    expect(pathsOf(toGatewayRequest(request(validBody({ timeoutMs: 0 }))))).toEqual([
      'body.timeoutMs',
    ]);
    expect(pathsOf(toGatewayRequest(request(validBody({ featureFlag: '' }))))).toEqual([
      'body.featureFlag',
    ]);
    expect(pathsOf(toGatewayRequest(request(validBody({ correlationId: 7 }))))).toEqual([
      'body.correlationId',
    ]);
  });

  it('reports every issue at once rather than the first', () => {
    const outcome = toGatewayRequest(
      request({ taskType: '', capability: 'nope', workspaceId: 'x' }, {}),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues.length).toBeGreaterThan(4);
  });
});

describe('what transport validation deliberately does NOT check', () => {
  it('accepts a taskType the Gateway will refuse, so there is one definition of dot.case', () => {
    // Admission owns the format. Re-checking it here would create a second
    // definition that could drift from the enforced one.
    const outcome = toGatewayRequest(request(validBody({ taskType: 'NotDotCase' })));
    expect(outcome.ok).toBe(true);
  });

  it('accepts oversized variables, because the byte bound belongs to admission', () => {
    const outcome = toGatewayRequest(
      request(validBody({ variables: { blob: 'x'.repeat(300_000) } })),
    );
    expect(outcome.ok).toBe(true);
  });
});

describe('the correlation id', () => {
  it('prefers the header', () => {
    const outcome = toGatewayRequest(
      request(validBody({ correlationId: 'from-body' }), {
        'idempotency-key': 'idem-1',
        'x-correlation-id': 'from-header',
      }),
    );
    expect(outcome.ok && outcome.value.correlationId).toBe('from-header');
  });

  it('falls back to the body, then to the idempotency key', () => {
    const fromBody = toGatewayRequest(request(validBody({ correlationId: 'from-body' })));
    expect(fromBody.ok && fromBody.value.correlationId).toBe('from-body');

    const derived = toGatewayRequest(request(validBody()));
    expect(derived.ok && derived.value.correlationId).toBe('idem-1');
  });

  it('is derived, never generated — the same request maps to the same value', () => {
    const once = toGatewayRequest(request(validBody()));
    const twice = toGatewayRequest(request(validBody()));
    expect(once).toEqual(twice);
  });
});

describe('a tenant-scoped read', () => {
  const read = (headers: Record<string, string>, params: Record<string, string>): ApiRequest => ({
    method: 'GET',
    path: '/v1/ai/jobs/job-1',
    params,
    query: {},
    headers,
    body: null,
  });

  it('takes the workspace from the header and the id from the path', () => {
    expect(toScopedRead(read({ 'x-workspace-id': WORKSPACE }, { id: 'job-1' }), 'id')).toEqual({
      ok: true,
      value: { workspaceId: WORKSPACE, id: 'job-1' },
    });
  });

  it('requires the workspace, because an unscoped read is a cross-tenant read', () => {
    const outcome = toScopedRead(read({}, { id: 'job-1' }), 'id');
    expect(outcome).toEqual({
      ok: false,
      issues: [{ path: 'headers.x-workspace-id', code: 'REQUIRED' }],
    });
  });

  it('requires the workspace to be a UUID', () => {
    const outcome = toScopedRead(read({ 'x-workspace-id': 'nope' }, { id: 'job-1' }), 'id');
    expect(outcome).toEqual({
      ok: false,
      issues: [{ path: 'headers.x-workspace-id', code: 'NOT_A_UUID' }],
    });
  });

  it('requires the path parameter', () => {
    const outcome = toScopedRead(read({ 'x-workspace-id': WORKSPACE }, {}), 'id');
    expect(outcome).toEqual({ ok: false, issues: [{ path: 'path.id', code: 'REQUIRED' }] });
  });
});

describe('the resume position', () => {
  const streaming = (
    query: Record<string, string>,
    headers: Record<string, string>,
  ): ApiRequest => ({
    method: 'POST',
    path: '/v1/ai/stream',
    params: {},
    query,
    headers,
    body: {},
  });

  it('is absent when neither the query nor the header carries one', () => {
    expect(readResumeToken(streaming({}, {}))).toEqual({ ok: true, value: null });
    expect(readResumeToken(streaming({ resumeToken: '  ' }, {}))).toEqual({
      ok: true,
      value: null,
    });
  });

  it('reads the query parameter', () => {
    expect(readResumeToken(streaming({ resumeToken: 'stream:s@4' }, {}))).toEqual({
      ok: true,
      value: 'stream:s@4',
    });
  });

  it("reads SSE's Last-Event-ID, so a browser reconnect resumes without a query change", () => {
    expect(readResumeToken(streaming({}, { 'last-event-id': 'stream:s@9' }))).toEqual({
      ok: true,
      value: 'stream:s@9',
    });
  });
});
