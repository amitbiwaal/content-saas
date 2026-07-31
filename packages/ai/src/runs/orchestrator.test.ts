import { ProviderError, type AIRequest, type AIResponse } from '@contentos/contracts';
import type { Principal } from '@contentos/security';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createWorkflowRegistry, type ContentWorkflowDefinition } from '../blueprints/registry.js';
import type { WorkflowMetadata, WorkflowStepDefinition } from '../blueprints/steps.js';
import type { AdmissionOrganization, AdmissionWorkspace } from '../gateway/ports.js';
import type { PromptTemplate } from '../prompts/template.js';
import type * as WorkflowEngine from '../workflow/engine.js';
import type { ModelProvider } from '../providers/provider.js';
import { createProviderRegistry } from '../providers/registry.js';
import { createModelCatalogue, type ModelEntry } from '../routing/catalogue.js';
import { createRoutingTable } from '../routing/policy.js';
import { createRouter, type Router } from '../routing/router.js';
import { createTemplateLibrary, type TemplateLibrary } from '../templates/library.js';
import { createPricingRegistry } from '../usage/pricing.js';
import { idempotencyKeyFor } from '../workflow/engine.js';
import {
  createOrchestrator,
  type OrchestratorOptions,
  type RunExecutor,
  type StartRunOptions,
} from './orchestrator.js';
import type { RunMetadata } from './run.js';

/**
 * A pass-through counter over the FROZEN runtime.
 *
 * Wrapping rather than replacing: every test below runs the real S2.4 engine,
 * and the mock exists only so "the Workflow Runtime is invoked exactly once"
 * is a number a test can read rather than a claim.
 */
const runtime = vi.hoisted(() => ({ created: 0, started: 0, recorded: 0 }));

vi.mock('../workflow/engine.js', async (importOriginal) => {
  const actual = await importOriginal<typeof WorkflowEngine>();
  return {
    ...actual,
    createWorkflowExecution: (...args: Parameters<typeof actual.createWorkflowExecution>) => {
      runtime.created += 1;
      return actual.createWorkflowExecution(...args);
    },
    start: (...args: Parameters<typeof actual.start>) => {
      runtime.started += 1;
      return actual.start(...args);
    },
    recordExecution: (...args: Parameters<typeof actual.recordExecution>) => {
      runtime.recorded += 1;
      return actual.recordExecution(...args);
    },
  };
});

const NOW = new Date('2026-07-31T12:00:00.000Z');
const ORG = '11111111-1111-4111-8111-111111111111';
const WS = '22222222-2222-4222-8222-222222222222';
const CORRELATION = '33333333-3333-4333-8333-333333333333';

// ── Templates ───────────────────────────────────────────────────────────────

const CAPABILITY_OF: Readonly<Record<string, 'chat' | 'text'>> = {
  'planning.outline': 'chat',
  'writing.draft': 'chat',
  'review.scores': 'text',
};

/**
 * `writing.draft` also takes `outline`, because the step before it binds one.
 *
 * The runtime refuses a variable a template never declared — the check that
 * makes a mis-wired blueprint visible instead of silently degrading quality —
 * so the fixture has to be wired the way a real blueprint would be.
 */
const takesOutline = (id: string): boolean => id === 'writing.draft';

const template = (id: string): PromptTemplate => ({
  id,
  version: 4,
  taskType: id,
  status: 'active',
  parts: {
    system: 'S',
    user: takesOutline(id) ? `U for ${id}: {{topic}} from {{outline}}` : `U for ${id}: {{topic}}`,
  },
  variables: [
    { name: 'topic', type: 'string', required: true, description: 'The subject.' },
    ...(takesOutline(id)
      ? [
          {
            name: 'outline',
            type: 'string' as const,
            required: false,
            description: 'The outline the previous step produced.',
          },
        ]
      : []),
  ],
  modelHints: { maxOutputTokens: 512, temperature: 0.2, determinismRequired: false },
  evalSetRef: `evals/${id}`,
  owner: 'content-platform',
  changelog: 'Initial.',
});

const TEMPLATES: readonly PromptTemplate[] = Object.keys(CAPABILITY_OF).map(template);

