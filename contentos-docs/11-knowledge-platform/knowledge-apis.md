# Knowledge APIs

> **Status:** v1.0 — complete. New in Phase 7. **The canonical interface specification for the Knowledge Platform.**
> This document consolidates every interface declared across the thirteen component documents and performs the Phase 7 consistency review. Where a component document and this registry differ in signature form, **this document is canonical for implementation** — no component document is modified.

## Overview

**Purpose.** Thirteen documents each declared the interfaces they own. That is the correct way to specify components and the wrong way to implement them: an implementer needs one registry, consistent naming, one tenancy convention, and one set of domain types. This document is that registry.

It also performs the **final consistency review** — six genuine drift items were found across the approved documents, and each is reconciled below with a canonical resolution.

**Two rules govern everything here.** No API exposes a database schema, a table name, a column, or an implementation detail. Every API returns **domain contracts** — types defined in the ubiquitous language, resolvable through `01-system-architecture/05-glossary.md`.

## Consistency review findings

Six drift items, reconciled.

### D-1 · Service naming was inconsistent

Approved documents declared `Retrieval.*` and `Freshness.*` while every other component used its full name.

| Declared | **Canonical** |
|---|---|
| `Retrieval.retrieve` | **`RetrievalPipeline.retrieve`** |
| `Freshness.estimate` | **`FreshnessEngine.estimate`** |

**Resolution:** service identifiers match their component document name. `retrieval-pipeline.md` → `RetrievalPipeline`; `freshness-engine.md` → `FreshnessEngine`. The short forms in those documents are aliases; the canonical names are used in code. This is the only naming change and it affects no semantics.

### D-2 · Two components answered the same coverage question

`EvidenceBank.assessCoverage(CoverageRequest) → CoverageReport` and `RetrievalPipeline.probe(request) → CoverageProbeResult` both answer *"is there enough evidence?"* — a genuine overlap that would have produced two implementations with divergent answers.

**Resolution:** **`EvidenceBank.assessCoverage` is the single public coverage interface.** It is what Planning calls. It **delegates internally** to `RetrievalPipeline.probe`, which remains an internal mechanism and is not called directly by consumers outside this platform. `CoverageProbeResult` is an internal type; `CoverageReport` is the published contract.

### D-3 · Tenancy arrived three different ways

Some signatures took `tenantId` positionally, some inside a request object, some not at all.

**Resolution — one convention with one documented exception:**

| Rule | Applies to |
|---|---|
| **Tenancy is ambient** from the request-scoped `TenantContext`; interfaces do not take `tenantId` | Every interface |
| **Except `VectorSearch`**, where `tenantId` is an explicit required parameter with no default | `VectorSearch.*` only |

The exception is deliberate and load-bearing: an ANN index returns neighbours from everything it holds, so the tenant predicate must be *explicitly present in the query*, not inherited. Making it a required parameter renders an untenanted vector search unrepresentable at the type level (`vector-search.md` §Tenant isolation).

Signatures below that previously showed `tenantId` retain it **only** where it names a *target* scope distinct from the caller's context — for example `Governance.export(tenantId, …)` invoked by a platform admin.

### D-4 · Mutating operations declared no return type

`EvidenceBank.retract(...)` and `.supersede(...)` had none.

**Resolution:** both return **`CustodyLink`** — the record appended by the operation. Returning the custody link makes the audit trail immediately available to the caller and matches `Provenance.appendCustody`.

### D-5 · `budget` parameter type was unspecified

`EntityGraph.evidenceFor(entityId, budget)` and `KnowledgeGraph.evidenceForConcept(conceptId, budget)` left `budget` untyped.

**Resolution:** the type is **`EvidenceBudget`**, as defined in `retrieval-pipeline.md` §8 — `{ maxTokens, maxItems?, minItems? }`. One budget type across the platform, supplied by the Context Builder.

### D-6 · Three evidence types needed explicit differentiation

`EvidenceRef`, `EvidenceItem`, and `EvidenceCandidate` are all used, correctly but without a single statement of when each applies.

**Resolution — canonical trio:**

