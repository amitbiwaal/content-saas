/**
 * The ports authentication and authorization depend on.
 *
 * Three, and nothing else: a token verifier, a key directory, an identity
 * directory. The middleware imports no provider adapter, no workflow runtime,
 * no database driver and no SDK — it cannot, because none of them appears in
 * any signature here. A composition root binds these to real implementations.
 *
 * ── Why these are ports and not the services themselves ─────────────────────
 * `packages/platform` owns organizations, workspaces and memberships, and
 * reading them means a transaction. A middleware that opened one would put
 * persistence in the authentication path and make the whole pipeline
 * untestable without a database. The port names the QUESTION; the composition
 * root decides what answers it.
 *
 * ── Everything returns null; nothing throws for absence ─────────────────────
 * A workspace that does not exist and a workspace in another tenant must be
 * indistinguishable, and the only reliable way to keep them so is for the
 * directory to have one way of saying "no".
 */

import type { ApiKeyRecord, AuthenticationResult, RoleBinding } from '@contentos/security';

export interface DirectoryOrganization {
  readonly organizationId: string;
  /** The platform's own vocabulary. Compared, never interpreted. */
  readonly status: string;
}

export interface DirectoryWorkspace {
  readonly workspaceId: string;
  /** Resolved, not claimed — this is where a request's organization comes from. */
  readonly organizationId: string;
  readonly status: string;
}

/**
 * Everything authorization needs to look up.
 *
 * `bindings` returns the subject's ACTIVE role bindings in one organization,
 * already projected — `toRoleBinding` in `@contentos/platform` is the seam that
 * produces them, so a membership that cannot project into one grants nothing
 * here either.
 */
export interface IdentityDirectory {
  organization(organizationId: string): Promise<DirectoryOrganization | null>;
  workspace(workspaceId: string): Promise<DirectoryWorkspace | null>;
  bindings(subjectId: string, organizationId: string): Promise<readonly RoleBinding[]>;
  /**
   * Whether the subject itself is barred, independently of any membership.
   *
   * Separate from membership status because the remedies differ: a suspended
   * user is barred everywhere at once, and revoking each membership instead
   * would leave the account usable wherever one was missed.
   */
  subjectSuspended(subjectId: string): Promise<boolean>;
}

/** Key lookup by the PUBLIC half of a presented key. */
export interface ApiKeyDirectory {
  findByKeyId(keyId: string): Promise<ApiKeyRecord | null>;
}

/**
 * A bearer token verifier.
 *
 * Synchronous by design: verification here is an HMAC and a handful of claim
 * comparisons, with no network in it. An async signature would invite a JWKS
 * fetch into the authentication path, where an unreachable issuer becomes an
 * outage rather than a rejection.
 */
export interface TokenVerifier {
  verify(token: string): AuthenticationResult;
}