function libraryOf(ids: readonly string[] = Object.keys(CAPABILITY_OF)): TemplateLibrary {
  const library = createTemplateLibrary(
    ids.map((id) => ({
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
          compatibility: {
            capability: CAPABILITY_OF[id] as 'chat' | 'text',
            providers: null,
            models: null,
          },
        },
      ],
    })),
  );
  library.seal();
  return library;
}

const LIBRARY = libraryOf();

// ── Blueprints ──────────────────────────────────────────────────────────────

const workflowMetadata: WorkflowMetadata = {
  title: 'Draft an article',
  description: 'Outline, then draft.',
  owner: 'content-platform',
  visibility: 'public',
  tags: ['article'],
};

const promptStep = (
  id: string,
  next: string | null,
  templateId: string,
): WorkflowStepDefinition => ({
  kind: 'prompt',
  id,
  description: `Render ${templateId}.`,
  templateRef: { id: templateId, selector: { kind: 'latest-stable' } },
  bindOutputTo: id.replace(/-/g, '_'),
  next,
});

const LINEAR: readonly WorkflowStepDefinition[] = [
  promptStep('outline', 'draft', 'planning.outline'),
  promptStep('draft', null, 'writing.draft'),
];

const articleDraft: ContentWorkflowDefinition = {
  id: 'article.draft',
  metadata: workflowMetadata,
  versions: [
    {
      version: 1,
      semanticVersion: '1.0.0',
      status: 'active',
      capability: { capability: 'chat', executionMode: 'buffered' },
      entryStepId: 'outline',
      steps: LINEAR,
      changelog: 'Initial version.',
    },
  ],
};

const articleStream: ContentWorkflowDefinition = {
  id: 'article.stream',
  metadata: workflowMetadata,
  versions: [
    {
      version: 1,
      semanticVersion: '1.0.0',
      status: 'active',
      capability: { capability: 'chat', executionMode: 'streaming' },
      entryStepId: 'outline',
      steps: [promptStep('outline', null, 'planning.outline')],
      changelog: 'Initial version.',
    },
  ],
};

/** A graph. Valid as a blueprint; the linear runtime cannot walk it. */
const articleBranching: ContentWorkflowDefinition = {
  id: 'article.branching',
  metadata: workflowMetadata,
  versions: [
    {
      version: 1,
      semanticVersion: '1.0.0',
      status: 'active',
      capability: { capability: 'chat', executionMode: 'buffered' },
      entryStepId: 'choose',
      steps: [
        {
          kind: 'branch',
          id: 'choose',
          description: 'Pick a path.',
          cases: [{ when: 'long', next: 'outline' }],
          otherwise: 'draft',
        },
        promptStep('outline', null, 'planning.outline'),
        promptStep('draft', null, 'writing.draft'),
      ],
      changelog: 'Initial version.',
    },
  ],
};

/** References a template the library will not have at compile time. */
const articleGhost: ContentWorkflowDefinition = {
  id: 'article.ghost',
  metadata: workflowMetadata,
  versions: [
    {
      version: 1,
      semanticVersion: '1.0.0',
      status: 'active',
      capability: { capability: 'chat', executionMode: 'buffered' },
      entryStepId: 'outline',
      steps: [promptStep('outline', null, 'nothing.here')],
      changelog: 'Initial version.',
    },
  ],
};

// ── Providers, routing, pricing ─────────────────────────────────────────────

const RESPONSE = (request: AIRequest, content: string): AIResponse => ({
  idempotencyKey: request.idempotencyKey,
  providerId: 'openai',
  model: 'gpt-4o-2026-05-01',
  content,
  finishReason: 'stop',
  usage: {
    tokens: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
    tokensEstimated: false,
    cost: { currency: 'USD', amount: '0.000000' },
    latencyMs: 5,
  },
  providerMetadata: {},
});

/** Counts every direct provider call. Nothing in a run may raise this. */
const providerCalls = { executed: 0 };

