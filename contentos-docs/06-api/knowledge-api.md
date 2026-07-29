# Knowledge API

> **Status:** v1.0 — complete. Phase 12. **Contracts only.**
> **Evidence-centric, never storage-centric.** No embedding, no vector distance, no index parameter appears in any response. What the API returns is what a claim can be grounded in — and where it came from.

## Overview

**Purpose.** Define endpoints for evidence search and retrieval, entity lookup, citation resolution, provenance, and freshness.

**The Knowledge Platform is always the source of truth** (ADR-026). AI Memory is never. Nothing in this API returns AI Memory content, and no response mixes the two.

**Retrieval prepares evidence only.** Assembling a `ContextManifest` for a model is the Context Builder's job in the AI Platform, and no endpoint here returns one. That boundary is mandatory (`11-knowledge-platform/retrieval-pipeline.md`).

## What is never exposed

| Never returned | Why |
|---|---|
| Embedding vectors | Implementation detail; reconstructible into content |
| **Raw vector distances** | Meaningless across index or metric changes |
| Index type, dimension, parameters | Changing them would become a breaking API change |
| Chunking strategy or chunk boundaries | Internal to the embedding pipeline |
| **Anything from AI Memory** | Never a source of truth (ADR-026) |
| Another tenant's evidence, or its existence | Query-time tenant filtering |

**Raw distances are withheld because they are not portable.** A cosine distance of 0.23 means something different under a different metric, a different model, or a re-indexed corpus. A client that filtered on it would silently change behaviour on every re-embedding. Relevance is normalized to an integer 0–100, matching the platform's scoring convention (ADR-021).

**Vector search is tenant-filtered at query time, never post-filtered.** Post-filtering leaks existence through result counts — requesting ten and receiving three tells the caller that seven similar documents exist in other tenants (`16-security/tenant-isolation.md`).

## Common contract

| Property | Value |
|---|---|
| Base path | `/v1/workspaces/{workspaceId}/knowledge` and `/v1/evidence/{id}` |
| Authorization | `knowledge:read`, `knowledge:update` |
| Rate-limit class | `read`; semantic search is `expensive` |
| Audit | Reads not recorded; curation recorded |

## Evidence resource

```ts
interface Evidence {
  readonly id: string;
  readonly kind: 'web_page' | 'document' | 'dataset' | 'transcript' | 'manual_entry';
  readonly title: string;
  readonly excerpt: string;                     // bounded — never the full source
  readonly sourceUrl: string | null;
  readonly publisher: string | null;
  readonly publishedAt: string | null;
  readonly collectedAt: string;
  readonly freshness: Freshness;
  readonly reliability: number | null;          // INTEGER 0–100
  readonly claims: readonly Claim[];
  readonly isAuthoritative: true;               // always — see below
}

interface Freshness {
  readonly ageDays: number;
  readonly status: 'current' | 'aging' | 'stale' | 'unknown';
  readonly assessedAt: string;
  readonly isEstimate: boolean;
}
```

**`excerpt` is bounded and is never the full source document.** Returning a competitor's page in full through an API is a copyright exposure; returning enough to verify a claim is the actual requirement.

**`isAuthoritative` is a literal `true` on this type, and that is deliberate.** Evidence is authoritative by definition (`11-knowledge-platform/provenance.md`). Derived artifacts — extracted entities, mentions, embeddings — are a different type and are marked accordingly. The two categories are never blurred, and a boolean that could be `false` would invite exactly that.

**`freshness.isEstimate` distinguishes a known publication date from an inferred one.** A freshness estimate presented as fact would let a client treat a guess as a guarantee.

**`reliability` is nullable** because not every source has been assessed. `null` means unknown, not zero — a zero would read as "assessed and found unreliable."

## Evidence search

| Field | Value |
|---|---|
| **Purpose** | Find evidence by text, semantics, or filters |
| **Method · Path** | `GET /v1/workspaces/{workspaceId}/knowledge/evidence` |
| **Authorization** | `knowledge:read` |
| **Idempotency** | Read-only |
| **Rate limit** | `read`, or **`expensive`** when `mode=semantic` |
| **Events** | None |
| **Audit** | Not recorded |

```http
GET .../evidence?q=espresso+extraction+temperature&mode=semantic&limit=20
```

| Parameter | Values |
|---|---|
| `q` | Query text |
| `mode` | `keyword` \| `semantic` \| `hybrid` (default) |
| `freshness` | `current` \| `aging` \| `stale` |
| `kind` | Evidence kind |
| `publishedAfter` / `publishedBefore` | ISO 8601 |
| `minReliability` | 0–100 |
| `entityId` | Evidence mentioning an entity |

```ts
// 200
{
  data: readonly {
    evidence: Evidence;
    relevance: number;                // INTEGER 0–100
    matchedOn: readonly ('title' | 'excerpt' | 'claim' | 'semantic')[];
  }[];
  pagination: { nextCursor: string | null; hasMore: boolean };
}
```

**`mode` names the retrieval strategy without exposing its implementation.** `semantic` may be vector search today and something else later; the contract is the behaviour, not the mechanism.

