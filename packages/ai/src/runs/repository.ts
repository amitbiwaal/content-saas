/**
 * The persistence port — interfaces, and nothing else.
 *
 * ── Why there is no implementation here ────────────────────────────────────
 * This increment defines the shape of the contract, not a store. A composition
 * root supplies the implementation; whether that is PostgreSQL, an object
 * store, or a test double is a decision this package must never be able to
 * observe. Nothing in `packages/ai` imports a driver, and the boundary check
 * enforces it rather than trusting it.
 *
 * ── Everything is supplied, including the clock ────────────────────────────
 * `updateStatus` takes the timestamp it should write. A repository that read a
 * clock would make two writes of the same fact differ, and a caller could never
 * reproduce a record. The same reason the orchestrator has no clock.
 *
 * ── A run and its artifacts are saved TOGETHER ─────────────────────────────
 * One call, both halves. Saving them separately would allow a run whose
 * artifacts never arrived — a record that says work happened and cannot show
 * it — and no reader could tell that from a run that genuinely produced
 * nothing. Whether the implementation uses one transaction or two writes is its
 * business; that it either stores both or neither is the contract's.
 */

import type { RunStatus } from './state.js';
import type { StoredArtifact, StoredContentRun } from './stored.js';

export interface SaveRunInput {
  readonly run: StoredContentRun;
  /** In `sequence` order. `run.artifactCount` must agree. */
  readonly artifacts: readonly StoredArtifact[];
}

export interface UpdateStatusInput {
  readonly runId: string;
  readonly status: RunStatus;
  /** Supplied, never read from a clock here. */
  readonly updatedAt: string;
}

export interface ContentRunRepository {
  /**
   * Store a settled run and everything it produced.
   *
   * Idempotent on `runId`: the orchestrator may be re-driven for a request that
   * already ran, and a second save of the same run must not produce a second
   * record. What that costs an implementation is its own concern.
   */
  saveRun(input: SaveRunInput): Promise<void>;

  /**
   * The run, or null when there is none.
   *
   * Null rather than a throw, because "no such run" is an answer a caller acts
   * on — `loadContentRun` turns it into a refusal with a code. An exception
   * here would make the ordinary case the exceptional one.
   */
  loadRun(runId: string): Promise<StoredContentRun | null>;

  /** Its artifacts, in `sequence` order. Empty for a run that produced none. */
  loadArtifacts(runId: string): Promise<readonly StoredArtifact[]>;

  /**
   * Move a stored run to a new status.
   *
   * Separate from `saveRun` because a status change is not a rewrite: it
   * touches one column and must not be able to alter an artifact. A caller that
   * had to re-save the whole run to mark it cancelled could silently change
   * what it says.
   */
  updateStatus(input: UpdateStatusInput): Promise<void>;
}
