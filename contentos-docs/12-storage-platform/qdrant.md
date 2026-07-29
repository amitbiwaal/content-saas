# Qdrant

> **Status:** v1.0 — ownership document. Phase 12 governance completion.
> **Qdrant is not deployed. It is the accepted migration target for vector search at scale** (ADR-006). This document exists so the four references to it resolve to a statement of that position rather than to nothing.

## Purpose

Record Qdrant's status as a planned migration target, name the trigger that would initiate it, and name the documents that own vector search today.

## Scope

**In scope:** Qdrant's status, the decision that governs it, and the ownership map for vector search in both the current and target states.

**Not in scope:** deployment configuration, collection design, or migration procedure. None exists, because the migration has not been initiated.

## Ownership

| Concern | Owner |
|---|---|
| **The decision to migrate, and its trigger** | **ADR-006** — `01-system-architecture/13-adr-log.md` |
| Vector search behaviour, today and after migration | `11-knowledge-platform/vector-search.md` |
| Vector index definitions | `03-database/indexes.md` |
| Embedding production | `11-knowledge-platform/embedding-pipeline.md` |
| Tenant filtering at query time | `16-security/tenant-isolation.md` |
| Scaling triggers and thresholds | `01-system-architecture/11-deployment-topology.md` |
| **Qdrant deployment configuration** | **Not yet owned — does not exist** |

## Current status

**pgvector, inside the primary PostgreSQL instance, is the deployed vector store.** ADR-006 — *"pgvector first, Qdrant at scale"* — is **Accepted**, and its decision is: use pgvector at v1, migrate to Qdrant when documented thresholds are met.

**Qdrant appears in the deployment topology at the S3 tier** as a separate data-zone service (`01-system-architecture/11-deployment-topology.md`). It is not part of S1 or S2.

**No Qdrant instance exists, no collection is defined, and no migration has been scheduled.** This document records that state rather than pre-specifying a system that has not been built.

> **A correction is recorded here for accuracy.** During Phase 10 and Phase 12 review, references to this document were twice described as "stale, since Phase 1 selected pgvector." That was wrong: ADR-006 accepts pgvector *now* and Qdrant *at scale*. The references are forward references to planned work, not contradictions. This is recorded as G-8 in `ARCHITECTURE-GOVERNANCE-REVIEW.md`.

## Responsibilities

This document is responsible for one statement: **vector search behaviour does not change on migration.**

`11-knowledge-platform/vector-search.md` owns the behaviour, and the constraints it specifies bind both stores:

- **Tenant filtering happens at query time, never as a post-filter on results** (`16-security/tenant-isolation.md`). Post-filtering leaks existence through result counts.
- **No embedding, raw distance, or index parameter is exposed externally** (`06-api/knowledge-api.md`). Relevance is normalized to an integer 0–100, which is what makes the store swappable without a breaking API change.
- Embeddings are **derived data** — rebuildable, excluded from backup (`11-knowledge-platform/provenance.md`).

**That last property is what makes migration tractable.** Embeddings do not need to be migrated; they are regenerated into the new store from authoritative sources.

## Existing references

Four references:

| Document | Refers as |
|---|---|
| `01-system-architecture/13-adr-log.md` | ADR-006 Affects |
| `11-knowledge-platform/vector-search.md` | "the migration target" |
| `03-database/indexes.md` | "the vector migration target" |
| `12-storage-platform/README.md` | Folder scope note |

**All four refer to it as a target, none as a current dependency.** No document assumes Qdrant is deployed.

## Related documents

- `01-system-architecture/13-adr-log.md` — **ADR-006, the governing decision**
- `11-knowledge-platform/vector-search.md` — vector search behaviour, store-independent
- `11-knowledge-platform/embedding-pipeline.md` — embedding production and re-indexing
- `11-knowledge-platform/provenance.md` — embeddings as derived data
- `16-security/tenant-isolation.md` — query-time tenant filtering, which any store must support
- `06-api/knowledge-api.md` — why no vector implementation detail is exposed
- `03-database/indexes.md` — pgvector index definitions today
- `12-storage-platform/postgresql.md` — where pgvector runs today
- `01-system-architecture/11-deployment-topology.md` — Qdrant at the S3 tier

## Operational considerations

**Migration is triggered by documented thresholds, not by preference.** The scaling triggers are specified in `01-system-architecture/11-deployment-topology.md`; ADR-006 defers to them.

**pgvector shares the primary's resources today.** Vector index memory and query load compete with transactional work, which is the pressure the migration is intended to relieve.

**Query-time tenant filtering is a requirement any replacement must satisfy**, not a pgvector implementation detail. A store that could only post-filter would be disqualified regardless of its performance.

**When migration is initiated, this document is replaced by a deployment specification.** Until then it is an ownership record.

## Explicitly out of scope

| Out of scope | Where it belongs |
|---|---|
| Vector search behaviour and ranking | `11-knowledge-platform/vector-search.md` |
| Embedding model, dimensions, chunking | `11-knowledge-platform/embedding-pipeline.md` |
| Current index configuration | `03-database/indexes.md` |
| The migration decision and its trigger | ADR-006 |
| Scaling thresholds | `01-system-architecture/11-deployment-topology.md` |
| Tenant isolation in vector search | `16-security/tenant-isolation.md` |
| **Qdrant collection design, sharding, deployment** | **Does not exist; specified when migration is initiated** |
| **Migration procedure** | **Not written — no migration has been scheduled** |
