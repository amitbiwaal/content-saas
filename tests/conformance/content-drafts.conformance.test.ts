/**
 * Draft management against the layers it prepares work for.
 *
 * ── What only this file can check ───────────────────────────────────────────
 *
 * 1. THE SEAM IS REAL. A draft created through the service compiles into a
 *    request the FROZEN orchestrator actually runs, producing artifacts — four
 *    increments end to end. Neither the draft layer nor the orchestrator can see
 *    that path from inside itself.
 *
 * 2. THE DRAFT LAYER NEVER EXECUTES. It holds no provider registry, no router,
 *    no executor and no orchestrator; a full draft lifecycle leaves every
 *    provider uncalled. Structural AND behavioural, because either alone can be
 *    argued with.
 *
 * 3. REVISIONS ARE IMMUTABLE. Not "readonly" — frozen, and demonstrated by
 *    trying to rewrite one on a draft the service produced.
 *
 * 4. THE PIN IS ENFORCED. A template promoted after a draft was written stops
 *    it compiling, which is the only thing that makes a pin mean anything given
 *    that the frozen orchestrator resolves templates itself.
 *
 * 5. THE DEVIATIONS, recorded so they cannot be forgotten.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  compileDraft,
  createDraftService,
  createModelCatalogue,
  createOrchestrator,
  createPricingRegistry,
  createProviderRegistry,
  createRouter,
  createRoutingTable,
  createTemplateLibrary,
  createWorkflowRegistry,
  DRAFT_STATUSES,
  latestRevision,
  type ContentDraft,
  type ContentWorkflowDefinition,
  type DraftListCriteria,
  type DraftMetadata,
  type DraftRepository,
  type ModelProvider,
  type PromptTemplate,
  type TemplateLibrary,
  type WorkflowStepDefinition,
} from '@contentos/ai';
import type { AIRequest, AIResponse } from '@contentos/contracts';
import type { Principal } from '@contentos/security';
import { describe, expect, it } from 'vitest';

const ORG = '018f7a1e-0000-7000-8000-0000000000aa';
const WS = '018f7a1e-0000-7000-8000-0000000000bb';
const CORRELATION = '018f7a1e-0000-7000-8000-0000000000dd';
const NOW = new Date('2026-07-31T12:00:00.000Z');

const draftsDir = new URL('../../packages/ai/src/drafts/', import.meta.url);

const codeOf = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, draftsDir)), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

/** Every module of the draft package, tests excluded. */
const DRAFT_MODULES: readonly string[] = readdirSync(fileURLToPath(draftsDir)).filter(
  (name) => name.endsWith('.ts') && !name.endsWith('.test.ts'),
);

// ── Fixtures ────────────────────────────────────────────────────────────────

const VARIABLES: Readonly<Record<string, PromptTemplate['variables']>> = {
  'planning.outline': [
    { name: 'topic', type: 'string', required: true, description: 'The subject.' },
  ],
  'writing.draft': [
    { name: 'topic', type: 'string', required: true, description: 'The subject.' },
    { name: 'outline', type: 'string', required: false, description: 'The bound outline.' },
  ],
};

const BODY: Readonly<Record<string, string>> = {
  'planning.outline': 'Outline {{topic}}.',
  'writing.draft': 'Draft {{topic}} from {{outline}}.',
};

const template = (
  id: string,
  version: number,
  status: PromptTemplate['status'] = 'active',
): PromptTemplate => ({
  id,
  version,
  taskType: id,
  status,
  parts: { system: 'You write.', user: BODY[id] as string },
  variables: VARIABLES[id] as PromptTemplate['variables'],
  modelHints: { maxOutputTokens: 512, temperature: 0.2, determinismRequired: false },
  evalSetRef: `evals/${id}`,
  owner: 'content-platform',
  changelog: 'Initial.',
});

function libraryOf(versions: Readonly<Record<string, readonly number[]>>): TemplateLibrary {
  const library = createTemplateLibrary(
    Object.entries(versions).map(([id, numbers]) => ({
      id,
      metadata: {
        title: id,
        description: `The ${id} prompt.`,
        owner: 'content-platform',
        visibility: 'public' as const,
        tags: [],
      },
      versions: numbers.map((number, index) => ({
        prompt: template(id, number, index === numbers.length - 1 ? 'active' : 'deprecated'),
        semanticVersion: `1.${String(index)}.0`,
        compatibility: { capability: 'chat' as const, providers: null, models: null },
      })),
    })),
  );
  library.seal();
  return library;
}

