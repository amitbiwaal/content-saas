import {
  createProviderRegistry,
  REJECTION_CODES,
  type AdmissionResult,
  type Gateway,
  type GatewayResponse,
  type Job,
  type ModelProvider,
  type ProviderRegistry,
  type RejectionCode,
  type StreamChunk,
  type StreamEvent,
  type WorkflowExecution,
} from '@contentos/ai';
import {
  PROVIDER_ERROR_CODES,
  ProviderError,
  type AIRequest,
  type AIResponse,
  type ProviderErrorCode,
  type Usage,
} from '@contentos/contracts';
import type { AuthContext } from '@contentos/security';
import { describe, expect, it } from 'vitest';

import {
  createAiControllers,
  type AiControllerOptions,
  type AiControllers,
} from './controllers.js';
import {
  isStreamResponse,
  type ApiResponse,
  type AuthenticatedRequest,
  type ErrorBody,
} from './http.js';
import type { AiDispatcher, JobReader, WorkflowReader } from './ports.js';

const ORG = '11111111-1111-4111-8111-111111111111';
const WORKSPACE = '22222222-2222-4222-8222-222222222222';

const USAGE: Usage = {
  tokens: { input: 10, output: 20, cachedInput: 0, total: 30, tokenizer: 'cl100k_base' },
  tokensEstimated: false,
  cost: { currency: 'USD', amount: '0.000300' },
  latencyMs: 120,
};

const AI_REQUEST: AIRequest = {
  taskType: 'planning.outline',
  capability: 'chat',
  model: 'gpt-4o',
  // The rendered prompt. Nothing this file returns may contain it.
  messages: [{ role: 'system', content: 'SECRET SYSTEM PROMPT' }],
  params: { temperature: 0.2, maxOutputTokens: 900 },
  timeoutMs: 30_000,
  idempotencyKey: 'idem-1',
  correlationId: 'corr-1',
  tenantId: WORKSPACE,
  organizationId: ORG,
};

const ADMITTED: AdmissionResult = {
  context: {
    tenant: { tenantId: WORKSPACE, organizationId: ORG, source: 'request' },
    organizationId: ORG,
    workspaceId: WORKSPACE,
    actorId: 'user-1',
    correlationId: 'corr-1',
    idempotencyKey: 'idem-1',
  },
  request: AI_REQUEST,
  promptVersion: 'planning.outline@7',
  providerId: 'openai',
  capability: 'chat',
  workflowId: 'workflow-1',
};

const RESPONSE: AIResponse = {
  idempotencyKey: 'idem-1',
  providerId: 'openai',
  model: 'gpt-4o-2026-01',
  content: 'an outline',
  finishReason: 'stop',
  usage: USAGE,
  providerMetadata: { 'x-vendor-request-id': 'vendor-123' },
};

const JOB: Job = {
  id: 'job-1',
  tenantId: WORKSPACE,
  workspaceId: WORKSPACE,
  organizationId: ORG,
  jobType: 'ai.execute',
  status: 'running',
  correlationId: 'corr-1',
  causationId: null,
  payload: { variables: { topic: 'CUSTOMER CONTENT' } },
  reason: null,
  createdAt: '2026-07-30T00:00:00.000Z',
  updatedAt: '2026-07-30T00:00:01.000Z',
  startedAt: '2026-07-30T00:00:01.000Z',
  completedAt: null,
};

const authFor = (workspaceId: string = WORKSPACE): AuthContext =>
  Object.freeze({
    requestId: 'req-1',
    correlationId: 'corr-1',
    principal: Object.freeze({
      subjectId: 'user-1',
      kind: 'user' as const,
      method: 'password' as const,
      organizationId: ORG,
      workspaceId,
      roles: Object.freeze(['editor' as const]),
      permissions: Object.freeze(['article:execute' as const, 'run:read' as const]),
      authenticatedAt: new Date('2026-07-31T00:00:00.000Z'),
      mfaSatisfied: true,
      sessionId: 'session-1',
    }),
    organization: Object.freeze({ id: ORG, status: 'active' }),
    workspace: Object.freeze({ id: workspaceId, status: 'active' }),
  });

