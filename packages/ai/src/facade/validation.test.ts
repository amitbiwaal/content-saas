import type { Principal } from '@contentos/security';
import { describe, expect, it } from 'vitest';

import type { AdmissionOrganization, AdmissionWorkspace } from '../gateway/ports.js';
import {
  CONTENT_OPERATIONS,
  isContentOperation,
  type ContentContext,
  type ContentRequest,
} from './model.js';
import { validateContentRequest } from './validation.js';

const ORG = 'org-1';
const WS = 'ws-1';

const principal = (overrides: Partial<Principal> = {}): Principal => ({
  subjectId: 'user-1',
  kind: 'user',
  method: 'password',
  organizationId: ORG,
  workspaceId: WS,
  roles: ['editor'],
  permissions: ['article:execute'],
  authenticatedAt: new Date('2026-07-31T12:00:00.000Z'),
  mfaSatisfied: true,
  sessionId: null,
  ...overrides,
});

const organization: AdmissionOrganization = { organizationId: ORG, status: 'active' };
const workspace: AdmissionWorkspace = { workspaceId: WS, organizationId: ORG, status: 'active' };

const context = (overrides: Partial<ContentContext> = {}): ContentContext => ({
  principal: principal(),
  organization,
  workspace,
  requestId: 'req-1',
  correlationId: 'corr-1',
  ...overrides,
});

const getDraft = (overrides: Partial<ContentContext> = {}): ContentRequest => ({
  operation: 'getDraft',
  context: context(overrides),
  payload: { draftId: 'draft-1' },
});

const codeOf = (request: ContentRequest): string | null => {
  const result = validateContentRequest(request);
  return result.ok ? null : result.code;
};

const fieldsOf = (request: ContentRequest): readonly string[] => {
  const result = validateContentRequest(request);
  return result.ok ? [] : result.issues.map((issue) => issue.field);
};

describe('the operation vocabulary', () => {
  it('is the ten the platform offers', () => {
    expect([...CONTENT_OPERATIONS]).toEqual([
      'createDraft',
      'updateDraft',
      'deleteDraft',
      'getDraft',
      'listDrafts',
      'submitDraft',
      'getRun',
      'listRuns',
      'search',
      'export',
    ]);
  });

  it('recognises its own members and nothing else', () => {
    expect(isContentOperation('submitDraft')).toBe(true);
    expect(isContentOperation('SUBMITDRAFT')).toBe(false);
    expect(isContentOperation('deleteRun')).toBe(false);
  });

  it('refuses an operation nobody offers', () => {
    const request = { ...getDraft(), operation: 'deleteRun' } as unknown as ContentRequest;
    expect(codeOf(request)).toBe('InvalidOperation');
  });

  it('refuses one before it looks at anything else', () => {
    const request = {
      operation: 'nonsense',
      context: undefined,
      payload: {},
    } as unknown as ContentRequest;

    expect(codeOf(request)).toBe('InvalidOperation');
  });
});

describe('the context', () => {
  it('accepts a complete one', () => {
    expect(validateContentRequest(getDraft()).ok).toBe(true);
  });

  it('requires every identifier, and infers none', () => {
    for (const [field, overrides] of [
      ['context.requestId', { requestId: '' }],
      ['context.correlationId', { correlationId: '  ' }],
      ['context.principal.subjectId', { principal: principal({ subjectId: '' }) }],
      [
        'context.organization.organizationId',
        { organization: { organizationId: '', status: 'active' as const } },
      ],
      [
        'context.workspace.workspaceId',
        { workspace: { workspaceId: '', organizationId: ORG, status: 'active' as const } },
      ],
    ] as const) {
      const request = getDraft(overrides);
      expect(codeOf(request)).toBe('MissingIdentifier');
      expect(fieldsOf(request)).toContain(field);
    }
  });

  it('refuses a request with no context at all', () => {
    const request = { ...getDraft(), context: undefined } as unknown as ContentRequest;
    expect(codeOf(request)).toBe('MissingIdentifier');
  });
});

