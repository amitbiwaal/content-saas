/**
 * Authorization engine — `16-security/authorization.md`.
 *
 * Every evaluation is DETERMINISTIC: a pure function of (subject, action,
 * resource, bindings, clock). No I/O happens inside the decision; bindings are
 * resolved first and passed in, so the same inputs always produce the same
 * decision and the evaluator is testable without a database.
 *
 * The default is DENY with `no-policy`. Nothing is permitted because nothing
 * refused it.
 */

import type { Subject } from '../authn/subject.js';
import type { ResourceRef } from '../tenant/context.js';
import {
  ROLE_PERMISSIONS,
  tierOf,
  type Permission,
  type RoleName,
  type RoleTier,
} from './permissions.js';

export type AuthorizationDecision =
  | { readonly effect: 'allow' }
  | { readonly effect: 'deny'; readonly reason: DenyReason; readonly auditDetail: string };

export type DenyReason =
  | 'no-membership'
  | 'insufficient-role'
  | 'resource-scope'
  | 'entitlement'
  | 'step-up-required'
  | 'subject-suspended'
  | 'no-policy';

export interface RoleBinding {
  readonly subjectId: string;
  readonly subjectKind: 'user' | 'api-key' | 'service';
  readonly role: RoleName;
  readonly tier: RoleTier;
  readonly organizationId: string;
  /** null for organization-tier. */
  readonly workspaceId: string | null;
  /** null = all projects; `[]` is INVALID. */
  readonly projectScope: readonly string[] | null;
  readonly grantedBy: string;
  readonly grantedAt: Date;
  readonly expiresAt: Date | null;
  readonly status?: 'active' | 'revoked';
}

export class AuthorizationError extends Error {
  readonly reason: DenyReason;
  readonly auditDetail: string;
  constructor(reason: DenyReason, auditDetail: string) {
    // The message is deliberately uniform: a richer message would leak whether
    // a resource exists.
    super('Forbidden');
    this.name = 'AuthorizationError';
    this.reason = reason;
    this.auditDetail = auditDetail;
  }
}

/**
 * `projectScope: []` is invalid and rejected at write time. An empty array
 * reads as either "no projects" or "unset", and the two interpretations differ
 * by everything.
 */
export function assertValidBinding(binding: RoleBinding): void {
  if (binding.projectScope !== null && binding.projectScope.length === 0) {
    throw new Error(
      'projectScope [] is invalid: null means all projects; a non-empty array means those projects.',
    );
  }
  if (binding.tier === 'organization' && binding.workspaceId !== null) {
    throw new Error('An organization-tier binding must have workspaceId null.');
  }
  if (binding.tier === 'workspace' && binding.workspaceId === null) {
    throw new Error('A workspace-tier binding must name a workspaceId.');
  }
  if (tierOf(binding.role) !== binding.tier) {
    throw new Error(`Role '${binding.role}' does not belong to the ${binding.tier} tier.`);
  }
}

/**
 * Expiry is evaluated AT DECISION TIME, not by a sweep, so there is no window
 * in which a lapsed grant still works.
 */
export function isBindingActive(binding: RoleBinding, at: Date): boolean {
  if (binding.status === 'revoked') return false;
  if (binding.expiresAt !== null && at >= binding.expiresAt) return false;
  return true;
}

/**
 * Resolve the permission set. Returns a `Set`, making the additive union
 * explicit in the type and precluding an implementation that accidentally
 * introduces precedence.
 */
export function resolvePermissions(
  bindings: readonly RoleBinding[],
  tenantId: string,
  organizationId: string,
  projectId: string | null,
  at: Date,
): Set<Permission> {
  const granted = new Set<Permission>();

  for (const binding of bindings) {
    if (!isBindingActive(binding, at)) continue;
    if (binding.organizationId !== organizationId) continue;

    if (binding.tier === 'workspace') {
      if (binding.workspaceId !== tenantId) continue;
      // Project scope is authorization, not isolation: it is enforced here and
      // is NOT backed by RLS.
      if (binding.projectScope !== null) {
        if (projectId === null || !binding.projectScope.includes(projectId)) continue;
      }
    }

    for (const permission of ROLE_PERMISSIONS[binding.role]) {
      granted.add(permission);
    }
  }

  return granted;
}

export interface EvaluationInput {
  readonly subject: Subject;
  readonly action: Permission;
  readonly resource: ResourceRef;
  readonly bindings: readonly RoleBinding[];
  readonly at: Date;
  /** Project the resource belongs to, where the resource is project-scoped. */
  readonly projectId?: string | null;
  /** Sensitive operations require fresh MFA. */
  readonly requiresStepUp?: boolean;
  readonly subjectSuspended?: boolean;
  /** Plan capability check, resolved by the caller from entitlements. */
  readonly entitled?: boolean;
}

