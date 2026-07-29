# Caching

> **Status:** v1.0 — ownership document. Phase 12 governance completion.
> **No layer caches another layer's data**, because it cannot know when that data becomes invalid. This document owns invalidation strategy; the key rules that make caching safe are owned by Security.

## Purpose

Own cache invalidation strategy, and name the documents that own key construction, placement, and storage.

## Scope

**In scope:** ownership of invalidation strategy — who invalidates what, and on what signal.

**Not in scope:** key construction and tenant scoping, which are security controls owned by `16-security/tenant-isolation.md`. Cache placement by layer, already specified in `01-system-architecture/03-high-level-architecture.md`. CDN caching, owned by the Storage Platform.

## Ownership

| Concern | Owner |
|---|---|
| **Invalidation strategy** | **This document** |
| **Key construction and tenant scoping** | **`16-security/tenant-isolation.md`** |
| Cache placement by layer | `01-system-architecture/03-high-level-architecture.md` |
| The six cache layers | `01-system-architecture/01-executive-summary.md` |
| Redis-resident cache state | `12-storage-platform/redis.md` |
| Semantic AI cache | `08-ai-platform/` |
| External-data cache and freshness policy | `09-integrations/` |
| CDN caching and invalidation | `12-storage-platform/cdn.md` |

**Placement follows layer ownership**, already specified: the Provider Layer caches external data by freshness policy; the AI Platform owns the semantic cache; the Platform and Content layers cache hot entities; the Edge caches static and idempotent responses.

## Responsibilities

**Own invalidation, which is the half of caching that produces correctness bugs.** Key construction is a security control and is owned by Security; deciding *when* a cached value stops being true is a platform concern.

**The governing rule is already stated and is restated here because it is an invalidation rule:** **no layer caches another layer's data**, because it cannot know when that data becomes invalid. A cache populated by one layer and invalidated by another produces stale reads that no owner can diagnose.

**Three invalidation signals are already in use across the platform:**

| Signal | Used by |
|---|---|
| **TTL expiry** | External-data cache, per freshness policy (`09-integrations/`) |
| **Event-driven invalidation** | Entity caches, on domain events through the outbox (ADR-020) |
| **Explicit invalidation** | CDN, on soft delete (`12-storage-platform/cdn.md`) |

**Event-driven invalidation depends on the outbox guarantee.** A cache invalidated by an event is correct only because an event exists if and only if its transaction committed. Invalidating from a fire-and-forget publish would leave caches stale whenever publication failed after commit.

**Tenant-wide invalidation is available and is what erasure depends on.** `invalidateTenant` removes an entire tenant's cache by key prefix — possible only because every key is tenant-prefixed (`16-security/tenant-isolation.md`, `16-security/compliance.md`).

## Existing references

Two references, both from one document:

| Document | Defers |
|---|---|
| `16-security/tenant-isolation.md` §Non-responsibilities | Cache invalidation strategy |
| `16-security/tenant-isolation.md` §Cross references | Cache strategy under these key rules |

**Both defer strategy while retaining the key rules**, which is the correct split: an unscoped key is a cross-tenant leak, and that belongs to Security.

## Related documents

- `16-security/tenant-isolation.md` — **the tenant-prefixed key rule, the scoped cache API, and why an unscoped key is a leak**
- `01-system-architecture/03-high-level-architecture.md` — cache placement by layer
- `01-system-architecture/01-executive-summary.md` — the six cache layers
- `12-storage-platform/redis.md` — where cache state lives
- `12-storage-platform/cdn.md` — edge caching, immutable assets, invalidation at soft delete
- `08-ai-platform/` — the semantic cache, the platform's largest cost lever
- `09-integrations/` — external-data caching by freshness policy
- `13-event-platform/transactional-outbox.md` — why event-driven invalidation is reliable
- `16-security/compliance.md` — tenant-wide invalidation under erasure

## Operational considerations

**A cache sits in front of RLS, which is why key scoping is a security control rather than a performance concern.** A value populated by one tenant and read by another is a cross-tenant disclosure that never touches the database and therefore never touches RLS. `cache_key_unscoped_total` is an invariant metric with a target of zero and pages at count one (`16-security/security-observability.md`).

**Global caches exist and are strictly non-tenant** — provider rate-limit state, model catalogues, feature flags — under a reserved `cos:global:` prefix, with CI rejecting a global-namespace write whose value derives from tenant data.

**Immutable objects need no invalidation.** Storage objects are immutable, so a content change produces a new identifier and a new URL; CDN invalidation is required only for deletion, which is a correctness requirement rather than a freshness one (`12-storage-platform/cdn.md`).

**Cache loss is never a correctness problem.** Every cached value is reconstructable from an authoritative source; a cold cache is a latency event.

## Explicitly out of scope

| Out of scope | Where it belongs |
|---|---|
| Key construction, tenant prefixing, the scoped cache API | `16-security/tenant-isolation.md` |
| Which layer caches what | `01-system-architecture/03-high-level-architecture.md` |
| Semantic cache keying and cost behaviour | `08-ai-platform/` |
| External-data TTLs and freshness policy | `09-integrations/` |
| CDN cache keys, headers, and edge behaviour | `12-storage-platform/cdn.md` |
| Redis configuration, memory policy, eviction | `12-storage-platform/redis.md` |
| Cache metrics and alerting | `06-api/api-observability.md`, `16-security/security-observability.md` |
| **Caching another layer's data** | **Prohibited — no owner** |
