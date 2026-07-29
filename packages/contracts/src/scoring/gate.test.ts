import { describe, expect, it } from 'vitest';

import { composeGateVerdict, REASON_MANDATORY_CATEGORY_MISSING } from './gate.js';
import type { GateEvaluationRequest, ThresholdSnapshot } from './gate.js';
import type { Score, ScoreCategory, ScoreSubject, ScoreVerdict } from './score.js';

const SUBJECT: ScoreSubject = {
  kind: 'article_version',
  articleId: 'art-1',
  revisionNumber: 4,
};

const SNAPSHOT: ThresholdSnapshot = {
  snapshotId: 'snap-1',
  resolvedAt: '2026-07-29T00:00:00.000Z',
};

const AT = '2026-07-29T10:00:00.000Z';

function score(
  category: ScoreCategory,
  verdict: ScoreVerdict,
  overrides: Partial<Score> = {},
): Score {
  return {
    id: `score-${category}`,
    tenantId: 'ws-1',
    organizationId: 'org-1',
    subject: SUBJECT,
    category,
    value: 80,
    confidence: 90,
    verdict,
    contractVersion: 1,
    algorithmVersion: 'review@3.1.0',
    producer: { engine: 'review-engine', engineVersion: '2.4.1' },
    inputsDigest: 'digest',
    status: 'current',
    generatedAt: AT,
    expiresAt: null,
    supersededBy: null,
    explanationId: `exp-${category}`,
    ...overrides,
  };
}

function request(
  scores: readonly Score[],
  mandatoryCategories: readonly ScoreCategory[],
): GateEvaluationRequest {
  return {
    subject: SUBJECT,
    scores,
    thresholdSnapshot: SNAPSHOT,
    policy: { mandatoryCategories, ymyl: false },
  };
}

describe('composeGateVerdict', () => {
  it('passes when every mandatory category passes', () => {
    const result = composeGateVerdict(
      request(
        [score('eeat', 'pass'), score('citation_quality', 'pass')],
        ['eeat', 'citation_quality'],
      ),
      AT,
    );
    expect(result.verdict).toBe('pass');
    expect(result.reasons).toEqual([]);
  });

  it('is monotonic in severity — any block wins', () => {
    const result = composeGateVerdict(
      request(
        [score('eeat', 'pass'), score('citation_quality', 'block')],
        ['eeat', 'citation_quality'],
      ),
      AT,
    );
    expect(result.verdict).toBe('block');
  });

  it('yields soft-warn when there is a warn but no block', () => {
    const result = composeGateVerdict(
      request(
        [score('eeat', 'soft-warn'), score('citation_quality', 'pass')],
        ['eeat', 'citation_quality'],
      ),
      AT,
    );
    expect(result.verdict).toBe('soft-warn');
  });

  // Rule 3 — inconclusive is not permission.
  it('BLOCKS when a mandatory category has no score', () => {
    const result = composeGateVerdict(
      request([score('eeat', 'pass')], ['eeat', 'citation_quality']),
      AT,
    );
    expect(result.verdict).toBe('block');
    expect(result.reasons).toContainEqual({
      code: REASON_MANDATORY_CATEGORY_MISSING,
      category: 'citation_quality',
      severity: 'critical',
    });
  });

  it('treats a non-current score as absent, so a superseded mandatory score blocks', () => {
    const result = composeGateVerdict(
      request([score('eeat', 'pass', { status: 'superseded' })], ['eeat']),
      AT,
    );
    expect(result.verdict).toBe('block');
  });

  // Rule 4 — not_applicable is excluded, never treated as pass and never as zero.
  it('excludes not_applicable from composition rather than passing on it', () => {
    const result = composeGateVerdict(
      request(
        [score('accessibility', 'not_applicable'), score('eeat', 'pass')],
        ['accessibility', 'eeat'],
      ),
      AT,
    );
    expect(result.verdict).toBe('pass');
  });

  it('does not let a not_applicable mask a block in another mandatory category', () => {
    const result = composeGateVerdict(
      request(
        [score('accessibility', 'not_applicable'), score('eeat', 'block')],
        ['accessibility', 'eeat'],
      ),
      AT,
    );
    expect(result.verdict).toBe('block');
  });

  it('ignores non-mandatory categories when composing the verdict', () => {
    const result = composeGateVerdict(
      request([score('eeat', 'pass'), score('readability', 'block')], ['eeat']),
      AT,
    );
    expect(result.verdict).toBe('pass');
    expect(result.contributingScores).toHaveLength(2);
  });

  it('echoes the threshold snapshot so the decision stays reproducible', () => {
    const result = composeGateVerdict(request([score('eeat', 'pass')], ['eeat']), AT);
    expect(result.thresholdSnapshot).toEqual(SNAPSHOT);
    expect(result.evaluatedAt).toBe(AT);
  });

  it('is deterministic — identical inputs produce identical results', () => {
    const req = request(
      [score('eeat', 'soft-warn'), score('citation_quality', 'pass')],
      ['eeat', 'citation_quality'],
    );
    expect(composeGateVerdict(req, AT)).toEqual(composeGateVerdict(req, AT));
  });
});
