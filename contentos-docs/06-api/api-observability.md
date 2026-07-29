# API Observability

> **Status:** v1.0 — complete. Phase 12.
> **This document owns the HTTP surface only.** Authentication failures, authorization denials, and event delivery signals are already owned elsewhere and are referenced, never redefined — a metric with two owners drifts, and the drift surfaces during an incident.

## Overview

**Purpose.** Define API-layer telemetry: request metrics, trace identifiers, log schema at the edge, and the SLOs the external surface is operated against.

**Ownership is explicit because this layer is where every platform's signals converge.**

| Signal | Owner |
|---|---|
| Authentication and authorization failures | **`16-security/security-observability.md`** |
| Invariant breaches, cross-tenant attempts | **`16-security/security-observability.md`** |
| Event delivery, consumer lag, DLQ | **`13-event-platform/observability.md`** |
| Storage, media, CDN | **`12-storage-platform/storage-observability.md`** |
| Metrics infrastructure, dashboards | `14-operations/monitoring.md` |
| **HTTP request/response semantics** | **This document** |

**What this document adds is the API dimension.** `authz_denials_total` is owned by Security; this document specifies that API-layer telemetry labels it by `endpoint` and `version`, so an operator can answer "which endpoint is denying" rather than only "denials are up."

## Request metrics

Names are **frozen**. No component emits an alternate name for a catalogued concept.

| Metric | Type | Labels |
|---|---|---|
| `api_requests_total` | counter | `method`, `endpoint`, `status`, `version` |
| `api_request_duration_seconds` | histogram | `method`, `endpoint`, `version` |
| `api_request_size_bytes` · `api_response_size_bytes` | histogram | `endpoint` |
| `api_in_flight_requests` | gauge | — |
| `api_errors_total` | counter | `endpoint`, `code`, `status` |
| `api_validation_failures_total` | counter | `endpoint`, `field` |
| `api_rate_limit_rejections_total` | counter | `endpoint`, `scope`, `tenant_bucket` |
| `api_idempotency_hits_total` | counter | `endpoint`, `outcome` |
| `api_conditional_requests_total` | counter | `endpoint`, `outcome` |
| `api_deprecated_version_requests_total` | counter | `version`, `endpoint` |

**`endpoint` is the route template, never the resolved path.** `/v1/articles/{id}` — not `/v1/articles/018f3a2b-...`. A resolved path as a label creates one time series per article and takes down the metrics backend long before any attack does.

**`tenant_bucket` groups tenants by request volume**, never a raw `tenantId`. Per-tenant cardinality multiplies every series by the customer count; per-tenant analysis comes from logs and traces on demand (`16-security/security-observability.md`).

**`api_errors_total` labels by stable `code`, not by message.** Codes are contract and are the aggregation key that survives wording changes (`07-development-guide/error-handling.md`).

**`api_idempotency_hits_total{outcome}`** distinguishes `replayed` (the original response returned — the mechanism working) from `conflict` (`422`, same key with a different body — a client bug). Collapsing them would hide a real client defect inside a healthy-looking counter.

## Referenced, not redefined

These are emitted with API-layer labels but owned elsewhere:

| Metric | Owner | API labels added |
|---|---|---|
| `auth_attempts_total` · `auth_failures_total` | Security | `endpoint` |
| `authz_denials_total` | Security | `endpoint`, `action` |
| `authz_cross_tenant_attempts_total` | Security — **invariant** | `endpoint` |
| `webhook_delivery_attempts_total` · `_failures_total` | Event | `event_type` |
| `signature_verification_failures_total` | Security | `direction` |
| `replay_runs_total` | Event | — |

**Cross-tenant attempts page at count one and that routing belongs to Security.** This document does not restate the threshold; it specifies that the API layer contributes `endpoint`, which is what turns "someone probed" into "someone probed *here*."

**Webhook delivery failures are Event Platform metrics.** The API surface exposes them to customers through delivery records (`event-api.md`); the telemetry is not duplicated.

## Trace identifiers