const admitted: GatewayResponse = {
  admitted: true,
  decision: { outcome: 'admit' },
  result: ADMITTED,
};

const rejected = (code: RejectionCode): GatewayResponse => ({
  admitted: false,
  decision: {
    outcome: 'reject',
    code,
    stage: 'validate',
    // Deliberately full of things a response must never carry.
    reason: `workspace ${WORKSPACE} template planning.outline host db-primary.internal`,
  },
});

const chunk = (sequence: number, content: string, final = false): StreamChunk => ({
  sequence,
  content,
  finishReason: final ? 'stop' : null,
  usage: final ? USAGE : null,
  metadata: {},
});

function provider(overrides: Partial<ModelProvider> = {}): ModelProvider {
  return {
    providerId: 'openai',
    displayName: 'OpenAI',
    capabilities: ['chat', 'text'],
    health: () =>
      Promise.resolve({
        status: 'healthy' as const,
        reportedAt: '2026-07-30T00:00:00.000Z',
        detail: null,
      }),
    execute: () => Promise.resolve(RESPONSE),
    ...overrides,
  };
}

function registryWith(...providers: readonly ModelProvider[]): ProviderRegistry {
  const registry = createProviderRegistry();
  for (const one of providers) registry.register(one);
  registry.seal();
  return registry;
}

interface Harness {
  readonly controllers: AiControllers;
  readonly admitCalls: GatewayRequestLog[];
}

type GatewayRequestLog = { readonly taskType: string; readonly workspaceId: string };

function harness(overrides: Partial<AiControllerOptions> = {}): Harness {
  const admitCalls: GatewayRequestLog[] = [];
  const gateway: Gateway = {
    admit: (request) => {
      admitCalls.push({ taskType: request.taskType, workspaceId: request.workspaceId });
      return Promise.resolve(admitted);
    },
  };
  const dispatcher: AiDispatcher = {
    execute: () => Promise.resolve(RESPONSE),
    // eslint-disable-next-line @typescript-eslint/require-await
    async *stream(): AsyncIterable<StreamEvent> {
      yield {
        kind: 'started',
        streamId: 'idem-1',
        cursor: {
          streamId: 'idem-1',
          lastSequence: null,
          completed: false,
          resumeToken: 'stream:idem-1@start',
        },
      };
      yield {
        kind: 'chunk',
        streamId: 'idem-1',
        chunk: chunk(0, 'an outline', true),
        cursor: {
          streamId: 'idem-1',
          lastSequence: 0,
          completed: true,
          resumeToken: 'stream:idem-1@0',
        },
      };
    },
  };
  const jobs: JobReader = {
    findById: (workspaceId, jobId) =>
      Promise.resolve(workspaceId === WORKSPACE && jobId === 'job-1' ? JOB : null),
  };
  const workflows: WorkflowReader = { findById: () => Promise.resolve(null) };

  return {
    admitCalls,
    controllers: createAiControllers({
      gateway,
      dispatcher,
      jobs,
      workflows,
      providers: registryWith(provider()),
      version: '2.0.0',
      ...overrides,
    }),
  };
}

const post = (
  body: unknown,
  headers: Record<string, string> = {},
  auth: AuthContext = authFor(),
): AuthenticatedRequest => ({
  method: 'POST',
  path: '/v1/ai/execute',
  params: {},
  query: {},
  headers: { 'idempotency-key': 'idem-1', ...headers },
  body,
  auth,
});

const validBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  taskType: 'planning.outline',
  capability: 'chat',
  providerId: 'openai',
  model: 'gpt-4o',
  template: { id: 'planning.outline', version: 7 },
  variables: { topic: 'kettles' },
  ...overrides,
});