function provider(providerId: string): ModelProvider {
  return {
    providerId,
    displayName: providerId,
    capabilities: ['chat', 'text'],
    health: () =>
      Promise.resolve({ status: 'healthy' as const, reportedAt: NOW.toISOString(), detail: null }),
    execute: (request: AIRequest) => {
      providerCalls.executed += 1;
      return Promise.resolve(RESPONSE(request, 'direct'));
    },
  };
}

const ENTRIES: readonly ModelEntry[] = [
  {
    canonical: 'writing.standard',
    providerId: 'openai',
    providerModel: 'gpt-4o-2026-05-01',
    aliases: ['gpt-4o'],
    capabilities: ['chat', 'text'],
  },
];

function providersAndRouter(): {
  providers: ReturnType<typeof createProviderRegistry>;
  router: Router;
} {
  const registry = createProviderRegistry();
  registry.register(provider('openai'));
  registry.seal();

  const catalogue = createModelCatalogue([...ENTRIES]);
  catalogue.seal();

  return {
    providers: registry,
    router: createRouter({
      providers: registry,
      catalogue,
      table: createRoutingTable({ version: 'routing-2026-07', global: { providerId: 'openai' } }),
    }),
  };
}

const PRICING = createPricingRegistry({
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
PRICING.seal();

// ── Identity ────────────────────────────────────────────────────────────────

const principal: Principal = {
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
};

const organization: AdmissionOrganization = { organizationId: ORG, status: 'active' };
const workspace: AdmissionWorkspace = {
  workspaceId: WS,
  organizationId: ORG,
  status: 'active',
};

const metadata: RunMetadata = {
  principal,
  organization,
  workspace,
  correlationId: CORRELATION,
  idempotencyKey: 'idem-run-1',
};

// ── Harness ─────────────────────────────────────────────────────────────────

interface Recorded {
  readonly request: AIRequest;
  readonly providerId: string;
  readonly model: string;
}

interface Harness {
  readonly definitions?: readonly ContentWorkflowDefinition[];
  readonly library?: TemplateLibrary;
  /** Registered WITHOUT a library, so template refs are checked at compile. */
  readonly unchecked?: boolean;
  readonly dispatch?: RunExecutor['dispatch'];
  readonly router?: Router;
  readonly clock?: () => Date;
  readonly delays?: number[];
}

function harnessFor(harness: Harness = {}) {
  const dispatched: Recorded[] = [];
  const delays = harness.delays ?? [];
  const wired = providersAndRouter();

  const workflows = createWorkflowRegistry(
    [...(harness.definitions ?? [articleDraft, articleStream, articleBranching])],
    harness.unchecked === true ? {} : { library: harness.library ?? LIBRARY },
  );

  const executor: RunExecutor = {
    dispatch:
      harness.dispatch ??
      (({ request, plan }) => {
        dispatched.push({ request, providerId: plan.providerId, model: plan.model });
        return Promise.resolve(RESPONSE(request, `content for ${request.taskType}`));
      }),
  };

  const options: OrchestratorOptions = {
    workflows,
    templates: harness.library ?? LIBRARY,
    providers: wired.providers,
    router: harness.router ?? wired.router,
    executor,
    pricing: PRICING,
    now: harness.clock ?? (() => NOW),
    newRunId: () => 'run-1',
    delay: (ms: number) => {
      delays.push(ms);
      return Promise.resolve();
    },
  };

  return { orchestrator: createOrchestrator(options), dispatched, delays, workflows };
}

const start = (overrides: Partial<StartRunOptions> = {}): StartRunOptions => ({
  workflowId: 'article.draft',
  selector: { kind: 'latest-stable' },
  variables: { topic: 'tenancy' },
  metadata,
  model: 'gpt-4o',
  timeoutMs: 30_000,
  promptTemplates: TEMPLATES,
  ...overrides,
});

beforeEach(() => {
  runtime.created = 0;
  runtime.started = 0;
  runtime.recorded = 0;
  providerCalls.executed = 0;
});

// ── The pipeline ────────────────────────────────────────────────────────────

describe('a complete run', () => {
  it('completes, and reaches COMPLETED', async () => {
    const { orchestrator } = harnessFor();
    const result = await orchestrator.start(start());

    expect(result.outcome).toBe('completed');
    expect(result.run.state.status).toBe('completed');
  });

  it('records the workflow it ran, by identity and by version', async () => {
    const { orchestrator } = harnessFor();
    const result = await orchestrator.start(start());

    expect(result.run.workflowId).toBe('article.draft');
    expect(result.run.workflowVersion).toBe(1);
    expect(result.run.workflowRef).toBe('article.draft@1');
    expect(result.run.capability).toBe('chat');
  });

  it('pins every template version at compile time', async () => {
    // A promotion mid-flight cannot change what a started run is doing.
    const { orchestrator } = harnessFor();
    const result = await orchestrator.start(start());

    expect(result.run.templateVersions).toEqual(['planning.outline@4', 'writing.draft@4']);
  });

  it('carries the identity it was given, unaltered', async () => {
    const { orchestrator } = harnessFor();
    const result = await orchestrator.start(start());

    expect(result.run.metadata.principal.subjectId).toBe('user-1');
    expect(result.run.metadata.organization.organizationId).toBe(ORG);
    expect(result.run.metadata.workspace.workspaceId).toBe(WS);
    expect(result.run.metadata.correlationId).toBe(CORRELATION);
  });

  it('stamps every timing from the injected clock', async () => {
    const { orchestrator } = harnessFor();
    const { timings } = (await orchestrator.start(start())).run.state;

    expect(timings.createdAt).toBe(NOW.toISOString());
    expect(timings.compiledAt).toBe(NOW.toISOString());
    expect(timings.startedAt).toBe(NOW.toISOString());
    expect(timings.finishedAt).toBe(NOW.toISOString());
  });

  it('returns a run that is frozen through', async () => {
    const { orchestrator } = harnessFor();
    const result = await orchestrator.start(start());

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.run)).toBe(true);
    expect(Object.isFrozen(result.run.state.artifacts)).toBe(true);
    expect(Object.isFrozen(result.run.state.artifacts[0])).toBe(true);
  });
});