**`matchedOn` explains why a result appeared.** A semantic match that a user cannot see the reason for reads as arbitrary, and this is the minimum explanation that makes ranking legible.

**Semantic mode is rate-limited as `expensive`** because it runs an ANN scan and, for some queries, an embedding call.

**Results are always tenant-scoped by construction.** There is no cross-tenant search parameter, for operators or anyone else, through this API.

## Retrieve evidence

| Field | Value |
|---|---|
| **Purpose** | Retrieve one evidence item |
| **Method · Path** | `GET /v1/evidence/{evidenceId}` |
| **Authorization** | `knowledge:read` |
| **Idempotency** | Read-only |
| **Rate limit** | `read` |
| **Events** | None |
| **Audit** | Not recorded |

| Error | Code | Status |
|---|---|---|
| In another tenant | `SECURITY_AUTHORIZATION_DENIED` | **404** |
| Unknown | `NOT_FOUND` | 404 |

**Expandable:** `provenance`, `entities`, `citingRevisions`.

**`citingRevisions` answers "what is using this?"** — the question an editor asks before requesting removal of a source, and the reason evidence deletion is refused while citations reference it (`RESTRICT` in `03-database/tables.md`).

## Provenance

| Field | Value |
|---|---|
| **Purpose** | Retrieve the full provenance chain |
| **Method · Path** | `GET /v1/evidence/{evidenceId}/provenance` |
| **Authorization** | `knowledge:read` |
| **Idempotency** | Read-only |
| **Rate limit** | `read` |
| **Events** | None |
| **Audit** | Not recorded |

```ts
interface Provenance {
  readonly evidenceId: string;
  readonly origin: {
    readonly method: 'crawl' | 'api' | 'upload' | 'manual';
    readonly sourceUrl: string | null;
    readonly collectedAt: string;
    readonly collectedBy: string;             // run id or actor id
  };
  readonly lineage: readonly {
    readonly at: string;
    readonly action: 'created' | 'merged' | 'superseded' | 'curated' | 'reverified';
    readonly actor: string;
    readonly note: string | null;
    readonly previousEvidenceIds: readonly string[];
  }[];
  readonly verifiedAt: string | null;
}
```

**Provenance is authoritative and append-only.** A merge preserves the lineage of both inputs; nothing is overwritten and no evidence identifier is lost (`11-knowledge-platform/deduplication.md`).

**`previousEvidenceIds` survives merges**, which is what makes a citation written against a pre-merge identifier still resolvable. Losing it would silently break historical grounding.

**Provenance integrity is an invariant, not an SLO.** A break is a security-class incident rather than a data-quality finding (`11-knowledge-platform/observability.md`).

## Entities

| Field | Value |
|---|---|
| **Purpose** | Look up entities and the evidence mentioning them |
| **Method · Path** | `GET .../knowledge/entities` · `GET /v1/entities/{id}` · `GET /v1/entities/{id}/evidence` |
| **Authorization** | `knowledge:read` |
| **Idempotency** | Read-only |
| **Rate limit** | `read` |
| **Events** | None |
| **Audit** | Not recorded |

```ts
interface Entity {
  readonly id: string;
  readonly canonicalName: string;
  readonly type: string;
  readonly aliases: readonly {
    readonly value: string;
    readonly verified: boolean;               // authoritative vs derived
  }[];
  readonly mentionCount: number;              // DERIVED
  readonly curatedMetadata: object | null;    // AUTHORITATIVE
  readonly mergeCandidates: readonly {
    readonly entityId: string;
    readonly similarity: number;              // 0–100
  }[];
}
```

**`aliases[].verified` marks the authoritative/derived boundary inside one field.** A verified alias was confirmed by a human; an unverified one was extracted. Presenting them identically would let derived data be mistaken for curated fact — the blur the Knowledge Platform explicitly forbids.

**`mergeCandidates` are candidates, never merges.** Similarity creates a review candidate; **authoritative entities are never merged automatically** (`11-knowledge-platform/deduplication.md`). Exposing candidates lets a customer curate; performing the merge silently would destroy a distinction they may rely on.

**`mentionCount` is derived and rebuildable**, so it may lag a re-index. It is not a number to reconcile against.

## Entity curation

| Field | Value |
|---|---|
| **Purpose** | Confirm an alias, edit curated metadata, or approve a merge |
| **Method · Path** | `PATCH /v1/entities/{id}` · `POST /v1/entities/{id}/actions/merge` |
| **Authorization** | **`knowledge:update`** |
| **Idempotency** | `PATCH` idempotent; merge requires `Idempotency-Key` |
| **Rate limit** | `write` |
| **Events** | `EntityCurated`, `EntityMerged` |
| **Audit** | **Actor, before/after, and lineage recorded** |

```ts
// merge request
{ sourceEntityId: string; note: string; }     // note REQUIRED
```

| Error | Code | Status |
|---|---|---|
| Merging into itself | `VALIDATION_FIELD_INVALID` | 400 |
| Source has curated metadata that would be lost | `KNOWLEDGE_MERGE_CONFLICT` | 409 |
| Missing note | `VALIDATION_FIELD_INVALID` | 400 |

