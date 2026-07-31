import {
  createProviderRegistry,
  eventsOf,
  openStream,
  startStream,
  acceptChunk,
  type AdmissionResult,
  type AIStream,
  type ModelProvider,
  type StreamChunk,
  type StreamEvent,
  type StreamingModelProvider,
} from '@contentos/ai';
import { isProviderError, type AIRequest, type AIResponse, type Usage } from '@contentos/contracts';
import { describe, expect, it } from 'vitest';

import { createProviderDispatcher } from './dispatch.js';

const USAGE: Usage = {
  tokens: { input: 10, output: 20, cachedInput: 0, total: 30, tokenizer: 'cl100k_base' },
  tokensEstimated: false,
  cost: { currency: 'USD', amount: '0.000300' },
  latencyMs: 120,
};

const REQUEST: AIRequest = {
  taskType: 'planning.outline',
  capability: 'chat',
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'outline this' }],
  params: { temperature: 0.2, maxOutputTokens: 900 },
  timeoutMs: 30_000,
  idempotencyKey: 'idem-1',
  correlationId: 'corr-1',
  tenantId: '22222222-2222-4222-8222-222222222222',
  organizationId: '11111111-1111-4111-8111-111111111111',
};

const ADMITTED: AdmissionResult = {
  context: {
    tenant: {
      tenantId: REQUEST.tenantId,
      organizationId: REQUEST.organizationId,
      source: 'request',
    },
    organizationId: REQUEST.organizationId,
    workspaceId: REQUEST.tenantId,
    actorId: 'user-1',
    correlationId: 'corr-1',
    idempotencyKey: 'idem-1',
  },
  request: REQUEST,
  promptVersion: 'planning.outline@7',
  providerId: 'openai',
  capability: 'chat',
  workflowId: 'idem-1',
};

const chunk = (sequence: number, content: string, final = false): StreamChunk => ({
  sequence,
  content,
  finishReason: final ? 'stop' : null,
  usage: final ? USAGE : null,
  metadata: {},
});

const RESPONSE: AIResponse = {
  idempotencyKey: 'idem-1',
  providerId: 'openai',
  model: 'gpt-4o',
  content: 'an outline',
  finishReason: 'stop',
  usage: USAGE,
  providerMetadata: {},
};

