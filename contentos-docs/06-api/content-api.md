# Content API

> **Status:** v1.0 — complete. Phase 12. **Contracts only.**
> **`status` is read-only.** No client sets it. Transitions happen through pipeline progression and explicit actions, because the workflow is owned by `05-content-platform/orchestration.md` and a settable status field would let a client skip a quality gate.

## Overview

**Purpose.** Define endpoints for articles, outlines, revisions, quality gates, citations, and the publish, refresh, and optimize actions.

**Business workflow is never redefined here.** The pipeline, the gate rules, and the approval requirements belong to Phase 5. This document exposes them as HTTP contracts and states which constraints a client will hit.

**Two Phase 5 rules drive most of the design below.** Writing cannot proceed without an approved outline — enforced by a database CHECK constraint, not application logic (`03-database/tables.md`). And publishing requires a `pass` or `soft-warn` gate verdict *for the specific revision being published* (`05-content-platform/publishing-engine.md`).

## Common contract

| Property | Value |
|---|---|
| Base path | `/v1/workspaces/{workspaceId}/articles` and `/v1/articles/{articleId}` |
| Authorization | Workspace-tier `article:*` permissions |
| Tenant scope | Derived from the article, never from a parameter |
| Rate-limit class | `read`, `write`, or **`expensive`** for pipeline-triggering actions |
| Audit | Every mutation and every action |

## Article resource

```ts
interface Article {
  readonly id: string;
  readonly projectId: string;
  readonly type: 'guide' | 'comparison' | 'listicle' | 'how_to' | 'review' | 'news' | 'pillar';
  readonly status: ArticleStatus;                 // READ-ONLY
  readonly title: string | null;
  readonly brief: ArticleBrief;                   // snapshotted at creation
  readonly currentRevision: number;
  readonly approvedOutlineId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly publishedAt: string | null;
}

type ArticleStatus =
  | 'idea' | 'researching' | 'planning' | 'outline_ready' | 'outline_approved'
  | 'drafting' | 'in_review' | 'gate_blocked' | 'optimizing' | 'revalidating'
  | 'ready_to_publish' | 'published' | 'refreshing' | 'archived';
```

**`status` has fourteen values and none is settable.** They are exposed because a client must render progress and enable actions; they are read-only because each transition has preconditions the pipeline enforces.

**`brief` is snapshotted at creation from project defaults.** Changing a project default does not retroactively alter an in-flight article — which is why the brief is a value on the article rather than a reference to the project.

**`approvedOutlineId` is `null` until an outline is approved**, and its absence is what blocks writing.

## Create article

| Field | Value |
|---|---|
| **Purpose** | Create an article in the `idea` state |
| **Method · Path** | `POST /v1/workspaces/{workspaceId}/articles` |
| **Authorization** | `article:create` |
| **Idempotency** | **`Idempotency-Key` required** |
| **Rate limit** | `write` |
| **Events** | `ArticleCreated` |
| **Audit** | Recorded with actor and project |

```ts
// request
{
  projectId: string;
  type: ArticleType;
  title?: string;
  brief?: Partial<ArticleBrief>;      // merged over project defaults
}

// 201 — Location: /v1/articles/{id}
{ article: Article }
```

| Error | Code | Status |
|---|---|---|
| Project not in this workspace | `VALIDATION_FIELD_INVALID` | 400 |
| Project archived | `DOMAIN_STATE_INVALID` | 409 |
| Article quota reached | `DOMAIN_QUOTA_EXCEEDED` | 402 |
| Lacks permission | `SECURITY_AUTHORIZATION_DENIED` | 403 |

**Creation does not start a pipeline run.** An article begins at `idea`; running the pipeline is a separate, credit-charging action. Coupling them would make an accidental `POST` cost money.

## Read, list, update

| Field | Value |
|---|---|
| **Purpose** | Retrieve articles and edit metadata |
| **Method · Path** | `GET .../articles` · `GET /v1/articles/{id}` · `PATCH /v1/articles/{id}` |
| **Authorization** | `article:read` · `article:update` |
| **Idempotency** | `PATCH` idempotent; **`If-Match` required** |
| **Rate limit** | `read` · `write` |
| **Events** | `ArticleUpdated` |
| **Audit** | Changed field names |

```ts
// PATCH — metadata only
{ title?: string; brief?: Partial<ArticleBrief>; projectId?: string; }
```