/**
 * The decision. Pure and total — every path returns explicitly, and the final
 * fallthrough is `no-policy`.
 *
 * Order matters and is fixed, so the reported reason is stable for a given
 * input rather than depending on evaluation order.
 */
export function evaluate(input: EvaluationInput): AuthorizationDecision {
  const { subject, action, resource, bindings, at } = input;

  if (input.subjectSuspended === true) {
    return {
      effect: 'deny',
      reason: 'subject-suspended',
      auditDetail: `subject ${subject.subjectId} is suspended`,
    };
  }

  if (input.entitled === false) {
    return {
      effect: 'deny',
      reason: 'entitlement',
      auditDetail: `plan does not include ${action}`,
    };
  }

  const active = bindings.filter(
    (b) => b.subjectId === subject.subjectId && isBindingActive(b, at),
  );
  const inOrg = active.filter((b) => b.organizationId === resource.organizationId);
  if (inOrg.length === 0) {
    return {
      effect: 'deny',
      reason: 'no-membership',
      auditDetail: `no active binding for ${subject.subjectId} in organization ${resource.organizationId}`,
    };
  }

  const projectId = input.projectId ?? null;
  const granted = resolvePermissions(
    inOrg,
    resource.tenantId,
    resource.organizationId,
    projectId,
    at,
  );

  if (granted.has(action)) {
    // Step-up is checked LAST among allows: a subject who lacks the permission
    // entirely is told `insufficient-role`, not `step-up-required`, so a
    // challenge is never issued for an operation that would fail anyway.
    if (input.requiresStepUp === true && !subject.mfaSatisfied) {
      return {
        effect: 'deny',
        reason: 'step-up-required',
        auditDetail: `fresh MFA required for ${action}`,
      };
    }
    return { effect: 'allow' };
  }

  // Distinguish "the role lacks it" from "the project scope excluded it", since
  // the remedies differ entirely.
  //
  // The bindings are stripped of their project scope rather than passed with
  // `projectId: null`. Those are NOT the same question: `projectId: null` means
  // "this resource belongs to no project", under which a project-scoped binding
  // correctly grants nothing. Here the question is "what would this subject
  // hold if project scope were not applied", which needs the scope removed.
  const unscoped = resolvePermissions(
    inOrg.map((b) => ({ ...b, projectScope: null })),
    resource.tenantId,
    resource.organizationId,
    null,
    at,
  );
  const hasWorkspaceBinding = inOrg.some(
    (b) => b.tier === 'workspace' && b.workspaceId === resource.tenantId,
  );

  if (projectId !== null && unscoped.has(action)) {
    return {
      effect: 'deny',
      reason: 'resource-scope',
      auditDetail: `project ${projectId} outside granted scope`,
    };
  }

  if (hasWorkspaceBinding || unscoped.size > 0) {
    return {
      effect: 'deny',
      reason: 'insufficient-role',
      auditDetail: `role lacks ${action}`,
    };
  }

  // DEFAULT — nothing granted it.
  return {
    effect: 'deny',
    reason: 'no-policy',
    auditDetail: `no policy grants ${action} on ${resource.kind}:${resource.id}`,
  };
}

export interface AuthorizationService {
  /** Throws on denial — the failure path is unmissable. */
  require(input: EvaluationInput): void;
  /** Returns a decision — for UI affordances that need one without failing. */
  check(input: EvaluationInput): AuthorizationDecision;
  /** Set-wise evaluation, so list endpoints do not authorize in a loop. */
  filter<T extends ResourceRef>(
    input: Omit<EvaluationInput, 'resource'>,
    resources: readonly T[],
  ): T[];
  permissionsFor(
    bindings: readonly RoleBinding[],
    tenantId: string,
    organizationId: string,
    at: Date,
  ): Set<Permission>;
}

export const authorizationService: AuthorizationService = {
  require(input): void {
    const decision = evaluate(input);
    if (decision.effect === 'deny') {
      // Forgetting to inspect a returned value is a silent authorization
      // bypass; forgetting to catch an exception is a 500, which fails closed.
      throw new AuthorizationError(decision.reason, decision.auditDetail);
    }
  },

  check(input): AuthorizationDecision {
    return evaluate(input);
  },

  filter<T extends ResourceRef>(
    input: Omit<EvaluationInput, 'resource'>,
    resources: readonly T[],
  ): T[] {
    return resources.filter((resource) => evaluate({ ...input, resource }).effect === 'allow');
  },

  permissionsFor(bindings, tenantId, organizationId, at): Set<Permission> {
    return resolvePermissions(bindings, tenantId, organizationId, null, at);
  },
};
