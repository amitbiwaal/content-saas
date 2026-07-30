/**
 * The provider abstraction, against the REAL packages.
 *
 * The unit suites check each piece against its own imports. What they cannot
 * check is the thing that decides whether the abstraction actually holds: that
 * the canonical contracts are reachable from `@contentos/contracts` — the
 * barrel an ENGINE imports — while the port stays inside `@contentos/ai`.
 *
 * That split is the whole design. `01-system-architecture/04-context-map.md`
 * names AIRequest/AIResponse the AI Capability's Open Host Service: "one
 * published interface serves every context". An engine is a feature package
 * and two feature packages may not import each other, so a contract defined
 * beside the port would be one no engine could name — and every engine would
 * grow its own bespoke AI integration, which is the outcome the port exists to
 * prevent.
 */

import { describe, expect, it } from 'vitest';

import {
  AI_CAPABILITIES,
  AI_REQUEST_FIELDS,
  AI_RESPONSE_FIELDS,
  AI_ROLES,
  FINISH_REASONS,
  isAICapability,
  isProviderError,
  PROVIDER_ERROR_CODES,
  ProviderError,
  RETRYABLE_PROVIDER_ERROR_CODES,
  type AIRequest,
  type AIResponse,
} from '@contentos/contracts';
import {
  assertCapabilityDeclared,
  createProviderRegistry,
  normalizeProviderError,
  PROVIDER_HEALTH_STATUSES,
  supportsCapability,
  throughProvider,
  validateAIRequest,
  validateAIResponse,
  type ModelProvider,
} from '@contentos/ai';

const WS = '018f7a1e-0000-7000-8000-0000000000bb';
const ORG = '018f7a1e-0000-7000-8000-0000000000aa';
const CORRELATION = '018f7a1e-0000-7000-8000-0000000000dd';

function request(over: Partial<AIRequest> = {}): AIRequest {
  return {
    taskType: 'planning.outline',
    capability: 'chat',
    model: 'reference-model',
    messages: [{ role: 'user', content: 'Draft an outline.' }],
    params: { temperature: 0.2, maxOutputTokens: 512 },
    timeoutMs: 30_000,
    idempotencyKey: 'run-1:step-3',
    correlationId: CORRELATION,
    tenantId: WS,
    organizationId: ORG,
    ...over,
  };
}

/**
 * A provider that satisfies the port using nothing but the canonical contracts.
 *
 * It is the proof the port is implementable without a vendor: if this needed a
 * field the contracts do not carry, the abstraction would be incomplete, and
 * the first real adapter would discover it instead.
 */
function referenceProvider(over: Partial<ModelProvider> = {}): ModelProvider {
  return {
    providerId: 'reference',
    displayName: 'Reference Provider',
    capabilities: ['text', 'chat'],
    health: () =>
      Promise.resolve({
        status: 'healthy' as const,
        reportedAt: '2026-07-30T12:00:00.000Z',
        detail: null,
      }),
    execute: (req: AIRequest): Promise<AIResponse> =>
      Promise.resolve({
        idempotencyKey: req.idempotencyKey,
        providerId: 'reference',
        model: `${req.model}-2026-05-01`,
        content: 'An outline.',
        finishReason: 'stop',
        usage: {
          tokens: { promptTokens: 12, completionTokens: 30, totalTokens: 42 },
          tokensEstimated: false,
          cost: { currency: 'USD', amount: '0.000420' },
          latencyMs: 91,
        },
        providerMetadata: { requestId: 'req_reference' },
      }),
    ...over,
  };
}

