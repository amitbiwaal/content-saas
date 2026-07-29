# Indexes, Partitioning and Vector Search

> **Status:** v2.0 — complete. Index and physical-layout strategy for the schema in `tables.md`, targeting PostgreSQL 17.
> **Rule:** every index in this document names the query pattern that justifies it. An index without a query is write amplification with no reader, and is removed.

## 1 · Strategy

### 1.1 The tenant-leading rule

**Every index on a tenant-scoped table leads with `tenant_id`.**

This is not a convention — it is what makes Row-Level Security affordable. RLS appends `tenant_id = current_setting('app.tenant_id')::uuid` to every query. If `tenant_id` is not the leading column, the planner filters *after* an index scan that crossed tenant boundaries, and cost grows with the size of the whole table rather than with the size of one tenant's data. At S3 volumes that difference is three orders of magnitude.

The `EXPLAIN` assertions in `10-testing/integration-testing.md` §8 exist to catch a hot-path query that has lost its tenant-leading index.

### 1.2 Index budget

Every index costs write throughput, WAL volume, vacuum time, and storage. The rules applied throughout:

| Rule | Rationale |
|---|---|
| Maximum ~5 indexes on high-write tables | Each insert maintains every index |
| Partial indexes over full indexes wherever a predicate is constant | A `WHERE deleted_at IS NULL` index is often 10–40% the size of the full one |
| Composite over multiple single-column | The planner rarely combines bitmap scans as well as one correct composite |
| Covering (`INCLUDE`) only where index-only scans are proven | `INCLUDE` widens the index; it pays only for genuinely hot reads |
| No index on a column with fewer than ~3 distinct values | Unless it is part of a partial index predicate |

### 1.3 Naming

`ix_<table>__<columns>` · `ux_<table>__<columns>` (unique) · `ixp_<table>__<purpose>` (partial) · `ixg_<table>__<column>` (GIN/GiST) · `ixv_<table>__<column>` (vector).

---

## 2 · Identity and tenancy

| Index | Type | Query pattern | Trade-off |
|---|---|---|---|
| `ux_users__email` | B-tree unique on `email` (CITEXT) | Login; invitation matching | Mandatory; low cost |
| `ix_users__status` partial `WHERE status <> 'active'` | Partial B-tree | Deactivation and erasure sweeps | Tiny; avoids indexing the 99% active majority |
| `ux_organizations__slug` | B-tree unique | Slug resolution | Mandatory |
| `ixp_organizations__attention` partial `WHERE status IN ('past_due','pending_closure')` | Partial | Grace-timer and closure sweeps | Tiny; scans only rows needing action |
| `ux_org_memberships__org_user` | B-tree unique `(organization_id, user_id)` | Membership lookup; enforces one membership per user | Mandatory |
| `ix_org_memberships__user_status` | B-tree `(user_id, status)` | "My organizations" | Medium |
| `ux_verified_domains__domain` | B-tree unique | SSO domain resolution; enforces one-org-per-domain | Mandatory |
| `ux_workspaces__org_slug` | B-tree unique `(organization_id, slug)` | Slug resolution within org | Mandatory |
| `ix_workspaces__org_status` partial `WHERE deleted_at IS NULL` | Partial composite | Agency console: list an organization's workspaces | Medium |
| `ux_workspace_memberships__tenant_user` | B-tree unique `(tenant_id, user_id)` | **Permission resolution — the hottest lookup in the platform** | Mandatory |
| `ix_workspace_memberships__user_status` | B-tree `(user_id, status)` | Workspace switcher | Medium |

**The permission-resolution path is on every request.** `ux_workspace_memberships__tenant_user` plus `ux_org_memberships__org_user` are the two lookups behind the effective-permission cache (`02-domain-design/workspace.md` §Performance). Both are unique index probes; without the cache they would still be fast, but at request volume the cache is what keeps them off the p95.

---

## 3 · Work management

