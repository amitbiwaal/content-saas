/**
 * The security-posture ports — interfaces, and nothing else.
 *
 * ── Why ports ─────────────────────────────────────────────────────────────
 * A policy catalogue, a findings queue and an assessment history all need
 * storage, and every reader of them — a report, a dashboard, a CI gate, a test
 * — would otherwise grow its own SQL. That is three places a finding's shape
 * and its tenant filter get written down.
 *
 * ── They follow the shapes already established here ───────────────────────
 * Keyset positions, never offsets. Explicit nulls on every query dimension, so
 * an implementer sees what it must handle. Instants supplied, never read from a
 * clock. The same decisions `ReservationQuery`, `ConsumptionQuery`,
 * `SettlementQuery` and `AuditQuery` made, for the same reasons.
 *
 * ── Findings are appended and transitioned, never edited ──────────────────
 * There is no `updateFinding`. A finding's severity, threat and evidence are
 * what the scan saw; the only thing that changes is its STATUS, and that has
 * its own method so an audit record can be written beside it. Editing a
 * severity in place is how a Critical quietly becomes a Low before a review.
 *
 * ── No database, no clock, no SQL ────────────────────────────────────────
 * No driver, no query text, no transaction handle.
 */

import type { SecurityAssessment, AssessmentId } from './assessment.js';
import type { FindingId, FindingStatus, SecurityFinding } from './finding.js';
import type { PolicyId, PolicyStatus, SecurityPolicy } from './policy.js';
import type { SecurityCategory, SecuritySeverity, ThreatId } from './threats.js';

// ── Policies ────────────────────────────────────────────────────────────────

export interface PolicyQuery {
  /** Match any. Null lists every status. Never an empty array. */
  readonly statuses: readonly PolicyStatus[] | null;
  readonly categories: readonly SecurityCategory[] | null;
  /** Policies naming this threat. The coverage question. */
  readonly threatId: ThreatId | null;
}

export interface PolicySlice {
  readonly policies: readonly SecurityPolicy[];
}

export interface SecurityPolicyRepository {
  /**
   * Store a policy.
   *
   * Must refuse a duplicate id: two policies under one id would make a finding
   * ambiguous about which control it failed.
   */
  savePolicy(policy: SecurityPolicy): Promise<SecurityPolicy>;

  loadPolicy(policyId: PolicyId): Promise<SecurityPolicy | null>;

  listPolicies(query: PolicyQuery): Promise<PolicySlice>;
}

// ── Findings ────────────────────────────────────────────────────────────────

/** Where a page of findings continues from. Keyset, never an offset. */
export interface FindingPosition {
  readonly detectedAt: string;
  readonly findingId: FindingId;
}

export interface FindingQuery {
  readonly statuses: readonly FindingStatus[] | null;
  readonly severities: readonly SecuritySeverity[] | null;
  readonly categories: readonly SecurityCategory[] | null;
  readonly threatId: ThreatId | null;
  readonly policyId: PolicyId | null;
  readonly component: string | null;
  /** Inclusive. */
  readonly detectedAfter: string | null;
  /** Exclusive, so adjacent windows never count one finding twice. */
  readonly detectedBefore: string | null;
  readonly after: FindingPosition | null;
  readonly limit: number;
}

export interface FindingSlice {
  /** Worst-first, then newest: a triage queue is read in the order it is worked. */
  readonly findings: readonly SecurityFinding[];
  readonly next: FindingPosition | null;
}

export interface SecurityFindingRepository {
  /**
   * Record findings from one scan.
   *
   * Idempotent on `fingerprint`: a rescan of an unchanged system must not file
   * the same problem again, and the store's unique constraint is what decides
   * rather than a read-then-write.
   */
  recordFindings(findings: readonly SecurityFinding[]): Promise<readonly SecurityFinding[]>;

  loadFinding(findingId: FindingId): Promise<SecurityFinding | null>;

  /** The one with this fingerprint, or null. The deduplication question. */
  findByFingerprint(fingerprint: string): Promise<SecurityFinding | null>;

  /**
   * Move a finding to a new status.
   *
   * The ONLY mutation on this interface. `at` is supplied so the transition and
   * whatever audits it agree about when it happened.
   */
  transitionFinding(input: {
    readonly findingId: FindingId;
    readonly status: FindingStatus;
    readonly at: string;
  }): Promise<SecurityFinding>;

  listFindings(query: FindingQuery): Promise<FindingSlice>;
}

// ── Assessments ─────────────────────────────────────────────────────────────

export interface AssessmentQuery {
  readonly startedAfter: string | null;
  readonly startedBefore: string | null;
  readonly limit: number;
}

export interface AssessmentSlice {
  /** Newest first: "when were we last assessed" is the usual question. */
  readonly assessments: readonly SecurityAssessment[];
}

export interface SecurityAssessmentRepository {
  /** Append one completed assessment. There is no path to amend one. */
  saveAssessment(assessment: SecurityAssessment): Promise<SecurityAssessment>;

  loadAssessment(assessmentId: AssessmentId): Promise<SecurityAssessment | null>;

  listAssessments(query: AssessmentQuery): Promise<AssessmentSlice>;
}
