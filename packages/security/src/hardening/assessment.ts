/**
 * Assessments, scans, compliance and the report they produce.
 *
 * ── An assessment is a MEASUREMENT, taken at a moment ──────────────────────
 * It says what was checked, when, and what was found. It changes nothing: no
 * control is applied, relaxed or bypassed from here, and a scan that could
 * repair what it found would make an outage invisible by fixing it just long
 * enough to answer — the same reason `monitoring.md` forbids a health check
 * from reconnecting.
 *
 * ── It cannot have happened in the future ──────────────────────────────────
 * `completedAt` is compared against a SUPPLIED `now`. A future assessment is
 * either a clock skew or a fabrication, and both make a compliance report say
 * the platform was verified at a time it was not.
 *
 * ── Compliance is a ratio over what was ASKED ──────────────────────────────
 * Rules that were not applicable are excluded from the denominator rather than
 * counted as passes. Counting them would let a deployment reach 100% by not
 * having the features the rules are about.
 */

import { assertIdentifier, assertInstant, deepFreeze, SecurityError } from './errors.js';
import { isUnresolved, type FindingStatus, type SecurityFinding } from './finding.js';
import type { PolicyId, SecurityPolicy } from './policy.js';
import {
  SECURITY_CATEGORIES,
  SECURITY_SEVERITIES,
  worstOf,
  type SecurityCategory,
  type SecuritySeverity,
} from './threats.js';

export type AssessmentId = string;

/** What one rule concluded on one component. The unit a scan produces. */
export interface ScanResult {
  readonly policyId: PolicyId;
  readonly ruleId: string;
  readonly component: string;
  readonly outcome: FindingStatus;
}

/**
 * What was assessed.
 *
 * An assessment over "everything" and one over a single policy are different
 * measurements, and a report that could not tell them apart would compare a
 * spot check to a full sweep.
 */
export interface AssessmentScope {
  /** Null means every active policy. */
  readonly policyIds: readonly PolicyId[] | null;
  /** Null means every component. */
  readonly components: readonly string[] | null;
}

export interface SecurityAssessment {
  readonly assessmentId: AssessmentId;
  readonly scope: AssessmentScope;
  readonly startedAt: string;
  readonly completedAt: string;
  /** How many rule evaluations were performed, including the ones that passed. */
  readonly rulesEvaluated: number;
  /** Every finding this run produced. Deduplicated by fingerprint. */
  readonly findings: readonly SecurityFinding[];
}

/**
 * A count per severity, and per category.
 *
 * Both, because they answer different questions: severity is "how urgent is
 * this queue", category is "which part of the system is weak". A report with
 * only one of them sends somebody to the wrong place.
 */
export interface SecuritySummary {
  readonly total: number;
  readonly unresolved: number;
  readonly bySeverity: Readonly<Record<SecuritySeverity, number>>;
  readonly byCategory: Readonly<Record<SecurityCategory, number>>;
  /** The worst unresolved severity, or null when nothing is outstanding. */
  readonly worstUnresolved: SecuritySeverity | null;
}

/**
 * How much of what was asked, passed.
 *
 * `applicable` excludes `not_applicable` results, so a deployment cannot reach
 * 100% by lacking the features the rules are about.
 */
export interface SecurityCompliance {
  readonly evaluated: number;
  readonly applicable: number;
  readonly passed: number;
  /** `passed / applicable`, to four decimal places. Null when nothing applied. */
  readonly ratio: number | null;
  /** Threats with at least one active policy naming them. */
  readonly threatsCovered: number;
  readonly threatsTotal: number;
}

/** An assessment, its summary and its compliance, in one value. */
export interface SecurityReport {
  readonly assessment: SecurityAssessment;
  readonly summary: SecuritySummary;
  readonly compliance: SecurityCompliance;
  readonly generatedAt: string;
}

function zeroBySeverity(): Record<SecuritySeverity, number> {
  const out = {} as Record<SecuritySeverity, number>;
  for (const severity of SECURITY_SEVERITIES) out[severity] = 0;
  return out;
}

function zeroByCategory(): Record<SecurityCategory, number> {
  const out = {} as Record<SecurityCategory, number>;
  for (const category of SECURITY_CATEGORIES) out[category] = 0;
  return out;
}

/**
 * Validate an assessment.
 *
 * `now` is supplied, never read: a validator with its own clock could not be
 * asserted on, and two readers would disagree about whether a run was in the
 * future.
 */
