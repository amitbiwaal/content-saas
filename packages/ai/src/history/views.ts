/**
 * The read model — what history hands out.
 *
 * ── Persistence metadata never crosses this line ───────────────────────────
 * `schemaVersion`, and the record's own `createdAt`/`updatedAt`, are facts
 * about a ROW: which build wrote it and when it was last touched. A dashboard
 * that showed them would be showing storage internals, and a client that
 * branched on `schemaVersion` would make an internal migration a breaking API
 * change.
 *
 * The exclusion is a TYPE, not a habit: both views are `Omit<..., keyof
 * StoredRecord>`, so a field added to `StoredRecord` later is excluded
 * automatically rather than leaking until somebody notices.
 *
 * ── Everything else survives ───────────────────────────────────────────────
 * Workflow version, template versions, provider, model, usage, timings and the
 * artifact's carried metadata all come through unchanged. They are what a run
 * detail view, an audit view and a cost report are made of, and a read model
 * that dropped any of them would send every consumer back to the store.
 *
 * ── The failure REASON does not ────────────────────────────────────────────
 * A stored failure carries an operator-facing sentence. The canonical error
 * contract is emphatic that a caller branches on a CODE and never reads
 * internal prose, so the view carries `code` and `providerCode` and stops. The
 * reason stays in the store, where an operator can still read it.
 */

import type { AICapability } from '@contentos/contracts';

import type { RunStatus } from '../runs/state.js';
import type {
  StoredArtifact,
  StoredContentRun,
  StoredPromptReference,
  StoredRecord,
  StoredTimings,
} from '../runs/stored.js';

/**
 * One artifact, as a reader sees it.
 *
 * Derived by subtraction rather than restated, so the two can never drift and
 * the exclusion cannot be forgotten. `StoredPromptReference` and `StoredUsage`
 * come through as they are — both are pure domain, and a second identical
 * shape would be one more thing to keep in step.
 */
export type ArtifactHistoryView = Omit<StoredArtifact, keyof StoredRecord>;

/** Why a run did not complete. Codes only — see the file header. */
export interface RunFailureView {
  readonly code: string;
  readonly providerCode: string | null;
}

/**
 * One run, as a reader sees it.
 *
 * Flat rather than nested under `execution`: a list view reads
 * `run.workflowId`, and a shape that made every consumer reach through a
 * storage-shaped envelope would be exporting the storage shape.
 */
export interface RunHistoryView {
  readonly runId: string;
  readonly status: RunStatus;
  readonly workflowId: string;
  readonly workflowVersion: number;
  /** `'article.draft@2'`. */
  readonly workflowRef: string;
  readonly capability: AICapability;
  /** In step order, as the run pinned them at compile time. */
  readonly templateVersions: readonly StoredPromptReference[];
  readonly executionId: string | null;
  readonly organizationId: string;
  /** The workspace IS the tenant (ADR-017). */
  readonly workspaceId: string;
  /** Who ran it. Identity; history holds no authority of any kind. */
  readonly principalId: string;
  readonly principalKind: string;
  readonly correlationId: string;
  /** The run's own clock, never the record's. */
  readonly timings: StoredTimings;
  readonly failure: RunFailureView | null;
  /** How many artifacts it produced, so a list view need not load them. */
  readonly artifactCount: number;
}

/** Totals across a run's artifacts. Derived on demand, never stored. */
export interface RunUsageSummary {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  readonly artifacts: number;
  /** True when any artifact's counts were computed rather than reported. */
  readonly tokensEstimated: boolean;
}

function frozen<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.getOwnPropertyNames(value)) {
      frozen((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

export function toRunHistoryView(stored: StoredContentRun): RunHistoryView {
  const { execution } = stored;

  return frozen({
    runId: stored.runId,
    status: stored.status,
    workflowId: execution.workflowId,
    workflowVersion: execution.workflowVersion,
    workflowRef: execution.workflowRef,
    capability: execution.capability,
    templateVersions: stored.templateVersions.map((reference) => ({ ...reference })),
    executionId: execution.executionId,
    organizationId: execution.organizationId,
    workspaceId: execution.workspaceId,
    principalId: execution.principalId,
    principalKind: execution.principalKind,
    correlationId: execution.correlationId,
    timings: { ...execution.timings },
    failure:
      stored.failure === null
        ? null
        : { code: stored.failure.code, providerCode: stored.failure.providerCode },
    artifactCount: stored.artifactCount,
  });
}

export function toArtifactHistoryView(stored: StoredArtifact): ArtifactHistoryView {
  // Named explicitly rather than spread-and-delete: a spread would carry a
  // field added to `StoredArtifact` later into the view without anyone
  // deciding that it belongs there.
  return frozen({
    runId: stored.runId,
    stepId: stored.stepId,
    sequence: stored.sequence,
    prompt: { ...stored.prompt },
    providerId: stored.providerId,
    model: stored.model,
    capability: stored.capability,
    content: stored.content,
    finishReason: stored.finishReason,
    usage: { ...stored.usage },
    attempts: stored.attempts,
    metadata: { ...stored.metadata },
  });
}

/** What a run cost, added up. The number a detail view usually wants. */
export function summariseUsage(artifacts: readonly ArtifactHistoryView[]): RunUsageSummary {
  return Object.freeze(
    artifacts.reduce<RunUsageSummary>(
      (total, artifact) => ({
        promptTokens: total.promptTokens + artifact.usage.promptTokens,
        completionTokens: total.completionTokens + artifact.usage.completionTokens,
        totalTokens: total.totalTokens + artifact.usage.totalTokens,
        artifacts: total.artifacts + 1,
        // One estimated artifact makes the whole total an estimate; reporting
        // it as measured is how a reconciliation gap becomes invisible.
        tokensEstimated: total.tokensEstimated || artifact.usage.tokensEstimated,
      }),
      {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        artifacts: 0,
        tokensEstimated: false,
      },
    ),
  );
}

/**
 * The stored fields a view must never carry, as a value.
 *
 * `keyof StoredRecord` is a compile-time guarantee that a cast erases. This is
 * the same list at runtime, so the claim is one a test can check against a real
 * view rather than against a type.
 */
export const PERSISTENCE_ONLY_FIELDS: readonly string[] = Object.freeze([
  'schemaVersion',
  'createdAt',
  'updatedAt',
]);
