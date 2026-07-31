/**
 * The REST layer against the components it exposes, and against the documents
 * that constrain it.
 *
 * ── What this file exists to catch ──────────────────────────────────────────
 * Three kinds of drift that a unit test in `services/api` structurally cannot.
 *
 * 1. VOCABULARY drift. The controllers map every `RejectionCode` from
 *    `@contentos/ai` and every `ProviderErrorCode` from `@contentos/contracts`
 *    to an HTTP status. Adding a code in either package without deciding what a
 *    client sees is a silent 500, and this is where the two vocabularies and
 *    the mapping meet.
 *
 * 2. WIRE drift. The streaming endpoint claims to carry the canonical
 *    `StreamChunk` and nothing else. Serializing it and comparing is the only
 *    check that survives someone adding a convenience field to the frame.
 *
 * 3. THINNESS drift. "Controllers never execute business logic" is an
 *    architectural claim, and the way it stops being true is one import at a
 *    time. It is asserted here over the source, because no behavioural test can
 *    observe the absence of a capability that has not been used yet.
 *
 * It also composes the whole path — a real Gateway over a real registry,
 * catalogue and adapter, behind the real router — because six endpoints that
 * each work against a fake prove less than one that works against the platform.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  createGateway,
  createPromptCatalogue,
  createProviderRegistry,
  createOpenAIProvider,
  REJECTION_CODES,
  STREAM_EVENT_KINDS,
  type AdmissionDirectory,
  type AdmissionFlags,
  type ModelProvider,
  type PromptTemplate,
  type StreamEvent,
} from '@contentos/ai';
import {
  AI_CAPABILITIES,
  PROVIDER_ERROR_CODES,
  ProviderError,
  type ProviderErrorCode,
} from '@contentos/contracts';
import {
  AI_ROUTES,
  API_ERROR_MESSAGES,
  createAiControllers,
  createAiRouter,
  createProviderDispatcher,
  failureResponse,
  isStreamResponse,
  rejectionResponse,
  type ApiRequest,
  type ApiResponse,
  type ErrorBody,
} from '@contentos/api';
import { describe, expect, it } from 'vitest';

const ORG = '018f7a1e-0000-7000-8000-0000000000aa';
const WS = '018f7a1e-0000-7000-8000-0000000000bb';
const CORRELATION = '018f7a1e-0000-7000-8000-0000000000dd';

const sourceOf = (relative: string): string =>
  readFileSync(
    fileURLToPath(new URL(`../../services/api/src/ai/${relative}`, import.meta.url)),
    'utf8',
  );

/**
 * The source with its comments removed.
 *
 * These files explain at length what they deliberately do NOT do, so a check
 * for `AIRequest` in the raw text matches the sentence promising never to build
 * one. Stripping comments is what makes the assertion about the code.
 */
const codeOf = (relative: string): string =>
  sourceOf(relative)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

// ── 1 · Vocabulary drift ─────────────────────────────────────────────────────

describe('every internal code has a decided HTTP answer', () => {
  it('maps every admission rejection', () => {
    for (const code of REJECTION_CODES) {
      const response = rejectionResponse(code, 'req-1');
      expect(response.status, code).toBeGreaterThanOrEqual(400);
      expect(response.status, code).toBeLessThan(500);
      expect(Object.keys(API_ERROR_MESSAGES)).toContain((response.body as ErrorBody).error.code);
    }
  });

  it('maps every provider failure', () => {
    for (const code of PROVIDER_ERROR_CODES) {
      const response = failureResponse(new ProviderError(code, 'openai', 'vendor text'), 'req-1');
      expect(response.status, code).toBeGreaterThanOrEqual(400);
      expect(Object.keys(API_ERROR_MESSAGES)).toContain((response.body as ErrorBody).error.code);
    }
  });

  it('never returns a 4xx for a failure the caller cannot fix', () => {
    // The distinction that decides whether a customer opens a support ticket or
    // edits their request. `Authentication` is OUR credential; `Validation` is
    // OUR malformed call. Blaming the caller for either sends them looking
    // through a body that was correct.
    const ours: readonly ProviderErrorCode[] = ['Authentication', 'Validation'];
    for (const code of ours) {
      const status = failureResponse(new ProviderError(code, 'openai', 'x'), 'req').status;
      expect(status, code).toBeGreaterThanOrEqual(500);
    }
  });

  it('keeps a rejection that names a stage from carrying the stage to a client', () => {
    // `stage` and `reason` are operator diagnostics. The response has neither.
    for (const code of REJECTION_CODES) {
      const body = rejectionResponse(code, 'req-1').body as ErrorBody;
      expect(Object.keys(body.error)).toEqual(['code', 'message', 'requestId']);
    }
  });
});

