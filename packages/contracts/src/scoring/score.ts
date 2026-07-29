/**
 * Unified Scoring Contract — contractVersion 1.
 *
 * Specified by `01-system-architecture/14-scoring-contract.md`, the normative
 * document behind **ADR-021**. Mandatory for every engine that produces or
 * consumes a quality measure.
 *
 * This module contains no formula, no threshold, no weight, no heuristic, and
 * no model reference — those belong to the engines implementing the contract
 * and may change freely without amending it (scoring-contract.md §"Scope
 * discipline").
 */

/** The contract version this module implements. Consumers may branch on it. */
export const CONTRACT_VERSION = 1;

export type ScoreVerdict = 'pass' | 'soft-warn' | 'block' | 'not_applicable';
export type ScoreStatus = 'current' | 'superseded' | 'invalidated' | 'expired';

/**
 * The gate's own three-value vocabulary — unchanged, and a database `CHECK`
 * (`05-glossary.md`, ADR-009). Distinct from `ScoreVerdict`, which adds
 * `not_applicable` for an individual measure.
 */
export type Verdict = 'pass' | 'soft-warn' | 'block';

export type ScoreSubject =
  | {
      readonly kind: 'article_version';
      readonly articleId: string;
      readonly revisionNumber: number;
    }
  | {
      readonly kind: 'section';
      readonly articleId: string;
      readonly revisionNumber: number;
      readonly sectionId: string;
    }
  | { readonly kind: 'live_url'; readonly urlId: string }
  | { readonly kind: 'outline'; readonly articleId: string; readonly outlineVersion: number };

export type ScoreSubjectKind = ScoreSubject['kind'];

export interface ProducerRef {
  readonly engine: string;
  readonly engineVersion: string;
}

/**
 * The canonical Score object.
 *
 * Binding rules (scoring-contract.md §2):
 *  1. `value` is an integer 0–100 where **higher is always better**. A producer
 *     whose natural output is risk inverts it before emitting.
 *  2. `confidence` is **orthogonal** to `value`. Producers must not fold
 *     uncertainty into the value.
 *  3. `not_applicable` is a first-class verdict; `value: null` is prohibited.
 *  4. `explanationId` is mandatory — a score without an explanation cannot be
 *     persisted.
 *  5. `algorithmVersion` is **opaque**. No consumer may parse, compare, or
 *     branch on it.
 *  6. A score is immutable. Recalculation produces a new score; the previous
 *     becomes `superseded`.
 */
export interface Score {
  readonly id: string;
  readonly tenantId: string;
  readonly organizationId: string;

  readonly subject: ScoreSubject;
  readonly category: ScoreCategory;

  /** INTEGER 0–100, higher is better, always. */
  readonly value: number;
  /** INTEGER 0–100 — the producer's certainty in `value`. Orthogonal to it. */
  readonly confidence: number;
  readonly verdict: ScoreVerdict;

  readonly contractVersion: number;
  /** Opaque to consumers, e.g. 'seo@4.2.0'. Audit and diff tracking only. */
  readonly algorithmVersion: string;
  readonly producer: ProducerRef;
  /** Hash of the exact inputs measured — the cache-validity key. */
  readonly inputsDigest: string;

  readonly status: ScoreStatus;
  readonly generatedAt: string;
  /** null = does not expire on time alone. */
  readonly expiresAt: string | null;
  readonly supersededBy: string | null;

  /** Mandatory, never optional. */
  readonly explanationId: string;
}

/**
 * The twelve canonical categories. Categories not listed here do not exist;
 * adding one is scoring-contract.md §12 (registry entry, no contract change).
 */
export const SCORE_CATEGORIES = [
  'seo',
  'aeo',
  'geo',
  'accessibility',
  'eeat',
  'human_quality',
  'readability',
  'fact_confidence',
  'citation_quality',
  'spam_risk',
  'brand_voice',
  'publishing_readiness',
] as const;

export type ScoreCategory = (typeof SCORE_CATEGORIES)[number];

/** The two engines permitted to produce scores. */
export type ScoreProducerEngine = 'seo-engine' | 'review-engine';