describe('the Workflow Runtime', () => {
  it('is invoked exactly once for a run', async () => {
    const { orchestrator } = harnessFor();
    await orchestrator.start(start());

    expect(runtime.created).toBe(1);
    expect(runtime.started).toBe(1);
  });

  it('records exactly one execution per step', async () => {
    const { orchestrator } = harnessFor();
    await orchestrator.start(start());

    expect(runtime.recorded).toBe(2);
  });

  it('builds every dispatched request itself', async () => {
    // The idempotency key is derived by the runtime from (executionId, stepId).
    // A request the orchestrator had assembled could not carry these.
    const { orchestrator, dispatched } = harnessFor();
    await orchestrator.start(start());

    expect(dispatched.map((entry) => entry.request.idempotencyKey)).toEqual([
      idempotencyKeyFor('idem-run-1', 'outline'),
      idempotencyKeyFor('idem-run-1', 'draft'),
    ]);
  });

  it('keys the execution on the request, so two orchestrations address one call', async () => {
    const { orchestrator } = harnessFor();
    const first = await orchestrator.start(start());
    const second = await orchestrator.start(start());

    expect(first.run.state.executionId).toBe('idem-run-1');
    expect(second.run.state.executionId).toBe(first.run.state.executionId);
  });
});

describe('provider invocation', () => {
  it('never calls a provider directly', async () => {
    // The registry the orchestrator holds contains a provider that counts its
    // own calls. A complete run must leave that count at zero.
    const { orchestrator } = harnessFor();
    const result = await orchestrator.start(start());

    expect(result.outcome).toBe('completed');
    expect(providerCalls.executed).toBe(0);
  });

  it('dispatches through the port, once per step', async () => {
    const { orchestrator, dispatched } = harnessFor();
    await orchestrator.start(start());

    expect(dispatched).toHaveLength(2);
  });
});

