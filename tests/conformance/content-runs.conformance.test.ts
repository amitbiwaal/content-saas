/**
 * The content run orchestrator against everything it coordinates.
 *
 * ── What only this file can check ───────────────────────────────────────────
 *
 * 1. THE SEAM IS REAL. A workflow id becomes a resolved blueprint, a compiled
 *    runtime definition, a driven S2.4 execution, a routed request and a
 *    metered artifact — across seven components, none of which can see the
 *    whole path from inside itself.
 *
 * 2. NO PROVIDER IS INVOKED DIRECTLY. The orchestrator holds a sealed provider
 *    registry, and a complete run must leave every provider's `execute` at
 *    zero. Structural AND behavioural, because either alone can be argued with.
 *
 * 3. THE RUNTIME IS NOT BYPASSED. Every dispatched request carries the
 *    idempotency key the FROZEN runtime derives from (executionId, stepId), and
 *    validates against the frozen `AIRequest` contract. A request the
 *    orchestrator had assembled itself could not.
 *
 * 4. IT DUPLICATES NOTHING. Retry decisions come from the S2.6 engine, prices
 *    from the S2.5 recorder, provider choice from the S3.5 Router, template
 *    resolution from the S4.1 library, compilation from S4.2. A second copy of
 *    any of them is only visible structurally.
 *
 * 5. THE DEVIATIONS, recorded so they cannot be forgotten.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  createModelCatalogue,
  createOrchestrator,
  createPricingRegistry,
  createProviderRegistry,
  createRouter,
  createRoutingTable,
  createTemplateLibrary,
  createWorkflowRegistry,
  idempotencyKeyFor,
  RUN_FAILURE_CODES,
  RUN_STATUSES,
  TERMINAL_RUN_STATUSES,
  validateAIRequest,
  type ContentWorkflowDefinition,
  type ModelProvider,
  type PromptTemplate,
  type RunMetadata,
  type WorkflowStepDefinition,
} from '@contentos/ai';
import {
  PROVIDER_ERROR_CODES,
  ProviderError,
  type AIRequest,
  type AIResponse,
} from '@contentos/contracts';
import type { Principal } from '@contentos/security';
import { describe, expect, it } from 'vitest';

const ORG = '018f7a1e-0000-7000-8000-0000000000aa';
const WS = '018f7a1e-0000-7000-8000-0000000000bb';
const CORRELATION = '018f7a1e-0000-7000-8000-0000000000dd';
const NOW = new Date('2026-07-31T12:00:00.000Z');

const sourceOf = (relative: string): string =>
  readFileSync(
    fileURLToPath(new URL(`../../packages/ai/src/runs/${relative}`, import.meta.url)),
    'utf8',
  );

/** Source with comments stripped, so prose never satisfies a structural claim. */
const codeOf = (relative: string): string =>
  sourceOf(relative)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

// ── Fixtures ────────────────────────────────────────────────────────────────

const takesOutline = (id: string): boolean => id === 'writing.draft';

const template = (id: string): PromptTemplate => ({
  id,
  version: 4,
  taskType: id,
  status: 'active',
  parts: {
    system: 'You write.',
    user: takesOutline(id) ? 'Draft {{topic}} from {{outline}}.' : 'Outline {{topic}}.',
  },
  variables: [
    { name: 'topic', type: 'string', required: true, description: 'The subject.' },
    ...(takesOutline(id)
      ? [
          {
            name: 'outline',
            type: 'string' as const,
            required: false,
            description: 'The bound outline.',
          },
        ]
      : []),
  ],
  modelHints: { maxOutputTokens: 512, temperature: 0.2, determinismRequired: false },
  evalSetRef: `evals/${id}`,
  owner: 'content-platform',
  changelog: 'Initial.',
});

const TEMPLATE_IDS = ['planning.outline', 'writing.draft'] as const;
const TEMPLATES: readonly PromptTemplate[] = TEMPLATE_IDS.map(template);