| Index | Type | Query pattern | Notes |
|---|---|---|---|
| `ux_projects__tenant_slug` | Unique `(tenant_id, slug)` | Slug resolution | |
| `ix_projects__tenant_status` partial `WHERE deleted_at IS NULL` | Partial composite | Project list | |
| `ux_tasks__article_type_open` partial `(article_id, type) WHERE state NOT IN ('done','cancelled')` | **Partial unique** | **Enforces the one-open-task-per-type invariant** | Constraint and index in one; scans only live tasks |
| `ix_tasks__tenant_project_state` | Composite `(tenant_id, project_id, state)` | Project backlog board | |
| `ix_tasks__assignee_state_due` partial `WHERE state NOT IN ('done','cancelled')` | Partial composite `(assignee_id, state, due_at)` | "My work", sorted by due date | Excludes terminal rows — usually the large majority |
| `ixp_tasks__overdue` partial `(tenant_id, due_at) WHERE state NOT IN ('done','cancelled') AND due_at IS NOT NULL` | Partial | Overdue sweep and reminder job | Tiny |
| `ux_calendar_items__article_active` partial `(article_id) WHERE state IN ('planned','scheduled','in_progress')` | **Partial unique** | **Enforces one active calendar item** | |
| `ix_calendar_items__tenant_planned` | Composite `(tenant_id, planned_for)` | Month view; missed-item sweep | |
| `ux_template_versions__template_version` | Unique `(template_id, version)` | Version-pinned resolution | Immutable; cached indefinitely |

---

## 4 · Research: Discovery and Knowledge

### 4.1 Discovery

| Index | Type | Query pattern | Notes |
|---|---|---|---|
| `ix_research_runs__tenant_status_created` | Composite | Run list; stuck-run detection | |
| `ix_keywords__tenant_term_locale` | Composite `(tenant_id, term, locale)` | **External-data cache lookup** — "do we already have this keyword for this locale?" | Highest-value index in Discovery: it is what prevents paying a provider twice |
| `ix_keywords__set` | B-tree `(keyword_set_id)` | Fetch a set's keywords | |
| `ix_serp_datasets__tenant_keyword_captured` | Composite `(tenant_id, keyword_term, locale, captured_at DESC)` | Latest SERP for a keyword; freshness check | `DESC` matches the read direction, avoiding a sort |
| `ux_serp_entries__dataset_position` | Unique `(serp_dataset_id, position)` | Ordered SERP render | |
| `ix_competitor_profiles__tenant_domain` | Composite | Competitor history per domain | |

### 4.2 Knowledge

| Index | Type | Query pattern | Notes |
|---|---|---|---|
| `ux_evidence_items__tenant_fingerprint` | **Unique** `(tenant_id, fingerprint)` | **Deduplication** — checked on every evidence write | Constraint and hot lookup in one |
| `ux_evidence_items__source_range` | Unique `(tenant_id, source_id, excerpt_range)` | Prevents duplicate excerpts | |
| `ix_evidence_items__tenant_created` | Composite `(tenant_id, created_at)` | Retention sweeps; run reconstruction | Partition key alignment |
| `ixp_evidence_items__active` partial `(tenant_id, source_id) WHERE status = 'active'` | Partial | Retrieval candidate filtering | Excludes superseded and retracted |
| `ux_source_documents__tenant_fingerprint` | Unique | Source-level dedup before fetch | Avoids re-fetching a known document |
| `ix_source_documents__tenant_status` | Composite | Parse and re-index sweeps | |
| `ux_evidence_embeddings__evidence_chunk` | Unique `(evidence_id, chunk_index)` | Idempotent embedding writes | Makes the embedding job safely retryable |
| `ux_extracted_entities__tenant_type_name` | Unique `(tenant_id, type, canonical_name)` | Entity resolution and linking | |
| `ux_entity_mentions__entity_evidence` | Unique `(entity_id, evidence_id)` | Mention dedup | |

---

## 5 · Articles

