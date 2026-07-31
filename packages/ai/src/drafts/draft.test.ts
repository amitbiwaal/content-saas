import { describe, expect, it } from 'vitest';

import {
  appendRevision,
  describeDraft,
  draftStatus,
  latestRevision,
  newDraft,
  type ContentDraft,
  type DraftMetadata,
} from './draft.js';

const AT = '2026-07-31T12:00:00.000Z';
const LATER = '2026-07-31T12:05:00.000Z';

const metadata: DraftMetadata = {
  organizationId: 'org-1',
  workspaceId: 'ws-1',
  principalId: 'user-1',
  principalKind: 'user',
  title: 'An article about tenancy',
  tags: ['article'],
};

const draft = (): ContentDraft =>
  newDraft({
    draftId: 'draft-1',
    metadata,
    workflowId: 'article.draft',
    workflowVersion: 2,
    workflowRef: 'article.draft@2',
    capability: 'chat',
    templateReferences: [
      { templateId: 'planning.outline', templateVersion: 7, promptVersion: 'planning.outline@7' },
    ],
    inputs: { topic: 'multi-tenancy' },
    now: AT,
  });

describe('creating a draft', () => {
  it('starts at revision 1, as a draft', () => {
    const value = draft();

    expect(value.revisions).toHaveLength(1);
    expect(latestRevision(value).revision).toBe(1);
    expect(draftStatus(value)).toBe('draft');
  });

  it('records the workflow it is against, pinned', () => {
    const value = draft();

    expect(value.workflowId).toBe('article.draft');
    expect(value.workflowVersion).toBe(2);
    expect(value.workflowRef).toBe('article.draft@2');
    expect(value.capability).toBe('chat');
  });

  it('records the template references it resolved', () => {
    expect(draft().templateReferences).toEqual([
      { templateId: 'planning.outline', templateVersion: 7, promptVersion: 'planning.outline@7' },
    ]);
  });

  it('records who it belongs to, and nothing about what they may do', () => {
    const value = draft();

    expect(value.metadata.workspaceId).toBe('ws-1');
    expect(value.metadata.principalId).toBe('user-1');
    expect(value.metadata.principalKind).toBe('user');
    expect(JSON.stringify(value)).not.toContain('permissions');
  });

  it('stamps both timestamps from the supplied clock', () => {
    const value = draft();

    expect(value.createdAt).toBe(AT);
    expect(value.updatedAt).toBe(AT);
    expect(latestRevision(value).createdAt).toBe(AT);
  });

  it('carries the inputs it was given', () => {
    expect(latestRevision(draft()).inputs).toEqual({ topic: 'multi-tenancy' });
  });

  it('is frozen through', () => {
    const value = draft();

    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.revisions)).toBe(true);
    expect(Object.isFrozen(value.revisions[0])).toBe(true);
    expect(Object.isFrozen(value.metadata)).toBe(true);
    expect(Object.isFrozen(value.templateReferences)).toBe(true);
  });

  it('does not alias what it was handed', () => {
    const inputs = { topic: 'multi-tenancy' };
    const value = newDraft({
      draftId: 'draft-1',
      metadata,
      workflowId: 'article.draft',
      workflowVersion: 2,
      workflowRef: 'article.draft@2',
      capability: 'chat',
      templateReferences: [],
      inputs,
      now: AT,
    });

    inputs.topic = 'something else';
    expect(latestRevision(value).inputs['topic']).toBe('multi-tenancy');
  });
});