| Type | Contains | Returned by |
|---|---|---|
| **`EvidenceRef`** | Identifier, source id, status, provenance **summary**, fingerprint | Ingestion, graph lookups, listings — the **published language** |
| **`EvidenceItem`** | Full record: excerpt, range, complete provenance, status | `EvidenceBank.get` / `.getMany` only |
| **`EvidenceCandidate`** | Identifier, chunk index, distance, rank provenance, embedding version — **no excerpt** | `VectorSearch.*` only |

**Rule:** cross-context consumers receive `EvidenceRef`. `EvidenceItem` is fetched deliberately when content is needed. `EvidenceCandidate` never leaves this platform.

**No further drift was found.** Event names, provenance terminology, custody vocabulary, `ArticleVersion` usage, and `ContextManifest` terminology were consistent across all thirteen documents.

## Universal conventions

| Concern | Convention |
|---|---|
| Tenancy | Ambient `TenantContext`; explicit only in `VectorSearch` and for admin-targeted scopes |
| Identifiers | UUID v7; **evidence identifiers are immutable, never reused, always resolvable** — including to a tombstone |
| Batching | Multi-item access is **batch-only** (`getMany`, `estimate(ids[])`) — no single-item loop path exists |
| Errors | Typed and exhaustive; never a partial result presented as complete |
| Async | Long operations return a handle; progress via events (ADR-020) |
| Correlation | `correlationId` propagates through every call and every event |
| Pagination | Cursor-based on every collection |
| Scores | **None returned** (ADR-021); estimates carry `method` and `computedAt` |
| Schemas | Never exposed — no table names, columns, or storage details in any contract |

## Domain contracts

The complete type surface. Every API returns these; none returns a row.

```ts
// ─── Evidence ────────────────────────────────────────────────
interface EvidenceRef {
  evidenceId: string;
  sourceId: string;
  status: 'active' | 'superseded' | 'retracted';
  provenanceSummary: { url: string; retrievedAt: string; method: string };
  fingerprint: string;
}

interface EvidenceItem extends EvidenceRef {
  excerpt: string;
  range: { start: number; end: number };
  provenance: Provenance;              // complete — see provenance.md
  supersededBy: string | null;
}

interface EvidenceCandidate {
  evidenceId: string;
  chunkIndex: number;
  distance: number;
  rankProvenance: { semanticRank?: number; lexicalRank?: number; fusedRank: number };
  embeddingVersion: string;
}

// ─── Coverage and retrieval ──────────────────────────────────
interface CoverageReport {
  perSection: Array<{ sectionId: string; availableItems: number; sufficient: boolean; staleItems: number; reason?: string }>;
  overallSufficient: boolean;
  computedAt: string;
}

interface EvidenceBudget { maxTokens: number; maxItems?: number; minItems?: number }

interface RetrievalResult {
  evidence: Array<EvidenceRef & { excerpt: string; range: Range; rank: number; rankProvenance: RankProvenance }>;
  groundingSufficient: boolean;
  evidenceTokens: number;
  diagnostics: RetrievalDiagnostics;
  rankingPolicyVersion: string;
  retrievedAt: string;
}

// ─── Citations ───────────────────────────────────────────────
interface CitationResolutionResult {
  articleVersion: ArticleVersion;      // (articleId, revisionNumber) — glossary type
  totalClaims: number;
  resolvedCount: number;
  coverageRatio: number;               // a MEASURE, not a Score
  failures: Array<{ anchorId: string; evidenceId: string | null; failure: CitationFailure }>;
  flaggedUnsupported: number;
  resolvedAt: string;
}

// ─── Graphs ──────────────────────────────────────────────────
interface Concept { conceptId: string; label: string; description: string; status: ConceptStatus }
interface Entity { entityId: string; type: EntityType; canonicalName: string; status: EntityStatus }
interface NeighbourhoodResult { center: Concept; nodes: Concept[]; edges: ConceptRelationship[]; truncated: boolean }

// ─── Freshness ───────────────────────────────────────────────
interface FreshnessEstimate {
  evidenceId: string;
  value: number;
  volatilityClass: VolatilityClass;
  sourceAgeDays: number;
  retrievedAt: string;
  publishedAt?: string;
  stale: boolean;
  method: string;
  computedAt: string;                  // estimates go stale too
  confidence: number;
}

// ─── Provenance and custody ──────────────────────────────────
interface CustodyLink {
  event: 'acquired' | 'deduplicated' | 'superseded' | 'retracted' | 'merged' | 'split' | 'migrated' | 'deleted';
  occurredAt: string;
  actor: ActorRef;
  correlationId: string;
  priorEvidenceId?: string;
  reason?: string;
}
```