describe('routing', () => {
  it('routes every step, and hands the executor the resolved target', async () => {
    const { orchestrator, dispatched } = harnessFor();
    await orchestrator.start(start());

    for (const entry of dispatched) {
      expect(entry.providerId).toBe('openai');
      // The VENDOR model, resolved from the alias the caller asked for.
      expect(entry.model).toBe('gpt-4o-2026-05-01');
    }
  });

  it('fails the run when routing refuses', async () => {
    const refusing: Router = {
      route: () =>
        Promise.resolve({
          outcome: 'refused' as const,
          code: 'ProviderUnhealthy' as const,
          reason: 'openai is unhealthy.',
          reasons: [],
        }),
    };
    const { orchestrator } = harnessFor({ router: refusing });
    const result = await orchestrator.start(start());

    expect(result.outcome).toBe('failed');
    if (result.outcome !== 'failed') return;
    expect(result.code).toBe('ExecutionFailed');
    expect(result.run.state.status).toBe('failed');
  });
});

// ── Artifacts ───────────────────────────────────────────────────────────────

describe('artifact collection', () => {
  it('produces one artifact per step, in step order', async () => {
    const { orchestrator } = harnessFor();
    const { artifacts } = (await orchestrator.start(start())).run.state;

    expect(artifacts.map((artifact) => artifact.stepId)).toEqual(['outline', 'draft']);
  });

  it('carries the generated text', async () => {
    const { orchestrator } = harnessFor();
    const { artifacts } = (await orchestrator.start(start())).run.state;

    expect(artifacts[0]?.content).toBe('content for planning.outline');
    expect(artifacts[1]?.content).toBe('content for writing.draft');
  });

  it('carries token usage', async () => {
    const { orchestrator } = harnessFor();
    const { artifacts } = (await orchestrator.start(start())).run.state;

    expect(artifacts[0]?.tokens).toEqual({
      promptTokens: 10,
      completionTokens: 20,
      totalTokens: 30,
    });
    expect(artifacts[0]?.usage.latencyMs).toBe(5);
  });

  it('carries the provider and model that ACTUALLY ran', async () => {
    const { orchestrator } = harnessFor({
      dispatch: ({ request }) =>
        // A fallback answered: the response names a provider the plan did not.
        Promise.resolve({ ...RESPONSE(request, 'from anthropic'), providerId: 'anthropic' }),
    });
    const { artifacts } = (await orchestrator.start(start())).run.state;

    expect(artifacts[0]?.providerId).toBe('anthropic');
    expect(artifacts[0]?.metadata['plannedProviderId']).toBe('openai');
  });

  it('carries the prompt version, so an artifact stays explainable', async () => {
    const { orchestrator } = harnessFor();
    const { artifacts } = (await orchestrator.start(start())).run.state;

    expect(artifacts[0]?.promptVersion).toBe('planning.outline@4');
    expect(artifacts[1]?.promptVersion).toBe('writing.draft@4');
  });

  it('meters each artifact through the frozen recorder', async () => {
    const { orchestrator } = harnessFor();
    const { artifacts } = (await orchestrator.start(start())).run.state;

    // 10 in at 2.50/M plus 20 out at 10.00/M.
    expect(artifacts[0]?.metadata['chargeableAmount']).toBe('0.000225');
    expect(artifacts[0]?.metadata['meteringError']).toBeNull();
  });

  it('persists nothing', async () => {
    // Structural, not behavioural: the module has no writer to call. The
    // artifacts exist in the result and nowhere else.
    const { orchestrator } = harnessFor();
    const result = await orchestrator.start(start());

    expect(result.run.state.artifacts).toHaveLength(2);
  });
});

// ── Refusals ────────────────────────────────────────────────────────────────

