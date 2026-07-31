/**
 * The Template Library against the components it is built on.
 *
 * ── What only this file can check ───────────────────────────────────────────
 *
 * 1. IT DUPLICATES NOTHING. The library must reuse the S2.3 pipeline for
 *    rendering and validation, and the Provider Registry for compatibility. A
 *    second renderer or a second capability table is only visible structurally
 *    — a copy that agrees today passes every behavioural test.
 *
 * 2. THE WHOLE PATH COMPOSES. A resolved template renders into a prompt the
 *    frozen workflow runtime can execute and the frozen provider abstraction
 *    accepts. That crosses four components and is invisible from inside any one.
 *
 * 3. IT NEVER EXECUTES. Registered providers count their own calls; resolving
 *    and rendering must leave every counter at zero.
 *
 * 4. THE NAMING DEVIATION, recorded so it cannot be forgotten.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  awaitExecution,
  buildRequest,
  compilePrompt,
  createProviderRegistry,
  createPromptCatalogue,
  createTemplateLibrary,
  createWorkflowExecution,
  loadStep,
  preparePrompt,
  RENDER_ORDER,
  renderCanonicalPrompt,
  resolveTemplate,
  startWorkflow,
  validateAIRequest,
  validatePromptTemplate,
  type ModelProvider,
  type PromptTemplate,
  type TemplateCapability,
  type TemplateMetadata,
  type WorkflowDefinition,
} from '@contentos/ai';
import type { AIRequest, AIResponse } from '@contentos/contracts';
import { describe, expect, it } from 'vitest';

const ORG = '018f7a1e-0000-7000-8000-0000000000aa';
const WS = '018f7a1e-0000-7000-8000-0000000000bb';
const CORRELATION = '018f7a1e-0000-7000-8000-0000000000dd';

const sourceOf = (relative: string): string =>
  readFileSync(
    fileURLToPath(new URL(`../../packages/ai/src/templates/${relative}`, import.meta.url)),
    'utf8',
  );

const codeOf = (relative: string): string =>
  sourceOf(relative)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

const RESPONSE: AIResponse = {
  idempotencyKey: 'run-1:step-1',
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

/** A provider that counts every call anything makes to it. */
function counting(providerId: string, calls: { executed: number }): ModelProvider {
  return {
    providerId,
    displayName: providerId,
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

const TEMPLATE: PromptTemplate = {
  id: 'planning.outline',
  version: 7,
  taskType: 'planning.outline',
  status: 'active',
  parts: {
    system: 'You write outlines.',
    developer: 'Never invent a citation.',
    user: 'Write an outline about {{topic}}.',
  },
  variables: [{ name: 'topic', type: 'string', required: true, description: 'The subject.' }],
  modelHints: { maxOutputTokens: 1024, temperature: 0.2, determinismRequired: false },
  evalSetRef: 'evals/planning.outline',
  owner: 'content-platform',
  changelog: 'Initial version.',
};

const METADATA: TemplateMetadata = {
  title: 'Article outline',
  description: 'Produces a structured outline for an article.',
  owner: 'content-platform',
  visibility: 'public',
  tags: ['planning'],
};

const COMPATIBILITY: TemplateCapability = {
  capability: 'chat',
  providers: ['openai'],
  models: null,
};

const library = createTemplateLibrary([
  {
    id: 'planning.outline',
    metadata: METADATA,
    versions: [{ prompt: TEMPLATE, semanticVersion: '1.0.0', compatibility: COMPATIBILITY }],
  },
]);
library.seal();

function registryWith(calls: { executed: number }) {
  const providers = createProviderRegistry();
  providers.register(counting('openai', calls));
  providers.seal();
  return providers;
}

function resolved(calls: { executed: number }) {
  const result = resolveTemplate({
    library,
    id: 'planning.outline',
    selector: { kind: 'latest-stable' },
    providers: registryWith(calls),
    capability: 'chat',
    providerId: 'openai',
    visibility: 'public',
  });
  if (result.outcome !== 'resolved') throw new Error(`expected a resolution, got ${result.code}`);
  return result.resolved;
}

// ── 1 · It duplicates nothing ───────────────────────────────────────────────

describe('the library reuses what already exists', () => {
  it('renders through the pipeline compiler rather than its own', () => {
    // A second renderer would be a second definition of what a prompt IS, and
    // the two would diverge first on the case nobody wrote a test for.
    const render = codeOf('render.ts');
    expect(render).toContain("from '../prompts/compile.js'");
    expect(render).toContain('compilePrompt(');
    // No substitution of its own.
    expect(render).not.toMatch(/\{\{|replace\(|substitute\(/);
  });

  it('validates templates with the pipeline own validator', () => {
    const lib = codeOf('library.ts');
    expect(lib).toContain("from '../prompts/validation.js'");
    expect(lib).toContain('validatePromptTemplate(');
  });

  it('asks the Provider Registry about capability rather than keeping a table', () => {
    const resolve = codeOf('resolve.ts');
    expect(resolve).toContain("from '../providers/registry.js'");
    expect(resolve).toContain('supportsCapability');
    expect(resolve).not.toMatch(/CAPABILITY_MAP|const PROVIDERS\b|new Map<string, ModelProvider>/);
  });

  it('produces the anchor with the pipeline own helper', () => {
    expect(codeOf('library.ts')).toContain('promptVersionOf');
  });

  it('imports no provider SDK and no other feature package', () => {
    for (const file of ['library.ts', 'metadata.ts', 'render.ts', 'resolve.ts']) {
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

// ── 2 · It never executes ───────────────────────────────────────────────────

describe('the library supplies prompts and executes nothing', () => {
  it('leaves every provider untouched through resolution and rendering', () => {
    const calls = { executed: 0 };
    renderCanonicalPrompt({
      resolved: resolved(calls),
      variables: { topic: 'espresso' },
      tenantId: WS,
      correlationId: CORRELATION,
    });
    expect(calls.executed).toBe(0);
  });

  it('has no reachable path to a provider call, or to routing', () => {
    for (const file of ['library.ts', 'metadata.ts', 'render.ts', 'resolve.ts']) {
      const source = codeOf(file);
      expect(source, file).not.toMatch(/\.execute\s*\(/);
      expect(source, file).not.toMatch(/\.stream\s*\(/);
      expect(source, file).not.toContain('createRouter');
      expect(source, file).not.toContain('ExecutionPlan');
    }
  });
});

// ── 3 · The whole path composes ─────────────────────────────────────────────

describe('a rendered template is something the runtime can execute', () => {
  it('renders the same messages the pipeline would, on its own', () => {
    // The delegation is real, not a re-implementation that happens to agree.
    const canonical = renderCanonicalPrompt({
      resolved: resolved({ executed: 0 }),
      variables: { topic: 'espresso' },
      tenantId: WS,
      correlationId: CORRELATION,
    });

    const direct = compilePrompt({
      template: TEMPLATE,
      input: {
        templateRef: { id: TEMPLATE.id, version: TEMPLATE.version },
        variables: { topic: 'espresso' },
        tenantId: WS,
        correlationId: CORRELATION,
      },
    });

    expect(canonical.messages).toEqual(direct.messages);
    expect(canonical.promptVersion).toBe(direct.promptVersion);
    expect(canonical.promptChars).toBe(direct.promptChars);
  });

  it('honours the render order the compiler declares', () => {
    const canonical = renderCanonicalPrompt({
      resolved: resolved({ executed: 0 }),
      variables: { topic: 'espresso' },
      tenantId: WS,
      correlationId: CORRELATION,
    });

    expect(canonical.parts).toEqual([...RENDER_ORDER]);
    const system = canonical.messages[0]?.content ?? '';
    expect(system.indexOf('You write outlines.')).toBeLessThan(
      system.indexOf('Never invent a citation.'),
    );
  });

  it('drives the frozen workflow runtime to a valid AIRequest', () => {
    const canonical = renderCanonicalPrompt({
      resolved: resolved({ executed: 0 }),
      variables: { topic: 'espresso' },
      tenantId: WS,
      correlationId: CORRELATION,
    });

    const definition: WorkflowDefinition = {
      id: 'ai.single',
      version: 1,
      description: 'One step, driven by a library template.',
      steps: [
        {
          id: 'step-1',
          // The LIBRARY's identity and capability, carried into the definition
          // the frozen runtime consumes. This is the seam under test.
          templateRef: { id: canonical.templateId, version: canonical.templateVersion },
          capability: canonical.capability,
          model: 'gpt-4o',
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
    // The catalogue the runtime takes is fed from the LIBRARY's own version.
    execution = preparePrompt(execution, createPromptCatalogue([TEMPLATE]));
    execution = buildRequest(execution);
    execution = awaitExecution(execution);

    const prepared = execution.state.prepared;
    if (prepared === null) throw new Error('the runtime prepared no request');
    const built: AIRequest = prepared.request;

    expect(validateAIRequest(built)).toEqual({ ok: true });
    expect(built.messages).toEqual(canonical.messages);
    expect(prepared.promptVersion).toBe(canonical.promptVersion);
  });

  it('holds only versions the pipeline itself considers renderable', () => {
    for (const template of library.list()) {
      for (const version of template.versions) {
        expect(validatePromptTemplate(version.prompt), version.prompt.id).toEqual({ ok: true });
      }
    }
  });
});

// ── 4 · The naming deviation, on the record ─────────────────────────────────

describe('deviation from the increment naming, recorded', () => {
  it('RECORDS: `PromptTemplate` was already taken by the frozen pipeline', () => {
    // The increment names `PromptTemplate` for the identity-level aggregate.
    // S2.3 exports that name for ONE IMMUTABLE VERSION — parts, variables,
    // hints — which is what this increment calls a `PromptVersion`. Shadowing
    // it would put two `PromptTemplate`s meaning different things in one
    // barrel, so the aggregate is `LibraryTemplate` and `PromptVersion` wraps
    // the frozen type rather than restating it.
    const version = library.get('planning.outline').versions[0];
    expect(version?.prompt).toBe(TEMPLATE);
    expect(validatePromptTemplate(TEMPLATE)).toEqual({ ok: true });
  });

  it('keeps the monotonic version as the identity and the anchor', () => {
    // `prompt-engine.md`: "version: number; monotonic; immutable once active",
    // and `promptVersion` reaches AIResponse, the workflow's step results and
    // every producer's algorithmVersion under ADR-021. Semver is added
    // ALONGSIDE, for compatibility questions the integer cannot answer.
    const version = library.get('planning.outline').versions[0];
    expect(version?.prompt.version).toBe(7);
    expect(version?.semanticVersion).toEqual({ major: 1, minor: 0, patch: 0 });

    const canonical = renderCanonicalPrompt({
      resolved: resolved({ executed: 0 }),
      variables: { topic: 'espresso' },
      tenantId: WS,
      correlationId: CORRELATION,
    });
    expect(canonical.promptVersion).toBe('planning.outline@7');
    expect(canonical.semanticVersion).toBe('1.0.0');
  });
});