**`coverageRatio` and every estimate are measures, never Scores** (ADR-021). No interface in this platform returns a `Score`, a `verdict`, or a category.

## Interface registry

### Evidence

```ts
interface EvidenceBankApi {
  ingest(ingestion: EvidenceIngestion): Promise<EvidenceRef[]>;      // Research Engine only
  get(evidenceId: string): Promise<EvidenceItem>;
  getMany(evidenceIds: string[]): Promise<EvidenceItem[]>;           // batch-only
  listByRun(runId: string): Promise<EvidenceRef[]>;
  assessCoverage(request: CoverageRequest): Promise<CoverageReport>; // D-2: the ONLY public coverage path
  supersede(evidenceId: string, newId: string, reason: string): Promise<CustodyLink>;   // D-4
  retract(evidenceId: string, reason: string, actor: ActorRef): Promise<CustodyLink>;   // D-4, elevated
}
```

### Retrieval

```ts
interface RetrievalPipelineApi {                                     // D-1
  retrieve(request: RetrievalRequest): Promise<RetrievalResult>;
  probe(request: RetrievalRequest): Promise<CoverageProbeResult>;    // internal; reached via assessCoverage
  explain(requestId: string): Promise<RetrievalDiagnostics>;
}
```

**`RetrievalPipeline.retrieve` returns the evidence portion only.** It never returns prompt context, generated text, AI Memory, or workspace context. The `ContextManifest` is composed by `08-ai-platform/context-builder.md` from this result plus AI Memory, workspace context, conversation continuity, and request context. **This boundary is mandatory** and is the single most important contract in this registry.

### Vector search — the tenancy exception

```ts
interface VectorSearchApi {
  similar(query: SimilaritySearch): Promise<EvidenceCandidate[]>;    // query.tenantId REQUIRED
  hybrid(query: SimilaritySearch, lexical: LexicalQuery, fusion: FusionConfig): Promise<EvidenceCandidate[]>;
  neighbours(evidenceId: string, k: number, tenantId: string): Promise<EvidenceCandidate[]>;
  health(): Promise<IndexHealth>;
  stats(tenantId?: string): Promise<IndexStats>;
}
```

`tenantId` is explicit and required — the D-3 exception. Internal to this platform; **no consumer outside the Knowledge Platform calls it.**

### Citations

```ts
interface CitationEngineApi {
  resolve(articleVersion: ArticleVersion): Promise<CitationResolutionResult>;
  resolveOne(anchorId: string): Promise<ResolutionRecord>;
  format(citations: Citation[], style: CitationStyle): Promise<FormattedCitation[]>;
  findDependent(evidenceId: string): Promise<ArticleVersion[]>;
  integrityReport(scope: IntegrityScope): Promise<IntegrityReport>;
}
```

### Graphs

```ts
interface KnowledgeGraphApi {
  neighbourhood(query: NeighbourhoodQuery): Promise<NeighbourhoodResult>;
  hierarchy(conceptId: string): Promise<HierarchyPath>;
  conceptsForEvidence(evidenceIds: string[]): Promise<Concept[]>;
  evidenceForConcept(conceptId: string, budget: EvidenceBudget): Promise<EvidenceRef[]>;   // D-5
  relatedConcepts(conceptIds: string[], minStrength: number): Promise<Concept[]>;
  coverageGaps(scope: CoverageScope): Promise<CoverageGap[]>;
}

interface EntityGraphApi {
  resolve(mention: string, type: EntityType | undefined): Promise<ResolutionResult>;
  get(entityId: string): Promise<Entity>;
  getMany(entityIds: string[]): Promise<Entity[]>;
  aliasesFor(entityId: string): Promise<EntityAlias[]>;
  evidenceFor(entityId: string, budget: EvidenceBudget): Promise<EvidenceRef[]>;           // D-5
  ambiguities(filter?: AmbiguityFilter): Promise<AmbiguityRecord[]>;
  merge(surviving: string, merged: string, reason: string, actor: ActorRef): Promise<MergeRecord>;   // elevated
  split(entityId: string, assignment: SplitAssignment, actor: ActorRef): Promise<SplitResult>;      // elevated
}
```