describe('workflow resolution', () => {
  it('fails with WorkflowUnresolved for an unknown workflow', async () => {
    const { orchestrator } = harnessFor();
    const result = await orchestrator.start(start({ workflowId: 'article.nothing' }));

    expect(result.outcome).toBe('failed');
    if (result.outcome !== 'failed') return;
    expect(result.code).toBe('WorkflowUnresolved');
  });

  it('fails with WorkflowUnresolved for an unknown version', async () => {
    const { orchestrator } = harnessFor();
    const result = await orchestrator.start(start({ selector: { kind: 'explicit', version: 99 } }));

    expect(result.outcome).toBe('failed');
    if (result.outcome !== 'failed') return;
    expect(result.code).toBe('WorkflowUnresolved');
  });

  it('rejects an incompatible capability', async () => {
    const { orchestrator } = harnessFor();
    const result = await orchestrator.start(start({ capability: 'image' }));

    expect(result.outcome).toBe('failed');
    if (result.outcome !== 'failed') return;
    expect(result.code).toBe('WorkflowUnresolved');
    expect(result.reason).toMatch(/image/);
  });

  it('never invokes the runtime for a workflow it could not resolve', async () => {
    const { orchestrator } = harnessFor();
    await orchestrator.start(start({ workflowId: 'article.nothing' }));

    expect(runtime.created).toBe(0);
  });
});

describe('compilation', () => {
  it('fails with CompilationFailed for a blueprint the linear runtime cannot walk', async () => {
    const { orchestrator } = harnessFor();
    const result = await orchestrator.start(start({ workflowId: 'article.branching' }));

    expect(result.outcome).toBe('failed');
    if (result.outcome !== 'failed') return;
    expect(result.code).toBe('CompilationFailed');
    expect(result.run.state.status).toBe('failed');
  });

  it('fails with TemplateUnresolved when a step names a template the library lacks', async () => {
    const { orchestrator } = harnessFor({
      definitions: [articleGhost],
      unchecked: true,
    });
    const result = await orchestrator.start(start({ workflowId: 'article.ghost' }));

    expect(result.outcome).toBe('failed');
    if (result.outcome !== 'failed') return;
    expect(result.code).toBe('TemplateUnresolved');
  });

  it('refuses a streaming blueprint rather than serving it buffered', async () => {
    const { orchestrator } = harnessFor();
    const result = await orchestrator.start(start({ workflowId: 'article.stream' }));

    expect(result.outcome).toBe('failed');
    if (result.outcome !== 'failed') return;
    expect(result.code).toBe('StreamingUnsupported');
  });

  it('never invokes the runtime for a blueprint that did not compile', async () => {
    const { orchestrator } = harnessFor();
    await orchestrator.start(start({ workflowId: 'article.branching' }));

    expect(runtime.created).toBe(0);
    expect(providerCalls.executed).toBe(0);
  });
});

// ── Execution failures ──────────────────────────────────────────────────────

describe('execution failure', () => {
  it('fails with ExecutionFailed, naming the provider code', async () => {
    const { orchestrator } = harnessFor({
      dispatch: () =>
        Promise.reject(new ProviderError('Validation', 'openai', 'The request was malformed.')),
    });
    const result = await orchestrator.start(start());

    expect(result.outcome).toBe('failed');
    if (result.outcome !== 'failed') return;
    expect(result.code).toBe('ExecutionFailed');
    expect(result.providerCode).toBe('Validation');
  });

  it('keeps the artifacts the run had already produced', async () => {
    // Work that completed before a later step failed was paid for.
    let call = 0;
    const { orchestrator } = harnessFor({
      dispatch: ({ request }) => {
        call += 1;
        return call === 1
          ? Promise.resolve(RESPONSE(request, 'the outline'))
          : Promise.reject(new ProviderError('Validation', 'openai', 'Malformed.'));
      },
    });
    const result = await orchestrator.start(start());

    expect(result.outcome).toBe('failed');
    expect(result.run.state.artifacts).toHaveLength(1);
    expect(result.run.state.artifacts[0]?.stepId).toBe('outline');
  });

  it('does not classify a non-provider failure as a provider one', async () => {
    const { orchestrator } = harnessFor({
      dispatch: () => Promise.reject(new Error('the executor itself is broken')),
    });
    const result = await orchestrator.start(start());

    expect(result.outcome).toBe('failed');
    if (result.outcome !== 'failed') return;
    expect(result.providerCode).toBeNull();
  });
});

