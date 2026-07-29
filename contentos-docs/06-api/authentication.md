# Authentication API — Superseded

> **This document has been superseded.**

**Replacement document:** `06-api/authentication-api.md`

**Replacement sections:**

| Original intent | Now specified in |
|---|---|
| Auth flows — login, refresh, logout/revoke, service tokens | `authentication-api.md` §Login, §Token issuance and refresh, §Logout |
| Token contents and claims | `authentication-api.md` §Overview and §Token issuance and refresh |
| Endpoint list | `06-api/api-reference.md` §Authentication |
| Request/response DTOs | `authentication-api.md`, per endpoint |
| Error cases | `authentication-api.md`, per endpoint; codes in `07-development-guide/error-handling.md` |
| MFA and session rules | `authentication-api.md` §MFA verification, §Session, §Step-up |

## Migration note

**This document's stated intent contained an assumption that was later overturned.** It specified token contents as `user_id`, `tenant_id`, `roles`.

`16-security/authentication.md` establishes the opposite, and `authentication-api.md` implements it:

- **No token carries permissions or roles.** Permissions are evaluated per request against current state, which is what makes revocation immediate.
- **`Subject` carries no `tenantId`.** A user belongs to many workspaces; the tenant is determined by the addressed resource and checked against the subject's grants.

Any implementation started from this document's original intent must be re-checked against `16-security/authentication.md` before use.
