/**
 * The two posture services — validate, freeze, persist through a port.
 *
 * ── They observe. They enforce nothing ─────────────────────────────────────
 * Neither service authenticates, authorizes, rate limits or blocks anything.
 * The controls stay exactly where they are — `authz/evaluator.ts`, the rate
 * limiter, RLS, the redaction backstop, `AuditService` — and a posture service
 * that could reach one would be able to weaken the thing it reports on.
 *
 * There is deliberately no `deletePolicy`, no `resolveFinding` that skips a
 * status transition, and no way to lower a severity: a finding's severity is
 * what the scan saw.
 *
 * ── Recording a scan does not bypass audit ────────────────────────────────
 * Accepting a finding, retiring a policy and starting an assessment are all
 * privileged actions, and `audit.md` requires every one of them to be recorded
 * in the ACTION's transaction. This layer does not write audit records itself —
 * that needs a transaction handle and would make these services a second write
 * path — so `toAuditEvent` projects a posture action onto the frozen
 * `AuditEvent`, and the caller records it through `AuditService` in the same
 * transaction as the change.
 *
 * ── No clock, no ids, no globals ──────────────────────────────────────────
 * Every instant and every identifier arrives with the request.
 */

import type { AuditEvent } from '../audit/model.js';
import type { Principal } from '../authn/principal.js';
import {
  createSecurityAssessment,
  type AssessmentId,
  type SecurityAssessment,
} from './assessment.js';
import { deepFreeze, SecurityError } from './errors.js';
import { createSecurityFinding, type FindingStatus, type SecurityFinding } from './finding.js';
import { createSecurityPolicy, ruleOf, type PolicyId, type SecurityPolicy } from './policy.js';
import type {
  SecurityAssessmentRepository,
  SecurityFindingRepository,
  SecurityPolicyRepository,
} from './repository.js';
import { THREATS } from './threats.js';

// ── Policies ────────────────────────────────────────────────────────────────

export interface SecurityPolicyServiceOptions {
  readonly policies: SecurityPolicyRepository;
}

export interface SecurityPolicyService {
  /** Validate, freeze and store. Refuses everything a report cannot carry. */
  declarePolicy(policy: SecurityPolicy): Promise<SecurityPolicy>;

  loadPolicy(policyId: PolicyId): Promise<SecurityPolicy | null>;

  /**
   * Which declared threats have no active policy naming them.
   *
   * The question the whole model exists to answer, and one nobody can answer
   * by reading twenty files of comments.
   */
  uncoveredThreats(): Promise<readonly string[]>;
}

export function createSecurityPolicyService(
  options: SecurityPolicyServiceOptions,
): SecurityPolicyService {
  const { policies } = options;

  return Object.freeze({
    async declarePolicy(policy: SecurityPolicy): Promise<SecurityPolicy> {
      // Validated and frozen BEFORE the store is reached, so an implementation
      // cannot be handed a policy the rules would have refused.
      const validated = createSecurityPolicy(policy);
      return policies.savePolicy(validated);
    },

    loadPolicy(policyId: PolicyId): Promise<SecurityPolicy | null> {
      return policies.loadPolicy(policyId);
    },

    async uncoveredThreats(): Promise<readonly string[]> {
      const slice = await policies.listPolicies({
        statuses: ['active'],
        categories: null,
        threatId: null,
      });

      const covered = new Set<string>();
      for (const policy of slice.policies) {
        for (const threatId of policy.threatIds) covered.add(threatId);
      }

      return Object.freeze(
        THREATS.filter((threat) => !covered.has(threat.id)).map((threat) => threat.id),
      );
    },
  });
}

// ── Assessments ─────────────────────────────────────────────────────────────

export interface SecurityAssessmentServiceOptions {
  readonly assessments: SecurityAssessmentRepository;
  readonly findings: SecurityFindingRepository;
  readonly policies: SecurityPolicyRepository;
}

/** What a caller submits when a scan finishes. Ids and instants are supplied. */
export interface RecordAssessmentCommand {
  readonly assessmentId: AssessmentId;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly rulesEvaluated: number;
  readonly scope: SecurityAssessment['scope'];
  /** Each finding without its fingerprint, which is derived. */
  readonly findings: readonly Parameters<typeof createSecurityFinding>[0][];
  /** Supplied, never read from a clock — a future assessment must be refusable. */
  readonly now: string;
}

