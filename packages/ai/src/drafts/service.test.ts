import { describe, expect, it } from 'vitest';

import { createWorkflowRegistry, type ContentWorkflowDefinition } from '../blueprints/registry.js';
import type { WorkflowStepDefinition } from '../blueprints/steps.js';
import type { PromptTemplate } from '../prompts/template.js';
import { createTemplateLibrary, type TemplateLibrary } from '../templates/library.js';
import { latestRevision, type ContentDraft, type DraftMetadata } from './draft.js';
import type { DraftListCriteria, DraftRepository, UpdateDraftInput } from './repository.js';
import {
  createDraftService,
  DRAFT_SERVICE_CODES,
  isDraftServiceCode,
  MAX_DRAFT_LIST_LIMIT,
} from './service.js';

const AT = new Date('2026-07-31T12:00:00.000Z');

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

const template = (id: string, version: number): PromptTemplate => ({
  id,
  version,
  taskType: id,
  status: 'active',
  parts: { system: 'You write.', user: BODY[id] as string },
  variables: VARIABLES[id] as PromptTemplate['variables'],
  modelHints: { maxOutputTokens: 512, temperature: 0.2, determinismRequired: false },
  evalSetRef: `evals/${id}`,
  owner: 'content-platform',
  changelog: 'Initial.',
});

