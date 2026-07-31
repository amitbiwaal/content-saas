import type { AIRequest, AIResponse } from '@contentos/contracts';
import type { Principal } from '@contentos/security';
import { describe, expect, it } from 'vitest';

import type { AdmissionOrganization, AdmissionWorkspace } from '../gateway/ports.js';
import type { ModelProvider, ProviderHealthStatus } from '../providers/provider.js';
import { createProviderRegistry } from '../providers/registry.js';
import type { StreamingModelProvider } from '../providers/streaming-provider.js';
import type { StreamChunk } from '../streaming/chunk.js';
import { createModelCatalogue, type ModelEntry } from './catalogue.js';
import type { ExecutionMode, ExecutionPlan } from './plan.js';
import { createRoutingTable, type RoutingTableOptions } from './policy.js';
import { createRouter, RoutingInputError, type RoutingInput } from './router.js';

const ORG = 'org-1';
const WS = 'ws-1';
const NOW = new Date('2026-07-31T12:00:00.000Z');

const RESPONSE: AIResponse = {
  idempotencyKey: 'idem-1',
  providerId: 'openai',
  model: 'gpt-4o-2026-05-01',
  content: 'text',
  finishReason: 'stop',
  usage: {
    tokens: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    tokensEstimated: false,
    cost: { currency: 'USD', amount: '0.000001' },
    latencyMs: 1,
  },
  providerMetadata: {},
};

/** A provider that records whether anything ever called it. */
function buffered(
  providerId: string,
  capabilities: ModelProvider['capabilities'] = ['chat'],
  health: ProviderHealthStatus = 'healthy',
  calls: { executed: number } = { executed: 0 },
): ModelProvider {
  return {
    providerId,
    displayName: providerId,
    capabilities,
    health: () => Promise.resolve({ status: health, reportedAt: NOW.toISOString(), detail: null }),
    execute: () => {
      calls.executed += 1;
      return Promise.resolve(RESPONSE);
    },
  };
}

function streamingProvider(
  providerId: string,
  capabilities: ModelProvider['capabilities'] = ['chat'],
  health: ProviderHealthStatus = 'healthy',
): StreamingModelProvider {
  return {
    ...buffered(providerId, capabilities, health),
    // eslint-disable-next-line @typescript-eslint/require-await, require-yield
    async *stream(): AsyncIterable<StreamChunk> {
      // Never reached: routing plans, it does not execute.
      throw new Error('routing must never open a stream');
    },
  };
}

const entry = (overrides: Partial<ModelEntry> = {}): ModelEntry => ({
  canonical: 'writing.standard',
  providerId: 'openai',
  providerModel: 'gpt-4o-2026-05-01',
  aliases: ['gpt-4o'],
  capabilities: ['chat'],
  ...overrides,
});

const principal = (overrides: Partial<Principal> = {}): Principal => ({
  subjectId: 'user-1',
  kind: 'user',
  method: 'password',
  organizationId: ORG,
  workspaceId: WS,
  roles: ['editor'],
  permissions: ['article:execute'],
  authenticatedAt: NOW,
  mfaSatisfied: true,
  sessionId: null,
  ...overrides,
});

const organization: AdmissionOrganization = { organizationId: ORG, status: 'active' };
const workspace: AdmissionWorkspace = { workspaceId: WS, organizationId: ORG, status: 'active' };

const request = (overrides: Partial<AIRequest> = {}): AIRequest => ({
  taskType: 'planning.outline',
  capability: 'chat',
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'hello' }],
  params: { temperature: 0.2, maxOutputTokens: 100 },
  timeoutMs: 30_000,
  idempotencyKey: 'idem-1',
  correlationId: 'corr-1',
  tenantId: WS,
  organizationId: ORG,
  ...overrides,
});

interface Harness {
  readonly providers: readonly ModelProvider[];
  readonly entries: readonly ModelEntry[];
  readonly table?: Partial<RoutingTableOptions>;
}