describe('the canonical contracts are published where an engine can reach them', () => {
  // The Open Host Service. A deep import is blocked by `exports`, so being on
  // the barrel is the whole of "published".
  it('exports the request vocabulary from @contentos/contracts', () => {
    expect(AI_REQUEST_FIELDS.length).toBeGreaterThan(0);
    expect([...AI_ROLES]).toEqual(['system', 'user', 'assistant']);
    expect([...AI_CAPABILITIES]).toEqual(['text', 'chat', 'image', 'embedding', 'vision', 'audio']);
  });

  it('exports the response vocabulary from @contentos/contracts', () => {
    expect(AI_RESPONSE_FIELDS.length).toBeGreaterThan(0);
    expect([...FINISH_REASONS]).toEqual(['stop', 'length', 'content_filter', 'tool_call']);
  });

  it('exports the error taxonomy from @contentos/contracts', () => {
    expect(PROVIDER_ERROR_CODES).toHaveLength(10);
    expect(typeof ProviderError).toBe('function');
    expect(isProviderError(new ProviderError('Timeout', 'x', 'y'))).toBe(true);
  });

  // The taxonomy is one closed set; a retryable code outside it would be a
  // classification nothing else recognises.
  it('draws every retryable code from the taxonomy', () => {
    for (const code of RETRYABLE_PROVIDER_ERROR_CODES) {
      expect(PROVIDER_ERROR_CODES, code).toContain(code);
    }
  });

  it('covers every error name the increment lists', () => {
    for (const code of [
      'Authentication',
      'RateLimit',
      'Unavailable',
      'Timeout',
      'Validation',
      'Internal',
    ] as const) {
      expect(PROVIDER_ERROR_CODES, code).toContain(code);
    }
  });

  // Each of the spec's nine typed errors has exactly one home here.
  it('covers the whole taxonomy in provider-adapters.md', () => {
    for (const code of [
      'Authentication', // ProviderAuthFailed
      'RateLimit', // ProviderRateLimited
      'Unavailable', // ProviderUnavailable
      'Timeout', // ProviderTimeout
      'Validation', // ProviderBadRequest
      'ContentFiltered', // ProviderContentFiltered
      'ContextTooLarge', // ProviderContextTooLarge
      'ModelUnavailable', // ProviderModelUnavailable
      'MalformedResponse', // ProviderMalformedResponse
    ] as const) {
      expect(PROVIDER_ERROR_CODES, code).toContain(code);
    }
  });
});

describe('the port stays inside @contentos/ai', () => {
  it('publishes the health vocabulary and nothing that polls it', () => {
    expect([...PROVIDER_HEALTH_STATUSES]).toEqual(['healthy', 'degraded', 'offline']);
  });

  it('publishes the registry, the normalizer and the validators', () => {
    expect(typeof createProviderRegistry).toBe('function');
    expect(typeof normalizeProviderError).toBe('function');
    expect(typeof validateAIRequest).toBe('function');
    expect(typeof validateAIResponse).toBe('function');
  });
});

describe('a provider can be built from the canonical contracts alone', () => {
  const provider = referenceProvider();

  it('answers with a valid response to a valid request', async () => {
    const req = request();
    expect(validateAIRequest(req)).toEqual({ ok: true });

    const res = await provider.execute(req);
    expect(validateAIResponse(res)).toEqual({ ok: true });
  });

  // Which response answered which request has to be answerable without holding
  // state, because a retry is a second call for the same key.
  it('echoes the idempotency key, tying a response to its cause', async () => {
    const res = await provider.execute(request({ idempotencyKey: 'run-9:step-1' }));
    expect(res.idempotencyKey).toBe('run-9:step-1');
  });

  // The model that ran is not necessarily the model asked for.
  it('reports the model that actually ran', async () => {
    const res = await provider.execute(request({ model: 'reference-model' }));
    expect(res.model).toBe('reference-model-2026-05-01');
  });

  it('reports provider-declared health without anything probing it', async () => {
    expect(await provider.health()).toMatchObject({ status: 'healthy', detail: null });
  });

  it('declares what it can do', () => {
    expect(supportsCapability(provider, 'chat')).toBe(true);
    expect(supportsCapability(provider, 'audio')).toBe(false);
  });
});