**Filterable:** `status`, `type`, `projectId`, `createdAfter`, `createdBefore`, `q`.
**Sortable:** `createdAt`, `updatedAt`, `publishedAt`, `title`. Default `-updatedAt`.
**Expandable:** `project`, `currentRevisionSummary`.

| Error | Code | Status |
|---|---|---|
| Not reachable in the caller's tenants | `SECURITY_AUTHORIZATION_DENIED` | **404** |
| Attempt to set `status` | `VALIDATION_FIELD_INVALID` | **400** |
| Brief change while a run is active | `DOMAIN_STATE_INVALID` | 409 |
| Stale `If-Match` | `PRECONDITION_FAILED` | 412 |

**Sending `status` in a `PATCH` is `400`, not silently ignored.** A client believing it changed state and receiving `200` would build a broken workflow on a no-op — the same reasoning behind `.strict()` request schemas (`api-principles.md`).

**Changing the brief mid-run is `409`.** The run snapshotted the brief at its start; allowing a change would produce content matching neither the old brief nor the new one.

## Outlines

| Field | Value |
|---|---|
| **Purpose** | Retrieve outline versions and approve one |
| **Method · Path** | `GET /v1/articles/{id}/outlines` · `GET .../outlines/{version}` · `POST /v1/articles/{id}/actions/approve-outline` |
| **Authorization** | `article:read` · `article:update` |
| **Idempotency** | Approve is idempotent per outline version |
| **Rate limit** | `read` · `write` |
| **Events** | `OutlineApproved` |
| **Audit** | Approver, outline version, and rationale |

```ts
interface Outline {
  readonly id: string;
  readonly versionNumber: number;
  readonly status: 'draft' | 'coverage_thin' | 'awaiting_approval' | 'approved' | 'superseded';
  readonly intent: object;
  readonly sections: readonly OutlineSection[];
  readonly coverage: CoverageReport;
  readonly rationale: ExplainabilityEnvelope;      // ADR-009
}

// approve request
{ outlineVersionId: string; note?: string; }
```

| Error | Code | Status |
|---|---|---|
| Outline not `awaiting_approval` | `DOMAIN_STATE_INVALID` | 409 |
| Superseded outline | `CONTENT_OUTLINE_SUPERSEDED` | 409 |
| Approving a `coverage_thin` outline without acknowledgement | `CONTENT_COVERAGE_THIN` | 409 |

**Approval is a human decision and is required before writing.** The database CHECK constraint refuses to move an article to `drafting` without `approved_outline_id`, so a client cannot skip this by calling a later action (`03-database/tables.md`).

**`rationale` carries the Explainability Envelope** — `{ recommendation, reason, evidence[], expected_impact, confidence }`. A recommendation without one is a defect (ADR-009), so it is a required response field rather than an optional enrichment.

**`coverage_thin` can be approved with explicit acknowledgement.** The platform advises; the customer decides. Refusing outright would substitute the platform's judgement for the editor's.

## Revisions

| Field | Value |
|---|---|
| **Purpose** | Retrieve draft content |
| **Method · Path** | `GET /v1/articles/{id}/revisions` · `GET .../revisions/{number}` |
| **Authorization** | `article:read` |
| **Idempotency** | Read-only |
| **Rate limit** | `read` |
| **Events** | None |
| **Audit** | Not recorded — ordinary reads |

```ts
interface Revision {
  readonly revisionNumber: number;
  readonly origin: 'initial_draft' | 'revision_requested' | 'seo_optimization' | 'human_edit' | 'refresh';
  readonly sections: readonly Section[];
  readonly contentHash: string;
  readonly createdAt: string;
}
```

**Revisions are append-only and immutable.** There is no `PATCH` on a revision — human edits create a new revision with `origin: 'human_edit'`, which preserves the audit trail of what the platform generated versus what a person changed.

**`contentHash` lets a client detect whether content changed** without diffing full section bodies.

## Quality gates

| Field | Value |
|---|---|
| **Purpose** | Retrieve gate results for a revision |
| **Method · Path** | `GET /v1/articles/{id}/revisions/{number}/gates` |
| **Authorization** | `article:read` |
| **Idempotency** | Read-only |
| **Rate limit** | `read` |
| **Events** | None |
| **Audit** | Not recorded |