describe('revising a draft', () => {
  it('appends rather than replacing', () => {
    const before = draft();
    const after = appendRevision({
      draft: before,
      status: 'ready',
      note: 'Validated.',
      now: LATER,
    });

    expect(before.revisions).toHaveLength(1);
    expect(after.revisions).toHaveLength(2);
    expect(after).not.toBe(before);
  });

  it('leaves the previous draft entirely intact', () => {
    // Editing history is what makes "what did this look like before?"
    // answerable, and a draft that could be rewritten would answer it wrongly.
    const before = draft();
    appendRevision({
      draft: before,
      status: 'ready',
      changes: { inputs: { topic: 'something else' } },
      note: 'Changed the topic.',
      now: LATER,
    });

    expect(latestRevision(before).inputs).toEqual({ topic: 'multi-tenancy' });
    expect(latestRevision(before).status).toBe('draft');
  });

  it('numbers revisions consecutively', () => {
    let value = draft();
    for (let index = 0; index < 3; index += 1) {
      value = appendRevision({ draft: value, status: 'draft', note: 'Edited.', now: LATER });
    }

    expect(value.revisions.map((revision) => revision.revision)).toEqual([1, 2, 3, 4]);
  });

  it('keeps every earlier revision readable', () => {
    const first = draft();
    const second = appendRevision({
      draft: first,
      status: 'draft',
      changes: { inputs: { topic: 'second' } },
      note: 'Edited.',
      now: LATER,
    });

    expect(second.revisions[0]?.inputs).toEqual({ topic: 'multi-tenancy' });
    expect(second.revisions[1]?.inputs).toEqual({ topic: 'second' });
  });

  it('replaces inputs rather than merging them', () => {
    // A merge would make removing a value impossible to express, and "the field
    // I cleared came back" is a bug nobody reports because nobody believes it.
    const before = appendRevision({
      draft: draft(),
      status: 'draft',
      changes: { inputs: { topic: 'a', extra: 'b' } },
      note: 'Two inputs.',
      now: LATER,
    });
    const after = appendRevision({
      draft: before,
      status: 'draft',
      changes: { inputs: { topic: 'a' } },
      note: 'Removed one.',
      now: LATER,
    });

    expect(latestRevision(after).inputs).toEqual({ topic: 'a' });
  });

  it('carries the inputs forward when a revision does not change them', () => {
    const after = appendRevision({
      draft: draft(),
      status: 'ready',
      note: 'Validated, no edits.',
      now: LATER,
    });

    expect(latestRevision(after).inputs).toEqual({ topic: 'multi-tenancy' });
  });

  it('moves updatedAt but never createdAt', () => {
    const after = appendRevision({ draft: draft(), status: 'ready', note: 'Ready.', now: LATER });

    expect(after.createdAt).toBe(AT);
    expect(after.updatedAt).toBe(LATER);
  });

  it('keeps the pinned references exactly where they were', () => {
    const after = appendRevision({
      draft: draft(),
      status: 'draft',
      changes: { inputs: { topic: 'anything' }, title: 'A new title' },
      note: 'Edited.',
      now: LATER,
    });

    expect(after.workflowId).toBe('article.draft');
    expect(after.workflowVersion).toBe(2);
    expect(after.templateReferences).toEqual(draft().templateReferences);
  });

  it('follows the title through to the metadata', () => {
    const after = appendRevision({
      draft: draft(),
      status: 'draft',
      changes: { title: 'A new title' },
      note: 'Renamed.',
      now: LATER,
    });

    expect(latestRevision(after).title).toBe('A new title');
    expect(after.metadata.title).toBe('A new title');
  });

  it('records why the revision exists', () => {
    expect(
      latestRevision(
        appendRevision({ draft: draft(), status: 'ready', note: 'Validated.', now: LATER }),
      ).note,
    ).toBe('Validated.');
  });

  it('freezes what it returns', () => {
    const after = appendRevision({ draft: draft(), status: 'ready', note: 'Ready.', now: LATER });

    expect(Object.isFrozen(after)).toBe(true);
    expect(Object.isFrozen(after.revisions[1])).toBe(true);
  });
});

describe('in-place mutation', () => {
  it('is refused on the draft', () => {
    const value = draft();
    expect(() => {
      (value as { draftId: string }).draftId = 'other';
    }).toThrow();
  });

  it('is refused on a revision', () => {
    const value = draft();
    expect(() => {
      (value.revisions[0] as { note: string }).note = 'rewritten';
    }).toThrow();
  });

  it('is refused on the revision list', () => {
    const value = draft();
    expect(() => {
      (value.revisions as { length: number }).length = 0;
    }).toThrow();
  });

  it('is refused on the inputs of an earlier revision', () => {
    const value = appendRevision({ draft: draft(), status: 'ready', note: 'Ready.', now: LATER });
    expect(() => {
      (value.revisions[0]?.inputs as Record<string, unknown>)['topic'] = 'rewritten';
    }).toThrow();
  });
});

describe('describing a draft', () => {
  it('names the workflow and the revision', () => {
    expect(describeDraft(draft())).toBe("draft 'draft-1' (article.draft@2, revision 1)");
  });
});
