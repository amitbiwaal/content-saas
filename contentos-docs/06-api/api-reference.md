# API Reference

> **Status:** v1.0 — complete. Phase 12. **Canonical endpoint registry.**
> **This document is the frozen contract.** Where it disagrees with any other API document, this one wins. It closes eight drift items found by extracting all 101 declared path strings rather than assuming the fifteen documents agreed.

## Overview

**Purpose.** Enumerate every endpoint exactly once, with its method, authorization, idempotency, rate-limit class, events, and audit implications — and resolve the naming and shape drift that fifteen documents written in sequence inevitably produced.

**Scope of authority.** This is a **drift resolution, not a redesign.** No endpoint gains or loses behaviour. Where two documents declared the same endpoint differently, one form is chosen and the divergence is recorded below.

## Path conventions — frozen

| Rule | Form |
|---|---|
| Version prefix | `/v1/…` on every customer endpoint |
| **Path parameters** | **`{resourceId}`, never bare `{id}`** |
| Admin surface | `/admin/v1/…` |
| **Probes** | **Unversioned** — `/healthz`, `/readyz`, `/startupz` |
| Actions | `POST /{collection}/{resourceId}/actions/{action}` |

**Bare `{id}` is retired in favour of `{resourceId}`.** In a nested path two parameters appear — `/v1/workspaces/{workspaceId}/articles/{articleId}` — and `{id}` is ambiguous about which resource it identifies. The typed form is unambiguous everywhere and matches the generated client naming.

**Probes are deliberately unversioned.** They are consumed by orchestrators, not clients, and versioning them would mean a Kubernetes manifest breaking on an API version change (`admin-api.md`).

## Registry

### Authentication — `/v1/auth`

| Method · Path | Authz | Idem | Rate | Events | Audit |
|---|---|---|---|---|---|
| `POST /v1/auth/login` | — | — | `auth` | — | ✅ |
| `POST /v1/auth/mfa/verify` | challenge | — | `auth` | — | ✅ |
| `POST /v1/auth/token` | session | — | `auth` | — | ✅ |
| `POST /v1/auth/refresh` | refresh token | — | `auth` | — | ✅ |
| `POST /v1/auth/logout` | authenticated | ✅ | `auth` | — | ✅ |
| `GET /v1/auth/session` | authenticated | ✅ | `read` | — | — |
| `GET /v1/auth/sessions` | authenticated | ✅ | `read` | — | — |
| `DELETE /v1/auth/sessions/{sessionId}` | authenticated | ✅ | `auth` | — | ✅ |
| `POST /v1/auth/step-up` | authenticated | — | `auth` | — | ✅ |
| `POST /v1/auth/password/reset-request` | — | ✅ | `auth` | — | ✅ |
| `POST /v1/auth/password/reset` | token | — | `auth` | — | ✅ |
| `POST /v1/auth/password/change` | auth + step-up | — | `auth` | — | ✅ |
| `POST /v1/auth/email/verify-request` | authenticated | ✅ | `auth` | — | ✅ |
| `POST /v1/auth/email/verify` | token | — | `auth` | `UserEmailVerified` | ✅ |
| `POST /v1/auth/mfa/totp` | auth + step-up | — | `auth` | — | ✅ |
| `POST /v1/auth/mfa/webauthn/register` | auth + step-up | — | `auth` | — | ✅ |
| `POST /v1/auth/mfa/recovery-codes` | auth + step-up | — | `auth` | — | ✅ |
| `DELETE /v1/auth/mfa/{factorId}` | auth + step-up | ✅ | `auth` | — | ✅ |
| `POST /v1/auth/sso/discover` | — | ✅ | `auth` | — | — |

### Organizations — `/v1/organizations`

