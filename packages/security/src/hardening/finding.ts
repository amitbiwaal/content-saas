/**
 * Security findings and what to do about them.
 *
 * ── A finding says WHAT, never HOW ─────────────────────────────────────────
 * `threat-model.md` is a public-facing artefact and a report built from these
 * is read by auditors and customers. So a finding carries an identifier, a
 * threat, a severity and a component — and deliberately carries no stack trace,
 * no query, no header, no token and no internal path. `evidence` is bounded and
 * enumerated for exactly that reason: a free-text field wide enough to hold a
 * stack trace eventually holds one, and then holds a secret.
 *
 * ── Its identity is what it is, not when it was found ──────────────────────
 * `fingerprint` is `policyId:ruleId:component`. Two scans of an unchanged
 * system produce the same fingerprint, so "is this new" is answerable and a
 * queue does not fill with the same finding once a night. The detection instant
 * is deliberately NOT part of it.
 */

import {
  assertIdentifier,
  assertInstant,
  assertPresent,
  deepFreeze,
  SecurityError,
} from './errors.js';
import { MAX_TEXT_LENGTH } from './policy.js';
import {
  isKnownThreat,
  isSecurityCategory,
  isSecuritySeverity,
  type SecurityCategory,
  type SecuritySeverity,
  type ThreatId,
} from './threats.js';

/**
 * What a rule concluded.
 *
 * `not_applicable` is distinct from `pass` on purpose: a rule about SAML on a
 * deployment with no SAML has not been satisfied, it has not been asked, and a
 * compliance percentage that counted it as a pass would overstate coverage.
 */
export const FINDING_STATUSES = ['open', 'accepted', 'resolved', 'not_applicable'] as const;

export type FindingStatus = (typeof FINDING_STATUSES)[number];

export function isFindingStatus(value: unknown): value is FindingStatus {
  return typeof value === 'string' && (FINDING_STATUSES as readonly string[]).includes(value);
}

/** The statuses that still need somebody. What a queue counts. */
export const UNRESOLVED_STATUSES: readonly FindingStatus[] = Object.freeze(['open']);

/**
 * What to do about a finding.
 *
 * `action` is an instruction, not a diagnosis. A recommendation that only
 * restated the problem would be a finding with extra words.
 */
export interface SecurityRecommendation {
  readonly action: string;
  /** How urgent, which may exceed the finding's own on an aggregate. */
  readonly severity: SecuritySeverity;
  /** The document that says why. A reference, never a filesystem path. */
  readonly reference: string | null;
}

export type FindingId = string;

export interface SecurityFinding {
  readonly findingId: FindingId;
  /**
   * `policyId:ruleId:component`. Stable across scans of an unchanged system,
   * which is what makes a finding deduplicable.
   */
  readonly fingerprint: string;
  readonly policyId: string;
  readonly ruleId: string;
  readonly threatId: ThreatId;
  readonly category: SecurityCategory;
  readonly severity: SecuritySeverity;
  readonly status: FindingStatus;
  /** What it was found in. An identifier, never a path or a URL. */
  readonly component: string;
  /**
   * Enumerated detail, bounded. Never a stack trace, a query, a header or a
   * token — see the file header.
   */
  readonly evidence: Readonly<Record<string, string>>;
  readonly recommendation: SecurityRecommendation;
  readonly detectedAt: string;
}

export const MAX_EVIDENCE_KEYS = 16;
export const MAX_EVIDENCE_VALUE_LENGTH = 200;

const EVIDENCE_KEY_SHAPE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

/**
 * Evidence that can be shown to an auditor.
 *
 * String values only, bounded, with keys that read as field names. The limits
 * are the control: a value long enough to paste a stack trace into is a value
 * somebody eventually pastes a stack trace into.
 */
export function assertValidEvidence(
  evidence: Readonly<Record<string, string>>,
  field = 'evidence',
): Readonly<Record<string, string>> {
  const keys = Object.keys(evidence);

  if (keys.length > MAX_EVIDENCE_KEYS) {
    throw new SecurityError(
      'InvalidPolicy',
      field,
      `Evidence carries ${String(keys.length)} keys; the limit is ${String(MAX_EVIDENCE_KEYS)}. Findings are shown to auditors, and an unbounded blob is one nobody has read before it is sent.`,
    );
  }

  for (const key of keys) {
    if (!EVIDENCE_KEY_SHAPE.test(key)) {
      throw new SecurityError(
        'InvalidPolicy',
        `${field}.${key}`,
        `'${key}' is not an evidence key: lowercase, underscore-separated.`,
      );
    }
    const value: unknown = evidence[key];
    if (typeof value !== 'string') {
      throw new SecurityError(
        'InvalidPolicy',
        `${field}.${key}`,
        `Evidence values are strings; '${key}' is a ${typeof value}.`,
      );
    }
    if (value.length > MAX_EVIDENCE_VALUE_LENGTH) {
      throw new SecurityError(
        'InvalidPolicy',
        `${field}.${key}`,
        `'${key}' is ${String(value.length)} characters; the limit is ${String(MAX_EVIDENCE_VALUE_LENGTH)}. A field wide enough for a stack trace eventually holds one, and then holds a secret.`,
      );
    }
  }

  return evidence;
}