const get = (path: string, params: Record<string, string>, auth: AuthContext = authFor()) =>
  ({
    method: 'GET',
    path,
    params,
    query: {},
    headers: {},
    body: null,
    auth,
  }) satisfies AuthenticatedRequest;

const linesOf = async (result: { lines: AsyncIterable<string> }): Promise<string[]> => {
  const lines: string[] = [];
  for await (const line of result.lines) lines.push(line);
  return lines;
};

describe('POST /v1/ai/execute', () => {
  it('validates transport, admits through the Gateway, and returns the result', async () => {
    const { controllers, admitCalls } = harness();
    const response = await controllers.execute(post(validBody()));

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      workflowId: 'workflow-1',
      promptVersion: 'planning.outline@7',
      capability: 'chat',
      correlationId: 'corr-1',
      idempotencyKey: 'idem-1',
      providerId: 'openai',
      model: 'gpt-4o-2026-01',
      content: 'an outline',
      finishReason: 'stop',
      usage: USAGE,
    });
    expect(admitCalls).toEqual([{ taskType: 'planning.outline', workspaceId: WORKSPACE }]);
  });

  it('never returns the rendered prompt or the vendor metadata', async () => {
    const { controllers } = harness();
    const serialized = JSON.stringify((await controllers.execute(post(validBody()))).body);

    expect(serialized).not.toContain('SECRET SYSTEM PROMPT');
    expect(serialized).not.toContain('messages');
    expect(serialized).not.toContain('vendor-123');
  });

  it('rejects a malformed body before the Gateway is reached', async () => {
    const { controllers, admitCalls } = harness();
    const response = await controllers.execute(post(validBody({ capability: 'telepathy' })));

    expect(response.status).toBe(400);
    expect((response.body as ErrorBody).error).toMatchObject({
      code: 'invalid_request',
      requestId: 'req-1',
      details: [{ path: 'body.capability', code: 'NOT_A_CAPABILITY' }],
    });
    expect(admitCalls).toEqual([]);
  });

  it('maps every admission rejection to a status, and leaks none of the reason', async () => {
    for (const code of REJECTION_CODES) {
      const { controllers } = harness({
        // eslint-disable-next-line @typescript-eslint/require-await
        gateway: { admit: async () => rejected(code) },
      });
      const response = await controllers.execute(post(validBody()));
      const serialized = JSON.stringify(response.body);

      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(serialized).not.toContain(WORKSPACE);
      expect(serialized).not.toContain('planning.outline');
      expect(serialized).not.toContain('db-primary.internal');
      expect((response.body as ErrorBody).error.requestId).toBe('req-1');
    }
  });

  it('maps the rejections a client can act on to the statuses they expect', async () => {
    const expected: Partial<Record<RejectionCode, number>> = {
      MalformedRequest: 400,
      RequestTooLarge: 413,
      UnknownWorkspace: 404,
      WorkspaceNotAdmitting: 403,
      MembershipRequired: 403,
      FeatureDisabled: 403,
      UnknownProvider: 400,
      CapabilityUnavailable: 422,
      UnknownPrompt: 404,
      PreparationFailed: 422,
    };
    for (const [code, status] of Object.entries(expected)) {
      const { controllers } = harness({
        // eslint-disable-next-line @typescript-eslint/require-await
        gateway: { admit: async () => rejected(code as RejectionCode) },
      });
      expect((await controllers.execute(post(validBody()))).status).toBe(status);
    }
  });

  it('maps every provider failure without carrying the vendor message', async () => {
    const statuses: Record<ProviderErrorCode, number> = {
      Authentication: 502,
      RateLimit: 429,
      Unavailable: 503,
      Timeout: 504,
      Validation: 500,
      ContentFiltered: 422,
      ContextTooLarge: 413,
      ModelUnavailable: 503,
      MalformedResponse: 502,
      Internal: 502,
    };

    for (const code of PROVIDER_ERROR_CODES) {
      const { controllers } = harness({
        dispatcher: {
          execute: () =>
            Promise.reject(
              new ProviderError(code, 'openai', 'Incorrect API key sk-live-abcdef provided'),
            ),

          async *stream(): AsyncIterable<StreamEvent> {},
        },
      });
      const response = await controllers.execute(post(validBody()));

      expect(response.status).toBe(statuses[code]);
      expect(JSON.stringify(response.body)).not.toContain('sk-live-abcdef');
    }
  });

  it('passes the retry-after a provider gave, in seconds, and invents none otherwise', async () => {
    const withHeader = harness({
      dispatcher: {
        execute: () =>
          Promise.reject(
            new ProviderError('RateLimit', 'openai', 'slow down', { retryAfterMs: 2400 }),
          ),

        async *stream(): AsyncIterable<StreamEvent> {},
      },
    });
    const limited = await withHeader.controllers.execute(post(validBody()));
    expect(limited.headers['retry-after']).toBe('3');

    const without = harness({
      dispatcher: {
        execute: () => Promise.reject(new ProviderError('RateLimit', 'openai', 'slow down')),

        async *stream(): AsyncIterable<StreamEvent> {},
      },
    });
    expect(
      (await without.controllers.execute(post(validBody()))).headers['retry-after'],
    ).toBeUndefined();
  });

  it('turns an unrecognised failure into an opaque 500', async () => {
    const { controllers } = harness({
      dispatcher: {
        execute: () => Promise.reject(new Error('at Object.<anonymous> (/srv/app/db.ts:41)')),

        async *stream(): AsyncIterable<StreamEvent> {},
      },
    });
    const response = await controllers.execute(post(validBody()));

    expect(response.status).toBe(500);
    expect(JSON.stringify(response.body)).not.toContain('/srv/app/db.ts');
  });
});

