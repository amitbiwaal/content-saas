/**
 * Run history against the layers it reads from and the ones it must not touch.
 *
 * ── What only this file can check ───────────────────────────────────────────
 *
 * 1. THE WHOLE SEAM. Runs produced by the ORCHESTRATOR, stored through the
 *    S4.4 repository, and read back through history — three increments and a
 *    store, end to end. None of them can see that path from inside itself.
 *
 * 2. THE READ MODEL LEAKS NOTHING. A view built from a real stored record
 *    carries no `schemaVersion` and no record timestamps, while still carrying
 *    every template version, provider, model, usage figure and timing.
 *
 * 3. THE REPOSITORY IS REUSED, NOT REPLACED. A history store IS a
 *    `ContentRunRepository`: the same instance drives the orchestrator's writes
 *    and history's reads, which is only demonstrable from outside both.
 *
 * 4. HISTORY WRITES NOTHING, and there is no offset pagination anywhere.
 *
 * 5. THE DEVIATIONS, recorded so they cannot be forgotten.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  createModelCatalogue,
  createOrchestrator,
  createPricingRegistry,
  createProviderRegistry,
  createRouter,
  createRoutingTable,
  createRunHistory,
  createTemplateLibrary,
  createWorkflowRegistry,
  PERSISTENCE_ONLY_FIELDS,
  RUN_HISTORY_CODES,
  RUN_LOAD_CODES,
  type ContentRunHistoryStore,
  type ContentRunRepository,
  type ContentWorkflowDefinition,
  type ModelProvider,
  type PromptTemplate,
  type RunMetadata,
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

const historyDir = new URL('../../packages/ai/src/history/', import.meta.url);

const codeOf = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, historyDir)), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

/** Every module of the history package, tests excluded. */
const HISTORY_MODULES: readonly string[] = readdirSync(fileURLToPath(historyDir)).filter(
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
    execute: (request: AIRequest) => Promise.resolve(response(request, 'direct')),
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

const METADATA: RunMetadata = {
  principal,
  organization: { organizationId: ORG, status: 'active' },
  workspace: { workspaceId: WS, organizationId: ORG, status: 'active' },
  correlationId: CORRELATION,
  idempotencyKey: 'run-idem-1',
};

/**
 * One store, honouring both contracts.
 *
 * `ContentRunHistoryStore extends ContentRunRepository`, so the SAME instance
 * is what the orchestrator writes through and what history reads through. That
 * is the reuse claim, and this is where it is demonstrable.
 */
function memoryStore() {
  const runs = new Map<string, StoredContentRun>();
  const artifacts = new Map<string, readonly StoredArtifact[]>();
  const calls = { saveRun: 0, loadRun: 0, loadArtifacts: 0, updateStatus: 0, queryRuns: 0 };

  const key = (entry: StoredContentRun): string =>
    `${entry.execution.timings.createdAt}|${entry.runId}`;

  const store: ContentRunHistoryStore = {
    saveRun: (input) => {
      calls.saveRun += 1;
      runs.set(input.run.runId, input.run);
      artifacts.set(input.run.runId, input.artifacts);
      return Promise.resolve();
    },
    loadRun: (runId) => {
      calls.loadRun += 1;
      return Promise.resolve(runs.get(runId) ?? null);
    },
    loadArtifacts: (runId) => {
      calls.loadArtifacts += 1;
      return Promise.resolve(artifacts.get(runId) ?? []);
    },
    updateStatus: ({ runId, status, updatedAt }) => {
      calls.updateStatus += 1;
      const existing = runs.get(runId);
      if (existing !== undefined) runs.set(runId, { ...existing, status, updatedAt });
      return Promise.resolve();
    },
    queryRuns: (criteria) => {
      calls.queryRuns += 1;
      const matched = [...runs.values()].filter((entry) => {
        const { execution } = entry;
        const createdAt = execution.timings.createdAt;
        if (criteria.workspaceId !== null && execution.workspaceId !== criteria.workspaceId)
          return false;
        if (criteria.workflowId !== null && execution.workflowId !== criteria.workflowId)
          return false;
        if (criteria.statuses !== null && !criteria.statuses.includes(entry.status)) return false;
        if (criteria.createdAfter !== null && createdAt < criteria.createdAfter) return false;
        if (criteria.createdBefore !== null && createdAt >= criteria.createdBefore) return false;
        return true;
      });

      const ordered = matched.sort((left, right) => {
        const comparison = key(left).localeCompare(key(right));
        return criteria.order === 'newest' ? -comparison : comparison;
      });

      const after = criteria.after;
      const remaining =
        after === null
          ? ordered
          : ordered.filter((entry) => {
              const boundary = `${after.createdAt}|${after.runId}`;
              return criteria.order === 'newest'
                ? key(entry).localeCompare(boundary) < 0
                : key(entry).localeCompare(boundary) > 0;
            });

      return Promise.resolve({ runs: remaining.slice(0, criteria.limit) });
    },
  };

  return { store, calls, runs, artifacts };
}

function orchestratorFor(store: ContentRunHistoryStore, clock: () => Date, ids: () => string) {
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

  const workflows = createWorkflowRegistry([DEFINITION], { library: LIBRARY });
  workflows.seal();

  return createOrchestrator({
    workflows,
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
    // The SAME store. See the note on `memoryStore`.
    runs: store,
  });
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

/** Three real runs, one minute apart, produced by the orchestrator. */
async function seeded(count = 3) {
  const store = memoryStore();
  let minute = 0;
  let issued = 0;

  for (let index = 0; index < count; index += 1) {
    minute = index + 1;
    issued = index + 1;
    const orchestrator = orchestratorFor(
      store.store,
      () => new Date(`2026-07-31T12:0${String(minute)}:00.000Z`),
      () => `run-${String(issued)}`,
    );
    const result = await orchestrator.start(startOptions);
    if (result.outcome !== 'completed') throw new Error(`run ${String(index)} did not complete`);
  }

  return { ...store, history: createRunHistory({ store: store.store }) };
}

// ── 1 · The whole seam ──────────────────────────────────────────────────────

describe('runs the orchestrator made come back out of history', () => {
  it('lists every one of them, newest first', async () => {
    const { history } = await seeded();
    const result = await history.listRuns();

    expect(result.outcome).toBe('ok');
    if (result.outcome !== 'ok') return;
    expect(result.page.items.map((view) => view.runId)).toEqual(['run-3', 'run-2', 'run-1']);
  });

  it('finds one by id', async () => {
    const { history } = await seeded();
    const result = await history.getRunById('run-2');

    expect(result.outcome).toBe('found');
    if (result.outcome !== 'found') return;
    expect(result.run.workflowRef).toBe('article.draft@2');
    expect(result.run.status).toBe('completed');
  });

  it('returns the artifacts that run actually produced', async () => {
    const { history } = await seeded(1);
    const result = await history.listArtifacts('run-1');

    expect(result.outcome).toBe('ok');
    if (result.outcome !== 'ok') return;
    expect(result.artifacts.map((view) => view.stepId)).toEqual(['outline', 'draft']);
    expect(result.artifacts[0]?.content).toBe('generated text');
  });

  it('lists by workflow', async () => {
    const { history } = await seeded();
    const result = await history.listByWorkflow('article.draft');

    if (result.outcome !== 'ok') return;
    expect(result.page.items).toHaveLength(3);
  });
});

// ── 2 · The read model leaks nothing, and drops nothing ─────────────────────

describe('what a history view carries', () => {
  it('no persistence metadata, on a run or on an artifact', async () => {
    const { history } = await seeded(1);
    const run = await history.getRunById('run-1');
    const artifacts = await history.listArtifacts('run-1');

    if (run.outcome !== 'found' || artifacts.outcome !== 'ok') throw new Error('expected reads');
    for (const field of PERSISTENCE_ONLY_FIELDS) {
      expect(Object.keys(run.run)).not.toContain(field);
      expect(Object.keys(artifacts.artifacts[0] ?? {})).not.toContain(field);
    }
  });

  it('the workflow version the run actually ran', async () => {
    const { history } = await seeded(1);
    const result = await history.getRunById('run-1');

    if (result.outcome !== 'found') return;
    expect(result.run.workflowVersion).toBe(2);
  });

  it('every template version the run pinned', async () => {
    const { history } = await seeded(1);
    const result = await history.getRunById('run-1');

    if (result.outcome !== 'found') return;
    expect(result.run.templateVersions.map((entry) => entry.promptVersion)).toEqual([
      'planning.outline@4',
      'writing.draft@4',
    ]);
  });

  it('the provider and model that actually ran', async () => {
    const { history } = await seeded(1);
    const result = await history.listArtifacts('run-1');

    if (result.outcome !== 'ok') return;
    for (const artifact of result.artifacts) {
      expect(artifact.providerId).toBe('openai');
      expect(artifact.model).toBe('gpt-4o-2026-05-01');
    }
  });

  it('usage, still in the ledger decimal format', async () => {
    const { history } = await seeded(1);
    const result = await history.listArtifacts('run-1');

    if (result.outcome !== 'ok') return;
    expect(result.artifacts[0]?.usage.totalTokens).toBe(30);
    expect(result.artifacts[0]?.usage.amount).toMatch(/^\d+\.\d{6}$/);
    expect(result.usage.totalTokens).toBe(60);
  });

  it('the run clock, and never the record clock', async () => {
    // The record is touched long after the run happened. A view that showed it
    // would report "the run took eight decades".
    const { history, runs } = await seeded(1);
    const stored = runs.get('run-1') as StoredContentRun;
    runs.set('run-1', { ...stored, updatedAt: '2099-01-01T00:00:00.000Z' });

    const result = await history.getRunById('run-1');
    if (result.outcome !== 'found') return;

    expect(result.run.timings.createdAt).toBe(stored.execution.timings.createdAt);
    expect(JSON.stringify(result.run)).not.toContain('2099');
  });

  it('the artifact metadata the orchestrator attached', async () => {
    const { history } = await seeded(1);
    const result = await history.listArtifacts('run-1');

    if (result.outcome !== 'ok') return;
    expect(result.artifacts[0]?.metadata['plannedProviderId']).toBe('openai');
  });

  it('and no authority of any kind', async () => {
    // History stores identity. It never stored roles or permissions, and a read
    // model that produced them would be inventing them.
    const { history } = await seeded(1);
    const result = await history.getRunById('run-1');

    if (result.outcome !== 'found') return;
    expect(result.run.principalId).toBe(principal.subjectId);
    const flat = JSON.stringify(result.run);
    expect(flat).not.toContain('editor');
    expect(flat).not.toContain('article:execute');
    expect(flat).not.toContain('permissions');
  });

  it('is frozen through', async () => {
    const { history } = await seeded(1);
    const result = await history.listRuns();

    if (result.outcome !== 'ok') return;
    expect(Object.isFrozen(result.page.items[0])).toBe(true);
    expect(() => {
      (result.page.items as { length: number }).length = 0;
    }).toThrow();
  });
});

// ── 3 · The repository is reused, not replaced ──────────────────────────────

describe('one store, both contracts', () => {
  it('the instance history reads through is the one the orchestrator wrote through', async () => {
    const { store, calls } = await seeded(1);
    const history = createRunHistory({ store });

    // A `ContentRunHistoryStore` IS a `ContentRunRepository`; this compiles
    // because the read port extends the frozen write one.
    const asRepository: ContentRunRepository = store;
    expect(typeof asRepository.saveRun).toBe('function');

    expect(calls.saveRun).toBe(1);
    const result = await history.getRunById('run-1');
    expect(result.outcome).toBe('found');
    expect(calls.loadRun).toBe(1);
  });

  it('reads by id through the frozen contract, never through a query', async () => {
    const { history, calls } = await seeded(1);
    await history.getRunById('run-1');
    await history.listArtifacts('run-1');

    expect(calls.loadRun).toBe(2);
    expect(calls.loadArtifacts).toBe(1);
    expect(calls.queryRuns).toBe(0);
  });

  it('reuses the S4.4 refusal codes rather than restating them', () => {
    for (const code of RUN_LOAD_CODES) expect(RUN_HISTORY_CODES).toContain(code);
    expect(codeOf('service.ts')).toMatch(/\.\.\.RUN_LOAD_CODES/);
  });

  it('reuses the S4.4 validators rather than checking records again', () => {
    const code = codeOf('service.ts');
    expect(code).toMatch(/validateStoredRun\(/);
    expect(code).toMatch(/validateStoredArtifact\(/);
    expect(code).toMatch(/isSupportedSchemaVersion\(/);
  });
});

// ── 4 · It reads, and pages by position ─────────────────────────────────────

describe('history writes nothing', () => {
  it('never saves and never updates a status', async () => {
    const { history, calls } = await seeded(1);
    const before = { saveRun: calls.saveRun, updateStatus: calls.updateStatus };

    await history.getRunById('run-1');
    await history.listRuns();
    await history.listArtifacts('run-1');
    await history.listByWorkflow('article.draft');

    expect(calls.saveRun).toBe(before.saveRun);
    expect(calls.updateStatus).toBe(before.updateStatus);
  });

  it('calls neither anywhere in its source', () => {
    for (const file of HISTORY_MODULES) {
      expect(codeOf(file)).not.toMatch(/\.saveRun\(|\.updateStatus\(/);
    }
  });
});

describe('pagination is by position, never by count', () => {
  it('has no offset, page number or skip anywhere', () => {
    for (const file of HISTORY_MODULES) {
      expect(codeOf(file)).not.toMatch(/\boffset\b|\bskip\b|\bpageNumber\b/i);
    }
  });

  it('walks the whole history exactly once', async () => {
    const { history } = await seeded();
    const seen: string[] = [];
    let cursor: string | null = null;

    for (let page = 0; page < 10; page += 1) {
      const result: Awaited<ReturnType<typeof history.listRuns>> = await history.listRuns({
        limit: 1,
        ...(cursor === null ? {} : { cursor }),
      });
      if (result.outcome !== 'ok') throw new Error('expected a page');
      seen.push(...result.page.items.map((view) => view.runId));
      cursor = result.page.nextCursor;
      if (cursor === null) break;
    }

    expect(seen).toEqual(['run-3', 'run-2', 'run-1']);
    expect(new Set(seen).size).toBe(3);
  });

  it('is unaffected by a run written above the page being read', async () => {
    // The failure an offset would have: something lands at the top and page two
    // silently repeats a row.
    const seed = await seeded();
    const first = await seed.history.listRuns({ limit: 1 });
    if (first.outcome !== 'ok' || first.page.nextCursor === null) throw new Error('expected more');

    const later = orchestratorFor(
      seed.store,
      () => new Date('2026-07-31T12:09:00.000Z'),
      () => 'run-9',
    );
    await later.start(startOptions);

    const second = await seed.history.listRuns({ limit: 1, cursor: first.page.nextCursor });
    if (second.outcome !== 'ok') throw new Error('expected a page');

    expect(first.page.items[0]?.runId).toBe('run-3');
    expect(second.page.items[0]?.runId).toBe('run-2');
  });

  it('hands the store a position, never a count', async () => {
    const { history } = await seeded();
    const first = await history.listRuns({ limit: 1 });
    if (first.outcome !== 'ok' || first.page.nextCursor === null) throw new Error('expected more');

    expect(codeOf('store.ts')).toMatch(/after: StoredRunPosition \| null/);
  });
});

describe('the history layer knows of no database', () => {
  it('imports no database package, driver or ORM', () => {
    for (const file of HISTORY_MODULES) {
      const code = codeOf(file);
      expect(code).not.toMatch(/@contentos\/database/);
      expect(code).not.toMatch(/from '(pg|postgres|mysql2|ioredis|redis|knex|drizzle)/);
      expect(code).not.toMatch(/from '(typeorm|prisma|@prisma\/client|sequelize)/);
    }
  });

  it('writes no SQL and opens no connection', () => {
    for (const file of HISTORY_MODULES) {
      const code = codeOf(file);
      expect(code).not.toMatch(/SELECT .+ FROM |INSERT INTO|ORDER BY|LIMIT \d/i);
      expect(code).not.toMatch(/createPool|new Client\(|\.connect\(|\.query\(/);
    }
  });

  it('ships a port and no implementation of it', () => {
    const code = codeOf('store.ts');
    expect(code).toMatch(/interface ContentRunHistoryStore extends ContentRunRepository/);
    expect(code).not.toMatch(/^export (async )?function/m);
    expect(code).not.toMatch(/^export const/m);
  });
});

// ── 5 · Deviations ──────────────────────────────────────────────────────────

describe('recorded deviations', () => {
  it('DEVIATION: the read port EXTENDS the frozen repository', () => {
    // The S4.4 contract addresses runs by id and has no query. Adding a method
    // to it would break every implementation of a frozen interface; loading
    // every run and filtering in memory would be the duplicate persistence
    // logic this increment forbids. Extending it is the only option that keeps
    // both promises — and an implementation of the read port IS a repository.
    expect(codeOf('store.ts')).toMatch(/extends ContentRunRepository/);
  });

  it('DEVIATION: a page is the platform `Page<T>`, not a second shape', () => {
    // The increment names `RunHistoryPage`. It is an alias of the contracts
    // `Page<T>` — `items`, `nextCursor`, `hasMore` — rather than one more
    // pagination shape meaning the same thing.
    expect(codeOf('service.ts')).toMatch(/RunHistoryPage = Page<RunHistoryView>/);
  });

  it('DEVIATION: a failure view carries codes, never the stored reason', () => {
    // The canonical error contract is emphatic that a caller branches on a code
    // and never reads internal prose. The reason stays in the store, where an
    // operator can still read it.
    expect(codeOf('views.ts')).toMatch(/interface RunFailureView/);
    expect(codeOf('views.ts')).not.toMatch(/reason/);
  });

  it('DEVIATION: one corrupt record refuses the whole page', () => {
    // Skipping it would hand back a page that looks complete and is not, and
    // silent data loss is the failure nobody goes looking for.
    expect(RUN_HISTORY_CODES).toContain('CorruptRecord');
    expect(codeOf('service.ts')).toMatch(/admitRun\(/);
  });

  it('DEVIATION: the service re-sorts what the store returned', () => {
    // Cursor paging is only correct over a total order. A store that returned
    // rows unordered would otherwise produce pages that skip and repeat while
    // looking entirely normal.
    expect(codeOf('service.ts')).toMatch(/\.sort\(/);
  });

  it('DEVIATION: the cursor fingerprint is integrity, not security', () => {
    // Not secret and not signed. Forging one grants nothing: the filter is
    // always the one the caller passed on this request, tenancy included.
    expect(codeOf('cursor.ts')).toMatch(/fingerprint/);
    expect(codeOf('cursor.ts')).not.toMatch(/hmac|sign\(|createHash/i);
  });
});
