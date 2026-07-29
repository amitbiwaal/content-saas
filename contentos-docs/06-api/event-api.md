# Event API

> **Status:** v1.0 — complete. Phase 12. **Contracts only.**
> **No broker detail is ever exposed.** No stream name, no consumer group, no entry id, no partition. The transport is Redis Streams today and swappable by design (ADR-020); a contract that leaked it would make that swap a breaking change.

## Overview

**Purpose.** Define the customer-facing view of platform events: the event catalogue, subscriptions, delivery records, replay visibility, and progress notification.

**The boundary with `webhooks.md`.** A **subscription** declares *which* events a customer wants. A **webhook endpoint** is *where* they are delivered. One endpoint serves many subscriptions, and the two are separate resources because they change independently — rotating an endpoint's secret should not disturb what it is subscribed to.

**The `Run` resource is canonical in `research-api.md`** and is not redefined here. This document covers the event side of asynchronous work.

## What is never exposed

| Never returned | Why |
|---|---|
| Stream names, consumer groups, entry ids | Transport-specific; swappable (ADR-020) |
| Redis, Kafka, or any broker identity | Same |
| Outbox rows, `publish_attempts`, relay state | Internal durability mechanics |
| Partition or ordering internals | Per-aggregate ordering is a guarantee, not a mechanism |
| **Dead-letter queue contents** | Operator surface — `admin-api.md` |
| Another tenant's events, or their existence | Tenant isolation |

**`entryId` is opaque even internally and is never persisted by a consumer** (`13-event-platform/event-bus.md`). Exposing it externally would let a customer store a value that becomes meaningless at cutover.

## Common contract

| Property | Value |
|---|---|
| Base path | `/v1/workspaces/{workspaceId}/events` |
| Authorization | Workspace-tier `integration:*` for subscriptions; `run:read` for delivery |
| Rate-limit class | `read` or `write` |
| Audit | Subscription changes recorded; reads not |

## Event catalogue

| Field | Value |
|---|---|
| **Purpose** | Discover subscribable event types and their payload shapes |
| **Method · Path** | `GET /v1/events/types` |
| **Authorization** | Authenticated |
| **Idempotency** | Read-only |
| **Rate limit** | `read` |
| **Events** | None |
| **Audit** | Not recorded |

```ts
interface EventTypeDescriptor {
  readonly eventType: string;                 // 'ArticlePublished'
  readonly versions: readonly {
    readonly version: number;
    readonly status: 'active' | 'deprecated';
    readonly schema: object;                  // JSON Schema
  }[];
  readonly aggregateType: string;
  readonly description: string;
  readonly deliveryGuarantee: 'at-least-once';
  readonly orderingGuarantee: 'per-aggregate' | 'none';
}
```

**The catalogue is generated from the event registry**, not hand-maintained. A hand-written catalogue drifts from what the platform actually publishes, and the drift surfaces as a customer integration breaking on a payload that never matched the docs (`13-event-platform/event-registry.md`).

**`deliveryGuarantee` is always `at-least-once` and is stated on every type.** Customers must build idempotent handlers; a contract implying exactly-once would produce integrations that break on the first redelivery. Exactly-once delivery is not achievable across a process boundary and the platform does not claim it (`13-event-platform/idempotency.md`).

**`orderingGuarantee` is per-aggregate or none — never global.** Two events about the same article arrive in order; two events about different articles have no relative ordering, and events of *different types* about the same article are not ordered relative to each other (`13-event-platform/ordering.md`).

## Subscriptions

| Field | Value |
|---|---|
| **Purpose** | Declare which events should be delivered to an endpoint |
| **Method · Path** | `POST .../events/subscriptions` · `GET` · `PATCH .../{id}` · `DELETE .../{id}` |
| **Authorization** | **`integration:manage`** |
| **Idempotency** | Create requires `Idempotency-Key`; `PATCH`/`DELETE` idempotent |
| **Rate limit** | `write` |
| **Events** | `EventSubscriptionCreated` · `Updated` · `Deleted` |
| **Audit** | **Actor, endpoint, event types recorded** |

```ts
interface Subscription {
  readonly id: string;
  readonly endpointId: string;                // webhooks.md
  readonly eventTypes: readonly string[];     // explicit — NO wildcards
  readonly version: number;                   // exactly one, per type family
  readonly filter: SubscriptionFilter | null;
  readonly status: 'active' | 'paused' | 'disabled';
  readonly createdAt: string;
}

interface SubscriptionFilter {
  readonly projectIds?: readonly string[];
  readonly articleTypes?: readonly string[];
}
```