describe('POST /v1/ai/stream', () => {
  it('streams NDJSON, one canonical StreamEvent per line', async () => {
    const { controllers } = harness();
    const result = await controllers.stream(post(validBody()));

    expect(isStreamResponse(result)).toBe(true);
    if (!isStreamResponse(result)) return;
    expect(result.status).toBe(200);
    expect(result.headers['content-type']).toBe('application/x-ndjson');

    const lines = await linesOf(result);
    expect(lines).toHaveLength(2);
    expect(lines.every((line) => line.endsWith('\n'))).toBe(true);
    expect(lines.map((line) => (JSON.parse(line) as StreamEvent).kind)).toEqual([
      'started',
      'chunk',
    ]);
  });

  it('tells intermediaries not to buffer, which would make a stream a slow response', async () => {
    const { controllers } = harness();
    const result = await controllers.stream(post(validBody()));
    if (!isStreamResponse(result)) throw new Error('expected a stream');
    expect(result.headers).toMatchObject({
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
    });
  });

  it('returns an ordinary JSON error when admission refuses, before any byte is written', async () => {
    const { controllers } = harness({
      // eslint-disable-next-line @typescript-eslint/require-await
      gateway: { admit: async () => rejected('WorkspaceNotAdmitting') },
    });
    const result = await controllers.stream(post(validBody()));

    expect(isStreamResponse(result)).toBe(false);
    expect((result as ApiResponse).status).toBe(403);
  });

  it('returns a JSON error when the provider refuses to open the stream at all', async () => {
    const { controllers } = harness({
      dispatcher: {
        execute: () => Promise.resolve(RESPONSE),
        // eslint-disable-next-line @typescript-eslint/require-await, require-yield
        async *stream(): AsyncIterable<StreamEvent> {
          throw new ProviderError('Unavailable', 'openai', 'This provider does not stream.');
        },
      },
    });
    const result = await controllers.stream(post(validBody()));

    expect(isStreamResponse(result)).toBe(false);
    expect((result as ApiResponse).status).toBe(503);
  });

  it('reports a mid-stream failure in-band, because the status line has already gone', async () => {
    const { controllers } = harness({
      dispatcher: {
        execute: () => Promise.resolve(RESPONSE),
        // eslint-disable-next-line @typescript-eslint/require-await
        async *stream(): AsyncIterable<StreamEvent> {
          yield {
            kind: 'started',
            streamId: 'idem-1',
            cursor: {
              streamId: 'idem-1',
              lastSequence: null,
              completed: false,
              resumeToken: 'stream:idem-1@start',
            },
          };
          throw new ProviderError('Timeout', 'openai', 'vendor said: gateway timeout at 10.0.0.4');
        },
      },
    });
    const result = await controllers.stream(post(validBody()));
    if (!isStreamResponse(result)) throw new Error('expected a stream');

    const lines = await linesOf(result);
    const last = JSON.parse(lines.at(-1) as string) as StreamEvent;
    expect(last).toMatchObject({ kind: 'failed', code: 'Timeout' });
    expect(lines.join()).not.toContain('10.0.0.4');
  });

  it('reports an unrecognised mid-stream failure as Internal', async () => {
    const { controllers } = harness({
      dispatcher: {
        execute: () => Promise.resolve(RESPONSE),
        // eslint-disable-next-line @typescript-eslint/require-await
        async *stream(): AsyncIterable<StreamEvent> {
          yield {
            kind: 'started',
            streamId: 'idem-1',
            cursor: {
              streamId: 'idem-1',
              lastSequence: null,
              completed: false,
              resumeToken: 'stream:idem-1@start',
            },
          };
          throw new Error('kaboom');
        },
      },
    });
    const result = await controllers.stream(post(validBody()));
    if (!isStreamResponse(result)) throw new Error('expected a stream');

    const last = JSON.parse((await linesOf(result)).at(-1) as string) as StreamEvent;
    expect(last).toMatchObject({ kind: 'failed', code: 'Internal' });
  });

  it('rejects a resume token this platform did not mint', async () => {
    // Treating it as absent would restart a stream the client believed it was
    // resuming, duplicating everything already rendered.
    const { controllers } = harness();
    const result = await controllers.stream({
      ...post(validBody()),
      query: { resumeToken: 'not-ours' },
    });

    expect(isStreamResponse(result)).toBe(false);
    expect((result as ApiResponse).status).toBe(400);
    expect(((result as ApiResponse).body as ErrorBody).error.details).toEqual([
      { path: 'query.resumeToken', code: 'UNRECOGNISED' },
    ]);
  });

  it('passes a recognised resume position to the dispatcher', async () => {
    let received: unknown = 'not called';
    const { controllers } = harness({
      dispatcher: {
        execute: () => Promise.resolve(RESPONSE),
        // eslint-disable-next-line @typescript-eslint/require-await, require-yield
        async *stream(_admitted, resume): AsyncIterable<StreamEvent> {
          received = resume;
        },
      },
    });
    await controllers.stream({ ...post(validBody()), query: { resumeToken: 'stream:idem-1@4' } });

    expect(received).toEqual({
      streamId: 'idem-1',
      lastSequence: 4,
      completed: false,
      resumeToken: 'stream:idem-1@4',
    });
  });

  it('validates transport before admitting, as the buffered endpoint does', async () => {
    const { controllers, admitCalls } = harness();
    const result = await controllers.stream(post(validBody(), { 'idempotency-key': '' }));

    expect((result as ApiResponse).status).toBe(400);
    expect(admitCalls).toEqual([]);
  });
});