| Index | Type | Query pattern | Notes |
|---|---|---|---|
| `ix_articles__tenant_project_status` partial `WHERE deleted_at IS NULL` | Partial composite | The primary list view | The single most-used index in the product |
| `ix_articles__tenant_updated` partial `WHERE deleted_at IS NULL` | Partial `(tenant_id, updated_at DESC)` | Recent activity feed | |
| `ixg_articles__brief` | **GIN** on `brief` JSONB (`jsonb_path_ops`) | Search by topic or brief field | `jsonb_path_ops` is smaller and faster than the default for containment queries, which is all this needs |
| `ux_outline_versions__article_version` | Unique `(article_id, version_number)` | Monotonic numbering; latest-outline fetch | |
| `ux_article_revisions__article_revision` | Unique `(article_id, revision_number)` | Monotonic numbering | |
| `ix_article_revisions__article_revision_desc` | `(article_id, revision_number DESC)` | **Current-revision fetch** — extremely hot | `DESC` + `LIMIT 1` avoids a sort on articles with hundreds of revisions |
| `ix_citation_anchors__revision` | B-tree `(revision_id)` | Render anchors; grounding validation | |
| `ix_citation_anchors__evidence` | B-tree `(evidence_id)` | **Reverse lookup: which content cites this evidence?** | Required by retraction handling — without it, `EvidenceRetracted` cannot find affected articles without a full scan |
| `ixp_citation_anchors__unsupported` partial `(revision_id) WHERE supported = false` | Partial | Unsupported-claim reporting | Tiny; the exception case |
| `ux_analyzer_reports__version_analyzer` | Unique `(article_id, revision_number, analyzer)` | One report per analyzer per version | |
| `ix_gate_verdicts__article_revision_created` | `(article_id, revision_number, created_at DESC)` | Latest verdict for a version | Re-gates append, so `DESC` finds the current one |
| `ix_media_specs__revision` | B-tree | Render and asset fulfilment | |

---

## 6 · Publishing

| Index | Type | Query pattern | Notes |
|---|---|---|---|
| `ux_publish_attempts__idempotency_key` | **Unique** on `idempotency_key` | **The duplicate-publication guarantee** | Checked before every external write |
| `ix_publish_attempts__tenant_article_created` | Composite `(tenant_id, article_id, created_at DESC)` | Publish history | |
| `ixp_publish_attempts__unresolved` partial `(tenant_id, state) WHERE state IN ('pending','in_flight','conflict')` | Partial | **Reconciliation worker** — finds attempts with unknown outcomes | Tiny and hot; the safety net against duplicate posts |
| `ux_published_content__target_url` | Unique `(target_id, url)` | One article per live URL | |
| `ux_published_content__article_target_live` partial `(article_id, target_id) WHERE state IN ('live','updating')` | **Partial unique** | One live record per article per target | |
| `ix_published_content__url` | B-tree `(url)` | **Reverse lookup from Analytics** | Cross-context join key |
| `ixp_publish_schedules__due` partial `(tenant_id, scheduled_for) WHERE state = 'scheduled'` | Partial | Scheduler sweep | Scans only pending schedules, never history |
| `ix_publish_targets__tenant_project_status` | Composite | Target list and health view | |

---

## 7 · Analytics

| Index | Type | Query pattern | Notes |
|---|---|---|---|
| `ux_url_registry__tenant_url` | Unique | URL resolution | |
| `ix_url_registry__tenant_project` | Composite | Project dashboard | |
| `ixp_url_registry__tracking` partial `(tenant_id, state) WHERE state = 'tracking'` | Partial | Ingestion scheduling | |
| `ux_performance_snapshots__url_window_gran_asof` | Unique `(url_id, window_start, granularity, as_of)` | Idempotent ingestion; provider revisions coexist | |
| `ix_performance_snapshots__tenant_url_window` | Composite `(tenant_id, url_id, window_start DESC)` | **The dominant read** — a URL's time-series | Per-partition |
| `ixb_performance_snapshots__window` | **BRIN** on `window_start` | Wide-range scans within a partition | ~1000× smaller than B-tree; ideal for naturally ordered append-only data |
| `ux_performance_rollups__url_period` | Unique `(url_id, period, period_start)` | Dashboard reads | Rollups serve charts so raw partitions are rarely touched |
| `ix_ranking_changes__tenant_url_detected` | Composite `(tenant_id, url_id, detected_at DESC)` | Ranking history | |
| `ix_decay_signals__tenant_state_detected` | Composite | Decay sweep and inbox | |
| `ux_optimization_actions__article_type_proposed` partial `(article_id, type) WHERE state = 'proposed'` | **Partial unique** | One proposal per type per article | |
| `ux_refresh_plans__article_running` partial `(article_id) WHERE state = 'running'` | **Partial unique** | One running refresh per article | |

