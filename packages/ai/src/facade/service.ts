/**
 * The Content Management Facade — one way in.
 *
 *   request → validate → delegate to the ONE service that owns it → respond
 *
 * ── It coordinates. It decides nothing ─────────────────────────────────────
 * Every operation is a routing decision and a shape change. Drafts go to the
 * draft service, a submission to the orchestrator, a run lookup to history, a
 * page to search, bytes to export. There is no filtering, no ordering, no
 * validation of content, no pricing and no state machine here — all of those
 * have owners, and a second copy in the entry point would be the copy every
 * caller actually hit.
 *
 * ── It holds services, never their insides ─────────────────────────────────
 * No repository, no registry, no provider, no workflow runtime. Compilation
 * arrives as a port with its registries already bound, because a registry is
 * not one of the five things this layer may reuse.
 *
 * ── Tenancy is taken from the context, and disagreement is refused ─────────
 * A create takes its organization, workspace and author from the resolved
 * context — so a caller cannot make a draft somewhere else, or in somebody
 * else's name, by asking. A filter may name the caller's own tenancy and is
 * refused if it names another's. Nothing is inferred and nothing is overruled.
 *
 * ── Nothing throws ─────────────────────────────────────────────────────────
 * Every operation returns a success or a refusal, including when a delegate
 * throws: an entry point that could throw would make every caller wrap it, and
 * the first one that forgot would turn a service fault into a 500 with no code.
 *
 * ── No clock, no id generator, no identity ─────────────────────────────────
 * There is nothing to inject. Every timestamp, id and principal this layer
 * passes on came in with the request, which is what "never create synthetic
 * identity" means when it is structural rather than a promise.
 */

import type { CompileDraftOptions, DraftCompilation } from '../drafts/compile.js';
import { DRAFT_COMPILATION_CODES } from '../drafts/compile.js';
import { DRAFT_SERVICE_CODES, type DraftService } from '../drafts/service.js';
import { EXPORT_CODES, type ContentExportService, type ExportResult } from '../exports/service.js';
import type { RunHistoryService } from '../history/service.js';
import type { Orchestrator } from '../runs/orchestrator.js';
import type { RunStatus } from '../runs/state.js';
import type { ContentSearchFilter, ContentSearchQuery } from '../search/query.js';
import type { ContentSearchService } from '../search/service.js';
import {
  isContentOperation,
  type ContentContext,
  type ContentData,
  type ContentOperation,
  type ContentRefusal,
  type ContentRequest,
  type ContentResponse,
  type ContentTrace,
  type ExportPayload,
} from './model.js';
import { validateContentRequest, type RequestIssue } from './validation.js';

/**
 * Draft Management's compiler, with its registries already bound.
 *
 * A port rather than the free function, so the facade never holds a workflow
 * registry or a template library. Those belong to Draft Management; the facade
 * may reuse the service, not reach past it.
 */
export interface DraftCompiler {
  compile(
    input: Omit<CompileDraftOptions, 'workflows' | 'templates' | 'providers'>,
  ): DraftCompilation;
}

/**
 * Every code this surface can return.
 *
 * Contributed by the layers it delegates to, spread in rather than restated,
 * plus the four things only an entry point can refuse. Duplicates across
 * contributors are removed for the runtime list; the type is the union either
 * way.
 */
const CONTRIBUTED = [
  ...EXPORT_CODES,
  ...DRAFT_SERVICE_CODES,
  ...DRAFT_COMPILATION_CODES,
  'InvalidOperation',
  'MissingIdentifier',
  'ContradictoryRequest',
  /**
   * A delegate threw.
   *
   * Nothing in the existing taxonomy means this, and something has to: a
   * service that raises rather than refusing is a fault, not an answer, and a
   * caller told `InvalidRequest` would go looking for its own mistake.
   */
  'ServiceFailed',
] as const;

export type ContentErrorCode = (typeof CONTRIBUTED)[number];

export const CONTENT_ERROR_CODES: readonly ContentErrorCode[] = Object.freeze([
  ...new Set(CONTRIBUTED),
]);

export function isContentErrorCode(value: unknown): value is ContentErrorCode {
  return typeof value === 'string' && (CONTENT_ERROR_CODES as readonly string[]).includes(value);
}