const LIBRARY: TemplateLibrary = createTemplateLibrary(
  [
    { id: 'planning.outline', version: 7 },
    { id: 'writing.draft', version: 3 },
  ].map((entry) => ({
    id: entry.id,
    metadata: {
      title: entry.id,
      description: `The ${entry.id} prompt.`,
      owner: 'content-platform',
      visibility: 'public' as const,
      tags: [],
    },
    versions: [
      {
        prompt: template(entry.id, entry.version),
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

const metadata: DraftMetadata = {
  organizationId: 'org-1',
  workspaceId: 'ws-1',
  principalId: 'user-1',
  principalKind: 'user',
  title: 'An article',
  tags: [],
};

/** An in-memory repository. The only implementation, and it lives in a test. */
function memoryRepository() {
  const drafts = new Map<string, ContentDraft>();
  const calls = { saveDraft: 0, loadDraft: 0, updateDraft: 0, deleteDraft: 0, listDrafts: 0 };
  const updates: UpdateDraftInput[] = [];
  const criteria: DraftListCriteria[] = [];

  const repository: DraftRepository = {
    saveDraft: (draft) => {
      calls.saveDraft += 1;
      if (drafts.has(draft.draftId)) {
        return Promise.reject(new Error(`draft '${draft.draftId}' already exists`));
      }
      drafts.set(draft.draftId, draft);
      return Promise.resolve();
    },
    loadDraft: (draftId) => {
      calls.loadDraft += 1;
      return Promise.resolve(drafts.get(draftId) ?? null);
    },
    updateDraft: (input) => {
      calls.updateDraft += 1;
      updates.push(input);
      drafts.set(input.draft.draftId, input.draft);
      return Promise.resolve();
    },
    deleteDraft: (draftId) => {
      calls.deleteDraft += 1;
      drafts.delete(draftId);
      return Promise.resolve();
    },
    listDrafts: (input) => {
      calls.listDrafts += 1;
      criteria.push(input);
      const matched = [...drafts.values()].filter((draft) => {
        if (input.workspaceId !== null && draft.metadata.workspaceId !== input.workspaceId)
          return false;
        if (input.principalId !== null && draft.metadata.principalId !== input.principalId)
          return false;
        if (input.workflowId !== null && draft.workflowId !== input.workflowId) return false;
        if (input.statuses !== null && !input.statuses.includes(latestRevision(draft).status))
          return false;
        return true;
      });
      return Promise.resolve({ drafts: matched.slice(0, input.limit) });
    },
  };

  return { repository, calls, updates, criteria, drafts };
}

function harness(ids: readonly string[] = ['draft-1'], clock: () => Date = () => AT) {
  const store = memoryRepository();
  let issued = 0;

  const service = createDraftService({
    repository: store.repository,
    workflows: REGISTRY,
    templates: LIBRARY,
    now: clock,
    newDraftId: () => ids[Math.min(issued++, ids.length - 1)] as string,
  });

  return { ...store, service };
}

const created = async (inputs: Readonly<Record<string, unknown>> = { topic: 'tenancy' }) => {
  const bench = harness();
  const result = await bench.service.create({
    metadata,
    workflowId: 'article.draft',
    workflowVersion: 2,
    inputs,
  });
  if (result.outcome !== 'ok') throw new Error(`expected a draft: ${result.reason}`);
  return { ...bench, draft: result.draft };
};

// ── Creating ────────────────────────────────────────────────────────────────

describe('creating a draft', () => {
  it('stores it, once', async () => {
    const { calls } = await created();
    expect(calls.saveDraft).toBe(1);
  });

  it('pins the workflow at the version it was created against', async () => {
    const { draft } = await created();

    expect(draft.workflowId).toBe('article.draft');
    expect(draft.workflowVersion).toBe(2);
    expect(draft.workflowRef).toBe('article.draft@2');
    expect(draft.capability).toBe('chat');
  });

  it('resolves and records every template reference', async () => {
    const { draft } = await created();

    expect(draft.templateReferences).toEqual([
      { templateId: 'planning.outline', templateVersion: 7, promptVersion: 'planning.outline@7' },
      { templateId: 'writing.draft', templateVersion: 3, promptVersion: 'writing.draft@3' },
    ]);
  });

  it('uses the injected clock and id generator', async () => {
    const { draft } = await created();

    expect(draft.draftId).toBe('draft-1');
    expect(draft.createdAt).toBe(AT.toISOString());
  });

  it('does not require the inputs to be complete yet', async () => {
    // A draft is work in progress; refusing an empty one would make it
    // impossible to start.
    const { draft } = await created({});
    expect(latestRevision(draft).inputs).toEqual({});
    expect(latestRevision(draft).status).toBe('draft');
  });

  it('refuses a workflow that does not exist', async () => {
    const { service } = harness();
    const result = await service.create({
      metadata,
      workflowId: 'article.nothing',
      workflowVersion: 1,
      inputs: {},
    });

    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') return;
    expect(result.code).toBe('WorkflowUnresolved');
  });

  it('refuses a version the registry does not have', async () => {
    const { service, calls } = harness();
    const result = await service.create({
      metadata,
      workflowId: 'article.draft',
      workflowVersion: 99,
      inputs: {},
    });

    expect(result.outcome).toBe('refused');
    expect(calls.saveDraft).toBe(0);
  });
});

// ── Loading ─────────────────────────────────────────────────────────────────

describe('loading a draft', () => {
  it('returns what was stored', async () => {
    const { service } = await created();
    const result = await service.load('draft-1');

    expect(result.outcome).toBe('ok');
    if (result.outcome !== 'ok') return;
    expect(result.draft.draftId).toBe('draft-1');
  });

  it('refuses one that is not there', async () => {
    const { service } = await created();
    const result = await service.load('draft-nothing');

    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') return;
    expect(result.code).toBe('UnknownDraft');
  });

  it('refuses a blank id without asking the store', async () => {
    const { service, calls } = harness();
    const before = calls.loadDraft;
    const result = await service.load('   ');

    expect(result.outcome).toBe('refused');
    expect(calls.loadDraft).toBe(before);
  });
});

// ── Revising ────────────────────────────────────────────────────────────────

describe('revising a draft', () => {
  it('appends a revision rather than replacing one', async () => {
    const { service } = await created();
    const result = await service.revise({
      draftId: 'draft-1',
      transition: 'edit',
      changes: { inputs: { topic: 'something else' } },
      note: 'Changed the topic.',
    });

    expect(result.outcome).toBe('ok');
    if (result.outcome !== 'ok') return;
    expect(result.draft.revisions).toHaveLength(2);
    expect(result.draft.revisions[0]?.inputs).toEqual({ topic: 'tenancy' });
  });

  it('goes through updateDraft, carrying the revision it was built on', async () => {
    const { service, updates } = await created();
    await service.revise({ draftId: 'draft-1', transition: 'edit', note: 'Edited.' });

    expect(updates).toHaveLength(1);
    expect(updates[0]?.expectedRevision).toBe(1);
  });

  it('refuses an edit built on a stale revision', async () => {
    // Somebody else revised it in between; writing over them would lose an edit.
    const { service } = await created();
    await service.revise({ draftId: 'draft-1', transition: 'edit', note: 'First.' });

    const result = await service.revise({
      draftId: 'draft-1',
      transition: 'edit',
      note: 'Second.',
      expectedRevision: 1,
    });

    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') return;
    expect(result.code).toBe('ImmutableDraft');
  });

  it('refuses a transition the lifecycle does not allow', async () => {
    const { service } = await created();
    const result = await service.revise({
      draftId: 'draft-1',
      transition: 'submit',
      note: 'Too early.',
    });

    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') return;
    expect(result.code).toBe('IllegalTransition');
  });

  it('refuses a revision that does not say why it exists', async () => {
    const { service } = await created();
    const result = await service.revise({ draftId: 'draft-1', transition: 'edit', note: '   ' });

    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') return;
    expect(result.code).toBe('DraftInvalid');
  });

  it('refuses a draft that is not there', async () => {
    const { service } = await created();
    const result = await service.revise({
      draftId: 'draft-nothing',
      transition: 'edit',
      note: 'Edited.',
    });

    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') return;
    expect(result.code).toBe('UnknownDraft');
  });
});

describe('becoming ready', () => {
  it('validates before promoting', async () => {
    const { service } = await created();
    const result = await service.revise({
      draftId: 'draft-1',
      transition: 'ready',
      note: 'Validated.',
    });

    expect(result.outcome).toBe('ok');
    if (result.outcome !== 'ok') return;
    expect(latestRevision(result.draft).status).toBe('ready');
  });

  it('refuses to promote a draft that does not validate', async () => {
    // Promoting an invalid draft would make 'ready' a label rather than a claim.
    const { service } = await created({});
    const result = await service.revise({
      draftId: 'draft-1',
      transition: 'ready',
      note: 'Ready?',
    });

    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') return;
    expect(result.code).toBe('DraftInvalid');
    expect(result.issues.map((issue) => issue.code)).toContain('MISSING_INPUT');
  });

  it('writes nothing when it refuses to promote', async () => {
    const { service, calls } = await created({});
    await service.revise({ draftId: 'draft-1', transition: 'ready', note: 'Ready?' });

    expect(calls.updateDraft).toBe(0);
  });

  it('validates the CHANGES, not the draft as it was', async () => {
    const { service } = await created({});
    const result = await service.revise({
      draftId: 'draft-1',
      transition: 'ready',
      changes: { inputs: { topic: 'supplied now' } },
      note: 'Filled it in.',
    });

    expect(result.outcome).toBe('ok');
  });

  it('returns a ready draft to draft when it is edited', async () => {
    const { service } = await created();
    await service.revise({ draftId: 'draft-1', transition: 'ready', note: 'Validated.' });
    const result = await service.revise({
      draftId: 'draft-1',
      transition: 'edit',
      changes: { inputs: { topic: 'changed' } },
      note: 'Changed my mind.',
    });

    expect(result.outcome).toBe('ok');
    if (result.outcome !== 'ok') return;
    expect(latestRevision(result.draft).status).toBe('draft');
  });
});

describe('validating without changing anything', () => {
  it('reports that a complete draft validates', async () => {
    const { service, calls } = await created();
    const before = calls.updateDraft;
    const result = await service.validate('draft-1');

    expect(result.outcome).toBe('ok');
    expect(calls.updateDraft).toBe(before);
  });

  it('reports every reason a draft does not', async () => {
    const { service } = await created({});
    const result = await service.validate('draft-1');

    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') return;
    expect(result.issues.map((issue) => issue.field)).toContain('inputs.topic');
  });
});

// ── Removing ────────────────────────────────────────────────────────────────

describe('removing a draft', () => {
  it('removes an unsubmitted one', async () => {
    const { service, calls } = await created();
    const result = await service.remove('draft-1');

    expect(result.outcome).toBe('ok');
    expect(calls.deleteDraft).toBe(1);
  });

  it('refuses to remove a submitted one', async () => {
    // It is the record of what was submitted; deleting it destroys the
    // provenance of a run that already happened.
    const { service, calls } = await created();
    await service.revise({ draftId: 'draft-1', transition: 'ready', note: 'Validated.' });
    await service.revise({ draftId: 'draft-1', transition: 'submit', note: 'Submitted.' });

    const result = await service.remove('draft-1');

    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') return;
    expect(result.code).toBe('ImmutableDraft');
    expect(calls.deleteDraft).toBe(0);
  });

  it('refuses one that is not there', async () => {
    const { service } = await created();
    const result = await service.remove('draft-nothing');

    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') return;
    expect(result.code).toBe('UnknownDraft');
  });
});

// ── Listing ─────────────────────────────────────────────────────────────────

describe('listing drafts', () => {
  it('sends explicit nulls for the dimensions that are off', async () => {
    const { service, criteria } = await created();
    await service.list();

    expect(criteria[0]).toEqual({
      organizationId: null,
      workspaceId: null,
      principalId: null,
      workflowId: null,
      statuses: null,
      limit: 25,
    });
  });

  it('passes every filter through', async () => {
    const { service, criteria } = await created();
    await service.list({
      organizationId: 'org-1',
      workspaceId: 'ws-1',
      principalId: 'user-1',
      workflowId: 'article.draft',
      statuses: ['draft'],
      limit: 5,
    });

    expect(criteria[0]).toMatchObject({ workspaceId: 'ws-1', statuses: ['draft'], limit: 5 });
  });

  it('narrows by workspace', async () => {
    const { service } = await created();
    const mine = await service.list({ workspaceId: 'ws-1' });
    const theirs = await service.list({ workspaceId: 'ws-2' });

    if (mine.outcome !== 'ok' || theirs.outcome !== 'ok') throw new Error('expected listings');
    expect(mine.drafts).toHaveLength(1);
    expect(theirs.drafts).toHaveLength(0);
  });

  it('refuses an empty status set rather than returning nothing', async () => {
    const { service, calls } = await created();
    const before = calls.listDrafts;
    const result = await service.list({ statuses: [] });

    expect(result.outcome).toBe('refused');
    expect(calls.listDrafts).toBe(before);
  });

  it('refuses a page size outside its bounds rather than clamping', async () => {
    const { service } = await created();

    for (const limit of [0, -1, 1.5, MAX_DRAFT_LIST_LIMIT + 1]) {
      const result = await service.list({ limit });
      expect(result.outcome).toBe('refused');
    }
  });

  it('orders newest updated first, whatever the store returned', async () => {
    let tick = 0;
    const ticks = [
      new Date('2026-07-31T12:00:00.000Z'),
      new Date('2026-07-31T12:01:00.000Z'),
      new Date('2026-07-31T12:02:00.000Z'),
    ];
    const bench = harness(['draft-1', 'draft-2', 'draft-3'], () => {
      const value = ticks[Math.min(tick, ticks.length - 1)] as Date;
      tick += 1;
      return value;
    });

    for (let index = 0; index < 3; index += 1) {
      await bench.service.create({
        metadata,
        workflowId: 'article.draft',
        workflowVersion: 2,
        inputs: { topic: 'tenancy' },
      });
    }

    const result = await bench.service.list();
    if (result.outcome !== 'ok') throw new Error('expected a listing');
    expect(result.drafts.map((entry) => entry.draftId)).toEqual(['draft-3', 'draft-2', 'draft-1']);
  });
});

describe('the refusal taxonomy', () => {
  it('names what the service can refuse', () => {
    expect([...DRAFT_SERVICE_CODES]).toEqual([
      'UnknownDraft',
      'DraftInvalid',
      'IllegalTransition',
      'TenancyMismatch',
      'WorkflowUnresolved',
      'ImmutableDraft',
    ]);
  });

  it('recognises its own members and nothing else', () => {
    expect(isDraftServiceCode('UnknownDraft')).toBe(true);
    expect(isDraftServiceCode('unknownDraft')).toBe(false);
    expect(isDraftServiceCode('Exploded')).toBe(false);
  });
});

describe('the service executes nothing', () => {
  it('takes no orchestrator, no provider registry and no executor', () => {
    // Structural: `DraftServiceOptions` has nowhere to put one.
    const options = createDraftService({
      repository: memoryRepository().repository,
      workflows: REGISTRY,
      templates: LIBRARY,
      now: () => AT,
      newDraftId: () => 'draft-1',
    });

    expect(Object.keys(options).sort()).toEqual([
      'create',
      'list',
      'load',
      'remove',
      'revise',
      'validate',
    ]);
  });
});
