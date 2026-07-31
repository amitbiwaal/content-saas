/**
 * Authentication and authorization middleware.
 *
 * Two steps, kept separate because they answer different questions and fail
 * with different status codes.
 *
 *   AUTHENTICATE — which credential is this, and is it genuine? → 401
 *   AUTHORIZE    — may this identity do this here, right now?   → 403
 *
 * Collapsing them would make "your token is fine but you lack the permission"
 * indistinguishable from "your token is bad", and a client cannot tell whether
 * to re-authenticate or ask for access.
 *
 * ── It does not duplicate the Gateway ───────────────────────────────────────
 * The Gateway also resolves an organization and a workspace, and the checks are
 * deliberately NOT the same:
 *
 *   here    — may this PRINCIPAL act in this workspace? Membership, role,
 *             permission, credential scope. The Gateway has no notion of any
 *             of those; it never sees a role.
 *   Gateway — does this workspace admit AI SPEND? Which is why it refuses a
 *             `past_due` organization and this does not: an unpaid account
 *             keeps reading its own articles and stops buying model calls.
 *
 * The two coincide on `suspended`, and that is the point of overlap rather than
 * duplication: one is the access boundary, the other the admission boundary,
 * and they are free to diverge exactly where the business says they should.
 *
 * ── No permission logic lives here ──────────────────────────────────────────
 * The decision is `evaluate` from `@contentos/security`, unchanged, and the
 * permission set is `authorizationService.permissionsFor`. This file resolves
 * inputs and translates the answer; it decides nothing. A second copy of "does
 * this role grant that" is how two parts of a system come to disagree about
 * who may do what.
 */

import {
  authorizationService,
  evaluate,
  freezeAuthContext,
  type AuthContext,
  type AuthenticationFailure,
  type AuthenticationResult,
  type AuthorizationDenial,
  type AuthorizationResult,
  type DenyReason,
  type Permission,
  type Principal,
  type RoleBinding,
  type Subject,
} from '@contentos/security';

import type { ApiRequest } from '../ai/http.js';
import type { ApiKeyDirectory, IdentityDirectory, TokenVerifier } from './ports.js';
import { parseApiKey, verifyApiKey } from '@contentos/security';

/** The organization status that bars every request. See the file header. */
export const BARRING_ORGANIZATION_STATUS = 'suspended';

/** The only workspace status a request may act in. */
export const ACCESSIBLE_WORKSPACE_STATUS = 'active';

/** The header naming the workspace a request acts in. */
export const WORKSPACE_HEADER = 'x-workspace-id';

const authFailed = (reason: AuthenticationFailure): AuthenticationResult =>
  Object.freeze({ outcome: 'failed' as const, reason });

const denied = (reason: AuthorizationDenial): AuthorizationResult =>
  Object.freeze({ outcome: 'denied' as const, reason });

/**
 * The evaluator's vocabulary, translated into this boundary's.
 *
 * Exhaustive, so a new `DenyReason` in `@contentos/security` fails to compile
 * until someone decides what a caller is told — the alternative is a new denial
 * silently becoming whichever arm a `default:` happened to be.
 *
 * `step-up-required` folds into `insufficient-permission` because step-up
 * challenges are out of scope for this increment: reporting a challenge nothing
 * can answer would send a client into a loop.
 */
const DENIAL_FOR: Readonly<Record<DenyReason, AuthorizationDenial>> = {
  'no-membership': 'membership-required',
  'insufficient-role': 'insufficient-permission',
  'resource-scope': 'insufficient-permission',
  entitlement: 'insufficient-permission',
  'step-up-required': 'insufficient-permission',
  'subject-suspended': 'subject-suspended',
  'no-policy': 'insufficient-permission',
};

export interface AuthMiddlewareOptions {
  readonly tokens: TokenVerifier;
  readonly apiKeys: ApiKeyDirectory;
  readonly directory: IdentityDirectory;
  /** The API key pepper, from the environment. Never a literal. */
  readonly apiKeyPepper: string;
  /** Injected. Nothing here reads a clock of its own. */
  readonly now: () => Date;
}

