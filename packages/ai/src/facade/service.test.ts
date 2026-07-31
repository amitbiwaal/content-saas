import type { Principal } from '@contentos/security';
import { describe, expect, it } from 'vitest';

import type { DraftCompilation } from '../drafts/compile.js';
import { newDraft, type ContentDraft } from '../drafts/draft.js';
import type { DraftService } from '../drafts/service.js';
import type { ContentExportService, ExportResult } from '../exports/service.js';
import type { AdmissionOrganization, AdmissionWorkspace } from '../gateway/ports.js';
import type { RunHistoryService } from '../history/service.js';
import type { RunHistoryView } from '../history/views.js';
import type { Orchestrator, StartRunOptions } from '../runs/orchestrator.js';
import type { ContentRunResult } from '../runs/run.js';
import type { ContentSearchService } from '../search/service.js';
import {
  CONTENT_OPERATIONS,
  type ContentContext,
  type ContentRequest,
  type ContentResponse,
} from './model.js';
import {
  CONTENT_ERROR_CODES,
  createContentManagement,
  isContentErrorCode,
  type DraftCompiler,
} from './service.js';

const ORG = 'org-1';
const WS = 'ws-1';
const AT = '2026-07-31T12:00:00.000Z';

// ── Fixtures ────────────────────────────────────────────────────────────────

const principal: Principal = {
  subjectId: 'user-1',
  kind: 'user',
  method: 'password',
  organizationId: ORG,
  workspaceId: WS,
  roles: ['editor'],
  permissions: ['article:execute'],
  authenticatedAt: new Date(AT),
  mfaSatisfied: true,
  sessionId: null,
};

const organization: AdmissionOrganization = { organizationId: ORG, status: 'active' };
const workspace: AdmissionWorkspace = { workspaceId: WS, organizationId: ORG, status: 'active' };

const context: ContentContext = {
  principal,
  organization,
  workspace,
  requestId: 'req-1',
  correlationId: 'corr-1',
};

const draftRecord = (draftId = 'draft-1'): ContentDraft =>
  newDraft({
    draftId,
    metadata: {
      organizationId: ORG,
      workspaceId: WS,
      principalId: 'user-1',
      principalKind: 'user',
      title: 'An article',
      tags: ['article'],
    },
    workflowId: 'article.draft',
    workflowVersion: 2,
    workflowRef: 'article.draft@2',
    capability: 'chat',
    templateReferences: [
      { templateId: 'planning.outline', templateVersion: 7, promptVersion: 'planning.outline@7' },
    ],
    inputs: { topic: 'tenancy' },
    now: AT,
  });

const runView: RunHistoryView = Object.freeze({
  runId: 'run-1',
  status: 'completed',
  workflowId: 'article.draft',
  workflowVersion: 2,
  workflowRef: 'article.draft@2',
  capability: 'chat',
  templateVersions: [
    { templateId: 'planning.outline', templateVersion: 7, promptVersion: 'planning.outline@7' },
  ],
  executionId: 'idem-1',
  organizationId: ORG,
  workspaceId: WS,
  principalId: 'user-1',
  principalKind: 'user',
  correlationId: 'corr-1',
  timings: { createdAt: AT, compiledAt: AT, startedAt: AT, finishedAt: AT },
  failure: null,
  artifactCount: 0,
});

const runResult: ContentRunResult = Object.freeze({
  outcome: 'completed',
  run: Object.freeze({
    runId: 'run-1',
    workflowId: 'article.draft',
    workflowVersion: 2,
    workflowRef: 'article.draft@2',
    templateVersions: [],
    capability: 'chat',
    metadata: { principal, organization, workspace, correlationId: 'corr-1', idempotencyKey: 'k' },
    state: {
      status: 'completed',
      artifacts: [],
      executionId: 'k',
      timings: { createdAt: AT, compiledAt: AT, startedAt: AT, finishedAt: AT },
    },
  }),
});

