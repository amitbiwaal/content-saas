# Research API

> **Status:** v1.0 — complete. Phase 12. **Contracts only.**
> **Internal pipeline stages are never exposed.** A client sees a coarse, stable phase vocabulary. The orchestrator's actual state machine changes as the pipeline evolves, and a client branching on it would break on every improvement.

## Overview

**Purpose.** Define endpoints for research jobs, SERP and competitor results, evidence collection, job status, streaming progress, and cancellation.

**This document also defines the canonical `Run` resource**, which `content-api.md` and `ai-api.md` both reference. Every long-running operation in the platform returns the same handle shape, so a client writes one polling and streaming implementation rather than three.

**Research spans Phase 5 and Phase 7.** The Research Engine gathers; the Knowledge Platform stores evidence and provenance. This API exposes the job and its results; evidence itself is retrieved through `knowledge-api.md`.

## The Run resource — canonical

```ts
interface Run {
  readonly id: string;
  readonly kind: 'research' | 'content' | 'refresh' | 'optimize' | 'publish' | 'ai';
  readonly status: RunStatus;
  readonly phase: RunPhase;                    // COARSE — see below
  readonly progress: number;                   // 0–100
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly cancellable: boolean;
  readonly error: { code: string; message: string } | null;
  readonly resultUrl: string | null;
  readonly statusUrl: string;
  readonly eventsUrl: string;
}

type RunStatus = 'queued' | 'running' | 'awaiting_input' | 'completed' | 'failed' | 'cancelled';

type RunPhase = 'preparing' | 'gathering' | 'analyzing' | 'synthesizing' | 'finalizing';
```

**Six statuses and five phases. That is the entire public vocabulary.**

**The internal orchestrator runs a far more detailed state machine** — keyword intelligence, SERP intelligence, competitor intelligence, research, planning, outline approval, writing, review, SEO, fast re-check (`05-content-platform/orchestration.md`). None of it appears here.

**This is a deliberate contract decision, not information hiding for its own sake.** Those stages are renamed, merged, split, and reordered as the pipeline improves. A client that rendered `SerpIntelligence` in its UI would break on a refactor that changed nothing a customer can observe. The coarse vocabulary is stable across pipeline evolution.

**`awaiting_input` is the one status that requires client action** — an outline awaiting approval, or a human review decision. It is distinguished from `running` because a job that will never progress without the customer is not the same as one making progress.

## Start a research job

| Field | Value |
|---|---|
| **Purpose** | Begin research for a topic or an article |
| **Method · Path** | `POST /v1/workspaces/{workspaceId}/research` |
| **Authorization** | **`research:execute`** |
| **Idempotency** | **`Idempotency-Key` required** |
| **Rate limit** | **`expensive`** — charges credits |
| **Events** | `ResearchRequested` |
| **Audit** | Actor, scope, credit hold |

```ts
// request
{
  articleId?: string;              // attach to an article, or omit for standalone
  topic?: string;                  // required if articleId is omitted
  keywords?: string[];
  locale?: string;
  depth?: 'standard' | 'deep';
  competitorUrls?: string[];       // optional explicit competitors
}

// 202 — Location: /v1/runs/{runId}
{ run: Run }
```

| Error | Code | Status |
|---|---|---|
| Neither `articleId` nor `topic` | `VALIDATION_FIELD_INVALID` | 400 |
| Insufficient credits | `DOMAIN_QUOTA_EXCEEDED` | **402** |
| Run already active for the article | `CONTENT_RUN_IN_PROGRESS` | 409 |
| **A competitor URL resolves to a private address** | `VALIDATION_FIELD_INVALID` | 400 |
| Provider unavailable | `PROVIDER_UNAVAILABLE` | 503 |

**Customer-supplied `competitorUrls` are validated through the SSRF chokepoint before the job starts** — scheme, DNS resolution, private-range blocklist, and redirect re-validation (`16-security/api-security.md`). Rejection is `400` at submission rather than a job that fails later, because the client can fix it immediately.

**Credits are held at acceptance and released if the run fails.** A `402` here means the hold could not be placed, and no work began (`04-platform/billing.md`).

**`depth` is a coarse quality knob, not a stage selector.** It maps to internal budget and breadth decisions the API does not expose.

## Job status

| Field | Value |
|---|---|
| **Purpose** | Retrieve current run state |
| **Method · Path** | `GET /v1/runs/{runId}` |
| **Authorization** | `research:read` or `article:read` per the run's subject |
| **Idempotency** | Read-only |
| **Rate limit** | `read` |
| **Events** | None |
| **Audit** | Not recorded |

```ts
// 200
{ run: Run }
```

| Error | Code | Status |
|---|---|---|
| Run in another tenant | `SECURITY_AUTHORIZATION_DENIED` | **404** |
| Unknown run | `NOT_FOUND` | 404 |