export interface AuthMiddleware {
  authenticate(request: ApiRequest): Promise<AuthenticationResult>;
  authorize(
    authenticated: Extract<AuthenticationResult, { outcome: 'authenticated' }>,
    request: ApiRequest,
    permission: Permission,
  ): Promise<AuthorizationResult>;
}

/**
 * The request and correlation ids, derived at the edge.
 *
 * Derived HERE and nowhere else. A controller that computed its own would
 * produce a second id for the same request, and the one in an error response
 * would not be the one in the logs. Exported because a 401 happens before an
 * `AuthContext` exists and still has to carry a request id.
 *
 * Headers only: the body is not read, because these ids exist to be present on
 * a request that failed to parse.
 */
export function requestIdsOf(request: ApiRequest): {
  readonly requestId: string;
  readonly correlationId: string;
} {
  const requestHeader = request.headers['x-request-id']?.trim();
  const correlationHeader = request.headers['x-correlation-id']?.trim();

  const correlationId =
    correlationHeader !== undefined && correlationHeader !== ''
      ? correlationHeader
      : requestHeader !== undefined && requestHeader !== ''
        ? requestHeader
        : 'unknown';
  const requestId =
    requestHeader !== undefined && requestHeader !== '' ? requestHeader : correlationId;

  return { requestId, correlationId };
}

/**
 * Which credential was presented.
 *
 * Two credentials at once is refused rather than resolved by precedence. A
 * caller sending both has an ambiguous intent, and picking one silently means
 * the credential that was actually checked is not the one they think.
 */
type Presented =
  | { readonly kind: 'bearer'; readonly value: string }
  | { readonly kind: 'api-key'; readonly value: string }
  | { readonly kind: 'none' }
  | { readonly kind: 'ambiguous' }
  | { readonly kind: 'unsupported' };

export function presentedCredential(request: ApiRequest): Presented {
  const authorization = request.headers['authorization']?.trim() ?? '';
  const apiKeyHeader = request.headers['x-api-key']?.trim() ?? '';

  if (authorization !== '' && apiKeyHeader !== '') return { kind: 'ambiguous' };
  if (authorization === '' && apiKeyHeader === '') return { kind: 'none' };
  if (apiKeyHeader !== '') return { kind: 'api-key', value: apiKeyHeader };

  const separator = authorization.indexOf(' ');
  if (separator === -1) return { kind: 'unsupported' };
  const scheme = authorization.slice(0, separator).toLowerCase();
  const value = authorization.slice(separator + 1).trim();
  if (value === '') return { kind: 'unsupported' };

  if (scheme === 'bearer') return { kind: 'bearer', value };
  if (scheme === 'apikey') return { kind: 'api-key', value };
  return { kind: 'unsupported' };
}