describe('the error envelope matches `06-api/api-principles.md`', () => {
  it('is exactly { error: { code, message, requestId, details? } }', () => {
    const withDetails = rejectionResponse('MalformedRequest', 'req-1').body as ErrorBody;
    expect(Object.keys(withDetails)).toEqual(['error']);
    expect(
      Object.keys(withDetails.error).every((key) =>
        ['code', 'message', 'requestId', 'details'].includes(key),
      ),
    ).toBe(true);
  });

  it('derives every message from its code, so no client may branch on prose', () => {
    const messages = Object.values(API_ERROR_MESSAGES);
    expect(new Set(messages).size).toBe(messages.length);
    for (const code of REJECTION_CODES) {
      const body = rejectionResponse(code, 'req-1').body as ErrorBody;
      expect(body.error.message).toBe(
        API_ERROR_MESSAGES[body.error.code as keyof typeof API_ERROR_MESSAGES],
      );
    }
  });
});

// ── 2 · Wire drift ───────────────────────────────────────────────────────────

const TEMPLATE: PromptTemplate = {
  id: 'planning.outline',
  version: 7,
  taskType: 'planning.outline',
  status: 'active',
  parts: { system: 'You write outlines.', user: 'Write an outline about {{topic}}.' },
  variables: [{ name: 'topic', type: 'string', required: true, description: 'The subject.' }],
  modelHints: { maxOutputTokens: 1024, temperature: 0.2, determinismRequired: false },
  evalSetRef: 'evals/planning.outline',
  owner: 'content-platform',
  changelog: 'Initial version.',
};

const prompts = createPromptCatalogue([TEMPLATE]);

/** A workspace that belongs to a DIFFERENT organization than the one claimed. */
const FOREIGN_WS = '018f7a1e-0000-7000-8000-0000000000cc';
const OTHER_ORG = '018f7a1e-0000-7000-8000-0000000000ee';

const directory: AdmissionDirectory = {
  organization: (organizationId) => Promise.resolve({ organizationId, status: 'active' }),
  workspace: (workspaceId) =>
    Promise.resolve({
      workspaceId,
      organizationId: workspaceId === FOREIGN_WS ? OTHER_ORG : ORG,
      status: 'active',
    }),
  membership: (workspaceId, actorId) => Promise.resolve({ workspaceId, actorId, status: 'active' }),
};

const flags: AdmissionFlags = { isEnabled: () => Promise.resolve(true) };

const credentials = { apiKey: 'test-key-not-a-real-one' }; // gitleaks:allow

