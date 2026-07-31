/**
 * What a search hands back.
 *
 * ── The projections are the read models that already exist ─────────────────
 * A run hit IS S4.5's `RunHistoryView`, and an artifact hit IS its
 * `ArtifactHistoryView`. Both already exclude persistence-only fields by
 * TYPE — `Omit<…, keyof StoredRecord>` — so search inherits that guarantee
 * rather than restating it, and a field added to a stored record later stays
 * excluded from both without anyone remembering.
 *
 * Only a draft needed a projection of its own, because nothing had one yet.
 *
 * ── A draft hit carries no inputs ──────────────────────────────────────────
 * Deliberately. A listing that returned everything anybody had typed, across a
 * workspace, is a disclosure decision nobody asked search to make — and a list
 * view does not need it. Load the draft to read what is in it.
 *
 * It also carries no revision HISTORY, only how many there are and which is
 * current. A search result is a pointer, not a copy.
 *
 * ── A hit says what it is ──────────────────────────────────────────────────
 * A discriminated union rather than three parallel result types: one page can
 * be rendered by one loop, and a caller narrows on `kind` instead of guessing
 * from which field happens to be present.
 */

import type { AICapability } from '@contentos/contracts';

import { draftStatus, latestRevision, type ContentDraft } from '../drafts/draft.js';
import type { DraftStatus } from '../drafts/status.js';
import type { ArtifactHistoryView, RunHistoryView } from '../history/views.js';
import type { StoredPromptReference } from '../runs/stored.js';

/**
 * One draft, as a search result sees it.
 *
 * Flat, and a summary: identity, provenance and where it is in its lifecycle.
 */
export interface DraftSearchView {
  readonly draftId: string;
  readonly title: string;
  readonly tags: readonly string[];
  readonly status: DraftStatus;
  /** The current revision number. */
  readonly revision: number;
  /** How many there have been. A count, never the history itself. */
  readonly revisions: number;
  readonly organizationId: string;
  /** The workspace IS the tenant (ADR-017). */
  readonly workspaceId: string;
  /** Who made it. Identity; a draft holds no authority of any kind. */
  readonly principalId: string;
  readonly principalKind: string;
  readonly workflowId: string;
  readonly workflowVersion: number;
  /** `'article.draft@2'`. */
  readonly workflowRef: string;
  readonly capability: AICapability;
  /** The prompts this draft pinned when it was created. */
  readonly templateReferences: readonly StoredPromptReference[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * One result.
 *
 * `kind` is singular where the query's is plural — a page of a `runs` search
 * holds `run` hits — because one of them is a request and the other is a thing.
 */
export type SearchHit =
  | { readonly kind: 'run'; readonly run: RunHistoryView }
  | { readonly kind: 'draft'; readonly draft: DraftSearchView }
  | { readonly kind: 'artifact'; readonly artifact: ArtifactHistoryView };

function frozen<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.getOwnPropertyNames(value)) {
      frozen((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

export function toDraftSearchView(draft: ContentDraft): DraftSearchView {
  const current = latestRevision(draft);

  return frozen({
    draftId: draft.draftId,
    title: current.title,
    tags: [...draft.metadata.tags],
    status: draftStatus(draft),
    revision: current.revision,
    revisions: draft.revisions.length,
    organizationId: draft.metadata.organizationId,
    workspaceId: draft.metadata.workspaceId,
    principalId: draft.metadata.principalId,
    principalKind: draft.metadata.principalKind,
    workflowId: draft.workflowId,
    workflowVersion: draft.workflowVersion,
    workflowRef: draft.workflowRef,
    capability: draft.capability,
    templateReferences: draft.templateReferences.map((reference) => ({ ...reference })),
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
  });
}

export const runHit = (run: RunHistoryView): SearchHit =>
  Object.freeze({ kind: 'run' as const, run });

export const draftHit = (draft: ContentDraft): SearchHit =>
  Object.freeze({ kind: 'draft' as const, draft: toDraftSearchView(draft) });

export const artifactHit = (artifact: ArtifactHistoryView): SearchHit =>
  Object.freeze({ kind: 'artifact' as const, artifact });

/**
 * Fields a draft carries that a search result deliberately does not.
 *
 * A value, so the claim is one a test can check against a real projection
 * rather than against a type.
 */
export const WITHHELD_DRAFT_FIELDS: readonly string[] = Object.freeze(['inputs', 'note']);
