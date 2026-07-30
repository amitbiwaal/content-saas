/**
 * The Anthropic adapter.
 *
 * The mapping that matters here is the one that genuinely differs from
 * OpenAI's: Anthropic takes the system prompt as a top-level parameter, not as
 * a message. A caller never learns that.
 */
import { describe, expect, it } from 'vitest';

import { ProviderError, type AIRequest } from '@contentos/contracts';

import {
  ANTHROPIC_PROVIDER_ID,
  createAnthropicProvider,
  fromAnthropicMessage,
  toAnthropicRequest,
  toFinishReason,
  toStreamChunk,
  type AnthropicMessage,
  type AnthropicStreamEvent,
  type AnthropicTransport,
} from './anthropic.js';
import { validateAIResponse } from './validation.js';

const WS = '018f7a1e-0000-7000-8000-0000000000bb';
const ORG = '018f7a1e-0000-7000-8000-0000000000aa';
const CORRELATION = '018f7a1e-0000-7000-8000-0000000000dd';

function request(over: Partial<AIRequest> = {}): AIRequest {
  return {
    taskType: 'planning.outline',
    capability: 'chat',
    model: 'claude-sonnet-4',
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

const message = (over: Partial<AnthropicMessage> = {}): AnthropicMessage => ({
  id: 'msg_1',
  model: 'claude-sonnet-4-20260501',
  content: [{ type: 'text', text: 'An outline.' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 1000, output_tokens: 500 },
  ...over,
});

const credentials = { apiKey: 'test-key-not-a-real-one' }; // gitleaks:allow

function stub(answer: unknown, capture: { body?: unknown } = {}): AnthropicTransport {
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

describe('the system prompt is lifted out of the message list', () => {
  // Anthropic takes it as a top-level parameter and the message list may
  // contain only user and assistant turns.
  it('moves the system message to its own field', () => {
    const body = toAnthropicRequest(request());
    expect(body.system).toBe('You write outlines.');
    expect(body.messages).toEqual([{ role: 'user', content: 'Write one about espresso.' }]);
  });

  it('joins several system messages in order', () => {
    const body = toAnthropicRequest(
      request({
        messages: [
          { role: 'system', content: 'One.' },
          { role: 'system', content: 'Two.' },
          { role: 'user', content: 'Go.' },
        ],
      }),
    );
    expect(body.system).toBe('One.\n\nTwo.');
  });

  it('omits the field entirely when there is no system message', () => {
    const body = toAnthropicRequest(request({ messages: [{ role: 'user', content: 'Go.' }] }));
    expect(body).not.toHaveProperty('system');
  });

  it('keeps assistant turns in the list', () => {
    const body = toAnthropicRequest(
      request({
        messages: [
          { role: 'system', content: 'S' },
          { role: 'user', content: 'A' },
          { role: 'assistant', content: 'B' },
          { role: 'user', content: 'C' },
        ],
      }),
    );
    expect(body.messages).toEqual([
      { role: 'user', content: 'A' },
      { role: 'assistant', content: 'B' },
      { role: 'user', content: 'C' },
    ]);
  });

  // Sending none would fail at the vendor with an error naming fields this
  // platform does not have.
  it('refuses a request with no turn but the system message', () => {
    expect(() =>
      toAnthropicRequest(request({ messages: [{ role: 'system', content: 'S' }] })),
    ).toThrow(ProviderError);
  });

  it('reports that as a Validation failure — our defect, not theirs', () => {
    try {
      toAnthropicRequest(request({ messages: [{ role: 'system', content: 'S' }] }));
      expect.unreachable('must refuse');
    } catch (error) {
      expect((error as ProviderError).code).toBe('Validation');
      expect((error as ProviderError).retryable).toBe(false);
    }
  });
});

describe('request mapping', () => {
  // Required by Anthropic, unlike OpenAI where it is optional.
  it('always sends max_tokens', () => {
    expect(toAnthropicRequest(request()).max_tokens).toBe(1024);
  });

  it('carries the model and temperature', () => {
    const body = toAnthropicRequest(request());
    expect(body.model).toBe('claude-sonnet-4');
    expect(body.temperature).toBe(0.2);
  });

  it("uses the vendor's own names for the optional parameters", () => {
    const body = toAnthropicRequest(
      request({
        params: { temperature: 0.5, maxOutputTokens: 10, topP: 0.9, stopSequences: ['END'] },
      }),
    );
    expect(body).toMatchObject({ top_p: 0.9, stop_sequences: ['END'] });
  });

  it('maps identically every time', () => {
    expect(JSON.stringify(toAnthropicRequest(request()))).toBe(
      JSON.stringify(toAnthropicRequest(request())),
    );
  });
});

describe('finish reason mapping', () => {
  const reasonFor = (raw: string): string =>
    fromAnthropicMessage(message({ stop_reason: raw }), { request: request(), latencyMs: 1 })
      .finishReason;

  it('maps every reason Anthropic actually returns', () => {
    expect(reasonFor('end_turn')).toBe('stop');
    expect(reasonFor('stop_sequence')).toBe('stop');
    expect(reasonFor('max_tokens')).toBe('length');
    expect(reasonFor('tool_use')).toBe('tool_call');
  });

  // Rule 2 of retry-strategy.md forbids retrying a safety refusal
  // automatically. Mapping it anywhere but content_filter would let it be
  // retried.
  it('maps a refusal to content_filter, so it can never be auto-retried', () => {
    expect(reasonFor('refusal')).toBe('content_filter');
  });

  it('refuses a reason it cannot express', () => {
    for (const raw of ['end', 'STOP', 'unknown_reason']) {
      expect(() => reasonFor(raw), raw).toThrow(ProviderError);
    }
  });
});

describe('response mapping', () => {
  it('produces a response the frozen contract accepts', () => {
    const response = fromAnthropicMessage(message(), { request: request(), latencyMs: 91 });
    expect(validateAIResponse(response)).toEqual({ ok: true });
  });

  it('concatenates the text blocks in order', () => {
    const response = fromAnthropicMessage(
      message({
        content: [
          { type: 'text', text: 'I. ' },
          { type: 'text', text: 'Grind.' },
        ],
      }),
      { request: request(), latencyMs: 1 },
    );
    expect(response.content).toBe('I. Grind.');
  });

  // A tool-use block carries no prose, and stringifying it would put JSON into
  // an article.
  it('ignores blocks that are not text', () => {
    const response = fromAnthropicMessage(
      message({
        content: [
          { type: 'text', text: 'Prose. ' },
          { type: 'tool_use' },
          { type: 'text', text: 'More.' },
        ],
      }),
      { request: request(), latencyMs: 1 },
    );
    expect(response.content).toBe('Prose. More.');
  });

  it("maps the vendor's own token field names", () => {
    const response = fromAnthropicMessage(message(), { request: request(), latencyMs: 1 });
    expect(response.usage.tokens).toEqual({
      promptTokens: 1000,
      completionTokens: 500,
      totalTokens: 1500,
    });
  });

  it('reports the model that actually ran', () => {
    const response = fromAnthropicMessage(message(), { request: request(), latencyMs: 1 });
    expect(response.model).toBe('claude-sonnet-4-20260501');
  });

  it('retains the request id and any cache read for diagnostics', () => {
    const response = fromAnthropicMessage(
      message({ usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 400 } }),
      { request: request(), latencyMs: 1 },
    );
    expect(response.providerMetadata).toEqual({
      requestId: 'msg_1',
      cacheReadInputTokens: 400,
    });
  });

  it('stamps the provider id', () => {
    expect(fromAnthropicMessage(message(), { request: request(), latencyMs: 1 }).providerId).toBe(
      ANTHROPIC_PROVIDER_ID,
    );
  });

  it('handles a message with no content blocks', () => {
    const response = fromAnthropicMessage(message({ content: [] }), {
      request: request(),
      latencyMs: 1,
    });
    expect(response.content).toBe('');
  });
});

describe('the adapter', () => {
  it('declares no embedding capability, because Anthropic offers none', () => {
    const provider = createAnthropicProvider({ credentials, transport: stub(message()) });
    expect(provider.capabilities).not.toContain('embedding');
    expect(provider.capabilities).toContain('chat');
  });

  it('executes through the mapping', async () => {
    const capture: { body?: unknown } = {};
    const provider = createAnthropicProvider({
      credentials,
      now: CLOCK,
      transport: stub(message(), capture),
    });
    const response = await provider.execute(request());

    expect(response.content).toBe('An outline.');
    expect(capture.body).toMatchObject({ system: 'You write outlines.', max_tokens: 1024 });
  });

  it('never lets a raw SDK error escape', async () => {
    const raw = Object.assign(new Error('overloaded'), { status: 529 });
    const provider = createAnthropicProvider({
      credentials,
      now: CLOCK,
      transport: stub(raw),
    });
    await expect(provider.execute(request())).rejects.toBeInstanceOf(ProviderError);
  });

  it('maps an authentication failure', async () => {
    const raw = Object.assign(new Error('invalid x-api-key'), { status: 401 });
    const provider = createAnthropicProvider({ credentials, now: CLOCK, transport: stub(raw) });
    await expect(provider.execute(request())).rejects.toMatchObject({
      code: 'Authentication',
      providerId: 'anthropic',
    });
  });
});

describe('streaming', () => {
  // Anthropic's stream is a sequence of typed EVENTS, not deltas of one shape.
  const EVENTS: AnthropicStreamEvent[] = [
    { type: 'message_start', message: { usage: { input_tokens: 10 } } },
    { type: 'content_block_start' },
    { type: 'content_block_delta', delta: { type: 'text_delta', text: 'I. ' } },
    { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Grind.' } },
    { type: 'content_block_stop' },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } },
    { type: 'message_stop' },
  ];

  // A canned stream awaits nothing; the async generator is the shape the
  // adapter consumes.
  // eslint-disable-next-line @typescript-eslint/require-await
  async function* events(
    list: readonly AnthropicStreamEvent[],
  ): AsyncIterable<AnthropicStreamEvent> {
    for (const event of list) yield event;
  }

  const provider = (list: readonly AnthropicStreamEvent[]) =>
    createAnthropicProvider({
      credentials,
      now: CLOCK,
      transport: { create: () => Promise.resolve(events(list)) },
    });

  // A structural event that produced an empty chunk would take a sequence
  // number and make the numbering depend on vendor framing.
  it('emits a chunk only for events that carry something', async () => {
    const chunks = [];
    for await (const chunk of provider(EVENTS).stream(request())) chunks.push(chunk);

    expect(chunks.map((c) => c.sequence)).toEqual([0, 1, 2]);
    expect(chunks.map((c) => c.content)).toEqual(['I. ', 'Grind.', '']);
  });

  // The prompt count arrives on `message_start`, long before the final event.
  it('carries the prompt tokens from the start event into the final chunk', async () => {
    const chunks = [];
    for await (const chunk of provider(EVENTS).stream(request())) chunks.push(chunk);

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
    async function* broken(): AsyncIterable<AnthropicStreamEvent> {
      yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'I. ' } };
      throw new Error('connection reset');
    }
    const failing = createAnthropicProvider({
      credentials,
      now: CLOCK,
      transport: { create: () => Promise.resolve(broken()) },
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
  it('maps each vendor stop reason directly', () => {
    expect(toFinishReason('end_turn')).toBe('stop');
    expect(toFinishReason('refusal')).toBe('content_filter');
    expect(() => toFinishReason(null)).toThrow(ProviderError);
  });

  // A structural event that produced an empty chunk would take a sequence
  // number and make the numbering depend on vendor framing.
  it('produces no chunk for a structural event', () => {
    for (const type of ['message_start', 'content_block_start', 'content_block_stop', 'ping']) {
      expect(toStreamChunk({ type }, 0, 1, 0), type).toBeNull();
    }
  });

  it('produces a text chunk for a content delta', () => {
    const chunk = toStreamChunk(
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'I. ' } },
      2,
      30,
      10,
    );
    expect(chunk).toMatchObject({ sequence: 2, content: 'I. ', finishReason: null });
  });

  it('produces the final chunk from the message delta, carrying both counts', () => {
    const chunk = toStreamChunk(
      { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 5 } },
      4,
      80,
      11,
    );
    expect(chunk?.finishReason).toBe('length');
    expect(chunk?.usage?.tokens).toEqual({
      promptTokens: 11,
      completionTokens: 5,
      totalTokens: 16,
    });
  });
});