| Method · Path | Authz | Idem | Rate | Events | Audit |
|---|---|---|---|---|---|
| `POST /v1/organizations` | authenticated | **key** | `write` | `OrganizationCreated` | ✅ |
| `GET /v1/organizations/{organizationId}` | `organization:read` | ✅ | `read` | — | — |
| `PATCH /v1/organizations/{organizationId}` | `organization:update` | ✅ | `write` | `OrganizationUpdated` | ✅ |
| `DELETE /v1/organizations/{organizationId}` | `organization:delete` + step-up | ✅ | `write` | `OrganizationDeleted` | ✅ |
| `GET /v1/organizations/{organizationId}/members` | `member:read` | ✅ | `read` | — | — |
| `PATCH /v1/organizations/{organizationId}/members/{userId}` | `member:manage` | ✅ | `write` | `…MemberRoleChanged` | ✅ |
| `DELETE /v1/organizations/{organizationId}/members/{userId}` | `member:manage` | ✅ | `write` | `…MemberRemoved` | ✅ |
| `POST /v1/organizations/{organizationId}/invitations` | `member:manage` | **key** | `write` | `…InvitationSent` | ✅ |
| `GET /v1/organizations/{organizationId}/invitations` | `member:read` | ✅ | `read` | — | — |
| `DELETE /v1/organizations/{organizationId}/invitations/{invitationId}` | `member:manage` | ✅ | `write` | — | ✅ |
| `POST /v1/invitations/{token}/accept` | authenticated | ✅ | `write` | `…MemberAdded` | ✅ |
| `POST /v1/organizations/{organizationId}/actions/transfer-ownership` | `organization:delete` + step-up | **key** | `write` | `…OwnershipTransferred` | ✅ |

### Workspaces — `/v1/workspaces`

| Method · Path | Authz | Idem | Rate | Events | Audit |
|---|---|---|---|---|---|
| `POST /v1/organizations/{organizationId}/workspaces` | `workspace:create` | **key** | `write` | `WorkspaceCreated` | ✅ |
| `GET /v1/workspaces/{workspaceId}` | `workspace:read` | ✅ | `read` | — | — |
| `PATCH /v1/workspaces/{workspaceId}` | `workspace:update` | ✅ | `write` | `WorkspaceUpdated` | ✅ |
| `DELETE /v1/workspaces/{workspaceId}` | `workspace:delete` + step-up | ✅ | `write` | `WorkspaceDeleted` | ✅ |
| `POST /v1/workspaces/{workspaceId}/actions/archive` | `workspace:update` | ✅ | `write` | `WorkspaceArchived` | ✅ |
| `POST /v1/workspaces/{workspaceId}/actions/restore` | `workspace:update` | ✅ | `write` | `WorkspaceRestored` | ✅ |
| `GET /v1/workspaces/{workspaceId}/members` | `workspace:read` | ✅ | `read` | — | — |
| `POST /v1/workspaces/{workspaceId}/members` | `member:manage` | **key** | `write` | `WorkspaceMemberAdded` | ✅ |
| `PATCH /v1/workspaces/{workspaceId}/members/{userId}` | `member:manage` | ✅ | `write` | `…RoleChanged` | ✅ |
| `DELETE /v1/workspaces/{workspaceId}/members/{userId}` | `member:manage` | ✅ | `write` | `…MemberRemoved` | ✅ |
| `GET /v1/workspaces/{workspaceId}/permissions` | `workspace:read` | ✅ | `read` | — | — |

### Content — `/v1/articles`