---

## 8 · Infrastructure

| Index | Type | Query pattern | Notes |
|---|---|---|---|
| `ixp_outbox_events__pending` partial `(id) WHERE published_at IS NULL` | **Partial** | **The relay poll** — `SELECT ... WHERE published_at IS NULL ORDER BY id FOR UPDATE SKIP LOCKED` | The most important index for event latency. Stays tiny regardless of table size because published rows leave the index |
| `ux_outbox_events__event_id` | Unique | Dedup and replay by id | |
| `ix_outbox_events__aggregate` | `(aggregate_type, aggregate_id, id)` | Replay an aggregate's event history | |
| `ix_outbox_events__correlation` | `(correlation_id)` | Incident reconstruction | |
| `pk_processed_events` | PK `(consumer_group, event_id)` | **Exactly-once effect** | The PK is the guarantee |
| `ix_audit_log__tenant_created` | `(tenant_id, created_at DESC)` | Audit browse | |
| `ix_audit_log__target` | `(target_type, target_id, created_at DESC)` | "What happened to this article?" | |
| `ix_audit_log__actor` | `(actor_id, created_at DESC)` | "What did this user do?" | Required for security investigations |
| `ux_idempotency_keys__tenant_endpoint_key` | Unique | Request idempotency | |
| `ixp_idempotency_keys__expiry` partial `(expires_at) WHERE expires_at < now()` — rebuilt by the sweep | Partial | TTL purge | |
| `ix_ai_call_costs__tenant_created` / `__article` / `__model_created` | Composites | Cost dashboards; per-article attribution; per-model analysis | Feeds the cost-per-article SLI |
| `ux_credit_holds__run` | Unique `(run_id)` | One hold per run | |
| `ix_credit_ledger__org_created` | `(organization_id, created_at DESC)` | Billing reconciliation | Org-level, matching ADR-017 |

---

## 9 · Partitioning

### 9.1 What is partitioned, and when

| Table | Strategy | From | Rationale |
|---|---|---|---|
| `performance_snapshots` | **RANGE on `window_start`**, monthly | **Day one** | 10¹⁰ rows; retrofitting partitioning on a large time-series is far more expensive than starting with it |
| `evidence_items` | RANGE on `created_at`, monthly | S3 threshold | 10⁹ rows; retention and vacuum both become cheap per-partition operations |
| `article_revisions` | RANGE on `created_at`, monthly | S3 threshold | 10⁸ rows, large JSONB payloads |
| `analyzer_reports` | RANGE on `created_at`, monthly | S3 threshold | 10⁸ rows |
| `outbox_events` | RANGE on `occurred_at`, weekly | S2 threshold | Pruning becomes `DROP TABLE` instead of a mass `DELETE` |
| `audit_log` | RANGE on `created_at`, monthly | S2 threshold | Long retention, rare reads |
| `ai_call_costs` | RANGE on `created_at`, monthly | S2 threshold | 13-month retention aligns to monthly drops |

**Hash partitioning by `tenant_id` is deliberately not used.** It would spread one tenant's data across every partition, defeating partition pruning for the tenant-scoped queries that dominate this workload. Time-range partitioning plus tenant-leading indexes gives pruning on both dimensions: the range prunes partitions, the index prunes within them.

### 9.2 Operational rules

- Partitions are created **three months ahead** by a scheduled job; a missing partition is an outage on the write path, so the job alerts on failure and the check is part of the deploy verification.
- Indexes are declared on the parent and inherited; each new partition builds its own.
- Retention drops whole partitions (`DROP TABLE`), which is instantaneous and produces no bloat, rather than deleting rows.
- Every partitioned table's unique constraints must include the partition key — this is why `ux_performance_snapshots__url_window_gran_asof` leads with columns that include `window_start`.

---

## 10 · Vector search

### 10.1 Configuration

```sql
CREATE INDEX ixv_evidence_embeddings__hnsw
  ON evidence_embeddings USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
```