describe('GET /v1/ai/jobs/:id', () => {
  it('returns the job, without its payload', async () => {
    const { controllers } = harness();
    const response = await controllers.job(get('/v1/ai/jobs/job-1', { id: 'job-1' }));

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      id: 'job-1',
      status: 'running',
      jobType: 'ai.execute',
      workspaceId: WORKSPACE,
      correlationId: 'corr-1',
      reason: null,
      createdAt: '2026-07-30T00:00:00.000Z',
      updatedAt: '2026-07-30T00:00:01.000Z',
      startedAt: '2026-07-30T00:00:01.000Z',
      completedAt: null,
    });
    expect(JSON.stringify(response.body)).not.toContain('CUSTOMER CONTENT');
  });

  it("returns 404 for another workspace's job, never 403", async () => {
    // A 403 would confirm the id exists, which is the disclosure the rule is for.
    const { controllers } = harness();
    const response = await controllers.job(get('/v1/ai/jobs/job-1', { id: 'job-1' }, authFor(ORG)));

    expect(response.status).toBe(404);
    expect((response.body as ErrorBody).error.code).toBe('not_found');
  });

  it('returns 404 for a job that does not exist anywhere', async () => {
    const { controllers } = harness();
    expect((await controllers.job(get('/v1/ai/jobs/nope', { id: 'nope' }))).status).toBe(404);
  });

  it('refuses a read with no identifier in the path', async () => {
    const { controllers } = harness();
    const response = await controllers.job({ ...get('/v1/ai/jobs/', {}), params: {} });

    expect(response.status).toBe(400);
    expect((response.body as ErrorBody).error.details).toEqual([
      { path: 'path.id', code: 'REQUIRED' },
    ]);
  });
});

