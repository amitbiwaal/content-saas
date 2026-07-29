import { describe, expect, it } from 'vitest';

import {
  CONTRACT_VERSION,
  isKnownScoreCategory,
  SCORE_CATEGORIES,
  SCORE_CATEGORY_REGISTRY,
} from './score.js';

describe('Unified Scoring Contract registry (ADR-021)', () => {
  it('declares contractVersion 1', () => {
    expect(CONTRACT_VERSION).toBe(1);
  });

  it('holds exactly the twelve canonical categories', () => {
    expect(SCORE_CATEGORIES).toHaveLength(12);
    expect(Object.keys(SCORE_CATEGORY_REGISTRY).sort()).toEqual([...SCORE_CATEGORIES].sort());
  });

  // The contract's most important structural rule (scoring-contract.md §3).
  it('gives every category exactly one producer', () => {
    for (const code of SCORE_CATEGORIES) {
      const def = SCORE_CATEGORY_REGISTRY[code];
      expect(def.producer, `${code} must declare a producer`).toBeTruthy();
      expect(['seo-engine', 'review-engine']).toContain(def.producer);
    }
  });

  it('keys every registry entry by its own code', () => {
    for (const code of SCORE_CATEGORIES) {
      expect(SCORE_CATEGORY_REGISTRY[code].code).toBe(code);
    }
  });

  it('assigns the four SEO Engine categories exactly', () => {
    const seoOwned = SCORE_CATEGORIES.filter(
      (c) => SCORE_CATEGORY_REGISTRY[c].producer === 'seo-engine',
    );
    expect(seoOwned).toEqual(['seo', 'aeo', 'geo', 'accessibility']);
  });

  it('makes publishing_readiness the only composite category', () => {
    const composites = SCORE_CATEGORIES.filter((c) => SCORE_CATEGORY_REGISTRY[c].composite);
    expect(composites).toEqual(['publishing_readiness']);
    // Review hosts the quality gate — ADR-011.
    expect(SCORE_CATEGORY_REGISTRY.publishing_readiness.producer).toBe('review-engine');
  });

  it('marks spam_risk as the inverted category so higher is always better', () => {
    const inverted = SCORE_CATEGORIES.filter((c) => SCORE_CATEGORY_REGISTRY[c].inverted);
    expect(inverted).toEqual(['spam_risk']);
  });

  it('declares at least one subject kind for every category', () => {
    for (const code of SCORE_CATEGORIES) {
      expect(SCORE_CATEGORY_REGISTRY[code].subjectKinds.length).toBeGreaterThan(0);
    }
  });

  // Consumers must tolerate unknown categories (scoring-contract.md §12).
  it('recognizes known categories and does not throw on unknown ones', () => {
    expect(isKnownScoreCategory('eeat')).toBe(true);
    expect(isKnownScoreCategory('originality')).toBe(false);
    expect(isKnownScoreCategory('__proto__')).toBe(false);
  });
});