export interface SecurityAssessmentService {
  /**
   * Record one completed assessment.
   *
   * Validates every finding, refuses a duplicate within the run, checks each
   * finding against the policy and rule it names, then stores. Throws
   * `SecurityError` on anything a report cannot carry — a posture tool that
   * accepted a malformed finding would produce a report nobody can act on.
   */
  recordAssessment(command: RecordAssessmentCommand): Promise<SecurityAssessment>;

  loadAssessment(assessmentId: AssessmentId): Promise<SecurityAssessment | null>;

  /** Move a finding's status. The only mutation, and it is audited by the caller. */
  transitionFinding(input: {
    readonly findingId: string;
    readonly status: FindingStatus;
    readonly at: string;
  }): Promise<SecurityFinding>;
}

export function createSecurityAssessmentService(
  options: SecurityAssessmentServiceOptions,
): SecurityAssessmentService {
  const { assessments, findings, policies } = options;

  return Object.freeze({
    async recordAssessment(command: RecordAssessmentCommand): Promise<SecurityAssessment> {
      const built: SecurityFinding[] = [];

      for (const input of command.findings) {
        // Validated and frozen one at a time, so the first malformed finding
        // names itself rather than failing the whole run anonymously.
        const finding = createSecurityFinding(input);

        // The finding must name a policy and a rule that exist. A finding
        // against an unknown rule is one nobody can trace to a control.
        const policy = await policies.loadPolicy(finding.policyId);
        if (policy === null) {
          throw new SecurityError(
            'UnknownRule',
            'policyId',
            `Finding '${finding.findingId}' names policy '${finding.policyId}', which is not declared.`,
          );
        }
        if (ruleOf(policy, finding.ruleId) === null) {
          throw new SecurityError(
            'UnknownRule',
            'ruleId',
            `Policy '${finding.policyId}' declares no rule '${finding.ruleId}'. A finding against a rule nobody declared cannot be traced to a control.`,
          );
        }

        built.push(finding);
      }

      const assessment = createSecurityAssessment(
        {
          assessmentId: command.assessmentId,
          scope: command.scope,
          startedAt: command.startedAt,
          completedAt: command.completedAt,
          rulesEvaluated: command.rulesEvaluated,
          findings: built,
        },
        command.now,
      );

      await findings.recordFindings(assessment.findings);
      return assessments.saveAssessment(assessment);
    },

    loadAssessment(assessmentId: AssessmentId): Promise<SecurityAssessment | null> {
      return assessments.loadAssessment(assessmentId);
    },

    transitionFinding(input: {
      readonly findingId: string;
      readonly status: FindingStatus;
      readonly at: string;
    }): Promise<SecurityFinding> {
      return findings.transitionFinding(input);
    },
  });
}

// ── The bridge to audit ─────────────────────────────────────────────────────

/** The posture actions that are privileged enough to be audited. */
export const POSTURE_ACTIONS = {
  policyDeclared: 'security.policy.declared',
  policyRetired: 'security.policy.retired',
  assessmentRecorded: 'security.assessment.recorded',
  findingAccepted: 'security.finding.accepted',
  findingResolved: 'security.finding.resolved',
} as const;

export type PostureAction = (typeof POSTURE_ACTIONS)[keyof typeof POSTURE_ACTIONS];

/**
 * A posture action, as the frozen `AuditEvent`.
 *
 * A projection, not a second audit path: the caller hands this to
 * `AuditService.record` inside the same transaction as the change, which is
 * what `audit.md` requires and what this layer cannot do for it without
 * becoming a write path of its own.
 *
 * The category is `administration` — `threat-model.md` T-25 is insider threat,
 * and changing a control or accepting a finding is exactly the operator action
 * that entry is about.
 */
export function toAuditEvent(input: {
  readonly action: PostureAction;
  readonly principal: Principal;
  readonly organizationId: string;
  readonly tenantId: string | null;
  readonly correlationId: string;
  readonly targetKind: string;
  readonly targetId: string;
  readonly reason: string;
  readonly metadata?: Readonly<Record<string, string>>;
}): AuditEvent {
  return deepFreeze({
    category: 'administration' as const,
    action: input.action,
    tenantId: input.tenantId,
    organizationId: input.organizationId,
    actor: { id: input.principal.subjectId, kind: 'user' as const },
    correlationId: input.correlationId,
    target: { kind: input.targetKind, id: input.targetId, tenantId: input.tenantId },
    result: 'success' as const,
    reason: input.reason,
    ipAddress: null,
    userAgent: null,
    sessionId: null,
    stepUpSatisfied: false,
    ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
  });
}