**`GET` on a run is always available and is the source of truth.** The event stream below is a convenience; a client that missed events reconstructs state here (`api-principles.md`).

**Polling is acceptable and rate-limited as `read`.** Not every client can hold an SSE connection, and a contract that required streaming would exclude serverless and mobile consumers.

## Progress stream

| Field | Value |
|---|---|
| **Purpose** | Stream progress without polling |
| **Method · Path** | `GET /v1/runs/{runId}/events` |
| **Authorization** | Same as `GET /runs/{runId}` |
| **Idempotency** | Read-only |
| **Rate limit** | `read`, connection-bounded |
| **Events** | None emitted; this consumes them |
| **Audit** | Not recorded |

```
event: progress
data: {"status":"running","phase":"gathering","progress":34}

event: awaiting_input
data: {"reason":"outline_approval","actionUrl":"/v1/articles/{id}/actions/approve-outline"}

event: completed
data: {"status":"completed","resultUrl":"/v1/runs/{id}/results"}
```

**Server-Sent Events, not WebSockets.** Progress is unidirectional; SSE reconnects automatically, works through ordinary HTTP infrastructure, and needs no separate protocol upgrade (`01-system-architecture/09-request-flow.md`).

**`Last-Event-ID` is honoured on reconnect** and replays missed events, so a dropped connection does not lose progress.

**The stream carries no results, only state.** Results are fetched from `resultUrl` — a stream that embedded a full research payload would be unbounded and unresumable.

## Results

| Field | Value |
|---|---|
| **Purpose** | Retrieve completed research output |
| **Method · Path** | `GET /v1/runs/{runId}/results` |
| **Authorization** | `research:read` |
| **Idempotency** | Read-only |
| **Rate limit** | `read` |
| **Events** | None |
| **Audit** | Not recorded |

```ts
interface ResearchResult {
  readonly runId: string;
  readonly topic: string;
  readonly evidenceCount: number;
  readonly evidenceIds: readonly string[];      // resolve via knowledge-api.md
  readonly serp: SerpSummary;
  readonly competitors: readonly CompetitorSummary[];
  readonly coverage: CoverageReport;
  readonly completedAt: string;
}
```

| Error | Code | Status |
|---|---|---|
| Run not completed | `RESEARCH_NOT_COMPLETE` | 409 |
| Run failed | `RESEARCH_FAILED` | 409 |

**Results return evidence *identifiers*, not evidence bodies.** Evidence is owned by the Knowledge Platform, is reused across articles, and carries provenance that must not be duplicated into a research payload where it would go stale (`11-knowledge-platform/provenance.md`).

**`409` for an incomplete run, not `404`.** The resource exists; it is not ready. A `404` would be indistinguishable from a wrong id.

## SERP data

| Field | Value |
|---|---|
| **Purpose** | Retrieve search-results data collected for the run |
| **Method · Path** | `GET /v1/runs/{runId}/serp` |
| **Authorization** | `research:read` |
| **Idempotency** | Read-only |
| **Rate limit** | `read` |
| **Events** | None |
| **Audit** | Not recorded |

```ts
interface SerpSummary {
  readonly keyword: string;
  readonly locale: string;
  readonly collectedAt: string;
  readonly results: readonly {
    readonly position: number;
    readonly url: string;
    readonly title: string;
    readonly domain: string;
  }[];
  readonly features: readonly string[];        // 'featured_snippet', 'people_also_ask', …
}
```

**`collectedAt` is mandatory and prominent.** SERP data ages within days; a client rendering it without a timestamp presents stale rankings as current. Freshness is a first-class property throughout the Knowledge Platform, and it surfaces here (`11-knowledge-platform/freshness-engine.md`).

**Provider identity is never exposed.** Which data provider supplied a SERP is an implementation detail behind the Provider Layer, and exposing it would make provider substitution a breaking API change (`09-integrations/`).

## Competitor analysis

| Field | Value |
|---|---|
| **Purpose** | Retrieve competitor page analysis |
| **Method · Path** | `GET /v1/runs/{runId}/competitors` |
| **Authorization** | `research:read` |
| **Idempotency** | Read-only |
| **Rate limit** | `read` |
| **Events** | None |
| **Audit** | Not recorded |

```ts
interface CompetitorSummary {
  readonly url: string;
  readonly domain: string;
  readonly title: string;
  readonly wordCount: number;
  readonly headingStructure: readonly { level: number; text: string }[];
  readonly topicsCovered: readonly string[];
  readonly fetchedAt: string;
  readonly fetchStatus: 'ok' | 'blocked' | 'unavailable' | 'excluded';
}
```

**`fetchStatus` is exposed because partial competitor coverage changes how results should be read.** A competitor set where three of ten were `blocked` is a weaker basis for a coverage gap analysis, and hiding that would present incomplete analysis as complete.

**Competitor content is never returned in full.** Structure, topics, and metrics are returned; the page body is not. Redistributing a competitor's content through an API is a copyright exposure the platform does not take.

