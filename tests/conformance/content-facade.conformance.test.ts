/**
 * The Content Management Facade against the whole platform behind it.
 *
 * ── What only this file can check ───────────────────────────────────────────
 *
 * 1. THE WHOLE PLATFORM, THROUGH ONE DOOR. A draft created through the facade,
 *    revised through the facade, submitted through the facade — running a real
 *    orchestrator over a real store — and then found, read back and exported
 *    through the facade. Nine increments, one vocabulary.
 *
 * 2. IT IMPORTS NOTHING IT MAY NOT. No repository, no provider, no workflow
 *    runtime, no registry. Structural, per module, because the whole value of
 *    an entry point is that it cannot reach past the services it fronts.
 *
 * 3. IT CREATES NO IDENTITY. No principal is constructed, no id generated, no
 *    clock read. Everything it propagates came in with the request.
 *
 * 4. IT DELEGATES EXACTLY ONCE, and never throws.
 *
 * 5. THE DEVIATIONS, recorded so they cannot be forgotten.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  compileDraft,
  CONTENT_OPERATIONS,
  createContentExport,
  createContentManagement,
  createContentSearch,
  createDraftService,
  createModelCatalogue,
  createOrchestrator,
  createPricingRegistry,
  createProviderRegistry,
  createRouter,
  createRoutingTable,
  createRunHistory,
  createTemplateLibrary,
  createWorkflowRegistry,
  type CompileDraftOptions,
  type ContentContext,
  type ContentDraft,
  type ContentRequest,
  type ContentSearchStore,
  type ContentWorkflowDefinition,
  type ModelProvider,
  type PromptTemplate,
  type StoredArtifact,
  type StoredContentRun,
  type WorkflowStepDefinition,
} from '@contentos/ai';
import type { AIRequest, AIResponse } from '@contentos/contracts';
import type { Principal } from '@contentos/security';
import { describe, expect, it } from 'vitest';

const ORG = '018f7a1e-0000-7000-8000-0000000000aa';
const WS = '018f7a1e-0000-7000-8000-0000000000bb';
const CORRELATION = '018f7a1e-0000-7000-8000-0000000000dd';
const NOW = new Date('2026-07-31T12:00:00.000Z');

const facadeDir = new URL('../../packages/ai/src/facade/', import.meta.url);

const codeOf = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, facadeDir)), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

/** Every module of the facade, tests excluded. */
const FACADE_MODULES: readonly string[] = readdirSync(fileURLToPath(facadeDir)).filter(
  (name) => name.endsWith('.ts') && !name.endsWith('.test.ts'),
);

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

const REGISTRY = createWorkflowRegistry([DEFINITION], { library: LIBRARY });
REGISTRY.seal();

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

/** Counts every DIRECT provider call. The facade may never raise it. */
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

const context: ContentContext = {
  principal,
  organization: { organizationId: ORG, status: 'active' },
  workspace: { workspaceId: WS, organizationId: ORG, status: 'active' },
  requestId: '018f7a1e-0000-7000-8000-0000000000ee',
  correlationId: CORRELATION,
};