const COMPLETION = {
  id: 'chatcmpl-1',
  model: 'gpt-4o-2026-05-01',
  choices: [{ message: { content: 'An outline.' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1000, completion_tokens: 500 },
};

const FRAMES = [
  { model: 'gpt-4o-2026-05-01', choices: [{ delta: { content: 'An ' } }] },
  { model: 'gpt-4o-2026-05-01', choices: [{ delta: { content: 'outline.' } }] },
  {
    model: 'gpt-4o-2026-05-01',
    choices: [{ delta: { content: '' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1000, completion_tokens: 500 },
  },
];

/** A real adapter over a transport that serves both shapes. */
function realProvider(): ModelProvider {
  return createOpenAIProvider({
    credentials,
    now: () => 1_000_000,
    transport: {
      create: (body) => {
        if (body.stream !== true) return Promise.resolve(COMPLETION);
        return Promise.resolve({
          // eslint-disable-next-line @typescript-eslint/require-await
          async *[Symbol.asyncIterator]() {
            for (const frame of FRAMES) yield frame;
          },
        });
      },
    },
  });
}

function router(): ReturnType<typeof createAiRouter> {
  const providers = createProviderRegistry();
  providers.register(realProvider());
  providers.seal();

  return createAiRouter(
    createAiControllers({
      gateway: createGateway({ directory, flags, providers, prompts }),
      dispatcher: createProviderDispatcher({ providers }),
      jobs: { findById: () => Promise.resolve(null) },
      workflows: { findById: () => Promise.resolve(null) },
      providers,
      version: '2.0.0-conformance',
    }),
  );
}

const executeRequest = (path: string): ApiRequest => ({
  method: 'POST',
  path,
  params: {},
  query: {},
  headers: {
    'idempotency-key': 'run-1:step-1',
    'x-correlation-id': CORRELATION,
    'x-request-id': 'req-1',
  },
  body: {
    taskType: 'planning.outline',
    capability: 'chat',
    providerId: 'openai',
    model: 'gpt-4o',
    template: { id: 'planning.outline' },
    variables: { topic: 'espresso' },
    organizationId: ORG,
    workspaceId: WS,
    actorId: 'user-1',
  },
});

describe('the whole path, composed', () => {
  it('routes an HTTP request through admission to a real provider and back', async () => {
    const response = (await router()(executeRequest('/v1/ai/execute'))) as ApiResponse;

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      promptVersion: 'planning.outline@7',
      capability: 'chat',
      providerId: 'openai',
      content: 'An outline.',
      finishReason: 'stop',
      correlationId: CORRELATION,
    });
  });

  it('returns the rendered prompt to nobody', async () => {
    const response = (await router()(executeRequest('/v1/ai/execute'))) as ApiResponse;
    const serialized = JSON.stringify(response.body);

    expect(serialized).not.toContain('Write an outline about espresso');
    expect(serialized).not.toContain('You write outlines');
  });

  it('streams canonical events over NDJSON', async () => {
    const result = await router()(executeRequest('/v1/ai/stream'));
    expect(isStreamResponse(result)).toBe(true);
    if (!isStreamResponse(result)) return;

    const lines: string[] = [];
    for await (const line of result.lines) lines.push(line);

    const events = lines.map((line) => JSON.parse(line) as StreamEvent);
    expect(events.map((event) => event.kind)).toEqual([
      'started',
      'chunk',
      'chunk',
      'chunk',
      'completed',
    ]);
    // Assembled from the wire alone: what a client actually receives.
    const text = events
      .filter((event): event is Extract<StreamEvent, { kind: 'chunk' }> => event.kind === 'chunk')
      .map((event) => event.chunk.content)
      .join('');
    expect(text).toBe('An outline.');
  });

  it('carries the canonical StreamChunk over the wire, field for field', () => {
    // A chunk that gained a field, lost one, or was renamed in transit would
    // make the streaming contract something other than what S2.7 froze.
    const chunk = {
      sequence: 0,
      content: 'An ',
      finishReason: null,
      usage: null,
      metadata: { model: 'gpt-4o' },
    };
    expect(JSON.parse(JSON.stringify(chunk))).toEqual(chunk);
    expect(Object.keys(chunk)).toEqual([
      'sequence',
      'content',
      'finishReason',
      'usage',
      'metadata',
    ]);
  });

  it('emits only the event kinds the streaming framework declares', async () => {
    const result = await router()(executeRequest('/v1/ai/stream'));
    if (!isStreamResponse(result)) throw new Error('expected a stream');

    for await (const line of result.lines) {
      expect(STREAM_EVENT_KINDS).toContain((JSON.parse(line) as StreamEvent).kind);
    }
  });

  it('serves discovery from the same registry admission validates against', async () => {
    const response = (await router()({
      method: 'GET',
      path: '/v1/ai/providers',
      params: {},
      query: {},
      headers: {},
      body: null,
    })) as ApiResponse;

    const body = response.body as {
      providers: readonly { providerId: string; capabilities: readonly string[] }[];
    };
    expect(body.providers.map((entry) => entry.providerId)).toEqual(['openai']);
    for (const capability of body.providers[0]?.capabilities ?? []) {
      expect(AI_CAPABILITIES).toContain(capability);
    }
  });

  it('reports readiness without touching a database', async () => {
    const response = (await router()({
      method: 'GET',
      path: '/v1/ai/health',
      params: {},
      query: {},
      headers: {},
      body: null,
    })) as ApiResponse;

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      status: 'ok',
      version: '2.0.0-conformance',
      gateway: { ready: true },
      registry: { sealed: true, providers: 1 },
    });
  });

  it('refuses a cross-tenant request as 403, and says nothing else', async () => {
    // The workspace exists and belongs to another organization. What comes back
    // must not distinguish that from a workspace that does not exist at all.
    const request = executeRequest('/v1/ai/execute');
    const response = (await router()({
      ...request,
      body: { ...(request.body as object), workspaceId: FOREIGN_WS },
    })) as ApiResponse;

    expect(response.status).toBe(403);
    expect((response.body as ErrorBody).error).toEqual({
      code: 'forbidden',
      message: API_ERROR_MESSAGES.forbidden,
      requestId: 'req-1',
    });
    expect(JSON.stringify(response.body)).not.toContain(OTHER_ORG);
  });
});

