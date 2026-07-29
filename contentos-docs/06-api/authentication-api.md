# Authentication API

> **Status:** v1.0 — complete. Phase 12. **Contracts only.**
> **Authentication behaviour is specified by `16-security/authentication.md` and is not redefined here.** This document defines the HTTP surface: paths, schemas, status codes, and what each call records.

## Overview

**Purpose.** Define the endpoints for login, session lifecycle, MFA, password reset, and email verification.

**Two contract properties drive every schema below**, both from Phase 9:

**No token carries authority.** Access tokens contain identity claims only — subject, issued-at, expiry, audience. No permissions, no roles, and **no `tenantId`**. Permissions are evaluated per request against current state, which is what makes revocation immediate.

**Failure responses are uniform.** Wrong password, unknown email, and disabled account return the same code, the same body, and in the same time. Any distinguishable response turns these endpoints into an account enumeration oracle.

> **Note on the pre-existing placeholder.** `06-api/authentication.md` specified tokens carrying `tenant_id` and `roles`. That predates and contradicts `16-security/authentication.md`. This document follows the approved decision.

## Common contract

| Property | Value |
|---|---|
| Base path | `/v1/auth` |
| Session transport | `HttpOnly; Secure; SameSite=Lax` cookie |
| Bearer transport | `Authorization: Bearer <accessToken>` for programmatic clients |
| Rate-limit class | **`auth`** on every endpoint — plus pre-authentication IP limiting |
| CSRF | Required on cookie-authenticated mutations |
| Audit | **Every endpoint here writes an audit record** (`16-security/audit.md`) |

**Every authentication endpoint is rate limited twice** — by IP before authentication and by subject after. Credential stuffing and enumeration happen without valid credentials, so a post-auth-only limit protects nothing (`16-security/api-security.md`).

## Login

| Field | Value |
|---|---|
| **Purpose** | Verify a credential and establish a session |
| **Method · Path** | `POST /v1/auth/login` |
| **Authorization** | None |
| **Idempotency** | Not applicable — repeated calls create distinct sessions |
| **Rate limit** | `auth` |
| **Events** | None on success; `SecurityAuthenticationFailed` on repeated failure |
| **Audit** | Success, failure, and MFA challenge all recorded with IP and user agent |

```ts
// request
{ email: string; password: string; }

// 200 — authenticated
{ user: { id: string; email: string; name: string }; expiresAt: string; }

// 200 — MFA required
{ mfaRequired: true; challengeId: string; factors: ('webauthn' | 'totp' | 'recovery')[]; }

// 401 — ALWAYS this shape, whatever the cause
{ error: { code: 'SECURITY_AUTHENTICATION_FAILED', message: 'Invalid credentials', requestId } }
```

| Error | Code | Status |
|---|---|---|
| Any credential failure | `SECURITY_AUTHENTICATION_FAILED` | 401 |
| Account locked | `SECURITY_AUTHENTICATION_FAILED` | 401 |
| SSO required for this domain | `AUTH_SSO_REQUIRED` | 409 |
| Rate limited | `RATE_LIMITED` | 429 |

**`401` is returned for every credential failure without distinction**, and responses are timing-equalised. A faster "unknown email" path leaks membership even when the body is identical.

**`AUTH_SSO_REQUIRED` is the one permitted disclosure**, because the client must be redirected to the organization's IdP. It reveals that a domain is SSO-enforced, which is already observable from the login page, and returning `401` instead would make SSO users unable to sign in at all.

**The response body carries no session token.** The session is set as a cookie; programmatic clients receive tokens from `/token` below. A token in a login response body is copied into logs and browser storage.

## MFA verification

| Field | Value |
|---|---|
| **Purpose** | Complete a challenge issued by login or step-up |
| **Method · Path** | `POST /v1/auth/mfa/verify` |
| **Authorization** | A valid `challengeId` |
| **Idempotency** | No — codes are single-use |
| **Rate limit** | `auth`, tightened per challenge |
| **Events** | None |
| **Audit** | Factor, outcome, and attempt count recorded |

