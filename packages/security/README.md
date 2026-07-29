# `@contentos/security`

**Specified by** [`16-security/`](../../contentos-docs/16-security/).

## What this package owns

| Concern                                      | Source                                   |
| -------------------------------------------- | ---------------------------------------- |
| `TenantContext`, establishment, propagation  | `tenant-isolation.md`                    |
| `Subject`, `Session`, `Authenticator`        | `authentication.md`                      |
| MFA framework — TOTP, recovery codes, policy | `authentication.md`                      |
| Permission vocabulary and role catalogue     | `rbac.md`                                |
| Authorization evaluator                      | `authorization.md`                       |
| Audit writer abstraction                     | `audit.md`                               |
| Crypto primitives                            | `secrets-management.md`, `encryption.md` |

Reusable primitives only: no business logic, no UI, no API handlers.

## Rules that govern this package

**The provider is never exposed.** Better Auth sits behind `AuthProviderAdapter`, which is not re-exported from `src/index.ts`. Callers depend on `Authenticator`.

**A session establishes identity; it never carries authority.** `Subject` has no permissions, no roles, and no `tenantId`. Permissions are evaluated per request against current state, so revocation is immediate — there is nothing cached to invalidate.

**`AuthResult`'s failure variant carries one opaque reason.** A richer type would become an enumeration oracle; the type makes the leak unrepresentable.

**Organization roles grant no content access.** An organization Owner holds `workspace:create` and `workspace:delete` but **no** `article:read`. Administrative authority over a workspace is not access to its contents.

**Every evaluation is deterministic** — a pure function of (subject, action, resource, bindings, clock). No I/O inside the decision. The default is deny with `no-policy`.

**Expiry is evaluated at decision time**, not by a sweep, so there is no window in which a lapsed grant still works.

**`TenantContext` is immutable and has no nullable variant.** `currentContext()` throws outside a scope rather than returning null — a nullable accessor invites `ctx?.tenantId`, which silently produces a query matching nothing. Propagation uses `AsyncLocalStorage`: no global mutable state.

**SMS MFA is not implemented and not modelled.** `MfaFactorKind` has no `sms` member, so it is unrepresentable rather than merely discouraged.

**No cryptography is invented.** scrypt, HMAC-SHA1/256, `timingSafeEqual`, and the CSPRNG all come from `node:crypto`. TOTP is RFC 6238 over RFC 4226 and is verified against the published vectors.

## Audit: buffering until migration 0015

`audit_log` is created by **migration 0015**, which this package does not create. Until it exists the writer **buffers**, bounded, dropping oldest on overflow and reporting it. A writer that silently dropped records would make the audit trail quietly incomplete exactly while the platform is least mature. Call `drain(tx)` once 0015 has run.