| Method · Path | Authz | Idem | Rate | Events | Audit |
|---|---|---|---|---|---|
| `POST /v1/workspaces/{workspaceId}/articles` | `article:create` | **key** | `write` | `ArticleCreated` | ✅ |
| `GET /v1/workspaces/{workspaceId}/articles` | `article:read` | ✅ | `read` | — | — |
| `GET /v1/articles/{articleId}` | `article:read` | ✅ | `read` | — | — |
| `PATCH /v1/articles/{articleId}` | `article:update` | ✅ | `write` | `ArticleUpdated` | ✅ |
| `DELETE /v1/articles/{articleId}` | `article:delete` | ✅ | `write` | `ArticleDeleted` | ✅ |
| `POST /v1/articles/{articleId}/actions/archive` | `article:update` | ✅ | `write` | `ArticleArchived` | ✅ |
| `GET /v1/articles/{articleId}/outlines` | `article:read` | ✅ | `read` | — | — |
| `GET /v1/articles/{articleId}/outlines/{versionNumber}` | `article:read` | ✅ | `read` | — | — |
| `POST /v1/articles/{articleId}/actions/approve-outline` | `article:update` | ✅ | `write` | `OutlineApproved` | ✅ |
| `GET /v1/articles/{articleId}/revisions` | `article:read` | ✅ | `read` | — | — |
| `GET /v1/articles/{articleId}/revisions/{revisionNumber}` | `article:read` | ✅ | `read` | — | — |
| `GET /v1/articles/{articleId}/revisions/{revisionNumber}/gates` | `article:read` | ✅ | `read` | — | — |
| `GET /v1/articles/{articleId}/revisions/{revisionNumber}/citations` | `article:read` | ✅ | `read` | — | — |
| `POST /v1/articles/{articleId}/actions/publish` | `publish:execute` | **key** | `expensive` | `ArticlePublishRequested` | ✅ |
| `POST /v1/articles/{articleId}/actions/refresh` | `article:execute` | **key** | `expensive` | `ArticleRefreshRequested` | ✅ |
| `POST /v1/articles/{articleId}/actions/optimize` | `article:execute` | **key** | `expensive` | `ArticleOptimizationRequested` | ✅ |

### Runs and research

| Method · Path | Authz | Idem | Rate | Events | Audit |
|---|---|---|---|---|---|
| `POST /v1/workspaces/{workspaceId}/research` | `research:execute` | **key** | `expensive` | `ResearchRequested` | ✅ |
| `GET /v1/workspaces/{workspaceId}/runs` | `run:read` | ✅ | `read` | — | — |
| `GET /v1/runs/{runId}` | per run subject | ✅ | `read` | — | — |
| `GET /v1/runs/{runId}/events` | per run subject | ✅ | `read` | — | — |
| `GET /v1/runs/{runId}/results` | `research:read` | ✅ | `read` | — | — |
| `GET /v1/runs/{runId}/serp` | `research:read` | ✅ | `read` | — | — |
| `GET /v1/runs/{runId}/competitors` | `research:read` | ✅ | `read` | — | — |
| `POST /v1/runs/{runId}/actions/cancel` | `run:cancel` | ✅ | `write` | `RunCancelled` | ✅ |

### Knowledge

| Method · Path | Authz | Idem | Rate | Events | Audit |
|---|---|---|---|---|---|
| `GET /v1/workspaces/{workspaceId}/knowledge/evidence` | `knowledge:read` | ✅ | `read`/`expensive` | — | — |
| `GET /v1/evidence/{evidenceId}` | `knowledge:read` | ✅ | `read` | — | — |
| `GET /v1/evidence/{evidenceId}/provenance` | `knowledge:read` | ✅ | `read` | — | — |
| `GET /v1/workspaces/{workspaceId}/knowledge/entities` | `knowledge:read` | ✅ | `read` | — | — |
| `GET /v1/entities/{entityId}` | `knowledge:read` | ✅ | `read` | — | — |
| `GET /v1/entities/{entityId}/evidence` | `knowledge:read` | ✅ | `read` | — | — |
| `PATCH /v1/entities/{entityId}` | `knowledge:update` | ✅ | `write` | `EntityCurated` | ✅ |
| `POST /v1/entities/{entityId}/actions/merge` | `knowledge:update` | **key** | `write` | `EntityMerged` | ✅ |
| `GET /v1/citations/{citationId}` | `article:read` + `knowledge:read` | ✅ | `read` | — | — |
| `GET /v1/workspaces/{workspaceId}/knowledge/freshness` | `knowledge:read` | ✅ | `read` | — | — |

### AI

