/**
 * Content search against everything it discovers and everything it must not do.
 *
 * ── What only this file can check ───────────────────────────────────────────
 *
 * 1. IT FINDS WHAT REALLY HAPPENED. Runs produced by the ORCHESTRATOR, stored
 *    through the S4.4 repository, and a draft made by the S4.6 service, all
 *    come back out of one search vocabulary. Five increments end to end.
 *
 * 2. IT REUSES, IT DOES NOT REIMPLEMENT. Run search IS history's query — the
 *    same service, the same cursor, the same record checks. There is no second
 *    cursor format and no second pager for runs anywhere in the package.
 *
 * 3. IT NEVER EXECUTES AND NEVER WRITES. No provider is called, and no save,
 *    update or delete reaches the store through a whole search session.
 *    Structural AND behavioural.
 *
 * 4. NO PERSISTENCE FIELDS LEAK, and a draft hit carries no inputs.
 *
 * 5. THE DEVIATIONS, recorded so they cannot be forgotten.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  createContentSearch,
  createDraftService,
  createModelCatalogue,
  createOrchestrator,
  createPricingRegistry,
  createProviderRegistry,
  createRouter,
  createRoutingTable,
  createTemplateLibrary,
  createWorkflowRegistry,
  PERSISTENCE_ONLY_FIELDS,
  SEARCH_CODES,
  SEARCH_KINDS,
  SUPPORTED_FILTERS,
  WITHHELD_DRAFT_FIELDS,
  type ContentDraft,
  type ContentSearchStore,
  type ContentWorkflowDefinition,
  type DraftMetadata,
  type ModelProvider,
  type PromptTemplate,
  type StoredArtifact,
  type SearchResult,
  type StoredContentRun,
  type WorkflowStepDefinition,
} from '@contentos/ai';
import type { AIRequest, AIResponse } from '@contentos/contracts';
import type { Principal } from '@contentos/security';
import { describe, expect, it } from 'vitest';

const ORG = '018f7a1e-0000-7000-8000-0000000000aa';
const WS = '018f7a1e-0000-7000-8000-0000000000bb';
const CORRELATION = '018f7a1e-0000-7000-8000-0000000000dd';

const searchDir = new URL('../../packages/ai/src/search/', import.meta.url);

const codeOf = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, searchDir)), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

/** Every module of the search package, tests excluded. */
const SEARCH_MODULES: readonly string[] = readdirSync(fileURLToPath(searchDir)).filter(
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

/** Counts every direct provider call. Search may never raise it. */
const providerCalls = { executed: 0 };

function provider(): ModelProvider {
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
  authenticatedAt: new Date('2026-07-31T12:00:00.000Z'),
  mfaSatisfied: true,
  sessionId: 'session-1',
};

const draftMetadata: DraftMetadata = {
  organizationId: ORG,
  workspaceId: WS,
  principalId: principal.subjectId,
  principalKind: 'user',
  title: 'An article about tenancy',
  tags: ['article', 'seo'],
};

/**
 * One store honouring every contract at once.
 *
 * `ContentSearchStore` extends the S4.5 history store — itself the frozen S4.4
 * repository — and the S4.6 draft repository. The SAME instance is what the
 * orchestrator writes runs through, what the draft service writes drafts
 * through, and what search reads.
 */
function memoryStore() {
  const runs = new Map<string, StoredContentRun>();
  const artifacts = new Map<string, readonly StoredArtifact[]>();
  const drafts = new Map<string, ContentDraft>();
  const calls = { saveRun: 0, saveDraft: 0, updateStatus: 0, updateDraft: 0, deleteDraft: 0 };

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
      calls.saveRun += 1;
      runs.set(input.run.runId, input.run);
      artifacts.set(input.run.runId, input.artifacts);
      return Promise.resolve();
    },
    loadRun: (runId) => Promise.resolve(runs.get(runId) ?? null),
    loadArtifacts: (runId) => Promise.resolve(artifacts.get(runId) ?? []),
    updateStatus: () => {
      calls.updateStatus += 1;
      return Promise.resolve();
    },

    queryRuns: (criteria) => {
      const matched = [...runs.values()].filter((entry) => {
        const { execution } = entry;
        if (criteria.workspaceId !== null && execution.workspaceId !== criteria.workspaceId)
          return false;
        if (criteria.workflowId !== null && execution.workflowId !== criteria.workflowId)
          return false;
        if (criteria.statuses !== null && !criteria.statuses.includes(entry.status)) return false;
        return true;
      });
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
      calls.saveDraft += 1;
      drafts.set(draft.draftId, draft);
      return Promise.resolve();
    },
    loadDraft: (draftId) => Promise.resolve(drafts.get(draftId) ?? null),
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
    listDrafts: (criteria) =>
      Promise.resolve({ drafts: [...drafts.values()].slice(0, criteria.limit) }),

    queryDrafts: (criteria) => {
      const matched = [...drafts.values()].filter((entry) => {
        if (criteria.workspaceId !== null && entry.metadata.workspaceId !== criteria.workspaceId)
          return false;
        if (
          criteria.tags !== null &&
          !criteria.tags.every((tag) => entry.metadata.tags.includes(tag))
        )
          return false;
        return true;
      });
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
      const matched = all.filter(
        (entry) => criteria.runId === null || entry.runId === criteria.runId,
      );
      const tie = (entry: StoredArtifact): string => `${entry.runId}#${String(entry.sequence)}`;
      const ordered = matched.sort((left, right) => {
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

  return { store, calls, runs, artifacts, drafts };
}

function orchestratorFor(store: ContentSearchStore, clock: () => Date, ids: () => string) {
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
    now: clock,
    newRunId: ids,
    delay: () => Promise.resolve(),
    runs: store,
  });
}

/** Two real runs and one real draft, all through the layers that own them. */
async function seeded() {
  const bench = memoryStore();

  for (const index of [1, 2]) {
    const orchestrator = orchestratorFor(
      bench.store,
      () => new Date(`2026-07-31T12:0${String(index)}:00.000Z`),
      () => `run-${String(index)}`,
    );
    const result = await orchestrator.start({
      workflowId: 'article.draft',
      selector: { kind: 'latest-stable' },
      variables: { topic: 'multi-tenancy' },
      metadata: {
        principal,
        organization: { organizationId: ORG, status: 'active' },
        workspace: { workspaceId: WS, organizationId: ORG, status: 'active' },
        correlationId: CORRELATION,
        idempotencyKey: `idem-${String(index)}`,
      },
      model: 'gpt-4o',
      timeoutMs: 30_000,
      promptTemplates: TEMPLATES,
    });
    if (result.outcome !== 'completed') throw new Error('expected a completed run');
  }

  const drafts = createDraftService({
    repository: bench.store,
    workflows: REGISTRY,
    templates: LIBRARY,
    now: () => new Date('2026-07-31T12:05:00.000Z'),
    newDraftId: () => 'draft-1',
  });

  const created = await drafts.create({
    metadata: draftMetadata,
    workflowId: 'article.draft',
    workflowVersion: 2,
    inputs: { topic: 'multi-tenancy' },
  });
  if (created.outcome !== 'ok') throw new Error(`expected a draft: ${created.reason}`);

  return { ...bench, drafts, search: createContentSearch({ store: bench.store }) };
}

// ── 1 · It finds what really happened ───────────────────────────────────────

describe('search over what the platform actually produced', () => {
  it('finds the runs the orchestrator ran', async () => {
    const { search } = await seeded();
    const result = await search.searchRuns({ filter: { workspaceId: WS } });

    expect(result.outcome).toBe('ok');
    if (result.outcome !== 'ok') return;
    expect(result.page.items.map((hit) => hit.kind === 'run' && hit.run.runId)).toEqual([
      'run-2',
      'run-1',
    ]);
  });

  it('finds the artifacts those runs produced, across both of them', async () => {
    const { search } = await seeded();
    const result = await search.searchArtifacts({ order: 'oldest' });

    if (result.outcome !== 'ok') return;
    expect(
      result.page.items.map(
        (hit) => hit.kind === 'artifact' && `${hit.artifact.runId}:${hit.artifact.stepId}`,
      ),
    ).toEqual(['run-1:outline', 'run-1:draft', 'run-2:outline', 'run-2:draft']);
  });

  it('finds the draft the draft service made', async () => {
    const { search } = await seeded();
    const result = await search.searchDrafts({ filter: { tags: ['article'] } });

    if (result.outcome !== 'ok') return;
    expect(result.page.items.map((hit) => hit.kind === 'draft' && hit.draft.draftId)).toEqual([
      'draft-1',
    ]);
  });

  it('carries the provenance every layer contributed', async () => {
    const { search } = await seeded();
    const runs = await search.searchRuns();
    const artifacts = await search.searchArtifacts();
    const drafts = await search.searchDrafts();

    if (runs.outcome !== 'ok' || artifacts.outcome !== 'ok' || drafts.outcome !== 'ok') {
      throw new Error('expected pages');
    }

    const run = runs.page.items[0];
    const artifact = artifacts.page.items[0];
    const draft = drafts.page.items[0];

    if (run?.kind !== 'run' || artifact?.kind !== 'artifact' || draft?.kind !== 'draft') {
      throw new Error('expected one of each');
    }

    expect(run.run.workflowRef).toBe('article.draft@2');
    expect(run.run.templateVersions.map((entry) => entry.promptVersion)).toEqual([
      'planning.outline@4',
      'writing.draft@4',
    ]);
    expect(artifact.artifact.usage.totalTokens).toBe(30);
    expect(artifact.artifact.prompt.promptVersion).toMatch(/@4$/);
    expect(draft.draft.workflowRef).toBe('article.draft@2');
    expect(draft.draft.templateReferences.map((entry) => entry.promptVersion)).toEqual([
      'planning.outline@4',
      'writing.draft@4',
    ]);
  });
});

// ── 2 · It reuses, it does not reimplement ──────────────────────────────────

describe('run search IS history search', () => {
  it('hands the query to the S4.5 service', () => {
    const code = codeOf('service.ts');
    expect(code).toMatch(/createRunHistory\(/);
    expect(code).toMatch(/history\.listRuns\(/);
    expect(code).toMatch(/history\.getRunById\(/);
  });

  it('never queries runs itself', () => {
    // History owns the run filter, the record checks, the ordering and the
    // paging. A second path would be a second set of answers.
    expect(codeOf('service.ts')).not.toMatch(/store\.queryRuns\(/);
  });

  it('produces exactly the page history would', async () => {
    const { store, search } = await seeded();
    const { createRunHistory } = await import('@contentos/ai');
    const history = createRunHistory({ store });

    const searched = await search.searchRuns({ limit: 1 });
    const listed = await history.listRuns({ limit: 1 });

    if (searched.outcome !== 'ok' || listed.outcome !== 'ok') throw new Error('expected pages');
    expect(searched.page.items.map((hit) => hit.kind === 'run' && hit.run)).toEqual([
      listed.page.items[0],
    ]);
    expect(searched.page.nextCursor).toBe(listed.page.nextCursor);
  });

  it('defines no cursor of its own', () => {
    // One format, one version, one fingerprint scheme. A cursor is the thing
    // that crosses a wire, and two encodings would be two things to get wrong.
    for (const file of SEARCH_MODULES) {
      const code = codeOf(file);
      expect(code).not.toMatch(/base64|CURSOR_VERSION\s*=/);
      expect(code).not.toMatch(/function (createCursor|encodeCursor|decodeCursor)/);
    }
    expect(codeOf('service.ts')).toMatch(/from '\.\.\/history\/cursor\.js'/);
  });

  it('reuses history’s codes, orders and bounds', () => {
    expect(codeOf('service.ts')).toMatch(/\.\.\.RUN_HISTORY_CODES/);
    expect(codeOf('query.ts')).toMatch(/RUN_HISTORY_ORDERS/);
    expect(codeOf('query.ts')).toMatch(/MAX_RUN_HISTORY_LIMIT/);
  });

  it('reuses the persistence validators for artifacts', () => {
    const code = codeOf('service.ts');
    expect(code).toMatch(/validateStoredArtifact\(/);
    expect(code).toMatch(/isSupportedSchemaVersion\(/);
  });

  it('extends the frozen contracts rather than replacing them', () => {
    expect(codeOf('store.ts')).toMatch(
      /interface ContentSearchStore extends ContentRunHistoryStore, DraftRepository/,
    );
  });
});

// ── 3 · It never executes and never writes ──────────────────────────────────

describe('search changes nothing', () => {
  it('calls no provider through a whole session', async () => {
    providerCalls.executed = 0;
    const { search } = await seeded();

    await search.searchRuns();
    await search.searchDrafts();
    await search.searchArtifacts();

    expect(providerCalls.executed).toBe(0);
  });

  it('writes nothing to the store', async () => {
    const bench = await seeded();
    const before = { ...bench.calls };

    await bench.search.searchRuns();
    await bench.search.searchDrafts();
    await bench.search.searchArtifacts();

    expect(bench.calls.saveRun).toBe(before.saveRun);
    expect(bench.calls.saveDraft).toBe(before.saveDraft);
    expect(bench.calls.updateStatus).toBe(before.updateStatus);
    expect(bench.calls.updateDraft).toBe(before.updateDraft);
    expect(bench.calls.deleteDraft).toBe(before.deleteDraft);
  });

  it('calls no write method anywhere in its source', () => {
    for (const file of SEARCH_MODULES) {
      const code = codeOf(file);
      expect(code).not.toMatch(/\.saveRun\(|\.saveDraft\(|\.updateStatus\(|\.updateDraft\(/);
      expect(code).not.toMatch(/\.deleteDraft\(/);
    }
  });

  it('has no execution path at all', () => {
    for (const file of SEARCH_MODULES) {
      const code = codeOf(file);
      expect(code).not.toMatch(/createOrchestrator|\.execute\(|\.dispatch\(|\.stream\(/);
      expect(code).not.toMatch(/loadStep\(|preparePrompt\(|buildRequest\(|recordExecution\(/);
      expect(code).not.toMatch(/from '\.\.\/routing\/|from '\.\.\/retry\/|from '\.\.\/providers\//);
    }
  });

  it('compiles nothing and resolves nothing', () => {
    for (const file of SEARCH_MODULES) {
      expect(codeOf(file)).not.toMatch(/compileDraft\(|compilePrompt\(|resolveWorkflow\(/);
    }
  });
});

describe('the search layer knows of no database', () => {
  it('imports no database package, driver or ORM', () => {
    for (const file of SEARCH_MODULES) {
      const code = codeOf(file);
      expect(code).not.toMatch(/@contentos\/database/);
      expect(code).not.toMatch(/from '(pg|postgres|mysql2|ioredis|redis|knex|drizzle|prisma)/);
    }
  });

  it('writes no SQL and opens no connection', () => {
    for (const file of SEARCH_MODULES) {
      const code = codeOf(file);
      expect(code).not.toMatch(/SELECT .+ FROM |INSERT INTO|ORDER BY|LIMIT \d/i);
      expect(code).not.toMatch(/createPool|new Client\(|\.connect\(|\.query\(/);
    }
  });

  it('ships a port and no implementation of it', () => {
    const code = codeOf('store.ts');
    expect(code).toMatch(/interface ContentSearchStore/);
    expect(code).not.toMatch(/^export (async )?function/m);
    expect(code).not.toMatch(/^export const/m);
  });

  it('pages by position, never by count', () => {
    for (const file of SEARCH_MODULES) {
      expect(codeOf(file)).not.toMatch(/\boffset\b|\bskip\b|\bpageNumber\b/i);
    }
  });
});

// ── 4 · Nothing leaks ───────────────────────────────────────────────────────

describe('what a hit carries', () => {
  it('no persistence-only field, on a run or an artifact', async () => {
    const { search } = await seeded();
    const runs = await search.searchRuns();
    const artifacts = await search.searchArtifacts();

    if (runs.outcome !== 'ok' || artifacts.outcome !== 'ok') throw new Error('expected pages');
    const run = runs.page.items[0];
    const artifact = artifacts.page.items[0];
    if (run?.kind !== 'run' || artifact?.kind !== 'artifact') throw new Error('expected hits');

    for (const field of PERSISTENCE_ONLY_FIELDS) {
      expect(Object.keys(run.run)).not.toContain(field);
      expect(Object.keys(artifact.artifact)).not.toContain(field);
    }
  });

  it('no draft inputs', async () => {
    // A listing that returned everything anybody had typed, across a workspace,
    // is a disclosure decision nobody asked search to make.
    const { search } = await seeded();
    const result = await search.searchDrafts();

    if (result.outcome !== 'ok') return;
    const hit = result.page.items[0];
    if (hit?.kind !== 'draft') throw new Error('expected a draft hit');
    for (const field of WITHHELD_DRAFT_FIELDS) {
      expect(Object.keys(hit.draft)).not.toContain(field);
    }
  });

  it('no authority of any kind', async () => {
    const { search } = await seeded();
    const drafts = await search.searchDrafts();
    const runs = await search.searchRuns();

    const flat = JSON.stringify([drafts, runs]);
    expect(flat).not.toContain('editor');
    expect(flat).not.toContain('article:execute');
    expect(flat).not.toContain('session-1');
  });

  it('is frozen through', async () => {
    const { search } = await seeded();
    const result = await search.searchDrafts();

    if (result.outcome !== 'ok') return;
    expect(Object.isFrozen(result.page.items[0])).toBe(true);
    expect(() => {
      (result.page.items as { length: number }).length = 0;
    }).toThrow();
  });
});

// ── Filtering and paging across kinds ───────────────────────────────────────

describe('one vocabulary, three kinds', () => {
  it('declares which dimensions each kind can honour', () => {
    expect([...SEARCH_KINDS]).toEqual(['runs', 'drafts', 'artifacts']);
    expect(SUPPORTED_FILTERS.runs).not.toContain('tags');
    expect(SUPPORTED_FILTERS.drafts).toContain('tags');
  });

  it('refuses a dimension a kind cannot honour rather than dropping it', async () => {
    const { search } = await seeded();
    const result = await search.searchRuns({ filter: { tags: ['article'] } });

    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') return;
    expect(result.code).toBe('UnsupportedFilter');
  });

  it('walks every kind with a cursor, exactly once', async () => {
    const { search } = await seeded();

    const walks: readonly {
      readonly next: (cursor: string | null) => Promise<SearchResult>;
      readonly expected: number;
    }[] = [
      {
        next: (cursor) => search.searchRuns({ limit: 1, ...(cursor === null ? {} : { cursor }) }),
        expected: 2,
      },
      {
        next: (cursor) =>
          search.searchArtifacts({ limit: 1, ...(cursor === null ? {} : { cursor }) }),
        expected: 4,
      },
      {
        next: (cursor) => search.searchDrafts({ limit: 1, ...(cursor === null ? {} : { cursor }) }),
        expected: 1,
      },
    ];

    for (const { next: walkOne, expected } of walks) {
      let cursor: string | null = null;
      let seen = 0;
      for (let page = 0; page < 20; page += 1) {
        const result = await walkOne(cursor);
        if (result.outcome !== 'ok') throw new Error('expected a page');
        seen += result.page.items.length;
        cursor = result.page.nextCursor;
        if (cursor === null) break;
      }
      expect(seen).toBe(expected);
    }
  });

  it('never lets a cursor cross from one kind to another', async () => {
    const { search } = await seeded();
    const runs = await search.searchRuns({ limit: 1 });
    if (runs.outcome !== 'ok' || runs.page.nextCursor === null) throw new Error('expected more');

    const result = await search.searchArtifacts({ limit: 1, cursor: runs.page.nextCursor });

    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') return;
    expect(result.code).toBe('IncompatibleCursor');
  });
});

// ── 5 · Deviations ──────────────────────────────────────────────────────────

describe('recorded deviations', () => {
  it('DEVIATION: the store port extends BOTH frozen contracts', () => {
    // Search needs history's queries, the draft repository, and two keyset
    // queries neither has. Extending both keeps one implementation for a
    // composition root and changes nothing that is frozen. Loading everything
    // to filter in memory would be the duplicate query logic this forbids.
    expect(codeOf('store.ts')).toMatch(/extends ContentRunHistoryStore, DraftRepository/);
  });

  it('DEVIATION: a dimension a kind cannot honour is REFUSED', () => {
    // A run has no tags and an artifact has no draft. Ignoring such a filter
    // would hand back a result that looks correct and answers a different
    // question — the failure mode this layer exists to make impossible.
    expect(SEARCH_CODES).toContain('UnsupportedFilter');
    expect(codeOf('query.ts')).toMatch(/UNSUPPORTED_FILTER/);
  });

  it('DEVIATION: statuses are checked per kind, against different vocabularies', () => {
    // A run is `completed`; a draft is `ready`. Which are valid depends on what
    // is being searched, so the filter carries strings and the validator knows.
    expect(codeOf('query.ts')).toMatch(/STATUSES_OF/);
  });

  it('DEVIATION: the cursor position means something different per kind', () => {
    // The frozen cursor names an ordering key and a tiebreak. For a run they are
    // its clock and its id; for a draft, when it last changed and its id; for an
    // artifact, its run's clock and (run id, step index) packed together —
    // because one run holds several artifacts. One format, three meanings, and
    // the fingerprint carries the kind so they can never be confused.
    expect(codeOf('service.ts')).toMatch(/packArtifact/);
    expect(codeOf('query.ts')).toMatch(/kind=\$\{query\.kind\}/);
  });

  it('DEVIATION: a draft hit carries no inputs', () => {
    expect(WITHHELD_DRAFT_FIELDS).toContain('inputs');
    expect(codeOf('hits.ts')).toMatch(/WITHHELD_DRAFT_FIELDS/);
  });

  it('DEVIATION: refusals are values, not thrown errors', () => {
    expect(codeOf('service.ts')).toMatch(/outcome: 'refused'/);
    expect(codeOf('service.ts')).not.toMatch(/throw new/);
  });
});