| Error | Code | Status |
|---|---|---|
| Unknown event type | `EVENT_UNKNOWN_TYPE` | 400 |
| Retired version | `EVENT_VERSION_RETIRED` | 400 |
| Wildcard in `eventTypes` | `VALIDATION_FIELD_INVALID` | 400 |
| Endpoint not verified | `WEBHOOK_ENDPOINT_UNVERIFIED` | 409 |
| Subscription limit reached | `DOMAIN_QUOTA_EXCEEDED` | 402 |

**Wildcards are rejected, mirroring the permission model.** `Article*` would silently expand when a new article event ships — the customer starts receiving events they never agreed to handle, and their handler's `default` branch decides what happens. Explicit lists mean new event types reach nobody until someone subscribes (`16-security/rbac.md` applies the same reasoning to permissions).

**A subscription declares exactly one version per type.** The platform transforms delivered payloads to that version, so a customer on v1 keeps receiving v1 shapes after the platform moves to v3 (`13-event-platform/versioning.md`).

**Subscriptions require a verified endpoint.** Delivering to an unverified URL would let anyone register a subscription pointing at a third party and use the platform as an unwitting sender.

**`filter` narrows delivery server-side.** Without it, a customer interested in one project receives every project's events and discards most — paying delivery cost and expanding their exposure to data they did not need.

## Delivery records

| Field | Value |
|---|---|
| **Purpose** | Inspect what was delivered and what failed |
| **Method · Path** | `GET .../events/deliveries` · `GET .../deliveries/{id}` |
| **Authorization** | `integration:read` |
| **Idempotency** | Read-only |
| **Rate limit** | `read` |
| **Events** | None |
| **Audit** | Not recorded |

```ts
interface Delivery {
  readonly id: string;
  readonly subscriptionId: string;
  readonly eventId: string;
  readonly eventType: string;
  readonly eventVersion: number;
  readonly status: 'pending' | 'delivered' | 'failed' | 'exhausted';
  readonly attempts: readonly {
    readonly attemptNumber: number;
    readonly at: string;
    readonly responseStatus: number | null;
    readonly outcome: 'success' | 'http_error' | 'timeout' | 'connection_error';
    readonly nextRetryAt: string | null;
  }[];
  readonly occurredAt: string;
  readonly correlationId: string;
}
```

**Attempt history is retained and returned in full.** A customer debugging a missed event needs to know whether it was never sent, sent and rejected, or sent and timed out — three different problems with three different fixes on their side.

**`responseStatus` is *their* server's response**, recorded verbatim. It is the one place a raw status from outside the platform is surfaced, because it is the customer's own system and is the primary diagnostic.

**`exhausted` means retries are finished and the event will not be redelivered automatically.** It is distinguished from `failed` — which is a transient state between attempts — so a customer can alert on exhaustion without alerting on every retry.

**Filterable:** `subscriptionId`, `eventType`, `status`, `occurredAfter`, `occurredBefore`, `correlationId`.

**`correlationId` filtering is the highest-value query here.** From an API call a customer made, they can find every event it caused and every delivery attempt — the same pivot the platform uses internally (`13-event-platform/observability.md`).

## Manual redelivery

| Field | Value |
|---|---|
| **Purpose** | Re-send an exhausted or failed delivery |
| **Method · Path** | `POST .../deliveries/{deliveryId}/actions/redeliver` |
| **Authorization** | **`integration:manage`** |
| **Idempotency** | **`Idempotency-Key` required** |
| **Rate limit** | `write`, bounded per subscription |
| **Events** | `WebhookRedeliveryRequested` |
| **Audit** | Actor and delivery id recorded |

```ts
// 202
{ delivery: Delivery }        // status: 'pending'
```

| Error | Code | Status |
|---|---|---|
| Delivery already succeeded | `DELIVERY_ALREADY_SUCCEEDED` | 409 |
| Retention window elapsed | `DELIVERY_EXPIRED` | 410 |
| Subscription disabled | `SUBSCRIPTION_DISABLED` | 409 |

**Redelivery sends the original payload byte-identical**, so the signature verifies and any idempotency key the customer derived from content still matches.

**A succeeded delivery cannot be redelivered.** The customer's handler is idempotent by contract, but re-sending something already confirmed would create duplicate work with no ambiguity to resolve — if they need it again, the event is still queryable.

**Delivery records are retained 30 days.** Beyond that, redelivery returns `410` — the record is gone, not merely unavailable.

## Replay visibility