const LIBRARY = createTemplateLibrary(
  TEMPLATE_IDS.map((id) => ({
    id,
    metadata: {
      title: id,
      description: `The ${id} prompt.`,
      owner: 'content-platform',
      visibility: 'public' as const,
      tags: [],
    },
    versions: [
      {
        prompt: template(id),
        semanticVersion: '1.0.0',
        compatibility: { capability: 'chat' as const, providers: null, models: null },
      },
    ],
  })),
);
LIBRARY.seal();

const step = (id: string, next: string | null, templateId: string): WorkflowStepDefinition => ({
  kind: 'prompt',
  id,
  description: `Render ${templateId}.`,
  templateRef: { id: templateId, selector: { kind: 'latest-stable' } },
  bindOutputTo: id,
  next,
});

const DEFINITION: ContentWorkflowDefinition = {
  id: 'article.draft',
  metadata: {
    title: 'Draft an article',
    description: 'Outline, then draft.',
    owner: 'content-platform',
    visibility: 'public',
    tags: ['article'],
  },
  versions: [
    {
      version: 2,
      semanticVersion: '1.1.0',
      status: 'active',
      capability: { capability: 'chat', executionMode: 'buffered' },
      entryStepId: 'outline',
      steps: [step('outline', 'draft', 'planning.outline'), step('draft', null, 'writing.draft')],
      changelog: 'Added the draft step.',
    },
  ],
};

const response = (request: AIRequest, content: string): AIResponse => ({
  idempotencyKey: request.idempotencyKey,
  providerId: 'openai',
  model: 'gpt-4o-2026-05-01',
  content,
  finishReason: 'stop',
  usage: {
    tokens: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
    tokensEstimated: false,
    cost: { currency: 'USD', amount: '0.000000' },
    latencyMs: 12,
  },
  providerMetadata: {},
});

/** A real provider that counts every direct call. Nothing may raise this. */
function counting(calls: { executed: number }): ModelProvider {
  return {
    providerId: 'openai',
    displayName: 'OpenAI',
    capabilities: ['chat'],
    health: () =>
      Promise.resolve({ status: 'healthy' as const, reportedAt: NOW.toISOString(), detail: null }),
    execute: (request: AIRequest) => {
      calls.executed += 1;
      return Promise.resolve(response(request, 'direct'));
    },
  };
}

const principal: Principal = {
  subjectId: '018f7a1e-0000-7000-8000-0000000000cc',
  kind: 'user',
  method: 'password',
  organizationId: ORG,
  workspaceId: WS,
  roles: ['editor'],
  permissions: ['article:execute'],
  authenticatedAt: NOW,
  mfaSatisfied: true,
  sessionId: null,
};

const METADATA: RunMetadata = {
  principal,
  organization: { organizationId: ORG, status: 'active' },
  workspace: { workspaceId: WS, organizationId: ORG, status: 'active' },
  correlationId: CORRELATION,
  idempotencyKey: 'run-idem-1',
};

interface Wiring {
  readonly dispatch?: (input: {
    request: AIRequest;
    plan: { providerId: string; model: string };
  }) => Promise<AIResponse>;
}

function wire(options: Wiring = {}) {
  const calls = { executed: 0 };
  const seen: AIRequest[] = [];

  const providers = createProviderRegistry();
  providers.register(counting(calls));
  providers.seal();

  const catalogue = createModelCatalogue([
    {
      canonical: 'writing.standard',
      providerId: 'openai',
      providerModel: 'gpt-4o-2026-05-01',
      aliases: ['gpt-4o'],
      capabilities: ['chat'],
    },
  ]);
  catalogue.seal();

  const pricing = createPricingRegistry({
    version: 'pricing-2026-07',
    prices: [
      {
        providerId: 'openai',
        model: 'gpt-4o-2026-05-01',
        currency: 'USD',
        inputPerMillion: '2.500000',
        outputPerMillion: '10.000000',
      },
    ],
  });
  pricing.seal();

  const workflows = createWorkflowRegistry([DEFINITION], { library: LIBRARY });
  workflows.seal();

  const orchestrator = createOrchestrator({
    workflows,
    templates: LIBRARY,
    providers,
    router: createRouter({
      providers,
      catalogue,
      table: createRoutingTable({ version: 'routing-2026-07', global: { providerId: 'openai' } }),
    }),
    executor: {
      dispatch: (input) => {
        seen.push(input.request);
        return (
          options.dispatch?.(input) ?? Promise.resolve(response(input.request, 'generated text'))
        );
      },
    },
    pricing,
    now: () => NOW,
    newRunId: () => 'run-1',
    delay: () => Promise.resolve(),
  });

  return { orchestrator, calls, seen };
}

