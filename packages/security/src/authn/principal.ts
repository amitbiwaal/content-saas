/**
 * The Principal — resolved identity for ONE request.
 *
 * ── Why this exists next to `Subject`, and does not replace it ──────────────
 * `Subject` is what a credential proves: who you are, how you proved it, when.
 * It deliberately carries no tenant and no permissions, and the note on it says
 * why — "a token minted before a permission change would carry stale authority
 * until it expired."
 *
 * A `Principal` is what that identity MEANS right now, in one organization and
 * one workspace: the roles actually held and the permissions those roles
 * actually grant, resolved at request time from live bindings.
 *
 * The distinction is the whole security property. Permissions are never read
 * from a token claim; they are computed by `resolvePermissions` from bindings
 * fetched during the request. A JWT that carries `roles` or `permissions` in
 * its payload is ignored, because a caller that could name its own roles would
 * be authorizing itself.
 *
 * ── Immutable, and frozen rather than merely readonly ───────────────────────
 * `readonly` is a compile-time promise that a cast erases. These are deep
 * frozen, so a downstream component that tries to widen its own authority
 * fails at runtime instead of succeeding silently. A principal is evidence of a
 * decision already made; anything that edits it is rewriting the decision.
 */

import type { Permission, RoleName } from '../authz/permissions.js';
import type { AuthMethod, Subject } from './subject.js';

/**
 * Who is acting, where, and with what.
 *
 * `organizationId` and `workspaceId` are RESOLVED, never claimed: they name
 * records the directory returned, not values a caller sent. That is what stops
 * `workspaceId` in a request body from being a tenancy assertion.
 */
export interface Principal {
  readonly subjectId: string;
  readonly kind: Subject['kind'];
  /** How identity was proven. Never used to decide what may be done. */
  readonly method: AuthMethod;
  readonly organizationId: string;
  /** The workspace this request acts in — the tenant (ADR-017). */
  readonly workspaceId: string;
  /** Roles actually held here, organization tier and workspace tier together. */
  readonly roles: readonly RoleName[];
  /** What those roles grant. Computed per request, never read from a token. */
  readonly permissions: readonly Permission[];
  readonly authenticatedAt: Date;
  readonly mfaSatisfied: boolean;
  /** null for API keys and services, which have no session. */
  readonly sessionId: string | null;
}

/**
 * The request's identity, plus the two ids that make it traceable.
 *
 * This is what a controller receives INSTEAD OF the headers it used to read.
 * Everything a handler needs to know about who is calling is here, which is
 * what makes "controllers never inspect an Authorization header" enforceable
 * rather than a convention.
 */
export interface AuthContext {
  readonly requestId: string;
  readonly correlationId: string;
  readonly principal: Principal;
  readonly organization: { readonly id: string; readonly status: string };
  readonly workspace: { readonly id: string; readonly status: string };
}

/**
 * Why authentication failed — ONE opaque reason per class.
 *
 * Deliberately coarse, for the reason `AuthResult` gives: a richer vocabulary
 * eventually reaches a response or a log and becomes an enumeration oracle.
 * These distinguish only what a caller can act on. "Which claim was wrong" and
 * "the signature did not verify" are the same answer here — `invalid` — and the
 * detail stays in the audit record.
 */
export const AUTHENTICATION_FAILURES = [
  'missing',
  'malformed',
  'invalid',
  'expired',
  'not-yet-valid',
  'revoked',
] as const;

export type AuthenticationFailure = (typeof AUTHENTICATION_FAILURES)[number];

/**
 * What a verified credential established, before any tenancy is resolved.
 *
 * `subject` is the proven identity. `organizationId` / `workspaceId` are the
 * BINDING the credential itself carries — an API key issued for one workspace
 * cannot act in another — and are null for a credential that binds neither.
 */
export type AuthenticationResult =
  | {
      readonly outcome: 'authenticated';
      readonly subject: Subject;
      readonly organizationId: string | null;
      readonly workspaceId: string | null;
    }
  | { readonly outcome: 'failed'; readonly reason: AuthenticationFailure };

/**
 * Why authorization denied.
 *
 * Wider than the authentication vocabulary on purpose: an authenticated caller
 * is not an attacker probing for accounts, and telling them "your organization
 * is suspended" rather than a flat "forbidden" is the difference between a
 * support ticket and a guess. None of these names another tenant or reveals
 * whether a resource exists.
 */
export const AUTHORIZATION_DENIALS = [
  'organization-unknown',
  'organization-suspended',
  'workspace-unknown',
  'workspace-inaccessible',
  'subject-suspended',
  'membership-required',
  'insufficient-permission',
  'credential-scope',
] as const;

export type AuthorizationDenial = (typeof AUTHORIZATION_DENIALS)[number];

export type AuthorizationResult =
  | { readonly outcome: 'authorized'; readonly context: AuthContext }
  | { readonly outcome: 'denied'; readonly reason: AuthorizationDenial };

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.getOwnPropertyNames(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

/** A principal, frozen through. See the file header for why freezing matters. */
export function freezePrincipal(principal: Principal): Principal {
  return deepFreeze(principal);
}

/** An auth context, frozen through, principal included. */
export function freezeAuthContext(context: AuthContext): AuthContext {
  return deepFreeze(context);
}

/**
 * The `Subject` the authorization evaluator wants.
 *
 * One conversion, here, rather than a second identity type: `evaluate` takes a
 * `Subject`, a `Principal` has everything one needs, and re-deriving it at each
 * call site is how the two drift.
 */
export function subjectOf(principal: Principal): Subject {
  return Object.freeze({
    subjectId: principal.subjectId,
    kind: principal.kind,
    authenticatedAt: principal.authenticatedAt,
    method: principal.method,
    mfaSatisfied: principal.mfaSatisfied,
    sessionId: principal.sessionId,
  });
}

/** Whether this principal holds a permission. Reads the resolved set only. */
export function holds(principal: Principal, permission: Permission): boolean {
  return principal.permissions.includes(permission);
}