describe('GET /v1/ai/workflows/:id', () => {
  const execution = {
    workflowId: 'workflow-1',
    definition: { id: 'ai.single', version: 3, steps: [] },
    context: {
      tenant: { tenantId: WORKSPACE, organizationId: ORG, source: 'request' },
      jobId: 'job-1',
      correlationId: 'corr-1',
      metadata: {},
    },
    state: {
      status: 'completed',
      stepIndex: 0,
      stepId: 'step-1',
      promptRef: null,
      compiled: null,
      prepared: null,
      variables: {},
      completedSteps: [
        {
          stepId: 'step-1',
          promptVersion: 'planning.outline@7',
          idempotencyKey: 'idem-1',
          providerId: 'openai',
          model: 'gpt-4o',
          finishReason: 'stop',
          usage: USAGE,
          content: 'GENERATED ARTICLE BODY',
        },
      ],
      failure: 'template planning.outline failed to render',
    },
  } as unknown as WorkflowExecution;

  it('returns the run, without the generated content or the failure text', async () => {
    const { controllers } = harness({
      workflows: {
        findById: (workspaceId, id) =>
          Promise.resolve(workspaceId === WORKSPACE && id === 'workflow-1' ? execution : null),
      },
    });
    const response = await controllers.workflow(
      get('/v1/ai/workflows/workflow-1', { id: 'workflow-1' }),
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      workflowId: 'workflow-1',
      definitionId: 'ai.single',
      definitionVersion: 3,
      status: 'completed',
      stepIndex: 0,
      stepId: 'step-1',
      jobId: 'job-1',
      correlationId: 'corr-1',
      steps: [
        {
          stepId: 'step-1',
          promptVersion: 'planning.outline@7',
          providerId: 'openai',
          model: 'gpt-4o',
          finishReason: 'stop',
          usage: USAGE,
        },
      ],
    });
    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain('GENERATED ARTICLE BODY');
    expect(serialized).not.toContain('failed to render');
  });

  it('returns 404 for an unknown or out-of-tenant workflow', async () => {
    const { controllers } = harness();
    expect((await controllers.workflow(get('/v1/ai/workflows/nope', { id: 'nope' }))).status).toBe(
      404,
    );
  });

  it('refuses a read with no identifier in the path', async () => {
    const { controllers } = harness();
    const response = await controllers.workflow({
      ...get('/v1/ai/workflows/', {}),
      params: {},
    });
    expect(response.status).toBe(400);
  });
});

