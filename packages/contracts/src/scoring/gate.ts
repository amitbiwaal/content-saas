/**
 * Gate contract — `01-system-architecture/14-scoring-contract.md` §6.
 *
 * This module defines the interface and the composition rule. It defines **no
 * threshold**: thresholds are workspace policy, resolved by
 * `04-platform/settings.md` and snapshotted at run start (ADR-024).
 */

import type { Score, ScoreCategory, ScoreSubject, ScoreVerdict, Verdict } from './score.js';

/** Opaque to the contract; supplied by settings and echoed into the result. */
export interface ThresholdSnapshot {
  readonly snapshotId: string;
  readonly resolvedAt: string;
}

export interface GatePolicy {
  /** The gate cannot conclude without these. */
  readonly mandatoryCategories: readonly ScoreCategory[];
  readonly ymyl: boolean;
}

export interface GateEvaluationRequest {
  readonly subject: ScoreSubject;
  /** All current scores for the subject. */
  readonly scores: readonly Score[];
  readonly thresholdSnapshot: ThresholdSnapshot;
  readonly policy: GatePolicy;
}

export interface GateReason {
  /** Reason-code registry key. */
  readonly code: string;
  readonly category: ScoreCategory | null;
  readonly severity: 'warning' | 'critical';
}

export interface ContributingScore {
  readonly scoreId: string;
  readonly category: ScoreCategory;
  readonly verdict: ScoreVerdict;
}

export interface GateEvaluationResult {
  readonly verdict: Verdict;
  readonly reasons: readonly GateReason[];
  readonly contributingScores: readonly ContributingScore[];
  /** Echoed, so the decision remains reproducible after policy changes. */
  readonly thresholdSnapshot: ThresholdSnapshot;
  readonly evaluatedAt: string;
}

/** Emitted when a mandatory category has no current score. */
export const REASON_MANDATORY_CATEGORY_MISSING = 'gate.mandatory_category_missing';

/**
 * Compose a gate verdict from scores.
 *
 * Binding rules (scoring-contract.md §6):
 *  1. The gate consumes scores; it never computes them.
 *  2. Composition is **monotonic in severity**: any `block` among mandatory
 *     categories yields `block`; otherwise any `soft-warn` yields `soft-warn`;
 *     otherwise `pass`. The thresholds that make an individual score `block`
 *     are policy; this composition rule is contract.
 *  3. A missing mandatory category **cannot pass** — an analyzer failure means
 *     the gate cannot conclude, and inconclusive is not permission
 *     (`02-domain-design/articles.md` rule 19).
 *  4. `not_applicable` is excluded from composition, never treated as `pass`
 *     and never as a zero.
 *
 * Pure and deterministic: no I/O, no clock read. `evaluatedAt` is supplied by
 * the caller from the injected Clock so the result is reproducible in tests.
 */
export function composeGateVerdict(
  request: GateEvaluationRequest,
  evaluatedAt: string,
): GateEvaluationResult {
  const { scores, policy, thresholdSnapshot } = request;

  const current = scores.filter((s) => s.status === 'current');
  const byCategory = new Map<ScoreCategory, Score>();
  for (const score of current) {
    byCategory.set(score.category, score);
  }

  const contributingScores: ContributingScore[] = current.map((s) => ({
    scoreId: s.id,
    category: s.category,
    verdict: s.verdict,
  }));

  const reasons: GateReason[] = [];

  // Rule 3 — a missing mandatory category cannot pass.
  const missing = policy.mandatoryCategories.filter((c) => !byCategory.has(c));
  for (const category of missing) {
    reasons.push({
      code: REASON_MANDATORY_CATEGORY_MISSING,
      category,
      severity: 'critical',
    });
  }
  if (missing.length > 0) {
    return {
      verdict: 'block',
      reasons,
      contributingScores,
      thresholdSnapshot,
      evaluatedAt,
    };
  }

  // Rule 2 — monotonic in severity, over mandatory categories.
  // Rule 4 — `not_applicable` is excluded from composition entirely.
  const mandatoryVerdicts = policy.mandatoryCategories
    .map((c) => byCategory.get(c)?.verdict)
    .filter((v): v is ScoreVerdict => v !== undefined && v !== 'not_applicable');

  const verdict: Verdict = mandatoryVerdicts.includes('block')
    ? 'block'
    : mandatoryVerdicts.includes('soft-warn')
      ? 'soft-warn'
      : 'pass';

  return { verdict, reasons, contributingScores, thresholdSnapshot, evaluatedAt };
}