const LIBRARY = libraryOf({ 'planning.outline': [7], 'writing.draft': [3] });

const step = (id: string, next: string | null, templateId: string): WorkflowStepDefinition => ({
  kind: 'prompt',
  id,
  description: `Render ${templateId}.`,
  templateRef: { id: templateId, selector: { kind: 'latest-stable' } },
  bindOutputTo: id === 'outline' ? 'outline' : undefined,
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

const registryOf = (library: TemplateLibrary) => {
  const registry = createWorkflowRegistry([DEFINITION], { library });
  registry.seal();
  return registry;
};

const REGISTRY = registryOf(LIBRARY);

const metadata: DraftMetadata = {
  organizationId: ORG,
  workspaceId: WS,
  principalId: '018f7a1e-0000-7000-8000-0000000000cc',
  principalKind: 'user',
  title: 'An article',
  tags: ['article'],
};

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
  sessionId: 'session-1',
};

const organization = { organizationId: ORG, status: 'active' as const };
const workspace = { workspaceId: WS, organizationId: ORG, status: 'active' as const };

/** In-memory. The only implementation, and it lives in a test. */
function memoryRepository() {
  const drafts = new Map<string, ContentDraft>();
  const calls = { saveDraft: 0, loadDraft: 0, updateDraft: 0, deleteDraft: 0, listDrafts: 0 };

  const repository: DraftRepository = {
    saveDraft: (draft) => {
      calls.saveDraft += 1;
      drafts.set(draft.draftId, draft);
      return Promise.resolve();
    },
    loadDraft: (draftId) => {
      calls.loadDraft += 1;
      return Promise.resolve(drafts.get(draftId) ?? null);
    },
    updateDraft: (input) => {
      calls.updateDraft += 1;
      drafts.set(input.draft.draftId, input.draft);
      return Promise.resolve();
    },
    deleteDraft: (draftId) => {
      calls.deleteDraft += 1;
      drafts.delete(draftId);
      return Promise.resolve();
    },
    listDrafts: (criteria: DraftListCriteria) => {
      calls.listDrafts += 1;
      return Promise.resolve({ drafts: [...drafts.values()].slice(0, criteria.limit) });
    },
  };

  return { repository, calls, drafts };
}

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

/** Counts every direct provider call. Nothing in the draft layer may raise it. */
const providerCalls = { executed: 0 };

function provider(): ModelProvider {
  return {
    providerId: 'openai',
    displayName: 'OpenAI',
    capabilities: ['chat'],
    health: () =>
      Promise.resolve({ status: 'healthy' as const, reportedAt: NOW.toISOString(), detail: null }),
    execute: (request: AIRequest) => {
      providerCalls.executed += 1;
      return Promise.resolve(response(request, 'direct'));
    },
  };
}

function orchestrator() {
  const providers = createProviderRegistry();
  providers.register(provider());
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

  return createOrchestrator({
    workflows: REGISTRY,
    templates: LIBRARY,
    providers,
    router: createRouter({
      providers,
      catalogue,
      table: createRoutingTable({ version: 'routing-2026-07', global: { providerId: 'openai' } }),
    }),
    executor: { dispatch: ({ request }) => Promise.resolve(response(request, 'generated text')) },
    pricing,
    now: () => NOW,
    newRunId: () => 'run-1',
    delay: () => Promise.resolve(),
  });
}

function serviceFor(library: TemplateLibrary = LIBRARY) {
  const store = memoryRepository();
  return {
    ...store,
    service: createDraftService({
      repository: store.repository,
      workflows: registryOf(library),
      templates: library,
      now: () => NOW,
      newDraftId: () => 'draft-1',
    }),
  };
}

/** A draft, created and validated through the service. */
async function readyDraft(inputs: Readonly<Record<string, unknown>> = { topic: 'multi-tenancy' }) {
  const bench = serviceFor();
  const created = await bench.service.create({
    metadata,
    workflowId: 'article.draft',
    workflowVersion: 2,
    inputs,
  });
  if (created.outcome !== 'ok') throw new Error(`expected a draft: ${created.reason}`);

  const ready = await bench.service.revise({
    draftId: 'draft-1',
    transition: 'ready',
    note: 'Validated.',
  });
  if (ready.outcome !== 'ok') throw new Error(`expected a ready draft: ${ready.reason}`);

  return { ...bench, draft: ready.draft };
}

const compileOptions = (draft: ContentDraft) => ({
  draft,
  workflows: REGISTRY,
  templates: LIBRARY,
  principal,
  organization,
  workspace,
  correlationId: CORRELATION,
  idempotencyKey: 'draft-idem-1',
  model: 'gpt-4o',
  timeoutMs: 30_000,
});

// ── 1 · The seam is real ────────────────────────────────────────────────────

describe('a draft becomes a run', () => {
  it('compiles into a request the frozen orchestrator runs to completion', async () => {
    providerCalls.executed = 0;
    const { draft } = await readyDraft();

    const compilation = compileDraft(compileOptions(draft));
    expect(compilation.outcome).toBe('compiled');
    if (compilation.outcome !== 'compiled') return;

    const result = await orchestrator().start(compilation.request);

    expect(result.outcome).toBe('completed');
    expect(result.run.state.artifacts.map((artifact) => artifact.stepId)).toEqual([
      'outline',
      'draft',
    ]);
  });

  it('runs the workflow version the draft pinned', async () => {
    const { draft } = await readyDraft();
    const compilation = compileDraft(compileOptions(draft));
    if (compilation.outcome !== 'compiled') throw new Error('expected a compilation');

    const result = await orchestrator().start(compilation.request);

    expect(result.run.workflowRef).toBe('article.draft@2');
    expect(result.run.workflowVersion).toBe(draft.workflowVersion);
  });

  it('runs the prompts the draft pinned', async () => {
    const { draft } = await readyDraft();
    const compilation = compileDraft(compileOptions(draft));
    if (compilation.outcome !== 'compiled') throw new Error('expected a compilation');

    const result = await orchestrator().start(compilation.request);

    expect(result.run.templateVersions).toEqual(
      draft.templateReferences.map((reference) => reference.promptVersion),
    );
  });

  it('carries the draft inputs into the run', async () => {
    const { draft } = await readyDraft({ topic: 'a very specific subject' });
    const compilation = compileDraft(compileOptions(draft));
    if (compilation.outcome !== 'compiled') throw new Error('expected a compilation');

    expect(compilation.request.variables).toEqual({ topic: 'a very specific subject' });
  });

  it('produces the orchestrator’s own input type, not a shape of its own', () => {
    // An alias, not a copy. A second request shape would be one more thing to
    // keep in step, and the first drift would compile into something unrunnable.
    expect(codeOf('compile.ts')).toMatch(/ContentRunRequest = StartRunOptions/);
  });
});

// ── 2 · The draft layer never executes ──────────────────────────────────────

describe('drafts never execute anything', () => {
  it('leaves every provider uncalled through a whole lifecycle', async () => {
    providerCalls.executed = 0;
    const bench = await readyDraft();

    await bench.service.load('draft-1');
    await bench.service.validate('draft-1');
    await bench.service.list();
    compileDraft(compileOptions(bench.draft));

    expect(providerCalls.executed).toBe(0);
  });

  it('never calls the orchestrator', () => {
    for (const file of DRAFT_MODULES) {
      const code = codeOf(file);
      expect(code).not.toMatch(/createOrchestrator\(/);
      expect(code).not.toMatch(/\.start\(/);
      // Where the orchestrator module is named at all, it is a TYPE import —
      // erased at build, so there is no runtime path from a draft to a run.
      if (code.includes('runs/orchestrator.js')) {
        expect(code).toMatch(/import type \{[^}]*\} from '\.\.\/runs\/orchestrator\.js'/);
      }
    }
  });

  it('never calls a provider, and holds nothing that could', () => {
    for (const file of DRAFT_MODULES) {
      const code = codeOf(file);
      expect(code).not.toMatch(/\.execute\(|\.dispatch\(|\.stream\(/);
      expect(code).not.toMatch(/from '\.\.\/routing\/|from '\.\.\/retry\/|from '\.\.\/streaming\//);
    }
  });

  it('never drives the workflow runtime', () => {
    for (const file of DRAFT_MODULES) {
      expect(codeOf(file)).not.toMatch(
        /loadStep\(|preparePrompt\(|buildRequest\(|recordExecution\(/,
      );
    }
  });

  it('imports the orchestrator for its request TYPE and nothing else', () => {
    // `import type` is erased; there is no runtime path from a draft to a run.
    expect(codeOf('compile.ts')).toMatch(
      /import type \{ StartRunOptions \} from '\.\.\/runs\/orchestrator\.js'/,
    );
  });
});

describe('the draft layer knows of no database', () => {
  it('imports no database package, driver or ORM', () => {
    for (const file of DRAFT_MODULES) {
      const code = codeOf(file);
      expect(code).not.toMatch(/@contentos\/database/);
      expect(code).not.toMatch(/from '(pg|postgres|mysql2|ioredis|redis|knex|drizzle|prisma)/);
    }
  });

  it('writes no SQL and opens no connection', () => {
    for (const file of DRAFT_MODULES) {
      const code = codeOf(file);
      expect(code).not.toMatch(/SELECT .+ FROM |INSERT INTO|UPDATE .+ SET |DELETE FROM/i);
      expect(code).not.toMatch(/createPool|new Client\(|\.connect\(|\.query\(/);
    }
  });

  it('ships a port and no implementation of it', () => {
    const code = codeOf('repository.ts');
    expect(code).toMatch(/interface DraftRepository/);
    expect(code).not.toMatch(/^export (async )?function/m);
    expect(code).not.toMatch(/^export const/m);
  });
});

// ── 3 · Revisions are immutable ─────────────────────────────────────────────

describe('revisions', () => {
  it('accumulate rather than replace', async () => {
    const bench = await readyDraft();
    const edited = await bench.service.revise({
      draftId: 'draft-1',
      transition: 'edit',
      changes: { inputs: { topic: 'changed' } },
      note: 'Changed my mind.',
    });

    expect(edited.outcome).toBe('ok');
    if (edited.outcome !== 'ok') return;
    expect(edited.draft.revisions.map((revision) => revision.revision)).toEqual([1, 2, 3]);
    expect(edited.draft.revisions[0]?.inputs).toEqual({ topic: 'multi-tenancy' });
  });

  it('cannot be rewritten in place', async () => {
    const { draft } = await readyDraft();

    expect(() => {
      (draft.revisions[0] as { note: string }).note = 'rewritten';
    }).toThrow();
    expect(() => {
      (draft.revisions as { length: number }).length = 0;
    }).toThrow();
  });

  it('keep the pinned references wherever the draft goes', async () => {
    const bench = await readyDraft();
    const edited = await bench.service.revise({
      draftId: 'draft-1',
      transition: 'edit',
      changes: { inputs: { topic: 'changed' } },
      note: 'Edited.',
    });

    if (edited.outcome !== 'ok') return;
    expect(edited.draft.workflowVersion).toBe(2);
    expect(edited.draft.templateReferences).toEqual(bench.draft.templateReferences);
  });

  it('record who made the draft and never what they may do', async () => {
    const { draft } = await readyDraft();
    const flat = JSON.stringify(draft);

    expect(draft.metadata.principalId).toBe(principal.subjectId);
    expect(flat).not.toContain('editor');
    expect(flat).not.toContain('article:execute');
    expect(flat).not.toContain('session-1');
  });

  it('go through the repository, once each', async () => {
    const bench = await readyDraft();

    expect(bench.calls.saveDraft).toBe(1);
    expect(bench.calls.updateDraft).toBe(1);
    expect(latestRevision(bench.draft).revision).toBe(2);
  });
});

// ── 4 · The pin is enforced ─────────────────────────────────────────────────

describe('a promoted template stops a draft compiling', () => {
  it('refuses rather than running a prompt the author never saw', async () => {
    const { draft } = await readyDraft();

    // The library moves on after the draft was written.
    const promoted = libraryOf({ 'planning.outline': [7, 8], 'writing.draft': [3] });
    const result = compileDraft({
      ...compileOptions(draft),
      workflows: registryOf(promoted),
      templates: promoted,
    });

    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') return;
    expect(result.code).toBe('DraftInvalid');
    expect(result.issues.map((issue) => issue.code)).toContain('TEMPLATE_DRIFT');
  });

  it('is why a draft records the references at all', () => {
    expect(codeOf('validation.ts')).toMatch(/TEMPLATE_DRIFT/);
  });
});

// ── The lifecycle ───────────────────────────────────────────────────────────

describe('the draft lifecycle', () => {
  it('is the four states, and submitted is terminal', () => {
    expect([...DRAFT_STATUSES]).toEqual(['draft', 'ready', 'submitted', 'discarded']);
  });

  it('refuses to compile a draft nobody validated', async () => {
    const bench = serviceFor();
    const created = await bench.service.create({
      metadata,
      workflowId: 'article.draft',
      workflowVersion: 2,
      inputs: { topic: 'x' },
    });
    if (created.outcome !== 'ok') throw new Error('expected a draft');

    const result = compileDraft(compileOptions(created.draft));

    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') return;
    expect(result.code).toBe('NotReady');
  });

  it('refuses to compile a draft from another workspace', async () => {
    const { draft } = await readyDraft();
    const result = compileDraft({
      ...compileOptions(draft),
      workspace: {
        workspaceId: '018f7a1e-0000-7000-8000-0000000000ee',
        organizationId: ORG,
        status: 'active',
      },
    });

    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') return;
    expect(result.code).toBe('TenancyMismatch');
  });

  it('refuses to delete a submitted draft', async () => {
    const bench = await readyDraft();
    await bench.service.revise({ draftId: 'draft-1', transition: 'submit', note: 'Submitted.' });

    const result = await bench.service.remove('draft-1');

    expect(result.outcome).toBe('refused');
    expect(bench.calls.deleteDraft).toBe(0);
  });
});

// ── 5 · Deviations ──────────────────────────────────────────────────────────

describe('recorded deviations', () => {
  it('DEVIATION: pinned references are fixed for the life of the draft', () => {
    // A revision may change inputs, title and status, and nothing else. The
    // point of pinning is that the thing the author saw is the thing that runs;
    // wanting a different workflow is wanting a different draft.
    expect(codeOf('draft.ts')).toMatch(/appendRevision/);
    expect(codeOf('draft.ts')).not.toMatch(/workflowVersion: (changes|options\.changes)/);
  });

  it('DEVIATION: compilation enforces the template pin the orchestrator cannot', () => {
    // The frozen orchestrator resolves templates itself and `StartRunOptions`
    // has nowhere to pin them, so an un-refused drift would silently run a
    // newer prompt. Refusing is the pin.
    expect(codeOf('validation.ts')).toMatch(/TEMPLATE_DRIFT/);
  });

  it('DEVIATION: value conformance is checked at compile, not while editing', () => {
    // A half-typed number is normal mid-edit. Compilation runs the FROZEN
    // `compilePrompt` instead of restating its rules, so the two cannot
    // disagree.
    expect(codeOf('validation.ts')).not.toMatch(/compilePrompt/);
    expect(codeOf('compile.ts')).toMatch(/compilePrompt\(/);
  });

  it('DEVIATION: `updateDraft` carries the revision it was built on', () => {
    // Collaboration is out of scope; a lost update is not a collaboration
    // feature, it is data loss. One field turns last-write-wins into a refusal.
    expect(codeOf('repository.ts')).toMatch(/expectedRevision/);
  });

  it('DEVIATION: a submitted draft cannot be deleted', () => {
    // It is the record of what was submitted, and deleting it destroys the
    // provenance of a run that already happened.
    expect(codeOf('service.ts')).toMatch(/ImmutableDraft/);
  });

  it('DEVIATION: refusals are values, not thrown errors', () => {
    // The same shape resolution, routing, admission and history use.
    expect(codeOf('service.ts')).toMatch(/outcome: 'refused'/);
    expect(codeOf('compile.ts')).toMatch(/outcome: 'refused'/);
  });
});
