# Rate Limiting

> **Status:** v1.0 — ownership document. Phase 12 governance completion.
> **This document owns the values; other documents own the mechanism.** Thirteen references defer limit numbers here. The dimensions, classes, and enforcement are specified elsewhere and are not restated.

## Purpose

Own the rate limit values applied per class and per plan, and name the documents that specify how limiting is enforced.

## Scope

**In scope:** ownership of limit values; the map from an endpoint's declared class to the plan tier that sets its number.

**Not in scope:** the limiting mechanism, its dimensions, its headers, or its failure behaviour. All are specified in `16-security/api-security.md` and `06-api/api-principles.md`.

## Ownership

| Concern | Owner |
|---|---|
| **Limit values per class and plan** | **This document** |
| Enforcement dimensions and pipeline position | `16-security/api-security.md` |
| Rate-limit classes and response headers | `06-api/api-principles.md` |
| Limiter state storage | `12-storage-platform/redis.md` |
| **AI provider rate limiting** | **`08-ai-platform/rate-limiting.md`** — a separate concern |
| Plan tiers and entitlements | `04-platform/billing.md` |
| Abuse-prevention rationale | `16-security/api-security.md`, `16-security/threat-model.md` T-23, T-24 |

**Two rate limiting systems exist and are deliberately separate.** This document governs *inbound* limits on the platform's own API. `08-ai-platform/rate-limiting.md` governs *outbound* limits against model providers, which are set by provider contracts rather than by customer plan.

## Responsibilities

**The classes are already declared.** `06-api/api-principles.md` defines four, and every endpoint documents which it belongs to:

| Class | Applies to |
|---|---|
| `read` | `GET` endpoints |
| `write` | `POST`, `PATCH`, `DELETE` |
| `expensive` | Pipeline runs, exports, bulk operations |
| `auth` | Authentication endpoints — also limited pre-authentication by IP |

**The dimensions are already specified.** `16-security/api-security.md` establishes that limiting runs twice: **pre-authentication by IP**, protecting the authentication endpoints themselves against credential stuffing and enumeration, and **post-authentication by subject and tenant**, enforcing fair use and catching a compromised account. Either alone leaves a gap.

**The plan tiers already exist.** `starter`, `growth`, and `enterprise` are declared on the organization resource (`06-api/organization-api.md`).

**This document owns the value at each (class × plan) intersection.**

## Current state of the values

**No approved document sets a numeric limit, and this document does not invent one.** The matrix is a commercial decision — it prices fair use, and setting it in an architecture document without that decision would create a constraint nobody agreed to.

| Intersection | Status |
|---|---|
| `read` × {starter, growth, enterprise} | **Not yet set** |
| `write` × {starter, growth, enterprise} | **Not yet set** |
| `expensive` × {starter, growth, enterprise} | **Not yet set** |
| `auth` × all plans | **Not yet set** — plan-independent; abuse-driven |

**`auth` limits are plan-independent by design**, because they exist to stop credential attacks rather than to price usage. A higher-paying customer does not get more login attempts.

**Values are loaded from configuration, never hardcoded**, following the rule already established in `07-development-guide/configuration.md`. Setting them is a configuration change, not a code change, which is why their absence blocks no implementation.

## Existing references

Thirteen references across three folders, all deferring values:

| Document | Defers |
|---|---|
| `06-api/api-principles.md` ×2 | "the values per plan belong to `04-platform/rate-limiting.md`" |
| `06-api/README.md` ×2 | Rate limit **values** |
| `06-api/api-observability.md` | Rate limit values |
| `16-security/api-security.md` ×3 | "Values live elsewhere; rationale lives here" |
| `16-security/README.md` ×2 | "limit values; this platform owns the abuse-prevention rationale" |
| `16-security/threat-model.md` | T-23 DoS, T-24 rate-limit bypass mitigations |
| `12-storage-platform/redis.md` ×2 | Limiter state and values |

**Every reference defers only values.** No document defers mechanism here, which is why this document specifies none.

## Related documents

- `16-security/api-security.md` — **the enforcement pipeline, dimensions, and rationale**
- `06-api/api-principles.md` — classes and the `X-RateLimit-*` headers returned on every response
- `16-security/threat-model.md` — T-23 denial of service, T-24 rate-limit bypass
- `12-storage-platform/redis.md` — limiter state
- `08-ai-platform/rate-limiting.md` — outbound provider limits, a separate system
- `04-platform/billing.md` — plan tiers and entitlements
- `04-platform/credits.md` — credit accounting, which caps cost independently of request count
- `07-development-guide/configuration.md` — values are configuration, validated at startup

## Operational considerations

**Rate limits are not the only cost control.** Per-tenant credit accounting caps spend regardless of request count, which is why a rate-limit bypass is classified Medium rather than High in the threat model — an attacker who evades limits still cannot exceed the tenant's credit balance (`04-platform/credits.md`).

**Limits are relaxed in local development and production-valued in CI**, so a change that breaks under limits fails in CI rather than in production (`07-development-guide/configuration.md`).

**Rejections are a security signal, not only a capacity signal.** A spike for one tenant indicates abuse or a runaway client, and is alerted in `06-api/api-observability.md` and `16-security/security-observability.md`.

**Headers are returned on every response, not only on `429`**, so a client can pace itself rather than discovering the limit by hitting it.

## Explicitly out of scope

| Out of scope | Where it belongs |
|---|---|
| The limiting algorithm and pipeline position | `16-security/api-security.md` |
| Rate-limit classes and header format | `06-api/api-principles.md` |
| Per-endpoint class assignment | The endpoint's own API document |
| Limiter state storage and TTLs | `12-storage-platform/redis.md` |
| Outbound provider limits | `08-ai-platform/rate-limiting.md` |
| Credit accounting and quota | `04-platform/credits.md`, `billing.md` |
| Abuse detection and alerting | `16-security/security-observability.md` |
| **Setting the numeric values** | **A commercial decision, recorded here when made** |