/** One store behind every service, so the whole platform shares its state. */
function memoryStore() {
  const runs = new Map<string, StoredContentRun>();
  const artifacts = new Map<string, readonly StoredArtifact[]>();
  const drafts = new Map<string, ContentDraft>();

  const clockOf = (runId: string): string =>
    runs.get(runId)?.execution.timings.createdAt ?? '1970-01-01T00:00:00.000Z';

  const compare = (
    leftKey: string,
    leftTie: string,
    rightKey: string,
    rightTie: string,
  ): number => {
    if (leftKey !== rightKey) return leftKey < rightKey ? -1 : 1;
    if (leftTie !== rightTie) return leftTie < rightTie ? -1 : 1;
    return 0;
  };

  const store: ContentSearchStore = {
    saveRun: (input) => {
      runs.set(input.run.runId, input.run);
      artifacts.set(input.run.runId, input.artifacts);
      return Promise.resolve();
    },
    loadRun: (runId) => Promise.resolve(runs.get(runId) ?? null),
    loadArtifacts: (runId) => Promise.resolve(artifacts.get(runId) ?? []),
    updateStatus: () => Promise.resolve(),
    queryRuns: (criteria) => {
      const matched = [...runs.values()].filter(
        (entry) =>
          criteria.workspaceId === null || entry.execution.workspaceId === criteria.workspaceId,
      );
      const ordered = matched.sort((left, right) => {
        const value = compare(
          left.execution.timings.createdAt,
          left.runId,
          right.execution.timings.createdAt,
          right.runId,
        );
        return criteria.order === 'newest' ? -value : value;
      });
      const after = criteria.after;
      const remaining =
        after === null
          ? ordered
          : ordered.filter((entry) => {
              const value = compare(
                entry.execution.timings.createdAt,
                entry.runId,
                after.createdAt,
                after.runId,
              );
              return criteria.order === 'newest' ? value < 0 : value > 0;
            });
      return Promise.resolve({ runs: remaining.slice(0, criteria.limit) });
    },
    saveDraft: (draft) => {
      drafts.set(draft.draftId, draft);
      return Promise.resolve();
    },
    loadDraft: (draftId) => Promise.resolve(drafts.get(draftId) ?? null),
    updateDraft: (input) => {
      drafts.set(input.draft.draftId, input.draft);
      return Promise.resolve();
    },
    deleteDraft: (draftId) => {
      drafts.delete(draftId);
      return Promise.resolve();
    },
    listDrafts: (criteria) =>
      Promise.resolve({
        drafts: [...drafts.values()]
          .filter(
            (entry) =>
              criteria.workspaceId === null || entry.metadata.workspaceId === criteria.workspaceId,
          )
          .slice(0, criteria.limit),
      }),
    queryDrafts: (criteria) => {
      const matched = [...drafts.values()].filter(
        (entry) =>
          criteria.workspaceId === null || entry.metadata.workspaceId === criteria.workspaceId,
      );
      const ordered = matched.sort((left, right) => {
        const value = compare(left.updatedAt, left.draftId, right.updatedAt, right.draftId);
        return criteria.order === 'newest' ? -value : value;
      });
      const after = criteria.after;
      const remaining =
        after === null
          ? ordered
          : ordered.filter((entry) => {
              const value = compare(entry.updatedAt, entry.draftId, after.updatedAt, after.draftId);
              return criteria.order === 'newest' ? value < 0 : value > 0;
            });
      return Promise.resolve({ drafts: remaining.slice(0, criteria.limit) });
    },
    queryArtifacts: (criteria) => {
      const all = [...artifacts.values()].flat();
      const tie = (entry: StoredArtifact): string => `${entry.runId}#${String(entry.sequence)}`;
      const ordered = all.sort((left, right) => {
        const value = compare(clockOf(left.runId), tie(left), clockOf(right.runId), tie(right));
        return criteria.order === 'newest' ? -value : value;
      });
      const after = criteria.after;
      const remaining =
        after === null
          ? ordered
          : ordered.filter((entry) => {
              const value = compare(
                clockOf(entry.runId),
                tie(entry),
                after.createdAt,
                `${after.runId}#${String(after.sequence)}`,
              );
              return criteria.order === 'newest' ? value < 0 : value > 0;
            });
      const kept = remaining.slice(0, criteria.limit);
      const runCreatedAt: Record<string, string> = {};
      for (const entry of kept) runCreatedAt[entry.runId] = clockOf(entry.runId);
      return Promise.resolve({ artifacts: kept, runCreatedAt });
    },
  };

  return { store, runs, artifacts, drafts };
}

/** The whole platform, wired once, fronted by the facade. */
function platform() {
  const bench = memoryStore();

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

  const drafts = createDraftService({
    repository: bench.store,
    workflows: REGISTRY,
    templates: LIBRARY,
    now: () => NOW,
    newDraftId: () => 'draft-1',
  });

  const orchestrator = createOrchestrator({
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
    runs: bench.store,
  });

  const history = createRunHistory({ store: bench.store });
  const search = createContentSearch({ store: bench.store });
  const exports = createContentExport({
    history,
    drafts,
    search,
    now: () => NOW,
    newExportId: () => 'export-1',
  });

  return {
    ...bench,
    facade: createContentManagement({
      drafts,
      // Draft Management's compiler, with its registries already bound. The
      // facade never sees a registry.
      compiler: {
        compile: (input: Omit<CompileDraftOptions, 'workflows' | 'templates' | 'providers'>) =>
          compileDraft({ ...input, workflows: REGISTRY, templates: LIBRARY }),
      },
      orchestrator,
      history,
      search,
      exports,
    }),
  };
}

