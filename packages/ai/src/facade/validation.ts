/**
 * Checking a request before anything is delegated.
 *
 * ── Three kinds of wrong, three codes ──────────────────────────────────────
 * An operation nobody offers, an identifier nobody supplied, and a request that
 * says two things at once. They are different mistakes and a caller fixes them
 * differently, so they are not one code.
 *
 * ── Contradiction is refused, never resolved ───────────────────────────────
 * A principal resolved for one workspace, acting on a request that names
 * another, is not a request with a typo — it is two claims about who is asking.
 * Picking either one silently is how a facade becomes a way around the thing
 * that resolved them.
 *
 * The same for a filter: a caller may name its own workspace, and must not name
 * a different one. Absent means "the one I am in"; present and different means
 * the request is wrong.
 *
 * ── Nothing here is inferred ───────────────────────────────────────────────
 * No default organization, no default workspace, no generated correlation id.
 * A missing identifier is a refusal, because the alternative is answering a
 * question nobody asked.
 */

import {
  isContentOperation,
  type ContentContext,
  type ContentRequest,
  type ExportTarget,
} from './model.js';

/**
 * A context AS RECEIVED.
 *
 * The declared type says every field is there; a request that arrived over a
 * wire says nothing of the kind. Checking against the looser shape is what
 * makes the presence checks real rather than something the compiler has already
 * decided cannot fail.
 */
interface ReceivedContext {
  readonly principal?: {
    readonly subjectId?: unknown;
    readonly organizationId?: unknown;
    readonly workspaceId?: unknown;
  };
  readonly organization?: { readonly organizationId?: unknown };
  readonly workspace?: { readonly workspaceId?: unknown; readonly organizationId?: unknown };
  readonly requestId?: unknown;
  readonly correlationId?: unknown;
}

const received = (context: ContentContext): ReceivedContext => context as ReceivedContext;

export interface RequestIssue {
  readonly field: string;
  readonly code: string;
  readonly detail: string;
}

export type RequestValidation =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: 'InvalidOperation' | 'MissingIdentifier' | 'ContradictoryRequest';
      readonly issues: readonly RequestIssue[];
    };

const isBlank = (value: unknown): boolean => typeof value !== 'string' || value.trim() === '';

/** Every identifier the context must carry, whatever is being asked. */
function checkContext(context: ReceivedContext | undefined, issues: RequestIssue[]): void {
  if (context === undefined || typeof context !== 'object') {
    issues.push({
      field: 'context',
      code: 'MISSING',
      detail: 'Every operation acts for somebody, somewhere; a context is required.',
    });
    return;
  }

  const named: readonly (readonly [string, unknown])[] = [
    ['context.requestId', context.requestId],
    ['context.correlationId', context.correlationId],
    ['context.principal.subjectId', context.principal?.subjectId],
    ['context.organization.organizationId', context.organization?.organizationId],
    ['context.workspace.workspaceId', context.workspace?.workspaceId],
  ];

  for (const [field, value] of named) {
    if (isBlank(value)) {
      issues.push({
        field,
        code: 'MISSING',
        detail: `'${field}' is required and is not inferred.`,
      });
    }
  }
}

/** Where the context disagrees with itself. */
function checkCoherence(context: ReceivedContext, issues: RequestIssue[]): void {
  const principal = context.principal ?? {};
  const organization = context.organization ?? {};
  const workspace = context.workspace ?? {};

  if (
    !isBlank(principal.workspaceId) &&
    !isBlank(workspace.workspaceId) &&
    principal.workspaceId !== workspace.workspaceId
  ) {
    issues.push({
      field: 'context.workspace.workspaceId',
      code: 'CONTRADICTORY',
      detail: `The principal was resolved for workspace '${String(principal.workspaceId)}' and the request acts in '${String(workspace.workspaceId)}'.`,
    });
  }

  if (
    !isBlank(principal.organizationId) &&
    !isBlank(organization.organizationId) &&
    principal.organizationId !== organization.organizationId
  ) {
    issues.push({
      field: 'context.organization.organizationId',
      code: 'CONTRADICTORY',
      detail: `The principal was resolved for organization '${String(principal.organizationId)}' and the request acts in '${String(organization.organizationId)}'.`,
    });
  }

  if (
    !isBlank(workspace.organizationId) &&
    !isBlank(organization.organizationId) &&
    workspace.organizationId !== organization.organizationId
  ) {
    issues.push({
      field: 'context.workspace.organizationId',
      code: 'CONTRADICTORY',
      detail: `Workspace '${String(workspace.workspaceId)}' belongs to organization '${String(workspace.organizationId)}', not '${String(organization.organizationId)}'.`,
    });
  }
}

/** A filter may name the caller's own tenancy, and must not name another's. */
function checkTenancyFilter(
  context: ContentContext,
  filter: { organizationId?: string; workspaceId?: string } | undefined,
  where: string,
  issues: RequestIssue[],
): void {
  if (filter === undefined) return;

  if (
    filter.organizationId !== undefined &&
    filter.organizationId !== context.organization.organizationId
  ) {
    issues.push({
      field: `${where}.organizationId`,
      code: 'CONTRADICTORY',
      detail: `This request acts in organization '${context.organization.organizationId}' and the filter names '${filter.organizationId}'. Omit it to mean the one you are in.`,
    });
  }

  if (filter.workspaceId !== undefined && filter.workspaceId !== context.workspace.workspaceId) {
    issues.push({
      field: `${where}.workspaceId`,
      code: 'CONTRADICTORY',
      detail: `This request acts in workspace '${context.workspace.workspaceId}' and the filter names '${filter.workspaceId}'. Omit it to mean the one you are in.`,
    });
  }
}