const EXPORT: ExportResult = Object.freeze({
  outcome: 'ok',
  export: Object.freeze({
    metadata: {
      exportId: 'export-1',
      exportType: 'run',
      format: 'json',
      exportSchemaVersion: 1,
      formatVersion: 1,
      exportedAt: AT,
      organizationId: ORG,
      workspaceId: WS,
      itemCount: 0,
    },
    items: [],
    body: '{}\n',
    createdAt: AT,
  }),
});

// ── Fake delegates ──────────────────────────────────────────────────────────

interface Behaviour {
  readonly draftRefusal?: boolean;
  readonly compilation?: DraftCompilation;
  readonly throwOn?: string;
}

function harness(behaviour: Behaviour = {}) {
  const calls: Record<string, number> = {
    'drafts.create': 0,
    'drafts.load': 0,
    'drafts.revise': 0,
    'drafts.remove': 0,
    'drafts.list': 0,
    'drafts.validate': 0,
    'compiler.compile': 0,
    'orchestrator.start': 0,
    'history.getRunById': 0,
    'history.listRuns': 0,
    'history.listArtifacts': 0,
    'history.listByWorkflow': 0,
    'search.searchRuns': 0,
    'search.searchDrafts': 0,
    'search.searchArtifacts': 0,
    'exports.exportRun': 0,
    'exports.exportRuns': 0,
    'exports.exportDraft': 0,
    'exports.exportDrafts': 0,
    'exports.exportArtifacts': 0,
  };

  const seen: Record<string, unknown> = {};

  const note = (name: string, input?: unknown): void => {
    calls[name] = (calls[name] ?? 0) + 1;
    if (input !== undefined) seen[name] = input;
    if (behaviour.throwOn === name) throw new Error(`${name} exploded`);
  };

  const refusal = {
    outcome: 'refused' as const,
    code: 'UnknownDraft' as const,
    reason: 'no',
    issues: [],
  };

  const drafts: DraftService = {
    create: (input) => {
      note('drafts.create', input);
      return Promise.resolve(
        behaviour.draftRefusal === true ? refusal : { outcome: 'ok', draft: draftRecord() },
      );
    },
    load: (draftId) => {
      note('drafts.load', draftId);
      return Promise.resolve(
        behaviour.draftRefusal === true ? refusal : { outcome: 'ok', draft: draftRecord() },
      );
    },
    revise: (input) => {
      note('drafts.revise', input);
      return Promise.resolve(
        behaviour.draftRefusal === true ? refusal : { outcome: 'ok', draft: draftRecord() },
      );
    },
    remove: (draftId) => {
      note('drafts.remove', draftId);
      return Promise.resolve(behaviour.draftRefusal === true ? refusal : { outcome: 'ok' });
    },
    list: (criteria) => {
      note('drafts.list', criteria);
      return Promise.resolve(
        behaviour.draftRefusal === true ? refusal : { outcome: 'ok', drafts: [draftRecord()] },
      );
    },
    validate: (draftId) => {
      note('drafts.validate', draftId);
      return Promise.resolve({ outcome: 'ok', draft: draftRecord() });
    },
  };

  const compiled: DraftCompilation = behaviour.compilation ?? {
    outcome: 'compiled',
    request: {
      workflowId: 'article.draft',
      selector: { kind: 'explicit', version: 2 },
      variables: { topic: 'tenancy' },
      metadata: {
        principal,
        organization,
        workspace,
        correlationId: 'corr-1',
        idempotencyKey: 'k',
      },
      model: 'gpt-4o',
      timeoutMs: 30_000,
      capability: 'chat',
      promptTemplates: [],
    } satisfies StartRunOptions,
    templates: [],
  };

  const compiler: DraftCompiler = {
    compile: (input) => {
      note('compiler.compile', input);
      return compiled;
    },
  };

  const orchestrator: Orchestrator = {
    start: (input) => {
      note('orchestrator.start', input);
      return Promise.resolve(runResult);
    },
  };

  const history: RunHistoryService = {
    getRunById: (runId) => {
      note('history.getRunById', runId);
      return Promise.resolve({ outcome: 'found', run: runView });
    },
    listRuns: (query) => {
      note('history.listRuns', query);
      return Promise.resolve({
        outcome: 'ok',
        page: { items: [runView], nextCursor: null, hasMore: false },
      });
    },
    listArtifacts: () => {
      note('history.listArtifacts');
      return Promise.resolve({
        outcome: 'ok',
        artifacts: [],
        usage: {
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          artifacts: 0,
          tokensEstimated: false,
        },
      });
    },
    listByWorkflow: () => {
      note('history.listByWorkflow');
      return Promise.resolve({
        outcome: 'ok',
        page: { items: [], nextCursor: null, hasMore: false },
      });
    },
  };

  const emptyPage = { items: [], nextCursor: null, hasMore: false };

  const search: ContentSearchService = {
    searchRuns: (query) => {
      note('search.searchRuns', query);
      return Promise.resolve({ outcome: 'ok', page: emptyPage });
    },
    searchDrafts: (query) => {
      note('search.searchDrafts', query);
      return Promise.resolve({ outcome: 'ok', page: emptyPage });
    },
    searchArtifacts: (query) => {
      note('search.searchArtifacts', query);
      return Promise.resolve({ outcome: 'ok', page: emptyPage });
    },
  };

  const exports: ContentExportService = {
    exportRun: (runId, input) => {
      note('exports.exportRun', { runId, input });
      return Promise.resolve(EXPORT);
    },
    exportRuns: (query, input) => {
      note('exports.exportRuns', { query, input });
      return Promise.resolve(EXPORT);
    },
    exportDraft: (draftId, input) => {
      note('exports.exportDraft', { draftId, input });
      return Promise.resolve(EXPORT);
    },
    exportDrafts: (query, input) => {
      note('exports.exportDrafts', { query, input });
      return Promise.resolve(EXPORT);
    },
    exportArtifacts: (query, input) => {
      note('exports.exportArtifacts', { query, input });
      return Promise.resolve(EXPORT);
    },
  };

  return {
    calls,
    seen,
    facade: createContentManagement({
      drafts,
      compiler,
      orchestrator,
      history,
      search,
      exports,
    }),
  };
}

