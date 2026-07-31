import { describe, expect, it } from 'vitest';

import { newDraft, type ContentDraft } from '../drafts/draft.js';
import type { DraftResult, DraftService } from '../drafts/service.js';
import type {
  ArtifactHistoryResult,
  RunHistoryService,
  RunLookupResult,
} from '../history/service.js';
import type { ArtifactHistoryView, RunHistoryView } from '../history/views.js';
import type { ContentSearchService, SearchResult } from '../search/service.js';
import { draftHit, runHit, artifactHit } from '../search/hits.js';
import { readExportMetadata } from './format.js';
import {
  CONTENT_EXPORT_FORMATS,
  EXPORT_SCHEMA_VERSION,
  type ContentExportRequest,
  type ExportMetadata,
} from './model.js';
import { createContentExport, EXPORT_CODES, isExportCode } from './service.js';

const AT = new Date('2026-07-31T12:00:00.000Z');
const ORG = 'org-1';
const WS = 'ws-1';

// ── Fixtures ────────────────────────────────────────────────────────────────

const runView = (runId: string): RunHistoryView =>
  Object.freeze({
    runId,
    status: 'completed',
    workflowId: 'article.draft',
    workflowVersion: 2,
    workflowRef: 'article.draft@2',
    capability: 'chat',
    templateVersions: [
      { templateId: 'planning.outline', templateVersion: 7, promptVersion: 'planning.outline@7' },
    ],
    executionId: `idem-${runId}`,
    organizationId: ORG,
    workspaceId: WS,
    principalId: 'user-1',
    principalKind: 'user',
    correlationId: `corr-${runId}`,
    timings: {
      createdAt: '2026-07-31T12:00:00.000Z',
      compiledAt: '2026-07-31T12:00:00.000Z',
      startedAt: '2026-07-31T12:00:00.000Z',
      finishedAt: '2026-07-31T12:00:00.000Z',
    },
    failure: null,
    artifactCount: 1,
  });

const artifactView = (runId: string, sequence: number): ArtifactHistoryView =>
  Object.freeze({
    runId,
    stepId: sequence === 0 ? 'outline' : 'draft',
    sequence,
    prompt: {
      templateId: 'planning.outline',
      templateVersion: 7,
      promptVersion: 'planning.outline@7',
    },
    providerId: 'openai',
    model: 'gpt-4o-2026-05-01',
    capability: 'chat',
    content: `${runId} artifact ${String(sequence)}`,
    finishReason: 'stop',
    usage: {
      promptTokens: 10,
      completionTokens: 20,
      totalTokens: 30,
      tokensEstimated: false,
      currency: 'USD',
      amount: '0.000225',
      latencyMs: 12,
    },
    attempts: 1,
    metadata: { plannedProviderId: 'openai' },
  });

const draftRecord = (draftId: string): ContentDraft =>
  newDraft({
    draftId,
    metadata: {
      organizationId: ORG,
      workspaceId: WS,
      principalId: 'user-1',
      principalKind: 'user',
      title: `Draft ${draftId}`,
      tags: ['article'],
    },
    workflowId: 'article.draft',
    workflowVersion: 2,
    workflowRef: 'article.draft@2',
    capability: 'chat',
    templateReferences: [
      { templateId: 'planning.outline', templateVersion: 7, promptVersion: 'planning.outline@7' },
    ],
    inputs: { topic: 'multi-tenancy' },
    now: AT.toISOString(),
  });

// ── Fake services ───────────────────────────────────────────────────────────

interface Behaviour {
  readonly runs?: readonly string[];
  readonly drafts?: readonly string[];
  readonly artifacts?: readonly ArtifactHistoryView[];
  readonly runLookup?: RunLookupResult;
  readonly artifactLookup?: ArtifactHistoryResult;
  readonly draftLookup?: DraftResult;
  readonly searchRefusal?: SearchResult;
}