/** The identifiers each operation cannot do without. */
function checkPayload(
  request: ContentRequest,
  context: ContentContext,
  issues: RequestIssue[],
): void {
  // Named , not : a local called  reads as a CommonJS
  // import to every tool that scans this file, boundary checking included.
  const needs = (field: string, value: unknown, why: string): void => {
    if (isBlank(value)) issues.push({ field: `payload.${field}`, code: 'MISSING', detail: why });
  };

  switch (request.operation) {
    case 'createDraft':
      needs('title', request.payload.title, 'A draft needs a name a person can find it by.');
      needs('workflowId', request.payload.workflowId, 'A draft is against one workflow.');
      if (!Number.isInteger(request.payload.workflowVersion)) {
        issues.push({
          field: 'payload.workflowVersion',
          code: 'MISSING',
          detail: 'A draft pins a workflow version; an unpinned one would move under its author.',
        });
      }
      break;

    case 'updateDraft':
      needs('draftId', request.payload.draftId, 'Which draft to revise.');
      needs('note', request.payload.note, 'A revision says why it exists.');
      needs('transition', request.payload.transition, 'What the revision does to its status.');
      break;

    case 'deleteDraft':
    case 'getDraft':
      needs('draftId', request.payload.draftId, 'Which draft.');
      break;

    case 'listDrafts':
      if (request.payload.principalId !== undefined && isBlank(request.payload.principalId)) {
        issues.push({
          field: 'payload.principalId',
          code: 'MISSING',
          detail: 'A filter that is present and empty matches nothing; omit it instead.',
        });
      }
      break;

    case 'submitDraft':
      needs('draftId', request.payload.draftId, 'Which draft to submit.');
      needs('model', request.payload.model, 'A run needs a model to ask for.');
      needs(
        'idempotencyKey',
        request.payload.idempotencyKey,
        'Half of every step’s key, and the thing that makes a retry the same call.',
      );
      if (!Number.isInteger(request.payload.timeoutMs) || request.payload.timeoutMs <= 0) {
        issues.push({
          field: 'payload.timeoutMs',
          code: 'MISSING',
          detail: 'Each step needs a timeout; a run without one has no bound.',
        });
      }
      break;

    case 'getRun':
      needs('runId', request.payload.runId, 'Which run.');
      break;

    case 'listRuns':
      checkTenancyFilter(context, request.payload.query?.filter, 'payload.query.filter', issues);
      break;

    case 'search':
      needs('kind', request.payload.kind, 'What to search: runs, drafts or artifacts.');
      checkTenancyFilter(context, request.payload.query?.filter, 'payload.query.filter', issues);
      break;

    case 'export':
      needs('format', request.payload.format, 'What to serialise it as.');
      {
        const target = request.payload.target as ExportTarget | undefined;
        if (target === undefined || isBlank(target.kind)) {
          issues.push({
            field: 'payload.target.kind',
            code: 'MISSING',
            detail: 'An export names what it is of; it is never inferred from what else is set.',
          });
          break;
        }
      }
      if (request.payload.target.kind === 'run') {
        needs('target.runId', request.payload.target.runId, 'Which run to export.');
      }
      if (request.payload.target.kind === 'draft') {
        needs('target.draftId', request.payload.target.draftId, 'Which draft to export.');
      }
      if (request.payload.target.kind !== 'run' && request.payload.target.kind !== 'draft') {
        checkTenancyFilter(
          context,
          request.payload.target.query?.filter,
          'payload.target.query.filter',
          issues,
        );
      }
      break;
  }
}

export function validateContentRequest(request: ContentRequest): RequestValidation {
  if (!isContentOperation((request as { operation?: unknown }).operation)) {
    return {
      ok: false,
      code: 'InvalidOperation',
      issues: [
        {
          field: 'operation',
          code: 'UNKNOWN_OPERATION',
          detail: `'${String((request as { operation?: unknown }).operation)}' is not an operation this platform offers.`,
        },
      ],
    };
  }

  const issues: RequestIssue[] = [];
  checkContext(received(request.context), issues);
  if (issues.length > 0) {
    return { ok: false, code: 'MissingIdentifier', issues: Object.freeze(issues) };
  }

  checkCoherence(received(request.context), issues);
  if (issues.length > 0) {
    return { ok: false, code: 'ContradictoryRequest', issues: Object.freeze(issues) };
  }

  checkPayload(request, request.context, issues);
  if (issues.length === 0) return { ok: true };

  // A contradiction and a missing field can both be present; the contradiction
  // is the more serious, because acting on it would answer somebody else's
  // question rather than none.
  const contradictory = issues.some((issue) => issue.code === 'CONTRADICTORY');
  return {
    ok: false,
    code: contradictory ? 'ContradictoryRequest' : 'MissingIdentifier',
    issues: Object.freeze(issues),
  };
}