describe('a context that disagrees with itself', () => {
  it('refuses a principal resolved for another workspace', () => {
    // Two claims about who is asking. Picking either silently is how a facade
    // becomes a way around the thing that resolved them.
    expect(codeOf(getDraft({ principal: principal({ workspaceId: 'ws-2' }) }))).toBe(
      'ContradictoryRequest',
    );
  });

  it('refuses a principal resolved for another organization', () => {
    expect(codeOf(getDraft({ principal: principal({ organizationId: 'org-2' }) }))).toBe(
      'ContradictoryRequest',
    );
  });

  it('refuses a workspace that belongs to another organization', () => {
    expect(
      codeOf(
        getDraft({
          workspace: { workspaceId: WS, organizationId: 'org-2', status: 'active' },
        }),
      ),
    ).toBe('ContradictoryRequest');
  });

  it('names which part disagreed', () => {
    expect(fieldsOf(getDraft({ principal: principal({ workspaceId: 'ws-2' }) }))).toContain(
      'context.workspace.workspaceId',
    );
  });
});

describe('required identifiers, per operation', () => {
  const withPayload = (operation: string, payload: unknown): ContentRequest =>
    ({ operation, context: context(), payload }) as unknown as ContentRequest;

  it('createDraft needs a title, a workflow and a pinned version', () => {
    expect(
      codeOf(withPayload('createDraft', { workflowId: 'w', workflowVersion: 1, inputs: {} })),
    ).toBe('MissingIdentifier');
    expect(codeOf(withPayload('createDraft', { title: 't', workflowVersion: 1, inputs: {} }))).toBe(
      'MissingIdentifier',
    );
    expect(codeOf(withPayload('createDraft', { title: 't', workflowId: 'w', inputs: {} }))).toBe(
      'MissingIdentifier',
    );
    expect(
      validateContentRequest(
        withPayload('createDraft', { title: 't', workflowId: 'w', workflowVersion: 2, inputs: {} }),
      ).ok,
    ).toBe(true);
  });

  it('updateDraft needs a draft, a transition and a note', () => {
    expect(codeOf(withPayload('updateDraft', { transition: 'edit', note: 'n' }))).toBe(
      'MissingIdentifier',
    );
    expect(codeOf(withPayload('updateDraft', { draftId: 'd', note: 'n' }))).toBe(
      'MissingIdentifier',
    );
    expect(
      codeOf(withPayload('updateDraft', { draftId: 'd', transition: 'edit', note: ' ' })),
    ).toBe('MissingIdentifier');
  });

  it('getDraft and deleteDraft need a draft', () => {
    for (const operation of ['getDraft', 'deleteDraft']) {
      expect(codeOf(withPayload(operation, {}))).toBe('MissingIdentifier');
      expect(validateContentRequest(withPayload(operation, { draftId: 'd' })).ok).toBe(true);
    }
  });

  it('getRun needs a run', () => {
    expect(codeOf(withPayload('getRun', {}))).toBe('MissingIdentifier');
    expect(validateContentRequest(withPayload('getRun', { runId: 'r' })).ok).toBe(true);
  });

  it('submitDraft needs a draft, a model, a timeout and an idempotency key', () => {
    const complete = { draftId: 'd', model: 'm', timeoutMs: 1_000, idempotencyKey: 'k' };

    expect(validateContentRequest(withPayload('submitDraft', complete)).ok).toBe(true);
    for (const missing of ['draftId', 'model', 'idempotencyKey']) {
      expect(codeOf(withPayload('submitDraft', { ...complete, [missing]: '' }))).toBe(
        'MissingIdentifier',
      );
    }
    expect(codeOf(withPayload('submitDraft', { ...complete, timeoutMs: 0 }))).toBe(
      'MissingIdentifier',
    );
  });

  it('search names what to search', () => {
    expect(codeOf(withPayload('search', {}))).toBe('MissingIdentifier');
    expect(validateContentRequest(withPayload('search', { kind: 'runs' })).ok).toBe(true);
  });

  it('export names a format and what it is of', () => {
    expect(codeOf(withPayload('export', { target: { kind: 'run', runId: 'r' } }))).toBe(
      'MissingIdentifier',
    );
    expect(codeOf(withPayload('export', { format: 'json' }))).toBe('MissingIdentifier');
    expect(codeOf(withPayload('export', { format: 'json', target: { kind: 'run' } }))).toBe(
      'MissingIdentifier',
    );
    expect(codeOf(withPayload('export', { format: 'json', target: { kind: 'draft' } }))).toBe(
      'MissingIdentifier',
    );
    expect(
      validateContentRequest(
        withPayload('export', { format: 'json', target: { kind: 'artifacts' } }),
      ).ok,
    ).toBe(true);
  });

  it('listDrafts refuses a present-but-empty filter', () => {
    expect(codeOf(withPayload('listDrafts', { principalId: '  ' }))).toBe('MissingIdentifier');
    expect(validateContentRequest(withPayload('listDrafts', {})).ok).toBe(true);
  });
});