function buffered(overrides: Partial<ModelProvider> = {}): ModelProvider {
  return {
    providerId: 'openai',
    displayName: 'OpenAI',
    capabilities: ['chat'],
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

function streaming(chunks: readonly StreamChunk[]): StreamingModelProvider {
  return {
    ...buffered(),
    // eslint-disable-next-line @typescript-eslint/require-await
    async *stream(): AsyncIterable<StreamChunk> {
      for (const item of chunks) yield item;
    },
  };
}

function registryOf(provider: ModelProvider): ReturnType<typeof createProviderRegistry> {
  const registry = createProviderRegistry();
  registry.register(provider);
  registry.seal();
  return registry;
}

const collect = async (events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> => {
  const seen: StreamEvent[] = [];
  for await (const event of events) seen.push(event);
  return seen;
};

describe('dispatching a buffered execution', () => {
  it('calls the provider admission named, with the request admission built', async () => {
    let received: AIRequest | null = null;
    const dispatcher = createProviderDispatcher({
      providers: registryOf(
        buffered({
          execute: (request: AIRequest) => {
            received = request;
            return Promise.resolve(RESPONSE);
          },
        }),
      ),
    });

    await expect(dispatcher.execute(ADMITTED)).resolves.toEqual(RESPONSE);
    expect(received).toBe(REQUEST);
  });

  it('lets a provider failure propagate rather than translating it here', async () => {
    // The controller owns the HTTP mapping; a dispatcher that caught this would
    // have to invent a response, and would be making a policy decision.
    const dispatcher = createProviderDispatcher({
      providers: registryOf(
        buffered({
          execute: () => Promise.reject(new Error('boom')),
        }),
      ),
    });
    await expect(dispatcher.execute(ADMITTED)).rejects.toThrow('boom');
  });
});

describe('dispatching a stream', () => {
  it('emits started, one event per chunk, then completed', async () => {
    const dispatcher = createProviderDispatcher({
      providers: registryOf(streaming([chunk(0, 'an '), chunk(1, 'outline', true)])),
    });

    const events = await collect(dispatcher.stream(ADMITTED, null));
    expect(events.map((event) => event.kind)).toEqual(['started', 'chunk', 'chunk', 'completed']);
    expect(events.every((event) => event.streamId === 'idem-1')).toBe(true);
  });

  it('emits exactly what a replay of the finished stream would emit', async () => {
    // The property that makes a resumed client indistinguishable from one that
    // never disconnected: live framing and `eventsOf` must not drift.
    const chunks = [chunk(0, 'an '), chunk(1, 'out'), chunk(2, 'line', true)];
    const dispatcher = createProviderDispatcher({ providers: registryOf(streaming(chunks)) });

    const live = await collect(dispatcher.stream(ADMITTED, null));

    let replayed: AIStream = startStream(
      openStream({ streamId: 'idem-1', request: REQUEST, providerId: 'openai', model: 'gpt-4o' }),
    );
    for (const item of chunks) replayed = acceptChunk(replayed, item);

    expect(live).toEqual([...eventsOf(replayed)]);
  });

  it('carries a resume token on every event', async () => {
    const dispatcher = createProviderDispatcher({
      providers: registryOf(streaming([chunk(0, 'a'), chunk(1, 'b', true)])),
    });
    const events = await collect(dispatcher.stream(ADMITTED, null));
    expect(events.map((event) => event.cursor.resumeToken)).toEqual([
      'stream:idem-1@start',
      'stream:idem-1@0',
      'stream:idem-1@1',
      'stream:idem-1@1',
    ]);
  });

  it('resumes after a cursor without repeating what was already delivered', async () => {
    const dispatcher = createProviderDispatcher({
      providers: registryOf(streaming([chunk(0, 'a'), chunk(1, 'b'), chunk(2, 'c', true)])),
    });

    const events = await collect(
      dispatcher.stream(ADMITTED, {
        streamId: 'idem-1',
        lastSequence: 1,
        completed: false,
        resumeToken: 'stream:idem-1@1',
      }),
    );

    // No second 'started': the client already rendered the first one.
    expect(events.map((event) => event.kind)).toEqual(['chunk', 'completed']);
    expect(events[0]).toMatchObject({ kind: 'chunk', chunk: { sequence: 2 } });
  });

  it('still accepts the skipped chunks, so the next one is not treated as a gap', async () => {
    // Skipping the accept as well as the emit would leave the engine one short
    // and make chunk 2 arrive where 1 was expected.
    const dispatcher = createProviderDispatcher({
      providers: registryOf(streaming([chunk(0, 'a'), chunk(1, 'b'), chunk(2, 'c', true)])),
    });

    const events = await collect(
      dispatcher.stream(ADMITTED, {
        streamId: 'idem-1',
        lastSequence: 0,
        completed: false,
        resumeToken: 'stream:idem-1@0',
      }),
    );
    expect(events.map((event) => event.kind)).toEqual(['chunk', 'chunk', 'completed']);
    expect(events.at(-1)).toMatchObject({ kind: 'completed', finishReason: 'stop' });
  });

  it('refuses to stream from a provider that cannot, rather than buffering silently', async () => {
    const dispatcher = createProviderDispatcher({ providers: registryOf(buffered()) });
    const failure = await collect(dispatcher.stream(ADMITTED, null)).catch(
      (error: unknown) => error,
    );

    expect(isProviderError(failure)).toBe(true);
    expect(isProviderError(failure) && failure.code).toBe('Unavailable');
  });

  it('refuses a stream that ended without a final chunk', async () => {
    const dispatcher = createProviderDispatcher({
      providers: registryOf(streaming([chunk(0, 'half a sen')])),
    });
    const failure = await collect(dispatcher.stream(ADMITTED, null)).catch(
      (error: unknown) => error,
    );

    expect(isProviderError(failure) && failure.code).toBe('MalformedResponse');
  });

  it("lets the engine's refusal of an out-of-order chunk propagate", async () => {
    const dispatcher = createProviderDispatcher({
      providers: registryOf(streaming([chunk(0, 'a'), chunk(5, 'b', true)])),
    });
    await expect(collect(dispatcher.stream(ADMITTED, null))).rejects.toThrow(/expected/);
  });
});