```ts
// request
{ challengeId: string; factor: 'webauthn' | 'totp' | 'recovery'; response: string; }

// 200
{ user: { id, email, name }; expiresAt: string; }
```

| Error | Code | Status |
|---|---|---|
| Wrong or expired code | `SECURITY_MFA_FAILED` | 401 |
| Challenge expired | `SECURITY_MFA_CHALLENGE_EXPIRED` | 401 |
| Too many attempts | `SECURITY_MFA_LOCKED` | 429 |

**SMS is not an available factor.** It is the most familiar second factor and the weakest — SIM-swap requires no technical sophistication — and offering it would let an organization believe it has MFA while holding a factor obtainable from a phone carrier (`16-security/authentication.md`).

**Attempt limits are per challenge, not only per account.** A TOTP code has ~10⁶ possibilities; unbounded attempts against one challenge is a brute-force window.

## Token issuance and refresh

| Field | Value |
|---|---|
| **Purpose** | Issue and rotate bearer tokens for programmatic clients |
| **Method · Path** | `POST /v1/auth/token` · `POST /v1/auth/refresh` |
| **Authorization** | Valid session (`/token`) or refresh token (`/refresh`) |
| **Idempotency** | No — **rotation is the point** |
| **Rate limit** | `auth` |
| **Events** | None |
| **Audit** | Issuance and **reuse detection** recorded |

```ts
// POST /v1/auth/refresh
{ refreshToken: string; }

// 200 — BOTH tokens are new
{ accessToken: string; refreshToken: string; expiresIn: 900; tokenType: 'Bearer'; }
```

| Error | Code | Status |
|---|---|---|
| Invalid or expired refresh token | `SECURITY_AUTHENTICATION_FAILED` | 401 |
| **Reuse of a rotated token** | `SECURITY_TOKEN_REUSE_DETECTED` | 401 |

**Refresh rotates both tokens; the presented refresh token is invalidated immediately.** A client that stores only the access token and retries with the old refresh token will fail — correctly.

**Reuse of an already-rotated refresh token revokes the entire session family.** The platform cannot distinguish the legitimate holder from a thief, so both are logged out. This is the platform's primary token-theft signal and it pages (`16-security/security-observability.md`).

**Access tokens are 15 minutes because they cannot be revoked.** Lengthening them to reduce refresh traffic trades a bounded compromise window for an unbounded one.

**Tokens carry no permissions, roles, or tenant.** A client cannot inspect a token to learn what it may do; it calls the resource and receives `403` or `404`.

## Session

| Field | Value |
|---|---|
| **Purpose** | Return the current subject; enumerate and revoke sessions |
| **Method · Path** | `GET /v1/auth/session` · `GET /v1/auth/sessions` · `DELETE /v1/auth/sessions/{sessionId}` |
| **Authorization** | Authenticated |
| **Idempotency** | `DELETE` is idempotent |
| **Rate limit** | `read` for `GET`, `auth` for `DELETE` |
| **Events** | None |
| **Audit** | Revocation recorded with reason |

```ts
// GET /v1/auth/session — 200
{
  user: { id: string; email: string; name: string };
  authenticatedAt: string;
  mfaSatisfied: boolean;
  expiresAt: string;
  organizations: { id: string; name: string; }[];   // membership, NOT permissions
}
```

**`organizations` lists membership so a client can render a switcher.** It is not a permission set and must not be treated as one — permissions come from evaluating each request (`16-security/authorization.md`).

**`GET /sessions` returns every active session with IP, user agent, and last-active time.** Visibility is the control for multi-device access; concurrent sessions are unlimited and all revocable.

**A subject may revoke any of their own sessions, including the current one.** Revoking another user's session requires `member:manage` and is a different path.

## Step-up

| Field | Value |
|---|---|
| **Purpose** | Re-verify MFA for a sensitive operation |
| **Method · Path** | `POST /v1/auth/step-up` |
| **Authorization** | Authenticated |
| **Idempotency** | No |
| **Rate limit** | `auth` |
| **Events** | None |
| **Audit** | Operation and outcome recorded |