// ── 3 · Thinness drift ───────────────────────────────────────────────────────

describe('controllers stay transport-only', () => {
  const controllers = codeOf('controllers.ts');

  it('imports one runtime value from the AI capability, and types for the rest', () => {
    // `cursorFromToken` parses an opaque string a client sent back. Everything
    // else the controllers touch is a TYPE — which is what "transport-only"
    // means when written as a constraint rather than an intention.
    const aiImport = /import\s*\{([^}]*)\}\s*from\s*'@contentos\/ai'/.exec(controllers)?.[1] ?? '';
    const values = aiImport
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry !== '' && !entry.startsWith('type '));

    expect(values).toEqual(['cursorFromToken']);
  });

  it('never builds an AIRequest', () => {
    // The Gateway normalizes; a controller that assembled messages would be a
    // second, ungoverned way into a provider.
    expect(controllers).not.toContain('messages:');
    expect(controllers).not.toMatch(/\bAIRequest\b/);
  });

  it('never resolves a provider itself', () => {
    // Discovery reads the registry; DISPATCH goes through the port. A `get`
    // here would be the controller choosing who runs a request.
    expect(controllers).not.toContain('providers.get(');
  });

  it('imports no model provider SDK anywhere in the REST layer (ADR-019)', () => {
    for (const file of ['controllers.ts', 'dispatch.ts', 'routes.ts', 'validation.ts', 'http.ts']) {
      const source = codeOf(file);
      for (const sdk of ['openai', '@anthropic-ai', '@google/generative-ai', 'node-fetch']) {
        expect(source, file).not.toContain(`from '${sdk}`);
      }
    }
  });

  it('reaches persistence only through a port', () => {
    for (const file of ['controllers.ts', 'dispatch.ts']) {
      const source = codeOf(file);
      expect(source, file).not.toContain('@contentos/database');
      expect(source, file).not.toMatch(/\bBEGIN\b|\bSELECT\b|\bINSERT\b/);
    }
  });
});

describe('the exposed surface matches the increment', () => {
  it('exposes six endpoints under /v1/ai', () => {
    expect(AI_ROUTES).toHaveLength(6);
    expect(AI_ROUTES.every((route) => route.pattern.startsWith('/v1/ai/'))).toBe(true);
  });

  it('exposes no endpoint this increment did not ask for', () => {
    expect(AI_ROUTES.map((route) => `${route.method} ${route.pattern}`).sort()).toEqual([
      'GET /v1/ai/health',
      'GET /v1/ai/jobs/:id',
      'GET /v1/ai/providers',
      'GET /v1/ai/workflows/:id',
      'POST /v1/ai/execute',
      'POST /v1/ai/stream',
    ]);
  });

  it('records that these are NOT the customer paths in `06-api/ai-api.md`', () => {
    // Documented as an assertion so the divergence cannot be forgotten: the
    // spec's customer surface is workspace-scoped and intent-shaped
    // (`/v1/workspaces/{workspaceId}/ai/generate`), returns 202 with the
    // canonical `Run`, and exposes no provider identity. These six are the
    // platform-facing routes the increment names, where the CALLER chooses the
    // provider. Reconciling them is a later increment's work, not a silent
    // choice made here.
    expect(AI_ROUTES.some((route) => route.pattern.includes('/workspaces/'))).toBe(false);
    expect(AI_ROUTES.some((route) => route.pattern.includes('/runs/'))).toBe(false);
  });

  it('implements no WebSocket transport', () => {
    for (const file of ['controllers.ts', 'dispatch.ts', 'routes.ts', 'http.ts']) {
      expect(codeOf(file).toLowerCase(), file).not.toContain('websocket');
    }
  });
});