function routerFor(harness: Harness) {
  const registry = createProviderRegistry();
  for (const provider of harness.providers) registry.register(provider);
  registry.seal();

  const catalogue = createModelCatalogue([...harness.entries]);
  catalogue.seal();

  return createRouter({
    providers: registry,
    catalogue,
    table: createRoutingTable({
      version: 'routing-2026-07',
      global: { providerId: 'openai' },
      ...harness.table,
    }),
  });
}

const input = (overrides: Partial<RoutingInput> = {}): RoutingInput => ({
  request: request(),
  principal: principal(),
  organization,
  workspace,
  executionMode: 'buffered' as ExecutionMode,
  ...overrides,
});

const planOf = (
  result: Awaited<ReturnType<ReturnType<typeof routerFor>['route']>>,
): ExecutionPlan => {
  if (result.outcome !== 'routed') throw new Error(`expected a plan, got ${result.code}`);
  return result.plan;
};

// ── Policies ─────────────────────────────────────────────────────────────────

describe('policy precedence', () => {
  const TWO = {
    providers: [buffered('openai'), buffered('anthropic')],
    entries: [
      entry(),
      entry({ providerId: 'anthropic', providerModel: 'claude', aliases: ['gpt-4o'] }),
    ],
  };

  it('honours an explicit provider above everything else', async () => {
    const router = routerFor({
      ...TWO,
      table: { global: { providerId: 'openai' }, workspaces: { [WS]: { providerId: 'openai' } } },
    });
    const plan = planOf(await router.route(input({ requestedProviderId: 'anthropic' })));

    expect(plan.policy).toBe('explicit');
    expect(plan.providerId).toBe('anthropic');
    expect(plan.reasons).toContain('routing.explicit_provider');
  });

  it('falls to the workspace default above the organization one', async () => {
    const router = routerFor({
      ...TWO,
      table: {
        global: { providerId: 'openai' },
        organizations: { [ORG]: { providerId: 'openai' } },
        workspaces: { [WS]: { providerId: 'anthropic' } },
      },
    });
    const plan = planOf(await router.route(input()));

    expect(plan.policy).toBe('workspace-default');
    expect(plan.providerId).toBe('anthropic');
  });

  it('falls to the organization default above the global one', async () => {
    const router = routerFor({
      ...TWO,
      table: {
        global: { providerId: 'openai' },
        organizations: { [ORG]: { providerId: 'anthropic' } },
      },
    });
    const plan = planOf(await router.route(input()));

    expect(plan.policy).toBe('organization-default');
    expect(plan.providerId).toBe('anthropic');
  });

  it('falls to the global default when nothing more specific applies', async () => {
    const plan = planOf(await routerFor(TWO).route(input()));

    expect(plan.policy).toBe('global-default');
    expect(plan.providerId).toBe('openai');
    expect(plan.reasons).toContain('routing.global_default');
  });

  it('scopes a workspace default to that workspace', async () => {
    const router = routerFor({
      ...TWO,
      table: {
        global: { providerId: 'openai' },
        workspaces: { 'ws-other': { providerId: 'anthropic' } },
      },
    });
    expect(planOf(await router.route(input())).providerId).toBe('openai');
  });

  it('lets a policy pin a model as well as a provider', async () => {
    // How an operator holds a workspace on a known-good snapshot while a new
    // one is evaluated.
    const router = routerFor({
      providers: [buffered('openai')],
      entries: [
        entry(),
        entry({ canonical: 'writing.pinned', providerModel: 'gpt-4o-2026-01', aliases: [] }),
      ],
      table: { global: { providerId: 'openai', model: 'writing.pinned' } },
    });
    const plan = planOf(await router.route(input({ request: request({ model: 'gpt-4o' }) })));

    expect(plan.model).toBe('gpt-4o-2026-01');
    expect(plan.canonicalModel).toBe('writing.pinned');
  });

  it('records the policy version on every decision', async () => {
    expect(planOf(await routerFor(TWO).route(input())).policyVersion).toBe('routing-2026-07');
  });
});

// ── Model resolution ─────────────────────────────────────────────────────────

