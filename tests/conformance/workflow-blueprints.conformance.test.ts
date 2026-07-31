/**
 * Content workflow blueprints against the components they are built on.
 *
 * ── What only this file can check ───────────────────────────────────────────
 *
 * 1. THE SEAM IS REAL. A blueprint compiles into a definition the FROZEN S2.4
 *    engine actually executes, through the frozen validator, producing an
 *    `AIRequest` the frozen provider abstraction accepts. That crosses four
 *    components and is invisible from inside any one of them.
 *
 * 2. IT DUPLICATES NOTHING. Template references resolve through the S4.1
 *    library; the step bound is the runtime's own; semver comes from the
 *    template library's parser. A second copy is only visible structurally.
 *
 * 3. NO STEP NAMES A PROVIDER. The frozen `WorkflowStep` carries `model`; a
 *    blueprint step must not, because the Router decides that per request.
 *
 * 4. THE NAMING DEVIATION, recorded so it cannot be forgotten.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  awaitExecution,
  buildRequest,
  createPromptCatalogue,
  createProviderRegistry,
  createTemplateLibrary,
  createWorkflowExecution,
  createWorkflowRegistry,
  isLinear,
  loadStep,
  MAX_WORKFLOW_STEPS,
  outgoing,
  preparePrompt,
  recordExecution,
  resolveWorkflow,
  startWorkflow,
  toRuntimeDefinition,
  validateAIRequest,
  validateWorkflowDefinition,
  WORKFLOW_STEP_KINDS,
  type ContentWorkflowDefinition,
  type ModelProvider,
  type PromptTemplate,
  type WorkflowStepDefinition,
} from '@contentos/ai';
import type { AIRequest, AIResponse } from '@contentos/contracts';
import { describe, expect, it } from 'vitest';

const ORG = '018f7a1e-0000-7000-8000-0000000000aa';
const WS = '018f7a1e-0000-7000-8000-0000000000bb';
const CORRELATION = '018f7a1e-0000-7000-8000-0000000000dd';

const sourceOf = (relative: string): string =>
  readFileSync(
    fileURLToPath(new URL(`../../packages/ai/src/blueprints/${relative}`, import.meta.url)),
    'utf8',
  );

const codeOf = (relative: string): string =>
  sourceOf(relative)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

const RESPONSE: AIResponse = {
  idempotencyKey: 'run-1:outline',
  providerId: 'openai',
  model: 'gpt-4o',
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

function counting(calls: { executed: number }): ModelProvider {
  return {
    providerId: 'openai',
    displayName: 'OpenAI',
    capabilities: ['chat'],
    health: () =>
      Promise.resolve({
        status: 'healthy' as const,
        reportedAt: '2026-07-31T12:00:00.000Z',
        detail: null,
      }),
    execute: () => {
      calls.executed += 1;
      return Promise.resolve(RESPONSE);
    },
  };
}

const template = (id: string, version: number): PromptTemplate => ({
  id,
  version,
  taskType: id,
  status: 'active',
  parts: { system: 'You write.', user: 'Write about {{topic}}.' },
  variables: [{ name: 'topic', type: 'string', required: true, description: 'The subject.' }],
  modelHints: { maxOutputTokens: 512, temperature: 0.2, determinismRequired: false },
  evalSetRef: `evals/${id}`,
  owner: 'content-platform',
  changelog: 'Initial.',
});

const LIBRARY = createTemplateLibrary(
  [
    { id: 'planning.outline', version: 7 },
    { id: 'writing.draft', version: 3 },
  ].map((entry) => ({
    id: entry.id,
    metadata: {
      title: entry.id,
      description: `The ${entry.id} prompt.`,
      owner: 'content-platform',
      visibility: 'public' as const,
      tags: [],
    },
    versions: [
      {
        prompt: template(entry.id, entry.version),
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

const registry = createWorkflowRegistry([DEFINITION], { library: LIBRARY });
registry.seal();

function resolved() {
  const result = resolveWorkflow({
    registry,
    id: 'article.draft',
    selector: { kind: 'latest-stable' },
    capability: 'chat',
    visibility: 'public',
  });
  if (result.outcome !== 'resolved') throw new Error(`expected a resolution, got ${result.code}`);
  return result.resolved;
}

// ── 1 · The seam is real ────────────────────────────────────────────────────

describe('a blueprint compiles into something the frozen runtime executes', () => {
  it('produces a definition the frozen validator accepts', () => {
    const definition = toRuntimeDefinition({
      resolved: resolved(),
      library: LIBRARY,
      timeoutMs: 30_000,
      model: 'gpt-4o',
    });
    expect(validateWorkflowDefinition(definition)).toEqual({ ok: true });
  });

  it('drives the runtime end to end to a valid AIRequest', () => {
    const definition = toRuntimeDefinition({
      resolved: resolved(),
      library: LIBRARY,
      timeoutMs: 30_000,
      model: 'gpt-4o',
    });

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

    const catalogue = createPromptCatalogue([
      template('planning.outline', 7),
      template('writing.draft', 3),
    ]);

    execution = loadStep(execution);
    execution = preparePrompt(execution, catalogue);
    execution = buildRequest(execution);
    execution = awaitExecution(execution);

    const prepared = execution.state.prepared;
    if (prepared === null) throw new Error('the runtime prepared no request');
    const built: AIRequest = prepared.request;

    expect(validateAIRequest(built)).toEqual({ ok: true });
    // The step the BLUEPRINT declared first is the step the runtime ran first.
    expect(prepared.promptVersion).toBe('planning.outline@7');

    // And the second step follows, which is what makes it a workflow.
    execution = recordExecution(execution, RESPONSE);
    execution = loadStep(execution);
    expect(execution.state.stepId).toBe('draft');
  });

  it('resolves each step template to a pinned integer, not a selector', () => {
    // The runtime has no way to evaluate `latest-stable`; handing it one would
    // fail at the step that costs money.
    const definition = toRuntimeDefinition({
      resolved: resolved(),
      library: LIBRARY,
      timeoutMs: 30_000,
      model: 'gpt-4o',
    });
    expect(definition.steps.map((entry) => entry.templateRef)).toEqual([
      { id: 'planning.outline', version: 7 },
      { id: 'writing.draft', version: 3 },
    ]);
  });

  it('never executes: compiling and resolving leave every provider untouched', () => {
    const calls = { executed: 0 };
    const providers = createProviderRegistry();
    providers.register(counting(calls));
    providers.seal();

    toRuntimeDefinition({
      resolved: resolved(),
      library: LIBRARY,
      timeoutMs: 30_000,
      model: 'gpt-4o',
      providers,
    });
    expect(calls.executed).toBe(0);
  });
});

// ── 2 · It duplicates nothing ───────────────────────────────────────────────

describe('the blueprint layer reuses what already exists', () => {
  it('resolves template references through the S4.1 library', () => {
    for (const file of ['validation.ts', 'resolve.ts']) {
      expect(codeOf(file), file).toContain("from '../templates/resolve.js'");
      expect(codeOf(file), file).toContain('resolveTemplate(');
    }
  });

  it('takes the step bound from the frozen runtime rather than choosing its own', () => {
    // A second, looser number would let a blueprint register that the runtime
    // then refuses.
    expect(codeOf('validation.ts')).toContain("from '../workflow/definition.js'");
    expect(MAX_WORKFLOW_STEPS).toBe(50);
  });

  it('parses semantic versions with the template library parser', () => {
    for (const file of ['registry.ts', 'resolve.ts']) {
      expect(codeOf(file), file).toContain("from '../templates/metadata.js'");
      expect(codeOf(file), file).not.toMatch(/\\d\+\\\.\\d\+\\\.\\d\+|SEMVER\s*=/);
    }
  });

  it('reads every graph edge from one function', () => {
    // Three walks that each decided what an edge was would disagree on
    // `onFailure` first.
    expect(codeOf('validation.ts')).toContain('outgoing(');
    expect(codeOf('resolve.ts')).toContain('outgoing(');
    const step2: WorkflowStepDefinition = {
      kind: 'validate',
      id: 'check',
      description: 'Check.',
      validator: 'schema',
      subject: 'draft',
      next: 'ok',
      onFailure: 'bad',
    };
    expect(outgoing(step2)).toEqual(['ok', 'bad']);
  });

  it('imports no provider SDK and no other feature package', () => {
    for (const file of ['steps.ts', 'validation.ts', 'registry.ts', 'resolve.ts']) {
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

// ── 3 · No step names a provider ────────────────────────────────────────────

describe('a blueprint step names a template, never a provider', () => {
  it('declares no provider or model field on any step kind', () => {
    const steps = codeOf('steps.ts');
    expect(steps).not.toMatch(/readonly\s+providerId\s*:/);
    expect(steps).not.toMatch(/readonly\s+model\s*:/);
  });

  it('carries no provider identity in a registered version', () => {
    const serialized = JSON.stringify(registry.get('article.draft'));
    expect(serialized).not.toContain('openai');
    expect(serialized).not.toContain('gpt-4o');
    expect(serialized).not.toContain('providerId');
  });

  it('takes the model from the CALLER at compile time', () => {
    // The Router decides that per request from live health and policy; a
    // blueprint pinning one would decide it months early.
    const compiled = toRuntimeDefinition({
      resolved: resolved(),
      library: LIBRARY,
      timeoutMs: 30_000,
      model: 'claude-sonnet',
    });
    expect(compiled.steps.every((entry) => entry.model === 'claude-sonnet')).toBe(true);
  });

  it('declares exactly the five step kinds the increment names', () => {
    expect([...WORKFLOW_STEP_KINDS]).toEqual([
      'prompt',
      'transform',
      'validate',
      'branch',
      'merge',
    ]);
  });
});

// ── 4 · The naming deviation, on the record ─────────────────────────────────

describe('deviation from the increment naming, recorded', () => {
  it('RECORDS: `WorkflowDefinition` and `WorkflowStep` were already taken', () => {
    // The increment names both. S2.4 exports them for a LINEAR list of prompt
    // steps that the engine walks one at a time; this increment describes a
    // GRAPH with branch and merge, which that engine deliberately does not
    // execute. Two `WorkflowDefinition`s meaning different things in one barrel
    // would be worse than a different word, so the aggregate is
    // `ContentWorkflow` and a step is a `WorkflowStepDefinition`.
    const runtimeDefinition = toRuntimeDefinition({
      resolved: resolved(),
      library: LIBRARY,
      timeoutMs: 30_000,
      model: 'gpt-4o',
    });

    // The frozen type: linear steps, each with a model and a timeout.
    expect(validateWorkflowDefinition(runtimeDefinition)).toEqual({ ok: true });
    expect(Object.keys(runtimeDefinition).sort()).toEqual([
      'description',
      'id',
      'steps',
      'version',
    ]);

    // The blueprint type: a graph, with none of that.
    const blueprint = registry.get('article.draft').versions[0];
    expect(blueprint?.steps[0]).toHaveProperty('kind');
    expect(blueprint?.steps[0]).not.toHaveProperty('model');
  });

  it('refuses to hand a graph to an engine that walks a list', () => {
    // A flattened branch is a workflow that quietly does the wrong thing on the
    // path nobody tested.
    const graph = createWorkflowRegistry(
      [
        {
          ...DEFINITION,
          versions: [
            {
              ...DEFINITION.versions[0],
              version: 1,
              semanticVersion: '1.0.0',
              status: 'active' as const,
              capability: { capability: 'chat' as const, executionMode: 'buffered' as const },
              entryStepId: 'outline',
              changelog: 'Branching.',
              steps: [
                step('outline', 'fork', 'planning.outline'),
                {
                  kind: 'branch',
                  id: 'fork',
                  description: 'Long or short.',
                  on: 'outline',
                  cases: [{ when: 'long', next: 'draft' }],
                  otherwise: null,
                },
                step('draft', null, 'writing.draft'),
              ],
            },
          ],
        },
      ],
      { library: LIBRARY },
    );

    const result = resolveWorkflow({
      registry: graph,
      id: 'article.draft',
      selector: { kind: 'latest-stable' },
    });
    if (result.outcome !== 'resolved') throw new Error('expected a resolution');

    expect(isLinear(result.resolved.version)).toBe(false);
    expect(() =>
      toRuntimeDefinition({
        resolved: result.resolved,
        library: LIBRARY,
        timeoutMs: 30_000,
        model: 'gpt-4o',
      }),
    ).toThrow(/single linear sequence/);
  });

  it('keeps the monotonic version as identity, with semver alongside', () => {
    const version = registry.get('article.draft').versions[0];
    expect(version?.version).toBe(2);
    expect(version?.semanticVersion).toEqual({ major: 1, minor: 1, patch: 0 });
    expect(resolved().workflowVersion).toBe('article.draft@2');

    // And the integer is what the runtime records.
    const compiled = toRuntimeDefinition({
      resolved: resolved(),
      library: LIBRARY,
      timeoutMs: 30_000,
      model: 'gpt-4o',
    });
    expect(compiled.version).toBe(2);
  });
});