**Four identifiers accompany every API request.**

```ts
interface ApiTraceContext {
  readonly requestId: string;        // THIS HTTP request — returned to the client
  readonly correlationId: string;    // the client operation, across services and async work
  readonly tenantId: string | null;  // span attribute and log field — NEVER a metric label
  readonly runId: string | null;     // present on run-related endpoints
}
```

| Identifier | Answers |
|---|---|
| `requestId` | "Which call was this?" — quoted in support tickets |
| `correlationId` | "What did this operation cause?" — spans the async boundary |
| `tenantId` | "Who is affected?" |
| `runId` | "Which long-running job?" |

**`requestId` is returned in the `X-Request-Id` header and in every error body**, so it is available whichever the client captured (`api-principles.md`).

**A client-supplied `X-Correlation-Id` is accepted, validated, and propagated** — bounded length, restricted characters, never used in a query or path. It flows into the event envelope, which is how a webhook a customer receives ties back to the API call that caused it (`13-event-platform/event-apis.md`).

**`runId` on run endpoints is what joins a `202` to everything that followed it.** Without it, correlating a pipeline failure back to the request that started it requires reconstructing from timestamps.

**Spans are named by route template.** A span named with a resolved path produces unbounded distinct span names and defeats aggregation exactly as it does for metrics.

## Edge logging

**The API layer emits one structured record per request** (`07-development-guide/logging-guide.md`).

```ts
interface ApiLogRecord {
  readonly event: 'api.request';
  readonly method: string;
  readonly endpoint: string;              // route template
  readonly status: number;
  readonly durationMs: number;
  readonly version: string;
  readonly requestId: string;
  readonly correlationId: string;
  readonly tenantId: string | null;
  readonly actorId: string | null;
  readonly code: string | null;           // stable error code on failure
  readonly userAgent: string;
  readonly ipAddress: string;
}
```

**Never logged at the edge:** request bodies, response bodies, `Authorization` headers, cookies, API keys, presigned URLs, signing secrets, or any field not on the allowlist above. Redaction is allowlist-based, reinforced by `SecretValue` returning `[REDACTED]` on serialization (`16-security/secrets-management.md`).

**One record per request, at the boundary.** Logging at each layer as a request descends produces five records for one call and inflates every rate derived from them.

**`ipAddress` is personal data and is retained under the compliance rules** — stored by reference so redaction does not require rewriting an audit record (`16-security/compliance.md`).

**Errors are logged once, where handled.** A `500` produces one record with the stable code; the full internal detail is logged against `requestId` and never returned (`07-development-guide/error-handling.md`).

## Client-facing observability

**What a customer can see about their own usage, without an operator.**

| Surface | Provides |
|---|---|
| `X-Request-Id` on every response | The support pivot |
| `X-RateLimit-*` on every response | Remaining budget — enables self-pacing |
| `Deprecation` / `Sunset` headers | Migration signal |
| `GET .../events/deliveries` | Webhook delivery and attempt history |
| `GET .../ai/usage` | Credit and operation consumption |
| Per-version usage reporting | Migration completeness (`api-versioning.md`) |

**Rate-limit headers appear on every response, not only on `429`.** A client that can see its remaining budget paces itself; one that discovers the limit by hitting it cannot.

**Customer-facing observability reduces support load more than any dashboard.** A customer who can answer "did that webhook arrive" without opening a ticket is a customer whose integration they can debug themselves.

## SLOs

| SLI | Target |
|---|---|
| **Availability** | 99.9% of requests not `5xx` |
| Read latency | p95 < 200 ms, p99 < 500 ms |
| Write latency | p95 < 400 ms |
| Presign / URL issuance | p95 < 50 ms |
| Async acceptance (`202`) | p95 < 300 ms |
| **Tenant isolation** | **100% — invariant, not an SLO** |
| **Audit completeness** | **100% — invariant** |

**Isolation and audit completeness are listed so their absence from percentile treatment is explicit.** A 99.99% isolation target would concede that one request in ten thousand may cross tenants, which is not the guarantee ADR-017 makes.