| Parameter | Value | Reasoning |
|---|---|---|
| Index type | **HNSW** | Better recall-per-latency than IVFFlat and no training step, which matters because the corpus grows continuously rather than being bulk-loaded |
| Distance | Cosine | Embeddings are normalized; cosine is the standard for text similarity |
| `m = 16` | Graph degree | Default balance of recall and index size |
| `ef_construction = 64` | Build quality | Higher improves recall at the cost of build time |
| `ef_search` | 40 default, tunable per query | Set at query time via `hnsw.ef_search`; raised for high-stakes retrieval, lowered for bulk operations |

### 10.2 Tenant isolation — the rule that matters most

**Every similarity query carries an explicit `tenant_id` predicate:**

```sql
SELECT e.id, e.excerpt, emb.embedding <=> $1 AS distance
FROM evidence_embeddings emb
JOIN evidence_items e ON e.id = emb.evidence_id
WHERE emb.tenant_id = $2                    -- MANDATORY, never optional
  AND e.status = 'active'
ORDER BY emb.embedding <=> $1
LIMIT $3;
```

RLS does apply to these tables, but an ANN index search is not a filtered scan: the index returns approximate nearest neighbours across everything it contains, and the tenant predicate is applied afterwards. Without the explicit filter, recall degrades unpredictably for the correct tenant and the query wastes work traversing other tenants' vectors. **This is the one isolation path RLS cannot fully protect**, which is why `10-testing/integration-testing.md` §8 includes a dedicated cross-tenant nearest-neighbour test asserting zero foreign results.

`tenant_id` is denormalized onto `evidence_embeddings` precisely so this predicate needs no join.

### 10.3 Hybrid search

Semantic retrieval alone misses exact terms — product names, statistics, proper nouns. Retrieval combines:

1. **Vector search** (HNSW, cosine) for semantic similarity.
2. **Full-text search** (GIN on `to_tsvector`) for lexical matching.
3. **Reciprocal Rank Fusion** to merge both ranked lists, which requires no score normalization between two incomparable scales.

```sql
CREATE INDEX ixg_evidence_items__fts
  ON evidence_items USING gin (to_tsvector('english', excerpt));
```

Fusion weighting and reranking are owned by `11-knowledge-platform/retrieval-pipeline.md`; this document provides the indexes both halves require.

### 10.4 Migration path to Qdrant

Cutover criteria are ADR-006 and `14-operations/scaling-strategy.md` §8: any two of index > 50 GB, query p95 > 200 ms at target recall, > 50M embeddings, or measurable contention with transactional load. The path is dual-write → backfill → shadow-read comparison → cutover, with `evidence_embeddings` retained until parity is proven. Because embeddings are derived data, the fallback is always "rebuild from evidence" rather than "restore from backup."

---

## 11 · Full-text search

| Index | Table | Purpose |
|---|---|---|
| `ixg_evidence_items__fts` | `evidence_items` | Lexical half of hybrid retrieval |
| `ixg_articles__brief` | `articles` | Brief and topic search (GIN `jsonb_path_ops`) |
| `ixg_article_revisions__content_fts` | `article_revisions` | In-app content search across a workspace |

Generated `tsvector` columns are preferred over expression indexes where the column is queried frequently — PostgreSQL 17 stored generated columns keep the vector materialized, avoiding recomputation per query. English is the default configuration; multi-language search is deferred with localization and will require per-locale configurations.

---

## 12 · Query optimization and maintenance

### 12.1 Planner and statistics

- `default_statistics_target = 250` on high-cardinality tenant-scoped tables, so the planner estimates tenant selectivity correctly. The default of 100 systematically underestimates on skewed multi-tenant data, producing sequential scans for large tenants.
- **Extended statistics** on correlated column pairs, which the planner otherwise assumes independent:
  ```sql
  CREATE STATISTICS st_articles__project_status (dependencies)
    ON project_id, status FROM articles;
  ```
- `ANALYZE` after every bulk load, every backfill, and every new partition.

### 12.2 Vacuum

| Table class | Setting | Reason |
|---|---|---|
| High-churn (`tasks`, `articles`, `published_content`) | `autovacuum_vacuum_scale_factor = 0.05` | Default 0.2 lets bloat accumulate for far too long on hot tables |
| Append-only (`evidence_items`, `snapshots`, `attempts`, `audit_log`) | `autovacuum_vacuum_insert_scale_factor = 0.1` | Insert-only tables still need vacuum for visibility-map maintenance and index-only scans |
| `outbox_events` | Aggressive: `scale_factor = 0.02` | The one column that updates (`published_at`) churns constantly; without aggressive vacuum, the pending partial index bloats and event latency rises |