describe('a filter that names somebody else’s tenancy', () => {
  const withQuery = (operation: string, filter: unknown): ContentRequest =>
    ({
      operation,
      context: context(),
      payload: operation === 'search' ? { kind: 'runs', query: { filter } } : { query: { filter } },
    }) as unknown as ContentRequest;

  it('is refused on listRuns', () => {
    expect(codeOf(withQuery('listRuns', { workspaceId: 'ws-2' }))).toBe('ContradictoryRequest');
    expect(codeOf(withQuery('listRuns', { organizationId: 'org-2' }))).toBe('ContradictoryRequest');
  });

  it('is refused on search', () => {
    expect(codeOf(withQuery('search', { workspaceId: 'ws-2' }))).toBe('ContradictoryRequest');
  });

  it('is accepted when it names the caller’s own', () => {
    expect(validateContentRequest(withQuery('listRuns', { workspaceId: WS })).ok).toBe(true);
    expect(validateContentRequest(withQuery('search', { organizationId: ORG })).ok).toBe(true);
  });

  it('is accepted when it is absent, which means "the one I am in"', () => {
    expect(validateContentRequest(withQuery('listRuns', {})).ok).toBe(true);
  });

  it('is refused on a bulk export target', () => {
    const request = {
      operation: 'export',
      context: context(),
      payload: {
        format: 'json',
        target: { kind: 'artifacts', query: { filter: { workspaceId: 'ws-2' } } },
      },
    } as unknown as ContentRequest;

    expect(codeOf(request)).toBe('ContradictoryRequest');
  });

  it('says how to say what the caller meant', () => {
    const result = validateContentRequest(withQuery('listRuns', { workspaceId: 'ws-2' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.detail).toMatch(/Omit it to mean the one you are in/);
  });
});

describe('reporting', () => {
  it('reports every issue, not the first', () => {
    const request = {
      operation: 'submitDraft',
      context: context(),
      payload: { draftId: '', model: '', timeoutMs: 0, idempotencyKey: '' },
    } as unknown as ContentRequest;

    const result = validateContentRequest(request);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toHaveLength(4);
  });

  it('calls a contradiction a contradiction even alongside a missing field', () => {
    // Acting on a contradiction would answer somebody else's question rather
    // than none, which is the worse of the two.
    const request = {
      operation: 'listRuns',
      context: context(),
      payload: { query: { filter: { workspaceId: 'ws-2' } } },
    } as unknown as ContentRequest;

    expect(codeOf(request)).toBe('ContradictoryRequest');
  });

  it('freezes the issues it returns', () => {
    const result = validateContentRequest(getDraft({ requestId: '' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(Object.isFrozen(result.issues)).toBe(true);
  });
});