```ts
// request
{ operation: string; }        // e.g. 'apikey.create'

// 200
{ challengeId: string; factors: ('webauthn' | 'totp' | 'recovery')[]; }
```

**A sensitive operation returns `401` with `SECURITY_STEP_UP_REQUIRED` rather than `403`.** The subject may perform it; they must prove presence first. Step-up is satisfied for 12 hours (`16-security/authentication.md`).

**Operations requiring step-up:** authentication settings, API key management, billing changes, DLQ inspection, replay execution, and ownership transfer.

## Logout

| Field | Value |
|---|---|
| **Purpose** | Terminate the current session |
| **Method · Path** | `POST /v1/auth/logout` |
| **Authorization** | Authenticated |
| **Idempotency** | **Yes** — logging out when logged out is `204` |
| **Rate limit** | `auth` |
| **Events** | None |
| **Audit** | Recorded with reason `user-logout` |

**Returns `204` with the session cookie cleared.** Logging out an already-expired session succeeds — the client's intent is satisfied, and returning `401` would leave clients unable to clear state.

## Password reset

| Field | Value |
|---|---|
| **Purpose** | Request and complete a password reset |
| **Method · Path** | `POST /v1/auth/password/reset-request` · `POST /v1/auth/password/reset` |
| **Authorization** | None |
| **Idempotency** | Request is idempotent within its window |
| **Rate limit** | `auth`, per email and per IP |
| **Events** | None |
| **Audit** | Request and completion recorded |

```ts
// POST /password/reset-request
{ email: string; }
// 204 — ALWAYS, whether or not the account exists

// POST /password/reset
{ token: string; newPassword: string; }
// 204
```

**`reset-request` always returns `204`.** Returning `404` for an unknown email is an enumeration oracle, and it is the most commonly shipped one because the "helpful" behaviour feels like better UX.

| Error on completion | Code | Status |
|---|---|---|
| Invalid, used, or expired token | `AUTH_RESET_TOKEN_INVALID` | 400 |
| Password fails policy | `VALIDATION_FIELD_INVALID` | 400 |

**Reset tokens are single-use, 15 minutes, and invalidated by any password change.** Completing a reset **revokes every session for that user** — the action a person takes when they believe they are compromised (`16-security/authentication.md`).

## Password change

| Field | Value |
|---|---|
| **Purpose** | Change a password with the current one |
| **Method · Path** | `POST /v1/auth/password/change` |
| **Authorization** | Authenticated + **step-up** |
| **Idempotency** | No |
| **Rate limit** | `auth` |
| **Events** | None |
| **Audit** | Recorded |

```ts
{ currentPassword: string; newPassword: string; }
// 204
```

**Requires the current password *and* step-up.** A session alone is insufficient — an attacker with a stolen session should not be able to lock the owner out by changing the password.

**All other sessions are revoked; the current one survives.** Revoking the current session would log out the user who just secured their account.

## Email verification

| Field | Value |
|---|---|
| **Purpose** | Verify ownership of an email address |
| **Method · Path** | `POST /v1/auth/email/verify-request` · `POST /v1/auth/email/verify` |
| **Authorization** | Authenticated for request; token for completion |
| **Idempotency** | Request idempotent within its window |
| **Rate limit** | `auth` |
| **Events** | **`UserEmailVerified`** on success |
| **Audit** | Recorded |

```ts
// POST /email/verify
{ token: string; }
// 204
```

**`UserEmailVerified` is emitted through the outbox in the same transaction as the state change**, so a consumer cannot observe a verified user whose event never arrived (`13-event-platform/transactional-outbox.md`).

**Verification tokens are single-use and 24 hours.** Longer than a reset token because verification is not a security-critical recovery path and the friction of expiry is higher.

## MFA enrolment

