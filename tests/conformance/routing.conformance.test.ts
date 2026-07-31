/**
 * Routing against the components it reuses, and against the document that
 * constrains it.
 *
 * ── What only this file can check ───────────────────────────────────────────
 *
 * 1. NO DUPLICATE DISCOVERY, NO DUPLICATE CAPABILITY CHECK. Routing must ask
 *    the registry who exists and the provider abstraction what it can do. A
 *    second copy of either is only visible structurally, because a copy that
 *    happens to agree today passes every behavioural test.
 *
 * 2. WORKFLOW RUNTIME COMPATIBILITY. A plan is only useful if the runtime can
 *    execute it. Asserted by taking a real plan, driving the real workflow
 *    engine with it, and checking the `AIRequest` that comes out names exactly
 *    what routing chose — through the frozen `validateAIRequest`.
 *
 * 3. IT NEVER EXECUTES. Registered providers count their own calls; routing a
 *    request must leave every counter at zero. That property is the whole of
 *    "Routing prepares execution. Workflow Runtime executes it."
 *
 * 4. THE DIVERGENCES from `model-router.md`, recorded so they cannot be
 *    forgotten.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  awaitExecution,
  buildRequest,
  createModelCatalogue,
  createProviderRegistry,
  createPromptCatalogue,
  createRouter,
  createRoutingTable,
  createWorkflowExecution,
  loadStep,
  preparePrompt,
  ROUTING_POLICIES,
  ROUTING_REASONS,
  ROUTING_REJECTION_CODES,
  startWorkflow,
  validateAIRequest,
  type AdmissionOrganization,
  type AdmissionWorkspace,
  type ExecutionPlan,
  type ModelEntry,
  type ModelProvider,
  type PromptTemplate,
  type RoutingInput,
  type WorkflowDefinition,
} from '@contentos/ai';
import type { AIRequest, AIResponse } from '@contentos/contracts';
import type { Principal } from '@contentos/security';
import { describe, expect, it } from 'vitest';

const ORG = '018f7a1e-0000-7000-8000-0000000000aa';
const WS = '018f7a1e-0000-7000-8000-0000000000bb';
const CORRELATION = '018f7a1e-0000-7000-8000-0000000000dd';
const NOW = new Date('2026-07-31T12:00:00.000Z');

const sourceOf = (relative: string): string =>
  readFileSync(
    fileURLToPath(new URL(`../../packages/ai/src/routing/${relative}`, import.meta.url)),
    'utf8',
  );

const codeOf = (relative: string): string =>
  sourceOf(relative)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

const RESPONSE: AIResponse = {
  idempotencyKey: 'run-1:step-1',
  providerId: 'openai',
  model: 'gpt-4o-2026-05-01',
  content: 'An outline.',
  finishReason: 'stop',
  usage: {
    tokens: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    tokensEstimated: false,
    cost: { currency: 'USD', amount: '0.000015' },
    latencyMs: 12,
  },
  providerMetadata: {},
};

/** Providers that count every call anything makes to them. */
function counting(providerId: string, calls: { executed: number }): ModelProvider {
  return {
    providerId,
    displayName: providerId,
    capabilities: ['chat'],
    health: () =>
      Promise.resolve({ status: 'healthy' as const, reportedAt: NOW.toISOString(), detail: null }),
    execute: () => {
      calls.executed += 1;
      return Promise.resolve(RESPONSE);
    },
  };
}

const ENTRIES: readonly ModelEntry[] = [
  {
    canonical: 'writing.standard',
    providerId: 'openai',
    providerModel: 'gpt-4o-2026-05-01',
    aliases: ['gpt-4o'],
    capabilities: ['chat'],
  },
  {
    canonical: 'writing.standard',
    providerId: 'anthropic',
    providerModel: 'claude-sonnet-2026-03',
    aliases: ['gpt-4o'],
    capabilities: ['chat'],
  },
];

const principal: Principal = Object.freeze({
  subjectId: 'user-1',
  kind: 'user',
  method: 'password',
  organizationId: ORG,
  workspaceId: WS,
  roles: Object.freeze(['editor' as const]),
  permissions: Object.freeze(['article:execute' as const]),
  authenticatedAt: NOW,
  mfaSatisfied: true,
  sessionId: null,
});

const organization: AdmissionOrganization = { organizationId: ORG, status: 'active' };
const workspace: AdmissionWorkspace = { workspaceId: WS, organizationId: ORG, status: 'active' };

const request: AIRequest = {
  taskType: 'planning.outline',
  capability: 'chat',
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'outline this' }],
  params: { temperature: 0.2, maxOutputTokens: 1024 },
  timeoutMs: 30_000,
  idempotencyKey: 'run-1:step-1',
  correlationId: CORRELATION,
  tenantId: WS,
  organizationId: ORG,
};