### Freshness

```ts
interface FreshnessEngineApi {                                       // D-1
  estimate(evidenceIds: string[]): Promise<FreshnessEstimate[]>;     // batch-only; retrieval hot path
  staleEvidence(filter: StaleFilter): Promise<StaleEvidenceRecord[]>;
  dependentsOf(evidenceId: string): Promise<ArticleVersion[]>;
  requestCrawl(sourceId: string, priority: Priority): Promise<CrawlRequestRef>;
  policyFor(volatilityClass: VolatilityClass): Promise<VolatilityPolicy>;
}
```

### Provenance

```ts
interface ProvenanceApi {
  validate(record: ProvenanceRecord): Promise<ValidationResult>;     // the admission gate
  get(evidenceId: string): Promise<Provenance>;
  verify(evidenceId: string): Promise<VerificationResult>;
  chainFor(evidenceId: string): Promise<CustodyLink[]>;
  appendCustody(evidenceId: string, link: CustodyLink): Promise<void>;   // internal only
}
```

### Deduplication

```ts
interface DeduplicationApi {
  detect(evidenceId: string): Promise<DuplicateSet>;
  candidates(filter: CandidateFilter): Promise<DuplicateCandidate[]>;
  merge(candidateId: string, decision: MergeDecision, actor: ActorRef): Promise<MergeLineage>;   // elevated
  split(evidenceId: string, assignment: SplitAssignment, actor: ActorRef): Promise<SplitResult>; // elevated
  reverse(mergeId: string, actor: ActorRef, reason: string): Promise<ReversalResult>;            // elevated
  lineageFor(evidenceId: string): Promise<MergeLineage[]>;
}
```

### Embedding — internal only

```ts
interface EmbeddingPipelineApi {
  enqueue(evidenceIds: string[], priority: Priority): Promise<JobRef>;
  reEmbed(scope: EmbeddingScope, version: EmbeddingVersion): Promise<MigrationRef>;   // admin
  status(scope?: EmbeddingScope): Promise<{ backlog: number; failed: number; coverage: number }>;
  currentVersion(): Promise<EmbeddingVersion>;
}
```

### Governance

```ts
interface GovernanceApi {
  applyRetention(tenantId: string, dryRun?: boolean): Promise<RetentionResult>;
  placeLegalHold(scope: HoldScope, matterRef: string, actor: ActorRef): Promise<LegalHold>;      // elevated
  releaseLegalHold(holdId: string, actor: ActorRef, reason: string): Promise<void>;              // elevated
  holdsAffecting(evidenceId: string): Promise<LegalHold[]>;
  export(tenantId: string, scope: ExportScope, options: ExportOptions): Promise<ExportRef>;      // 202
  purgeWorkspace(tenantId: string, actor: ActorRef): Promise<PurgeResult>;                       // platform admin
  executeErasure(subjectRef: SubjectRef, actor: ActorRef): Promise<ErasureResult>;
  tombstoneFor(evidenceId: string): Promise<Tombstone>;
}
```

`tenantId` appears explicitly here because these are **admin operations targeting a workspace other than the caller's context** — the documented D-3 exception for admin scopes.

## REST surface

Internal interfaces are the primary surface. REST exists only where a human or an external client needs access.

