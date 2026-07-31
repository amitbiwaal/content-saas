/**
 * The Content Platform's one entry point.
 *
 * ── Everything a caller may ask for, in one vocabulary ─────────────────────
 * Ten operations, one request shape, one response shape. A REST controller, an
 * SDK and an admin UI all speak this and nothing else; whether an operation is
 * served by the draft service, history, search or the orchestrator is a fact
 * about the inside, and it stays inside.
 *
 * ── Tenancy comes from the CONTEXT, never from a payload ───────────────────
 * A create payload names a title and a workflow. It does not name an
 * organization, a workspace or an author, because those are resolved facts
 * about the request and a payload is something a caller typed. Taking them from
 * the context is what stops a caller creating a draft in another workspace, or
 * attributing one to somebody else, by asking nicely.
 *
 * Where a caller DOES name one — a filter, an export envelope — it must agree
 * with the context. A disagreement is refused, never quietly overruled: the two
 * readings mean different things and guessing between them is exactly the
 * silent inference this layer exists to prevent.
 *
 * ── A failed run is a SUCCESSFUL submission ────────────────────────────────
 * `submitDraft` succeeds when the draft was compiled, marked submitted and
 * handed to the orchestrator. What the orchestrator then made of it is data on
 * the response. Conflating the two would make "the platform refused you" and
 * "the model refused you" the same answer, and they call for opposite actions.
 */

import type { Principal } from '@contentos/security';

import type { ContentDraft, RevisionChanges } from '../drafts/draft.js';
import type { DraftStatus, DraftTransition } from '../drafts/status.js';
import type { ContentExport, ContentExportFormat } from '../exports/model.js';
import type { AdmissionOrganization, AdmissionWorkspace } from '../gateway/ports.js';
import type { RunHistoryPage } from '../history/service.js';
import type { RunHistoryView } from '../history/views.js';
import type { ContentRunResult } from '../runs/run.js';
import type { ContentSearchQuery, SearchKind } from '../search/query.js';
import type { SearchPage } from '../search/service.js';

export const CONTENT_OPERATIONS = [
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
] as const;

export type ContentOperation = (typeof CONTENT_OPERATIONS)[number];

export function isContentOperation(value: unknown): value is ContentOperation {
  return typeof value === 'string' && (CONTENT_OPERATIONS as readonly string[]).includes(value);
}

/**
 * Who is asking, where, and under what trace.
 *
 * Every field is RESOLVED — the principal by authentication, the organization
 * and workspace by the directory, the ids by the edge. Nothing here is ever
 * constructed by this layer; a facade that could mint a principal would be a
 * way around authentication rather than a way into the platform.
 */
export interface ContentContext {
  readonly principal: Principal;
  readonly organization: AdmissionOrganization;
  /** The workspace IS the tenant (ADR-017). */
  readonly workspace: AdmissionWorkspace;
  /** This request. Echoed back so a caller can correlate one answer. */
  readonly requestId: string;
  /** This customer action, across every call it causes. */
  readonly correlationId: string;
}

// ── Payloads ────────────────────────────────────────────────────────────────

/** Tenancy and authorship are absent on purpose — see the file header. */
export interface CreateDraftPayload {
  readonly title: string;
  readonly tags?: readonly string[];
  readonly workflowId: string;
  /** Pinned. A draft against `latest-stable` would move under its author. */
  readonly workflowVersion: number;
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly note?: string;
}

export interface UpdateDraftPayload {
  readonly draftId: string;
  readonly transition: DraftTransition;
  readonly changes?: RevisionChanges;
  readonly note: string;
  /** The revision the caller edited. A mismatch means somebody else revised it. */
  readonly expectedRevision?: number;
}

export interface DraftIdPayload {
  readonly draftId: string;
}

export interface ListDraftsPayload {
  readonly statuses?: readonly DraftStatus[];
  readonly workflowId?: string;
  readonly principalId?: string;
  readonly limit?: number;
}

export interface SubmitDraftPayload {
  readonly draftId: string;
  /** The model the caller asks for. A draft names none; the Router decides. */
  readonly model: string;
  /** Per step. The runtime puts it on each request. */
  readonly timeoutMs: number;
  /**
   * Half of every step's key.
   *
   * Supplied, never derived from `requestId`: a retry carries a new request id
   * and the same idempotency key, which is the whole distinction between them.
   */
  readonly idempotencyKey: string;
  readonly runTimeoutMs?: number;
  readonly jobId?: string;
  readonly note?: string;
  readonly expectedRevision?: number;
}

