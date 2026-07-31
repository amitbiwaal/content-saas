/**
 * The content run — what a request becomes, and what it produces.
 *
 * ── A run is a RECORD, not a process ───────────────────────────────────────
 * Every value here is frozen. The orchestrator produces a new run at each
 * transition rather than mutating one, so a failure report and the run that
 * failed cannot disagree, and a caller holding a run from halfway through still
 * holds exactly what was true then.
 *
 * ── Artifacts are returned, never stored ───────────────────────────────────
 * The increment is explicit, and so is the shape: there is no writer, no
 * repository and no persistence port anywhere in this module. A run's output
 * exists in the result the caller receives and nowhere else.
 *
 * ── Provenance is carried, not reconstructed ───────────────────────────────
 * `promptVersion`, `workflowVersion`, provider and model all travel on the
 * artifact. `prompt-engine.md` calls `promptVersion` the reproducibility
 * anchor; an artifact without it is output nobody can explain three weeks
 * later, which is the failure the whole versioning apparatus exists to prevent.
 */

import type { AICapability, TokenUsage, Usage } from '@contentos/contracts';
import type { Principal } from '@contentos/security';

import type { AdmissionOrganization, AdmissionWorkspace } from '../gateway/ports.js';
import type { RunStatus } from './state.js';

/** Who asked, where, and under what identity. Resolved, never claimed. */
export interface RunMetadata {
  readonly principal: Principal;
  readonly organization: AdmissionOrganization;
  readonly workspace: AdmissionWorkspace;
  readonly correlationId: string;
  /**
   * Half of every step's idempotency key, the other half being the step id.
   *
   * Supplied rather than generated — generation is not pure, and two
   * orchestrations of one request must address the same work.
   */
  readonly idempotencyKey: string;
}

/** When each stage happened. Supplied by an injected clock, never read here. */
export interface RunTimings {
  readonly createdAt: string;
  readonly compiledAt: string | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
}

/**
 * What one step produced.
 *
 * The provider and model are the ones that ACTUALLY ran, taken from the
 * response rather than from the plan: a router may name one thing and an
 * adapter report another, and the artifact records what happened.
 */
export interface ContentArtifact {
  readonly stepId: string;
  /** `'planning.outline@7'` — resolves to the exact prompt, permanently. */
  readonly promptVersion: string;
  readonly providerId: string;
  readonly model: string;
  readonly capability: AICapability;
  /** The generated text. Plain, normalized, with no vendor wrappers. */
  readonly content: string;
  readonly finishReason: string;
  readonly usage: Usage;
  readonly tokens: TokenUsage;
  /** How many dispatches this step took. 1 unless something was retried. */
  readonly attempts: number;
  /** Vendor frame detail, carried and never interpreted. */
  readonly metadata: Readonly<Record<string, unknown>>;
}

/** Where a run is, and everything it has produced so far. */
export interface ContentRunState {
  readonly status: RunStatus;
  /** Ascending, one per completed step. */
  readonly artifacts: readonly ContentArtifact[];
  /** Set once the blueprint compiled. Null before that. */
  readonly executionId: string | null;
  readonly timings: RunTimings;
}

/**
 * One content run.
 *
 * `templateVersions` is the resolved set, recorded at compile time: a run
 * pinned its prompts when it started, so a promotion mid-flight cannot change
 * what it was doing (`prompt-engine.md` — "workflows pin at run start").
 */
export interface ContentRun {
  readonly runId: string;
  readonly workflowId: string;
  /** The monotonic identity the runtime records as `definitionVersion`. */
  readonly workflowVersion: number;
  /** `'article.draft@2'`. */
  readonly workflowRef: string;
  /** `['planning.outline@7', 'writing.draft@3']`, in step order. */
  readonly templateVersions: readonly string[];
  readonly capability: AICapability;
  readonly metadata: RunMetadata;
  readonly state: ContentRunState;
}

export const RUN_FAILURE_CODES = [
  'WorkflowUnresolved',
  'TemplateUnresolved',
  'CompilationFailed',
  'RuntimeFailed',
  'ExecutionFailed',
  'StreamingUnsupported',
  'Cancelled',
  'Timeout',
  /**
   * The run happened and was not stored.
   *
   * Both halves are true, and both matter: the artifacts are on the result and
   * are usable, and persistence is the source of truth, so a run missing from
   * it is a run nobody will find again. Reporting success would tell a caller
   * there is a durable record when there is not.
   */
  'PersistenceFailed',
] as const;

export type RunFailureCode = (typeof RUN_FAILURE_CODES)[number];

export function isRunFailureCode(value: unknown): value is RunFailureCode {
  return typeof value === 'string' && (RUN_FAILURE_CODES as readonly string[]).includes(value);
}

/**
 * The outcome.
 *
 * A refusal is a value, for the same reason admission's and routing's are: a
 * caller that must catch to discover it will eventually forget, and a run that
 * failed to compile is not an exceptional condition — it is an answer.
 *
 * A FAILED run still carries its artifacts. Work that completed before a later
 * step failed was paid for and is often usable, and discarding it because the
 * run did not finish is throwing away something the customer was charged for.
 */
export type ContentRunResult =
  | { readonly outcome: 'completed'; readonly run: ContentRun }
  | {
      readonly outcome: 'failed';
      readonly run: ContentRun;
      readonly code: RunFailureCode;
      /**
       * For operators. Never returned to a caller by the REST layer, which
       * derives its message from a code (`ai/http.ts`).
       */
      readonly reason: string;
      /**
       * The underlying provider code, where a provider failed.
       *
       * The canonical taxonomy's, not a new one — S2.2 froze it and the retry
       * engine and the REST layer already branch on it.
       */
      readonly providerCode: string | null;
    };

export function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.getOwnPropertyNames(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

/** A run, advanced to a new state. The previous one is untouched and valid. */
export function withState(run: ContentRun, state: Partial<ContentRunState>): ContentRun {
  return deepFreeze({ ...run, state: { ...run.state, ...state } });
}

/** Total tokens across every artifact. The number a caller usually wants. */
export function totalTokens(run: ContentRun): TokenUsage {
  return run.state.artifacts.reduce<TokenUsage>(
    (total, artifact) => ({
      promptTokens: total.promptTokens + artifact.tokens.promptTokens,
      completionTokens: total.completionTokens + artifact.tokens.completionTokens,
      totalTokens: total.totalTokens + artifact.tokens.totalTokens,
    }),
    { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  );
}