describe('model resolution', () => {
  const ONE = { providers: [buffered('openai')], entries: [entry()] };

  it('resolves requested to canonical to provider model', async () => {
    const plan = planOf(await routerFor(ONE).route(input()));

    expect(plan.canonicalModel).toBe('writing.standard');
    expect(plan.model).toBe('gpt-4o-2026-05-01');
  });

  it('records that an alias was resolved', async () => {
    expect(planOf(await routerFor(ONE).route(input())).reasons).toContain(
      'routing.model_alias_resolved',
    );
  });

  it('does not claim an alias when the canonical name was used', async () => {
    const plan = planOf(
      await routerFor(ONE).route(input({ request: request({ model: 'writing.standard' }) })),
    );
    expect(plan.reasons).not.toContain('routing.model_alias_resolved');
  });

  it('never carries the alias downstream', async () => {
    // A component that received 'gpt-4o' would have to resolve it again,
    // against a table it does not hold.
    const plan = planOf(await routerFor(ONE).route(input()));
    expect(JSON.stringify(plan)).not.toContain('"gpt-4o"');
  });

  it('refuses a name nothing in the catalogue answers to', async () => {
    const result = await routerFor(ONE).route(input({ request: request({ model: 'gpt-9' }) }));
    expect(result).toMatchObject({ outcome: 'refused', code: 'UnknownModel' });
  });

  it('distinguishes a model the NAMED provider lacks from one nobody has', async () => {
    const router = routerFor({
      providers: [buffered('openai'), buffered('anthropic')],
      entries: [
        entry(),
        entry({
          canonical: 'writing.fast',
          providerId: 'anthropic',
          providerModel: 'haiku',
          aliases: ['fast'],
        }),
      ],
      table: { global: { providerId: 'openai' } },
    });

    // 'fast' exists — on anthropic, not on the provider the CALLER named.
    expect(
      await router.route(
        input({ request: request({ model: 'fast' }), requestedProviderId: 'openai' }),
      ),
    ).toMatchObject({ code: 'ModelNotOnProvider' });

    expect(await router.route(input({ request: request({ model: 'nothing' }) }))).toMatchObject({
      code: 'UnknownModel',
    });
  });

  it('lets a DEFAULT fall through to a provider that has the model', async () => {
    // A default that refused rather than falling back would not be a default.
    const router = routerFor({
      providers: [buffered('openai'), buffered('anthropic')],
      entries: [
        entry(),
        entry({
          canonical: 'writing.fast',
          providerId: 'anthropic',
          providerModel: 'haiku',
          aliases: ['fast'],
        }),
      ],
      table: { global: { providerId: 'openai' } },
    });

    const plan = planOf(await router.route(input({ request: request({ model: 'fast' }) })));
    expect(plan.providerId).toBe('anthropic');
    expect(plan.model).toBe('haiku');
  });
});

// ── Selection and rejection ──────────────────────────────────────────────────

