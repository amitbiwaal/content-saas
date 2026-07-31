import { describe, expect, it } from 'vitest';

import { newDraft, type ContentDraft } from '../drafts/draft.js';
import type { DraftStatus } from '../drafts/status.js';
import {
  CONTENT_RUN_SCHEMA_VERSION,
  type StoredArtifact,
  type StoredContentRun,
} from '../runs/stored.js';
import type { RunStatus } from '../runs/state.js';
import { createContentSearch, isSearchCode, SEARCH_CODES, type SearchResult } from './service.js';
import type { ArtifactSearchCriteria, ContentSearchStore, DraftSearchCriteria } from './store.js';
import type { StoredRunCriteria } from '../history/store.js';

const at = (minute: number): string => `2026-07-31T12:${String(minute).padStart(2, '0')}:00.000Z`;

const STORED_AT = '2026-07-31T13:00:00.000Z';

// ── Records ─────────────────────────────────────────────────────────────────

interface RunShape {
  readonly runId: string;
  readonly minute: number;
  readonly status?: RunStatus;
  readonly workflowId?: string;
  readonly workspaceId?: string;
  readonly principalId?: string;
  readonly artifactCount?: number;
}

const run = (shape: RunShape): StoredContentRun => ({
  schemaVersion: CONTENT_RUN_SCHEMA_VERSION,
  createdAt: STORED_AT,
  updatedAt: STORED_AT,
  runId: shape.runId,
  status: shape.status ?? 'completed',
  execution: {
    executionId: `exec-${shape.runId}`,
    workflowId: shape.workflowId ?? 'article.draft',
    workflowVersion: 2,
    workflowRef: `${shape.workflowId ?? 'article.draft'}@2`,
    capability: 'chat',
    organizationId: 'org-1',
    organizationStatus: 'active',
    workspaceId: shape.workspaceId ?? 'ws-1',
    workspaceStatus: 'active',
    principalId: shape.principalId ?? 'user-1',
    principalKind: 'user',
    principalMethod: 'password',
    correlationId: `corr-${shape.runId}`,
    idempotencyKey: `idem-${shape.runId}`,
    timings: {
      createdAt: at(shape.minute),
      compiledAt: at(shape.minute),
      startedAt: at(shape.minute),
      finishedAt: at(shape.minute),
    },
  },
  templateVersions: [
    { templateId: 'planning.outline', templateVersion: 7, promptVersion: 'planning.outline@7' },
  ],
  failure: null,
  artifactCount: shape.artifactCount ?? 0,
});

const artifact = (runId: string, sequence: number): StoredArtifact => ({
  schemaVersion: CONTENT_RUN_SCHEMA_VERSION,
  createdAt: STORED_AT,
  updatedAt: STORED_AT,
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
  metadata: {},
});

interface DraftShape {
  readonly draftId: string;
  readonly minute: number;
  readonly status?: DraftStatus;
  readonly tags?: readonly string[];
  readonly workspaceId?: string;
  readonly workflowId?: string;
}

function draft(shape: DraftShape): ContentDraft {
  const base = newDraft({
    draftId: shape.draftId,
    metadata: {
      organizationId: 'org-1',
      workspaceId: shape.workspaceId ?? 'ws-1',
      principalId: 'user-1',
      principalKind: 'user',
      title: `Draft ${shape.draftId}`,
      tags: [...(shape.tags ?? [])],
    },
    workflowId: shape.workflowId ?? 'article.draft',
    workflowVersion: 2,
    workflowRef: `${shape.workflowId ?? 'article.draft'}@2`,
    capability: 'chat',
    templateReferences: [
      { templateId: 'planning.outline', templateVersion: 7, promptVersion: 'planning.outline@7' },
    ],
    inputs: { topic: 'tenancy' },
    now: at(shape.minute),
  });

  // The status a shape asks for, reached the way the lifecycle allows.
  return shape.status === undefined || shape.status === 'draft'
    ? base
    : Object.freeze({
        ...base,
        revisions: Object.freeze([
          ...base.revisions,
          Object.freeze({
            revision: 2,
            status: shape.status,
            inputs: { topic: 'tenancy' },
            title: `Draft ${shape.draftId}`,
            note: 'Moved on.',
            createdAt: at(shape.minute),
          }),
        ]),
      });
}