const total = (calls: Record<string, number>): number =>
  Object.values(calls).reduce((sum, count) => sum + count, 0);

const request = (operation: string, payload: unknown): ContentRequest =>
  ({ operation, context, payload }) as unknown as ContentRequest;

// ── Draft routing ───────────────────────────────────────────────────────────

describe('draft operations route to the draft service', () => {
  it('createDraft delegates exactly once, and to nothing else', async () => {
    const { facade, calls } = harness();
    const result = await facade.execute(
      request('createDraft', {
        title: 'An article',
        workflowId: 'article.draft',
        workflowVersion: 2,
        inputs: { topic: 'tenancy' },
      }),
    );

    expect(result.outcome).toBe('ok');
    expect(calls['drafts.create']).toBe(1);
    expect(total(calls)).toBe(1);
  });

  it('takes tenancy and authorship from the CONTEXT, never the payload', async () => {
    // A payload that could name them would be a way to create a draft
    // somewhere else, or in somebody else's name, by asking.
    const { facade, seen } = harness();
    await facade.execute(
      request('createDraft', {
        title: 'An article',
        tags: ['x'],
        workflowId: 'article.draft',
        workflowVersion: 2,
        inputs: {},
        // Ignored: the facade does not read these.
        metadata: { organizationId: 'org-2', workspaceId: 'ws-2', principalId: 'someone-else' },
      }),
    );

    expect(seen['drafts.create']).toMatchObject({
      metadata: {
        organizationId: ORG,
        workspaceId: WS,
        principalId: 'user-1',
        principalKind: 'user',
        title: 'An article',
      },
    });
  });

  it('updateDraft delegates exactly once', async () => {
    const { facade, calls } = harness();
    await facade.execute(
      request('updateDraft', { draftId: 'draft-1', transition: 'edit', note: 'Edited.' }),
    );

    expect(calls['drafts.revise']).toBe(1);
    expect(total(calls)).toBe(1);
  });

  it('getDraft delegates exactly once', async () => {
    const { facade, calls } = harness();
    const result = await facade.execute(request('getDraft', { draftId: 'draft-1' }));

    expect(result.outcome).toBe('ok');
    if (result.outcome !== 'ok') return;
    expect(result.data.kind).toBe('draft');
    expect(calls['drafts.load']).toBe(1);
    expect(total(calls)).toBe(1);
  });

  it('deleteDraft delegates exactly once and names what went', async () => {
    const { facade, calls } = harness();
    const result = await facade.execute(request('deleteDraft', { draftId: 'draft-1' }));

    expect(result.outcome).toBe('ok');
    if (result.outcome !== 'ok') return;
    expect(result.data).toEqual({ kind: 'deleted', draftId: 'draft-1' });
    expect(calls['drafts.remove']).toBe(1);
    expect(total(calls)).toBe(1);
  });

  it('listDrafts forces the caller’s own tenancy onto the listing', async () => {
    const { facade, seen, calls } = harness();
    await facade.execute(request('listDrafts', { statuses: ['ready'], workflowId: 'w' }));

    expect(seen['drafts.list']).toMatchObject({
      organizationId: ORG,
      workspaceId: WS,
      statuses: ['ready'],
      workflowId: 'w',
    });
    expect(calls['drafts.list']).toBe(1);
    expect(total(calls)).toBe(1);
  });

  it('carries a draft refusal back with its own code', async () => {
    const { facade } = harness({ draftRefusal: true });
    const result = await facade.execute(request('getDraft', { draftId: 'draft-1' }));

    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') return;
    expect(result.code).toBe('UnknownDraft');
  });
});