describe('retry', () => {
  it('re-dispatches a retryable failure and records the attempt count', async () => {
    let call = 0;
    const { orchestrator, delays } = harnessFor({
      dispatch: ({ request }) => {
        call += 1;
        return call === 1
          ? Promise.reject(new ProviderError('RateLimit', 'openai', 'Slow down.'))
          : Promise.resolve(RESPONSE(request, 'content for planning.outline'));
      },
    });
    const result = await orchestrator.start(start());

    expect(result.outcome).toBe('completed');
    expect(result.run.state.artifacts[0]?.attempts).toBe(2);
    expect(delays.length).toBeGreaterThan(0);
  });

  it('never retries a failure the taxonomy calls permanent', async () => {
    let call = 0;
    const { orchestrator, delays } = harnessFor({
      dispatch: () => {
        call += 1;
        return Promise.reject(new ProviderError('Validation', 'openai', 'Malformed.'));
      },
    });
    await orchestrator.start(start());

    expect(call).toBe(1);
    expect(delays).toEqual([]);
  });

  it('waits only through the injected delay, never a real timer', async () => {
    let call = 0;
    const { orchestrator, delays } = harnessFor({
      dispatch: ({ request }) => {
        call += 1;
        return call === 1
          ? Promise.reject(new ProviderError('Unavailable', 'openai', 'Down.'))
          : Promise.resolve(RESPONSE(request, 'ok'));
      },
    });
    await orchestrator.start(start());

    expect(delays.every((ms) => typeof ms === 'number' && ms >= 0)).toBe(true);
  });
});

// ── Cancellation and timeout ────────────────────────────────────────────────

describe('cancellation', () => {
  it('reaches CANCELLED and reports Cancelled', async () => {
    const { orchestrator } = harnessFor();
    const result = await orchestrator.start(start({ signal: { cancelled: () => true } }));

    expect(result.outcome).toBe('failed');
    if (result.outcome !== 'failed') return;
    expect(result.code).toBe('Cancelled');
    expect(result.run.state.status).toBe('cancelled');
  });

  it('dispatches nothing once cancelled', async () => {
    const { orchestrator, dispatched } = harnessFor();
    await orchestrator.start(start({ signal: { cancelled: () => true } }));

    expect(dispatched).toEqual([]);
  });

  it('keeps the artifacts produced before the cancellation', async () => {
    let steps = 0;
    const { orchestrator } = harnessFor({
      dispatch: ({ request }) => {
        steps += 1;
        return Promise.resolve(RESPONSE(request, 'done'));
      },
    });
    const result = await orchestrator.start(start({ signal: { cancelled: () => steps >= 1 } }));

    expect(result.outcome).toBe('failed');
    expect(result.run.state.status).toBe('cancelled');
    expect(result.run.state.artifacts).toHaveLength(1);
  });
});

describe('the run deadline', () => {
  it('fails with Timeout once the budget is spent', async () => {
    const ticks = [NOW, NOW, NOW, NOW, new Date(NOW.getTime() + 60_000)];
    let tick = 0;
    const { orchestrator } = harnessFor({
      clock: () => ticks[Math.min(tick++, ticks.length - 1)] as Date,
    });
    const result = await orchestrator.start(start({ runTimeoutMs: 1_000 }));

    expect(result.outcome).toBe('failed');
    if (result.outcome !== 'failed') return;
    expect(result.code).toBe('Timeout');
  });

  it('runs to completion inside its budget', async () => {
    const { orchestrator } = harnessFor();
    const result = await orchestrator.start(start({ runTimeoutMs: 60_000 }));

    expect(result.outcome).toBe('completed');
  });
});

// ── Determinism ─────────────────────────────────────────────────────────────

describe('determinism', () => {
  it('produces the same run twice from the same inputs', async () => {
    const first = await harnessFor().orchestrator.start(start());
    const second = await harnessFor().orchestrator.start(start());

    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('reads no clock of its own', async () => {
    const fixed = new Date('2001-01-01T00:00:00.000Z');
    const { orchestrator } = harnessFor({ clock: () => fixed });
    const result = await orchestrator.start(start());

    expect(result.run.state.timings.createdAt).toBe(fixed.toISOString());
  });

  it('generates no run id of its own', async () => {
    const { orchestrator } = harnessFor();
    const result = await orchestrator.start(start());

    expect(result.run.runId).toBe('run-1');
  });
});