| Endpoint | Interface | Authority |
|---|---|---|
| `GET /v1/evidence/{id}` | `EvidenceBank.get` | `research.evidence.read` |
| `GET /v1/evidence/{id}/provenance` | `Provenance.get` | `research.evidence.read` |
| `GET /v1/evidence/{id}/custody` | `Provenance.chainFor` | `research.evidence.read` |
| `POST /v1/evidence/{id}/verify` | `Provenance.verify` | `research.evidence.read` |
| `POST /v1/evidence/{id}/retract` | `EvidenceBank.retract` | `research.evidence.retract` |
| `GET /v1/evidence/{id}/tombstone` | `Governance.tombstoneFor` | `research.evidence.read` |
| `GET /v1/research/runs/{id}/evidence` | `EvidenceBank.listByRun` | `research.evidence.read` |
| `GET /v1/articles/{id}/revisions/{n}/citations` | `CitationEngine.resolve` | `article.read` |
| `GET /v1/articles/{id}/citations/integrity` | `CitationEngine.integrityReport` | `article.read` |
| `GET /v1/evidence/{id}/dependents` | `CitationEngine.findDependent` | `research.evidence.read` |
| `GET /v1/knowledge/concepts` · `/{id}/neighbourhood` | `KnowledgeGraph.*` | `research.evidence.read` |
| `GET /v1/knowledge/coverage-gaps` | `KnowledgeGraph.coverageGaps` | `research.evidence.read` |
| `GET /v1/knowledge/entities` · `/{id}` | `EntityGraph.get` | `research.evidence.read` |
| `POST /v1/knowledge/entities/merge` · `/{id}/split` | `EntityGraph.*` | `research.evidence.retract` |
| `GET /v1/knowledge/entities/ambiguities` | `EntityGraph.ambiguities` | `research.evidence.read` |
| `GET /v1/knowledge/duplicates` · `POST /{id}/decide` | `Deduplication.*` | `research.evidence.retract` |
| `POST /v1/knowledge/merges/{id}/reverse` | `Deduplication.reverse` | `research.evidence.retract` |
| `GET /v1/knowledge/freshness/stale` | `FreshnessEngine.staleEvidence` | `research.evidence.read` |
| `POST /v1/knowledge/sources/{id}/refresh` | `FreshnessEngine.requestCrawl` | `research.run` |
| `GET/PATCH /v1/workspaces/{id}/knowledge/retention` | `Governance.applyRetention` | `admin` |
| `POST /v1/workspaces/{id}/knowledge/export` | `Governance.export` | `owner` |
| `POST /internal/v1/knowledge/legal-holds` | `Governance.placeLegalHold` | Platform admin |
| `GET /internal/v1/knowledge/embeddings/status` | `EmbeddingPipeline.status` | Platform admin |

**No REST surface exists for `RetrievalPipeline` or `VectorSearch`** — exposing either would let a caller extract a workspace's corpus through repeated probing.

## Consumer access matrix

| Consumer | May call |
|---|---|
| `05-content-platform/research-engine.md` | `EvidenceBank.ingest`, `Provenance.validate` |
| `05-content-platform/planning-engine.md` | `EvidenceBank.assessCoverage`, `KnowledgeGraph.*` |
| `05-content-platform/writing-engine.md` | `EvidenceBank.getMany`, `EntityGraph.aliasesFor` |
| `05-content-platform/review-engine.md` | `CitationEngine.resolve`, `EvidenceBank.getMany` |
| `05-content-platform/seo-engine.md` | `KnowledgeGraph.neighbourhood`, `relatedConcepts` |
| `05-content-platform/refresh-engine.md` | `FreshnessEngine.staleEvidence`, `estimate` |
| `08-ai-platform/context-builder.md` | **`RetrievalPipeline.retrieve`** |
| `08-ai-platform/guardrails.md` | Manifest membership verification (read-only) |
| `04-platform/users.md` | `Governance.executeErasure` |
| `04-platform/workspaces.md` | `Governance.purgeWorkspace` |

**No consumer calls `VectorSearch`, `EmbeddingPipeline`, or `RetrievalPipeline.probe` directly.** Those are internal mechanisms reached through published paths.

## Events

Consolidated from every component. All through the transactional outbox (ADR-020).