PostgreSQL 17's improved vacuum memory management reduces the cost of these settings on the largest tables — one of the concrete reasons for the version choice.

### 12.3 HOT updates

`fillfactor = 85` on frequently-updated tables (`articles`, `tasks`, `published_content`, `outbox_events`) leaves page space for heap-only tuple updates, which avoid index maintenance entirely when no indexed column changes. This is why `outbox_events.published_at` is deliberately **not** indexed by a plain B-tree on itself: doing so would prevent HOT updates on the platform's highest-write table.

Append-only tables keep `fillfactor = 100`, since they never update.

### 12.4 Connection pooling

PgBouncer in **transaction pooling** mode from S2 (`14-operations/scaling-strategy.md` §8, step 2), because worker fleets exhaust connections long before CPU. Transaction pooling has one hard consequence for this schema: `current_setting('app.tenant_id')` must be set **per transaction**, not per session, or a pooled connection could carry one tenant's context into another tenant's transaction. The gateway's DB Session Binder does exactly this (`01-system-architecture/08-c4-component.md`), and there is an integration test asserting that a pooled connection cannot leak context.

### 12.5 JSONB and compression

Large JSONB columns (`article_revisions.sections`, `publish_packages.body`) are TOASTed automatically. Where a column is large but rarely read in full, `ALTER TABLE ... ALTER COLUMN ... SET STORAGE EXTENDED` keeps it out of the main heap so row-level reads stay fast. PostgreSQL 17's LZ4 TOAST compression is preferred over the default for these columns: meaningfully faster decompression at slightly lower ratio, and these payloads are read far more often than they are written.

---

## 13 · Index maintenance cost summary

| Table | Indexes | Write cost | Notes |
|---|---|---|---|
| `evidence_items` | 5 | High | Justified — dedup and retrieval both depend on them |
| `evidence_embeddings` | 2 (1 HNSW) | **Very high** | HNSW build is the most expensive index operation in the platform; embedding writes are batched and asynchronous for this reason |
| `performance_snapshots` | 3 (1 BRIN) | Low | BRIN is nearly free; partition-local B-trees stay small |
| `outbox_events` | 4 | Medium | The pending partial index stays tiny; the rest are read-path only |
| `citation_anchors` | 3 | High | The reverse-lookup index is mandatory for retraction handling |
| `articles` | 4 (1 GIN) | Medium | GIN on `brief` is the costliest; briefs change rarely |
| `tasks` | 4 (3 partial) | Low | Partial indexes exclude terminal rows, which are the majority |

Index bloat is monitored via `pg_stat_user_indexes` and `pgstattuple`; unused indexes (`idx_scan = 0` over 30 days) are reported monthly and dropped after review. **Reindexing uses `REINDEX CONCURRENTLY`** — the non-concurrent form takes an `ACCESS EXCLUSIVE` lock and is prohibited outside a maintenance window.

---

## 14 · Cross References

- `tables.md` — the tables and constraints these indexes serve
- `er-diagram.md` — relationship cardinality driving join patterns
- `migrations.md` — `CREATE INDEX CONCURRENTLY` rules and partition creation
- `12-storage-platform/postgresql.md` — server configuration, replicas, vacuum operations
- `12-storage-platform/qdrant.md` — the vector migration target
- `11-knowledge-platform/vector-search.md` · `rag-pipeline.md` — retrieval and fusion strategy
- `14-operations/scaling-strategy.md` §8 — the ladder these choices anticipate
- `10-testing/integration-testing.md` §8 — `EXPLAIN` assertions and the cross-tenant vector test

## 15 · Open Questions

- **OQ-11** — the embedding model fixes `VECTOR(n)` and HNSW parameters; `m` and `ef_construction` are provisional until measured against the real corpus.
- **OQ-6** — Qdrant cutover thresholds proposed but not yet accepted as an ADR.
- Whether `article_revisions` full-text search should index all revisions or only the current one per article. Current position: all, with a partial index limited to the current revision if write cost proves excessive.