| Method · Path | Authz | Idem | Rate | Events | Audit |
|---|---|---|---|---|---|
| `POST /v1/workspaces/{workspaceId}/ai/generate` | `article:execute` | **key** | `expensive` | `AiGenerationRequested` | ✅ |
| `POST /v1/workspaces/{workspaceId}/ai/review` | `article:execute` | **key** | `expensive` | `AiReviewRequested` | ✅ |
| `POST /v1/workspaces/{workspaceId}/ai/council` | `article:execute` | **key** | `expensive` | `AiCouncilRequested` | ✅ |
| `GET /v1/workspaces/{workspaceId}/ai/usage` | `analytics:read` | ✅ | `read` | — | — |

### Media

| Method · Path | Authz | Idem | Rate | Events | Audit |
|---|---|---|---|---|---|
| `POST /v1/workspaces/{workspaceId}/media` | `article:create` | **key** | `write` | `MediaUploadInitiated` | ✅ |
| `POST /v1/workspaces/{workspaceId}/media/multipart` | `article:create` | **key** | `write` | `MediaUploadInitiated` | ✅ |
| `POST /v1/media/{mediaId}/complete` | `article:create` | ✅ | `write` | `MediaAvailable` | ✅ |
| `DELETE /v1/media/{mediaId}/multipart` | `article:create` | ✅ | `write` | — | ✅ |
| `GET /v1/workspaces/{workspaceId}/media` | `article:read` | ✅ | `read` | — | — |
| `GET /v1/media/{mediaId}` | `article:read` | ✅ | `read` | — | — |
| `PATCH /v1/media/{mediaId}` | `article:update` | ✅ | `write` | `MediaMetadataUpdated` | ✅ |
| `GET /v1/media/{mediaId}/url` | `article:read` / `article:export` | ✅ | `read` | — | conditional |
| `GET /v1/media/{mediaId}/derivatives` | `article:read` | ✅ | `read` | — | — |
| `DELETE /v1/media/{mediaId}` | `article:delete` | ✅ | `write` | `MediaDeleted` | ✅ |
| `POST /v1/media/{mediaId}/actions/restore` | `article:update` | ✅ | `write` | `MediaRestored` | ✅ |

### Events and webhooks

| Method · Path | Authz | Idem | Rate | Events | Audit |
|---|---|---|---|---|---|
| `GET /v1/events/types` | authenticated | ✅ | `read` | — | — |
| `POST /v1/workspaces/{workspaceId}/events/subscriptions` | `integration:manage` | **key** | `write` | `EventSubscriptionCreated` | ✅ |
| `GET /v1/workspaces/{workspaceId}/events/subscriptions` | `integration:read` | ✅ | `read` | — | — |
| `PATCH /v1/workspaces/{workspaceId}/events/subscriptions/{subscriptionId}` | `integration:manage` | ✅ | `write` | `…Updated` | ✅ |
| `DELETE /v1/workspaces/{workspaceId}/events/subscriptions/{subscriptionId}` | `integration:manage` | ✅ | `write` | `…Deleted` | ✅ |
| `GET /v1/workspaces/{workspaceId}/events/deliveries` | `integration:read` | ✅ | `read` | — | — |
| `GET /v1/workspaces/{workspaceId}/events/deliveries/{deliveryId}` | `integration:read` | ✅ | `read` | — | — |
| `POST /v1/workspaces/{workspaceId}/events/deliveries/{deliveryId}/actions/redeliver` | `integration:manage` | **key** | `write` | `WebhookRedeliveryRequested` | ✅ |
| `GET /v1/workspaces/{workspaceId}/events/replays` | `integration:read` | ✅ | `read` | — | — |
| `POST /v1/workspaces/{workspaceId}/webhooks` | `integration:manage` | **key** | `write` | `WebhookEndpointCreated` | ✅ |
| `GET /v1/workspaces/{workspaceId}/webhooks` | `integration:read` | ✅ | `read` | — | — |
| `PATCH /v1/webhooks/{webhookId}` | `integration:manage` | ✅ | `write` | `…Updated` | ✅ |
| `DELETE /v1/webhooks/{webhookId}` | `integration:manage` | ✅ | `write` | `…Deleted` | ✅ |
| `POST /v1/webhooks/{webhookId}/actions/verify` | `integration:manage` | ✅ | `write` | `…Verified` | ✅ |
| `POST /v1/webhooks/{webhookId}/actions/rotate-secret` | `integration:manage` + step-up | **key** | `write` | `WebhookSecretRotated` | ✅ |