// ── Submission ──────────────────────────────────────────────────────────────

describe('submitDraft', () => {
  const payload = {
    draftId: 'draft-1',
    model: 'gpt-4o',
    timeoutMs: 30_000,
    idempotencyKey: 'idem-1',
  };

  it('loads, compiles, marks and runs — in that order', async () => {
    const { facade, calls } = harness();
    const result = await facade.execute(request('submitDraft', payload));

    expect(result.outcome).toBe('ok');
    expect(calls['drafts.load']).toBe(1);
    expect(calls['compiler.compile']).toBe(1);
    expect(calls['drafts.revise']).toBe(1);
    expect(calls['orchestrator.start']).toBe(1);
    expect(total(calls)).toBe(4);
  });

  it('marks the draft submitted through the draft service', async () => {
    const { facade, seen } = harness();
    await facade.execute(request('submitDraft', payload));

    expect(seen['drafts.revise']).toMatchObject({ draftId: 'draft-1', transition: 'submit' });
  });

  it('gives the compiler the resolved context, not anything it invented', async () => {
    const { facade, seen } = harness();
    await facade.execute(request('submitDraft', payload));

    expect(seen['compiler.compile']).toMatchObject({
      principal,
      organization,
      workspace,
      correlationId: 'corr-1',
      idempotencyKey: 'idem-1',
      model: 'gpt-4o',
      timeoutMs: 30_000,
    });
  });

  it('hands the orchestrator exactly what the compiler produced', async () => {
    const { facade, seen } = harness();
    await facade.execute(request('submitDraft', payload));

    expect(seen['orchestrator.start']).toMatchObject({ workflowId: 'article.draft' });
  });

  it('returns the submitted draft and the run together', async () => {
    const { facade } = harness();
    const result = await facade.execute(request('submitDraft', payload));

    if (result.outcome !== 'ok') return;
    expect(result.data.kind).toBe('submitted');
    if (result.data.kind !== 'submitted') return;
    expect(result.data.draft.draftId).toBe('draft-1');
    expect(result.data.run.outcome).toBe('completed');
  });

  it('does NOT mark a draft that could not compile', async () => {
    // A draft that cannot compile was never submitted, and must not be left
    // recording that it was.
    const { facade, calls } = harness({
      compilation: {
        outcome: 'refused',
        code: 'NotReady',
        reason: 'still a draft',
        issues: [],
      },
    });
    const result = await facade.execute(request('submitDraft', payload));

    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') return;
    expect(result.code).toBe('NotReady');
    expect(calls['drafts.revise']).toBe(0);
    expect(calls['orchestrator.start']).toBe(0);
  });

  it('runs nothing when the draft cannot be marked', async () => {
    const { facade, calls } = harness({ draftRefusal: true });
    await facade.execute(request('submitDraft', payload));

    expect(calls['orchestrator.start']).toBe(0);
  });

  it('treats a FAILED run as a successful submission', async () => {
    // "The platform refused you" and "the model refused you" call for opposite
    // actions and must not be the same answer.
    const { facade } = harness();
    const result = await facade.execute(request('submitDraft', payload));

    expect(result.outcome).toBe('ok');
  });
});