function routerWith(calls: { executed: number }) {
  const providers = createProviderRegistry();
  providers.register(counting('openai', calls));
  providers.register(counting('anthropic', calls));
  providers.seal();

  const catalogue = createModelCatalogue([...ENTRIES]);
  catalogue.seal();

  return {
    providers,
    router: createRouter({
      providers,
      catalogue,
      table: createRoutingTable({ version: 'routing-2026-07' }),
    }),
  };
}

const input: RoutingInput = {
  request,
  principal,
  organization,
  workspace,
  executionMode: 'buffered',
};

async function planFor(calls: { executed: number }): Promise<ExecutionPlan> {
  const result = await routerWith(calls).router.route(input);
  if (result.outcome !== 'routed') throw new Error(`expected a plan, got ${result.code}`);
  return result.plan;
}

// ── 1 · No duplicate discovery, no duplicate capability check ───────────────

describe('routing reuses what already exists', () => {
  it('asks the registry who exists rather than keeping its own list', () => {
    const router = codeOf('router.ts');
    expect(router).toContain("from '../providers/registry.js'");
    // No second inventory. A copy that agrees today diverges first under
    // exactly the conditions that make routing matter.
    expect(router).not.toMatch(/new Map<string, ModelProvider>|const PROVIDERS\b/);
  });

  it('reads capability from the declared data, not from a table of its own', () => {
    const router = codeOf('router.ts');
    expect(router).toContain('provider.capabilities.includes');
    expect(router).toContain('entry.capabilities.includes');
    expect(router).not.toMatch(/CAPABILITY_MAP|capabilitiesFor\s*\(/);
  });

  it('asks the provider abstraction whether a provider can stream', () => {
    expect(codeOf('router.ts')).toContain('isStreamingProvider');
    expect(codeOf('router.ts')).not.toMatch(/typeof\s+provider\.stream/);
  });

  it('imports no provider SDK, and no other feature package', () => {
    for (const file of ['router.ts', 'plan.ts', 'catalogue.ts', 'policy.ts']) {
      const imports = [...codeOf(file).matchAll(/from '([^']+)'/g)].map((match) => match[1]);
      for (const forbidden of [
        'openai',
        '@anthropic-ai/sdk',
        '@google/generative-ai',
        '@contentos/platform',
        '@contentos/events',
        '@contentos/database',
      ]) {
        expect(imports, `${file} / ${forbidden}`).not.toContain(forbidden);
      }
    }
  });
});

// ── 2 · It never executes ──────────────────────────────────────────────────

describe('routing selects and never executes', () => {
  it('leaves every provider untouched', async () => {
    const calls = { executed: 0 };
    await planFor(calls);
    expect(calls.executed).toBe(0);
  });

  it('has no reachable path to a provider call', () => {
    const router = codeOf('router.ts');
    expect(router).not.toMatch(/\.execute\s*\(/);
    expect(router).not.toMatch(/\.stream\s*\(/);
    expect(router).not.toMatch(/providers\.get\([^)]*\)\.execute/);
  });

  it('does not advance the chain it planned', async () => {
    // "The Router supplies the chain, not the schedule."
    const plan = await planFor({ executed: 0 });
    expect(plan.fallbacks.length).toBeGreaterThan(0);
    expect(codeOf('router.ts')).not.toMatch(/fallbacks\[\d+\]|shift\(\)|advance/);
  });
});

// ── 3 · Workflow runtime compatibility ─────────────────────────────────────

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

describe('a plan is something the workflow runtime can execute', () => {
  it('produces an AIRequest naming exactly what routing chose', async () => {
    const plan = await planFor({ executed: 0 });

    const definition: WorkflowDefinition = {
      id: 'ai.single',
      version: 1,
      description: 'One step, executed from a routing plan.',
      steps: [
        {
          id: 'step-1',
          templateRef: { id: 'planning.outline' },
          // The PLAN's capability and RESOLVED model, carried into the
          // definition the runtime consumes. This is the seam under test.
          capability: plan.capability,
          model: plan.model,
          timeoutMs: 30_000,
        },
      ],
    };

    let execution = startWorkflow(
      createWorkflowExecution({
        workflowId: 'run-1',
        definition,
        context: {
          tenant: { tenantId: WS, organizationId: ORG, source: 'request' },
          jobId: 'job-1',
          correlationId: CORRELATION,
          metadata: {},
        },
        variables: { topic: 'espresso' },
      }),
    );
    execution = loadStep(execution);
    execution = preparePrompt(execution, createPromptCatalogue([TEMPLATE]));
    execution = buildRequest(execution);
    execution = awaitExecution(execution);

    const prepared = execution.state.prepared;
    if (prepared === null) throw new Error('the runtime prepared no request');
    const built: AIRequest = prepared.request;

    // The runtime built a request the frozen provider abstraction accepts, and
    // it carries the model the ROUTER resolved — not the alias the caller sent.
    expect(validateAIRequest(built)).toEqual({ ok: true });
    expect(built.model).toBe(plan.model);
    expect(built.model).not.toBe('gpt-4o');
    expect(built.capability).toBe(plan.capability);
  });

  it('carries a provider model the registry can dispatch to', async () => {
    const calls = { executed: 0 };
    const { providers } = routerWith(calls);
    const plan = await planFor(calls);

    expect(providers.has(plan.providerId)).toBe(true);
    expect(providers.get(plan.providerId).capabilities).toContain(plan.capability);
    for (const fallback of plan.fallbacks) {
      expect(providers.has(fallback.providerId)).toBe(true);
    }
  });
});

// ── 4 · The contract, and the divergences ──────────────────────────────────

describe('the plan matches what the increment specifies', () => {
  it('carries provider, model, capability, execution mode and streaming mode', async () => {
    const plan = await planFor({ executed: 0 });
    for (const field of [
      'providerId',
      'model',
      'capability',
      'executionMode',
      'streamingMode',
    ] as const) {
      expect(plan[field], field).toBeTruthy();
    }
  });

  it('is deterministic for identical inputs', async () => {
    expect(await planFor({ executed: 0 })).toEqual(await planFor({ executed: 0 }));
  });

  it('is immutable through and through', async () => {
    const plan = await planFor({ executed: 0 });
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.fallbacks)).toBe(true);
    expect(() => {
      (plan as unknown as { providerId: string }).providerId = 'elsewhere';
    }).toThrow(TypeError);
  });

  it('declares exactly the four deterministic policies plus capability selection', () => {
    // No probabilistic routing, no weighting, no A/B: the list is the whole of
    // the decision space and it has no ties.
    expect([...ROUTING_POLICIES]).toEqual([
      'explicit',
      'workspace-default',
      'organization-default',
      'global-default',
      'capability',
    ]);
  });

  it('names every rejection it can produce', () => {
    expect([...ROUTING_REJECTION_CODES].sort()).toEqual([
      'CapabilityUnavailable',
      'ModelNotOnProvider',
      'NoRouteConfigured',
      'ProviderUnhealthy',
      'StreamingUnsupported',
      'UnknownModel',
      'UnknownProvider',
    ]);
  });

  it('uses the reason-code registry `model-router.md` defines', () => {
    // The spec's own names where the meaning matches, so a trace reads the way
    // the document describes it.
    for (const code of ROUTING_REASONS) {
      expect(code, code).toMatch(/^routing\.[a-z_]+$/);
    }
    expect([...ROUTING_REASONS]).toContain('routing.capability_filtered');
    expect([...ROUTING_REASONS]).toContain('routing.health_filtered');
  });

  it('implements none of the codes for features this increment excludes', () => {
    // Budget filtering, tier escalation and circuit state are out of scope, so
    // their codes are absent rather than stubbed — a code nothing can emit is a
    // trace field that reads as "never happens" when it means "never checked".
    for (const absent of [
      'routing.budget_filtered',
      'routing.escalated_low_confidence',
      'routing.tier_from_policy',
      'routing.floor_enforced',
    ]) {
      expect([...ROUTING_REASONS]).not.toContain(absent);
    }
  });
});