export interface RunIdPayload {
  readonly runId: string;
}

export interface ListRunsPayload {
  readonly query?: ContentSearchQuery;
}

export interface SearchPayload {
  readonly kind: SearchKind;
  readonly query?: ContentSearchQuery;
}

/** What an export is OF. One of five, named explicitly — never inferred. */
export type ExportTarget =
  | { readonly kind: 'run'; readonly runId: string }
  | {
      readonly kind: 'runs';
      readonly query?: ContentSearchQuery;
      readonly includeArtifacts?: boolean;
    }
  | { readonly kind: 'draft'; readonly draftId: string }
  | { readonly kind: 'drafts'; readonly query?: ContentSearchQuery }
  | { readonly kind: 'artifacts'; readonly query?: ContentSearchQuery };

export interface ExportPayload {
  readonly target: ExportTarget;
  readonly format: ContentExportFormat;
  readonly exportSchemaVersion?: number;
}

// ── Requests ────────────────────────────────────────────────────────────────

interface Envelope<O extends ContentOperation, P> {
  readonly operation: O;
  readonly context: ContentContext;
  readonly payload: P;
}

/**
 * One request, whatever is being asked.
 *
 * A discriminated union rather than ten entry types: one HTTP handler can
 * accept all of it, and a caller narrows on `operation` instead of choosing a
 * function name before it has parsed the body.
 */
export type ContentRequest =
  | Envelope<'createDraft', CreateDraftPayload>
  | Envelope<'updateDraft', UpdateDraftPayload>
  | Envelope<'deleteDraft', DraftIdPayload>
  | Envelope<'getDraft', DraftIdPayload>
  | Envelope<'listDrafts', ListDraftsPayload>
  | Envelope<'submitDraft', SubmitDraftPayload>
  | Envelope<'getRun', RunIdPayload>
  | Envelope<'listRuns', ListRunsPayload>
  | Envelope<'search', SearchPayload>
  | Envelope<'export', ExportPayload>;

// ── Responses ───────────────────────────────────────────────────────────────

/** What came back. Narrowed by `kind`, never by which field is populated. */
export type ContentData =
  | { readonly kind: 'draft'; readonly draft: ContentDraft }
  | { readonly kind: 'drafts'; readonly drafts: readonly ContentDraft[] }
  | { readonly kind: 'deleted'; readonly draftId: string }
  | {
      readonly kind: 'submitted';
      /** The draft, now recording that it was submitted. */
      readonly draft: ContentDraft;
      /** What the orchestrator made of it. A failure here is still a success. */
      readonly run: ContentRunResult;
    }
  | { readonly kind: 'run'; readonly run: RunHistoryView }
  | { readonly kind: 'runs'; readonly page: RunHistoryPage }
  | { readonly kind: 'hits'; readonly page: SearchPage }
  | { readonly kind: 'export'; readonly export: ContentExport };

/**
 * The trace a caller gets back.
 *
 * The two ids and nothing else. Returning the principal would be sending a
 * caller its own authority back down the wire, which is at best noise and at
 * worst something a client starts to trust.
 */
export interface ContentTrace {
  readonly requestId: string;
  readonly correlationId: string;
}

export interface ContentSuccess {
  readonly outcome: 'ok';
  readonly operation: ContentOperation;
  readonly trace: ContentTrace;
  readonly data: ContentData;
}

export interface ContentRefusal {
  readonly outcome: 'refused';
  /**
   * What was ASKED for.
   *
   * A string rather than a `ContentOperation`, because a refusal can name one
   * that does not exist — which is the whole of what `InvalidOperation` says.
   */
  readonly operation: string;
  readonly trace: ContentTrace;
  readonly code: string;
  /** For operators. Never returned to a caller — see `ai/http.ts`. */
  readonly reason: string;
  readonly issues: readonly {
    readonly field: string;
    readonly code: string;
    readonly detail: string;
  }[];
}

export type ContentResponse = ContentSuccess | ContentRefusal;