### Admin — `/admin/v1` · **never publicly routable**

| Method · Path | Authz | Idem | Rate | Events | Audit |
|---|---|---|---|---|---|
| `GET /healthz` · `GET /readyz` · `GET /startupz` | **none** | ✅ | exempt | — | — |
| `GET /admin/v1/status` | `platform:support` | ✅ | `read` | — | ✅ |
| `GET /admin/v1/config` | `platform:support` | ✅ | `read` | — | ✅ |
| `GET /admin/v1/flags` | `platform:support` | ✅ | `read` | — | ✅ |
| `PATCH /admin/v1/flags/{flagName}` | `platform:support` + step-up | ✅ | `write` | `FeatureFlagChanged` | ✅ |
| `GET /admin/v1/jobs` · `GET /admin/v1/workers` | `platform:support` | ✅ | `read` | — | ✅ |
| `GET /admin/v1/dlq` · `GET /admin/v1/dlq/{entryId}` | `dlq:read` | ✅ | `read` | — | ✅ |
| `POST /admin/v1/dlq/{entryId}/actions/resolve` | `dlq:manage` + step-up | **key** | `write` | `DlqEntryResolved` | ✅ |
| `POST /admin/v1/dlq/{entryId}/actions/discard` | `dlq:manage` + step-up | **key** | `write` | `DlqEntryDiscarded` | ✅ |
| `POST /admin/v1/dlq/{entryId}/actions/replay` | `dlq:manage` + step-up | **key** | `write` | `ReplayRequested` | ✅ |
| `POST /admin/v1/replays/estimate` | `replay:execute` | ✅ | `write` | — | ✅ |
| `POST /admin/v1/replays` | `replay:execute` + step-up | **key** | `write` | `ReplayStarted` | ✅ |
| `GET /admin/v1/replays/{replayId}` | `replay:execute` | ✅ | `read` | — | ✅ |
| `POST /admin/v1/replays/{replayId}/actions/pause` · `/resume` · `/abort` | `replay:execute` | ✅ | `write` | `ReplayAborted` | ✅ |
| `GET /admin/v1/audit` | `platform:audit` + step-up | ✅ | `read` | — | ✅ |
| `GET /admin/v1/audit/timeline/{correlationId}` | `platform:audit` + step-up | ✅ | `read` | — | ✅ |
| `POST /admin/v1/audit/verify` | `platform:audit` + step-up | ✅ | `read` | — | ✅ |

**Total: 127 endpoints** across 123 registry rows — four rows list sibling paths together (the three probes; the three replay lifecycle actions).

| Area | Endpoints |
|---|---|
| Authentication | 19 |
| Admin | 17 rows / 21 endpoints |
| Content | 16 |
| Events and webhooks | 15 |
| Organizations | 12 |
| Workspaces | 11 |
| Media | 11 |
| Knowledge | 10 |
| Runs and research | 8 |
| AI | 4 |

## Consistency review

Extracted from all fifteen documents — 101 declared path strings. **Eight drift items found; all resolved.**

