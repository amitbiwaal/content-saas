# API Principles

> **Status:** v1.0 — complete. Phase 12. **Canonical conventions.**
> **Every resource document assumes this one.** Pagination, errors, filtering, idempotency, and conditional requests are defined here once and referenced everywhere, so no endpoint invents its own.

## Overview

**Purpose.** Freeze the cross-cutting conventions: URL structure, method semantics, status codes, the error envelope, pagination, filtering, sorting, sparse fieldsets, expansion, idempotency, conditional requests, and deprecation.

**Stable contracts over convenient implementation.** Where a convention is inconvenient to implement but easier to consume and evolve, the convention wins. The API outlives every implementation behind it.

## Resource-oriented URLs

```
/v1/organizations/{organizationId}
/v1/organizations/{organizationId}/members
/v1/workspaces/{workspaceId}
/v1/workspaces/{workspaceId}/articles/{articleId}
/v1/workspaces/{workspaceId}/articles/{articleId}/actions/publish
```

| Rule | Example |
|---|---|
| Plural nouns | `/articles`, never `/article` or `/getArticles` |
| Hierarchy reflects ownership | `/workspaces/{id}/articles` |
| Nesting stops at two levels | Deeper resources are addressed at top level with a filter |
| Non-CRUD actions | `POST /{resource}/{id}/actions/{action}` |
| No file extensions, no trailing slash | Content negotiation is a header concern |

**Nesting stops at two levels because deeper paths become unusable.** `/organizations/{o}/workspaces/{w}/projects/{p}/articles/{a}/revisions/{r}` requires a client to hold five ids to fetch one thing. Revisions are addressed as `/workspaces/{w}/revisions/{r}` — the workspace is the tenant boundary and is always present; everything below it is a filter.

**The workspace segment is the tenant boundary and appears on every tenant-scoped path.** It is not how the tenant is *determined* — that comes from the authenticated subject intersected with the addressed resource (`16-security/tenant-isolation.md`) — but it makes the scope legible in logs, support tickets, and the URL itself.

**URLs never expose database tables, column names, or storage keys.** A path segment named after a table freezes the schema into the public contract.

## HTTP methods

| Method | Semantics | Idempotent | Body |
|---|---|---|---|
| `GET` | Retrieve | Yes | Never |
| `POST` | Create, or invoke an action | **No** — unless `Idempotency-Key` | Yes |
| `PATCH` | Partial update | Yes | Yes |
| `PUT` | **Not used** | — | — |
| `DELETE` | Remove | Yes | No |

**`PUT` is deliberately absent.** Full-replacement semantics require a client to send every field, which means a client on an older version silently erases fields it does not know about. `PATCH` with explicit fields makes partial updates the only shape.

**`GET` never mutates and never carries a body.** A mutating `GET` is reachable from an image tag, is cached by intermediaries, and is exempt from CSRF preflight (`16-security/api-security.md`).

**`DELETE` is idempotent: deleting an already-deleted resource returns `204`, not `404`.** The client's intent — that the resource not exist — is satisfied. Returning `404` makes a retried delete look like a failure, which is the same reasoning that makes `already-deleted` a success outcome in the storage layer (`12-storage-platform/storage-apis.md`).

## Status codes

| Code | Used for |
|---|---|
| `200` | Successful `GET`, `PATCH`, or action returning a body |
| `201` | Resource created — `Location` header set |
| `202` | **Accepted for async processing** — returns a handle |
| `204` | Success with no body — `DELETE` |
| `304` | `If-None-Match` matched |
| `400` | Malformed request or schema violation |
| `401` | Unauthenticated, or step-up required |
| `403` | Authenticated, permission denied **within the tenant** |
| `404` | Not found, **or outside the subject's tenants** |
| `409` | State conflict — domain invariant |
| `410` | Retired API version, or permanently removed resource |
| `412` | `If-Match` precondition failed |
| `413` | Payload too large |
| `422` | Semantically invalid, or **idempotency key reuse with a different body** |
| `429` | Rate limited — `Retry-After` set |
| `500` | Unexpected — generic body, `requestId` only |
| `503` | Dependency unavailable — `Retry-After` where known |

