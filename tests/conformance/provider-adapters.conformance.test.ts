/**
 * The three adapters against everything built before them.
 *
 * ── The property this suite exists for ──────────────────────────────────────
 * `provider-adapters.md`: "a normalization contract strict enough that two
 * adapters produce indistinguishable results for equivalent work", and
 * "nothing above the Gateway can tell which vendor executed a request".
 *
 * So the tests below run ONE canonical request through three genuinely
 * different vendors — three message shapes, three sets of field names, three
 * finish-reason vocabularies — and assert that what comes back differs only in
 * the two fields that are allowed to: which provider ran it, and which model.
 *
 * Everything downstream then consumes those responses through its existing
 * path: the workflow records them, the meter prices them, the retry engine
 * decides about their failures, and S2.7 assembles their streams. None of them
 * is told which vendor was involved, and that is the whole test.
 */

import { describe, expect, it } from 'vitest';

import {
  acceptChunk,
  ANTHROPIC_PROVIDER_ID,
  assembleResponse,
  awaitExecution,
  beginRetryState,
  buildRequest,
  createAnthropicProvider,
  createGoogleProvider,
  createOpenAIProvider,
  createOpenRouterProvider,
  createPricingRegistry,
  createPromptCatalogue,
  createProviderRegistry,
  createWorkflowExecution,
  decideRetry,
  GOOGLE_PROVIDER_ID,
  isStreamingProvider,
  loadStep,
  OPENAI_PROVIDER_ID,
  openStream,
  pendingRequest,
  preparePrompt,
  recordExecution,
  recordFailure,
  recordResponseUsage,
  resultOf,
  startStream,
  startWorkflow,
  validateAIResponse,
  type AIStream,
  type AnthropicTransport,
  type GoogleTransport,
  type ModelProvider,
  type OpenAITransport,
  type PromptTemplate,
  type StreamingModelProvider,
  type WorkflowDefinition,
  type WorkflowExecutionContext,
} from '@contentos/ai';
import { ProviderError, type AIRequest, type AIResponse } from '@contentos/contracts';

const WS = '018f7a1e-0000-7000-8000-0000000000bb';
const ORG = '018f7a1e-0000-7000-8000-0000000000aa';
const CORRELATION = '018f7a1e-0000-7000-8000-0000000000dd';
const JOB = '018f7a1e-0000-7000-7003-000000000001';

const credentials = { apiKey: 'test-key-not-a-real-one' }; // gitleaks:allow

/** A fixed clock, so latency never varies between providers or runs. */
const now = (): number => 1_000_000;

const TEXT = 'I. Grind. II. Dose.';

/**
 * The same completion, expressed the way each vendor expresses it.
 *
 * Written out per vendor rather than generated, because the differences are
 * the point: field names, nesting, and the words each uses for "stopped".
 */
