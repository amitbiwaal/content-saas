/**
 * Authentication and authorization failures, as HTTP.
 *
 * ── Two vocabularies, two status codes, and no leakage between them ─────────
 * Every authentication failure is a 401 and every authorization denial is a
 * 403. That is not a simplification — it is the boundary. A 401 says "this
 * credential did not work"; a 403 says "this identity may not". A caller uses
 * the difference to decide whether to re-authenticate or ask for access, and
 * nothing finer than that is safe to tell them.
 *
 * The tables are exhaustive `Record`s over both vocabularies, so adding a
 * reason in `@contentos/security` fails the build until someone decides what a
 * caller sees. A `default:` arm would let a new reason become whichever status
 * happened to be last.
 *
 * ── What never appears in these responses ───────────────────────────────────
 * No JWT payload, no claim, no signature detail, no key id, no stack trace, no
 * organization or workspace name, no statement about whether a resource exists.
 * The reason is carried in the AUDIT record, where it belongs; the response
 * body is the frozen envelope with a message derived from its code, which is
 * why `errorFor` has no message parameter (see `ai/http.ts`).
 */

import type { AuthenticationFailure, AuthorizationDenial } from '@contentos/security';

import { errorFor, type ApiResponse } from '../ai/http.js';

/**
 * The challenge a 401 must carry.
 *
 * RFC 7235 requires `WWW-Authenticate` on every 401, and omitting it is how a
 * client library ends up unable to tell an authentication failure from a
 * generic refusal. Both schemes are advertised because both are accepted.
 */
export const WWW_AUTHENTICATE = 'Bearer realm="contentos", ApiKey realm="contentos"';

/** Every way authentication can fail. All 401 — see the file header. */
const STATUS_FOR_FAILURE: Readonly<Record<AuthenticationFailure, 401>> = {
  missing: 401,
  malformed: 401,
  invalid: 401,
  expired: 401,
  'not-yet-valid': 401,
  revoked: 401,
};

/** Every way authorization can deny. All 403. */
const STATUS_FOR_DENIAL: Readonly<Record<AuthorizationDenial, 403>> = {
  'organization-unknown': 403,
  'organization-suspended': 403,
  'workspace-unknown': 403,
  'workspace-inaccessible': 403,
  'subject-suspended': 403,
  'membership-required': 403,
  'insufficient-permission': 403,
  'credential-scope': 403,
};

export function unauthenticatedResponse(
  reason: AuthenticationFailure,
  requestId: string,
): ApiResponse {
  return errorFor(STATUS_FOR_FAILURE[reason], 'unauthenticated', requestId, undefined, {
    'www-authenticate': WWW_AUTHENTICATE,
  });
}

export function forbiddenResponse(reason: AuthorizationDenial, requestId: string): ApiResponse {
  return errorFor(STATUS_FOR_DENIAL[reason], 'forbidden', requestId);
}