describe('GET /v1/ai/providers', () => {
  it('lists id, display name, capabilities and health', async () => {
    const { controllers } = harness();
    const response = await controllers.listProviders(get('/v1/ai/providers', {}));

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      providers: [
        {
          providerId: 'openai',
          displayName: 'OpenAI',
          capabilities: ['chat', 'text'],
          health: { status: 'healthy', reportedAt: '2026-07-30T00:00:00.000Z' },
        },
      ],
    });
  });

  it('includes models only where a provider publishes them', async () => {
    const withModels = { ...provider(), providerId: 'anthropic', models: ['claude-x', 42] };
    const { controllers } = harness({
      providers: registryWith(provider(), withModels as ModelProvider),
    });
    const body = (await controllers.listProviders(get('/v1/ai/providers', {}))).body as {
      providers: readonly Record<string, unknown>[];
    };

    expect('models' in (body.providers[0] as object)).toBe(false);
    expect(body.providers[1]?.['models']).toEqual(['claude-x']);
  });

  it('omits an empty model list rather than claiming a provider supports none', async () => {
    const empty = { ...provider(), providerId: 'google', models: [] };
    const { controllers } = harness({ providers: registryWith(empty as ModelProvider) });
    const body = (await controllers.listProviders(get('/v1/ai/providers', {}))).body as {
      providers: readonly Record<string, unknown>[];
    };
    expect('models' in (body.providers[0] as object)).toBe(false);
  });

  it('reports a provider whose health call throws as offline, and still lists the rest', async () => {
    const broken = {
      ...provider(),
      providerId: 'anthropic',
      health: () => Promise.reject(new Error('connection refused to 10.0.0.9')),
    };
    const { controllers } = harness({
      providers: registryWith(provider(), broken as ModelProvider),
    });
    const response = await controllers.listProviders(get('/v1/ai/providers', {}));
    const body = response.body as { providers: readonly Record<string, unknown>[] };

    expect(body.providers).toHaveLength(2);
    expect(body.providers[1]?.['health']).toEqual({ status: 'offline', reportedAt: null });
    expect(JSON.stringify(response.body)).not.toContain('10.0.0.9');
  });
});

describe('GET /v1/ai/health', () => {
  it('reports service status, gateway readiness, registry state and version', async () => {
    const { controllers } = harness();
    const response = await controllers.health(get('/v1/ai/health', {}));

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      status: 'ok',
      version: '2.0.0',
      gateway: { ready: true },
      registry: { sealed: true, providers: 1 },
      providers: [{ providerId: 'openai', status: 'healthy' }],
    });
  });

  it('is degraded when the registry is sealed but nothing can take a call', async () => {
    const offline = {
      ...provider(),
      health: () =>
        Promise.resolve({
          status: 'offline' as const,
          reportedAt: '2026-07-30T00:00:00.000Z',
          detail: 'down',
        }),
    };
    const { controllers } = harness({ providers: registryWith(offline) });
    const response = await controllers.health(get('/v1/ai/health', {}));

    expect(response.body).toMatchObject({ status: 'degraded', gateway: { ready: false } });
  });

  it('is degraded while the registry is still open, because startup has not finished', async () => {
    const open = createProviderRegistry();
    open.register(provider());
    const { controllers } = harness({ providers: open });

    expect((await controllers.health(get('/v1/ai/health', {}))).body).toMatchObject({
      status: 'degraded',
      registry: { sealed: false },
    });
  });

  it('answers 200 either way, so a probe can tell degraded from unreachable', async () => {
    const { controllers } = harness({ providers: registryWith() });
    expect((await controllers.health(get('/v1/ai/health', {}))).status).toBe(200);
  });

  it('runs no database diagnostics — nothing it reports comes from persistence', async () => {
    const { controllers } = harness({
      jobs: {
        findById: () => Promise.reject(new Error('the database must not be touched')),
      },
      workflows: {
        findById: () => Promise.reject(new Error('the database must not be touched')),
      },
    });
    await expect(controllers.health(get('/v1/ai/health', {}))).resolves.toMatchObject({
      status: 200,
    });
  });
});
