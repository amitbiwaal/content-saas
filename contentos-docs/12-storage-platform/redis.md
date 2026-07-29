# Redis

> **Status:** v1.0 — ownership document. Phase 12 governance completion.
> **Redis is transport and coordination state, never truth.** Everything it holds is either reconstructable, short-lived, or backed by PostgreSQL. This document names what lives here and who owns each part.

## Purpose

Consolidate the ownership of Redis-resident state. Fourteen documents place state in Redis and defer its configuration here; this document names each use, its owner, and the constraints that already govern it.

## Scope

**In scope:** the inventory of Redis-resident state, its owners, and the platform-wide constraints already stated elsewhere that apply to all of it.

**Not in scope:** cache strategy, eviction policy, instance sizing, or any new behaviour. Each use is specified by its owning document.

## Ownership

**No single component owns Redis.** Seven owners place state in it, and each owns the semantics of its own keys.

| State | Owner |
|---|---|
| **Cache — six layers** | `01-system-architecture/03-high-level-architecture.md` §Cache placement; layer owners below |
| Sessions | `04-platform/authentication.md` |
| Rate limiter state | `08-ai-platform/rate-limiting.md`, `04-platform/rate-limiting.md` |
| **Stream data, consumer group state, pending-entry lists** | `13-event-platform/event-bus.md`, `consumer-groups.md` |
| Worker heartbeats, scheduled-job locks, lease state | `13-event-platform/workers.md` |
| Retry attempt counters, budget windows | `13-event-platform/retry-engine.md` |
| Aggregate barriers, ordering markers | `13-event-platform/ordering.md` |
| Tenant-scoped cache API | `16-security/tenant-isolation.md` |

**Cache placement follows layer ownership**, as already specified: the Provider Layer caches external data by freshness policy; the AI Platform owns the semantic cache; the Platform and Content layers cache hot entities; the Edge caches static and idempotent responses. **No layer caches another layer's data**, because it cannot know when that data becomes invalid.

**The six cache layers are enumerated in `01-system-architecture/01-executive-summary.md` §158** — CDN, HTTP response, application entity cache, external-data cache, semantic AI cache, vector query cache — and are not restated here.

## Responsibilities

This document is responsible for three statements that apply across every use:

**Redis holds no source of truth.** Stream data is recoverable by republishing from the outbox (ADR-020). Cache entries are reconstructable. Locks, leases, and heartbeats are ephemeral by design. A total Redis loss degrades latency and coordination; it does not lose durable state.

**Every key carrying tenant data is tenant-prefixed** — `cos:{tenantId}:{namespace}:{key}` — with a reserved `cos:global:` namespace for genuinely non-tenant data. This is specified and enforced by `16-security/tenant-isolation.md`; it is named here because it applies to every use above.

**Redis holds no data requiring encryption at rest**, by policy. It caches identifiers, counters, locks, and short-lived state. Anything requiring encryption does not belong here (`16-security/encryption.md`).

## Existing references

Fourteen references across five folders:

| Group | Documents |
|---|---|
| **Event Platform** (5) | `event-bus.md`, `consumer-groups.md`, `workers.md`, `README.md`, and the retry and ordering documents by implication |
| **Architecture** (3) | `01-executive-summary.md` ×2, `03-high-level-architecture.md` |
| **Platform** (2) | `04-platform/authentication.md` ×2 |
| **AI Platform** (1) | `08-ai-platform/rate-limiting.md` |
| **Storage** (1) | `12-storage-platform/README.md` |

**The Event Platform group is the load-bearing one.** Consumer group state, pending-entry lists, worker leases, and heartbeats are what make delivery work, and all four are Redis-resident with no PostgreSQL backing.

## Related documents

- `16-security/tenant-isolation.md` — **the tenant-prefixed key rule and the scoped cache API**
- `16-security/encryption.md` — TLS in transit; why no encryption at rest is required
- `13-event-platform/event-bus.md` — Redis Streams as transport; the swap point (ADR-020)
- `13-event-platform/consumer-groups.md` — group state and pending entries
- `13-event-platform/workers.md` — heartbeats, locks, lease renewal
- `13-event-platform/retry-engine.md` — attempt counters and budget windows
- `13-event-platform/ordering.md` — aggregate barriers
- `04-platform/authentication.md` — session storage
- `01-system-architecture/03-high-level-architecture.md` — cache placement by layer
- `07-development-guide/local-development.md` — Redis 7 locally, matching production

## Operational considerations

**Redis loss is recoverable but not free.** Streams republish from the outbox; caches refill; leases expire and are reclaimed. What is lost is in-flight coordination — pending-entry attribution and held leases — which resolves through the idle-claim path already specified in `consumer-groups.md`.

**Consumer group state has no PostgreSQL backing.** This is the one Redis-resident state whose loss is operationally visible: consumer groups must be recreated and positions re-established. The recovery path is `13-event-platform/replay.md`.

**Version parity with production is required locally**, because consumer groups, pending entries, and idle claims are the behaviours most likely to differ across versions (`07-development-guide/local-development.md`).

**Memory pressure manifests as stream trimming**, which is lag-aware and specified in `event-bus.md`. Trimming is why replay reads from PostgreSQL rather than the bus (ADR-028).

## Explicitly out of scope

| Out of scope | Where it belongs |
|---|---|
| Cache strategy, TTLs, invalidation | The owning layer's document |
| Semantic cache keying | `08-ai-platform/` |
| Stream topology, trimming policy | `13-event-platform/event-bus.md` |
| Consumer group mechanics | `13-event-platform/consumer-groups.md` |
| Rate limit values | `04-platform/rate-limiting.md` |
| Session lifetime and revocation | `16-security/authentication.md` |
| Key naming and tenant scoping rules | `16-security/tenant-isolation.md` |
| Instance sizing, clustering, failover topology | `14-operations/scaling-strategy.md` |
| **Any durable state** | **PostgreSQL — `03-database/`** |
