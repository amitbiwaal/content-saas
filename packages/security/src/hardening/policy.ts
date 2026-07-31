/**
 * Security policies — the controls the platform claims to have.
 *
 * ── A policy DESCRIBES a control. It is not the control ────────────────────
 * The controls exist and are frozen: `authz/evaluator.ts` decides access, RLS
 * confines a query, `ratelimit/` throttles, the credential backstop redacts,
 * `AuditService` records. A policy here says "this control is claimed against
 * this threat, and this is how it is verified" — nothing in this module
 * authenticates, authorizes, blocks or enforces anything, and a module that
 * could would be able to weaken what it is supposed to report on.
 *
 * ── Why a policy is worth having as data ───────────────────────────────────
 * Every mitigation in the platform cites a threat by number, in a comment.
 * Comments cannot answer "which of the twenty-six threats has no declared
 * control", which is the question an assessment exists to ask, and the one
 * nobody can answer by reading twenty files.
 *
 * ── Every policy names a threat the document declares ──────────────────────
 * A policy against `T-99` is a control for a threat nobody has assessed, and a
 * report counting it as coverage would say the platform is protected against
 * something imaginary.
 */

import {
  assertIdentifier,
  assertInstant,
  assertPresent,
  deepFreeze,
  SecurityError,
} from './errors.js';
import {
  isKnownThreat,
  isSecurityCategory,
  isSecuritySeverity,
  isThreatIdShape,
  threatOf,
  type SecurityCategory,
  type SecuritySeverity,
  type ThreatId,
} from './threats.js';

/**
 * How a control is applied.
 *
 * `enforced` is a control that refuses — RLS, the authorization evaluator, the
 * rate limiter. `detective` finds afterwards — the credential backstop firing,
 * chain verification. `manual` is a process, and is recorded rather than
 * pretended: `threat-model.md` accepts residual risk explicitly, and a policy
 * that claimed automation it does not have is worse than one that admits a
 * human step.
 */
export const ENFORCEMENT_MODES = ['enforced', 'detective', 'manual'] as const;

export type EnforcementMode = (typeof ENFORCEMENT_MODES)[number];

export function isEnforcementMode(value: unknown): value is EnforcementMode {
  return typeof value === 'string' && (ENFORCEMENT_MODES as readonly string[]).includes(value);
}

/**
 * Whether the policy is in force.
 *
 * `retired` rather than deleted: an assessment from last quarter cites policies
 * by id, and a deleted one would make that report unreadable.
 */
export const POLICY_STATUSES = ['active', 'draft', 'retired'] as const;

export type PolicyStatus = (typeof POLICY_STATUSES)[number];

export function isPolicyStatus(value: unknown): value is PolicyStatus {
  return typeof value === 'string' && (POLICY_STATUSES as readonly string[]).includes(value);
}

export type PolicyId = string;

/** A checkable rule inside a policy. What a scan reports a result against. */
export interface SecurityRule {
  readonly id: string;
  /** What it checks, in one sentence. Shown in a report. */
  readonly description: string;
  /** How bad it is when this rule fails. May differ from the threat's own. */
  readonly severity: SecuritySeverity;
}

export interface SecurityPolicy {
  readonly policyId: PolicyId;
  readonly title: string;
  /** The threats this control mitigates. At least one, all declared. */
  readonly threatIds: readonly ThreatId[];
  readonly category: SecurityCategory;
  readonly enforcement: EnforcementMode;
  readonly status: PolicyStatus;
  /** The rules a scan evaluates. At least one, or nothing can be assessed. */
  readonly rules: readonly SecurityRule[];
  /** Where the control actually lives. A reference, never a filesystem path. */
  readonly owner: string;
  readonly createdAt: string;
}

export const MAX_TEXT_LENGTH = 512;

function assertText(value: unknown, field: string, why: string): string {
  assertPresent(value, field, why);
  const text = value as string;
  if (text.length > MAX_TEXT_LENGTH) {
    throw new SecurityError(
      'InvalidPolicy',
      field,
      `'${field}' is ${String(text.length)} characters; the limit is ${String(MAX_TEXT_LENGTH)}. A report field long enough to hold a stack trace eventually holds one.`,
    );
  }
  return text;
}

export function assertValidRule(rule: SecurityRule, field = 'rule'): SecurityRule {
  assertIdentifier(rule.id, `${field}.id`);
  assertText(
    rule.description,
    `${field}.description`,
    'a rule nobody can read is one nobody acts on.',
  );

  if (!isSecuritySeverity(rule.severity)) {
    throw new SecurityError(
      'InvalidSeverity',
      `${field}.severity`,
      `'${String(rule.severity)}' is not a severity. The four in threat-model.md drive response time; a fifth would drive nothing.`,
    );
  }
  return rule;
}