const startOptions = {
  workflowId: 'article.draft',
  selector: { kind: 'latest-stable' as const },
  variables: { topic: 'multi-tenancy' },
  metadata: METADATA,
  model: 'gpt-4o',
  timeoutMs: 30_000,
  promptTemplates: TEMPLATES,
};

// ── 1 · The seam is real ────────────────────────────────────────────────────

describe('a workflow id becomes a metered artifact set', () => {
  it('runs the whole pipeline through the public surface', async () => {
    const { orchestrator } = wire();
    const result = await orchestrator.start(startOptions);

    expect(result.outcome).toBe('completed');
    expect(result.run.state.artifacts.map((artifact) => artifact.stepId)).toEqual([
      'outline',
      'draft',
    ]);
  });

  it('carries the provenance every layer contributed', async () => {
    const { orchestrator } = wire();
    const result = await orchestrator.start(startOptions);

    // S4.2's identity, S4.1's pinned template versions, S3.5's target, S2.5's
    // price — one artifact set that names all four.
    expect(result.run.workflowRef).toBe('article.draft@2');
    expect(result.run.templateVersions).toEqual(['planning.outline@4', 'writing.draft@4']);
    expect(result.run.state.artifacts[0]?.providerId).toBe('openai');
    expect(result.run.state.artifacts[0]?.metadata['chargeableAmount']).toBe('0.000225');
  });
});

// ── 2 · No provider is invoked directly ─────────────────────────────────────