| Category | Events |
|---|---|
| **Evidence** | `EvidenceStored` · `SourceArchived` · `EvidenceSuperseded` · `EvidenceRetracted` · `EvidenceExpired` · `ProvenanceRejected` |
| **Provenance** | `ProvenanceRecorded` · `CustodyLinkAppended` · `IntegrityVerificationFailed` · `PermissionBasisFlagged` |
| **Citations** | `CitationsResolved` · `BrokenCitationDetected` · `FabricatedCitationDetected` · `CitationIntegrityCompromised` · `CitationsUpdatedAfterSupersession` |
| **Graphs** | `ConceptCreated` · `ConceptPromoted` · `ConceptArchived` · `RelationshipObserved` · `TopicalCoverageGapDetected` · `EntityCreated` · `EntityPromoted` · `EntityAliasObserved` · `EntityMerged` · `EntitySplit` · `EntityAmbiguityDetected` · `EntityArchived` |
| **Embedding / vector** | `EmbeddingsGenerated` · `KnowledgeIndexed` · `EmbeddingGenerationFailed` · `EmbeddingVersionChanged` · `ReEmbeddingProgress` · `EmbeddingDriftDetected` · `VectorIndexHealthDegraded` · `VectorIndexRebuildStarted` · `VectorIndexRebuildCompleted` · `CrossTenantRetrievalAttempted` |
| **Retrieval** | `RetrievalInsufficient` · `RetrievalPolicyChanged` · `RetrievalQualityDegraded` |
| **Freshness** | `EvidenceStale` · `CrawlRequested` · `SourceUnrefreshable` · `FreshnessConfirmed` · `ReEmbeddingRequested` · `ReIndexRequested` |
| **Deduplication** | `EvidenceDeduplicated` · `DuplicateCandidateQueued` · `DuplicateDecisionRecorded` · `EvidenceSplit` · `MergeReversed` · `ContradictoryEvidenceDetected` |
| **Governance** | `RetentionPolicyApplied` · `EvidencePurged` · `RetentionExceededWithCitations` · `LegalHoldPlaced` · `LegalHoldReleased` · `KnowledgeExportCompleted` · `ErasureExecuted` · `PurgeVerificationFailed` |

**Consumed from outside:** `SubscriptionChanged`, `WorkspaceArchived`, `WorkspacePurged`, `UserErased`, `ArticleArchived`, `RevisionCommitted`, `ArticlePublished`, `SettingsUpdated`.

**Payload rule, universal:** identifiers, counts, classifications, and hashes. **Never excerpt text, never full URLs, never vectors, never entity names in bulk.**

## Frozen interface contract

With Phase 7 complete, these interfaces are **frozen**. Changes follow the platform's normal discipline:

| Change | Requires |
|---|---|
| Adding an interface or an optional parameter | Additive; no ADR |
| Adding a returned field | Additive; consumers ignore unknown fields |
| Removing or renaming anything | **Breaking** — new version, deprecation window, ADR |
| Changing a return type's meaning | **Prohibited** — introduce a new operation |
| Adding a required parameter | **Breaking** |
| Exposing a schema detail | **Prohibited** — no exception |

## Security

- **Every interface is tenant-scoped**, ambient by default and explicit in `VectorSearch` (D-3).
- **Elevated operations** — retract, merge, split, reverse, hold, purge, erasure — require `research.evidence.retract` or platform-admin authority, and every one is audited with actor and reason.
- **Batch interfaces are the only multi-item path**, which is both a performance property and a rate-limiting surface — a single call with a bounded batch is easier to limit than an unbounded loop.
- **No interface returns a database identifier that is not a domain identifier.** No table names, no column names, no storage keys except opaque archive references.
- Cross-tenant access exists only through `Governance` admin operations under break-glass, and is audited.
- Reference `16-security/`; this document defines no controls of its own.

## Performance contract

| Interface | Budget (p95) |
|---|---|
| `EvidenceBank.get` / `getMany` | < 50 ms |
| `EvidenceBank.assessCoverage` | < 80 ms |
| `RetrievalPipeline.retrieve` | < 400 ms |
| `VectorSearch.similar` | < 120 ms |
| `CitationEngine.resolve` | < 200 ms |
| `FreshnessEngine.estimate` | < 20 ms |
| `KnowledgeGraph.neighbourhood` (depth 2) | < 150 ms |
| `EntityGraph.resolve` | < 30 ms |
| `Provenance.validate` | < 15 ms |

**Three of these sit on the grounded-generation hot path** — retrieval, freshness estimation, and evidence fetch — and their budgets are what keep the pipeline's context-assembly stage within its own 300 ms allowance (`08-ai-platform/context-builder.md`).

## Cross references

- Every component document in this folder — each declares the interfaces consolidated here
- **`08-ai-platform/context-builder.md`** — the mandatory `ContextManifest` boundary
- `01-system-architecture/05-glossary.md` — the ubiquitous language every contract uses
- `01-system-architecture/14-scoring-contract.md` — why no interface returns a Score
- `01-system-architecture/13-adr-log.md` — ADR-006, ADR-020, ADR-021, ADR-026
- `05-content-platform/` — the consumer access matrix
- `04-platform/permissions.md` — the authority levels every elevated operation requires
- `06-api/README.md` — REST conventions the surface above follows
- `03-database/tables.md` — the schema these contracts deliberately never expose
