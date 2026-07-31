import { describe, expect, it } from 'vitest';

import type { SaveRunInput, UpdateStatusInput } from '../runs/repository.js';
import type { RunStatus } from '../runs/state.js';
import {
  CONTENT_RUN_SCHEMA_VERSION,
  type StoredArtifact,
  type StoredContentRun,
} from '../runs/stored.js';
import { createRunHistory, RUN_HISTORY_CODES, isRunHistoryCode } from './service.js';
import type { ContentRunHistoryStore, StoredRunCriteria } from './store.js';

const STORED_AT = '2026-07-31T12:00:09.000Z';

const at = (minute: number): string => `2026-07-31T12:${String(minute).padStart(2, '0')}:00.000Z`;

interface Shape {
  readonly runId: string;
  readonly minute: number;
  readonly status?: RunStatus;
  readonly workflowId?: string;
  readonly workspaceId?: string;
  readonly organizationId?: string;
  readonly principalId?: string;
  readonly artifactCount?: number;
}

const run = (shape: Shape): StoredContentRun => ({
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
    organizationId: shape.organizationId ?? 'org-1',
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
  content: `artifact ${String(sequence)}`,
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

/**
 * An in-memory store that honours the criteria faithfully.
 *
 * The only implementation anywhere near this package — the port exists so the
 * real one lives elsewhere — and it doubles as the specification an
 * implementer reads: every dimension applied, `after` strict, `limit` obeyed.
 */
function memoryStore(
  runs: readonly StoredContentRun[],
  artifacts: ReadonlyMap<string, readonly StoredArtifact[]> = new Map(),
) {
  const calls = { queryRuns: 0, loadRun: 0, loadArtifacts: 0, saveRun: 0, updateStatus: 0 };
  const seen: StoredRunCriteria[] = [];

  const store: ContentRunHistoryStore = {
    queryRuns: (criteria) => {
      calls.queryRuns += 1;
      seen.push(criteria);

      const matched = runs.filter((entry) => {
        const { execution } = entry;
        const createdAt = execution.timings.createdAt;
        if (
          criteria.organizationId !== null &&
          execution.organizationId !== criteria.organizationId
        )
          return false;
        if (criteria.workspaceId !== null && execution.workspaceId !== criteria.workspaceId)
          return false;
        if (criteria.principalId !== null && execution.principalId !== criteria.principalId)
          return false;
        if (criteria.workflowId !== null && execution.workflowId !== criteria.workflowId)
          return false;
        if (criteria.statuses !== null && !criteria.statuses.includes(entry.status)) return false;
        if (criteria.createdAfter !== null && createdAt < criteria.createdAfter) return false;
        if (criteria.createdBefore !== null && createdAt >= criteria.createdBefore) return false;
        return true;
      });

      const key = (entry: StoredContentRun): string =>
        `${entry.execution.timings.createdAt}|${entry.runId}`;

      const ordered = [...matched].sort((left, right) => {
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
    loadRun: (runId) => {
      calls.loadRun += 1;
      return Promise.resolve(runs.find((entry) => entry.runId === runId) ?? null);
    },
    loadArtifacts: (runId) => {
      calls.loadArtifacts += 1;
      return Promise.resolve(artifacts.get(runId) ?? []);
    },
    saveRun: (_input: SaveRunInput) => {
      calls.saveRun += 1;
      return Promise.resolve();
    },
    updateStatus: (_input: UpdateStatusInput) => {
      calls.updateStatus += 1;
      return Promise.resolve();
    },
  };

  return { store, calls, seen, history: createRunHistory({ store }) };
}

const SPREAD: readonly StoredContentRun[] = [
  run({ runId: 'run-a', minute: 1 }),
  run({ runId: 'run-b', minute: 2, status: 'failed' }),
  run({ runId: 'run-c', minute: 3, workflowId: 'article.review' }),
  run({ runId: 'run-d', minute: 4, workspaceId: 'ws-2' }),
  run({ runId: 'run-e', minute: 5, principalId: 'user-2' }),
];

// ── Lookup ──────────────────────────────────────────────────────────────────

describe('getRunById', () => {
  it('returns the run as a view', async () => {
    const { history } = memoryStore(SPREAD);
    const result = await history.getRunById('run-a');

    expect(result.outcome).toBe('found');
    if (result.outcome !== 'found') return;
    expect(result.run.runId).toBe('run-a');
    expect(result.run.workflowRef).toBe('article.draft@2');
  });

  it('reuses the repository contract, without a query', async () => {
    const { history, calls } = memoryStore(SPREAD);
    await history.getRunById('run-a');

    expect(calls.loadRun).toBe(1);
    expect(calls.queryRuns).toBe(0);
  });

  it('loads no artifacts, which a summary does not need', async () => {
    const { history, calls } = memoryStore(SPREAD);
    await history.getRunById('run-a');

    expect(calls.loadArtifacts).toBe(0);
  });

  it('refuses a run that is not there', async () => {
    const { history } = memoryStore(SPREAD);
    const result = await history.getRunById('run-nothing');

    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') return;
    expect(result.code).toBe('UnknownRun');
  });

  it('refuses a blank id rather than asking the store', async () => {
    const { history, calls } = memoryStore(SPREAD);
    const result = await history.getRunById('   ');

    expect(result.outcome).toBe('refused');
    expect(calls.loadRun).toBe(0);
  });

  it('refuses a record from a schema this build does not read', async () => {
    const { history } = memoryStore([{ ...(SPREAD[0] as StoredContentRun), schemaVersion: 99 }]);
    const result = await history.getRunById('run-a');

    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') return;
    expect(result.code).toBe('IncompatibleSchema');
  });

  it('refuses a corrupted record rather than showing it', async () => {
    const { history } = memoryStore([
      { ...(SPREAD[0] as StoredContentRun), status: 'paused' as RunStatus },
    ]);
    const result = await history.getRunById('run-a');

    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') return;
    expect(result.code).toBe('CorruptRecord');
    expect(result.issues.map((issue) => issue.code)).toContain('UNKNOWN_STATUS');
  });
});

// ── Listing ─────────────────────────────────────────────────────────────────

describe('listRuns', () => {
  it('returns every run, newest first', async () => {
    const { history } = memoryStore(SPREAD);
    const result = await history.listRuns();

    expect(result.outcome).toBe('ok');
    if (result.outcome !== 'ok') return;
    expect(result.page.items.map((view) => view.runId)).toEqual([
      'run-e',
      'run-d',
      'run-c',
      'run-b',
      'run-a',
    ]);
  });

  it('reverses on request', async () => {
    const { history } = memoryStore(SPREAD);
    const result = await history.listRuns({ order: 'oldest' });

    expect(result.outcome).toBe('ok');
    if (result.outcome !== 'ok') return;
    expect(result.page.items.map((view) => view.runId)).toEqual([
      'run-a',
      'run-b',
      'run-c',
      'run-d',
      'run-e',
    ]);
  });

  it('orders deterministically even when the store does not', async () => {
    // The service sorts what it is handed. Cursor paging is only correct over a
    // total order, and an unordered store would otherwise produce pages that
    // skip and repeat while looking entirely normal.
    const shuffled = [SPREAD[3], SPREAD[0], SPREAD[4], SPREAD[1], SPREAD[2]] as StoredContentRun[];
    const { history } = memoryStore(shuffled);
    const first = await history.listRuns();
    const second = await history.listRuns();

    expect(first).toEqual(second);
    if (first.outcome !== 'ok') return;
    expect(first.page.items.map((view) => view.runId)).toEqual([
      'run-e',
      'run-d',
      'run-c',
      'run-b',
      'run-a',
    ]);
  });

  it('breaks a timestamp tie by run id, so the order is total', async () => {
    const tied = [run({ runId: 'run-y', minute: 1 }), run({ runId: 'run-x', minute: 1 })];
    const { history } = memoryStore(tied);
    const result = await history.listRuns({ order: 'oldest' });

    expect(result.outcome).toBe('ok');
    if (result.outcome !== 'ok') return;
    expect(result.page.items.map((view) => view.runId)).toEqual(['run-x', 'run-y']);
  });

  it('asks the store for one more than the page, to learn there is another', async () => {
    const { history, seen } = memoryStore(SPREAD);
    await history.listRuns({ limit: 2 });

    expect(seen[0]?.limit).toBe(3);
  });

  it('passes every filter dimension through to the store', async () => {
    const { history, seen } = memoryStore(SPREAD);
    await history.listRuns({
      filter: {
        organizationId: 'org-1',
        workspaceId: 'ws-1',
        principalId: 'user-1',
        workflowId: 'article.draft',
        statuses: ['completed'],
        createdAfter: at(1),
        createdBefore: at(9),
      },
    });

    expect(seen[0]).toMatchObject({
      organizationId: 'org-1',
      workspaceId: 'ws-1',
      principalId: 'user-1',
      workflowId: 'article.draft',
      statuses: ['completed'],
      createdAfter: at(1),
      createdBefore: at(9),
    });
  });

  it('sends explicit nulls for the dimensions that are off', async () => {
    // An implementer sees every dimension, including the ones not in use.
    const { history, seen } = memoryStore(SPREAD);
    await history.listRuns();

    expect(seen[0]).toMatchObject({
      organizationId: null,
      workspaceId: null,
      principalId: null,
      workflowId: null,
      statuses: null,
      createdAfter: null,
      createdBefore: null,
      after: null,
    });
  });

  it('returns views, not records', async () => {
    const { history } = memoryStore(SPREAD);
    const result = await history.listRuns();

    expect(result.outcome).toBe('ok');
    if (result.outcome !== 'ok') return;
    expect(Object.keys(result.page.items[0] ?? {})).not.toContain('schemaVersion');
  });

  it('freezes the page through', async () => {
    const { history } = memoryStore(SPREAD);
    const result = await history.listRuns();

    if (result.outcome !== 'ok') return;
    expect(Object.isFrozen(result.page)).toBe(true);
    expect(Object.isFrozen(result.page.items)).toBe(true);
    expect(Object.isFrozen(result.page.items[0])).toBe(true);
  });

  it('refuses the page when any record on it is corrupt', async () => {
    // Skipping it would hand back a page that looks complete and is not.
    const { history } = memoryStore([
      SPREAD[0] as StoredContentRun,
      { ...(SPREAD[1] as StoredContentRun), runId: '' },
    ]);
    const result = await history.listRuns();

    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') return;
    expect(result.code).toBe('CorruptRecord');
  });
});

describe('filtering', () => {
  it('narrows by workspace', async () => {
    const { history } = memoryStore(SPREAD);
    const result = await history.listRuns({ filter: { workspaceId: 'ws-2' } });

    if (result.outcome !== 'ok') return;
    expect(result.page.items.map((view) => view.runId)).toEqual(['run-d']);
  });

  it('narrows by principal', async () => {
    const { history } = memoryStore(SPREAD);
    const result = await history.listRuns({ filter: { principalId: 'user-2' } });

    if (result.outcome !== 'ok') return;
    expect(result.page.items.map((view) => view.runId)).toEqual(['run-e']);
  });

  it('narrows by status', async () => {
    const { history } = memoryStore(SPREAD);
    const result = await history.listRuns({ filter: { statuses: ['failed'] } });

    if (result.outcome !== 'ok') return;
    expect(result.page.items.map((view) => view.runId)).toEqual(['run-b']);
  });

  it('narrows by a half-open time window', async () => {
    const { history } = memoryStore(SPREAD);
    const result = await history.listRuns({
      filter: { createdAfter: at(2), createdBefore: at(4) },
      order: 'oldest',
    });

    if (result.outcome !== 'ok') return;
    expect(result.page.items.map((view) => view.runId)).toEqual(['run-b', 'run-c']);
  });

  it('refuses a query it cannot honour, and asks the store nothing', async () => {
    const { history, calls } = memoryStore(SPREAD);
    const result = await history.listRuns({ filter: { statuses: [] } });

    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') return;
    expect(result.code).toBe('InvalidFilter');
    expect(calls.queryRuns).toBe(0);
  });

  it('names every problem with the query', async () => {
    const { history } = memoryStore(SPREAD);
    const result = await history.listRuns({ filter: { workspaceId: '' }, limit: 0 });

    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') return;
    expect(result.issues.map((issue) => issue.field)).toEqual(['filter.workspaceId', 'limit']);
  });
});

// ── Pagination ──────────────────────────────────────────────────────────────

describe('cursor pagination', () => {
  it('reports that there is more, and hands back a cursor', async () => {
    const { history } = memoryStore(SPREAD);
    const result = await history.listRuns({ limit: 2 });

    expect(result.outcome).toBe('ok');
    if (result.outcome !== 'ok') return;
    expect(result.page.items).toHaveLength(2);
    expect(result.page.hasMore).toBe(true);
    expect(result.page.nextCursor).not.toBeNull();
  });

  it('hands back no cursor on the last page', async () => {
    // A cursor there invites a caller to fetch an empty page forever.
    const { history } = memoryStore(SPREAD);
    const result = await history.listRuns({ limit: 10 });

    if (result.outcome !== 'ok') return;
    expect(result.page.hasMore).toBe(false);
    expect(result.page.nextCursor).toBeNull();
  });

  it('walks the whole history, once, in order', async () => {
    const { history } = memoryStore(SPREAD);
    const seen: string[] = [];
    let cursor: string | null = null;

    for (let page = 0; page < 10; page += 1) {
      const result: Awaited<ReturnType<typeof history.listRuns>> = await history.listRuns({
        limit: 2,
        ...(cursor === null ? {} : { cursor }),
      });
      if (result.outcome !== 'ok') throw new Error('expected a page');
      seen.push(...result.page.items.map((view) => view.runId));
      cursor = result.page.nextCursor;
      if (cursor === null) break;
    }

    expect(seen).toEqual(['run-e', 'run-d', 'run-c', 'run-b', 'run-a']);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('walks it the other way too', async () => {
    const { history } = memoryStore(SPREAD);
    const seen: string[] = [];
    let cursor: string | null = null;

    for (let page = 0; page < 10; page += 1) {
      const result: Awaited<ReturnType<typeof history.listRuns>> = await history.listRuns({
        limit: 2,
        order: 'oldest',
        ...(cursor === null ? {} : { cursor }),
      });
      if (result.outcome !== 'ok') throw new Error('expected a page');
      seen.push(...result.page.items.map((view) => view.runId));
      cursor = result.page.nextCursor;
      if (cursor === null) break;
    }

    expect(seen).toEqual(['run-a', 'run-b', 'run-c', 'run-d', 'run-e']);
  });

  it('gives the store the position, never an offset', async () => {
    const { history, seen } = memoryStore(SPREAD);
    const first = await history.listRuns({ limit: 2 });
    if (first.outcome !== 'ok' || first.page.nextCursor === null) throw new Error('expected more');
    await history.listRuns({ limit: 2, cursor: first.page.nextCursor });

    expect(seen[1]?.after).toEqual({ createdAt: at(4), runId: 'run-d' });
    expect(JSON.stringify(seen[1])).not.toContain('offset');
  });

  it('refuses a cursor that is not one', async () => {
    const { history } = memoryStore(SPREAD);
    const result = await history.listRuns({ cursor: 'not-a-cursor' });

    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') return;
    expect(result.code).toBe('InvalidCursor');
  });

  it('refuses a cursor issued for a different filter', async () => {
    const { history } = memoryStore(SPREAD);
    const first = await history.listRuns({ limit: 2 });
    if (first.outcome !== 'ok' || first.page.nextCursor === null) throw new Error('expected more');

    const result = await history.listRuns({
      limit: 2,
      filter: { workspaceId: 'ws-2' },
      cursor: first.page.nextCursor,
    });

    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') return;
    expect(result.code).toBe('IncompatibleCursor');
  });

  it('refuses a cursor issued for a different order', async () => {
    const { history } = memoryStore(SPREAD);
    const first = await history.listRuns({ limit: 2 });
    if (first.outcome !== 'ok' || first.page.nextCursor === null) throw new Error('expected more');

    const result = await history.listRuns({
      limit: 2,
      order: 'oldest',
      cursor: first.page.nextCursor,
    });

    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') return;
    expect(result.code).toBe('IncompatibleCursor');
  });

  it('accepts the same cursor with a different page size', async () => {
    // The page size does not change the sequence, only how much of it is read.
    const { history } = memoryStore(SPREAD);
    const first = await history.listRuns({ limit: 2 });
    if (first.outcome !== 'ok' || first.page.nextCursor === null) throw new Error('expected more');

    const result = await history.listRuns({ limit: 3, cursor: first.page.nextCursor });
    expect(result.outcome).toBe('ok');
  });

  it('never asks the store when a cursor is refused', async () => {
    const { history, calls } = memoryStore(SPREAD);
    await history.listRuns({ cursor: 'rubbish' });

    expect(calls.queryRuns).toBe(0);
  });
});

// ── By workflow ─────────────────────────────────────────────────────────────

describe('listByWorkflow', () => {
  it('lists only that workflow', async () => {
    const { history } = memoryStore(SPREAD);
    const result = await history.listByWorkflow('article.review');

    if (result.outcome !== 'ok') return;
    expect(result.page.items.map((view) => view.runId)).toEqual(['run-c']);
  });

  it('is the same query as a workflow filter', async () => {
    const { history } = memoryStore(SPREAD);
    const byName = await history.listByWorkflow('article.draft');
    const byFilter = await history.listRuns({ filter: { workflowId: 'article.draft' } });

    expect(byName).toEqual(byFilter);
  });

  it('honours the other filters alongside it', async () => {
    const { history } = memoryStore(SPREAD);
    const result = await history.listByWorkflow('article.draft', {
      filter: { statuses: ['failed'] },
    });

    if (result.outcome !== 'ok') return;
    expect(result.page.items.map((view) => view.runId)).toEqual(['run-b']);
  });

  it('refuses a query that names a different workflow', async () => {
    // Honouring either silently would answer a question nobody asked.
    const { history, calls } = memoryStore(SPREAD);
    const result = await history.listByWorkflow('article.draft', {
      filter: { workflowId: 'article.review' },
    });

    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') return;
    expect(result.code).toBe('InvalidFilter');
    expect(result.issues[0]?.code).toBe('CONTRADICTORY');
    expect(calls.queryRuns).toBe(0);
  });

  it('accepts a query that names the same workflow', async () => {
    const { history } = memoryStore(SPREAD);
    const result = await history.listByWorkflow('article.draft', {
      filter: { workflowId: 'article.draft' },
    });

    expect(result.outcome).toBe('ok');
  });
});

// ── Artifacts ───────────────────────────────────────────────────────────────

describe('listArtifacts', () => {
  const withArtifacts = (): ReturnType<typeof memoryStore> =>
    memoryStore(
      [run({ runId: 'run-a', minute: 1, artifactCount: 2 })],
      new Map([['run-a', [artifact('run-a', 1), artifact('run-a', 0)]]]),
    );

  it('returns them in step order, whatever the store returned', async () => {
    const { history } = withArtifacts();
    const result = await history.listArtifacts('run-a');

    expect(result.outcome).toBe('ok');
    if (result.outcome !== 'ok') return;
    expect(result.artifacts.map((view) => view.sequence)).toEqual([0, 1]);
    expect(result.artifacts.map((view) => view.stepId)).toEqual(['outline', 'draft']);
  });

  it('returns views, not records', async () => {
    const { history } = withArtifacts();
    const result = await history.listArtifacts('run-a');

    if (result.outcome !== 'ok') return;
    expect(Object.keys(result.artifacts[0] ?? {})).not.toContain('schemaVersion');
  });

  it('preserves usage, provider and prompt', async () => {
    const { history } = withArtifacts();
    const result = await history.listArtifacts('run-a');

    if (result.outcome !== 'ok') return;
    expect(result.artifacts[0]?.usage.totalTokens).toBe(30);
    expect(result.artifacts[0]?.providerId).toBe('openai');
    expect(result.artifacts[0]?.prompt.promptVersion).toBe('planning.outline@7');
  });

  it('adds the usage up', async () => {
    const { history } = withArtifacts();
    const result = await history.listArtifacts('run-a');

    if (result.outcome !== 'ok') return;
    expect(result.usage).toEqual({
      promptTokens: 20,
      completionTokens: 40,
      totalTokens: 60,
      artifacts: 2,
      tokensEstimated: false,
    });
  });

  it('reuses the repository contract', async () => {
    const { history, calls } = withArtifacts();
    await history.listArtifacts('run-a');

    expect(calls.loadRun).toBe(1);
    expect(calls.loadArtifacts).toBe(1);
    expect(calls.queryRuns).toBe(0);
  });

  it('refuses a run that is not there', async () => {
    const { history } = withArtifacts();
    const result = await history.listArtifacts('run-nothing');

    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') return;
    expect(result.code).toBe('UnknownRun');
  });

  it('refuses when fewer come back than the run recorded', async () => {
    const { history } = memoryStore([run({ runId: 'run-a', minute: 1, artifactCount: 2 })]);
    const result = await history.listArtifacts('run-a');

    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') return;
    expect(result.code).toBe('CorruptRecord');
    expect(result.issues[0]?.code).toBe('COUNT_MISMATCH');
  });

  it('refuses one filed under another run', async () => {
    const { history } = memoryStore(
      [run({ runId: 'run-a', minute: 1, artifactCount: 1 })],
      new Map([['run-a', [artifact('run-b', 0)]]]),
    );
    const result = await history.listArtifacts('run-a');

    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') return;
    expect(result.code).toBe('CorruptRecord');
    expect(result.issues.map((issue) => issue.code)).toContain('WRONG_RUN');
  });

  it('is empty, and fine, for a run that produced nothing', async () => {
    const { history } = memoryStore([run({ runId: 'run-a', minute: 1, artifactCount: 0 })]);
    const result = await history.listArtifacts('run-a');

    expect(result.outcome).toBe('ok');
    if (result.outcome !== 'ok') return;
    expect(result.artifacts).toEqual([]);
    expect(result.usage.artifacts).toBe(0);
  });
});

// ── It reads, and only reads ────────────────────────────────────────────────

describe('history writes nothing', () => {
  it('never saves and never updates a status', async () => {
    const store = memoryStore(
      [run({ runId: 'run-a', minute: 1, artifactCount: 1 })],
      new Map([['run-a', [artifact('run-a', 0)]]]),
    );

    await store.history.getRunById('run-a');
    await store.history.listRuns();
    await store.history.listArtifacts('run-a');
    await store.history.listByWorkflow('article.draft');

    expect(store.calls.saveRun).toBe(0);
    expect(store.calls.updateStatus).toBe(0);
  });
});

describe('the refusal taxonomy', () => {
  it('reuses S4.4 codes rather than restating them', () => {
    for (const code of ['UnknownRun', 'IncompatibleSchema', 'CorruptRecord']) {
      expect(RUN_HISTORY_CODES).toContain(code);
    }
  });

  it('adds only what history itself can refuse', () => {
    expect([...RUN_HISTORY_CODES]).toEqual([
      'UnknownRun',
      'IncompatibleSchema',
      'CorruptRecord',
      'InvalidFilter',
      'InvalidCursor',
      'IncompatibleCursor',
    ]);
  });

  it('recognises its own members and nothing else', () => {
    expect(isRunHistoryCode('InvalidCursor')).toBe(true);
    expect(isRunHistoryCode('invalidCursor')).toBe(false);
    expect(isRunHistoryCode('Exploded')).toBe(false);
  });
});