describe('divergences from `08-ai-platform/model-router.md`, on the record', () => {
  it('RECORDS: a plan names a provider, where the spec says identity stops here', () => {
    // Rule 2: "Provider identity never escapes this component. Upstream
    // receives `ModelHandle` only." This increment specifies an ExecutionPlan
    // containing provider and model, and the frozen `GatewayRequest` already
    // requires both from the caller, so provider identity is visible by design
    // here. Recorded rather than silently reconciled.
    return planFor({ executed: 0 }).then((plan) => {
      expect(plan.providerId).toBeTruthy();
      expect(plan).not.toHaveProperty('handle');
    });
  });

  it('RECORDS: tenant defaults name a provider, where the spec says tier only', () => {
    // Rule 6: "Tenant overrides express tier preference only; a workspace
    // cannot pin a provider or a vendor model", for a stated data-residency
    // reason. This increment specifies workspace and organization defaults that
    // name a provider. The shape satisfying both is a tier indirection inside
    // `policy.ts` and nothing else.
    const table = createRoutingTable({
      version: 'v1',
      workspaces: { [WS]: { providerId: 'anthropic' } },
    });
    expect(table.forWorkspace(WS)).toEqual({ providerId: 'anthropic' });
  });

  it('honours the residency concern where it can: no fallback off a caller pin', async () => {
    // The one place rule 6's reasoning is respected without contradicting the
    // increment — moving off a provider the CALLER named would send their data
    // to a vendor they did not pick.
    const calls = { executed: 0 };
    const result = await routerWith(calls).router.route({
      ...input,
      requestedProviderId: 'anthropic',
    });
    if (result.outcome !== 'routed') throw new Error('expected a plan');

    expect(result.plan.providerId).toBe('anthropic');
    expect(result.plan.fallbacks).toEqual([]);
  });

  it('records the policy version, as rule 4 requires', async () => {
    expect((await planFor({ executed: 0 })).policyVersion).toBe('routing-2026-07');
  });
});