**`excluded` means the URL failed SSRF validation** or matched an exclusion rule — surfaced rather than silently dropped.

## Cancellation

| Field | Value |
|---|---|
| **Purpose** | Cancel a running job |
| **Method · Path** | `POST /v1/runs/{runId}/actions/cancel` |
| **Authorization** | **`run:cancel`** |
| **Idempotency** | **Yes** — cancelling a cancelled run is `200` |
| **Rate limit** | `write` |
| **Events** | `RunCancelled` |
| **Audit** | Actor and reason recorded |

```ts
{ reason?: string; }
// 200
{ run: Run }        // status: 'cancelled'
```

| Error | Code | Status |
|---|---|---|
| Run already completed | `RUN_NOT_CANCELLABLE` | 409 |
| Run in a non-cancellable phase | `RUN_NOT_CANCELLABLE` | 409 |

**Cancellation is cooperative and may not be instant.** The run transitions to `cancelled` when the current activity reaches a safe point; work already committed is not rolled back. `cancellable` on the resource tells a client whether to offer the action at all.

**Credits are released for work not performed, and retained for work already done.** A run cancelled at 80% is charged for 80% — refunding fully would make cancellation a free way to consume provider capacity (`04-platform/billing.md`).

**Cancelling a completed run is `409`, not silent success.** Unlike `DELETE`, the client's intent cannot be satisfied — the work already happened.

## Listing runs

| Field | Value |
|---|---|
| **Purpose** | Enumerate runs in a workspace |
| **Method · Path** | `GET /v1/workspaces/{workspaceId}/runs` |
| **Authorization** | `run:read` |
| **Idempotency** | Read-only |
| **Rate limit** | `read` |
| **Events** | None |
| **Audit** | Not recorded |

**Filterable:** `kind`, `status`, `articleId`, `startedAfter`, `startedBefore`.
**Sortable:** `startedAt`, `completedAt`. Default `-startedAt`.

**Cursor-paginated with no total by default**, like every list endpoint (`api-principles.md`).

## Business rules

1. **Internal pipeline stages are never exposed** — five coarse phases only.
2. **`Run` is one shape across every long-running operation.**
3. **`awaiting_input` is distinct from `running`.**
4. **Research returns `202` with a run handle.**
5. **`Idempotency-Key` is required to start a job.**
6. **Customer-supplied URLs pass SSRF validation at submission.**
7. **Credits are held at acceptance, released on failure, retained for work done.**
8. **`GET /runs/{id}` is the source of truth; the stream is a convenience.**
9. **`Last-Event-ID` replays missed events.**
10. **The stream carries state, never results.**
11. **Results return evidence identifiers, never evidence bodies.**
12. **`collectedAt` and `fetchedAt` are mandatory on time-sensitive data.**
13. **Provider identity is never exposed.**
14. **Competitor page bodies are never returned.**
15. **`fetchStatus` surfaces partial coverage rather than hiding it.**
16. **Cancellation is cooperative and idempotent**; cancelling a completed run is `409`.

## Events emitted

| Event | Trigger |
|---|---|
| `ResearchRequested` | Job accepted |
| `ResearchCompleted` · `ResearchFailed` | Terminal outcome |
| `RunCancelled` | Cancellation |

**Payloads carry run and evidence identifiers only — never SERP data, competitor content, or evidence text** (`13-event-platform/event-registry.md`).

**Progress is not an event type.** Per-percent progress across every run would flood the bus with data no consumer acts on; progress lives in the run resource and its SSE stream.

## Audit implications

| Action | Recorded |
|---|---|
| Start | Actor, scope, credit hold, competitor URLs |
| Cancel | Actor, reason, phase at cancellation |
| Result retrieval | **Not recorded** — an ordinary read |

**Submitted competitor URLs are audited** because they are customer-supplied inputs to an outbound fetch, and an SSRF investigation needs to know what was requested (`16-security/threat-model.md`).

## Cross references

- `05-content-platform/research-engine.md` — **the engine this exposes**
- `05-content-platform/orchestration.md` — the internal state machine deliberately hidden
- `11-knowledge-platform/provenance.md` — evidence ownership and provenance
- `11-knowledge-platform/freshness-engine.md` — why `collectedAt` matters
- `knowledge-api.md` — resolving the evidence identifiers returned here
- `content-api.md` — articles these runs serve
- `ai-api.md` — the shared `Run` shape
- `api-principles.md` — `202`, SSE, cursor pagination
- `16-security/api-security.md` — SSRF validation of competitor URLs
- `16-security/rbac.md` — `research:execute`, `run:cancel`
- `04-platform/billing.md` — credit holds and partial charging
- `09-integrations/` — the Provider Layer whose identity is hidden
- `01-system-architecture/09-request-flow.md` — 202 plus handle, SSE progress
