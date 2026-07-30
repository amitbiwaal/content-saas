/**
 * The Google Gemini adapter.
 *
 * Gemini differs from the other two in more places than either: `contents`
 * instead of `messages`, `model` instead of `assistant`, a separate system
 * instruction, differently-named generation parameters, and the widest set of
 * finish reasons — six distinct ways of saying "blocked".
 *
 * Absorbing all of that is the point of the port.
 */
import { describe, expect, it } from 'vitest';

import { ProviderError, type AIRequest } from '@contentos/contracts';

import {
  createGoogleProvider,
  fromGoogleResponse,
  GOOGLE_PROVIDER_ID,
  toFinishReason,
  toGoogleRequest,
  toStreamChunk,
  type GoogleResponse,
  type GoogleTransport,
} from './google.js';
import { validateAIResponse } from './validation.js';

const WS = '018f7a1e-0000-7000-8000-0000000000bb';
const ORG = '018f7a1e-0000-7000-8000-0000000000aa';
const CORRELATION = '018f7a1e-0000-7000-8000-0000000000dd';

function request(over: Partial<AIRequest> = {}): AIRequest {
  return {
    taskType: 'planning.outline',
    capability: 'chat',
    model: 'gemini-2.5-pro',
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

const response = (over: Partial<GoogleResponse> = {}): GoogleResponse => ({
  responseId: 'resp_1',
  modelVersion: 'gemini-2.5-pro-002',
  candidates: [{ content: { parts: [{ text: 'An outline.' }] }, finishReason: 'STOP' }],
  usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 500, totalTokenCount: 1500 },
  ...over,
});

const credentials = { apiKey: 'test-key-not-a-real-one' }; // gitleaks:allow

function stub(answer: unknown, capture: { body?: unknown } = {}): GoogleTransport {
  const settle = (): Promise<never> =>
    answer instanceof Error ? Promise.reject(answer) : (Promise.resolve(answer) as Promise<never>);
  return {
    generate: (body) => {
      capture.body = body;
      return settle();
    },
    generateStream: (body) => {
      capture.body = body;
      return settle();
    },
  };
}

const CLOCK = (() => {
  let t = 1000;
  return (): number => (t += 10);
})();

describe('request mapping', () => {
  it('calls the message list contents, as Gemini does', () => {
    const body = toGoogleRequest(request());
    expect(body.contents).toEqual([
      { role: 'user', parts: [{ text: 'Write one about espresso.' }] },
    ]);
  });

  // Gemini's word for the assistant is 'model'.
  it('renames the assistant role to model', () => {
    const body = toGoogleRequest(
      request({
        messages: [
          { role: 'user', content: 'A' },
          { role: 'assistant', content: 'B' },
        ],
      }),
    );
    expect(body.contents.map((c) => c.role)).toEqual(['user', 'model']);
  });

  it('lifts the system message into a system instruction', () => {
    expect(toGoogleRequest(request()).systemInstruction).toBe('You write outlines.');
  });

  it('omits the instruction when there is no system message', () => {
    const body = toGoogleRequest(request({ messages: [{ role: 'user', content: 'Go.' }] }));
    expect(body).not.toHaveProperty('systemInstruction');
  });

  it('uses the vendor names for the generation parameters', () => {
    const body = toGoogleRequest(
      request({
        params: { temperature: 0.5, maxOutputTokens: 10, topP: 0.9, stopSequences: ['END'] },
      }),
    );
    expect(body.generationConfig).toEqual({
      temperature: 0.5,
      maxOutputTokens: 10,
      topP: 0.9,
      stopSequences: ['END'],
    });
  });

  it('refuses a request with no content turn', () => {
    expect(() =>
      toGoogleRequest(request({ messages: [{ role: 'system', content: 'S' }] })),
    ).toThrow(ProviderError);
  });

  it('maps identically every time', () => {
    expect(JSON.stringify(toGoogleRequest(request()))).toBe(
      JSON.stringify(toGoogleRequest(request())),
    );
  });
});

describe('finish reason mapping', () => {
  const reasonFor = (raw: string): string =>
    fromGoogleResponse(
      response({ candidates: [{ content: { parts: [{ text: '' }] }, finishReason: raw }] }),
      { request: request(), latencyMs: 1 },
    ).finishReason;

  it('maps the ordinary endings', () => {
    expect(reasonFor('STOP')).toBe('stop');
    expect(reasonFor('MAX_TOKENS')).toBe('length');
  });

  // Six words for one thing. All six must land on content_filter, or Rule 2 of
  // retry-strategy.md would stop applying to whichever one slipped through.
  it('maps every way Gemini says blocked to content_filter', () => {
    for (const raw of [
      'SAFETY',
      'RECITATION',
      'BLOCKLIST',
      'PROHIBITED_CONTENT',
      'SPII',
      'LANGUAGE',
    ]) {
      expect(reasonFor(raw), raw).toBe('content_filter');
    }
  });

  it('maps a malformed function call to tool_call', () => {
    expect(reasonFor('MALFORMED_FUNCTION_CALL')).toBe('tool_call');
  });

  // OTHER and UNSPECIFIED say only that the model stopped for a reason the
  // vendor did not name — which is not the same as finishing.
  it('refuses the reasons that name nothing', () => {
    for (const raw of ['OTHER', 'FINISH_REASON_UNSPECIFIED', 'stop']) {
      expect(() => reasonFor(raw), raw).toThrow(ProviderError);
    }
  });
});

describe('response mapping', () => {
  it('produces a response the frozen contract accepts', () => {
    expect(
      validateAIResponse(fromGoogleResponse(response(), { request: request(), latencyMs: 9 })),
    ).toEqual({
      ok: true,
    });
  });

  it('concatenates the parts of the first candidate', () => {
    const mapped = fromGoogleResponse(
      response({
        candidates: [
          { content: { parts: [{ text: 'I. ' }, { text: 'Grind.' }] }, finishReason: 'STOP' },
        ],
      }),
      { request: request(), latencyMs: 1 },
    );
    expect(mapped.content).toBe('I. Grind.');
  });

  it('maps the vendor token field names', () => {
    const mapped = fromGoogleResponse(response(), { request: request(), latencyMs: 1 });
    expect(mapped.usage.tokens).toEqual({
      promptTokens: 1000,
      completionTokens: 500,
      totalTokens: 1500,
    });
  });

  it('reports the model version that actually ran', () => {
    expect(fromGoogleResponse(response(), { request: request(), latencyMs: 1 }).model).toBe(
      'gemini-2.5-pro-002',
    );
  });

  // Gemini returns no candidate when the PROMPT itself was blocked, which is a
  // refusal rather than an empty answer — and must never be retried.
  it('treats a candidate-less response as a refusal, not an empty answer', () => {
    try {
      fromGoogleResponse(response({ candidates: [] }), { request: request(), latencyMs: 1 });
      expect.unreachable('must refuse');
    } catch (error) {
      expect((error as ProviderError).code).toBe('ContentFiltered');
      expect((error as ProviderError).retryable).toBe(false);
    }
  });

  it('stamps the provider id and keeps the request id', () => {
    const mapped = fromGoogleResponse(response(), { request: request(), latencyMs: 1 });
    expect(mapped.providerId).toBe(GOOGLE_PROVIDER_ID);
    expect(mapped.providerMetadata).toMatchObject({ requestId: 'resp_1' });
  });

  it('retains a cached content count where the vendor reported one', () => {
    const mapped = fromGoogleResponse(
      response({
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 5,
          cachedContentTokenCount: 4,
        },
      }),
      { request: request(), latencyMs: 1 },
    );
    expect(mapped.providerMetadata).toMatchObject({ cachedContentTokenCount: 4 });
  });
});