```ts
interface GateResult {
  readonly gate: string;
  readonly verdict: 'pass' | 'soft-warn' | 'block';
  readonly scores: readonly Score[];
  readonly explanation: ExplainabilityEnvelope;
}

interface Score {
  readonly category: string;          // canonical registry value
  readonly value: number;             // INTEGER 0–100, higher is better
  readonly confidence: number;        // INTEGER 0–100
  readonly contractVersion: string;
}
```

**Exactly three verdicts exist and a fourth is unrepresentable** (ADR-009). `block` prevents publication; `soft-warn` does not.

**Scores follow ADR-021 exactly**: integer 0–100, higher always better, orthogonal confidence, mandatory explanation, and `contractVersion` separate from the opaque `algorithmVersion` — which is **not exposed**, because it is an internal implementation detail whose changes must not look like contract changes.

## Publish

| Field | Value |
|---|---|
| **Purpose** | Publish a revision to a connected target |
| **Method · Path** | `POST /v1/articles/{id}/actions/publish` |
| **Authorization** | **`publish:execute`** |
| **Idempotency** | **`Idempotency-Key` required** |
| **Rate limit** | `expensive` |
| **Events** | `ArticlePublishRequested`, then `ArticlePublished` |
| **Audit** | Actor, target, revision, and gate verdict recorded |

```ts
// request
{ revisionNumber: number; targetId: string; scheduledFor?: string; }

// 202 — Location: /v1/runs/{runId}
{ run: { id: string; status: 'accepted'; statusUrl: string } }
```

| Error | Code | Status |
|---|---|---|
| **Gate verdict is `block`** | `CONTENT_GATE_BLOCKED` | **409** |
| Gate verdict missing for this revision | `CONTENT_GATE_MISSING` | 409 |
| **Gate verdict belongs to a different revision** | `CONTENT_GATE_MISMATCH` | 409 |
| Target not connected | `INTEGRATION_NOT_CONNECTED` | 409 |
| Lacks `publish:execute` | `SECURITY_AUTHORIZATION_DENIED` | 403 |

**Publishing verifies the gate verdict for *that specific revision*, not the article.** A revision that passed, followed by an edit producing a new revision, does not inherit the verdict — `CONTENT_GATE_MISMATCH` is a distinct code because it is a distinct mistake from having no verdict at all (`05-content-platform/publishing-engine.md`).

**A `block` verdict cannot be overridden through this API.** The path forward is fixing the content or a human review decision recorded in the pipeline — not a force flag, which would make the gate advisory.

**Returns `202` with a run handle.** Publishing reaches an external CMS with retry and rollback semantics; a synchronous call would hold a connection through a third-party timeout (`api-principles.md`).

**Contributors cannot publish.** `publish:execute` is held by Editor and Workspace Admin only — the distinction that makes Contributor safe for freelancers (`16-security/rbac.md`).

## Refresh and optimize

| Field | Value |
|---|---|
| **Purpose** | Re-run content against current data, or apply SEO optimization |
| **Method · Path** | `POST /v1/articles/{id}/actions/refresh` · `.../actions/optimize` |
| **Authorization** | `article:execute` |
| **Idempotency** | **`Idempotency-Key` required** |
| **Rate limit** | **`expensive`** — both charge credits |
| **Events** | `ArticleRefreshRequested` · `ArticleOptimizationRequested` |
| **Audit** | Actor, scope, and credit hold recorded |

```ts
// refresh
{ scope?: 'full' | 'evidence-only' | 'sections'; sections?: string[]; }

// 202
{ run: { id, status: 'accepted', statusUrl } }
```

| Error | Code | Status |
|---|---|---|
| Insufficient credits | `DOMAIN_QUOTA_EXCEEDED` | **402** |
| Run already active for this article | `CONTENT_RUN_IN_PROGRESS` | 409 |
| Article not `published` (refresh) | `DOMAIN_STATE_INVALID` | 409 |

**Refresh applies to published articles; optimize applies to drafts.** Refreshing an unpublished article is just writing it, and optimizing a published one would change live content without a publish step.

**Both place a credit hold before starting and release it on failure.** A run that failed halfway does not charge for work not delivered (`04-platform/billing.md`).

**One active run per article.** Concurrent runs would produce revisions racing to become current.

## Citations

| Field | Value |
|---|---|
| **Purpose** | Retrieve the grounding chain for a revision |
| **Method · Path** | `GET /v1/articles/{id}/revisions/{number}/citations` |
| **Authorization** | `article:read` |
| **Idempotency** | Read-only |
| **Rate limit** | `read` |
| **Events** | None |
| **Audit** | Not recorded |