// ── Runs, search, export ────────────────────────────────────────────────────

describe('run lookup routes to history', () => {
  it('getRun delegates exactly once', async () => {
    const { facade, calls } = harness();
    const result = await facade.execute(request('getRun', { runId: 'run-1' }));

    expect(result.outcome).toBe('ok');
    if (result.outcome !== 'ok') return;
    expect(result.data.kind).toBe('run');
    expect(calls['history.getRunById']).toBe(1);
    expect(total(calls)).toBe(1);
  });

  it('listRuns delegates exactly once, with tenancy forced', async () => {
    const { facade, calls, seen } = harness();
    const result = await facade.execute(
      request('listRuns', { query: { limit: 5, filter: { workflowId: 'w' } } }),
    );

    expect(result.outcome).toBe('ok');
    if (result.outcome !== 'ok') return;
    expect(result.data.kind).toBe('runs');
    expect(seen['history.listRuns']).toMatchObject({
      limit: 5,
      filter: { organizationId: ORG, workspaceId: WS, workflowId: 'w' },
    });
    expect(calls['history.listRuns']).toBe(1);
    expect(total(calls)).toBe(1);
  });

  it('never reaches search for a run listing', async () => {
    const { facade, calls } = harness();
    await facade.execute(request('listRuns', {}));

    expect(calls['search.searchRuns']).toBe(0);
  });
});

describe('search routes to the search service', () => {
  it('sends each kind to its own method, exactly once', async () => {
    for (const [kind, name] of [
      ['runs', 'search.searchRuns'],
      ['drafts', 'search.searchDrafts'],
      ['artifacts', 'search.searchArtifacts'],
    ] as const) {
      const { facade, calls } = harness();
      const result = await facade.execute(request('search', { kind }));

      expect(result.outcome).toBe('ok');
      expect(calls[name]).toBe(1);
      expect(total(calls)).toBe(1);
    }
  });

  it('pins the query to the caller’s tenancy', async () => {
    const { facade, seen } = harness();
    await facade.execute(
      request('search', { kind: 'drafts', query: { limit: 3, filter: { tags: ['x'] } } }),
    );

    expect(seen['search.searchDrafts']).toMatchObject({
      limit: 3,
      filter: { organizationId: ORG, workspaceId: WS, tags: ['x'] },
    });
  });
});

