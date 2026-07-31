/**
 * The read port — one method the write contract does not have.
 *
 * ── Why this extends `ContentRunRepository` rather than replacing it ───────
 * The S4.4 repository is frozen and addresses runs BY ID: `saveRun`,
 * `loadRun`, `loadArtifacts`, `updateStatus`. History needs all of those and
 * one thing more — the ability to ask for a SET of runs by criteria — and there
 * are only three ways to get it:
 *
 *   1. Add a method to the frozen interface. Every implementation of a frozen
 *      contract breaks, which is what freezing it was meant to prevent.
 *   2. Load every run and filter in memory. That is a query engine in the
 *      application layer — precisely the duplicate persistence logic this
 *      increment forbids — and it stops working at the first thousand runs.
 *   3. Extend the contract. An implementation of this IS a
 *      `ContentRunRepository`, so nothing frozen changes and nothing is
 *      duplicated; a store that can answer queries simply declares that it can.
 *
 * The third is the only one that keeps both promises.
 *
 * ── Still no database ──────────────────────────────────────────────────────
 * An interface. No driver, no SQL, no connection — the same as S4.4, and
 * checked the same way. Whether `queryRuns` becomes an indexed scan, a keyset
 * SELECT or a map lookup is a decision made entirely outside this package.
 *
 * ── The criteria are explicit nulls, not optionals ─────────────────────────
 * An implementer reading this sees every dimension it must handle, including
 * the ones that are off. An optional field invites "I did not see that one", and
 * a filter an implementation quietly ignores is the tenancy leak this layer
 * exists to make impossible.
 */

import type { ContentRunRepository } from '../runs/repository.js';
import type { RunStatus } from '../runs/state.js';
import type { StoredContentRun } from '../runs/stored.js';
import type { RunHistoryOrder } from './query.js';

/** The keyset position a page continues from. Null on the first page. */
export interface StoredRunPosition {
  /** The run's own clock. */
  readonly createdAt: string;
  /** The tiebreak that makes the position exact. */
  readonly runId: string;
}

/**
 * What the store is asked for.
 *
 * Ordering is by (createdAt, runId) — total, because `runId` is unique — and
 * `after` is STRICT: the run it names has already been read.
 */
export interface StoredRunCriteria {
  readonly organizationId: string | null;
  readonly workspaceId: string | null;
  readonly principalId: string | null;
  readonly workflowId: string | null;
  /** Match any. Null means every status. Never an empty array. */
  readonly statuses: readonly RunStatus[] | null;
  /** Inclusive. */
  readonly createdAfter: string | null;
  /** Exclusive, so adjacent windows never count one run twice. */
  readonly createdBefore: string | null;
  readonly after: StoredRunPosition | null;
  readonly order: RunHistoryOrder;
  /**
   * At most this many.
   *
   * The service asks for one more than the page it intends to return, which is
   * how it learns there is a next page without a second query or a count.
   */
  readonly limit: number;
}

export interface StoredRunSlice {
  /** In (createdAt, runId) order. The service re-sorts anyway — see below. */
  readonly runs: readonly StoredContentRun[];
}

export interface ContentRunHistoryStore extends ContentRunRepository {
  queryRuns(criteria: StoredRunCriteria): Promise<StoredRunSlice>;
}
