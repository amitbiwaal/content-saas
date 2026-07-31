/**
 * Content persistence against the run it stores and the layers it must not know.
 *
 * ── What only this file can check ───────────────────────────────────────────
 *
 * 1. THE ROUND TRIP IS REAL. A run produced by the ORCHESTRATOR — not a hand
 *    written fixture — maps down to a record, through a repository, and back to
 *    a `ContentRun` that still says what the orchestrator said. Every layer
 *    between them is crossed, and none of them can see that from inside.
 *
 * 2. NOTHING IS LOST ON THE WAY DOWN. Template versions, provider identity,
 *    model identity, token usage, cost and every timing survive. What a run cost
 *    and which prompt produced it are the two questions a stored artifact exists
 *    to answer three weeks later.
 *
 * 3. THERE IS NO DATABASE. No driver, no SQL, no ORM, no connection anywhere in
 *    the package — only a port. This is the property that makes the store
 *    replaceable, and it is only visible structurally.
 *
 * 4. THE ORCHESTRATOR TOUCHES IT ONLY THROUGH THE PORT, exactly once per run.
 *
 * 5. THE DEVIATIONS, recorded so they cannot be forgotten.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  CONTENT_RUN_SCHEMA_VERSION,
  createModelCatalogue,
  createOrchestrator,
  createPricingRegistry,
  createProviderRegistry,
  createRouter,
  createRoutingTable,
  createTemplateLibrary,
  createWorkflowRegistry,
  isSupportedSchemaVersion,
  loadContentRun,
  RUN_LOAD_CODES,
  SUPPORTED_SCHEMA_VERSIONS,
  validateStoredArtifact,
  validateStoredRun,
  type ContentRunRepository,
  type ContentWorkflowDefinition,
  type ModelProvider,
  type PromptTemplate,
  type RunMetadata,
  type SaveRunInput,
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

const runsDir = new URL('../../packages/ai/src/runs/', import.meta.url);

const sourceOf = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, runsDir)), 'utf8');

/** Source with comments stripped, so prose never satisfies a structural claim. */
const codeOf = (relative: string): string =>
  sourceOf(relative)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