export interface ContentManagementService {
  createDraft(
    request: Extract<ContentRequest, { operation: 'createDraft' }>,
  ): Promise<ContentResponse>;
  updateDraft(
    request: Extract<ContentRequest, { operation: 'updateDraft' }>,
  ): Promise<ContentResponse>;
  deleteDraft(
    request: Extract<ContentRequest, { operation: 'deleteDraft' }>,
  ): Promise<ContentResponse>;
  getDraft(request: Extract<ContentRequest, { operation: 'getDraft' }>): Promise<ContentResponse>;
  listDrafts(
    request: Extract<ContentRequest, { operation: 'listDrafts' }>,
  ): Promise<ContentResponse>;
  submitDraft(
    request: Extract<ContentRequest, { operation: 'submitDraft' }>,
  ): Promise<ContentResponse>;
  getRun(request: Extract<ContentRequest, { operation: 'getRun' }>): Promise<ContentResponse>;
  listRuns(request: Extract<ContentRequest, { operation: 'listRuns' }>): Promise<ContentResponse>;
  search(request: Extract<ContentRequest, { operation: 'search' }>): Promise<ContentResponse>;
  export(request: Extract<ContentRequest, { operation: 'export' }>): Promise<ContentResponse>;
  /**
   * One entry for all ten.
   *
   * What an HTTP handler calls once it has parsed a body: it dispatches on
   * `operation` to the method above, so the two surfaces cannot answer
   * differently.
   */
  execute(request: ContentRequest): Promise<ContentResponse>;
}

export interface ContentManagementOptions {
  readonly drafts: DraftService;
  readonly compiler: DraftCompiler;
  readonly orchestrator: Orchestrator;
  readonly history: RunHistoryService;
  readonly search: ContentSearchService;
  readonly exports: ContentExportService;
}

const traceOf = (context: ContentContext): ContentTrace =>
  Object.freeze({ requestId: context.requestId, correlationId: context.correlationId });