describe('provider selection', () => {
  it('refuses a policy naming a provider that is not registered', async () => {
    const router = routerFor({
      providers: [buffered('openai')],
      entries: [entry()],
      table: { global: { providerId: 'ghost' } },
    });
    expect(await router.route(input())).toMatchObject({
      outcome: 'refused',
      code: 'UnknownProvider',
    });
  });

  it('refuses when the provider does not declare the capability', async () => {
    const router = routerFor({
      providers: [buffered('openai', ['embedding'])],
      entries: [entry()],
    });
    expect(await router.route(input())).toMatchObject({ code: 'CapabilityUnavailable' });
  });

  it('refuses when the MODEL does not declare the capability', async () => {
    // A provider offering chat and embeddings does not offer both from every
    // model; routing on the provider's list alone would pick the wrong one.
    const router = routerFor({
      providers: [buffered('openai', ['chat', 'embedding'])],
      entries: [entry({ capabilities: ['embedding'] })],
    });
    const result = await router.route(input());
    expect(result).toMatchObject({ code: 'CapabilityUnavailable' });
    if (result.outcome !== 'refused') return;
    expect(result.reasons).toContain('routing.capability_filtered');
  });

  it('refuses when every candidate is offline', async () => {
    const router = routerFor({
      providers: [buffered('openai', ['chat'], 'offline')],
      entries: [entry()],
    });
    const result = await router.route(input());
    expect(result).toMatchObject({ code: 'ProviderUnhealthy' });
    if (result.outcome !== 'refused') return;
    expect(result.reasons).toContain('routing.health_filtered');
  });

  it('reads a provider that cannot answer about its health as offline', async () => {
    const broken: ModelProvider = {
      ...buffered('openai'),
      health: () => Promise.reject(new Error('connection refused')),
    };
    const router = routerFor({ providers: [broken], entries: [entry()] });
    expect(await router.route(input())).toMatchObject({ code: 'ProviderUnhealthy' });
  });

  it('skips an offline default and routes to a healthy provider', async () => {
    const harness = {
      providers: [buffered('openai', ['chat'], 'offline'), buffered('anthropic')],
      entries: [
        entry(),
        entry({ providerId: 'anthropic', providerModel: 'claude', aliases: ['gpt-4o'] }),
      ],
      table: { global: { providerId: 'openai' } },
    };
    const plan = planOf(await routerFor(harness).route(input()));
    expect(plan.providerId).toBe('anthropic');
    expect(plan.reasons).toContain('routing.health_filtered');
  });

  it('refuses rather than moving off a provider the CALLER named', async () => {
    // A default is a preference; a caller's choice is a constraint. Moving off
    // it would send their data to a vendor they did not pick.
    const router = routerFor({
      providers: [buffered('openai', ['chat'], 'offline'), buffered('anthropic')],
      entries: [
        entry(),
        entry({ providerId: 'anthropic', providerModel: 'claude', aliases: ['gpt-4o'] }),
      ],
      table: {},
    });
    expect(await router.route(input({ requestedProviderId: 'openai' }))).toMatchObject({
      code: 'ProviderUnhealthy',
    });
  });

  it('keeps a degraded provider usable rather than refusing it', async () => {
    // Degraded means working but impaired. Refusing it outright would take the
    // platform down for a partial vendor incident.
    const router = routerFor({
      providers: [buffered('openai', ['chat'], 'degraded')],
      entries: [entry()],
      table: {},
    });
    const plan = planOf(await router.route(input()));
    expect(plan.providerId).toBe('openai');
    expect(plan.reasons).toContain('routing.health_degraded');
  });

  it('ranks health above a preference, so a degraded default loses to a healthy peer', async () => {
    const router = routerFor({
      providers: [buffered('openai', ['chat'], 'degraded'), buffered('anthropic')],
      entries: [
        entry(),
        entry({ providerId: 'anthropic', providerModel: 'claude', aliases: ['gpt-4o'] }),
      ],
      table: { global: { providerId: 'openai' } },
    });
    const plan = planOf(await router.route(input()));

    expect(plan.providerId).toBe('anthropic');
    // Still in the chain — demoted, not discarded.
    expect(plan.fallbacks.map((f) => f.providerId)).toEqual(['openai']);
  });

  it('honours a healthy preference over registration order', async () => {
    const router = routerFor({
      providers: [buffered('openai'), buffered('anthropic')],
      entries: [
        entry(),
        entry({ providerId: 'anthropic', providerModel: 'claude', aliases: ['gpt-4o'] }),
      ],
      table: { global: { providerId: 'anthropic' } },
    });
    const plan = planOf(await router.route(input()));

    expect(plan.providerId).toBe('anthropic');
    expect(plan.fallbacks.map((f) => f.providerId)).toEqual(['openai']);
  });
});

// ── Streaming ────────────────────────────────────────────────────────────────