/** Every module of the run package, tests excluded. */
const RUN_MODULES: readonly string[] = readdirSync(fileURLToPath(runsDir)).filter(
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
      Promise.resolve({ status: 'healthy' as const, reportedAt: NOW.toISOString(), detail: null }),
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
  authenticatedAt: NOW,
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
 * An in-memory repository. The only implementation anywhere near this package,
 * and it lives in a test — which is the point of the port.
 */
function memoryRepository(saveRun?: (input: SaveRunInput) => Promise<void>) {
  const runs = new Map<string, StoredContentRun>();
  const artifacts = new Map<string, readonly StoredArtifact[]>();
  const calls = { saveRun: 0, loadRun: 0, loadArtifacts: 0, updateStatus: 0 };

  const repository: ContentRunRepository = {
    saveRun: async (input) => {
      calls.saveRun += 1;
      if (saveRun !== undefined) await saveRun(input);
      runs.set(input.run.runId, input.run);
      artifacts.set(input.run.runId, input.artifacts);
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
  };

  return { repository, calls, runs, artifacts };
}

function wire(store: ReturnType<typeof memoryRepository>) {
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
    now: () => NOW,
    newRunId: () => 'run-1',
    delay: () => Promise.resolve(),
    runs: store.repository,
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

// ── 1 · The round trip is real ──────────────────────────────────────────────

describe('a run made by the orchestrator survives the trip through a store', () => {
  it('comes back as a run that still says what the orchestrator said', async () => {
    const store = memoryRepository();
    const produced = await wire(store).start(startOptions);
    expect(produced.outcome).toBe('completed');

    const loaded = await loadContentRun({ repository: store.repository, runId: 'run-1' });
    expect(loaded.outcome).toBe('loaded');
    if (loaded.outcome !== 'loaded') return;

    expect(loaded.run.runId).toBe(produced.run.runId);
    expect(loaded.run.workflowRef).toBe(produced.run.workflowRef);
    expect(loaded.run.workflowVersion).toBe(produced.run.workflowVersion);
    expect(loaded.run.state.status).toBe(produced.run.state.status);
    expect(loaded.run.state.executionId).toBe(produced.run.state.executionId);
  });

  it('is identical to the original except for the principal', async () => {
    // Everything the platform works in round-trips exactly. The principal is
    // the one deliberate exception, and it fails closed.
    const store = memoryRepository();
    const produced = await wire(store).start(startOptions);
    const loaded = await loadContentRun({ repository: store.repository, runId: 'run-1' });
    if (loaded.outcome !== 'loaded') throw new Error('expected a load');

    const strip = (value: (typeof loaded)['run']): unknown => ({
      ...value,
      metadata: { ...value.metadata, principal: null },
    });

    expect(strip(loaded.run)).toEqual(strip(produced.run));
  });

  it('produces records both validators accept', async () => {
    const store = memoryRepository();
    await wire(store).start(startOptions);

    const stored = store.runs.get('run-1') as StoredContentRun;
    expect(validateStoredRun(stored)).toEqual({ ok: true });
    for (const artifact of store.artifacts.get('run-1') ?? []) {
      expect(validateStoredArtifact(artifact, 'run-1')).toEqual({ ok: true });
    }
  });

  it('stamps every record with the schema version this build writes', async () => {
    const store = memoryRepository();
    await wire(store).start(startOptions);

    expect(store.runs.get('run-1')?.schemaVersion).toBe(CONTENT_RUN_SCHEMA_VERSION);
    for (const artifact of store.artifacts.get('run-1') ?? []) {
      expect(isSupportedSchemaVersion(artifact.schemaVersion)).toBe(true);
    }
  });
});

// ── 2 · Nothing is lost on the way down ─────────────────────────────────────

describe('what a stored run must still be able to answer', () => {
  it('which prompt produced each artifact', async () => {
    const store = memoryRepository();
    await wire(store).start(startOptions);

    expect((store.artifacts.get('run-1') ?? []).map((entry) => entry.prompt)).toEqual([
      { templateId: 'planning.outline', templateVersion: 4, promptVersion: 'planning.outline@4' },
      { templateId: 'writing.draft', templateVersion: 4, promptVersion: 'writing.draft@4' },
    ]);
  });

  it('which prompts the run pinned when it started', async () => {
    const store = memoryRepository();
    await wire(store).start(startOptions);

    expect(store.runs.get('run-1')?.templateVersions.map((entry) => entry.promptVersion)).toEqual([
      'planning.outline@4',
      'writing.draft@4',
    ]);
  });

  it('which provider and model actually ran', async () => {
    const store = memoryRepository();
    await wire(store).start(startOptions);

    for (const artifact of store.artifacts.get('run-1') ?? []) {
      expect(artifact.providerId).toBe('openai');
      expect(artifact.model).toBe('gpt-4o-2026-05-01');
    }
  });

  it('what it cost, in the format the ledger requires', async () => {
    const store = memoryRepository();
    await wire(store).start(startOptions);

    for (const artifact of store.artifacts.get('run-1') ?? []) {
      expect(artifact.usage.totalTokens).toBe(30);
      expect(typeof artifact.usage.amount).toBe('string');
      // Six places, never a float — the same rule the credits ledger applies.
      expect(artifact.usage.amount).toMatch(/^\d+\.\d{6}$/);
    }
  });

  it('when each stage happened', async () => {
    const store = memoryRepository();
    await wire(store).start(startOptions);

    expect(store.runs.get('run-1')?.execution.timings).toEqual({
      createdAt: NOW.toISOString(),
      compiledAt: NOW.toISOString(),
      startedAt: NOW.toISOString(),
      finishedAt: NOW.toISOString(),
    });
  });

  it('whose it was, and under what correlation', async () => {
    const store = memoryRepository();
    await wire(store).start(startOptions);
    const { execution } = store.runs.get('run-1') as StoredContentRun;

    // ADR-017: the workspace IS the tenant.
    expect(execution.workspaceId).toBe(WS);
    expect(execution.organizationId).toBe(ORG);
    expect(execution.correlationId).toBe(CORRELATION);
    expect(execution.principalId).toBe(principal.subjectId);
  });

  it('and NOT what that person was allowed to do', async () => {
    // Authorization state resolved for one request must not become a durable
    // second copy of itself, and a loaded run must never read as a grant.
    const store = memoryRepository();
    await wire(store).start(startOptions);

    const flat = JSON.stringify(store.runs.get('run-1'));
    expect(flat).not.toContain('editor');
    expect(flat).not.toContain('article:execute');
    expect(flat).not.toContain('session-1');

    const loaded = await loadContentRun({ repository: store.repository, runId: 'run-1' });
    if (loaded.outcome !== 'loaded') throw new Error('expected a load');
    expect(loaded.run.metadata.principal.permissions).toEqual([]);
    expect(loaded.run.metadata.principal.roles).toEqual([]);
    expect(loaded.run.metadata.principal.mfaSatisfied).toBe(false);
  });
});

// ── 3 · There is no database ────────────────────────────────────────────────

describe('the persistence layer knows of no database', () => {
  it('imports no database package anywhere in the run module', () => {
    for (const file of RUN_MODULES) {
      expect(codeOf(file)).not.toMatch(/@contentos\/database/);
    }
  });

  it('imports no driver and no ORM', () => {
    for (const file of RUN_MODULES) {
      expect(codeOf(file)).not.toMatch(/from '(pg|postgres|mysql2|ioredis|redis|knex|drizzle)/);
      expect(codeOf(file)).not.toMatch(/from '(typeorm|prisma|@prisma\/client|sequelize)/);
    }
  });

  it('writes no SQL', () => {
    for (const file of RUN_MODULES) {
      const code = codeOf(file);
      expect(code).not.toMatch(/INSERT INTO|UPDATE .+ SET |DELETE FROM|SELECT .+ FROM /i);
      expect(code).not.toMatch(/CREATE TABLE|ON CONFLICT|RETURNING /i);
    }
  });

  it('opens no connection and holds no pool', () => {
    for (const file of RUN_MODULES) {
      expect(codeOf(file)).not.toMatch(/createPool|new Client\(|\.connect\(|\.query\(/);
    }
  });

  it('ships a port and no implementation of it', () => {
    // `repository.ts` declares interfaces. If it ever gains a `create...`
    // factory, a store has moved into the package that defines the contract.
    const code = codeOf('repository.ts');
    expect(code).toMatch(/interface ContentRunRepository/);
    expect(code).not.toMatch(/^export (async )?function/m);
    expect(code).not.toMatch(/^export const/m);
  });

  it('stores only values a store of any kind could hold', async () => {
    // No Date, no Map, no class instance — which is what makes the record
    // storable by anything, including the SQL-backed repository written later.
    const store = memoryRepository();
    await wire(store).start(startOptions);

    const walk = (value: unknown, path: string): void => {
      if (value === null) return;
      if (Array.isArray(value)) {
        value.forEach((entry, index) => {
          walk(entry, `${path}[${String(index)}]`);
        });
        return;
      }
      if (typeof value === 'object') {
        expect(
          `${path}: ${Object.getPrototypeOf(value) === Object.prototype ? 'plain' : 'exotic'}`,
        ).toBe(`${path}: plain`);
        for (const [key, entry] of Object.entries(value)) walk(entry, `${path}.${key}`);
        return;
      }
      expect(['string', 'number', 'boolean']).toContain(typeof value);
    };

    walk(store.runs.get('run-1'), 'run');
    walk([...(store.artifacts.get('run-1') ?? [])], 'artifacts');
  });
});

// ── 4 · Only through the port, exactly once ─────────────────────────────────

describe('the orchestrator and the repository', () => {
  it('saves exactly once per run', async () => {
    const store = memoryRepository();
    await wire(store).start(startOptions);

    expect(store.calls.saveRun).toBe(1);
  });

  it('reads nothing while running', async () => {
    const store = memoryRepository();
    await wire(store).start(startOptions);

    expect(store.calls.loadRun).toBe(0);
    expect(store.calls.loadArtifacts).toBe(0);
    expect(store.calls.updateStatus).toBe(0);
  });

  it('saves the run and its artifacts together, never one without the other', async () => {
    // A run whose artifacts never arrived says work happened and cannot show
    // it — and no reader could tell that from a run that produced nothing.
    const store = memoryRepository();
    await wire(store).start(startOptions);

    expect(store.runs.has('run-1')).toBe(true);
    expect(store.artifacts.get('run-1')).toHaveLength(2);
    expect(store.runs.get('run-1')?.artifactCount).toBe(2);
  });

  it('tells the caller when the run was not stored', async () => {
    const store = memoryRepository(() => Promise.reject(new Error('the store is down')));
    const result = await wire(store).start(startOptions);

    expect(result.outcome).toBe('failed');
    if (result.outcome !== 'failed') return;
    expect(result.code).toBe('PersistenceFailed');
    // The content still comes back; it is simply not durable.
    expect(result.run.state.artifacts).toHaveLength(2);
  });
});

// ── Loading ─────────────────────────────────────────────────────────────────

describe('loading refuses rather than guessing', () => {
  it('refuses a run that is not there', async () => {
    const store = memoryRepository();
    const result = await loadContentRun({ repository: store.repository, runId: 'nothing' });

    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') return;
    expect(result.code).toBe('UnknownRun');
  });

  it('refuses a record from a schema this build does not read', async () => {
    const store = memoryRepository();
    await wire(store).start(startOptions);
    const stored = store.runs.get('run-1') as StoredContentRun;
    store.runs.set('run-1', { ...stored, schemaVersion: 99 });

    const result = await loadContentRun({ repository: store.repository, runId: 'run-1' });
    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') return;
    expect(result.code).toBe('IncompatibleSchema');
  });

  it('refuses a corrupted record', async () => {
    const store = memoryRepository();
    await wire(store).start(startOptions);
    const stored = store.runs.get('run-1') as StoredContentRun;
    store.runs.set('run-1', { ...stored, artifactCount: 9 });

    const result = await loadContentRun({ repository: store.repository, runId: 'run-1' });
    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') return;
    expect(result.code).toBe('CorruptRecord');
  });

  it('names the three refusals and nothing else', () => {
    expect([...RUN_LOAD_CODES]).toEqual(['UnknownRun', 'IncompatibleSchema', 'CorruptRecord']);
  });
});

describe('schema versions are checked, never migrated', () => {
  it('has no migration anywhere in the module', () => {
    // A reader that rewrites what it reads is a write nobody asked for,
    // performed by the process least equipped to know whether it is right.
    // The word appears in a refusal MESSAGE, which is why this looks for a
    // routine rather than for the string.
    for (const file of RUN_MODULES) {
      expect(codeOf(file)).not.toMatch(/(function|const|=>)\s*\w*(migrate|upgrade|backfill)\w*/i);
    }
  });

  it('reads only versions it declares', () => {
    expect(SUPPORTED_SCHEMA_VERSIONS).toContain(CONTENT_RUN_SCHEMA_VERSION);
    for (const version of [0, 2, 99, -1]) {
      expect(isSupportedSchemaVersion(version)).toBe(false);
    }
  });

  it('reuses the ledger decimal rule rather than restating it', () => {
    // The amount a stored artifact carries is the amount a ledger would accept,
    // checked by the metering layer's own predicate.
    expect(codeOf('stored.ts')).toMatch(/isLedgerCompatibleAmount/);
  });

  it('reuses the run status vocabulary rather than a second one', () => {
    expect(codeOf('stored.ts')).toMatch(/isRunStatus/);
    expect(codeOf('stored.ts')).not.toMatch(/const STORED_STATUSES/);
  });
});

// ── 5 · Deviations ──────────────────────────────────────────────────────────

describe('recorded deviations', () => {
  it('DEVIATION: the stored principal is identity, never authority', () => {
    // A `Principal` carries roles and permissions resolved from live bindings
    // for ONE request. Storing them would create a stale copy of the
    // authorization state, and reading it back would look like an
    // authorization. Identity goes down; a principal that grants nothing comes
    // back up.
    expect(codeOf('mapping.ts')).toMatch(/roles: \[\]/);
    expect(codeOf('mapping.ts')).toMatch(/permissions: \[\]/);
    expect(codeOf('mapping.ts')).toMatch(/mfaSatisfied: false/);
  });

  it('DEVIATION: every settled run is stored, not only the successful ones', async () => {
    // "Persistence stores completed Content Runs" is read as SETTLED. A failed
    // run's artifacts were produced and paid for, and the runs an operator most
    // needs to look at would otherwise be the only ones with no record.
    const store = memoryRepository();
    const orchestrator = wire(store);
    const failed = await orchestrator.start({ ...startOptions, workflowId: 'article.missing' });

    expect(failed.outcome).toBe('failed');
    expect(store.calls.saveRun).toBe(1);
    expect(store.runs.get('run-1')?.failure?.code).toBe('WorkflowUnresolved');
  });

  it('DEVIATION: a storage failure is reported as a run failure', () => {
    // Persistence is the source of truth, so a run missing from it is a run
    // nobody will find again. Reporting success would promise a durable record
    // that does not exist. The artifacts still travel on the result.
    expect(codeOf('orchestrator.ts')).toMatch(/PersistenceFailed/);
  });

  it('DEVIATION: the record carries an artifact count', () => {
    // Not in the increment's field list. Without it, a partial read and a run
    // that genuinely produced nothing are the same record, and the first is a
    // run that silently lost work.
    expect(codeOf('stored.ts')).toMatch(/artifactCount/);
    expect(codeOf('load.ts')).toMatch(/COUNT_MISMATCH/);
  });

  it('DEVIATION: a refused load is a value, not a thrown error', () => {
    // The same shape resolution, routing and admission use.
    expect(codeOf('load.ts')).toMatch(/outcome: 'refused'/);
    expect(codeOf('load.ts')).not.toMatch(/throw new/);
  });
});