export function createAuthMiddleware(options: AuthMiddlewareOptions): AuthMiddleware {
  const { tokens, apiKeys, directory, apiKeyPepper, now } = options;

  return {
    /** Step one: which credential, and is it genuine? Nothing is looked up. */
    async authenticate(request: ApiRequest): Promise<AuthenticationResult> {
      const presented = presentedCredential(request);

      if (presented.kind === 'none') return authFailed('missing');
      if (presented.kind === 'ambiguous' || presented.kind === 'unsupported') {
        return authFailed('malformed');
      }
      if (presented.kind === 'bearer') return tokens.verify(presented.value);

      const parsed = parseApiKey(presented.value);
      if (parsed === null) return authFailed('malformed');

      const record = await apiKeys.findByKeyId(parsed.keyId);
      // An unknown key id answers exactly as a wrong secret does. Anything else
      // would let an attacker enumerate valid ids without holding one.
      if (record === null) return authFailed('invalid');

      return verifyApiKey(parsed, record, { pepper: apiKeyPepper, now });
    },

    /**
     * Step two: may this identity do this, here?
     *
     * The order is cheapest-and-most-general first, and tenancy before
     * anything that reads tenant-scoped data — the same discipline the
     * Gateway's admission pipeline follows, for the same reason.
     */
    async authorize(
      authenticated: Extract<AuthenticationResult, { outcome: 'authenticated' }>,
      request: ApiRequest,
      permission: Permission,
    ): Promise<AuthorizationResult> {
      const { subject } = authenticated;

      // 1 · The workspace names the tenant, and the tenant names the
      //     organization. A caller never states its own organization: it
      //     states a workspace, and the directory says whose that is.
      const claimedWorkspace =
        request.headers[WORKSPACE_HEADER]?.trim() ??
        // An API key bound to one workspace does not need to be told which.
        authenticated.workspaceId ??
        '';
      if (claimedWorkspace === '') return denied('workspace-unknown');

      const workspace = await directory.workspace(claimedWorkspace);
      // Unknown and out-of-reach are the same answer, deliberately.
      if (workspace === null) return denied('workspace-unknown');

      const organization = await directory.organization(workspace.organizationId);
      if (organization === null) return denied('organization-unknown');

      // 2 · Tenant state. Only `suspended` bars access — see the file header
      //     for why `past_due` is the Gateway's business and not this one's.
      if (organization.status === BARRING_ORGANIZATION_STATUS) {
        return denied('organization-suspended');
      }
      if (workspace.status !== ACCESSIBLE_WORKSPACE_STATUS) {
        return denied('workspace-inaccessible');
      }

      // 3 · The credential's own scope. A binding RESTRICTS; it never grants,
      //     so this can only ever narrow what follows.
      if (
        (authenticated.organizationId !== null &&
          authenticated.organizationId !== organization.organizationId) ||
        (authenticated.workspaceId !== null && authenticated.workspaceId !== workspace.workspaceId)
      ) {
        return denied('credential-scope');
      }

      // 4 · The decision itself, made by the evaluator and not by this file.
      const at = now();
      const bindings = await directory.bindings(subject.subjectId, organization.organizationId);
      const decision = evaluate({
        subject,
        action: permission,
        resource: {
          kind: 'workspace',
          id: workspace.workspaceId,
          tenantId: workspace.workspaceId,
          organizationId: organization.organizationId,
          ownerId: null,
        },
        bindings,
        at,
        subjectSuspended: await directory.subjectSuspended(subject.subjectId),
      });
      if (decision.effect === 'deny') return denied(DENIAL_FOR[decision.reason]);

      return Object.freeze({
        outcome: 'authorized' as const,
        context: contextFor({
          request,
          subject,
          bindings,
          organizationId: organization.organizationId,
          organizationStatus: organization.status,
          workspaceId: workspace.workspaceId,
          workspaceStatus: workspace.status,
          at,
        }),
      });
    },
  };
}

interface ContextInput {
  readonly request: ApiRequest;
  readonly subject: Subject;
  readonly bindings: readonly RoleBinding[];
  readonly organizationId: string;
  readonly organizationStatus: string;
  readonly workspaceId: string;
  readonly workspaceStatus: string;
  readonly at: Date;
}

/**
 * Build the context a controller receives.
 *
 * `permissions` comes from `authorizationService.permissionsFor` — the same
 * resolution the decision used — and NEVER from a token claim. A caller that
 * could name its own permissions would be authorizing itself.
 */
function contextFor(input: ContextInput): AuthContext {
  const { requestId, correlationId } = requestIdsOf(input.request);

  const relevant = input.bindings.filter(
    (binding) =>
      binding.subjectId === input.subject.subjectId &&
      binding.organizationId === input.organizationId &&
      (binding.tier === 'organization' || binding.workspaceId === input.workspaceId),
  );

  const principal: Principal = {
    subjectId: input.subject.subjectId,
    kind: input.subject.kind,
    method: input.subject.method,
    organizationId: input.organizationId,
    workspaceId: input.workspaceId,
    roles: relevant.map((binding) => binding.role),
    permissions: [
      ...authorizationService.permissionsFor(
        relevant,
        input.workspaceId,
        input.organizationId,
        input.at,
      ),
    ],
    authenticatedAt: input.subject.authenticatedAt,
    mfaSatisfied: input.subject.mfaSatisfied,
    sessionId: input.subject.sessionId,
  };

  return freezeAuthContext({
    requestId,
    correlationId,
    principal,
    organization: { id: input.organizationId, status: input.organizationStatus },
    workspace: { id: input.workspaceId, status: input.workspaceStatus },
  });
}