| Field | Value |
|---|---|
| **Purpose** | See whether a platform-initiated replay affected this workspace |
| **Method · Path** | `GET .../events/replays` |
| **Authorization** | `integration:read` |
| **Idempotency** | Read-only |
| **Rate limit** | `read` |
| **Events** | None |
| **Audit** | Not recorded |

```ts
interface ReplayNotice {
  readonly id: string;
  readonly reason: 'incident-recovery' | 'projection-rebuild' | 'consumer-backfill';
  readonly affectedEventTypes: readonly string[];
  readonly window: { from: string; to: string };
  readonly deliveredToSubscriptions: boolean;      // usually FALSE
  readonly startedAt: string;
  readonly completedAt: string | null;
}
```

**Replay is an operator action, never a customer one.** Customers cannot trigger it; this endpoint exists so they can understand a burst of redeliveries rather than experiencing it as an anomaly (ADR-028, `13-event-platform/replay.md`).

**`deliveredToSubscriptions` is normally `false`.** A projection rebuild replays to internal consumers only — every replay names its target groups explicitly, and there is no broadcast default. When it is `true`, customers received duplicates their idempotent handlers should have suppressed.

**Replay scope is disclosed but replay *contents* are not.** The customer learns which event types and which window; the individual replayed events appear in their delivery records only if their subscriptions were targeted.

## Progress notification

**Two mechanisms, and the choice depends on the client, not the operation.**

| Mechanism | Use | Path |
|---|---|---|
| **SSE** | Interactive clients watching one run | `GET /v1/runs/{runId}/events` |
| **Webhooks** | Backend integrations, durable delivery | Subscriptions above |

**SSE is per-run and ephemeral; webhooks are per-subscription and durable.** A browser watching a pipeline uses SSE and reconnects with `Last-Event-ID`; a customer's backend uses webhooks and gets retries.

**SSE progress events are not domain events and are not subscribable.** Per-percent progress across every run would flood the bus with data no consumer acts on, so progress lives on the run resource and its stream (`research-api.md`).

**A run's terminal outcome *is* a domain event** and is subscribable — `ArticlePublished`, `ResearchCompleted`. The distinction is that progress is transient state and completion is a fact.

## Business rules

1. **No broker, stream, consumer group, or entry id is ever exposed.**
2. **The catalogue is generated from the registry.**
3. **`at-least-once` is stated on every type**; exactly-once is never claimed.
4. **Ordering is per-aggregate or none — never global.**
5. **Wildcards in `eventTypes` are rejected.**
6. **A subscription declares exactly one version per type.**
7. **Payloads are transformed to the subscribed version.**
8. **Subscriptions require a verified endpoint.**
9. **Attempt history is retained in full and returned.**
10. **`exhausted` is distinct from `failed`.**
11. **Redelivery sends the original payload byte-identical.**
12. **A succeeded delivery cannot be redelivered.**
13. **Delivery records are retained 30 days**, then `410`.
14. **Replay is operator-only; customers get visibility, not control.**
15. **Progress is not a domain event; completion is.**
16. **DLQ contents are never exposed here** — that is `admin-api.md`.

## Events emitted

| Event | Trigger |
|---|---|
| `EventSubscriptionCreated` · `Updated` · `Deleted` | Subscription lifecycle |
| `WebhookRedeliveryRequested` | Manual redelivery |

**Subscription changes are themselves events**, which lets a customer's own audit tooling observe changes to their integration configuration.

## Audit implications

| Action | Recorded |
|---|---|
| Subscription create, update, delete | **Actor, endpoint, event types, filter** |
| Manual redelivery | Actor, delivery id |
| Catalogue, delivery, replay reads | **Not recorded** |

**Subscription changes are audited because they alter where tenant data flows.** Adding an event type to a subscription is a data-egress change, and the audit trail is what answers "when did this endpoint start receiving publish events" (`16-security/audit.md`).

## Cross references

- `webhooks.md` — **endpoint registration, signing, retry, secret rotation**
- `research-api.md` — the canonical `Run` and SSE progress
- `13-event-platform/event-registry.md` — the registry the catalogue is generated from
- `13-event-platform/event-apis.md` — the envelope and its correlation fields
- `13-event-platform/versioning.md` — version transformation for subscribers
- `13-event-platform/ordering.md` — per-aggregate ordering
- `13-event-platform/idempotency.md` — why at-least-once is stated
- `13-event-platform/replay.md` — ADR-028; operator-only replay
- `13-event-platform/dead-letter-queue.md` — ADR-027; operator surface
- `admin-api.md` — DLQ inspection and replay administration
- `api-principles.md` — cursor pagination, idempotency, actions
- `16-security/audit.md` — subscription change records