describe('streaming compatibility', () => {
  it('routes a streaming request to a provider that can stream', async () => {
    const router = routerFor({
      providers: [streamingProvider('openai')],
      entries: [entry()],
    });
    const plan = planOf(await router.route(input({ executionMode: 'streaming' })));

    expect(plan.executionMode).toBe('streaming');
    expect(plan.streamingMode).toBe('native');
    expect(plan.reasons).toContain('routing.streaming_required');
  });

  it('refuses a streaming request when nothing can stream', async () => {
    // Never silently downgraded: a client that asked to stream and received one
    // response at the end has had its latency budget spent without being told.
    const router = routerFor({ providers: [buffered('openai')], entries: [entry()] });
    expect(await router.route(input({ executionMode: 'streaming' }))).toMatchObject({
      code: 'StreamingUnsupported',
    });
  });

  it('routes a buffered request to a provider that cannot stream', async () => {
    const plan = planOf(
      await routerFor({ providers: [buffered('openai')], entries: [entry()] }).route(input()),
    );
    expect(plan.executionMode).toBe('buffered');
    expect(plan.streamingMode).toBe('unsupported');
  });

  it('records that a buffered plan COULD have streamed', async () => {
    const plan = planOf(
      await routerFor({ providers: [streamingProvider('openai')], entries: [entry()] }).route(
        input(),
      ),
    );
    expect(plan.executionMode).toBe('buffered');
    expect(plan.streamingMode).toBe('native');
  });

  it('keeps every fallback able to stream when the plan streams', async () => {
    // A fallback that cannot stream is useless to a streaming plan, and
    // advancing onto it would fail at dispatch rather than at planning.
    const router = routerFor({
      providers: [streamingProvider('openai'), buffered('anthropic'), streamingProvider('google')],
      entries: [
        entry(),
        entry({ providerId: 'anthropic', providerModel: 'claude', aliases: ['gpt-4o'] }),
        entry({ providerId: 'google', providerModel: 'gemini', aliases: ['gpt-4o'] }),
      ],
      table: {},
    });
    const plan = planOf(await router.route(input({ executionMode: 'streaming' })));

    expect(plan.fallbacks.map((f) => f.providerId)).toEqual(['google']);
    expect(plan.fallbacks.every((f) => f.streamingMode === 'native')).toBe(true);
  });
});

// ── Fallback planning ────────────────────────────────────────────────────────

describe('fallback planning', () => {
  const THREE = {
    providers: [buffered('openai'), buffered('anthropic'), buffered('google')],
    entries: [
      entry(),
      entry({ providerId: 'anthropic', providerModel: 'claude', aliases: ['gpt-4o'] }),
      entry({ providerId: 'google', providerModel: 'gemini', aliases: ['gpt-4o'] }),
    ],
    // No default: capability selection, so every capable provider is a
    // candidate and the chain is the full registration order.
    table: {},
  };

  it('orders the remaining candidates behind the primary', async () => {
    const plan = planOf(await routerFor(THREE).route(input()));

    expect(plan.providerId).toBe('openai');
    expect(plan.fallbacks.map((f) => f.providerId)).toEqual(['anthropic', 'google']);
    expect(plan.reasons).toContain('routing.fallback_planned');
  });

  it('plans no fallback off a provider the CALLER named', async () => {
    // Falling off an explicitly named provider sends the caller's data
    // somewhere they did not choose — the data-residency concern
    // `model-router.md` §Security raises.
    const plan = planOf(await routerFor(THREE).route(input({ requestedProviderId: 'anthropic' })));

    expect(plan.providerId).toBe('anthropic');
    expect(plan.fallbacks).toEqual([]);
    expect(plan.reasons).toContain('routing.no_fallback_available');
  });

  it('hoists a default to the front and keeps the others behind it', async () => {
    const router = routerFor({ ...THREE, table: { global: { providerId: 'google' } } });
    const plan = planOf(await router.route(input()));

    expect(plan.providerId).toBe('google');
    expect(plan.fallbacks.map((f) => f.providerId)).toEqual(['openai', 'anthropic']);
  });

  it('plans no fallback when only one provider offers the model', async () => {
    const router = routerFor({ providers: [buffered('openai')], entries: [entry()], table: {} });
    const plan = planOf(await router.route(input()));

    expect(plan.fallbacks).toEqual([]);
    expect(plan.reasons).toContain('routing.no_fallback_available');
  });

  it('excludes an offline provider from the chain entirely', async () => {
    const router = routerFor({
      providers: [
        buffered('openai'),
        buffered('anthropic', ['chat'], 'offline'),
        buffered('google'),
      ],
      entries: THREE.entries,
      table: {},
    });
    const plan = planOf(await router.route(input()));
    expect(plan.fallbacks.map((f) => f.providerId)).toEqual(['google']);
  });

  it('puts a degraded candidate behind every healthy one', async () => {
    const router = routerFor({
      providers: [
        buffered('openai', ['chat'], 'degraded'),
        buffered('anthropic'),
        buffered('google'),
      ],
      entries: THREE.entries,
      table: {},
    });
    const plan = planOf(await router.route(input()));

    expect(plan.providerId).toBe('anthropic');
    expect(plan.fallbacks.map((f) => f.providerId)).toEqual(['google', 'openai']);
  });

  it('never advances the chain itself', async () => {
    // "The Router supplies the chain, not the schedule."
    const calls = { executed: 0 };
    const router = routerFor({
      providers: [buffered('openai', ['chat'], 'healthy', calls)],
      entries: [entry()],
    });
    await router.route(input());
    expect(calls.executed).toBe(0);
  });
});