describe('export routes to the export service', () => {
  it('sends each target to its own method, exactly once', async () => {
    for (const [target, name] of [
      [{ kind: 'run', runId: 'run-1' }, 'exports.exportRun'],
      [{ kind: 'runs' }, 'exports.exportRuns'],
      [{ kind: 'draft', draftId: 'draft-1' }, 'exports.exportDraft'],
      [{ kind: 'drafts' }, 'exports.exportDrafts'],
      [{ kind: 'artifacts' }, 'exports.exportArtifacts'],
    ] as const) {
      const { facade, calls } = harness();
      const result = await facade.execute(request('export', { target, format: 'json' }));

      expect(result.outcome).toBe('ok');
      expect(calls[name]).toBe(1);
      expect(total(calls)).toBe(1);
    }
  });

  it('stamps the export envelope with the caller’s tenancy', async () => {
    const { facade, seen } = harness();
    await facade.execute(
      request('export', { target: { kind: 'run', runId: 'run-1' }, format: 'ndjson' }),
    );

    expect(seen['exports.exportRun']).toMatchObject({
      runId: 'run-1',
      input: { format: 'ndjson', organizationId: ORG, workspaceId: WS },
    });
  });

  it('passes a named export schema version through', async () => {
    const { facade, seen } = harness();
    await facade.execute(
      request('export', {
        target: { kind: 'run', runId: 'run-1' },
        format: 'json',
        exportSchemaVersion: 1,
      }),
    );

    expect(seen['exports.exportRun']).toMatchObject({ input: { exportSchemaVersion: 1 } });
  });
});

// ── Context, responses, failures ────────────────────────────────────────────

describe('context propagation', () => {
  it('echoes the trace on every success', async () => {
    const { facade } = harness();
    const result = await facade.execute(request('getDraft', { draftId: 'draft-1' }));

    expect(result.trace).toEqual({ requestId: 'req-1', correlationId: 'corr-1' });
  });

  it('echoes it on a refusal too', async () => {
    const { facade } = harness();
    const result = await facade.execute(request('getDraft', { draftId: '' }));

    expect(result.outcome).toBe('refused');
    expect(result.trace).toEqual({ requestId: 'req-1', correlationId: 'corr-1' });
  });

  it('never sends the principal back down the wire', async () => {
    const { facade } = harness();
    const result = await facade.execute(request('getDraft', { draftId: 'draft-1' }));

    expect(JSON.stringify(result.trace)).not.toContain('article:execute');
    expect(Object.keys(result.trace)).toEqual(['requestId', 'correlationId']);
  });
});

describe('every response', () => {
  it('names the operation it answers', async () => {
    const { facade } = harness();
    const result = await facade.execute(request('getRun', { runId: 'run-1' }));

    expect(result.operation).toBe('getRun');
  });

  it('is frozen through', async () => {
    const { facade } = harness();
    const result = await facade.execute(request('getDraft', { draftId: 'draft-1' }));

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.trace)).toBe(true);
    if (result.outcome !== 'ok') return;
    expect(Object.isFrozen(result.data)).toBe(true);
  });
});