describe('the adapter', () => {
  it('executes through the mapping', async () => {
    const capture: { body?: unknown } = {};
    const provider = createGoogleProvider({
      credentials,
      now: CLOCK,
      transport: stub(response(), capture),
    });
    const mapped = await provider.execute(request());

    expect(mapped.content).toBe('An outline.');
    expect(capture.body).toMatchObject({ systemInstruction: 'You write outlines.' });
  });

  it('never lets a raw SDK error escape', async () => {
    const raw = Object.assign(new Error('quota exceeded'), { status: 429 });
    const provider = createGoogleProvider({ credentials, now: CLOCK, transport: stub(raw) });
    await expect(provider.execute(request())).rejects.toMatchObject({
      code: 'RateLimit',
      providerId: 'google',
    });
  });

  it('reports health without contacting the vendor', async () => {
    let calls = 0;
    const provider = createGoogleProvider({
      credentials,
      now: CLOCK,
      transport: {
        generate: () => {
          calls += 1;
          return Promise.resolve(response());
        },
        generateStream: () => Promise.reject(new Error('unused')),
      },
    });
    expect((await provider.health()).status).toBe('healthy');
    expect(calls).toBe(0);
  });
});

describe('streaming', () => {
  const FRAMES: GoogleResponse[] = [
    { candidates: [{ content: { parts: [{ text: 'I. ' }] } }] },
    { candidates: [{ content: { parts: [{ text: 'Grind.' }] } }] },
    {
      candidates: [{ content: { parts: [] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4 },
    },
  ];

  // A canned stream awaits nothing; the async generator is the shape the
  // adapter consumes.
  // eslint-disable-next-line @typescript-eslint/require-await
  async function* frames(list: readonly GoogleResponse[]): AsyncIterable<GoogleResponse> {
    for (const frame of list) yield frame;
  }

  const provider = (list: readonly GoogleResponse[]) =>
    createGoogleProvider({
      credentials,
      now: CLOCK,
      transport: {
        generate: () => Promise.reject(new Error('unused')),
        generateStream: () => Promise.resolve(frames(list)),
      },
    });

  it('emits canonical chunks numbered from zero', async () => {
    const chunks = [];
    for await (const chunk of provider(FRAMES).stream(request())) chunks.push(chunk);
    expect(chunks.map((c) => c.sequence)).toEqual([0, 1, 2]);
    expect(chunks.map((c) => c.content)).toEqual(['I. ', 'Grind.', '']);
  });

  // Gemini repeats running totals on every frame; the ones that count are the
  // ones on the frame that also carries the finish reason.
  it('takes the usage from the final frame', async () => {
    const chunks = [];
    for await (const chunk of provider(FRAMES).stream(request())) chunks.push(chunk);
    const last = chunks[chunks.length - 1];
    expect(last?.finishReason).toBe('stop');
    expect(last?.usage?.tokens).toEqual({
      promptTokens: 10,
      completionTokens: 4,
      totalTokens: 14,
    });
  });

  it('translates a mid-stream failure into a typed error', async () => {
    // See above: canned, so nothing to await.
    // eslint-disable-next-line @typescript-eslint/require-await
    async function* broken(): AsyncIterable<GoogleResponse> {
      yield { candidates: [{ content: { parts: [{ text: 'I. ' }] } }] };
      throw new Error('connection reset');
    }
    const failing = createGoogleProvider({
      credentials,
      now: CLOCK,
      transport: {
        generate: () => Promise.reject(new Error('unused')),
        generateStream: () => Promise.resolve(broken()),
      },
    });
    const iterate = async (): Promise<void> => {
      for await (const _chunk of failing.stream(request())) {
        // drain
      }
    };
    await expect(iterate()).rejects.toBeInstanceOf(ProviderError);
  });
});

describe('the mapping functions on their own', () => {
  it('maps each vendor finish reason directly', () => {
    expect(toFinishReason('STOP')).toBe('stop');
    expect(toFinishReason('SAFETY')).toBe('content_filter');
    expect(() => toFinishReason('OTHER')).toThrow(ProviderError);
  });

  it('maps an intermediate frame to a non-final chunk', () => {
    const chunk = toStreamChunk({ candidates: [{ content: { parts: [{ text: 'I. ' }] } }] }, 3, 40);
    expect(chunk).toMatchObject({ sequence: 3, content: 'I. ', finishReason: null, usage: null });
  });

  it('maps a final frame to a chunk carrying the reason and the usage', () => {
    const chunk = toStreamChunk(
      {
        candidates: [{ content: { parts: [] }, finishReason: 'MAX_TOKENS' }],
        usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3 },
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
  });

  it('concatenates several parts within one frame', () => {
    const chunk = toStreamChunk(
      { candidates: [{ content: { parts: [{ text: 'a' }, { text: 'b' }] } }] },
      0,
      1,
    );
    expect(chunk.content).toBe('ab');
  });
});