/**
 * Validate a policy, refusing everything a report cannot carry safely.
 *
 * Ordering: identity, then the threats it claims, then the enumerations, then
 * the rules. A policy with no id is refused before anybody checks whether the
 * threats it names exist.
 */
export function assertValidPolicy(policy: SecurityPolicy): SecurityPolicy {
  assertIdentifier(policy.policyId, 'policyId');
  assertText(policy.title, 'title', 'a policy nobody can read is one nobody reviews.');
  assertIdentifier(policy.owner, 'owner');
  assertInstant(policy.createdAt, 'createdAt');

  if (policy.threatIds.length === 0) {
    throw new SecurityError(
      'InvalidPolicy',
      'threatIds',
      'A policy mitigates at least one threat. A control against nothing cannot be assessed and cannot be retired.',
    );
  }

  const seen = new Set<ThreatId>();
  for (const threatId of policy.threatIds) {
    if (!isThreatIdShape(threatId)) {
      throw new SecurityError(
        'MalformedIdentifier',
        'threatIds',
        `'${String(threatId)}' is not a threat identifier. The document numbers them T-01 through T-26.`,
      );
    }
    if (!isKnownThreat(threatId)) {
      throw new SecurityError(
        'UnknownThreat',
        'threatIds',
        `'${threatId}' is not a threat this build declares. A policy against an undeclared threat would be counted as coverage for something imaginary.`,
      );
    }
    if (seen.has(threatId)) {
      throw new SecurityError(
        'InvalidPolicy',
        'threatIds',
        `Threat '${threatId}' is listed twice. A policy either mitigates a threat or it does not.`,
      );
    }
    seen.add(threatId);
  }

  if (!isSecurityCategory(policy.category)) {
    throw new SecurityError(
      'InvalidCategory',
      'category',
      `'${String(policy.category)}' is not a security category.`,
    );
  }
  if (!isEnforcementMode(policy.enforcement)) {
    throw new SecurityError(
      'InvalidPolicy',
      'enforcement',
      `'${String(policy.enforcement)}' is not an enforcement mode. Available: ${ENFORCEMENT_MODES.join(', ')}.`,
    );
  }
  if (!isPolicyStatus(policy.status)) {
    throw new SecurityError(
      'InvalidPolicy',
      'status',
      `'${String(policy.status)}' is not a policy status. Available: ${POLICY_STATUSES.join(', ')}.`,
    );
  }

  if (policy.rules.length === 0) {
    throw new SecurityError(
      'InvalidPolicy',
      'rules',
      'A policy declares at least one rule. A policy with none can never pass or fail, so it would sit in every report saying nothing.',
    );
  }

  const ruleIds = new Set<string>();
  for (const rule of policy.rules) {
    assertValidRule(rule, `rules.${rule.id}`);
    if (ruleIds.has(rule.id)) {
      throw new SecurityError(
        'InvalidPolicy',
        'rules',
        `Rule '${rule.id}' is declared twice; a scan result could not say which one it was for.`,
      );
    }
    ruleIds.add(rule.id);
  }

  return policy;
}

/** Build a policy, validated and deep-frozen. The only way to make one. */
export function createSecurityPolicy(policy: SecurityPolicy): SecurityPolicy {
  assertValidPolicy(policy);
  return deepFreeze({
    ...policy,
    threatIds: [...policy.threatIds],
    rules: policy.rules.map((rule) => ({ ...rule })),
  });
}

/** Does this policy declare that rule? The `UnknownRule` question. */
export function ruleOf(policy: SecurityPolicy, ruleId: string): SecurityRule | null {
  return policy.rules.find((rule) => rule.id === ruleId) ?? null;
}

/**
 * The inherent severity of the worst threat a policy covers.
 *
 * What a reviewer sorts by: a control over a Critical threat is reviewed before
 * one over a Low, whatever its own rules say.
 */
export function inherentSeverity(policy: SecurityPolicy): SecuritySeverity | null {
  let worst: SecuritySeverity | null = null;
  for (const threatId of policy.threatIds) {
    const threat = threatOf(threatId);
    if (threat === null) continue;
    if (worst === null || rank(threat.severity) < rank(worst)) worst = threat.severity;
  }
  return worst;
}

const rank = (severity: SecuritySeverity): number =>
  ['critical', 'high', 'medium', 'low'].indexOf(severity);