// ── Determinism and immutability ─────────────────────────────────────────────

describe('the plan itself', () => {
  const THREE = {
    providers: [buffered('openai'), buffered('anthropic')],
    entries: [
      entry(),
      entry({ providerId: 'anthropic', providerModel: 'claude', aliases: ['gpt-4o'] }),
    ],
  };

  it('is identical for identical inputs', async () => {
    const router = routerFor(THREE);
    const [first, second] = await Promise.all([router.route(input()), router.route(input())]);
    expect(first).toEqual(second);
  });

  it('is identical across two routers built the same way', async () => {
    expect(planOf(await routerFor(THREE).route(input()))).toEqual(
      planOf(await routerFor(THREE).route(input())),
    );
  });

  it('is deeply frozen', async () => {
    const plan = planOf(await routerFor(THREE).route(input()));

    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.fallbacks)).toBe(true);
    expect(Object.isFrozen(plan.reasons)).toBe(true);
    expect(Object.isFrozen(plan.fallbacks[0])).toBe(true);
  });

  it('refuses a write rather than accepting one a cast made legal', async () => {
    const plan = planOf(await routerFor(THREE).route(input()));
    expect(() => {
      (plan as unknown as { model: string }).model = 'something-cheaper';
    }).toThrow(TypeError);
    expect(() => {
      (plan.fallbacks as unknown as { push: (t: unknown) => void }).push({});
    }).toThrow(TypeError);
  });

  it('carries every field the increment names', async () => {
    const plan = planOf(await routerFor(THREE).route(input()));
    expect(plan).toMatchObject({
      providerId: expect.any(String) as string,
      model: expect.any(String) as string,
      capability: 'chat',
      executionMode: 'buffered',
      streamingMode: expect.any(String) as string,
    });
  });
});

describe('input integrity', () => {
  it('refuses a principal that does not belong to the tenancy it was handed', async () => {
    // A plan built from these would name the wrong tenant.
    const router = routerFor({ providers: [buffered('openai')], entries: [entry()] });

    await expect(
      router.route(input({ principal: principal({ workspaceId: 'ws-other' }) })),
    ).rejects.toBeInstanceOf(RoutingInputError);
    await expect(
      router.route(input({ principal: principal({ organizationId: 'org-other' }) })),
    ).rejects.toBeInstanceOf(RoutingInputError);
  });

  it('leaves the request untouched', async () => {
    const original = request();
    const router = routerFor({ providers: [buffered('openai')], entries: [entry()] });
    await router.route(input({ request: original }));
    expect(original).toEqual(request());
  });
});