export function assertValidAssessment(
  assessment: SecurityAssessment,
  now: string,
): SecurityAssessment {
  assertIdentifier(assessment.assessmentId, 'assessmentId');
  assertInstant(assessment.startedAt, 'startedAt');
  assertInstant(assessment.completedAt, 'completedAt');
  assertInstant(now, 'now');

  const started = Date.parse(assessment.startedAt);
  const completed = Date.parse(assessment.completedAt);

  if (completed < started) {
    throw new SecurityError(
      'InconsistentAssessment',
      'completedAt',
      'An assessment cannot finish before it started.',
    );
  }
  if (completed > Date.parse(now)) {
    throw new SecurityError(
      'FutureAssessment',
      'completedAt',
      'An assessment cannot have completed in the future. That is a clock skew or a fabrication, and either makes a compliance report claim the platform was verified at a time it was not.',
    );
  }

  if (!Number.isSafeInteger(assessment.rulesEvaluated) || assessment.rulesEvaluated < 0) {
    throw new SecurityError(
      'InconsistentAssessment',
      'rulesEvaluated',
      'A rule count is a non-negative whole number.',
    );
  }
  if (assessment.findings.length > assessment.rulesEvaluated) {
    throw new SecurityError(
      'InconsistentAssessment',
      'rulesEvaluated',
      `An assessment reports ${String(assessment.findings.length)} findings from ${String(assessment.rulesEvaluated)} evaluations. A finding comes from an evaluation, so it cannot have produced more than it ran.`,
    );
  }

  const seen = new Set<string>();
  for (const finding of assessment.findings) {
    if (seen.has(finding.fingerprint)) {
      throw new SecurityError(
        'DuplicateFinding',
        'findings',
        `Finding '${finding.fingerprint}' appears twice in one assessment. A queue that accepted it would show one problem as two, and closing one would leave the other open forever.`,
      );
    }
    seen.add(finding.fingerprint);
  }

  return assessment;
}

/** Build an assessment, validated and deep-frozen. */
export function createSecurityAssessment(
  assessment: SecurityAssessment,
  now: string,
): SecurityAssessment {
  assertValidAssessment(assessment, now);
  return deepFreeze({
    ...assessment,
    scope: {
      policyIds: assessment.scope.policyIds === null ? null : [...assessment.scope.policyIds],
      components: assessment.scope.components === null ? null : [...assessment.scope.components],
    },
    findings: [...assessment.findings],
  });
}

/** Count the findings, by severity and by category. */
export function summarize(findings: readonly SecurityFinding[]): SecuritySummary {
  const bySeverity = zeroBySeverity();
  const byCategory = zeroByCategory();
  const unresolvedSeverities: SecuritySeverity[] = [];
  let unresolved = 0;

  for (const finding of findings) {
    bySeverity[finding.severity] += 1;
    byCategory[finding.category] += 1;
    if (isUnresolved(finding)) {
      unresolved += 1;
      unresolvedSeverities.push(finding.severity);
    }
  }

  return deepFreeze({
    total: findings.length,
    unresolved,
    bySeverity,
    byCategory,
    worstUnresolved: worstOf(unresolvedSeverities),
  });
}

/**
 * How much of what was asked, passed.
 *
 * A pure fold over scan results and the policy set. Nothing is read from a
 * store and no clock is consulted.
 */
export function calculateCompliance(input: {
  readonly results: readonly ScanResult[];
  readonly policies: readonly SecurityPolicy[];
  readonly threatsTotal: number;
}): SecurityCompliance {
  const applicable = input.results.filter((result) => result.outcome !== 'not_applicable');
  const passed = applicable.filter((result) => result.outcome === 'resolved').length;

  const covered = new Set<string>();
  for (const policy of input.policies) {
    if (policy.status !== 'active') continue;
    for (const threatId of policy.threatIds) covered.add(threatId);
  }

  return deepFreeze({
    evaluated: input.results.length,
    applicable: applicable.length,
    passed,
    // Rounded rather than left as a long float: a compliance figure is read by
    // a human, and 0.8571428571428571 is not a number anybody quotes.
    ratio:
      applicable.length === 0 ? null : Math.round((passed / applicable.length) * 10_000) / 10_000,
    threatsCovered: covered.size,
    threatsTotal: input.threatsTotal,
  });
}

/**
 * The findings a scan produced that were not already known.
 *
 * Compared by fingerprint, not by id: a rescan of an unchanged system produces
 * the same fingerprints with new ids, and comparing ids would report every
 * finding as new every night.
 */
export function newFindings(
  found: readonly SecurityFinding[],
  known: readonly SecurityFinding[],
): readonly SecurityFinding[] {
  const seen = new Set(known.map((finding) => finding.fingerprint));
  return Object.freeze(found.filter((finding) => !seen.has(finding.fingerprint)));
}

/**
 * A finding that was open and is no longer produced by a scan.
 *
 * What a report calls resolved. Derived rather than trusted: a scan that simply
 * failed to run would otherwise look like everything being fixed at once.
 */
export function disappearedFindings(
  known: readonly SecurityFinding[],
  found: readonly SecurityFinding[],
): readonly SecurityFinding[] {
  const stillFound = new Set(found.map((finding) => finding.fingerprint));
  return Object.freeze(
    known.filter((finding) => isUnresolved(finding) && !stillFound.has(finding.fingerprint)),
  );
}

/** An assessment, summarised and scored. The whole report, deep-frozen. */
export function buildSecurityReport(input: {
  readonly assessment: SecurityAssessment;
  readonly results: readonly ScanResult[];
  readonly policies: readonly SecurityPolicy[];
  readonly threatsTotal: number;
  readonly generatedAt: string;
}): SecurityReport {
  assertInstant(input.generatedAt, 'generatedAt');

  return deepFreeze({
    assessment: input.assessment,
    summary: summarize(input.assessment.findings),
    compliance: calculateCompliance({
      results: input.results,
      policies: input.policies,
      threatsTotal: input.threatsTotal,
    }),
    generatedAt: input.generatedAt,
  });
}