**`404` for cross-tenant access is a security decision, not a convenience.** A `403` confirms the resource exists, letting an attacker enumerate ids across tenants and map another organization's content by probing. Within a tenant, `403` is correct — a member who lacks permission on something they can already see gains nothing from a lie (`16-security/authorization.md`).

**`401` covers step-up.** A valid session performing a sensitive operation without fresh MFA receives `401` with a step-up challenge, not `403` — the subject may act, but not yet (`16-security/authentication.md`).

**`409` is for domain state, `422` for semantics.** Publishing an already-published article is `409`; a `wordCount` of `-5` that passed schema validation but violates a rule is `422`.

## Error envelope

**Frozen in `16-security/api-security.md` and restated here as the canonical shape:**

```ts
interface ErrorResponse {
  error: {
    code: string;                       // stable, enumerated
    message: string;                    // safe, generic, derived from code
    requestId: string;
    details?: readonly FieldError[];    // validation only
  };
}

interface FieldError {
  readonly path: string;                // 'body.wordCount'
  readonly code: string;                // 'max_exceeded'
  // NO value — never echo what was received
}
```

**Clients branch on `code`, never on `message`.** Codes are contract; messages are not and may change (`07-development-guide/error-handling.md`).

**`details` carries field paths and codes, never received values.** Echoing input puts potentially sensitive data into responses and logs.

**Never in any error response:** stack traces, SQL fragments, provider messages, internal hostnames, secrets, or whether a resource exists in another tenant.

## Pagination

**Cursor-based only. Offset pagination does not exist in this API.**

```http
GET /v1/workspaces/{id}/articles?limit=50&cursor=eyJpZCI6...
```

```json
{
  "data": [ ... ],
  "pagination": {
    "nextCursor": "eyJpZCI6...",
    "hasMore": true
  }
}
```

| Parameter | Rule |
|---|---|
| `limit` | Default 25, maximum 100 |
| `cursor` | Opaque, base64; **never constructed by a client** |
| `nextCursor` | `null` when exhausted |

**Offset pagination is refused for two reasons, and the second matters more.** It degrades quadratically — `OFFSET 100000` scans and discards 100,000 rows. And it is *incorrect* under concurrent writes: a row inserted before your position shifts everything, so page 2 repeats an item from page 1 or skips one entirely. Cursors encode a position in a stable sort and are immune to both.

**No total count is returned by default.** `COUNT(*)` over a filtered set of millions is expensive on every page request. Where a count is genuinely needed, `?includeTotal=true` returns an `estimatedTotal`, named to signal it is not exact.

**Cursors are opaque and validated.** They encode the sort key and position; a client that decoded and constructed one would break on any change to sort implementation, and a tampered cursor is rejected rather than trusted as a position.

## Filtering

**Explicit, typed query parameters. Not a query language.**

```http
GET /v1/workspaces/{id}/articles?status=draft&createdAfter=2026-01-01T00:00:00Z&projectId={uuid}
```

| Pattern | Form |
|---|---|
| Equality | `status=draft` |
| Multiple values (OR) | `status=draft,review` |
| Ranges | `createdAfter=`, `createdBefore=` |
| Boolean | `hasMedia=true` |
| Text search | `q=` — scoped per resource |

**A generic query language is refused.** `?filter=status eq 'draft' and created gt ...` requires a parser, becomes an injection surface, and lets clients construct queries no index supports — turning any endpoint into an unbounded table scan. Explicit parameters are bounded by design, and each one is backed by an index.

**Unknown filter parameters are rejected with `400`.** Silently ignoring a typo returns an unfiltered set that looks correct and is not — the same reasoning that makes request schemas `.strict()` (`07-development-guide/coding-standards.md`).

**Every filterable field is documented per endpoint.** A field that is not documented is not filterable.

## Sorting

```http
GET /v1/workspaces/{id}/articles?sort=-updatedAt,title
```