```ts
interface CitationAnchor {
  readonly claimText: string;
  readonly offsets: { start: number; end: number };
  readonly evidenceId: string | null;
  readonly supported: boolean;
}
```

**`supported: false` with `evidenceId: null` is a legitimate, visible state** — an unsupported claim. Hiding it would let ungrounded content look grounded, which is exactly what the grounding invariant exists to prevent.

**A dangling anchor is unrepresentable** — the database refuses evidence deletion while a citation references it (`RESTRICT`), and a CHECK constraint enforces the grounding relationship (`03-database/tables.md`).

**Evidence detail is fetched from the Knowledge API**, not embedded here. This endpoint returns the chain; `knowledge-api.md` returns what the evidence says.

## Delete and archive

| Field | Value |
|---|---|
| **Purpose** | Soft-delete or archive an article |
| **Method · Path** | `DELETE /v1/articles/{id}` · `POST .../actions/archive` |
| **Authorization** | `article:delete` · `article:update` |
| **Idempotency** | Both idempotent |
| **Rate limit** | `write` |
| **Events** | `ArticleDeleted` · `ArticleArchived` |
| **Audit** | Actor and reason |

| Error | Code | Status |
|---|---|---|
| **Live published content exists** | `CONTENT_PUBLISHED_EXISTS` | **409** |
| Legal hold | `COMPLIANCE_LEGAL_HOLD` | 409 |

**Deletion is refused while live `published_content` rows exist** (`03-database/tables.md`). Deleting the source of a live customer page would leave content published with no record of where it came from — unpublish first.

## Business rules

1. **`status` is read-only**; sending it is `400`.
2. **Creation does not start a run.**
3. **The brief is snapshotted at creation** and cannot change mid-run.
4. **Outline approval is required before writing**, enforced by CHECK constraint.
5. **`coverage_thin` outlines may be approved with acknowledgement.**
6. **Revisions are append-only**; human edits create new revisions.
7. **Exactly three gate verdicts exist.**
8. **Publishing verifies the verdict for that specific revision.**
9. **`block` cannot be overridden through the API.**
10. **`algorithmVersion` is never exposed**; `contractVersion` is.
11. **Pipeline-triggering actions return `202` with a run handle.**
12. **Refresh, optimize, and publish require `Idempotency-Key`.**
13. **One active run per article.**
14. **Credit holds are placed before and released on failure.**
15. **Unsupported citations are visible, never hidden.**
16. **Deletion is refused while live published content exists.**

## Events emitted

| Event | Trigger |
|---|---|
| `ArticleCreated` · `ArticleUpdated` · `ArticleDeleted` · `ArticleArchived` | Lifecycle |
| `OutlineApproved` | Approval |
| `ArticlePublishRequested` · `ArticlePublished` | Publishing |
| `ArticleRefreshRequested` · `ArticleOptimizationRequested` | Re-runs |

**Payloads carry identifiers only — never article bodies, outlines, or briefs** (`13-event-platform/event-registry.md`). A consumer needing content fetches it through this API under its own authorization.

**All are published through the transactional outbox** in the state-changing transaction.

## Audit implications

| Action | Recorded |
|---|---|
| Create, update, delete, archive | Actor, changed fields, reason |
| **Outline approval** | Approver, version, coverage acknowledgement |
| **Publish** | Actor, target, revision, **gate verdict** |
| Refresh, optimize | Actor, scope, credit hold |

**Publishing records the gate verdict** because "was this checked before it went live" is the question an editorial audit asks.

## Cross references

- `05-content-platform/orchestration.md` — **the pipeline these actions trigger**
- `05-content-platform/publishing-engine.md` — gate verdict verification
- `05-content-platform/writing-engine.md` — revisions, `MediaSpec` (ADR-018)
- `05-content-platform/review-engine.md` — gate evaluation
- `01-system-architecture/14-scoring-contract.md` — **ADR-021 score shape**
- `03-database/tables.md` — status enum, outline constraint, citation grounding
- `api-principles.md` — actions, `202`, idempotency, `If-Match`
- `research-api.md` · `knowledge-api.md` · `ai-api.md` · `media-api.md`
- `16-security/rbac.md` — `publish:execute` and Contributor limits
- `04-platform/billing.md` — credit holds
- `13-event-platform/event-registry.md` — payload content rules