function harness(behaviour: Behaviour = {}) {
  const runIds = behaviour.runs ?? ['run-1'];
  const draftIds = behaviour.drafts ?? ['draft-1'];
  const calls = {
    getRunById: 0,
    listArtifacts: 0,
    listRuns: 0,
    listByWorkflow: 0,
    loadDraft: 0,
    createDraft: 0,
    reviseDraft: 0,
    removeDraft: 0,
    listDrafts: 0,
    validateDraft: 0,
    searchRuns: 0,
    searchDrafts: 0,
    searchArtifacts: 0,
  };

  const history: RunHistoryService = {
    getRunById: (runId) => {
      calls.getRunById += 1;
      if (behaviour.runLookup !== undefined) return Promise.resolve(behaviour.runLookup);
      return Promise.resolve(
        runIds.includes(runId)
          ? { outcome: 'found', run: runView(runId) }
          : { outcome: 'refused', code: 'UnknownRun', reason: 'no such run', issues: [] },
      );
    },
    listArtifacts: (runId) => {
      calls.listArtifacts += 1;
      if (behaviour.artifactLookup !== undefined) return Promise.resolve(behaviour.artifactLookup);
      return Promise.resolve({
        outcome: 'ok',
        artifacts: behaviour.artifacts ?? [artifactView(runId, 0)],
        usage: {
          promptTokens: 10,
          completionTokens: 20,
          totalTokens: 30,
          artifacts: 1,
          tokensEstimated: false,
        },
      });
    },
    listRuns: () => {
      calls.listRuns += 1;
      return Promise.resolve({
        outcome: 'ok',
        page: { items: runIds.map(runView), nextCursor: null, hasMore: false },
      });
    },
    listByWorkflow: () => {
      calls.listByWorkflow += 1;
      return Promise.resolve({
        outcome: 'ok',
        page: { items: [], nextCursor: null, hasMore: false },
      });
    },
  };

  const drafts: DraftService = {
    load: (draftId) => {
      calls.loadDraft += 1;
      if (behaviour.draftLookup !== undefined) return Promise.resolve(behaviour.draftLookup);
      return Promise.resolve(
        draftIds.includes(draftId)
          ? { outcome: 'ok', draft: draftRecord(draftId) }
          : { outcome: 'refused', code: 'UnknownDraft', reason: 'no such draft', issues: [] },
      );
    },
    create: () => {
      calls.createDraft += 1;
      return Promise.resolve({ outcome: 'refused', code: 'DraftInvalid', reason: '', issues: [] });
    },
    revise: () => {
      calls.reviseDraft += 1;
      return Promise.resolve({ outcome: 'refused', code: 'DraftInvalid', reason: '', issues: [] });
    },
    remove: () => {
      calls.removeDraft += 1;
      return Promise.resolve({ outcome: 'refused', code: 'DraftInvalid', reason: '', issues: [] });
    },
    list: () => {
      calls.listDrafts += 1;
      return Promise.resolve({ outcome: 'ok', drafts: [] });
    },
    validate: () => {
      calls.validateDraft += 1;
      return Promise.resolve({ outcome: 'refused', code: 'DraftInvalid', reason: '', issues: [] });
    },
  };

  const search: ContentSearchService = {
    searchRuns: () => {
      calls.searchRuns += 1;
      if (behaviour.searchRefusal !== undefined) return Promise.resolve(behaviour.searchRefusal);
      return Promise.resolve({
        outcome: 'ok',
        page: {
          items: runIds.map((runId) => runHit(runView(runId))),
          nextCursor: null,
          hasMore: false,
        },
      });
    },
    searchDrafts: () => {
      calls.searchDrafts += 1;
      if (behaviour.searchRefusal !== undefined) return Promise.resolve(behaviour.searchRefusal);
      return Promise.resolve({
        outcome: 'ok',
        page: {
          items: draftIds.map((draftId) => draftHit(draftRecord(draftId))),
          nextCursor: null,
          hasMore: false,
        },
      });
    },
    searchArtifacts: () => {
      calls.searchArtifacts += 1;
      if (behaviour.searchRefusal !== undefined) return Promise.resolve(behaviour.searchRefusal);
      return Promise.resolve({
        outcome: 'ok',
        page: {
          items: (behaviour.artifacts ?? [artifactView('run-1', 0), artifactView('run-1', 1)]).map(
            artifactHit,
          ),
          nextCursor: null,
          hasMore: false,
        },
      });
    },
  };

  let issued = 0;

  return {
    calls,
    history,
    drafts,
    search,
    exports: createContentExport({
      history,
      drafts,
      search,
      now: () => AT,
      newExportId: () => `export-${String(++issued)}`,
    }),
  };
}

