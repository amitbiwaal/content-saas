/**
 * The draft persistence port — interfaces, and nothing else.
 *
 * ── The same shape S4.4 established ────────────────────────────────────────
 * No implementation, no driver, no SQL, no clock. A composition root supplies
 * the store; nothing in `packages/ai` can observe what it is. `updateDraft`
 * takes the timestamp its caller already stamped onto the revision, for the
 * same reason `updateStatus` does: a repository that read a clock would make
 * two writes of one fact differ.
 *
 * ── `updateDraft` carries the revision it was built on ─────────────────────
 * Collaboration is out of scope, and a lost update is not a collaboration
 * feature — it is data loss. Two people editing one draft with last-write-wins
 * lose one person's work silently, and `expectedRevision` costs a field to make
 * that a refusal instead. Whether an implementation enforces it with a
 * conditional write or a transaction is its own business.
 *
 * ── `deleteDraft` is a hard delete, and the SERVICE decides who may ────────
 * The port removes what it is told to remove. Whether a submitted draft may be
 * removed at all is a policy question, and policy lives with the service that
 * knows the lifecycle — not in the contract every store has to implement.
 */

import type { ContentDraft } from './draft.js';
import type { DraftStatus } from './status.js';

export interface UpdateDraftInput {
  /** The whole draft, with the new revision already appended. */
  readonly draft: ContentDraft;
  /**
   * The revision this update was built on.
   *
   * A store whose current revision differs must refuse: somebody else revised
   * the draft in between, and writing over them loses their edit.
   */
  readonly expectedRevision: number;
}

/**
 * What to narrow a listing by.
 *
 * Explicit nulls rather than optionals, the same discipline the history
 * criteria use: an implementer sees every dimension it must handle, including
 * the ones that are off. A filter an implementation quietly ignores is a
 * tenancy leak wearing the shape of a successful response.
 */
export interface DraftListCriteria {
  readonly organizationId: string | null;
  /** The workspace IS the tenant (ADR-017). */
  readonly workspaceId: string | null;
  readonly principalId: string | null;
  readonly workflowId: string | null;
  /** Match any. Null means every status. Never an empty array. */
  readonly statuses: readonly DraftStatus[] | null;
  /** At most this many. Bounded by the service, never unbounded here. */
  readonly limit: number;
}

export interface DraftListSlice {
  /** Newest updated first. The service re-sorts, so order here is a courtesy. */
  readonly drafts: readonly ContentDraft[];
}

export interface DraftRepository {
  /**
   * Store a new draft.
   *
   * Refuses a draft id that already exists: a create that silently overwrote
   * would destroy every revision the first draft had.
   */
  saveDraft(draft: ContentDraft): Promise<void>;

  /**
   * The draft, or null when there is none.
   *
   * Null rather than a throw, for the reason `loadRun` gives: "no such draft"
   * is an answer a caller acts on, and the service turns it into a refusal with
   * a code.
   */
  loadDraft(draftId: string): Promise<ContentDraft | null>;

  /** Append a revision. See `UpdateDraftInput` for the concurrency contract. */
  updateDraft(input: UpdateDraftInput): Promise<void>;

  deleteDraft(draftId: string): Promise<void>;

  listDrafts(criteria: DraftListCriteria): Promise<DraftListSlice>;
}
