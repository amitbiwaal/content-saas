/**
 * The OpenAI adapter.
 *
 * Everything here runs without a key, a network or a vendor: the mapping is
 * pure and the transport is a seam. That is deliberate — the mapping is where
 * the bugs live, and a finish reason mapped to the wrong member changes what
 * the whole platform believes happened.
 */
import { describe, expect, it } from 'vitest';

import { ProviderError, type AIRequest } from '@contentos/contracts';

import { validateAIResponse } from './validation.js';
import {
  createOpenAIProvider,
  createOpenRouterProvider,
  fromOpenAICompletion,
  OPENAI_PROVIDER_ID,
  OPENROUTER_BASE_URL,
  OPENROUTER_PROVIDER_ID,
  toFinishReason,
  toOpenAIRequest,
  toStreamChunk,
  type OpenAICompletion,
  type OpenAIStreamFrame,
  type OpenAITransport,
} from './openai.js';

const WS = '018f7a1e-0000-7000-8000-0000000000bb';
const ORG = '018f7a1e-0000-7000-8000-0000000000aa';
const CORRELATION = '018f7a1e-0000-7000-8000-0000000000dd';

function request(over: Partial<AIRequest> = {}): AIRequest {
  return {
    taskType: 'planning.outline',
    capability: 'chat',
    model: 'gpt-4o',
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

const completion = (over: Partial<OpenAICompletion> = {}): OpenAICompletion => ({
  id: 'chatcmpl-1',
  model: 'gpt-4o-2026-05-01',
  choices: [{ message: { content: 'An outline.' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 },
  ...over,
});

const credentials = { apiKey: 'test-key-not-a-real-one' }; // gitleaks:allow

/** A transport that answers with whatever it was given. No network. */
function stub(answer: unknown, capture: { body?: unknown } = {}): OpenAITransport {
  return {
    create: (body) => {
      capture.body = body;
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    },
  };
}

const CLOCK = (() => {
  let t = 1000;
  return (): number => (t += 10);
})();

describe('request mapping', () => {
  it('maps the messages one for one — the roles line up', () => {
    expect(toOpenAIRequest(request()).messages).toEqual([
      { role: 'system', content: 'You write outlines.' },
      { role: 'user', content: 'Write one about espresso.' },
    ]);
  });

  it('carries the model and the sampling parameters', () => {
    const body = toOpenAIRequest(request());
    expect(body.model).toBe('gpt-4o');
    expect(body.temperature).toBe(0.2);
  });

  // The newer models reject the deprecated `max_tokens` outright.
  it('uses max_completion_tokens, not the deprecated name', () => {
    const body = toOpenAIRequest(request());
    expect(body.max_completion_tokens).toBe(1024);
    expect(body).not.toHaveProperty('max_tokens');
  });

  it('omits optional parameters the caller did not state', () => {
    const body = toOpenAIRequest(request());
    expect(body).not.toHaveProperty('top_p');
    expect(body).not.toHaveProperty('seed');
    expect(body).not.toHaveProperty('stop');
  });

  it('carries the optional parameters when they are stated', () => {
    const body = toOpenAIRequest(
      request({
        params: {
          temperature: 0.5,
          maxOutputTokens: 100,
          topP: 0.9,
          seed: 7,
          stopSequences: ['\n\n'],
        },
      }),
    );
    expect(body).toMatchObject({ top_p: 0.9, seed: 7, stop: ['\n\n'] });
  });

  it('maps identically every time', () => {
    expect(JSON.stringify(toOpenAIRequest(request()))).toBe(
      JSON.stringify(toOpenAIRequest(request())),
    );
  });
});

describe('finish reason mapping', () => {
  const reasonFor = (raw: string): string =>
    fromOpenAICompletion(
      completion({ choices: [{ message: { content: '' }, finish_reason: raw }] }),
      { request: request(), latencyMs: 1 },
    ).finishReason;

  it('maps every reason OpenAI actually returns', () => {
    expect(reasonFor('stop')).toBe('stop');
    expect(reasonFor('length')).toBe('length');
    expect(reasonFor('content_filter')).toBe('content_filter');
    expect(reasonFor('tool_calls')).toBe('tool_call');
    expect(reasonFor('function_call')).toBe('tool_call');
  });

  // Defaulting to 'stop' would claim the model finished normally, which is
  // exactly the claim nothing downstream should have to doubt.
  it('refuses a reason it cannot express rather than guessing', () => {
    for (const raw of ['weird_new_reason', '', 'STOP']) {
      expect(() => reasonFor(raw), raw).toThrow(ProviderError);
    }
  });

  it('reports an unmappable reason as MalformedResponse', () => {
    try {
      reasonFor('weird');
      expect.unreachable('must refuse');
    } catch (error) {
      expect((error as ProviderError).code).toBe('MalformedResponse');
      expect((error as ProviderError).message).toContain('would claim the model finished normally');
    }
  });

  it('refuses a null or missing reason', () => {
    expect(() =>
      fromOpenAICompletion(
        completion({ choices: [{ message: { content: 'x' }, finish_reason: null }] }),
        { request: request(), latencyMs: 1 },
      ),
    ).toThrow(ProviderError);
  });
});

describe('response mapping', () => {
  it('produces a response the frozen contract accepts', () => {
    const response = fromOpenAICompletion(completion(), { request: request(), latencyMs: 91 });
    expect(validateAIResponse(response)).toEqual({ ok: true });
  });

  it('carries the content, the key and the provider', () => {
    const response = fromOpenAICompletion(completion(), { request: request(), latencyMs: 91 });
    expect(response).toMatchObject({
      content: 'An outline.',
      idempotencyKey: 'wf-1:outline',
      providerId: OPENAI_PROVIDER_ID,
    });
  });

  // A vendor may resolve an alias to a dated snapshot, and pricing the alias
  // would hide which one actually ran.
  it('reports the model that actually ran, not the one asked for', () => {
    const response = fromOpenAICompletion(completion(), { request: request(), latencyMs: 1 });
    expect(response.model).toBe('gpt-4o-2026-05-01');
    expect(request().model).toBe('gpt-4o');
  });

  it('falls back to the requested model when the vendor omits one', () => {
    const response = fromOpenAICompletion(completion({ model: undefined }), {
      request: request(),
      latencyMs: 1,
    });
    expect(response.model).toBe('gpt-4o');
  });

  it('maps the token counts', () => {
    const response = fromOpenAICompletion(completion(), { request: request(), latencyMs: 91 });
    expect(response.usage.tokens).toEqual({
      promptTokens: 1000,
      completionTokens: 500,
      totalTokens: 1500,
    });
    expect(response.usage.latencyMs).toBe(91);
  });

  // A vendor total that disagreed with its own parts would fail the meter's
  // consistency check, and the parts are what the price table is applied to.
  it('recomputes the total rather than trusting a vendor that disagrees', () => {
    const response = fromOpenAICompletion(
      completion({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 999 } }),
      { request: request(), latencyMs: 1 },
    );
    expect(response.usage.tokens.totalTokens).toBe(15);
  });

  it('reports zero tokens when the vendor sent none, rather than failing', () => {
    const response = fromOpenAICompletion(completion({ usage: null }), {
      request: request(),
      latencyMs: 1,
    });
    expect(response.usage.tokens.totalTokens).toBe(0);
  });

  // Adapters report usage; the meter prices it.
  it('reports an unpriced cost, which the meter replaces', () => {
    const response = fromOpenAICompletion(completion(), { request: request(), latencyMs: 1 });
    expect(response.usage.cost).toEqual({ currency: 'USD', amount: '0.000000' });
  });

  it('retains the vendor request id for diagnostics', () => {
    const response = fromOpenAICompletion(completion({ system_fingerprint: 'fp_1' }), {
      request: request(),
      latencyMs: 1,
    });
    expect(response.providerMetadata).toEqual({
      requestId: 'chatcmpl-1',
      systemFingerprint: 'fp_1',
    });
  });

  it('refuses a completion with no choices', () => {
    expect(() =>
      fromOpenAICompletion(completion({ choices: [] }), { request: request(), latencyMs: 1 }),
    ).toThrow(/no choices/);
  });

  it('treats a null content as empty rather than failing', () => {
    const response = fromOpenAICompletion(
      completion({ choices: [{ message: { content: null }, finish_reason: 'stop' }] }),
      { request: request(), latencyMs: 1 },
    );
    expect(response.content).toBe('');
  });
});

describe('the adapter', () => {
  it('declares an id, a name and its capabilities', () => {
    const provider = createOpenAIProvider({ credentials, transport: stub(completion()) });
    expect(provider.providerId).toBe('openai');
    expect(provider.displayName).toBe('OpenAI');
    expect(provider.capabilities).toContain('chat');
    expect(provider.capabilities).toContain('embedding');
  });

  it('executes through the mapping', async () => {
    const capture: { body?: unknown } = {};
    const provider = createOpenAIProvider({
      credentials,
      now: CLOCK,
      transport: stub(completion(), capture),
    });
    const response = await provider.execute(request());

    expect(response.content).toBe('An outline.');
    expect(capture.body).toMatchObject({ model: 'gpt-4o', max_completion_tokens: 1024 });
  });

  it('reports health without contacting the vendor', async () => {
    let calls = 0;
    const provider = createOpenAIProvider({
      credentials,
      now: CLOCK,
      transport: {
        create: () => {
          calls += 1;
          return Promise.resolve(completion());
        },
      },
    });
    expect((await provider.health()).status).toBe('healthy');
    expect(calls).toBe(0);
  });

  it('offers streaming as well as execution', () => {
    const provider = createOpenAIProvider({ credentials, transport: stub(completion()) });
    expect(typeof provider.stream).toBe('function');
  });
});

describe('error translation', () => {
  const failing = (error: unknown) =>
    createOpenAIProvider({ credentials, now: CLOCK, transport: stub(error as Error) });

  it('never lets a raw SDK error escape', async () => {
    const raw = Object.assign(new Error('Rate limit reached'), { status: 429 });
    await expect(failing(raw).execute(request())).rejects.toBeInstanceOf(ProviderError);
  });

  it('maps the failures a vendor actually returns', async () => {
    const cases: [number, string][] = [
      [401, 'Authentication'],
      [429, 'RateLimit'],
      [500, 'Unavailable'],
      [400, 'Validation'],
      [404, 'ModelUnavailable'],
      [413, 'ContextTooLarge'],
      [408, 'Timeout'],
    ];
    for (const [status, code] of cases) {
      const raw = Object.assign(new Error('vendor said no'), { status });
      await expect(failing(raw).execute(request()), String(status)).rejects.toMatchObject({ code });
    }
  });

  it('classifies a network failure with no status', async () => {
    await expect(failing(new Error('ECONNREFUSED')).execute(request())).rejects.toMatchObject({
      code: 'Unavailable',
    });
  });

  it('names the provider on every error', async () => {
    await expect(failing(new Error('boom')).execute(request())).rejects.toMatchObject({
      providerId: 'openai',
    });
  });

  // A refusal the vendor reported as a finish reason still reaches the caller
  // as a canonical one, not as an exception.
  it('reports a content filter as a finish reason, not an error', async () => {
    const filtered = completion({
      choices: [{ message: { content: '' }, finish_reason: 'content_filter' }],
    });
    const provider = createOpenAIProvider({ credentials, now: CLOCK, transport: stub(filtered) });
    expect((await provider.execute(request())).finishReason).toBe('content_filter');
  });
});

describe('streaming', () => {
  // A canned stream awaits nothing; the async generator is the shape the
  // adapter consumes.
  // eslint-disable-next-line @typescript-eslint/require-await
  async function* frames(list: readonly OpenAIStreamFrame[]): AsyncIterable<OpenAIStreamFrame> {
    for (const frame of list) yield frame;
  }

  const streamingProvider = (list: readonly OpenAIStreamFrame[]) =>
    createOpenAIProvider({
      credentials,
      now: CLOCK,
      transport: { create: () => Promise.resolve(frames(list)) },
    });

  const FRAMES: OpenAIStreamFrame[] = [
    { choices: [{ delta: { content: 'I. ' } }] },
    { choices: [{ delta: { content: 'Grind.' } }] },
    {
      choices: [{ delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 4 },
    },
  ];

  it('emits canonical chunks, numbered from zero', async () => {
    const chunks = [];
    for await (const chunk of streamingProvider(FRAMES).stream(request())) chunks.push(chunk);

    expect(chunks.map((c) => c.sequence)).toEqual([0, 1, 2]);
    expect(chunks.map((c) => c.content)).toEqual(['I. ', 'Grind.', '']);
  });

  // No SDK stream object escapes: what comes out is the platform's shape.
  it('ends with a final chunk carrying the finish reason and usage', async () => {
    const chunks = [];
    for await (const chunk of streamingProvider(FRAMES).stream(request())) chunks.push(chunk);

    const last = chunks[chunks.length - 1];
    expect(last?.finishReason).toBe('stop');
    expect(last?.usage?.tokens).toEqual({
      promptTokens: 10,
      completionTokens: 4,
      totalTokens: 14,
    });
  });

  it('marks intermediate chunks as non-final', async () => {
    const chunks = [];
    for await (const chunk of streamingProvider(FRAMES).stream(request())) chunks.push(chunk);
    expect(chunks[0]?.finishReason).toBeNull();
    expect(chunks[0]?.usage).toBeNull();
  });

  it('translates a mid-stream failure into a typed error', async () => {
    // See above: canned, so nothing to await.
    // eslint-disable-next-line @typescript-eslint/require-await
    async function* broken(): AsyncIterable<OpenAIStreamFrame> {
      yield { choices: [{ delta: { content: 'I. ' } }] };
      throw new Error('connection reset');
    }
    const provider = createOpenAIProvider({
      credentials,
      now: CLOCK,
      transport: { create: () => Promise.resolve(broken()) },
    });

    const iterate = async (): Promise<void> => {
      for await (const _chunk of provider.stream(request())) {
        // drain
      }
    };
    await expect(iterate()).rejects.toBeInstanceOf(ProviderError);
  });

  it('asks the vendor to stream', async () => {
    const capture: { body?: unknown } = {};
    const provider = createOpenAIProvider({
      credentials,
      now: CLOCK,
      transport: {
        create: (body) => {
          capture.body = body;
          return Promise.resolve(frames(FRAMES));
        },
      },
    });
    for await (const _chunk of provider.stream(request())) break;
    expect(capture.body).toMatchObject({ stream: true });
  });
});

describe('OpenRouter speaks the same protocol', () => {
  // A base URL and an id, not a fourth adapter: a second copy of the mapping
  // would be a second place for a finish-reason bug to live.
  it('is the OpenAI adapter under another id', () => {
    const provider = createOpenRouterProvider({ credentials, transport: stub(completion()) });
    expect(provider.providerId).toBe(OPENROUTER_PROVIDER_ID);
    expect(provider.displayName).toBe('OpenRouter');
  });

  it('stamps its own id on the response', async () => {
    const provider = createOpenRouterProvider({
      credentials,
      now: CLOCK,
      transport: stub(completion()),
    });
    expect((await provider.execute(request())).providerId).toBe('openrouter');
  });

  it('defaults to the OpenRouter endpoint and honours an override', () => {
    expect(OPENROUTER_BASE_URL).toContain('openrouter.ai');
    expect(() =>
      createOpenRouterProvider({
        credentials: { ...credentials, baseUrl: 'https://proxy.internal/v1' },
        transport: stub(completion()),
      }),
    ).not.toThrow();
  });
});

describe('the mapping functions on their own', () => {
  it('maps each vendor finish reason directly', () => {
    expect(toFinishReason('stop')).toBe('stop');
    expect(toFinishReason('length')).toBe('length');
    expect(toFinishReason('content_filter')).toBe('content_filter');
    expect(toFinishReason('tool_calls')).toBe('tool_call');
    expect(() => toFinishReason(undefined)).toThrow(ProviderError);
  });

  it('maps an intermediate frame to a non-final chunk', () => {
    const chunk = toStreamChunk({ choices: [{ delta: { content: 'I. ' } }] }, 3, 40);
    expect(chunk).toMatchObject({ sequence: 3, content: 'I. ', finishReason: null, usage: null });
  });

  it('maps a final frame to a chunk carrying the reason and the usage', () => {
    const chunk = toStreamChunk(
      {
        choices: [{ delta: {}, finish_reason: 'length' }],
        usage: { prompt_tokens: 7, completion_tokens: 3 },
      },
      9,
      120,
    );
    expect(chunk.finishReason).toBe('length');
    expect(chunk.usage?.tokens).toEqual({
      promptTokens: 7,
      completionTokens: 3,
      totalTokens: 10,
    });
    expect(chunk.usage?.latencyMs).toBe(120);
  });

  // A final frame with no usage is still final; the counts are marked
  // estimated rather than the stream being rejected.
  it('marks a final frame with no usage as estimated', () => {
    const chunk = toStreamChunk({ choices: [{ delta: {}, finish_reason: 'stop' }] }, 1, 10);
    expect(chunk.usage?.tokensEstimated).toBe(true);
  });

  // The frame does not number itself; a position derived from arrival would
  // make the assembled text depend on the network.
  it('takes the sequence from the caller, not the frame', () => {
    expect(toStreamChunk({ choices: [{ delta: { content: 'x' } }] }, 42, 1).sequence).toBe(42);
  });
});