**A merge requires an explicit note and is fully audited.** It is a human decision that changes authoritative data, and reconstructing why it happened six months later requires the reason to have been captured at the time.

**A merge that would discard curated metadata is refused rather than resolved.** The platform does not choose which human curation to keep; the conflict is surfaced.

**Every merge preserves lineage and evidence identifiers.** No provenance is lost (`11-knowledge-platform/governance.md`).

## Citation resolution

| Field | Value |
|---|---|
| **Purpose** | Resolve a citation anchor to its evidence |
| **Method · Path** | `GET /v1/citations/{citationId}` |
| **Authorization** | `article:read` **and** `knowledge:read` |
| **Idempotency** | Read-only |
| **Rate limit** | `read` |
| **Events** | None |
| **Audit** | Not recorded |

```ts
interface Citation {
  readonly id: string;
  readonly revisionId: string;
  readonly claimText: string;
  readonly offsets: { start: number; end: number };
  readonly supported: boolean;
  readonly evidence: Evidence | null;
}
```

**Requires both permissions.** A citation joins an article claim to knowledge evidence, and a subject able to read one but not the other must not traverse the link.

**`supported: false` with `evidence: null` is a valid, visible state.** An unsupported claim is surfaced rather than hidden — the grounding invariant depends on it being observable (`content-api.md`).

## Freshness

| Field | Value |
|---|---|
| **Purpose** | Identify evidence needing re-verification |
| **Method · Path** | `GET .../knowledge/freshness` |
| **Authorization** | `knowledge:read` |
| **Idempotency** | Read-only |
| **Rate limit** | `read` |
| **Events** | None |
| **Audit** | Not recorded |

```ts
// 200
{
  summary: { current: number; aging: number; stale: number; unknown: number };
  staleEvidence: readonly { evidenceId: string; ageDays: number; citingRevisionCount: number }[];
}
```

**`citingRevisionCount` prioritizes the work.** Stale evidence cited by forty published articles matters more than stale evidence cited by none, and a flat list of stale items cannot express that.

**Freshness is an assessment, not a fact.** `unknown` is a real category — a source with no discoverable publication date — and forcing it into `stale` would misrepresent an absence of information as a finding.

## Business rules

1. **No embedding, distance, or index detail is ever returned.**
2. **Relevance is an integer 0–100**, never a raw distance.
3. **Vector search is tenant-filtered at query time.**
4. **No `ContextManifest` endpoint exists** — that boundary belongs to the AI Platform.
5. **Nothing from AI Memory is returned** (ADR-026).
6. **Evidence is authoritative; derived artifacts are marked as derived.**
7. **`aliases[].verified` distinguishes curated from extracted.**
8. **Merge candidates are surfaced; merges are never automatic.**
9. **Merges require a note and preserve lineage and evidence ids.**
10. **A merge discarding curated metadata is refused.**
11. **`excerpt` is bounded; full source content is never returned.**
12. **`freshness.isEstimate` marks inferred dates.**
13. **`reliability: null` means unassessed, not unreliable.**
14. **Citation resolution requires both article and knowledge read.**
15. **Unsupported citations are visible.**
16. **Cross-tenant search is not expressible in the contract.**

## Events emitted

| Event | Trigger |
|---|---|
| `EntityCurated` | Alias confirmed or metadata edited |
| `EntityMerged` | Human-approved merge |
| `EvidenceSuperseded` | Evidence replaced during curation |

**Payloads carry identifiers only — never evidence text, excerpts, or entity metadata** (`13-event-platform/event-registry.md`).

**Reads emit nothing.** Search and retrieval are the highest-volume operations in the platform; emitting events for them would flood the bus with data no consumer acts on.

## Audit implications

| Action | Recorded |
|---|---|
| Search, retrieval, provenance read | **Not recorded** |
| Entity curation | Actor, before/after, note |
| **Merge** | **Actor, both entities, note, preserved lineage** |
| Evidence supersession | Actor, reason, previous ids |

**Reads are not audited, deliberately.** Auditing every evidence search would produce volume that buries the curation records that matter, and knowledge reads are not privileged operations (`16-security/audit.md`).

**Merges are audited most heavily** because they are irreversible changes to authoritative data made by humans.

## Cross references

- `11-knowledge-platform/retrieval-pipeline.md` — **retrieval prepares evidence only**
- `11-knowledge-platform/provenance.md` — authoritative versus derived
- `11-knowledge-platform/deduplication.md` — candidates, never automatic merges
- `11-knowledge-platform/freshness-engine.md` — freshness assessment
- `11-knowledge-platform/governance.md` — lineage preservation
- `16-security/tenant-isolation.md` — query-time vector filtering
- `content-api.md` — citations and the grounding chain
- `research-api.md` — evidence identifiers returned by research
- `ai-api.md` — where the `ContextManifest` is assembled
- `api-principles.md` — search, pagination, expansion
- `01-system-architecture/13-adr-log.md` — **ADR-021 scoring, ADR-026 AI Memory**
- `03-database/tables.md` — citation grounding constraints