export function assertValidRecommendation(
  recommendation: SecurityRecommendation,
  field = 'recommendation',
): SecurityRecommendation {
  assertPresent(
    recommendation.action,
    `${field}.action`,
    'a recommendation with no action is a finding with extra words.',
  );

  if (recommendation.action.length > MAX_TEXT_LENGTH) {
    throw new SecurityError(
      'InvalidRecommendation',
      `${field}.action`,
      `'${field}.action' is longer than ${String(MAX_TEXT_LENGTH)} characters.`,
    );
  }
  if (!isSecuritySeverity(recommendation.severity)) {
    throw new SecurityError(
      'InvalidSeverity',
      `${field}.severity`,
      `'${String(recommendation.severity)}' is not a severity.`,
    );
  }
  if (recommendation.reference !== null) {
    assertPresent(
      recommendation.reference,
      `${field}.reference`,
      'a reference or null, not empty.',
    );
    if (/[\\/]|https?:/i.test(recommendation.reference)) {
      throw new SecurityError(
        'InvalidRecommendation',
        `${field}.reference`,
        'A reference names a document, never a path or a URL. Paths are implementation detail, and a report is read outside the team.',
      );
    }
  }
  return recommendation;
}

/** `policyId:ruleId:component`. The identity of a finding, across scans. */
export function fingerprintOf(input: {
  readonly policyId: string;
  readonly ruleId: string;
  readonly component: string;
}): string {
  return `${input.policyId}:${input.ruleId}:${input.component}`;
}

export function assertValidFinding(finding: SecurityFinding): SecurityFinding {
  assertIdentifier(finding.findingId, 'findingId');
  assertIdentifier(finding.policyId, 'policyId');
  assertIdentifier(finding.ruleId, 'ruleId');
  assertIdentifier(finding.component, 'component');
  assertInstant(finding.detectedAt, 'detectedAt');

  if (!isKnownThreat(finding.threatId)) {
    throw new SecurityError(
      'UnknownThreat',
      'threatId',
      `'${String(finding.threatId)}' is not a threat this build declares. A finding nobody can trace to the model is one nobody can triage.`,
    );
  }
  if (!isSecurityCategory(finding.category)) {
    throw new SecurityError(
      'InvalidCategory',
      'category',
      `'${String(finding.category)}' is not a security category.`,
    );
  }
  if (!isSecuritySeverity(finding.severity)) {
    throw new SecurityError(
      'InvalidSeverity',
      'severity',
      `'${String(finding.severity)}' is not a severity. The four in threat-model.md drive response time.`,
    );
  }
  if (!isFindingStatus(finding.status)) {
    throw new SecurityError(
      'InvalidPolicy',
      'status',
      `'${String(finding.status)}' is not a finding status. Available: ${FINDING_STATUSES.join(', ')}.`,
    );
  }

  const expected = fingerprintOf(finding);
  if (finding.fingerprint !== expected) {
    throw new SecurityError(
      'MalformedIdentifier',
      'fingerprint',
      'A fingerprint is policyId:ruleId:component. One that says otherwise would deduplicate against the wrong finding, and the same problem would be filed every night.',
    );
  }

  assertValidEvidence(finding.evidence);
  assertValidRecommendation(finding.recommendation);

  return finding;
}

/** Build a finding, validated and deep-frozen. */
export function createSecurityFinding(
  finding: Omit<SecurityFinding, 'fingerprint'> & { readonly fingerprint?: string },
): SecurityFinding {
  const complete: SecurityFinding = {
    ...finding,
    fingerprint: finding.fingerprint ?? fingerprintOf(finding),
  };
  assertValidFinding(complete);

  return deepFreeze({
    ...complete,
    evidence: { ...complete.evidence },
    recommendation: { ...complete.recommendation },
  });
}

/** Is this one still somebody's problem? */
export function isUnresolved(finding: SecurityFinding): boolean {
  return UNRESOLVED_STATUSES.includes(finding.status);
}
