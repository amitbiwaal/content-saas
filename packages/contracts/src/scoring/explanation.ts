/**
 * Explainability — `01-system-architecture/14-scoring-contract.md` §5.
 *
 * The contract's implementation of ADR-009 for measurement specifically. Every
 * score carries a structured explanation; this is what makes a score actionable
 * rather than merely a number.
 */

import type { ScoreCategory } from './score.js';

export interface SectionRef {
  readonly articleId: string;
  readonly revisionNumber: number;
  readonly sectionId: string;
}

/**
 * A reference into the Knowledge Platform. Explanations never embed evidence
 * *content* — references only, resolved through the authorized path, and only
 * within the owning workspace (scoring-contract.md §14, ADR-026).
 */
export interface EvidenceRef {
  readonly evidenceId: string;
  readonly citationId: string | null;
}

/**
 * Registry-backed, never free prose. Prose cannot be grouped, counted,
 * trended, or localized; the registry maps each code to a display template per
 * locale (scoring-contract.md §5 rule 1).
 */
export interface ReasonCodeInstance {
  /** Registry key, e.g. 'citation.coverage_below_target'. */
  readonly code: string;
  readonly severity: 'info' | 'warning' | 'critical';
  /** The producer's own contribution indicator; opaque to consumers. */
  readonly weight: number | null;
  /** Scalars only — no free-form strings that could smuggle content across a privilege boundary. */
  readonly context: Readonly<Record<string, string | number>>;
}

/** An observation, not a judgment. `citation_coverage_ratio: 0.82` is a fact. */
export interface SupportingFact {
  readonly metric: string;
  readonly observed: number | string;
  readonly unit: string | null;
  readonly source: 'measured' | 'derived' | 'external';
}

export interface RecommendedAction {
  /** Registry key — maps to ActionType where applicable. */
  readonly actionCode: string;
  readonly targetSection: SectionRef | null;
  readonly expectedImpact: 'low' | 'medium' | 'high';
  /**
   * MUST be non-empty when the action asserts a fact. Enforced in the schema by
   * a `CHECK`, consistent with the constraint already applied to optimization
   * actions (`03-database/tables.md` §7).
   */
  readonly evidenceRefs: readonly EvidenceRef[];
}

export interface ScoreExplanation {
  readonly id: string;
  readonly tenantId: string;
  readonly scoreId: string;

  /** One human-readable sentence. */
  readonly summary: string;
  readonly reasonCodes: readonly ReasonCodeInstance[];
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly supportingFacts: readonly SupportingFact[];
  /** A score of 62 with no location is not actionable. */
  readonly affectedSections: readonly SectionRef[];
  readonly recommendedActions: readonly RecommendedAction[];
  /** Mirrors `Score.confidence`. */
  readonly confidence: number;
  /** Composite scores only — declares the derivation so it is inspectable. */
  readonly inputCategories?: readonly ScoreCategory[];
}