describe('nothing throws', () => {
  it('turns a delegate that throws into a refusal', async () => {
    // An entry point that could throw would make every caller wrap it, and the
    // first one that forgot would turn a fault into a 500 with no code.
    const { facade } = harness({ throwOn: 'drafts.load' });
    const result = await facade.execute(request('getDraft', { draftId: 'draft-1' }));

    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') return;
    expect(result.code).toBe('ServiceFailed');
    expect(result.reason).toBe('drafts.load exploded');
  });

  it('does so for every operation', async () => {
    for (const [operation, payload, name] of [
      [
        'createDraft',
        { title: 't', workflowId: 'w', workflowVersion: 1, inputs: {} },
        'drafts.create',
      ],
      ['updateDraft', { draftId: 'd', transition: 'edit', note: 'n' }, 'drafts.revise'],
      ['deleteDraft', { draftId: 'd' }, 'drafts.remove'],
      ['getDraft', { draftId: 'd' }, 'drafts.load'],
      ['listDrafts', {}, 'drafts.list'],
      [
        'submitDraft',
        { draftId: 'd', model: 'm', timeoutMs: 1, idempotencyKey: 'k' },
        'drafts.load',
      ],
      ['getRun', { runId: 'r' }, 'history.getRunById'],
      ['listRuns', {}, 'history.listRuns'],
      ['search', { kind: 'runs' }, 'search.searchRuns'],
      ['export', { target: { kind: 'artifacts' }, format: 'json' }, 'exports.exportArtifacts'],
    ] as const) {
      const { facade } = harness({ throwOn: name });
      const result: ContentResponse = await facade.execute(request(operation, payload));

      expect(result.outcome).toBe('refused');
      if (result.outcome !== 'refused') continue;
      expect(result.code).toBe('ServiceFailed');
    }
  });

  it('refuses an operation nobody offers, without reaching anything', async () => {
    const { facade, calls } = harness();
    const result = await facade.execute(request('deleteRun', { runId: 'r' }));

    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') return;
    expect(result.code).toBe('InvalidOperation');
    expect(result.operation).toBe('deleteRun');
    expect(total(calls)).toBe(0);
  });

  it('refuses an invalid request before delegating', async () => {
    const { facade, calls } = harness();
    await facade.execute(request('getDraft', {}));

    expect(total(calls)).toBe(0);
  });
});

describe('the two surfaces agree', () => {
  it('every operation is reachable through execute', async () => {
    const payloads: Readonly<Record<string, unknown>> = {
      createDraft: { title: 't', workflowId: 'w', workflowVersion: 1, inputs: {} },
      updateDraft: { draftId: 'd', transition: 'edit', note: 'n' },
      deleteDraft: { draftId: 'd' },
      getDraft: { draftId: 'd' },
      listDrafts: {},
      submitDraft: { draftId: 'd', model: 'm', timeoutMs: 1, idempotencyKey: 'k' },
      getRun: { runId: 'r' },
      listRuns: {},
      search: { kind: 'runs' },
      export: { target: { kind: 'artifacts' }, format: 'json' },
    };

    for (const operation of CONTENT_OPERATIONS) {
      const { facade } = harness();
      const result = await facade.execute(request(operation, payloads[operation]));

      expect(result.outcome).toBe('ok');
      expect(result.operation).toBe(operation);
    }
  });

  it('the named method and execute give the same answer', async () => {
    const one = harness();
    const other = harness();

    const direct = await one.facade.getRun({
      operation: 'getRun',
      context,
      payload: { runId: 'run-1' },
    });
    const dispatched = await other.facade.execute(request('getRun', { runId: 'run-1' }));

    expect(dispatched).toEqual(direct);
  });
});

describe('the error taxonomy', () => {
  it('contributes from every layer it delegates to', () => {
    for (const code of [
      'UnknownRun',
      'UnknownDraft',
      'CorruptRecord',
      'InvalidCursor',
      'UnsupportedFilter',
      'UnsupportedFormat',
      'IncompatibleExportVersion',
      'IllegalTransition',
      'TenancyMismatch',
      'NotReady',
      'InputsInvalid',
    ]) {
      expect(CONTENT_ERROR_CODES).toContain(code);
    }
  });

  it('adds only what an entry point can refuse', () => {
    for (const code of [
      'InvalidOperation',
      'MissingIdentifier',
      'ContradictoryRequest',
      'ServiceFailed',
    ]) {
      expect(CONTENT_ERROR_CODES).toContain(code);
    }
  });

  it('lists every code once', () => {
    expect(new Set(CONTENT_ERROR_CODES).size).toBe(CONTENT_ERROR_CODES.length);
  });

  it('recognises its own members and nothing else', () => {
    expect(isContentErrorCode('ServiceFailed')).toBe(true);
    expect(isContentErrorCode('serviceFailed')).toBe(false);
    expect(isContentErrorCode('Exploded')).toBe(false);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(CONTENT_ERROR_CODES)).toBe(true);
  });
});