| Rule | Detail |
|---|---|
| `-` prefix | Descending |
| Multiple keys | Comma-separated, applied in order |
| Default | `-createdAt` |
| **Tie-breaker** | **`id` is always appended implicitly** |
| Sortable fields | Documented and indexed |

**The implicit `id` tie-breaker is what makes cursor pagination correct.** Without a total order, two rows with the same `updatedAt` can be returned in either order between requests, and a cursor built on an ambiguous position skips or repeats them. Appending `id` guarantees a deterministic sequence.

## Sparse fieldsets

```http
GET /v1/workspaces/{id}/articles?fields=id,title,status
```

**Reduces payload size on list endpoints.** `id` is always included regardless of the request — a response object with no identifier is unusable.

**Requesting an unknown field is `400`**, not silently ignored.

**Sparse fieldsets never bypass authorization.** A field a subject may not read is absent whether or not it was requested; `fields` narrows an already-authorized projection (`16-security/authorization.md`).

## Expansion

```http
GET /v1/workspaces/{id}/articles/{articleId}?expand=project,author
```

| Rule | Detail |
|---|---|
| Depth | **One level only** |
| Expandable relations | Documented per endpoint |
| Unexpanded | An id field, always present |
| Authorization | **Each expansion authorized independently** |
| Limit | Maximum 3 expansions per request |

**Depth is capped at one because arbitrary expansion is an N+1 generator with a public interface.** `expand=project.workspace.organization.members` is a client-triggered join across four tables per row.

**Each expansion is authorized independently.** A subject who may read an article but not its author receives the article with the author id and no expansion — never a `403` for the whole request, which would make an unrelated permission gap look like a broken endpoint.

## Idempotency

**Frozen in `16-security/api-security.md`; the client contract:**

```http
POST /v1/workspaces/{id}/runs
Idempotency-Key: 018f3a2b-...
```

| Behaviour | Rule |
|---|---|
| First request | Processed; response stored |
| Retry, same key, **same body** | **The original response returned**, including its status |
| Retry, same key, **different body** | **`422`** — a client bug |
| Window | 24 hours |
| Scope | Per tenant, per endpoint |
| Required on | Every non-idempotent `POST` that creates or charges |

**Returning the original response — including its status — is what makes retries safe.** A client retrying `POST /runs` after a network timeout receives the first run's result, not a second run and not a `409`.

**Key reuse with a different body is `422`, never a silent success.** The client has a bug that would otherwise return an unrelated resource's response, which is far harder to diagnose than an error.

**This is request-layer idempotency, distinct from event-handler idempotency** (`13-event-platform/idempotency.md`). Both prevent duplicate effects, at different boundaries with different keys.

## Conditional requests

```http
GET  /v1/workspaces/{id}     →  200, ETag: "a1b2c3"
GET  /v1/workspaces/{id}     →  304 with If-None-Match: "a1b2c3"
PATCH /v1/workspaces/{id}    →  412 with a stale If-Match
```

| Header | Purpose |
|---|---|
| `ETag` | Returned on every single-resource `GET` |
| `If-None-Match` | Caching — `304 Not Modified` |
| **`If-Match`** | **Optimistic concurrency — `412` on conflict** |

**`If-Match` is how lost updates are prevented, and it is required on resources with concurrent-edit exposure** — articles, workspace settings, role bindings. Two editors loading a resource and saving sequentially would otherwise have the second silently overwrite the first with no error anywhere.

**Where `If-Match` is required, its absence is `428 Precondition Required`** rather than proceeding unguarded.

**ETags are derived from resource state, not from a storage-layer value.** A provider ETag is not a content hash for multipart objects and differs between providers for identical bytes (`12-storage-platform/cdn.md`).

## Request correlation

| Header | Direction | Meaning |
|---|---|---|
| `X-Request-Id` | Response, always | This HTTP request; quoted in support tickets |
| `X-Correlation-Id` | Request (optional) / response | Groups everything caused by one client operation |