// ── Store ───────────────────────────────────────────────────────────────────

interface Contents {
  readonly runs?: readonly StoredContentRun[];
  readonly artifacts?: readonly StoredArtifact[];
  readonly drafts?: readonly ContentDraft[];
}

/**
 * An in-memory store honouring all three query contracts.
 *
 * The only implementation anywhere near this package, and it doubles as the
 * specification an implementer reads.
 */
function memoryStore(contents: Contents = {}) {
  const runs = [...(contents.runs ?? [])];
  const artifacts = [...(contents.artifacts ?? [])];
  const drafts = [...(contents.drafts ?? [])];

  const calls = {
    queryRuns: 0,
    queryDrafts: 0,
    queryArtifacts: 0,
    loadRun: 0,
    loadArtifacts: 0,
    loadDraft: 0,
    saveRun: 0,
    saveDraft: 0,
    updateStatus: 0,
    updateDraft: 0,
    deleteDraft: 0,
    listDrafts: 0,
  };
  const seenRuns: StoredRunCriteria[] = [];
  const seenDrafts: DraftSearchCriteria[] = [];
  const seenArtifacts: ArtifactSearchCriteria[] = [];

  const runById = (runId: string): StoredContentRun | undefined =>
    runs.find((entry) => entry.runId === runId);

  const runMatches = (
    entry: StoredContentRun,
    criteria: {
      organizationId: string | null;
      workspaceId: string | null;
      principalId: string | null;
      workflowId: string | null;
      statuses: readonly RunStatus[] | null;
      createdAfter: string | null;
      createdBefore: string | null;
    },
  ): boolean => {
    const { execution } = entry;
    const createdAt = execution.timings.createdAt;
    if (criteria.organizationId !== null && execution.organizationId !== criteria.organizationId)
      return false;
    if (criteria.workspaceId !== null && execution.workspaceId !== criteria.workspaceId)
      return false;
    if (criteria.principalId !== null && execution.principalId !== criteria.principalId)
      return false;
    if (criteria.workflowId !== null && execution.workflowId !== criteria.workflowId) return false;
    if (criteria.statuses !== null && !criteria.statuses.includes(entry.status)) return false;
    if (criteria.createdAfter !== null && createdAt < criteria.createdAfter) return false;
    if (criteria.createdBefore !== null && createdAt >= criteria.createdBefore) return false;
    return true;
  };

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
    // ── S4.4 ──────────────────────────────────────────────────────────────
    saveRun: () => {
      calls.saveRun += 1;
      return Promise.resolve();
    },
    loadRun: (runId) => {
      calls.loadRun += 1;
      return Promise.resolve(runById(runId) ?? null);
    },
    loadArtifacts: (runId) => {
      calls.loadArtifacts += 1;
      return Promise.resolve(artifacts.filter((entry) => entry.runId === runId));
    },
    updateStatus: () => {
      calls.updateStatus += 1;
      return Promise.resolve();
    },

    // ── S4.5 ──────────────────────────────────────────────────────────────
    queryRuns: (criteria) => {
      calls.queryRuns += 1;
      seenRuns.push(criteria);

      const matched = runs.filter((entry) => runMatches(entry, criteria));
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

    // ── S4.6 ──────────────────────────────────────────────────────────────
    saveDraft: () => {
      calls.saveDraft += 1;
      return Promise.resolve();
    },
    loadDraft: (draftId) => {
      calls.loadDraft += 1;
      return Promise.resolve(drafts.find((entry) => entry.draftId === draftId) ?? null);
    },
    updateDraft: () => {
      calls.updateDraft += 1;
      return Promise.resolve();
    },
    deleteDraft: () => {
      calls.deleteDraft += 1;
      return Promise.resolve();
    },
    listDrafts: () => {
      calls.listDrafts += 1;
      return Promise.resolve({ drafts: [...drafts] });
    },

    // ── S4.7 ──────────────────────────────────────────────────────────────
    queryDrafts: (criteria) => {
      calls.queryDrafts += 1;
      seenDrafts.push(criteria);

      const matched = drafts.filter((entry) => {
        const status = entry.revisions[entry.revisions.length - 1]?.status;
        if (
          criteria.organizationId !== null &&
          entry.metadata.organizationId !== criteria.organizationId
        )
          return false;
        if (criteria.workspaceId !== null && entry.metadata.workspaceId !== criteria.workspaceId)
          return false;
        if (criteria.principalId !== null && entry.metadata.principalId !== criteria.principalId)
          return false;
        if (criteria.workflowId !== null && entry.workflowId !== criteria.workflowId) return false;
        if (criteria.draftId !== null && entry.draftId !== criteria.draftId) return false;
        if (
          criteria.statuses !== null &&
          (status === undefined || !criteria.statuses.includes(status))
        )
          return false;
        if (
          criteria.tags !== null &&
          !criteria.tags.every((tag) => entry.metadata.tags.includes(tag))
        )
          return false;
        if (criteria.createdAfter !== null && entry.createdAt < criteria.createdAfter) return false;
        if (criteria.createdBefore !== null && entry.createdAt >= criteria.createdBefore)
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
      calls.queryArtifacts += 1;
      seenArtifacts.push(criteria);

      const key = (entry: StoredArtifact): { clock: string; tie: string } => ({
        clock: runById(entry.runId)?.execution.timings.createdAt ?? entry.createdAt,
        tie: `${entry.runId}#${String(entry.sequence)}`,
      });

      const matched = artifacts.filter((entry) => {
        const parent = runById(entry.runId);
        if (parent === undefined) return false;
        if (criteria.runId !== null && entry.runId !== criteria.runId) return false;
        return runMatches(parent, criteria);
      });

      const ordered = matched.sort((left, right) => {
        const leftKey = key(left);
        const rightKey = key(right);
        const value = compare(leftKey.clock, leftKey.tie, rightKey.clock, rightKey.tie);
        return criteria.order === 'newest' ? -value : value;
      });

      const after = criteria.after;
      const remaining =
        after === null
          ? ordered
          : ordered.filter((entry) => {
              const entryKey = key(entry);
              const value = compare(
                entryKey.clock,
                entryKey.tie,
                after.createdAt,
                `${after.runId}#${String(after.sequence)}`,
              );
              return criteria.order === 'newest' ? value < 0 : value > 0;
            });

      const kept = remaining.slice(0, criteria.limit);
      const runCreatedAt: Record<string, string> = {};
      for (const entry of kept) runCreatedAt[entry.runId] = key(entry).clock;

      return Promise.resolve({ artifacts: kept, runCreatedAt });
    },
  };

  return {
    store,
    calls,
    seenRuns,
    seenDrafts,
    seenArtifacts,
    search: createContentSearch({ store }),
  };
}

// ── Fixtures ────────────────────────────────────────────────────────────────

const RUNS: readonly StoredContentRun[] = [
  run({ runId: 'run-a', minute: 1, artifactCount: 2 }),
  run({ runId: 'run-b', minute: 2, status: 'failed', artifactCount: 1 }),
  run({ runId: 'run-c', minute: 3, workflowId: 'article.review', artifactCount: 1 }),
  run({ runId: 'run-d', minute: 4, workspaceId: 'ws-2', artifactCount: 0 }),
];

const ARTIFACTS: readonly StoredArtifact[] = [
  artifact('run-a', 0),
  artifact('run-a', 1),
  artifact('run-b', 0),
  artifact('run-c', 0),
];

const DRAFTS: readonly ContentDraft[] = [
  draft({ draftId: 'draft-a', minute: 1, tags: ['article'] }),
  draft({ draftId: 'draft-b', minute: 2, status: 'ready', tags: ['article', 'seo'] }),
  draft({ draftId: 'draft-c', minute: 3, workflowId: 'article.review' }),
  draft({ draftId: 'draft-d', minute: 4, workspaceId: 'ws-2' }),
];

const everything = () => memoryStore({ runs: RUNS, artifacts: ARTIFACTS, drafts: DRAFTS });

// ── Runs ────────────────────────────────────────────────────────────────────

describe('searching runs', () => {
  it('returns run hits, newest first', async () => {
    const { search } = everything();
    const result = await search.searchRuns();

    expect(result.outcome).toBe('ok');
    if (result.outcome !== 'ok') return;
    expect(result.page.items.map((hit) => hit.kind === 'run' && hit.run.runId)).toEqual([
      'run-d',
      'run-c',
      'run-b',
      'run-a',
    ]);
  });

  it('goes through the history service, not a query of its own', async () => {
    // History owns the filter, the record checks, the ordering and the paging.
    const bench = everything();
    await bench.search.searchRuns();

    expect(bench.calls.queryRuns).toBe(1);
    expect(bench.seenRuns[0]).toMatchObject({ order: 'newest', after: null });
  });

  it('answers a run id through the frozen by-id contract', async () => {
    const bench = everything();
    const result = await bench.search.searchRuns({ filter: { runId: 'run-b' } });

    expect(result.outcome).toBe('ok');
    if (result.outcome !== 'ok') return;
    expect(result.page.items).toHaveLength(1);
    expect(bench.calls.loadRun).toBe(1);
    expect(bench.calls.queryRuns).toBe(0);
  });

  it('refuses a run id that is not there', async () => {
    const { search } = everything();
    const result = await search.searchRuns({ filter: { runId: 'run-nothing' } });

    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') return;
    expect(result.code).toBe('UnknownRun');
  });

  it('narrows by workspace, workflow and status', async () => {
    const { search } = everything();

    const byWorkspace = await search.searchRuns({ filter: { workspaceId: 'ws-2' } });
    const byWorkflow = await search.searchRuns({ filter: { workflowId: 'article.review' } });
    const byStatus = await search.searchRuns({ filter: { statuses: ['failed'] } });

    for (const result of [byWorkspace, byWorkflow, byStatus]) {
      expect(result.outcome).toBe('ok');
      if (result.outcome !== 'ok') continue;
      expect(result.page.items).toHaveLength(1);
    }
  });

  it('narrows by a half-open time window', async () => {
    const { search } = everything();
    const result = await search.searchRuns({
      filter: { createdAfter: at(2), createdBefore: at(4) },
      order: 'oldest',
    });

    if (result.outcome !== 'ok') return;
    expect(result.page.items.map((hit) => hit.kind === 'run' && hit.run.runId)).toEqual([
      'run-b',
      'run-c',
    ]);
  });

  it('projects to the history read model, which carries no persistence fields', async () => {
    const { search } = everything();
    const result = await search.searchRuns();

    if (result.outcome !== 'ok') return;
    const [first] = result.page.items;
    expect(first?.kind).toBe('run');
    if (first?.kind !== 'run') return;
    expect(Object.keys(first.run)).not.toContain('schemaVersion');
    expect(first.run.workflowRef).toBe('article.draft@2');
  });

  it('refuses a dimension a run search cannot honour', async () => {
    const { search, calls } = everything();
    const result = await search.searchRuns({ filter: { tags: ['article'] } });

    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') return;
    expect(result.code).toBe('UnsupportedFilter');
    expect(calls.queryRuns).toBe(0);
  });
});

// ── Drafts ──────────────────────────────────────────────────────────────────

describe('searching drafts', () => {
  it('returns draft hits, newest updated first', async () => {
    const { search } = everything();
    const result = await search.searchDrafts();

    expect(result.outcome).toBe('ok');
    if (result.outcome !== 'ok') return;
    expect(result.page.items.map((hit) => hit.kind === 'draft' && hit.draft.draftId)).toEqual([
      'draft-d',
      'draft-c',
      'draft-b',
      'draft-a',
    ]);
  });

  it('sends explicit nulls for the dimensions that are off', async () => {
    const { search, seenDrafts } = everything();
    await search.searchDrafts();

    expect(seenDrafts[0]).toMatchObject({
      organizationId: null,
      workspaceId: null,
      principalId: null,
      workflowId: null,
      draftId: null,
      statuses: null,
      tags: null,
      createdAfter: null,
      createdBefore: null,
      after: null,
    });
  });

  it('asks for one more than the page', async () => {
    const { search, seenDrafts } = everything();
    await search.searchDrafts({ limit: 2 });

    expect(seenDrafts[0]?.limit).toBe(3);
  });

  it('narrows by tag, and requires every named one', async () => {
    const { search } = everything();

    const one = await search.searchDrafts({ filter: { tags: ['article'] } });
    const both = await search.searchDrafts({ filter: { tags: ['article', 'seo'] } });

    if (one.outcome !== 'ok' || both.outcome !== 'ok') throw new Error('expected pages');
    expect(one.page.items).toHaveLength(2);
    expect(both.page.items).toHaveLength(1);
  });

  it('narrows by draft status', async () => {
    const { search } = everything();
    const result = await search.searchDrafts({ filter: { statuses: ['ready'] } });

    if (result.outcome !== 'ok') return;
    expect(result.page.items.map((hit) => hit.kind === 'draft' && hit.draft.draftId)).toEqual([
      'draft-b',
    ]);
  });

  it('narrows by workspace and workflow', async () => {
    const { search } = everything();

    const byWorkspace = await search.searchDrafts({ filter: { workspaceId: 'ws-2' } });
    const byWorkflow = await search.searchDrafts({ filter: { workflowId: 'article.review' } });

    for (const result of [byWorkspace, byWorkflow]) {
      if (result.outcome !== 'ok') throw new Error('expected a page');
      expect(result.page.items).toHaveLength(1);
    }
  });

  it('orders deterministically even when the store does not', async () => {
    const shuffled = [DRAFTS[2], DRAFTS[0], DRAFTS[3], DRAFTS[1]] as ContentDraft[];
    const first = await memoryStore({ drafts: shuffled }).search.searchDrafts();
    const second = await memoryStore({ drafts: DRAFTS }).search.searchDrafts();

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('carries no inputs on a hit', async () => {
    const { search } = everything();
    const result = await search.searchDrafts();

    if (result.outcome !== 'ok') return;
    expect(JSON.stringify(result.page.items)).not.toContain('tenancy');
  });

  it('refuses a dimension a draft search cannot honour', async () => {
    const { search, calls } = everything();
    const result = await search.searchDrafts({ filter: { runId: 'run-a' } });

    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') return;
    expect(result.code).toBe('UnsupportedFilter');
    expect(calls.queryDrafts).toBe(0);
  });
});

// ── Artifacts ───────────────────────────────────────────────────────────────

describe('searching artifacts', () => {
  it('returns artifact hits across runs, newest run first', async () => {
    const { search } = everything();
    const result = await search.searchArtifacts();

    expect(result.outcome).toBe('ok');
    if (result.outcome !== 'ok') return;
    expect(
      result.page.items.map(
        (hit) =>
          hit.kind === 'artifact' && `${hit.artifact.runId}:${String(hit.artifact.sequence)}`,
      ),
    ).toEqual(['run-c:0', 'run-b:0', 'run-a:1', 'run-a:0']);
  });

  it('orders oldest first the other way, step by step', async () => {
    const { search } = everything();
    const result = await search.searchArtifacts({ order: 'oldest' });

    if (result.outcome !== 'ok') return;
    expect(
      result.page.items.map(
        (hit) =>
          hit.kind === 'artifact' && `${hit.artifact.runId}:${String(hit.artifact.sequence)}`,
      ),
    ).toEqual(['run-a:0', 'run-a:1', 'run-b:0', 'run-c:0']);
  });

  it('narrows by run', async () => {
    const { search } = everything();
    const result = await search.searchArtifacts({ filter: { runId: 'run-a' } });

    if (result.outcome !== 'ok') return;
    expect(result.page.items).toHaveLength(2);
  });

  it('narrows by the run’s workflow and status', async () => {
    const { search } = everything();

    const byWorkflow = await search.searchArtifacts({ filter: { workflowId: 'article.review' } });
    const byStatus = await search.searchArtifacts({ filter: { statuses: ['failed'] } });

    for (const result of [byWorkflow, byStatus]) {
      if (result.outcome !== 'ok') throw new Error('expected a page');
      expect(result.page.items).toHaveLength(1);
    }
  });

  it('projects to the history artifact view, with usage preserved', async () => {
    const { search } = everything();
    const result = await search.searchArtifacts();

    if (result.outcome !== 'ok') return;
    const [first] = result.page.items;
    if (first?.kind !== 'artifact') throw new Error('expected an artifact hit');
    expect(Object.keys(first.artifact)).not.toContain('schemaVersion');
    expect(first.artifact.usage.totalTokens).toBe(30);
    expect(first.artifact.prompt.promptVersion).toBe('planning.outline@7');
  });

  it('refuses a page holding a record it cannot trust', async () => {
    const broken = [{ ...(ARTIFACTS[0] as StoredArtifact), attempts: 0 }];
    const bench = memoryStore({ runs: RUNS, artifacts: broken });
    const result = await bench.search.searchArtifacts();

    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') return;
    expect(result.code).toBe('CorruptRecord');
  });

  it('refuses a record from a schema this build does not read', async () => {
    const future = [{ ...(ARTIFACTS[0] as StoredArtifact), schemaVersion: 99 }];
    const bench = memoryStore({ runs: RUNS, artifacts: future });
    const result = await bench.search.searchArtifacts();

    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') return;
    expect(result.code).toBe('IncompatibleSchema');
  });

  it('refuses a dimension an artifact search cannot honour', async () => {
    const { search, calls } = everything();
    const result = await search.searchArtifacts({ filter: { draftId: 'draft-a' } });

    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') return;
    expect(result.code).toBe('UnsupportedFilter');
    expect(calls.queryArtifacts).toBe(0);
  });
});

// ── Pagination ──────────────────────────────────────────────────────────────

describe('cursor pagination', () => {
  const walk = async (
    next: (cursor: string | null) => Promise<SearchResult>,
  ): Promise<readonly string[]> => {
    const seen: string[] = [];
    let cursor: string | null = null;

    for (let index = 0; index < 20; index += 1) {
      const result = await next(cursor);
      if (result.outcome !== 'ok') throw new Error(`expected a page: ${result.reason}`);
      for (const hit of result.page.items) {
        seen.push(
          hit.kind === 'run'
            ? hit.run.runId
            : hit.kind === 'draft'
              ? hit.draft.draftId
              : `${hit.artifact.runId}:${String(hit.artifact.sequence)}`,
        );
      }
      cursor = result.page.nextCursor;
      if (cursor === null) break;
    }

    return seen;
  };

  it('walks every run exactly once', async () => {
    const { search } = everything();
    const seen = await walk((cursor) =>
      search.searchRuns({ limit: 1, ...(cursor === null ? {} : { cursor }) }),
    );

    expect(seen).toEqual(['run-d', 'run-c', 'run-b', 'run-a']);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('walks every draft exactly once', async () => {
    const { search } = everything();
    const seen = await walk((cursor) =>
      search.searchDrafts({ limit: 1, ...(cursor === null ? {} : { cursor }) }),
    );

    expect(seen).toEqual(['draft-d', 'draft-c', 'draft-b', 'draft-a']);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('walks every artifact exactly once, across runs', async () => {
    const { search } = everything();
    const seen = await walk((cursor) =>
      search.searchArtifacts({ limit: 1, ...(cursor === null ? {} : { cursor }) }),
    );

    expect(seen).toEqual(['run-c:0', 'run-b:0', 'run-a:1', 'run-a:0']);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('walks artifacts the other way too', async () => {
    const { search } = everything();
    const seen = await walk((cursor) =>
      search.searchArtifacts({ limit: 2, order: 'oldest', ...(cursor === null ? {} : { cursor }) }),
    );

    expect(seen).toEqual(['run-a:0', 'run-a:1', 'run-b:0', 'run-c:0']);
  });

  it('hands back no cursor on the last page', async () => {
    const { search } = everything();
    const result = await search.searchDrafts({ limit: 50 });

    if (result.outcome !== 'ok') return;
    expect(result.page.hasMore).toBe(false);
    expect(result.page.nextCursor).toBeNull();
  });

  it('gives the store a position, never an offset', async () => {
    const { search, seenDrafts } = everything();
    const first = await search.searchDrafts({ limit: 1 });
    if (first.outcome !== 'ok' || first.page.nextCursor === null) throw new Error('expected more');
    await search.searchDrafts({ limit: 1, cursor: first.page.nextCursor });

    expect(seenDrafts[1]?.after).toEqual({ updatedAt: at(4), draftId: 'draft-d' });
    expect(JSON.stringify(seenDrafts[1])).not.toContain('offset');
  });

  it('refuses a cursor that is not one', async () => {
    const { search } = everything();
    const result = await search.searchDrafts({ cursor: 'not-a-cursor' });

    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') return;
    expect(result.code).toBe('InvalidCursor');
  });

  it('refuses a cursor issued for a different filter', async () => {
    const { search } = everything();
    const first = await search.searchDrafts({ limit: 1 });
    if (first.outcome !== 'ok' || first.page.nextCursor === null) throw new Error('expected more');

    const result = await search.searchDrafts({
      limit: 1,
      filter: { workspaceId: 'ws-2' },
      cursor: first.page.nextCursor,
    });

    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') return;
    expect(result.code).toBe('IncompatibleCursor');
  });

  it('refuses a draft cursor on an artifact search', async () => {
    // The canonical form includes the KIND, so a position from one sequence can
    // never be read in another.
    const { search } = everything();
    const first = await search.searchDrafts({ limit: 1 });
    if (first.outcome !== 'ok' || first.page.nextCursor === null) throw new Error('expected more');

    const result = await search.searchArtifacts({ limit: 1, cursor: first.page.nextCursor });

    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') return;
    expect(result.code).toBe('IncompatibleCursor');
  });

  it('never asks the store when a cursor is refused', async () => {
    const { search, calls } = everything();
    await search.searchDrafts({ cursor: 'rubbish' });

    expect(calls.queryDrafts).toBe(0);
  });
});

// ── It reads, and only reads ────────────────────────────────────────────────

describe('search writes nothing', () => {
  it('never saves, updates or deletes', async () => {
    const bench = everything();

    await bench.search.searchRuns();
    await bench.search.searchDrafts();
    await bench.search.searchArtifacts();
    await bench.search.searchRuns({ filter: { runId: 'run-a' } });

    expect(bench.calls.saveRun).toBe(0);
    expect(bench.calls.saveDraft).toBe(0);
    expect(bench.calls.updateStatus).toBe(0);
    expect(bench.calls.updateDraft).toBe(0);
    expect(bench.calls.deleteDraft).toBe(0);
  });

  it('freezes every page it returns', async () => {
    const { search } = everything();
    const result = await search.searchArtifacts();

    if (result.outcome !== 'ok') return;
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.page)).toBe(true);
    expect(Object.isFrozen(result.page.items)).toBe(true);
    expect(Object.isFrozen(result.page.items[0])).toBe(true);
  });
});

describe('the refusal taxonomy', () => {
  it('reuses history’s codes rather than restating them', () => {
    for (const code of [
      'UnknownRun',
      'IncompatibleSchema',
      'CorruptRecord',
      'InvalidFilter',
      'InvalidCursor',
      'IncompatibleCursor',
    ]) {
      expect(SEARCH_CODES).toContain(code);
    }
  });

  it('adds only what search itself can refuse', () => {
    expect([...SEARCH_CODES]).toEqual([
      'UnknownRun',
      'IncompatibleSchema',
      'CorruptRecord',
      'InvalidFilter',
      'InvalidCursor',
      'IncompatibleCursor',
      'UnsupportedFilter',
      'UnknownDraft',
    ]);
  });

  it('recognises its own members and nothing else', () => {
    expect(isSearchCode('UnsupportedFilter')).toBe(true);
    expect(isSearchCode('unsupportedFilter')).toBe(false);
    expect(isSearchCode('Exploded')).toBe(false);
  });
});