| Field | Value |
|---|---|
| **Purpose** | Enrol and remove factors |
| **Method · Path** | `POST /v1/auth/mfa/totp` · `POST /v1/auth/mfa/webauthn/register` · `DELETE /v1/auth/mfa/{factorId}` · `POST /v1/auth/mfa/recovery-codes` |
| **Authorization** | Authenticated + **step-up** |
| **Idempotency** | `DELETE` is idempotent |
| **Rate limit** | `auth` |
| **Events** | None |
| **Audit** | Enrolment and removal recorded |

```ts
// POST /mfa/totp — 200, secret shown ONCE
{ factorId: string; secret: string; qrCodeUri: string; }

// POST /mfa/recovery-codes — 200, shown ONCE
{ codes: string[]; }        // 10 single-use
```

**Secrets and recovery codes are returned exactly once and are never retrievable.** Storage is hashed; an endpoint that could redisplay them could leak every enrolment in a database compromise.

**Removing the last factor is refused where the organization enforces MFA** — `409` with `AUTH_MFA_REQUIRED_BY_POLICY`. MFA enforcement is an organization policy, not a user preference (`16-security/rbac.md`).

## SSO discovery

| Field | Value |
|---|---|
| **Purpose** | Determine whether an email domain requires SSO |
| **Method · Path** | `POST /v1/auth/sso/discover` |
| **Authorization** | None |
| **Idempotency** | Yes — read-only |
| **Rate limit** | `auth` |
| **Events** | None |
| **Audit** | Not recorded — no subject and no state change |

```ts
{ email: string; }

// 200 — identical shape whether or not SSO applies
{ ssoRequired: boolean; redirectUrl?: string; }
```

**Discovery reveals only whether a *domain* is SSO-enforced, never whether an account exists.** `alice@acme.com` and `nobody@acme.com` return identical responses, because the answer is a property of the domain.

**SSO requires a verified domain** — proven by DNS TXT record before enforcement, so no organization can claim a domain it does not control (`16-security/authentication.md`).

## Business rules

1. **No token carries permissions, roles, or `tenantId`.**
2. **Every credential failure returns `SECURITY_AUTHENTICATION_FAILED`**, uniform in body and timing.
3. **`AUTH_SSO_REQUIRED` is the only permitted login disclosure.**
4. **SMS is not an available factor.**
5. **Refresh rotates both tokens; reuse revokes the family and pages.**
6. **Access tokens are 15 minutes and are not revocable.**
7. **`reset-request` always returns `204`.**
8. **Reset completion revokes every session.**
9. **Password change requires the current password and step-up**; other sessions are revoked.
10. **MFA secrets and recovery codes are shown once.**
11. **Removing the last factor is refused under an enforcing policy.**
12. **Sensitive operations return `401` with a step-up challenge, not `403`.**
13. **`GET /session` returns membership, never permissions.**
14. **SSO discovery reveals domain policy, never account existence.**
15. **Every endpoint here is audited.**
16. **Every endpoint is rate limited pre- and post-authentication.**

## Events emitted

| Event | Trigger |
|---|---|
| `UserEmailVerified` | Email verification completed |

**Authentication deliberately emits almost nothing.** Login and logout are audit records, not domain events — no component acts on them, and publishing them would put authentication activity on a bus that fans out to webhook subscribers (`13-event-platform/event-registry.md`).

## Audit implications

**Every endpoint writes synchronously, in the action's transaction** (`16-security/audit.md`): login success and failure, MFA challenge and outcome, token issuance, **reuse detection**, session revocation with reason, password reset and change, MFA enrolment and removal, and step-up outcome.

**Records carry `actorId`, IP, and user agent — never credentials, tokens, or codes.**

## Cross references

- `16-security/authentication.md` — **the behaviour this surface exposes**
- `16-security/api-security.md` — pipeline, CSRF, rate limiting, error policy
- `16-security/authorization.md` — why membership is not permissions
- `16-security/rbac.md` — organization MFA policy
- `16-security/audit.md` — the records every endpoint writes
- `16-security/security-observability.md` — reuse detection paging
- `api-principles.md` — status codes, errors, idempotency, rate-limit headers
- `organization-api.md` — invitations and membership
- `07-development-guide/error-handling.md` — stable codes
- `13-event-platform/transactional-outbox.md` — event emission