**`4xx` responses are excluded from the availability SLI.** A `403` or a `400` is the platform working correctly; counting them would make the SLI track client behaviour rather than platform health.

**`429` is also excluded**, for the same reason — rate limiting functioning is not an outage.

**Async acceptance is measured, not async completion.** How long a pipeline takes is a product characteristic; how long the API takes to accept the request and return a handle is an API characteristic.

## Alerting

**Invariant breaches route to Security's paths and are not restated** (`16-security/security-observability.md`). What follows is API-layer alerting.

| Alert | Condition |
|---|---|
| **Error budget burn** | `5xx` rate consuming the 99.9% budget faster than sustainable |
| Latency regression | p95 above SLO for 10 minutes on any endpoint |
| **Validation failure spike** | `api_validation_failures_total` above baseline on one endpoint — fuzzing or a broken client release |
| Rate-limit spike | Rejections above baseline for one tenant — abuse or a runaway client |
| Idempotency conflicts | `api_idempotency_hits_total{outcome="conflict"}` rising — a client bug producing wrong responses |
| Deprecated version traffic **rising** | New integrations against a dying version |
| Sunset rejections | `410` after sunset — a client was missed by direct notice |
| In-flight saturation | `api_in_flight_requests` approaching the connection bound |

**Idempotency conflicts alert because they are silent client defects.** A client reusing a key with a different body gets `422` and may retry forever; the customer experiences a broken feature while the platform reports healthy.

**A validation-failure spike on one endpoint is usually a client release, occasionally fuzzing.** Both warrant attention, and the `field` label distinguishes them — a spike concentrated on one field is a client bug, a spike spread across many is probing.

## Dashboards

| Dashboard | Contents |
|---|---|
| **API health** | RED metrics by endpoint; error budget burn |
| Per-endpoint | Latency distribution, error codes, request sizes |
| Client health | Rate limits, validation failures, idempotency conflicts by `tenant_bucket` |
| Version adoption | Traffic by version; deprecated-version trend |
| **Async surface** | `202` acceptance latency, run outcomes, SSE connection counts |

**The API health dashboard is the first stop in a customer-reported incident**, and the diagnostic order matters: error rate by endpoint, then by code, then latency, then downstream platform dashboards. Starting downstream sends people to debug a database when the API was rejecting on validation.

## Business rules

1. **Metric names are frozen.**
2. **`endpoint` is a route template**, never a resolved path.
3. **`tenantId` is never a metric label**; `tenant_bucket` where grouping is needed.
4. **Errors are labelled by stable code**, never by message.
5. **Security and Event metrics are referenced, never redefined.**
6. **All four trace identifiers accompany every request.**
7. **Client-supplied `X-Correlation-Id` is validated and propagated.**
8. **Spans are named by route template.**
9. **One log record per request, at the boundary.**
10. **Bodies, headers, credentials, and URLs are never logged.**
11. **Errors are logged once, where handled.**
12. **Rate-limit headers appear on every response.**
13. **`4xx` and `429` are excluded from the availability SLI.**
14. **Isolation and audit completeness are invariants, not SLOs.**
15. **Async acceptance latency is measured, not completion.**
16. **Idempotency conflicts alert as client defects.**

## Cross references

- `16-security/security-observability.md` — **authentication, authorization, invariant breaches, cardinality discipline**
- `13-event-platform/observability.md` — event delivery, consumer lag, the silence-alert pattern
- `12-storage-platform/storage-observability.md` — storage and media signals
- `14-operations/monitoring.md` — metrics infrastructure and retention
- `07-development-guide/logging-guide.md` — the structured log schema
- `07-development-guide/error-handling.md` — stable codes as the aggregation key
- `api-principles.md` — request ids, rate-limit headers, correlation
- `api-versioning.md` — per-version traffic reporting
- `event-api.md` — customer-facing delivery visibility
- `04-platform/rate-limiting.md` — rate limit values