const openai = createOpenAIProvider({
  credentials,
  now,
  transport: {
    create: (body) =>
      Promise.resolve(
        (body as { stream?: boolean }).stream === true
          ? framesOf([
              { choices: [{ delta: { content: 'I. Grind. ' } }] },
              { choices: [{ delta: { content: 'II. Dose.' } }] },
              {
                choices: [{ delta: {}, finish_reason: 'stop' }],
                usage: { prompt_tokens: 1000, completion_tokens: 500 },
              },
            ])
          : {
              id: 'chatcmpl-1',
              model: 'gpt-4o-2026-05-01',
              choices: [{ message: { content: TEXT }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 1000, completion_tokens: 500 },
            },
      ),
  } satisfies OpenAITransport,
});

const anthropic = createAnthropicProvider({
  credentials,
  now,
  transport: {
    create: (body) =>
      Promise.resolve(
        (body as { stream?: boolean }).stream === true
          ? framesOf([
              { type: 'message_start', message: { usage: { input_tokens: 1000 } } },
              { type: 'content_block_delta', delta: { type: 'text_delta', text: 'I. Grind. ' } },
              { type: 'content_block_delta', delta: { type: 'text_delta', text: 'II. Dose.' } },
              {
                type: 'message_delta',
                delta: { stop_reason: 'end_turn' },
                usage: { output_tokens: 500 },
              },
            ])
          : {
              id: 'msg_1',
              model: 'claude-sonnet-4-20260501',
              content: [{ type: 'text', text: TEXT }],
              stop_reason: 'end_turn',
              usage: { input_tokens: 1000, output_tokens: 500 },
            },
      ),
  } satisfies AnthropicTransport,
});

const google = createGoogleProvider({
  credentials,
  now,
  transport: {
    generate: () =>
      Promise.resolve({
        responseId: 'resp_1',
        modelVersion: 'gemini-2.5-pro-002',
        candidates: [{ content: { parts: [{ text: TEXT }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 500 },
      }),
    generateStream: () =>
      Promise.resolve(
        framesOf([
          { candidates: [{ content: { parts: [{ text: 'I. Grind. ' }] } }] },
          { candidates: [{ content: { parts: [{ text: 'II. Dose.' }] } }] },
          {
            candidates: [{ content: { parts: [] }, finishReason: 'STOP' }],
            usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 500 },
          },
        ]),
      ),
  } satisfies GoogleTransport,
});

// A canned stream awaits nothing; the async generator is the shape the
// adapters consume.
// eslint-disable-next-line @typescript-eslint/require-await
async function* framesOf<T>(list: readonly T[]): AsyncIterable<T> {
  for (const frame of list) yield frame;
}

const ADAPTERS: readonly [string, StreamingModelProvider][] = [
  ['openai', openai],
  ['anthropic', anthropic],
  ['google', google],
];

function request(over: Partial<AIRequest> = {}): AIRequest {
  return {
    taskType: 'planning.outline',
    capability: 'chat',
    model: 'a-model',
    messages: [
      { role: 'system', content: 'You write outlines.' },
      { role: 'user', content: 'Write one about espresso.' },
    ],
    params: { temperature: 0.2, maxOutputTokens: 1024 },
    timeoutMs: 30_000,
    idempotencyKey: 'wf-1:outline',
    correlationId: CORRELATION,
    tenantId: WS,
    organizationId: ORG,
    ...over,
  };
}

describe('every adapter satisfies the frozen port', () => {
  for (const [name, provider] of ADAPTERS) {
    it(`${name} declares an id, a name and capabilities`, () => {
      expect(provider.providerId).not.toBe('');
      expect(provider.displayName).not.toBe('');
      expect(provider.capabilities.length).toBeGreaterThan(0);
    });

    it(`${name} is a ModelProvider that also streams`, () => {
      const asPort: ModelProvider = provider;
      expect(typeof asPort.execute).toBe('function');
      expect(typeof asPort.health).toBe('function');
      expect(isStreamingProvider(asPort)).toBe(true);
    });
  }

  it('uses the ids the registry expects', () => {
    expect([openai.providerId, anthropic.providerId, google.providerId]).toEqual([
      OPENAI_PROVIDER_ID,
      ANTHROPIC_PROVIDER_ID,
      GOOGLE_PROVIDER_ID,
    ]);
  });
});

describe('provider discovery through the existing registry', () => {
  function composed() {
    const registry = createProviderRegistry();
    registry.register(openai);
    registry.register(anthropic);
    registry.register(google);
    registry.register(createOpenRouterProvider({ credentials, now, transport: openaiStub() }));
    registry.seal();
    return registry;
  }

  function openaiStub(): OpenAITransport {
    return { create: () => Promise.resolve({ choices: [] }) };
  }

  it('registers all four and seals', () => {
    const registry = composed();
    expect(registry.listIds()).toEqual(['openai', 'anthropic', 'google', 'openrouter']);
    expect(registry.sealed).toBe(true);
  });

  // Startup verification is the registry's, and every adapter must pass it.
  it("passes the registry's startup verification", () => {
    expect(() => composed()).not.toThrow();
  });

  it('refuses a second adapter claiming a taken id', () => {
    const registry = createProviderRegistry();
    registry.register(openai);
    expect(() => {
      registry.register(createOpenAIProvider({ credentials, now, transport: openaiStub() }));
    }).toThrow(/already registered/);
  });

  it('stays sealed after startup', () => {
    expect(() => {
      composed().register(google);
    }).toThrow(/sealed/);
  });

  it('discovers by capability without ranking anything', () => {
    const registry = composed();
    expect(registry.providersWith('chat').map((p) => p.providerId)).toEqual([
      'openai',
      'anthropic',
      'google',
      'openrouter',
    ]);
    // Anthropic offers no embeddings and does not claim to.
    expect(registry.providersWith('embedding').map((p) => p.providerId)).not.toContain('anthropic');
  });

  it('reports health for every registered provider', async () => {
    for (const provider of composed().list()) {
      expect((await provider.health()).status, provider.providerId).toBe('healthy');
    }
  });
});

describe('identical canonical behaviour across three different vendors', () => {
  async function responses(): Promise<readonly [string, AIResponse][]> {
    const out: [string, AIResponse][] = [];
    for (const [name, provider] of ADAPTERS) out.push([name, await provider.execute(request())]);
    return out;
  }

  it('every response satisfies the frozen contract', async () => {
    for (const [name, response] of await responses()) {
      expect(validateAIResponse(response), name).toEqual({ ok: true });
    }
  });

  // The headline property: differing only where they are allowed to differ.
  it('differs only in the provider and the model', async () => {
    const results = await responses();
    const normalised = results.map(([, response]) => ({
      ...response,
      providerId: '<provider>',
      model: '<model>',
      providerMetadata: '<opaque>',
    }));

    const [first] = normalised;
    for (const response of normalised) expect(response).toEqual(first);
  });

  it('returns the same text from all three', async () => {
    for (const [name, response] of await responses()) {
      expect(response.content, name).toBe(TEXT);
    }
  });

  it('reports the same token counts from three different field names', async () => {
    for (const [name, response] of await responses()) {
      expect(response.usage.tokens, name).toEqual({
        promptTokens: 1000,
        completionTokens: 500,
        totalTokens: 1500,
      });
    }
  });

  it('maps three finish-reason vocabularies onto one word', async () => {
    for (const [name, response] of await responses()) {
      expect(response.finishReason, name).toBe('stop');
    }
  });

  it("echoes the caller's idempotency key unchanged", async () => {
    for (const [name, response] of await responses()) {
      expect(response.idempotencyKey, name).toBe('wf-1:outline');
    }
  });

  // The one thing that must differ, or attribution and pricing break.
  it('names the vendor that ran it, and the model it actually used', async () => {
    const results = await responses();
    expect(results.map(([, r]) => r.providerId)).toEqual(['openai', 'anthropic', 'google']);
    expect(results.map(([, r]) => r.model)).toEqual([
      'gpt-4o-2026-05-01',
      'claude-sonnet-4-20260501',
      'gemini-2.5-pro-002',
    ]);
  });
});

describe('every adapter drives the workflow runtime unchanged', () => {
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

  const catalogue = createPromptCatalogue([TEMPLATE]);

  const DEFINITION: WorkflowDefinition = {
    id: 'article.draft',
    version: 1,
    description: 'Outline the article.',
    steps: [
      {
        id: 'outline',
        templateRef: { id: 'planning.outline' },
        capability: 'chat',
        model: 'a-model',
        timeoutMs: 30_000,
      },
    ],
  };

  const context: WorkflowExecutionContext = {
    tenant: { tenantId: WS, organizationId: ORG, source: 'event' },
    jobId: JOB,
    correlationId: CORRELATION,
    metadata: {},
  };

  const pricing = createPricingRegistry({
    version: 'table-2026-07',
    prices: [
      {
        providerId: 'openai',
        model: 'gpt-4o-2026-05-01',
        currency: 'USD',
        inputPerMillion: '2.5',
        outputPerMillion: '10',
      },
      {
        providerId: 'anthropic',
        model: 'claude-sonnet-4-20260501',
        currency: 'USD',
        inputPerMillion: '2.5',
        outputPerMillion: '10',
      },
      {
        providerId: 'google',
        model: 'gemini-2.5-pro-002',
        currency: 'USD',
        inputPerMillion: '2.5',
        outputPerMillion: '10',
      },
    ],
  });
  pricing.seal();

  async function runThrough(provider: StreamingModelProvider) {
    let execution = awaitExecution(
      buildRequest(
        preparePrompt(
          loadStep(
            startWorkflow(
              createWorkflowExecution({
                workflowId: 'wf-1',
                definition: DEFINITION,
                context,
                variables: { topic: 'espresso' },
              }),
            ),
          ),
          catalogue,
        ),
      ),
    );

    const prepared = pendingRequest(execution);
    if (prepared === null) throw new Error('expected a pending request');

    const response = await provider.execute(prepared);
    execution = recordExecution(execution, response);

    const usage = recordResponseUsage(
      response,
      {
        tenantId: WS,
        organizationId: ORG,
        correlationId: CORRELATION,
        attempt: 1,
        taskType: 'planning.outline',
        promptVersion: 'planning.outline@7',
        runId: 'wf-1',
        stepId: 'outline',
      },
      pricing,
    );

    return { execution, usage };
  }

  for (const [name, provider] of ADAPTERS) {
    it(`${name} completes a real workflow step`, async () => {
      const { execution } = await runThrough(provider);
      expect(execution.state.status).toBe('completed');
      expect(resultOf(execution).steps[0]?.content).toBe(TEXT);
    });

    it(`${name} meters to the same amount, priced the same way`, async () => {
      const { usage } = await runThrough(provider);
      // 1000 @ $2.50/M + 500 @ $10/M, identical for all three.
      expect(usage.record.cost.totalCost).toBe('0.007500');
      expect(usage.ledgerIdempotencyKey).toBe('wf-1:outline#1');
    });
  }
});

describe('every adapter streams through the S2.7 framework', () => {
  async function assembled(provider: StreamingModelProvider): Promise<AIResponse> {
    let stream: AIStream = startStream(
      openStream({
        streamId: 'st-1',
        request: request(),
        providerId: provider.providerId,
        model: 'a-model-2026',
      }),
    );
    for await (const chunk of provider.stream(request())) stream = acceptChunk(stream, chunk);
    return assembleResponse(stream);
  }

  for (const [name, provider] of ADAPTERS) {
    it(`${name} emits chunks the framework accepts, in order`, async () => {
      const response = await assembled(provider);
      expect(response.content).toBe('I. Grind. II. Dose.');
    });

    it(`${name} assembles into a valid canonical response`, async () => {
      expect(validateAIResponse(await assembled(provider)), name).toEqual({ ok: true });
    });
  }

  // Three vendors, three stream shapes, one assembled text.
  it('assembles the same text from three different stream protocols', async () => {
    const texts = [];
    for (const [, provider] of ADAPTERS) texts.push((await assembled(provider)).content);
    expect(new Set(texts).size).toBe(1);
  });

  it('reports the same usage on every final chunk', async () => {
    for (const [name, provider] of ADAPTERS) {
      const response = await assembled(provider);
      expect(response.usage.tokens, name).toEqual({
        promptTokens: 1000,
        completionTokens: 500,
        totalTokens: 1500,
      });
    }
  });
});

describe('every adapter normalizes failures into one taxonomy', () => {
  const failing = (status: number): readonly [string, ModelProvider][] => {
    const error = Object.assign(new Error('vendor said no'), { status });
    return [
      [
        'openai',
        createOpenAIProvider({
          credentials,
          now,
          transport: { create: () => Promise.reject(error) },
        }),
      ],
      [
        'anthropic',
        createAnthropicProvider({
          credentials,
          now,
          transport: { create: () => Promise.reject(error) },
        }),
      ],
      [
        'google',
        createGoogleProvider({
          credentials,
          now,
          transport: {
            generate: () => Promise.reject(error),
            generateStream: () => Promise.reject(error),
          },
        }),
      ],
    ];
  };

  it('maps one vendor status to one code, whichever vendor returned it', async () => {
    for (const [status, code] of [
      [401, 'Authentication'],
      [429, 'RateLimit'],
      [500, 'Unavailable'],
      [400, 'Validation'],
    ] as const) {
      for (const [name, provider] of failing(status)) {
        await expect(
          provider.execute(request()),
          `${name}/${String(status)}`,
        ).rejects.toMatchObject({ code });
      }
    }
  });

  it('never lets a raw SDK error escape any adapter', async () => {
    for (const [name, provider] of failing(500)) {
      await expect(provider.execute(request()), name).rejects.toBeInstanceOf(ProviderError);
    }
  });

  // The retry engine decides from the taxonomy alone — it never learns which
  // vendor produced the failure.
  it('feeds the retry engine identically from all three', async () => {
    for (const [name, provider] of failing(429)) {
      try {
        await provider.execute(request());
        expect.unreachable('must fail');
      } catch (error) {
        const state = recordFailure(beginRetryState('wf-1:outline'), error as ProviderError);
        const decision = decideRetry(state);
        expect(decision.action, name).toBe('retry');
        expect(decision.attempt, name).toBe(2);
      }
    }
  });

  it('refuses to retry an authentication failure from any of them', async () => {
    for (const [name, provider] of failing(401)) {
      try {
        await provider.execute(request());
        expect.unreachable('must fail');
      } catch (error) {
        const state = recordFailure(beginRetryState('wf-1:outline'), error as ProviderError);
        expect(decideRetry(state).action, name).toBe('fail');
      }
    }
  });
});