const request = (overrides: Partial<ContentExportRequest> = {}): ContentExportRequest => ({
  format: 'json',
  organizationId: ORG,
  workspaceId: WS,
  ...overrides,
});

const envelopeOf = (body: string, format: 'json' | 'ndjson' = 'json'): ExportMetadata =>
  readExportMetadata(body, format) as ExportMetadata;

// ── Exporting one run ───────────────────────────────────────────────────────

describe('exporting one run', () => {
  it('produces an export carrying the run and its artifacts', async () => {
    const { exports } = harness();
    const result = await exports.exportRun('run-1', request());

    expect(result.outcome).toBe('ok');
    if (result.outcome !== 'ok') return;
    expect(result.export.items).toHaveLength(1);
    const [item] = result.export.items;
    if (item?.kind !== 'run') throw new Error('expected a run item');
    expect(item.run.runId).toBe('run-1');
    expect(item.artifacts).toHaveLength(1);
  });

  it('goes through History, never a store', async () => {
    const { exports, calls } = harness();
    await exports.exportRun('run-1', request());

    expect(calls.getRunById).toBe(1);
    expect(calls.listArtifacts).toBe(1);
    expect(calls.searchRuns).toBe(0);
  });

  it('records the export type, format and tenancy on the envelope', async () => {
    const { exports } = harness();
    const result = await exports.exportRun('run-1', request());

    if (result.outcome !== 'ok') return;
    const { metadata } = result.export;
    expect(metadata.exportType).toBe('run');
    expect(metadata.format).toBe('json');
    expect(metadata.organizationId).toBe(ORG);
    expect(metadata.workspaceId).toBe(WS);
    expect(metadata.itemCount).toBe(1);
  });

  it('stamps the schema version, the format version and both clocks', async () => {
    const { exports } = harness();
    const result = await exports.exportRun('run-1', request());

    if (result.outcome !== 'ok') return;
    expect(result.export.metadata.exportSchemaVersion).toBe(EXPORT_SCHEMA_VERSION);
    expect(result.export.metadata.formatVersion).toBe(1);
    expect(result.export.metadata.exportedAt).toBe(AT.toISOString());
    // One clock read, so the two can never disagree.
    expect(result.export.createdAt).toBe(result.export.metadata.exportedAt);
  });

  it('preserves workflow and template versions, usage and timings in the bytes', async () => {
    const { exports } = harness();
    const result = await exports.exportRun('run-1', request());

    if (result.outcome !== 'ok') return;
    const parsed = JSON.parse(result.export.body) as { items: readonly unknown[] };
    const [item] = parsed.items as readonly {
      run: RunHistoryView;
      artifacts: readonly ArtifactHistoryView[];
    }[];

    expect(item?.run.workflowRef).toBe('article.draft@2');
    expect(item?.run.templateVersions[0]?.promptVersion).toBe('planning.outline@7');
    expect(item?.run.timings.createdAt).toBe('2026-07-31T12:00:00.000Z');
    expect(item?.artifacts[0]?.usage.totalTokens).toBe(30);
    expect(item?.artifacts[0]?.providerId).toBe('openai');
    expect(item?.artifacts[0]?.model).toBe('gpt-4o-2026-05-01');
  });

  it('refuses a run that is not there', async () => {
    const { exports } = harness();
    const result = await exports.exportRun('run-nothing', request());

    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') return;
    expect(result.code).toBe('UnknownRun');
  });

  it('carries a corrupt-record refusal straight through', async () => {
    const { exports } = harness({
      artifactLookup: {
        outcome: 'refused',
        code: 'CorruptRecord',
        reason: 'bad artifact',
        issues: [{ field: 'a', code: 'B', detail: 'c' }],
      },
    });
    const result = await exports.exportRun('run-1', request());

    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') return;
    expect(result.code).toBe('CorruptRecord');
    expect(result.issues).toHaveLength(1);
  });

  it('freezes what it returns', async () => {
    const { exports } = harness();
    const result = await exports.exportRun('run-1', request());

    expect(Object.isFrozen(result)).toBe(true);
    if (result.outcome !== 'ok') return;
    expect(Object.isFrozen(result.export)).toBe(true);
    expect(Object.isFrozen(result.export.items)).toBe(true);
    expect(Object.isFrozen(result.export.metadata)).toBe(true);
  });
});

// ── Exporting many runs ─────────────────────────────────────────────────────