**A client-supplied `X-Correlation-Id` is accepted and propagated**, so a customer can correlate their logs with ours. It is treated as untrusted input — length-bounded, character-restricted, never used in a query or a path.

**`X-Correlation-Id` flows into the event envelope**, which is how a webhook a customer receives ties back to the API call that caused it (`13-event-platform/event-apis.md`).

**`requestId` in an error body equals `X-Request-Id`.** One identifier, in the header and the payload, so it is available whichever the client captured.

## Rate limiting

```http
X-RateLimit-Limit: 1000
X-RateLimit-Remaining: 847
X-RateLimit-Reset: 1735689600
Retry-After: 30            # on 429 only
```

**Every endpoint documents its rate-limit class**; the values per plan belong to `04-platform/rate-limiting.md`.

| Class | Applied to |
|---|---|
| `read` | `GET` endpoints |
| `write` | `POST`, `PATCH`, `DELETE` |
| `expensive` | Pipeline runs, exports, bulk operations |
| `auth` | Authentication endpoints — **also limited pre-authentication by IP** |

**Headers are returned on every response, not only on `429`.** A client that can see its remaining budget can pace itself; one that discovers the limit by hitting it cannot.

## Deprecation

```http
Deprecation: Sun, 01 Mar 2026 00:00:00 GMT
Sunset: Tue, 01 Sep 2026 00:00:00 GMT
Link: <https://docs.contentos.ai/api/v2/migration>; rel="deprecation"
```

| Stage | Duration | Behaviour |
|---|---|---|
| Announced | — | Docs updated; `Deprecation` header |
| Deprecated | **6 months minimum** | Fully functional; headers on every response |
| Sunset | — | **`410 Gone`** with the migration link |

**Deprecation is announced in-band on every response**, not only in a changelog. A client integrated two years ago is not reading the changelog, and the header is the only channel that reaches it.

**Sunset returns `410`, never a fallback to the current version** (`16-security/api-security.md`).

## Business rules

1. **Resources are plural nouns; nesting stops at two levels.**
2. **Non-CRUD actions use `POST /{resource}/{id}/actions/{action}`.**
3. **URLs never expose tables, columns, or storage keys.**
4. **`PUT` is not used.**
5. **`DELETE` is idempotent** — `204` on an already-deleted resource.
6. **Cross-tenant denial is `404`; in-tenant is `403`.**
7. **Clients branch on `error.code`, never on message text.**
8. **`details` carries paths and codes, never received values.**
9. **Pagination is cursor-based only**; cursors are opaque and validated.
10. **No total count by default**; `estimatedTotal` on request.
11. **`id` is always appended as a sort tie-breaker.**
12. **Unknown filter, field, or sort parameters are `400`.**
13. **Expansion is one level, maximum three, each authorized independently.**
14. **Idempotency keys return the original response**; different body is `422`.
15. **`If-Match` is required where concurrent edits are exposed**; absence is `428`.
16. **Rate-limit headers on every response.**
17. **Deprecation is announced in-band for at least 6 months**; sunset is `410`.
18. **Long-running work returns `202` with a handle**, never a held-open request.

## Cross references

- `README.md` — API philosophy, versioning, stability guarantees
- `authentication-api.md` · `organization-api.md` · `workspace-api.md` — resources applying these conventions
- `16-security/api-security.md` — **the request pipeline, error policy, idempotency, CORS, headers**
- `16-security/authorization.md` — 404-versus-403, per-expansion authorization
- `16-security/authentication.md` — step-up and `401`
- `07-development-guide/error-handling.md` — stable codes and retryability
- `13-event-platform/event-apis.md` — correlation flowing into the envelope
- `13-event-platform/idempotency.md` — the distinct handler-level mechanism
- `13-event-platform/versioning.md` — the compatible-versus-breaking taxonomy
- `12-storage-platform/storage-apis.md` — cursor pagination and idempotent delete precedent
- `04-platform/rate-limiting.md` — rate limit values per plan
- `01-system-architecture/09-request-flow.md` — 202 plus handle, SSE progress