export interface ScoreCategoryDefinition {
  readonly code: ScoreCategory;
  readonly name: string;
  /**
   * Exactly one producer per category. This exclusivity is the contract's most
   * important structural rule; a second producer is an architectural defect,
   * caught by a startup check against the registry (scoring-contract.md §3).
   */
  readonly producer: ScoreProducerEngine;
  readonly subjectKinds: readonly ScoreSubjectKind[];
  /** Derived from other scores rather than measured directly. */
  readonly composite: boolean;
  /** True where the category runs as risk and is inverted before emission. */
  readonly inverted: boolean;
}

/**
 * The canonical registry, mirroring scoring-contract.md §3 exactly.
 *
 * Reference data. At runtime this is backed by `score_category_registry`, a
 * global reference table under the ADR-025 exception class; this constant is
 * the compile-time source that the startup check validates the table against.
 */
export const SCORE_CATEGORY_REGISTRY: Readonly<Record<ScoreCategory, ScoreCategoryDefinition>> = {
  seo: {
    code: 'seo',
    name: 'Search Optimization',
    producer: 'seo-engine',
    subjectKinds: ['article_version', 'live_url'],
    composite: false,
    inverted: false,
  },
  aeo: {
    code: 'aeo',
    name: 'Answer Engine Optimization',
    producer: 'seo-engine',
    subjectKinds: ['article_version', 'live_url'],
    composite: false,
    inverted: false,
  },
  geo: {
    code: 'geo',
    name: 'Generative Engine Optimization',
    producer: 'seo-engine',
    subjectKinds: ['article_version', 'live_url'],
    composite: false,
    inverted: false,
  },
  accessibility: {
    code: 'accessibility',
    name: 'Accessibility',
    producer: 'seo-engine',
    subjectKinds: ['article_version'],
    composite: false,
    inverted: false,
  },
  eeat: {
    code: 'eeat',
    name: 'Experience, Expertise, Authoritativeness, Trust',
    producer: 'review-engine',
    subjectKinds: ['article_version'],
    composite: false,
    inverted: false,
  },
  human_quality: {
    code: 'human_quality',
    name: 'Human Quality',
    producer: 'review-engine',
    subjectKinds: ['article_version'],
    composite: false,
    inverted: false,
  },
  readability: {
    code: 'readability',
    name: 'Readability',
    producer: 'review-engine',
    subjectKinds: ['article_version', 'section'],
    composite: false,
    inverted: false,
  },
  fact_confidence: {
    code: 'fact_confidence',
    name: 'Fact Confidence',
    producer: 'review-engine',
    subjectKinds: ['article_version', 'section'],
    composite: false,
    inverted: false,
  },
  citation_quality: {
    code: 'citation_quality',
    name: 'Citation Quality',
    producer: 'review-engine',
    subjectKinds: ['article_version'],
    composite: false,
    inverted: false,
  },
  spam_risk: {
    code: 'spam_risk',
    name: 'Spam Risk',
    producer: 'review-engine',
    subjectKinds: ['article_version'],
    composite: false,
    /** 100 = no risk. Inverted before emission so higher is always better. */
    inverted: true,
  },
  brand_voice: {
    code: 'brand_voice',
    name: 'Brand Voice Conformance',
    producer: 'review-engine',
    subjectKinds: ['article_version', 'section'],
    composite: false,
    inverted: false,
  },
  publishing_readiness: {
    code: 'publishing_readiness',
    name: 'Publishing Readiness',
    /** Review hosts the quality gate — ADR-011. */
    producer: 'review-engine',
    subjectKinds: ['article_version'],
    /** The only composite category. */
    composite: true,
    inverted: false,
  },
};

/**
 * Consumers must tolerate unknown categories — a consumer that throws on an
 * unrecognized category makes every future category a breaking change
 * (scoring-contract.md §12). This is a type guard, never a validator that
 * rejects.
 */
export function isKnownScoreCategory(value: string): value is ScoreCategory {
  return Object.prototype.hasOwnProperty.call(SCORE_CATEGORY_REGISTRY, value);
}