const ask = (operation: string, payload: unknown): ContentRequest =>
  ({ operation, context, payload }) as unknown as ContentRequest;

// ── 1 · The whole platform, through one door ────────────────────────────────

describe('a whole content lifecycle, through the facade only', () => {
  it('creates, readies, submits and runs — then finds all of it', async () => {
    providerCalls.executed = 0;
    const { facade } = platform();

    const created = await facade.execute(
      ask('createDraft', {
        title: 'An article about tenancy',
        tags: ['article'],
        workflowId: 'article.draft',
        workflowVersion: 2,
        inputs: { topic: 'multi-tenancy' },
      }),
    );
    expect(created.outcome).toBe('ok');

    const ready = await facade.execute(
      ask('updateDraft', { draftId: 'draft-1', transition: 'ready', note: 'Validated.' }),
    );
    expect(ready.outcome).toBe('ok');

    const submitted = await facade.execute(
      ask('submitDraft', {
        draftId: 'draft-1',
        model: 'gpt-4o',
        timeoutMs: 30_000,
        idempotencyKey: 'idem-1',
      }),
    );

    expect(submitted.outcome).toBe('ok');
    if (submitted.outcome !== 'ok' || submitted.data.kind !== 'submitted') {
      throw new Error('expected a submission');
    }
    expect(submitted.data.run.outcome).toBe('completed');
    expect(submitted.data.run.run.state.artifacts).toHaveLength(2);

    // Everything the run produced is now findable through the same door.
    const run = await facade.execute(ask('getRun', { runId: 'run-1' }));
    expect(run.outcome).toBe('ok');
    if (run.outcome === 'ok' && run.data.kind === 'run') {
      expect(run.data.run.workflowRef).toBe('article.draft@2');
    }

    const runs = await facade.execute(ask('listRuns', {}));
    expect(runs.outcome).toBe('ok');
    if (runs.outcome === 'ok' && runs.data.kind === 'runs') {
      expect(runs.data.page.items).toHaveLength(1);
    }

    const artifacts = await facade.execute(ask('search', { kind: 'artifacts' }));
    expect(artifacts.outcome).toBe('ok');
    if (artifacts.outcome === 'ok' && artifacts.data.kind === 'hits') {
      expect(artifacts.data.page.items).toHaveLength(2);
    }

    const exported = await facade.execute(
      ask('export', { target: { kind: 'run', runId: 'run-1' }, format: 'json' }),
    );
    expect(exported.outcome).toBe('ok');
    if (exported.outcome === 'ok' && exported.data.kind === 'export') {
      expect(exported.data.export.body).toContain('planning.outline@4');
    }

    // Not one provider call went round the executor.
    expect(providerCalls.executed).toBe(0);
  });

  it('records the draft as submitted, and it stays that way', async () => {
    const { facade } = platform();

    await facade.execute(
      ask('createDraft', {
        title: 'An article',
        workflowId: 'article.draft',
        workflowVersion: 2,
        inputs: { topic: 'multi-tenancy' },
      }),
    );
    await facade.execute(
      ask('updateDraft', { draftId: 'draft-1', transition: 'ready', note: 'Validated.' }),
    );
    await facade.execute(
      ask('submitDraft', {
        draftId: 'draft-1',
        model: 'gpt-4o',
        timeoutMs: 30_000,
        idempotencyKey: 'idem-1',
      }),
    );

    const read = await facade.execute(ask('getDraft', { draftId: 'draft-1' }));
    if (read.outcome !== 'ok' || read.data.kind !== 'draft') throw new Error('expected a draft');
    expect(read.data.draft.revisions[read.data.draft.revisions.length - 1]?.status).toBe(
      'submitted',
    );

    // Submitted is terminal, and the facade does not make it otherwise.
    const edited = await facade.execute(
      ask('updateDraft', { draftId: 'draft-1', transition: 'edit', note: 'Too late.' }),
    );
    expect(edited.outcome).toBe('refused');
    if (edited.outcome !== 'refused') return;
    expect(edited.code).toBe('IllegalTransition');
  });

  it('lists and searches only the caller’s own workspace', async () => {
    const { facade } = platform();
    await facade.execute(
      ask('createDraft', {
        title: 'Mine',
        workflowId: 'article.draft',
        workflowVersion: 2,
        inputs: { topic: 'x' },
      }),
    );

    const listed = await facade.execute(ask('listDrafts', {}));
    if (listed.outcome !== 'ok' || listed.data.kind !== 'drafts')
      throw new Error('expected a list');
    expect(listed.data.drafts).toHaveLength(1);

    // A caller naming somebody else's workspace is refused, never served.
    const crossed = await facade.execute(
      ask('search', { kind: 'drafts', query: { filter: { workspaceId: 'ws-somebody-else' } } }),
    );
    expect(crossed.outcome).toBe('refused');
    if (crossed.outcome !== 'refused') return;
    expect(crossed.code).toBe('ContradictoryRequest');
  });

  it('refuses a draft that never became ready, without running anything', async () => {
    const { facade } = platform();
    await facade.execute(
      ask('createDraft', {
        title: 'An article',
        workflowId: 'article.draft',
        workflowVersion: 2,
        inputs: { topic: 'x' },
      }),
    );

    const submitted = await facade.execute(
      ask('submitDraft', {
        draftId: 'draft-1',
        model: 'gpt-4o',
        timeoutMs: 30_000,
        idempotencyKey: 'idem-1',
      }),
    );

    expect(submitted.outcome).toBe('refused');
    if (submitted.outcome !== 'refused') return;
    expect(submitted.code).toBe('NotReady');

    const read = await facade.execute(ask('getDraft', { draftId: 'draft-1' }));
    if (read.outcome !== 'ok' || read.data.kind !== 'draft') throw new Error('expected a draft');
    // Never marked. A draft that could not compile was never submitted.
    expect(read.data.draft.revisions).toHaveLength(1);
  });
});