describe('exporting a page of runs', () => {
  it('goes through Search', async () => {
    const { exports, calls } = harness({ runs: ['run-1', 'run-2'] });
    await exports.exportRuns({}, request());

    expect(calls.searchRuns).toBe(1);
    expect(calls.listRuns).toBe(0);
  });

  it('exports records only unless artifacts are asked for', async () => {
    // A page of a hundred runs with artifacts is a different order of magnitude
    // from a page of a hundred run records.
    const { exports, calls } = harness({ runs: ['run-1', 'run-2'] });
    const result = await exports.exportRuns({}, request());

    expect(result.outcome).toBe('ok');
    if (result.outcome !== 'ok') return;
    expect(result.export.items).toHaveLength(2);
    for (const item of result.export.items) {
      expect(item.kind === 'run' && item.artifacts).toEqual([]);
    }
    expect(calls.listArtifacts).toBe(0);
  });

  it('fetches each run’s artifacts when they are asked for', async () => {
    const { exports, calls } = harness({ runs: ['run-1', 'run-2'] });
    const result = await exports.exportRuns({}, { ...request(), includeArtifacts: true });

    if (result.outcome !== 'ok') return;
    expect(calls.listArtifacts).toBe(2);
    for (const item of result.export.items) {
      expect(item.kind === 'run' && item.artifacts).toHaveLength(1);
    }
  });

  it('names the export type in the plural', async () => {
    const { exports } = harness();
    const result = await exports.exportRuns({}, request());

    if (result.outcome !== 'ok') return;
    expect(result.export.metadata.exportType).toBe('runs');
  });

  it('carries a search refusal straight through', async () => {
    const { exports } = harness({
      searchRefusal: {
        outcome: 'refused',
        code: 'UnsupportedFilter',
        reason: 'runs have no tags',
        issues: [],
      },
    });
    const result = await exports.exportRuns({ filter: { tags: ['x'] } }, request());

    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') return;
    expect(result.code).toBe('UnsupportedFilter');
  });
});

// ── Drafts ──────────────────────────────────────────────────────────────────

describe('exporting a draft', () => {
  it('carries the WHOLE draft, revisions and inputs included', async () => {
    // Unlike a search hit: a listing is a pointer, an export is a download.
    const { exports } = harness();
    const result = await exports.exportDraft('draft-1', request());

    expect(result.outcome).toBe('ok');
    if (result.outcome !== 'ok') return;
    const [item] = result.export.items;
    if (item?.kind !== 'draft') throw new Error('expected a draft item');

    expect(item.draft.revisions).toHaveLength(1);
    expect(item.draft.revisions[0]?.inputs).toEqual({ topic: 'multi-tenancy' });
    expect(result.export.body).toContain('multi-tenancy');
  });

  it('goes through Draft Management', async () => {
    const { exports, calls } = harness();
    await exports.exportDraft('draft-1', request());

    expect(calls.loadDraft).toBe(1);
    expect(calls.searchDrafts).toBe(0);
  });

  it('preserves the pinned workflow and template references', async () => {
    const { exports } = harness();
    const result = await exports.exportDraft('draft-1', request());

    if (result.outcome !== 'ok') return;
    const [item] = result.export.items;
    if (item?.kind !== 'draft') throw new Error('expected a draft item');
    expect(item.draft.workflowRef).toBe('article.draft@2');
    expect(item.draft.templateReferences[0]?.promptVersion).toBe('planning.outline@7');
  });

  it('refuses a draft that is not there', async () => {
    const { exports } = harness();
    const result = await exports.exportDraft('draft-nothing', request());

    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') return;
    expect(result.code).toBe('UnknownDraft');
  });
});

describe('exporting a page of drafts', () => {
  it('finds them with Search and loads each one whole', async () => {
    const { exports, calls } = harness({ drafts: ['draft-1', 'draft-2'] });
    const result = await exports.exportDrafts({}, request());

    expect(result.outcome).toBe('ok');
    if (result.outcome !== 'ok') return;
    expect(calls.searchDrafts).toBe(1);
    expect(calls.loadDraft).toBe(2);
    expect(result.export.items).toHaveLength(2);
    for (const item of result.export.items) {
      expect(item.kind === 'draft' && item.draft.revisions).toHaveLength(1);
    }
  });

  it('includes the inputs a search hit withholds', async () => {
    const { exports } = harness({ drafts: ['draft-1'] });
    const result = await exports.exportDrafts({}, request());

    if (result.outcome !== 'ok') return;
    expect(result.export.body).toContain('multi-tenancy');
  });

  it('names the export type in the plural', async () => {
    const { exports } = harness();
    const result = await exports.exportDrafts({}, request());

    if (result.outcome !== 'ok') return;
    expect(result.export.metadata.exportType).toBe('drafts');
  });
});

