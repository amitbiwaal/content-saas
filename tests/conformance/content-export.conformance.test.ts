/**
 * Content export against the layers it serialises and the ones it must not use.
 *
 * ── What only this file can check ───────────────────────────────────────────
 *
 * 1. IT EXPORTS WHAT REALLY HAPPENED. Runs produced by the ORCHESTRATOR and a
 *    draft made by the S4.6 service come out as bytes — six increments end to
 *    end, and every version, price and timing survives the trip into text.
 *
 * 2. IT NEVER QUERIES STORAGE. It holds services, not stores: the module
 *    imports no repository and no port, and the store never sees a call it did
 *    not get through History, Draft Management or Search.
 *
 * 3. THE BYTES ARE DETERMINISTIC. The same export, twice, is the same string —
 *    demonstrated on real content, not on a fixture.
 *
 * 4. IT NEVER EXECUTES AND NEVER WRITES.
 *
 * 5. THE DEVIATIONS, recorded so they cannot be forgotten.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  createContentExport,
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
  canonicalJson,
  EXPORT_CODES,
  EXPORT_SCHEMA_VERSION,
  readExportMetadata,
  type ContentDraft,
  type ContentSearchStore,
  type ContentWorkflowDefinition,
  type DraftMetadata,
  type ExportMetadata,
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

const exportsDir = new URL('../../packages/ai/src/exports/', import.meta.url);

const codeOf = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, exportsDir)), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

/** Every module of the export package, tests excluded. */
const EXPORT_MODULES: readonly string[] = readdirSync(fileURLToPath(exportsDir)).filter(
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

/** Counts every direct provider call. An export may never raise it. */
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
  tags: ['article'],
};