// ── 2 · It imports nothing it may not ───────────────────────────────────────

describe('the facade reaches past nothing', () => {
  it('imports no repository or store', () => {
    for (const file of FACADE_MODULES) {
      const code = codeOf(file);
      expect(code).not.toMatch(/Repository|SearchStore|HistoryStore|Criteria/);
      expect(code).not.toMatch(/@contentos\/database/);
    }
  });

  it('imports no provider or model SDK', () => {
    for (const file of FACADE_MODULES) {
      const code = codeOf(file);
      expect(code).not.toMatch(/from '\.\.\/providers\//);
      expect(code).not.toMatch(/ProviderRegistry|ModelProvider/);
      expect(code).not.toMatch(/from '(openai|@anthropic-ai\/sdk)'/);
    }
  });

  it('imports no workflow runtime', () => {
    for (const file of FACADE_MODULES) {
      const code = codeOf(file);
      expect(code).not.toMatch(/from '\.\.\/workflow\//);
      expect(code).not.toMatch(/loadStep\(|preparePrompt\(|buildRequest\(|recordExecution\(/);
    }
  });

  it('imports no registry or library', () => {
    // Compilation arrives as a port with its registries already bound: a
    // registry is not one of the five services this layer may reuse.
    for (const file of FACADE_MODULES) {
      const code = codeOf(file);
      expect(code).not.toMatch(/WorkflowRegistry|TemplateLibrary|ModelCatalogue|PricingRegistry/);
    }
    expect(codeOf('service.ts')).toMatch(/interface DraftCompiler/);
  });

  it('imports no routing, retry or streaming', () => {
    for (const file of FACADE_MODULES) {
      const code = codeOf(file);
      expect(code).not.toMatch(/from '\.\.\/routing\/|from '\.\.\/retry\/|from '\.\.\/streaming\//);
    }
  });

  it('holds exactly the five services it may reuse', () => {
    const code = codeOf('service.ts');
    for (const held of [
      'readonly drafts: DraftService',
      'readonly compiler: DraftCompiler',
      'readonly orchestrator: Orchestrator',
      'readonly history: RunHistoryService',
      'readonly search: ContentSearchService',
      'readonly exports: ContentExportService',
    ]) {
      expect(code).toContain(held);
    }
  });

  it('writes no SQL and opens no connection', () => {
    for (const file of FACADE_MODULES) {
      const code = codeOf(file);
      expect(code).not.toMatch(/SELECT .+ FROM |INSERT INTO|createPool|\.query\(/i);
    }
  });
});

// ── 3 · It creates no identity ──────────────────────────────────────────────

describe('the facade invents nothing', () => {
  it('reads no clock and generates no id', () => {
    for (const file of FACADE_MODULES) {
      const code = codeOf(file);
      expect(code).not.toMatch(/Date\.now\(|Math\.random\(|randomUUID|crypto\./);
    }
  });

  it('takes no clock or id generator in its options', () => {
    // There is nothing to inject, because there is nothing to make up.
    const code = codeOf('service.ts');
    expect(code).not.toMatch(/readonly now:/);
    expect(code).not.toMatch(/readonly new\w+Id:/);
  });

  it('propagates the resolved principal unchanged', async () => {
    const { facade, drafts } = platform();
    await facade.execute(
      ask('createDraft', {
        title: 'An article',
        workflowId: 'article.draft',
        workflowVersion: 2,
        inputs: { topic: 'x' },
      }),
    );

    const stored = drafts.get('draft-1');
    expect(stored?.metadata.principalId).toBe(principal.subjectId);
    expect(stored?.metadata.workspaceId).toBe(WS);
    expect(stored?.metadata.organizationId).toBe(ORG);
  });

  it('propagates the correlation id into the run it starts', async () => {
    const { facade, runs } = platform();
    await facade.execute(
      ask('createDraft', {
        title: 'An article',
        workflowId: 'article.draft',
        workflowVersion: 2,
        inputs: { topic: 'multi-tenancy' },
      }),
    );
    await facade.execute(
      ask('updateDraft', { draftId: 'draft-1', transition: 'ready', note: 'Validated.' }),
    );
    await facade.execute(
      ask('submitDraft', {
        draftId: 'draft-1',
        model: 'gpt-4o',
        timeoutMs: 30_000,
        idempotencyKey: 'idem-1',
      }),
    );

    expect(runs.get('run-1')?.execution.correlationId).toBe(CORRELATION);
    // The idempotency key is the caller's, never the request id.
    expect(runs.get('run-1')?.execution.idempotencyKey).toBe('idem-1');
  });

  it('echoes the request id back, and never the principal', async () => {
    const { facade } = platform();
    const result = await facade.execute(ask('listDrafts', {}));

    expect(result.trace.requestId).toBe(context.requestId);
    expect(result.trace.correlationId).toBe(CORRELATION);
    expect(JSON.stringify(result.trace)).not.toContain('article:execute');
  });
});

// ── 4 · One delegation, and no throwing ─────────────────────────────────────

describe('the facade implements nothing', () => {
  it('has no filtering, ordering, paging or pricing of its own', () => {
    for (const file of FACADE_MODULES) {
      const code = codeOf(file);
      expect(code).not.toMatch(/\.sort\(|nextCursor|encodeCursor|decodeCursor/);
      expect(code).not.toMatch(/perMillion|BigInt\(|canonicalJson/);
    }
  });

  it('runs no state machine of its own', () => {
    for (const file of FACADE_MODULES) {
      expect(codeOf(file)).not.toMatch(/TRANSITION_RULES|assertTransitionAllowed/);
    }
  });

  it('answers every operation it declares', async () => {
    const { facade } = platform();
    await facade.execute(
      ask('createDraft', {
        title: 'An article',
        workflowId: 'article.draft',
        workflowVersion: 2,
        inputs: { topic: 'x' },
      }),
    );

    const payloads: Readonly<Record<string, unknown>> = {
      createDraft: { title: 't', workflowId: 'article.draft', workflowVersion: 2, inputs: {} },
      updateDraft: { draftId: 'draft-1', transition: 'edit', note: 'n' },
      deleteDraft: { draftId: 'draft-1' },
      getDraft: { draftId: 'draft-1' },
      listDrafts: {},
      submitDraft: { draftId: 'draft-1', model: 'm', timeoutMs: 1, idempotencyKey: 'k' },
      getRun: { runId: 'run-1' },
      listRuns: {},
      search: { kind: 'runs' },
      export: { target: { kind: 'artifacts' }, format: 'json' },
    };

    for (const operation of CONTENT_OPERATIONS) {
      const result = await facade.execute(ask(operation, payloads[operation]));
      // Every one answers with a code rather than an exception, whether or not
      // the platform's state happens to allow it.
      expect(['ok', 'refused']).toContain(result.outcome);
      expect(result.operation).toBe(operation);
    }
  });

  it('never throws, whatever it is handed', async () => {
    const { facade } = platform();

    for (const request of [
      { operation: 'getDraft' },
      { operation: 'getDraft', context: undefined, payload: {} },
      { operation: 'nonsense', context, payload: {} },
      { operation: 'export', context, payload: { format: 'zip', target: { kind: 'run' } } },
    ]) {
      const result = await facade.execute(request as unknown as ContentRequest);
      expect(result.outcome).toBe('refused');
    }
  });

  it('keeps the promise in one place, not ten', () => {
    // A guard per operation is a guard somebody forgets in the eleventh.
    expect(codeOf('service.ts')).toMatch(/function guarded\(/);
  });
});

// ── 5 · Deviations ──────────────────────────────────────────────────────────

describe('recorded deviations', () => {
  it('DEVIATION: compilation arrives as a PORT, not a registry', () => {
    // `compileDraft` needs a workflow registry and a template library, and
    // neither is one of the five services this layer may reuse. Binding them in
    // the composition root keeps the facade holding services only.
    expect(codeOf('service.ts')).toMatch(/interface DraftCompiler/);
    expect(codeOf('service.ts')).not.toMatch(/WorkflowRegistry/);
  });

  it('DEVIATION: `ServiceFailed` is a new code', () => {
    // Nothing in the existing taxonomy means "a delegate threw", and something
    // has to: a service that raises rather than refusing is a fault, not an
    // answer, and a caller told `InvalidRequest` would go looking for its own
    // mistake.
    expect(codeOf('service.ts')).toMatch(/'ServiceFailed'/);
  });

  it('DEVIATION: submit marks the draft BEFORE it runs', () => {
    // The draft is the record of what was submitted, and it was — whatever the
    // orchestrator then makes of it. Compilation comes first, so a draft that
    // could not compile is never left claiming otherwise.
    const code = codeOf('service.ts');
    expect(code.indexOf('compiler.compile(')).toBeLessThan(code.indexOf("transition: 'submit'"));
    expect(code.indexOf("transition: 'submit'")).toBeLessThan(code.indexOf('orchestrator.start('));
  });

  it('DEVIATION: a failed run is a successful submission', () => {
    // Conflating them would make "the platform refused you" and "the model
    // refused you" the same answer, and they call for opposite actions.
    expect(codeOf('service.ts')).toMatch(/kind: 'submitted'/);
  });

  it('DEVIATION: tenancy on a create comes from the context, not the payload', () => {
    // A payload that could name it would be a way to create a draft somewhere
    // else, or in somebody else's name, by asking.
    expect(codeOf('model.ts')).toMatch(/interface CreateDraftPayload/);
    expect(codeOf('model.ts')).not.toMatch(/interface CreateDraftPayload \{[^}]*organizationId/s);
    expect(codeOf('service.ts')).toMatch(/organizationId: context\.organization\.organizationId/);
  });

  it('DEVIATION: a filter naming another tenancy is refused, not overruled', () => {
    expect(codeOf('validation.ts')).toMatch(/checkTenancyFilter/);
  });

  it('DEVIATION: the response echoes the trace, never the principal', () => {
    expect(codeOf('model.ts')).toMatch(/interface ContentTrace/);
    expect(codeOf('model.ts')).not.toMatch(/interface ContentTrace \{[^}]*principal/s);
  });

  it('DEVIATION: refusals are values, and nothing throws', () => {
    expect(codeOf('service.ts')).toMatch(/outcome: 'refused'/);
    expect(codeOf('service.ts')).not.toMatch(/throw new/);
  });
});