// ── Artifacts ───────────────────────────────────────────────────────────────

describe('exporting artifacts', () => {
  it('goes through Search, across runs', async () => {
    const { exports, calls } = harness();
    const result = await exports.exportArtifacts({}, request());

    expect(result.outcome).toBe('ok');
    if (result.outcome !== 'ok') return;
    expect(calls.searchArtifacts).toBe(1);
    expect(result.export.items).toHaveLength(2);
    expect(result.export.metadata.exportType).toBe('artifacts');
  });

  it('preserves usage, provider, model and the prompt reference', async () => {
    const { exports } = harness();
    const result = await exports.exportArtifacts({}, request());

    if (result.outcome !== 'ok') return;
    const [item] = result.export.items;
    if (item?.kind !== 'artifact') throw new Error('expected an artifact item');

    expect(item.artifact.usage.totalTokens).toBe(30);
    expect(item.artifact.usage.amount).toBe('0.000225');
    expect(item.artifact.providerId).toBe('openai');
    expect(item.artifact.model).toBe('gpt-4o-2026-05-01');
    expect(item.artifact.prompt.promptVersion).toBe('planning.outline@7');
  });

  it('carries no persistence-only field into the bytes', async () => {
    const { exports } = harness();
    const result = await exports.exportArtifacts({}, request());

    if (result.outcome !== 'ok') return;
    expect(result.export.body).not.toContain('schemaVersion":1,"updatedAt');
    const parsed = JSON.parse(result.export.body) as {
      items: readonly { artifact: Record<string, unknown> }[];
    };
    expect(Object.keys(parsed.items[0]?.artifact ?? {})).not.toContain('updatedAt');
  });
});

// ── Formats and versions ────────────────────────────────────────────────────

describe('formats', () => {
  it('writes every format it declares', async () => {
    const { exports } = harness();

    for (const format of CONTENT_EXPORT_FORMATS) {
      const result = await exports.exportRun('run-1', request({ format }));
      expect(result.outcome).toBe('ok');
      if (result.outcome !== 'ok') continue;
      expect(envelopeOf(result.export.body, format).format).toBe(format);
    }
  });

  it('refuses one it does not', async () => {
    const { exports, calls } = harness();
    const result = await exports.exportRun('run-1', request({ format: 'csv' as 'json' }));

    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') return;
    expect(result.code).toBe('UnsupportedFormat');
    // Refused before anything is read.
    expect(calls.getRunById).toBe(0);
  });

  it('puts the envelope on the first NDJSON line, before any item', async () => {
    const { exports } = harness();
    const result = await exports.exportArtifacts({}, request({ format: 'ndjson' }));

    if (result.outcome !== 'ok') return;
    const lines = result.export.body.trimEnd().split('\n');
    expect(lines).toHaveLength(3);
    expect(envelopeOf(result.export.body, 'ndjson').itemCount).toBe(2);
  });
});

describe('export schema versions', () => {
  it('writes the version this build writes', async () => {
    const { exports } = harness();
    const result = await exports.exportRun('run-1', request());

    if (result.outcome !== 'ok') return;
    expect(result.export.metadata.exportSchemaVersion).toBe(EXPORT_SCHEMA_VERSION);
  });

  it('accepts a caller naming the version it writes', async () => {
    const { exports } = harness();
    const result = await exports.exportRun(
      'run-1',
      request({ exportSchemaVersion: EXPORT_SCHEMA_VERSION }),
    );

    expect(result.outcome).toBe('ok');
  });

  it('refuses a version it does not write, rather than upgrading', async () => {
    // A caller with a reader for one version must not silently receive another.
    const { exports, calls } = harness();
    const result = await exports.exportRun('run-1', request({ exportSchemaVersion: 2 }));

    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') return;
    expect(result.code).toBe('IncompatibleExportVersion');
    expect(result.reason).toMatch(/refused rather than upgraded/);
    expect(calls.getRunById).toBe(0);
  });

  it('refuses a version that is not a version', async () => {
    const { exports } = harness();
    const result = await exports.exportRun(
      'run-1',
      request({ exportSchemaVersion: '1' as unknown as number }),
    );

    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') return;
    expect(result.code).toBe('IncompatibleExportVersion');
  });
});

