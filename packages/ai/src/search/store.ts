/**
 * The search port — two queries the existing contracts do not have.
 *
 * ── Why it extends both frozen contracts ───────────────────────────────────
 * `ContentRunHistoryStore` (S4.5) already answers "which runs match?" and is
 * itself a `ContentRunRepository` (S4.4). `DraftRepository` (S4.6) addresses
 * drafts by id and lists them, but without a keyset position. Search needs
 * both of those, plus two things neither has: a keyset query over drafts, and
 * one over artifacts across runs.
 *
 * Extending is the same move S4.5 made for the same reason. A store that can
 * answer search queries declares that it can; nothing frozen changes; and a
 * composition root implements ONE thing rather than three that must agree
 * about the same rows.
 *
 * The alternative — loading every run and every draft to filter in memory — is
 * the duplicate query logic this increment forbids, and it stops working at the
 * first thousand records.
 *
 * ── Still no database ──────────────────────────────────────────────────────
 * Interfaces. No driver, no SQL, no connection. Whether `queryArtifacts`
 * becomes a join, an index scan or a map lookup is decided entirely outside
 * this package.
 *
 * ── Explicit nulls, not optionals ──────────────────────────────────────────
 * An implementer sees every dimension it must handle, including the ones that
 * are off. A filter an implementation quietly ignores is a tenancy leak wearing
 * the shape of a successful response.
 */

import type { DraftRepository } from '../drafts/repository.js';
import type { DraftStatus } from '../drafts/status.js';
import type { ContentDraft } from '../drafts/draft.js';
import type { ContentRunHistoryStore } from '../history/store.js';
import type { RunHistoryOrder } from '../history/query.js';
import type { RunStatus } from '../runs/state.js';
import type { StoredArtifact } from '../runs/stored.js';

/** Where a draft page continues from. Ordered by (updatedAt, draftId). */
export interface DraftSearchPosition {
  /** A draft's ordering key is when it last changed, not when it began. */
  readonly updatedAt: string;
  readonly draftId: string;
}

export interface DraftSearchCriteria {
  readonly organizationId: string | null;
  /** The workspace IS the tenant (ADR-017). */
  readonly workspaceId: string | null;
  readonly principalId: string | null;
  readonly workflowId: string | null;
  readonly draftId: string | null;
  /** Match any. Null means every status. Never an empty array. */
  readonly statuses: readonly DraftStatus[] | null;
  /** ALL of these must be present. Narrowing, never widening. */
  readonly tags: readonly string[] | null;
  /** Inclusive, against the draft's `createdAt`. */
  readonly createdAfter: string | null;
  /** Exclusive, so adjacent windows never count one draft twice. */
  readonly createdBefore: string | null;
  readonly after: DraftSearchPosition | null;
  readonly order: RunHistoryOrder;
  /** The service asks for one more than the page it means to return. */
  readonly limit: number;
}

export interface DraftSearchSlice {
  readonly drafts: readonly ContentDraft[];
}

/**
 * Where an artifact page continues from.
 *
 * Three parts, because an artifact's place in the world is its run's place plus
 * its own step: (run createdAt, runId, sequence). `sequence` is what makes the
 * order total inside one run.
 */
export interface ArtifactSearchPosition {
  /** The RUN's clock. Artifacts are ordered by the run they belong to. */
  readonly createdAt: string;
  readonly runId: string;
  readonly sequence: number;
}

/**
 * What an artifact search narrows by.
 *
 * Every dimension is a property of the artifact's RUN, because that is where
 * tenancy, workflow and status live. An artifact has none of its own.
 */
export interface ArtifactSearchCriteria {
  readonly organizationId: string | null;
  readonly workspaceId: string | null;
  readonly principalId: string | null;
  readonly workflowId: string | null;
  readonly runId: string | null;
  readonly statuses: readonly RunStatus[] | null;
  readonly createdAfter: string | null;
  readonly createdBefore: string | null;
  readonly after: ArtifactSearchPosition | null;
  readonly order: RunHistoryOrder;
  readonly limit: number;
}

export interface ArtifactSearchSlice {
  readonly artifacts: readonly StoredArtifact[];
  /**
   * The run each artifact came from, by id.
   *
   * Carried because an artifact record does not hold its run's clock, and the
   * page has to be ordered by it. A store that has just selected these rows
   * already knows; making the service load every run again to find out would
   * be a second query for something already in hand.
   */
  readonly runCreatedAt: Readonly<Record<string, string>>;
}

export interface ContentSearchStore extends ContentRunHistoryStore, DraftRepository {
  queryDrafts(criteria: DraftSearchCriteria): Promise<DraftSearchSlice>;
  queryArtifacts(criteria: ArtifactSearchCriteria): Promise<ArtifactSearchSlice>;
}