describe('the registry, end to end', () => {
  function composed() {
    const registry = createProviderRegistry();
    registry.register(referenceProvider());
    registry.register(
      referenceProvider({
        providerId: 'reference-embed',
        displayName: 'Reference Embeddings',
        capabilities: ['embedding'],
      }),
    );
    registry.seal();
    return registry;
  }

  it('composes, verifies and seals', () => {
    const registry = composed();
    expect(registry.sealed).toBe(true);
    expect(registry.listIds()).toEqual(['reference', 'reference-embed']);
  });

  it('routes a request to a provider found by capability', async () => {
    const registry = composed();
    const req = request({ capability: 'chat' });

    const candidates = registry.providersWith(req.capability);
    expect(candidates).toHaveLength(1);

    const provider = candidates[0];
    expect(provider).toBeDefined();
    if (provider === undefined) return;

    // The check that must run before a provider is contacted.
    assertCapabilityDeclared(provider.providerId, provider.capabilities, req.capability);
    const res = await provider.execute(req);
    expect(validateAIResponse(res)).toEqual({ ok: true });
  });

  it('discovers the embedding provider without any routing decision', () => {
    expect(
      composed()
        .providersWith('embedding')
        .map((p) => p.providerId),
    ).toEqual(['reference-embed']);
  });

  it('refuses to accept a provider once startup is over', () => {
    expect(() => {
      composed().register(referenceProvider({ providerId: 'late' }));
    }).toThrow(/sealed/);
  });

  it('refuses a second provider claiming an id already taken', () => {
    const registry = createProviderRegistry();
    registry.register(referenceProvider());
    expect(() => {
      registry.register(referenceProvider({ displayName: 'Impostor' }));
    }).toThrow(/already registered/);
  });
});

describe('a vendor failure never escapes as itself', () => {
  it('turns a raw rejection into a typed error, through the real wrapper', async () => {
    const provider = referenceProvider({
      execute: () =>
        throughProvider('reference', () =>
          Promise.reject(Object.assign(new Error('Rate limit reached'), { status: 429 })),
        ),
    });

    await expect(provider.execute(request())).rejects.toBeInstanceOf(ProviderError);
    await expect(provider.execute(request())).rejects.toMatchObject({
      code: 'RateLimit',
      providerId: 'reference',
      retryable: true,
    });
  });

  it('classifies a failure that never had a status', async () => {
    const provider = referenceProvider({
      execute: () => throughProvider('reference', () => Promise.reject(new Error('ECONNREFUSED'))),
    });
    await expect(provider.execute(request())).rejects.toMatchObject({ code: 'Unavailable' });
  });

  it('leaves nothing unclassified', () => {
    for (const cause of [undefined, null, 'x', 0, {}, [], new Error('?')]) {
      const error = normalizeProviderError('reference', cause);
      expect(PROVIDER_ERROR_CODES).toContain(error.code);
    }
  });
});

describe('the contracts cross a serialization boundary intact', () => {
  // A request is rebuilt from a job payload and a response is metered through
  // the outbox, so both are wire values before they are objects.
  it('round-trips a request through JSON', () => {
    const original = request({ params: { temperature: 0, maxOutputTokens: 8, seed: 7 } });
    const restored = JSON.parse(JSON.stringify(original)) as AIRequest;
    expect(restored).toEqual(original);
    expect(validateAIRequest(restored)).toEqual({ ok: true });
  });

  it('round-trips a response through JSON', async () => {
    const original = await referenceProvider().execute(request());
    const restored = JSON.parse(JSON.stringify(original)) as AIResponse;
    expect(restored).toEqual(original);
    expect(validateAIResponse(restored)).toEqual({ ok: true });
  });

  // The reason the amount is a string: a float loses money at the sixth
  // decimal, and this value reaches the credits ledger.
  it('preserves a cost to the sixth decimal', () => {
    const amount = '0.000001';
    const restored = JSON.parse(JSON.stringify({ amount })) as { amount: string };
    expect(restored.amount).toBe(amount);
    expect(typeof restored.amount).toBe('string');
  });

  it('keeps every capability recognisable after a round trip', () => {
    for (const capability of AI_CAPABILITIES) {
      expect(isAICapability(JSON.parse(JSON.stringify(capability))), capability).toBe(true);
    }
  });
});
