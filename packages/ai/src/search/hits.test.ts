import { describe, expect, it } from 'vitest';

import { appendRevision, newDraft, type ContentDraft } from '../drafts/draft.js';
import { PERSISTENCE_ONLY_FIELDS, toArtifactHistoryView } from '../history/views.js';
import { CONTENT_RUN_SCHEMA_VERSION, type StoredArtifact } from '../runs/stored.js';
import { artifactHit, draftHit, runHit, toDraftSearchView, WITHHELD_DRAFT_FIELDS } from './hits.js';
import type { RunHistoryView } from '../history/views.js';

const AT = '2026-07-31T12:00:00.000Z';
const LATER = '2026-07-31T12:05:00.000Z';

const draft = (): ContentDraft =>
  newDraft({
    draftId: 'draft-1',
    metadata: {
      organizationId: 'org-1',
      workspaceId: 'ws-1',
      principalId: 'user-1',
      principalKind: 'user',
      title: 'An article about tenancy',
      tags: ['article', 'seo'],
    },
    workflowId: 'article.draft',
    workflowVersion: 2,
    workflowRef: 'article.draft@2',
    capability: 'chat',
    templateReferences: [
      { templateId: 'planning.outline', templateVersion: 7, promptVersion: 'planning.outline@7' },
    ],
    inputs: { topic: 'multi-tenancy', secretNote: 'do not list this' },
    now: AT,
  });

const artifact = (): StoredArtifact => ({
  schemaVersion: CONTENT_RUN_SCHEMA_VERSION,
  createdAt: LATER,
  updatedAt: LATER,
  runId: 'run-1',
  stepId: 'outline',
  sequence: 0,
  prompt: {
    templateId: 'planning.outline',
    templateVersion: 7,
    promptVersion: 'planning.outline@7',
  },
  providerId: 'openai',
  model: 'gpt-4o-2026-05-01',
  capability: 'chat',
  content: 'An outline.',
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

const run: RunHistoryView = Object.freeze({
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
  organizationId: 'org-1',
  workspaceId: 'ws-1',
  principalId: 'user-1',
  principalKind: 'user',
  correlationId: 'corr-1',
  timings: { createdAt: AT, compiledAt: AT, startedAt: AT, finishedAt: AT },
  failure: null,
  artifactCount: 1,
});

describe('the draft projection', () => {
  it('carries identity, title and tags', () => {
    const view = toDraftSearchView(draft());

    expect(view.draftId).toBe('draft-1');
    expect(view.title).toBe('An article about tenancy');
    expect(view.tags).toEqual(['article', 'seo']);
  });

  it('carries where it is in its lifecycle', () => {
    const view = toDraftSearchView(draft());

    expect(view.status).toBe('draft');
    expect(view.revision).toBe(1);
    expect(view.revisions).toBe(1);
  });

  it('follows the current revision, not the first', () => {
    const revised = appendRevision({
      draft: draft(),
      status: 'ready',
      changes: { title: 'Renamed' },
      note: 'Validated.',
      now: LATER,
    });
    const view = toDraftSearchView(revised);

    expect(view.title).toBe('Renamed');
    expect(view.status).toBe('ready');
    expect(view.revision).toBe(2);
    expect(view.revisions).toBe(2);
  });

  it('carries the workflow and template references', () => {
    const view = toDraftSearchView(draft());

    expect(view.workflowRef).toBe('article.draft@2');
    expect(view.workflowVersion).toBe(2);
    expect(view.capability).toBe('chat');
    expect(view.templateReferences).toEqual([
      { templateId: 'planning.outline', templateVersion: 7, promptVersion: 'planning.outline@7' },
    ]);
  });

  it('carries tenancy and who made it, and no authority', () => {
    const view = toDraftSearchView(draft());

    expect(view.organizationId).toBe('org-1');
    expect(view.workspaceId).toBe('ws-1');
    expect(view.principalId).toBe('user-1');
    expect(JSON.stringify(view)).not.toContain('permissions');
  });

  it('carries no inputs at all', () => {
    // A listing that returned everything anybody had typed, across a workspace,
    // is a disclosure decision nobody asked search to make.
    const view = toDraftSearchView(draft());

    for (const field of WITHHELD_DRAFT_FIELDS) {
      expect(Object.keys(view)).not.toContain(field);
    }
    expect(JSON.stringify(view)).not.toContain('do not list this');
  });

  it('carries no revision history, only how much of it there is', () => {
    const view = toDraftSearchView(draft());
    expect(Object.keys(view)).not.toContain('revisions0');
    expect(typeof view.revisions).toBe('number');
  });

  it('carries both timestamps', () => {
    const view = toDraftSearchView(draft());

    expect(view.createdAt).toBe(AT);
    expect(view.updatedAt).toBe(AT);
  });

  it('is frozen through', () => {
    const view = toDraftSearchView(draft());

    expect(Object.isFrozen(view)).toBe(true);
    expect(Object.isFrozen(view.tags)).toBe(true);
    expect(Object.isFrozen(view.templateReferences)).toBe(true);
  });

  it('does not alias the draft it came from', () => {
    const value = draft();
    const view = toDraftSearchView(value);

    expect(view.tags).not.toBe(value.metadata.tags);
    expect(view.templateReferences).not.toBe(value.templateReferences);
  });
});

describe('hits', () => {
  it('say what they are', () => {
    expect(runHit(run).kind).toBe('run');
    expect(draftHit(draft()).kind).toBe('draft');
    expect(artifactHit(toArtifactHistoryView(artifact())).kind).toBe('artifact');
  });

  it('carry the read models that already exist, not copies', () => {
    const hit = runHit(run);
    expect(hit.kind === 'run' && hit.run).toBe(run);
  });

  it('never carry persistence-only fields on an artifact', () => {
    const hit = artifactHit(toArtifactHistoryView(artifact()));

    expect(hit.kind).toBe('artifact');
    if (hit.kind !== 'artifact') return;
    for (const field of PERSISTENCE_ONLY_FIELDS) {
      expect(Object.keys(hit.artifact)).not.toContain(field);
    }
  });

  it('preserve artifact usage and provenance', () => {
    const hit = artifactHit(toArtifactHistoryView(artifact()));

    if (hit.kind !== 'artifact') return;
    expect(hit.artifact.usage.totalTokens).toBe(30);
    expect(hit.artifact.usage.amount).toBe('0.000225');
    expect(hit.artifact.prompt.promptVersion).toBe('planning.outline@7');
    expect(hit.artifact.providerId).toBe('openai');
    expect(hit.artifact.metadata).toEqual({ plannedProviderId: 'openai' });
  });

  it('are frozen', () => {
    expect(Object.isFrozen(runHit(run))).toBe(true);
    expect(Object.isFrozen(draftHit(draft()))).toBe(true);
    expect(Object.isFrozen(artifactHit(toArtifactHistoryView(artifact())))).toBe(true);
  });
});