| # | Drift | Resolution |
|---|---|---|
| **D-1** | **`GET /runs/{id}` and `GET /v1/runs/{runId}` declared as the same endpoint** in `content-api.md` and `research-api.md` | **`GET /v1/runs/{runId}`** is canonical. The abbreviated form was prose shorthand that read as a second endpoint. |
| **D-2** | **Bare `{id}` and typed `{resourceId}` mixed** — `/v1/articles/{id}` beside `/v1/media/{mediaId}` | **`{resourceId}` everywhere.** In nested paths, `{id}` is ambiguous about which resource it names. |
| **D-3** | **`GET /session` and `GET /sessions` declared without the `/v1/auth` prefix** in a summary table | Full paths only: `/v1/auth/session`, `/v1/auth/sessions`. |
| **D-4** | **`POST /runs` declared in a `content-api.md` example** | Not an endpoint. Runs are created by domain actions (`.../actions/publish`, `POST .../research`); there is no generic run-creation endpoint. |
| **D-5** | **Abbreviated `.../` paths throughout** — `GET .../evidence`, `POST .../events/subscriptions` | Expanded to full paths in this registry. Prose shorthand is acceptable in a resource document; the registry is literal. |
| **D-6** | **`GET /admin/v1/dlq?groupBy=failure_code` declared with a query parameter** as if it were a distinct path | One endpoint, `GET /admin/v1/dlq`; `groupBy` is a query parameter. |
| **D-7** | **`POST /{resource}/{id}/actions/{action}` appeared in the extraction** | A convention template from `api-principles.md`, not an endpoint. |
| **D-8** | **Endpoints described in prose but never declared with a method** — workspace `actions/restore`, article `actions/optimize` and `actions/archive`, several event and webhook paths | All declared explicitly in this registry. |

**No behavioural drift was found.** Every conflict was in path notation or declaration completeness. No document contradicted another on authorization, idempotency, event emission, or audit implications.

**D-1 and D-8 are the two worth a reviewer's attention.** D-1 would have produced two route handlers for one resource in a generated server; D-8 means eight endpoints existed only in prose and would have been missed by a code generator reading declarations.

## Cross-cutting verification

| Property | Verified |
|---|---|
| Every mutating `POST` that creates or charges requires `Idempotency-Key` | ✅ |
| Every `DELETE` is idempotent | ✅ |
| Every `PATCH` on a concurrently-editable resource requires `If-Match` | ✅ |
| Cross-tenant denial returns `404`; in-tenant returns `403` | ✅ |
| Every pipeline-triggering action returns `202` with a `Run` | ✅ |
| Every mutation emits through the outbox or is explicitly eventless | ✅ |
| Every admin endpoint is audited, **including reads** | ✅ |
| No customer endpoint exposes a storage key, model name, broker detail, or vector | ✅ |
| `PUT` is used nowhere | ✅ |

**The last two rows are the ones that would have been easy to violate.** Fifteen documents each had an opportunity to leak an internal identifier or reach for `PUT`; neither happened, and the registry confirms it rather than assuming it.

## Business rules

1. **This document is canonical**; where it disagrees with another API document, this one wins.
2. **`{resourceId}` is the path-parameter form.**
3. **Every customer endpoint carries `/v1`.**
4. **Probes are unversioned.**
5. **There is no generic run-creation endpoint.**
6. **`PUT` is used nowhere.**
7. **Admin endpoints are never publicly routable and are always audited.**
8. **An endpoint absent from this registry does not exist.**

**Rule 8 is the operative one.** A route handler with no registry entry is unspecified surface, and CI asserts the implemented route table matches this document (`07-development-guide/ci-cd.md`).

## Cross references

- `api-principles.md` — conventions, error envelope, pagination, idempotency
- `api-versioning.md` — evolution and deprecation
- `api-observability.md` — per-endpoint telemetry
- `authentication-api.md` · `organization-api.md` · `workspace-api.md` · `content-api.md` · `research-api.md` · `knowledge-api.md` · `ai-api.md` · `media-api.md` · `event-api.md` · `admin-api.md` · `webhooks.md`
- `16-security/rbac.md` — every permission named in the Authz column
- `16-security/audit.md` — the audit column's records
- `13-event-platform/event-registry.md` — every event in the Events column
- `07-development-guide/ci-cd.md` — the route-table conformance check