/** One store behind every service. Counted, so a direct read would show. */
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
      const ordered = [...runs.values()].sort((left, right) => {
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
      const ordered = [...drafts.values()].sort((left, right) => {
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

  return { store, calls };
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

/** Two real runs and one real draft, each through the layer that owns it. */
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

  const history = createRunHistory({ store: bench.store });
  const search = createContentSearch({ store: bench.store });

  return {
    ...bench,
    exports: createContentExport({
      history,
      drafts,
      search,
      now: () => new Date('2026-07-31T13:00:00.000Z'),
      newExportId: () => 'export-1',
    }),
  };
}

const request = { format: 'json' as const, organizationId: ORG, workspaceId: WS };

// ── 1 · It exports what really happened ─────────────────────────────────────

describe('exporting real content', () => {
  it('turns a run the orchestrator ran into bytes', async () => {
    const { exports } = await seeded();
    const result = await exports.exportRun('run-1', request);

    expect(result.outcome).toBe('ok');
    if (result.outcome !== 'ok') return;
    expect(result.export.body.length).toBeGreaterThan(0);
    expect(result.export.metadata.itemCount).toBe(1);
  });

  it('preserves every version, price and timing into the text', async () => {
    const { exports } = await seeded();
    const result = await exports.exportRun('run-1', request);
    if (result.outcome !== 'ok') throw new Error('expected an export');

    const parsed = JSON.parse(result.export.body) as {
      items: readonly {
        run: {
          workflowRef: string;
          templateVersions: readonly { promptVersion: string }[];
          timings: Record<string, string>;
        };
        artifacts: readonly {
          providerId: string;
          model: string;
          prompt: { promptVersion: string };
          usage: { totalTokens: number; amount: string };
        }[];
      }[];
    };

    const [item] = parsed.items;
    expect(item?.run.workflowRef).toBe('article.draft@2');
    expect(item?.run.templateVersions.map((entry) => entry.promptVersion)).toEqual([
      'planning.outline@4',
      'writing.draft@4',
    ]);
    expect(item?.run.timings['createdAt']).toBe('2026-07-31T12:01:00.000Z');
    expect(item?.artifacts).toHaveLength(2);
    expect(item?.artifacts[0]?.providerId).toBe('openai');
    expect(item?.artifacts[0]?.model).toBe('gpt-4o-2026-05-01');
    expect(item?.artifacts[0]?.prompt.promptVersion).toBe('planning.outline@4');
    expect(item?.artifacts[0]?.usage.totalTokens).toBe(30);
    // Six decimal places, as the ledger requires. Money never becomes a float.
    expect(item?.artifacts[0]?.usage.amount).toMatch(/^\d+\.\d{6}$/);
  });

  it('turns the draft the draft service made into bytes, whole', async () => {
    const { exports } = await seeded();
    const result = await exports.exportDraft('draft-1', request);

    expect(result.outcome).toBe('ok');
    if (result.outcome !== 'ok') return;
    // An export is a download of the thing itself, unlike a search hit.
    expect(result.export.body).toContain('multi-tenancy');
    expect(result.export.body).toContain('planning.outline@4');
  });

  it('exports a page of runs, and a page of artifacts across them', async () => {
    const { exports } = await seeded();
    const runs = await exports.exportRuns({}, request);
    const artifacts = await exports.exportArtifacts({}, request);

    if (runs.outcome !== 'ok' || artifacts.outcome !== 'ok') throw new Error('expected exports');
    expect(runs.export.metadata.itemCount).toBe(2);
    expect(artifacts.export.metadata.itemCount).toBe(4);
  });

  it('writes NDJSON with the envelope first and one record per line', async () => {
    const { exports } = await seeded();
    const result = await exports.exportArtifacts({}, { ...request, format: 'ndjson' });
    if (result.outcome !== 'ok') throw new Error('expected an export');

    const lines = result.export.body.trimEnd().split('\n');
    expect(lines).toHaveLength(5);
    expect((readExportMetadata(result.export.body, 'ndjson') as ExportMetadata).itemCount).toBe(4);
    for (const line of lines) {
      expect(() => {
        JSON.parse(line);
      }).not.toThrow();
    }
  });

  it('stamps every export with a schema version, a format version and a time', async () => {
    const { exports } = await seeded();
    const result = await exports.exportRun('run-1', request);

    if (result.outcome !== 'ok') return;
    const envelope = readExportMetadata(result.export.body, 'json') as ExportMetadata;
    expect(envelope.exportSchemaVersion).toBe(EXPORT_SCHEMA_VERSION);
    expect(envelope.formatVersion).toBe(1);
    expect(envelope.exportedAt).toBe('2026-07-31T13:00:00.000Z');
  });
});

// ── 2 · It never queries storage ────────────────────────────────────────────

describe('export holds services, not stores', () => {
  it('imports no repository, store or criteria type', () => {
    for (const file of EXPORT_MODULES) {
      const code = codeOf(file);
      expect(code).not.toMatch(/Repository|SearchStore|HistoryStore|Criteria/);
    }
  });

  it('takes only services in its options', () => {
    const code = codeOf('service.ts');
    expect(code).toMatch(/readonly history: RunHistoryService/);
    expect(code).toMatch(/readonly drafts: DraftService/);
    expect(code).toMatch(/readonly search: ContentSearchService/);
    expect(code).not.toMatch(/readonly store:/);
  });

  it('reuses each service for what that service owns', () => {
    const code = codeOf('service.ts');
    expect(code).toMatch(/history\.getRunById\(/);
    expect(code).toMatch(/history\.listArtifacts\(/);
    expect(code).toMatch(/drafts\.load\(/);
    expect(code).toMatch(/search\.searchRuns\(/);
    expect(code).toMatch(/search\.searchDrafts\(/);
    expect(code).toMatch(/search\.searchArtifacts\(/);
  });

  it('reuses search’s codes, which are history’s', () => {
    expect(codeOf('service.ts')).toMatch(/\.\.\.SEARCH_CODES/);
    for (const code of ['UnknownRun', 'CorruptRecord', 'IncompatibleSchema']) {
      expect(EXPORT_CODES).toContain(code);
    }
  });

  it('reuses the search query rather than a second one', () => {
    expect(codeOf('service.ts')).toMatch(/ContentSearchQuery/);
  });

  it('reuses the history read models as its projections', () => {
    const code = codeOf('model.ts');
    expect(code).toMatch(/ExportArtifact = ArtifactHistoryView/);
    expect(code).toMatch(/RunHistoryView/);
  });
});

describe('the export layer knows of no database', () => {
  it('imports no database package, driver or ORM', () => {
    for (const file of EXPORT_MODULES) {
      const code = codeOf(file);
      expect(code).not.toMatch(/@contentos\/database/);
      expect(code).not.toMatch(/from '(pg|postgres|mysql2|ioredis|redis|knex|drizzle|prisma)/);
    }
  });

  it('writes no SQL and opens no connection', () => {
    for (const file of EXPORT_MODULES) {
      const code = codeOf(file);
      expect(code).not.toMatch(/SELECT .+ FROM |INSERT INTO|ORDER BY|LIMIT \d/i);
      expect(code).not.toMatch(/createPool|new Client\(|\.connect\(|\.query\(/);
    }
  });
});

// ── 3 · The bytes are deterministic ─────────────────────────────────────────

describe('deterministic bytes', () => {
  it('produces the same string for the same real export, twice', async () => {
    const first = await (await seeded()).exports.exportRun('run-1', request);
    const second = await (await seeded()).exports.exportRun('run-1', request);

    if (first.outcome !== 'ok' || second.outcome !== 'ok') throw new Error('expected exports');
    expect(second.export.body).toBe(first.export.body);
  });

  it('does the same in NDJSON', async () => {
    const first = await (
      await seeded()
    ).exports.exportArtifacts({}, { ...request, format: 'ndjson' });
    const second = await (
      await seeded()
    ).exports.exportArtifacts({}, { ...request, format: 'ndjson' });

    if (first.outcome !== 'ok' || second.outcome !== 'ok') throw new Error('expected exports');
    expect(second.export.body).toBe(first.export.body);
  });

  it('writes every object’s keys in sorted order, at every depth', async () => {
    const { exports } = await seeded();
    const result = await exports.exportRun('run-1', request);
    if (result.outcome !== 'ok') throw new Error('expected an export');

    // The bytes ARE the canonical form of their own content: re-serialising
    // what they parse to reproduces them exactly. That is sorted keys at every
    // depth, no padding, and nothing added on the way out — in one comparison.
    const parsed: unknown = JSON.parse(result.export.body);
    expect(`${canonicalJson(parsed)}
`).toBe(result.export.body);
  });

  it('parses back to exactly what it serialised — no hidden fields', async () => {
    const { exports } = await seeded();
    const result = await exports.exportRun('run-1', request);
    if (result.outcome !== 'ok') throw new Error('expected an export');

    expect(JSON.parse(result.export.body)).toEqual({
      metadata: result.export.metadata,
      items: result.export.items,
    });
  });

  it('ends with a newline in both formats', async () => {
    const { exports } = await seeded();
    const json = await exports.exportRun('run-1', request);
    const ndjson = await exports.exportRun('run-1', { ...request, format: 'ndjson' });

    if (json.outcome !== 'ok' || ndjson.outcome !== 'ok') throw new Error('expected exports');
    expect(json.export.body.endsWith('\n')).toBe(true);
    expect(ndjson.export.body.endsWith('\n')).toBe(true);
  });
});

// ── 4 · It never executes and never writes ──────────────────────────────────

describe('export changes nothing', () => {
  it('calls no provider', async () => {
    providerCalls.executed = 0;
    const { exports } = await seeded();

    await exports.exportRun('run-1', request);
    await exports.exportRuns({}, { ...request, includeArtifacts: true });
    await exports.exportDraft('draft-1', request);
    await exports.exportDrafts({}, request);
    await exports.exportArtifacts({}, request);

    expect(providerCalls.executed).toBe(0);
  });

  it('writes nothing to the store', async () => {
    const bench = await seeded();
    const before = { ...bench.calls };

    await bench.exports.exportRun('run-1', request);
    await bench.exports.exportDrafts({}, request);
    await bench.exports.exportArtifacts({}, request);

    expect(bench.calls.saveRun).toBe(before.saveRun);
    expect(bench.calls.saveDraft).toBe(before.saveDraft);
    expect(bench.calls.updateStatus).toBe(before.updateStatus);
    expect(bench.calls.updateDraft).toBe(before.updateDraft);
    expect(bench.calls.deleteDraft).toBe(before.deleteDraft);
  });

  it('has no execution path at all', () => {
    for (const file of EXPORT_MODULES) {
      const code = codeOf(file);
      expect(code).not.toMatch(/createOrchestrator|\.execute\(|\.dispatch\(|\.stream\(/);
      expect(code).not.toMatch(/loadStep\(|preparePrompt\(|buildRequest\(|recordExecution\(/);
      expect(code).not.toMatch(/from '\.\.\/routing\/|from '\.\.\/retry\/|from '\.\.\/providers\//);
    }
  });

  it('calls no write method on any service it holds', () => {
    for (const file of EXPORT_MODULES) {
      const code = codeOf(file);
      expect(code).not.toMatch(/drafts\.(create|revise|remove)\(/);
      expect(code).not.toMatch(/\.saveRun\(|\.saveDraft\(|\.updateStatus\(|\.deleteDraft\(/);
    }
  });
});

// ── 5 · Deviations ──────────────────────────────────────────────────────────

describe('recorded deviations', () => {
  it('DEVIATION: a bulk run export omits artifacts unless asked', async () => {
    // A page of a hundred runs with their artifacts is a different order of
    // magnitude from a page of a hundred run records, and which one a caller
    // wants is not something to guess.
    const { exports } = await seeded();
    const without = await exports.exportRuns({}, request);
    const with_ = await exports.exportRuns({}, { ...request, includeArtifacts: true });

    if (without.outcome !== 'ok' || with_.outcome !== 'ok') throw new Error('expected exports');
    expect(without.export.body.length).toBeLessThan(with_.export.body.length);
  });

  it('DEVIATION: a draft export carries what a search hit withholds', async () => {
    // A listing is a pointer and a download is the thing itself. The same
    // record, two audiences, two projections.
    const { exports } = await seeded();
    const exported = await exports.exportDraft('draft-1', request);
    if (exported.outcome !== 'ok') throw new Error('expected an export');

    expect(exported.export.body).toContain('multi-tenancy');
  });

  it('DEVIATION: a bulk draft export loads each draft whole', () => {
    // Search finds them; Draft Management supplies them. One extra call per
    // draft, bounded by the page size, for a backup that is actually a backup.
    expect(codeOf('service.ts')).toMatch(/drafts\.load\(hit\.draft\.draftId\)/);
  });

  it('DEVIATION: NDJSON puts the envelope on the first LINE', () => {
    // NDJSON has no place for a wrapper, and a streaming reader must know the
    // schema version before it reads an item. A trailer would mean buffering
    // the whole file to find out.
    expect(codeOf('format.ts')).toMatch(/record: 'metadata'/);
  });

  it('DEVIATION: canonical JSON is written here, not borrowed', () => {
    // The prompt compiler has a private canonicaliser for a different job —
    // rendering one variable's value into a slot. Exporting it would widen a
    // frozen module's surface for a purpose it was never built for, so this
    // layer states its own rule: sorted keys, dropped undefined, array order
    // untouched.
    expect(codeOf('format.ts')).toMatch(/function canonicalJson/);
  });

  it('DEVIATION: a named export schema version is refused, never upgraded', () => {
    expect(EXPORT_CODES).toContain('IncompatibleExportVersion');
    expect(codeOf('service.ts')).toMatch(/refused rather than upgraded/);
  });

  it('DEVIATION: refusals are values, not thrown errors', () => {
    expect(codeOf('service.ts')).toMatch(/outcome: 'refused'/);
    expect(codeOf('service.ts')).not.toMatch(/throw new/);
  });
});