describe('the request itself', () => {
  it('requires the tenancy it will record', async () => {
    const { exports } = harness();

    for (const overrides of [{ organizationId: '' }, { workspaceId: '  ' }]) {
      const result = await exports.exportRun('run-1', request(overrides));
      expect(result.outcome).toBe('refused');
      if (result.outcome !== 'refused') continue;
      expect(result.code).toBe('InvalidRequest');
    }
  });

  it('checks the request before it reads anything', async () => {
    const { exports, calls } = harness();
    await exports.exportRuns({}, request({ organizationId: '' }));

    expect(calls.searchRuns).toBe(0);
  });
});

// ── Determinism ─────────────────────────────────────────────────────────────

describe('determinism', () => {
  it('produces the same bytes for the same export twice', async () => {
    const first = await harness().exports.exportRun('run-1', request());
    const second = await harness().exports.exportRun('run-1', request());

    if (first.outcome !== 'ok' || second.outcome !== 'ok') throw new Error('expected exports');
    expect(second.export.body).toBe(first.export.body);
  });

  it('produces the same bytes in NDJSON too', async () => {
    const first = await harness().exports.exportArtifacts({}, request({ format: 'ndjson' }));
    const second = await harness().exports.exportArtifacts({}, request({ format: 'ndjson' }));

    if (first.outcome !== 'ok' || second.outcome !== 'ok') throw new Error('expected exports');
    expect(second.export.body).toBe(first.export.body);
  });

  it('reads no clock of its own', async () => {
    const fixed = new Date('2001-01-01T00:00:00.000Z');
    const bench = harness();
    const service = createContentExport({
      history: bench.history,
      drafts: bench.drafts,
      search: bench.search,
      now: () => fixed,
      newExportId: () => 'export-fixed',
    });

    const result = await service.exportRun('run-1', request());
    if (result.outcome !== 'ok') return;
    expect(result.export.metadata.exportedAt).toBe(fixed.toISOString());
    expect(result.export.metadata.exportId).toBe('export-fixed');
  });

  it('generates no id of its own', async () => {
    const { exports } = harness();
    const first = await exports.exportRun('run-1', request());
    const second = await exports.exportRun('run-1', request());

    if (first.outcome !== 'ok' || second.outcome !== 'ok') throw new Error('expected exports');
    expect(first.export.metadata.exportId).toBe('export-1');
    expect(second.export.metadata.exportId).toBe('export-2');
  });
});

// ── It reads, and only reads ────────────────────────────────────────────────

describe('export changes nothing', () => {
  it('never creates, revises or removes a draft', async () => {
    const bench = harness();

    await bench.exports.exportRun('run-1', request());
    await bench.exports.exportRuns({}, request());
    await bench.exports.exportDraft('draft-1', request());
    await bench.exports.exportDrafts({}, request());
    await bench.exports.exportArtifacts({}, request());

    expect(bench.calls.createDraft).toBe(0);
    expect(bench.calls.reviseDraft).toBe(0);
    expect(bench.calls.removeDraft).toBe(0);
  });
});

describe('the refusal taxonomy', () => {
  it('reuses search’s codes, which are history’s', () => {
    for (const code of [
      'UnknownRun',
      'UnknownDraft',
      'CorruptRecord',
      'IncompatibleSchema',
      'InvalidFilter',
      'InvalidCursor',
      'IncompatibleCursor',
      'UnsupportedFilter',
    ]) {
      expect(EXPORT_CODES).toContain(code);
    }
  });

  it('adds only what an export itself can refuse', () => {
    expect(EXPORT_CODES.slice(-3)).toEqual([
      'UnsupportedFormat',
      'IncompatibleExportVersion',
      'InvalidRequest',
    ]);
  });

  it('recognises its own members and nothing else', () => {
    expect(isExportCode('UnsupportedFormat')).toBe(true);
    expect(isExportCode('unsupportedFormat')).toBe(false);
    expect(isExportCode('Exploded')).toBe(false);
  });
});