describe('the orchestrator never invokes a provider', () => {
  it('leaves every provider in its own registry uncalled', async () => {
    const { orchestrator, calls } = wire();
    await orchestrator.start(startOptions);

    expect(calls.executed).toBe(0);
  });

  it('has no call to a provider in its source at all', () => {
    // The port's method is `dispatch` precisely so this claim is checkable:
    // a provider is invoked through `.execute(`, and there is none here.
    expect(codeOf('orchestrator.ts')).not.toMatch(/\.execute\s*\(/);
  });

  it('imports no provider adapter or model SDK (ADR-019)', () => {
    const code = codeOf('orchestrator.ts');
    expect(code).not.toMatch(/from '\.\.\/providers\/(openai|anthropic|adapters)/);
    expect(code).not.toMatch(/from '(openai|@anthropic-ai\/sdk|@google\/generative-ai)'/);
  });
});

// ── 3 · The runtime is not bypassed ─────────────────────────────────────────

describe('every dispatched request came from the frozen runtime', () => {
  it('carries the key the runtime derives from (executionId, stepId)', async () => {
    const { orchestrator, seen } = wire();
    await orchestrator.start(startOptions);

    expect(seen.map((request) => request.idempotencyKey)).toEqual([
      idempotencyKeyFor('run-idem-1', 'outline'),
      idempotencyKeyFor('run-idem-1', 'draft'),
    ]);
  });

  it('validates against the frozen AIRequest contract', async () => {
    const { orchestrator, seen } = wire();
    await orchestrator.start(startOptions);

    for (const request of seen) expect(validateAIRequest(request)).toEqual({ ok: true });
  });

  it('carries the caller tenancy on every request (ADR-017)', async () => {
    const { orchestrator, seen } = wire();
    await orchestrator.start(startOptions);

    for (const request of seen) {
      expect(request.tenantId).toBe(WS);
      expect(request.organizationId).toBe(ORG);
      expect(request.correlationId).toBe(CORRELATION);
    }
  });

  it('drives the runtime in its own declared order', () => {
    const code = codeOf('orchestrator.ts');
    const order = ['loadStep(', 'preparePrompt(', 'buildRequest(', 'awaitExecution('].map((call) =>
      code.indexOf(call),
    );
    expect(order.every((index) => index > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(code.indexOf('recordExecution(')).toBeGreaterThan(order[order.length - 1] as number);
  });
});

// ── 4 · It duplicates nothing ───────────────────────────────────────────────

describe('the orchestrator coordinates and implements nothing', () => {
  it('asks the retry engine rather than computing a backoff', () => {
    const code = codeOf('orchestrator.ts');
    expect(code).toMatch(/decideRetry\(/);
    // The engine owns the arithmetic; a second copy would be a second policy.
    expect(code).not.toMatch(/Math\.pow|\*\*\s*attempt|jitter/i);
  });

  it('asks the usage recorder rather than pricing anything', () => {
    const code = codeOf('orchestrator.ts');
    expect(code).toMatch(/recordResponseUsage\(/);
    expect(code).not.toMatch(/perMillion|BigInt\(|parseDecimal/);
  });

  it('asks the Router rather than choosing a provider', () => {
    const code = codeOf('orchestrator.ts');
    expect(code).toMatch(/router\.route\(/);
    // No provider selection, no fallback walking — the plan is consumed whole.
    expect(code).not.toMatch(/fallbacks\[|health\(\)|providers\.get\(/);
  });

  it('compiles through S4.2 rather than assembling a definition', () => {
    const code = codeOf('orchestrator.ts');
    expect(code).toMatch(/toRuntimeDefinition\(/);
    expect(code).toMatch(/resolveWorkflow\(/);
  });

  it('resolves templates only through the compiler, which uses the S4.1 library', () => {
    // A second resolution pass here would be a second opinion that could
    // disagree with the one that produced the pinned versions.
    expect(codeOf('orchestrator.ts')).not.toMatch(/resolveTemplate\(/);
  });
});

describe('the orchestrator owns no clock and no random source', () => {
  it('reads no clock', () => {
    const code = codeOf('orchestrator.ts');
    expect(code).not.toMatch(/Date\.now\(/);
    expect(code).not.toMatch(/new Date\(\)/);
  });

  it('generates nothing', () => {
    const code = codeOf('orchestrator.ts');
    expect(code).not.toMatch(/Math\.random\(|randomUUID|crypto\./);
  });

  it('starts no timer of its own', () => {
    expect(codeOf('orchestrator.ts')).not.toMatch(/setTimeout\(|setInterval\(/);
  });

  it('produces the same run twice from the same inputs', async () => {
    const first = await wire().orchestrator.start(startOptions);
    const second = await wire().orchestrator.start(startOptions);

    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });
});

// ── Artifacts are returned, never stored ────────────────────────────────────

describe('artifacts are returned and nothing else', () => {
  it('has no persistence anywhere in the run module', () => {
    for (const file of ['orchestrator.ts', 'run.ts', 'state.ts']) {
      const code = codeOf(file);
      expect(code).not.toMatch(/@contentos\/database/);
      expect(code).not.toMatch(/repository|persist\(|\.save\(|INSERT INTO/i);
    }
  });

  it('emits no event and enqueues no job', () => {
    // Out of scope, and both would be a side effect a caller cannot see.
    const code = codeOf('orchestrator.ts');
    expect(code).not.toMatch(/@contentos\/events|publish\(|enqueue\(/);
  });

  it('returns a run frozen through, so a held result cannot drift', async () => {
    const { orchestrator } = wire();
    const result = await orchestrator.start(startOptions);

    expect(Object.isFrozen(result.run.state.artifacts[0])).toBe(true);
    expect(() => {
      (result.run.state.artifacts as { length: number }).length = 0;
    }).toThrow();
  });
});

// ── The vocabularies ────────────────────────────────────────────────────────

describe('the run vocabulary', () => {
  it('is the state machine the increment specifies', () => {
    expect([...RUN_STATUSES]).toEqual([
      'created',
      'compiling',
      'ready',
      'running',
      'completed',
      'failed',
      'cancelled',
    ]);
    expect([...TERMINAL_RUN_STATUSES]).toEqual(['completed', 'failed', 'cancelled']);
  });

  it('covers every failure the increment enumerates', () => {
    for (const code of [
      'WorkflowUnresolved',
      'TemplateUnresolved',
      'CompilationFailed',
      'RuntimeFailed',
      'ExecutionFailed',
      'Cancelled',
      'Timeout',
    ]) {
      expect(RUN_FAILURE_CODES).toContain(code);
    }
  });

  it('reuses the frozen provider taxonomy rather than restating it', async () => {
    // The run codes describe RUN stages; the provider codes describe one call.
    // Restating the call-level ones here would be a second taxonomy to keep in
    // step, so none of them appears. (`Timeout` is in both and means different
    // things: a provider call that timed out, and a run that spent its budget.)
    for (const code of PROVIDER_ERROR_CODES) {
      if (code === 'Timeout') continue;
      expect(RUN_FAILURE_CODES).not.toContain(code);
    }

    // What a provider failure contributes is its own code, carried through.
    const { orchestrator } = wire({
      dispatch: () =>
        Promise.reject(new ProviderError('ContentFiltered', 'openai', 'Refused by the filter.')),
    });
    const filtered = await orchestrator.start(startOptions);
    expect(filtered.outcome).toBe('failed');
    if (filtered.outcome !== 'failed') return;
    expect(filtered.code).toBe('ExecutionFailed');
    expect(filtered.providerCode).toBe('ContentFiltered');
    expect(PROVIDER_ERROR_CODES).toContain(filtered.providerCode);
  });

  it('never invents a provider code for a failure that is not a provider one', async () => {
    const { orchestrator } = wire({
      dispatch: () => Promise.reject(new Error('the executor itself is broken')),
    });
    const result = await orchestrator.start(startOptions);

    expect(result.outcome).toBe('failed');
    if (result.outcome !== 'failed') return;
    expect(result.providerCode).toBeNull();
  });
});

// ── 5 · Deviations ──────────────────────────────────────────────────────────

describe('recorded deviations', () => {
  it('DEVIATION: a failed run is a VALUE, not a thrown error', () => {
    // The increment says "return canonical failures". Every refusal here is an
    // outcome on `ContentRunResult`, matching admission (S3.1) and routing
    // (S3.5): a caller that must catch to discover a refusal will eventually
    // forget, and a compilation failure is an answer, not an exception.
    expect(RUN_FAILURE_CODES.length).toBeGreaterThan(0);
    expect(codeOf('orchestrator.ts')).toMatch(/outcome: 'failed'/);
  });

  it('DEVIATION: a streaming blueprint is refused, not served buffered', () => {
    // Assembling a stream into a complete artifact needs a streaming executor
    // port and the S2.7 assembler, which belong to a later increment. Refusing
    // is stated: a caller that asked to stream and received one response at the
    // end has had its latency budget spent without being told.
    expect(RUN_FAILURE_CODES).toContain('StreamingUnsupported');
    expect(codeOf('orchestrator.ts')).toMatch(/StreamingUnsupported/);
  });

  it('DEVIATION: the provider call arrives through an injected port', () => {
    // The frozen S2.4 runtime PREPARES requests and records responses; it does
    // not execute. "Invoke the Workflow Runtime" is honoured literally — the
    // runtime drives every step — and the one thing a pure state machine cannot
    // do is supplied by `RunExecutor.dispatch`, deliberately not named
    // `execute` so that "no provider is invoked here" stays checkable.
    expect(codeOf('orchestrator.ts')).toMatch(/executor\.dispatch\(/);
  });

  it('DEVIATION: run statuses are lower-case', () => {
    // The increment writes CREATED → COMPILING → READY → RUNNING. The values
    // are lower-case, matching every other status vocabulary in the codebase
    // (job, workflow, retry); the machine is the one specified.
    expect(RUN_STATUSES.every((status) => status === status.toLowerCase())).toBe(true);
  });

  it('DEVIATION: the run deadline is optional and checked between steps', () => {
    // `Timeout` is in the taxonomy the increment asks for; per-step timeouts
    // are the runtime's and reach the provider on the request. A whole-run
    // budget is enforced here, between steps, because nothing in this layer can
    // interrupt a dispatch already in flight.
    expect(RUN_FAILURE_CODES).toContain('Timeout');
    expect(codeOf('orchestrator.ts')).toMatch(/runTimeoutMs/);
  });
});