function frozen<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.getOwnPropertyNames(value)) {
      frozen((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

const ok = (
  operation: ContentOperation,
  context: ContentContext,
  data: ContentData,
): ContentResponse =>
  Object.freeze({ outcome: 'ok' as const, operation, trace: traceOf(context), data: frozen(data) });

const refuse = (
  operation: string,
  context: ContentContext,
  code: ContentErrorCode,
  reason: string,
  issues: readonly RequestIssue[] = [],
): ContentRefusal =>
  Object.freeze({
    outcome: 'refused' as const,
    operation,
    trace: traceOf(context),
    code,
    reason,
    issues: Object.freeze([...issues]),
  });

/** A context that survives a request too malformed to carry one. */
const EMPTY_CONTEXT_TRACE: ContentContext = {
  principal: {
    subjectId: '',
    kind: 'service',
    method: 'service-token',
    organizationId: '',
    workspaceId: '',
    roles: [],
    permissions: [],
    authenticatedAt: new Date(0),
    mfaSatisfied: false,
    sessionId: null,
  },
  organization: { organizationId: '', status: 'active' },
  workspace: { workspaceId: '', organizationId: '', status: 'active' },
  requestId: '',
  correlationId: '',
};

/**
 * A search query, pinned to the caller's tenancy.
 *
 * Filled where absent, and never overruled where present — validation already
 * refused a filter naming somebody else's workspace, so by here the two agree.
 */
function scopedQuery(
  context: ContentContext,
  query: ContentSearchQuery | undefined,
): ContentSearchQuery {
  const given = query ?? {};
  const filter: ContentSearchFilter = given.filter ?? {};

  return {
    ...(given.order === undefined ? {} : { order: given.order }),
    ...(given.limit === undefined ? {} : { limit: given.limit }),
    ...(given.cursor === undefined ? {} : { cursor: given.cursor }),
    filter: {
      ...filter,
      organizationId: context.organization.organizationId,
      workspaceId: context.workspace.workspaceId,
    },
  };
}

export function createContentManagement(
  options: ContentManagementOptions,
): ContentManagementService {
  const { drafts, compiler, orchestrator, history, search, exports } = options;

  /**
   * Run an operation, converting a thrown fault into a refusal.
   *
   * The one place the "nothing throws" promise is kept, so it cannot be
   * forgotten in nine places and remembered in one.
   */
  async function guarded(
    request: ContentRequest,
    run: () => Promise<ContentResponse>,
  ): Promise<ContentResponse> {
    // As RECEIVED: a request too malformed to carry a context still gets an
    // answer, and an answer needs somewhere to put a trace.
    const context = (request as { context?: ContentContext }).context ?? EMPTY_CONTEXT_TRACE;

    const validation = validateContentRequest(request);
    if (!validation.ok) {
      return refuse(
        request.operation,
        context,
        validation.code,
        'The request cannot be run as asked.',
        validation.issues,
      );
    }

    try {
      return await run();
    } catch (failure) {
      return refuse(
        request.operation,
        context,
        'ServiceFailed',
        failure instanceof Error ? failure.message : String(failure),
      );
    }
  }

  /** An export target, routed to the one export operation that serves it. */
  function exported(context: ContentContext, payload: ExportPayload): Promise<ExportResult> {
    const request = {
      format: payload.format,
      organizationId: context.organization.organizationId,
      workspaceId: context.workspace.workspaceId,
      ...(payload.exportSchemaVersion === undefined
        ? {}
        : { exportSchemaVersion: payload.exportSchemaVersion }),
    };

    switch (payload.target.kind) {
      case 'run':
        return exports.exportRun(payload.target.runId, request);
      case 'runs':
        return exports.exportRuns(payload.target.query ?? {}, {
          ...request,
          ...(payload.target.includeArtifacts === undefined
            ? {}
            : { includeArtifacts: payload.target.includeArtifacts }),
        });
      case 'draft':
        return exports.exportDraft(payload.target.draftId, request);
      case 'drafts':
        return exports.exportDrafts(payload.target.query ?? {}, request);
      case 'artifacts':
        return exports.exportArtifacts(payload.target.query ?? {}, request);
    }
  }

  const service: ContentManagementService = {
    createDraft: (request) =>
      guarded(request, async () => {
        const { context, payload } = request;

        // Tenancy and authorship come from the RESOLVED context. A payload that
        // could name them would be a way to create a draft somewhere else.
        const result = await drafts.create({
          metadata: {
            organizationId: context.organization.organizationId,
            workspaceId: context.workspace.workspaceId,
            principalId: context.principal.subjectId,
            principalKind: context.principal.kind,
            title: payload.title,
            tags: [...(payload.tags ?? [])],
          },
          workflowId: payload.workflowId,
          workflowVersion: payload.workflowVersion,
          inputs: payload.inputs,
          ...(payload.note === undefined ? {} : { note: payload.note }),
        });

        return result.outcome === 'ok'
          ? ok('createDraft', context, { kind: 'draft', draft: result.draft })
          : refuse('createDraft', context, result.code, result.reason, result.issues);
      }),

    updateDraft: (request) =>
      guarded(request, async () => {
        const { context, payload } = request;
        const result = await drafts.revise({
          draftId: payload.draftId,
          transition: payload.transition,
          note: payload.note,
          ...(payload.changes === undefined ? {} : { changes: payload.changes }),
          ...(payload.expectedRevision === undefined
            ? {}
            : { expectedRevision: payload.expectedRevision }),
        });

        return result.outcome === 'ok'
          ? ok('updateDraft', context, { kind: 'draft', draft: result.draft })
          : refuse('updateDraft', context, result.code, result.reason, result.issues);
      }),

    deleteDraft: (request) =>
      guarded(request, async () => {
        const { context, payload } = request;
        const result = await drafts.remove(payload.draftId);

        return result.outcome === 'ok'
          ? ok('deleteDraft', context, { kind: 'deleted', draftId: payload.draftId })
          : refuse('deleteDraft', context, result.code, result.reason, result.issues);
      }),

    getDraft: (request) =>
      guarded(request, async () => {
        const { context, payload } = request;
        const result = await drafts.load(payload.draftId);

        return result.outcome === 'ok'
          ? ok('getDraft', context, { kind: 'draft', draft: result.draft })
          : refuse('getDraft', context, result.code, result.reason, result.issues);
      }),

    listDrafts: (request) =>
      guarded(request, async () => {
        const { context, payload } = request;

        const result = await drafts.list({
          // Forced, not filtered: a caller lists its own workspace or nothing.
          organizationId: context.organization.organizationId,
          workspaceId: context.workspace.workspaceId,
          principalId: payload.principalId ?? null,
          workflowId: payload.workflowId ?? null,
          statuses: payload.statuses ?? null,
          ...(payload.limit === undefined ? {} : { limit: payload.limit }),
        });

        return result.outcome === 'ok'
          ? ok('listDrafts', context, { kind: 'drafts', drafts: result.drafts })
          : refuse('listDrafts', context, result.code, result.reason, result.issues);
      }),

    submitDraft: (request) =>
      guarded(request, async () => {
        const { context, payload } = request;

        // ── 1 · The draft ────────────────────────────────────────────────
        const loaded = await drafts.load(payload.draftId);
        if (loaded.outcome !== 'ok') {
          return refuse('submitDraft', context, loaded.code, loaded.reason, loaded.issues);
        }

        // ── 2 · Compile, BEFORE the draft is marked ──────────────────────
        // A draft that cannot compile was never submitted, and must not be left
        // recording that it was.
        const compilation = compiler.compile({
          draft: loaded.draft,
          principal: context.principal,
          organization: context.organization,
          workspace: context.workspace,
          correlationId: context.correlationId,
          idempotencyKey: payload.idempotencyKey,
          model: payload.model,
          timeoutMs: payload.timeoutMs,
          ...(payload.runTimeoutMs === undefined ? {} : { runTimeoutMs: payload.runTimeoutMs }),
          ...(payload.jobId === undefined ? {} : { jobId: payload.jobId }),
        });

        if (compilation.outcome === 'refused') {
          return refuse(
            'submitDraft',
            context,
            compilation.code,
            compilation.reason,
            compilation.issues,
          );
        }

        // ── 3 · Mark it, BEFORE it runs ──────────────────────────────────
        // The draft is the record of what was submitted, and it was — whatever
        // the orchestrator then makes of it.
        const submitted = await drafts.revise({
          draftId: payload.draftId,
          transition: 'submit',
          note: payload.note ?? 'Submitted for execution.',
          ...(payload.expectedRevision === undefined
            ? {}
            : { expectedRevision: payload.expectedRevision }),
        });

        if (submitted.outcome !== 'ok') {
          return refuse('submitDraft', context, submitted.code, submitted.reason, submitted.issues);
        }

        // ── 4 · Run it ───────────────────────────────────────────────────
        const run = await orchestrator.start(compilation.request);

        // A failed run is a SUCCESSFUL submission. See the model's header.
        return ok('submitDraft', context, { kind: 'submitted', draft: submitted.draft, run });
      }),

    getRun: (request) =>
      guarded(request, async () => {
        const { context, payload } = request;
        const result = await history.getRunById(payload.runId);

        return result.outcome === 'found'
          ? ok('getRun', context, { kind: 'run', run: result.run })
          : refuse('getRun', context, result.code, result.reason, result.issues);
      }),

    listRuns: (request) =>
      guarded(request, async () => {
        const { context, payload } = request;
        const query = payload.query ?? {};
        const filter = query.filter ?? {};

        const result = await history.listRuns({
          ...(query.order === undefined ? {} : { order: query.order }),
          ...(query.limit === undefined ? {} : { limit: query.limit }),
          ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
          filter: {
            // Forced, for the reason `listDrafts` gives. A filter naming
            // another workspace was already refused by validation.
            organizationId: context.organization.organizationId,
            workspaceId: context.workspace.workspaceId,
            ...(filter.principalId === undefined ? {} : { principalId: filter.principalId }),
            ...(filter.workflowId === undefined ? {} : { workflowId: filter.workflowId }),
            // Carried as written. History owns the run status vocabulary and
            // refuses one it does not know; checking it here would be a second
            // opinion that could disagree.
            ...(filter.statuses === undefined
              ? {}
              : { statuses: filter.statuses as readonly RunStatus[] }),
            ...(filter.createdAfter === undefined ? {} : { createdAfter: filter.createdAfter }),
            ...(filter.createdBefore === undefined ? {} : { createdBefore: filter.createdBefore }),
          },
        });

        return result.outcome === 'ok'
          ? ok('listRuns', context, { kind: 'runs', page: result.page })
          : refuse('listRuns', context, result.code, result.reason, result.issues);
      }),

    search: (request) =>
      guarded(request, async () => {
        const { context, payload } = request;
        const scoped = scopedQuery(context, payload.query);

        const result =
          payload.kind === 'runs'
            ? await search.searchRuns(scoped)
            : payload.kind === 'drafts'
              ? await search.searchDrafts(scoped)
              : await search.searchArtifacts(scoped);

        return result.outcome === 'ok'
          ? ok('search', context, { kind: 'hits', page: result.page })
          : refuse('search', context, result.code, result.reason, result.issues);
      }),

    export: (request) =>
      guarded(request, async () => {
        const { context, payload } = request;
        const result = await exported(context, payload);

        return result.outcome === 'ok'
          ? ok('export', context, { kind: 'export', export: result.export })
          : refuse('export', context, result.code, result.reason, result.issues);
      }),

    execute(request: ContentRequest): Promise<ContentResponse> {
      const asked: unknown = (request as { operation?: unknown }).operation;
      if (!isContentOperation(asked)) {
        // Refused here rather than dispatched somewhere that half works. The
        // response still names what was asked, so a caller can see its typo.
        return Promise.resolve(
          refuse(
            String(asked),
            (request as { context?: ContentContext }).context ?? EMPTY_CONTEXT_TRACE,
            'InvalidOperation',
            'The request cannot be run as asked.',
            [
              {
                field: 'operation',
                code: 'UNKNOWN_OPERATION',
                detail: `'${String(asked)}' is not an operation this platform offers.`,
              },
            ],
          ),
        );
      }

      switch (request.operation) {
        case 'createDraft':
          return service.createDraft(request);
        case 'updateDraft':
          return service.updateDraft(request);
        case 'deleteDraft':
          return service.deleteDraft(request);
        case 'getDraft':
          return service.getDraft(request);
        case 'listDrafts':
          return service.listDrafts(request);
        case 'submitDraft':
          return service.submitDraft(request);
        case 'getRun':
          return service.getRun(request);
        case 'listRuns':
          return service.listRuns(request);
        case 'search':
          return service.search(request);
        case 'export':
          return service.export(request);
      }
    },
  };

  return Object.freeze(service);
}
