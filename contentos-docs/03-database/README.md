# 03 — Database

The physical PostgreSQL schema of ContentOS AI, derived directly from `02-domain-design/`. **Aggregates are the source of truth; tables implement them.** A table that no aggregate justifies is a defect, and a domain invariant that reaches production without a database enforcement mechanism — or a written explanation of why one is impossible — is also a defect.

| File | Covers |
|---|---|
| `er-diagram.md` | Entity-relationship diagrams per domain area, aggregate boundaries, cross-area links |
| `tables.md` | Every table: columns, keys, constraints, ownership, size and traffic profile, lifecycle; the invariant → constraint traceability matrix |
| `indexes.md` | Index strategy per query pattern, partitioning, pgvector, full-text, trade-offs and maintenance cost |
| `migrations.md` | Tooling, ordering, expand→migrate→contract, rollback, seed and reference data, deployment sequence |

## Target platform

| Choice | Value | Status |
|---|---|---|
| Database | **PostgreSQL 17** | Proposed **ADR-022** |
| Primary ORM | **Drizzle ORM** | Proposed **ADR-022** |
| Future compatibility | Prisma-compatible schema shapes | Constraint on design |
| Vector engine | `pgvector` (HNSW) → Qdrant at scale | ADR-006 |
| Migration tool | Drizzle Kit, SQL-first, checked into the repo | Proposed **ADR-022** |

PostgreSQL 17 and Drizzle were directed by the project owner during Phase 3 and are architecturally significant, so they are recorded as a proposed ADR rather than adopted silently (`01-system-architecture/12-architecture-decisions.md`). PostgreSQL 17 matters concretely here: improved `VACUUM` memory management and faster B-tree multi-value lookups both apply directly to the high-volume append-only tables in this schema.

**Prisma compatibility is a design constraint, not a second implementation.** It means: no PostgreSQL feature in the schema that Prisma cannot introspect or express without `Unsupported` fallbacks in the core entity tables. Advanced features — RLS policies, partitioning, `pgvector` operators, exclusion constraints — live in raw SQL migrations rather than in the ORM schema, which is where they belong regardless of ORM.

## Database philosophy

**The database is the last line of defence, not a persistence detail.** Application code is generated, refactored, and occasionally wrong; a `CHECK` constraint is not. Every Phase 2 invariant that *can* be expressed as a constraint *is* one. This is the direct answer to the v1 failure documented in `AUDIT.md`, where isolation and verification were enforced in application code and both leaked.

Five principles follow:

1. **Constraints over conventions.** `UNIQUE (idempotency_key)` makes duplicate publication impossible; a code review makes it unlikely. Prefer the former.
2. **Isolation in the engine.** Tenant separation is Row-Level Security, not a `WHERE` clause. A missing predicate must return zero rows, not another tenant's rows.
3. **Immutability where history matters.** Revisions, verdicts, publish attempts, snapshots, ledger entries, and audit rows are append-only. Correction is a new row, never an `UPDATE`.
4. **Small hot tables, large cold tables.** Frequently-read aggregate roots stay narrow; high-volume history is partitioned and read through rollups.
5. **No hidden state.** Nothing derives from a value the schema does not record. If a decision depended on a threshold, the threshold is snapshotted alongside the decision.

## Aggregate mapping strategy

| Domain pattern | Physical mapping |
|---|---|
| Aggregate root | One table, named plural (`articles`, `workspaces`) |
| Entity inside an aggregate | Child table with FK to the root and a denormalized `tenant_id` |
| Value object, single-valued | Inline columns on the owning table |
| Value object, complex or open-shaped | `JSONB` column (`brief`, `capabilities`, `envelope`) |
| Value object, queried collection | Child table (`keywords`, `serp_entries`, `citation_anchors`) |
| Reference to another aggregate | Identifier column plus FK; **never** an embedded copy |
| Append-only history | Partitioned table with no `UPDATE` path |

**One aggregate root, one table, one write path.** Two aggregate roots never share a table, and a child table is never written except through its root's repository. Phase 2's deliberate splits are preserved exactly: `ArticleRevision`, `AnalyzerReport`, `GateVerdict`, `PublishAttempt`, and `PerformanceSnapshot` are separate roots — not nested rows inside `articles` — because they are append-only, high-volume, and written by parallel processes.

**JSONB is used deliberately, not lazily.** It is correct for open-shaped, versioned, or rarely-queried structures (`settings`, `envelope`, `completeness`, `capabilities`). It is wrong for anything filtered, joined, or aggregated at scale — those become columns or child tables. Every JSONB column in `tables.md` states its shape and its owning value object, and where a JSONB field participates in an invariant, a `CHECK` validates it (for example, the non-empty `evidence[]` requirement on every Explainability Envelope).

## Naming conventions

Derived from `01-system-architecture/05-glossary.md`; a name that is not a glossary term is a defect.

| Artifact | Convention | Example |
|---|---|---|
| Table | `snake_case`, plural | `article_revisions` |
| Column | `snake_case` | `revision_number` |
| Primary key | `id` | `id UUID` |
| Foreign key | `<singular_referenced>_id` | `article_id` |
| Timestamp | `<verb>_at` | `published_at`, `deleted_at` |
| Boolean | `is_` / `has_` prefix avoided; state as adjective | `enforced`, `supported` |
| Enum-like | Text column plus `CHECK` (not PostgreSQL `ENUM`) | `status TEXT CHECK (...)` |
| Index | `ix_<table>__<columns>` | `ix_articles__tenant_project_status` |
| Unique index | `ux_<table>__<columns>` | `ux_publish_attempts__idempotency_key` |
| Constraint | `ck_<table>__<rule>` / `fk_<table>__<ref>` | `ck_gate_verdicts__verdict_values` |
| Partition | `<table>_p<yyyy_mm>` | `performance_snapshots_p2026_07` |

**Text + `CHECK` instead of native `ENUM`** because adding a value to a PostgreSQL enum type historically complicated transactional migrations and neither Drizzle nor Prisma migrates enum changes cleanly; a `CHECK` constraint is edited by a normal expand/contract migration.

## Multi-tenancy

Fixed by ADR-017 and Phase 2; restated here only as it binds the schema:

- **`tenant_id` is the workspace identifier** and appears on every workspace-owned table, including child tables where it is denormalized so RLS applies without a join.
- **`organization_id`** is carried alongside it on workspace-owned tables so organization-scoped reporting never joins across tenants.
- Every table carries an RLS policy keyed on `current_setting('app.tenant_id')`, set per transaction by the gateway (`01-system-architecture/09-request-flow.md`).
- **An unset tenant context returns zero rows**, never all rows. There is a test asserting exactly this.
- Application connections use a non-superuser role. A superuser bypasses RLS silently, which would void the entire isolation model.

**The five documented exceptions** — `users`, `organizations`, `organization_memberships`, `sso_configurations`, `verified_domains` — sit above the workspace boundary and cannot carry `tenant_id`. Each has an alternative membership-keyed policy and is registered in the RLS-coverage allowlist with a written justification. **No further exception may be added without an ADR** (`02-domain-design/organizations.md`).

## Audit strategy

Two distinct mechanisms, often conflated and deliberately separated here:

| Mechanism | Purpose | Shape |
|---|---|---|
| **Audit columns** | Who last touched this row | `created_at`, `updated_at`, `created_by`, `updated_by` on every table |
| **Audit log** | What security-relevant action occurred | `audit_log`: append-only, actor, action, target, before/after, correlation id |

Audit columns answer "who changed this?"; the audit log answers "what happened, in order, and can we prove it?" Security-relevant actions — role changes, settings changes, publishing, unpublishing, credential rotation, break-glass access, erasure — write an audit row in the same transaction as the change. `audit_log` and `credit_ledger_entries` are the only tables with a database-level rule refusing `UPDATE` and `DELETE`.

## Soft delete strategy

Three strategies, applied per table by lifecycle rather than uniformly:

| Strategy | Applied to | Mechanism |
|---|---|---|
| **Soft delete** | User-deletable aggregate roots: workspaces, projects, articles, templates, targets | `deleted_at TIMESTAMPTZ NULL`; repositories filter; purge job after 30 days |
| **Terminal state** | Aggregates whose history must survive: tasks, calendar items, memberships, published content, actions, plans | `status`/`state` transitions to `cancelled` / `revoked` / `unpublished` |
| **Append-only** | Immutable history: revisions, reports, verdicts, attempts, snapshots, evidence, ledger, audit, outbox | No delete path at all; removal only by retention policy |

Soft-deleted rows remain visible to RLS — the policy is about tenancy, not lifecycle — so **every read path must filter `deleted_at IS NULL`**. This is enforced by the repository layer and by partial indexes that only cover live rows, which makes the filtered path the fast path and an unfiltered query visibly slow.

Deletion is refused where it would break a referenced chain: an article with live published URLs cannot be deleted until unpublished, and evidence with active citations is retracted rather than removed.

## Event persistence (ADR-020)

The outbox is schema, not infrastructure glue:

```
BEGIN
  -- state change
  INSERT INTO outbox_events (...)   -- same transaction, always
COMMIT
        ↓  Outbox Relay polls unpublished rows in id order
        ↓  Redis Streams (one stream per event type)
        ↓  Consumer groups
        ↓  processed_events dedupe by (consumer_group, event_id)
```

`outbox_events` is append-only with a single mutable column, `published_at`, set by the relay. The relay reads with `FOR UPDATE SKIP LOCKED` so multiple instances never duplicate work, and a partial index on `WHERE published_at IS NULL` keeps that poll cheap regardless of table size. **No code path publishes an event outside a transaction**; the publisher's signature requires a transaction handle, and there is no overload that does not.

## Read models

Cross-context joins are prohibited by the context map, so list and dashboard views that appear to need them are served by read models: `article_list_view`, `project_board_view`, `workspace_switcher_view`, `performance_rollups`.

Read models are **materialized tables maintained by event consumers**, not PostgreSQL materialized views — a materialized view refreshes wholesale, which does not scale to per-tenant freshness, and cannot be updated incrementally from an event stream. Each is rebuildable by replaying from `outbox_events`, so a projection bug is repaired by rebuild rather than by data surgery. Each carries a `projected_through` watermark so a stale projection can be surfaced as stale rather than served as truth.

## Vector search integration

`evidence_embeddings` holds chunk-level vectors with a denormalized `tenant_id`, indexed with HNSW. **Every similarity query carries a `tenant_id` filter.** This is the one isolation path RLS cannot fully protect — an unfiltered ANN search over a shared index returns nearest neighbours regardless of policy intent — so it has a dedicated cross-tenant retrieval test that fails the build. Embeddings are derived data: they are `ON DELETE CASCADE` from evidence and rebuildable from evidence plus the R2 archive, which is why they are not backed up separately (`14-operations/backup-recovery.md`).

## Migration philosophy

Expand → migrate → contract, across three releases, so the previous application version always runs against the current schema (ADR-015). Migrations are SQL-first and reviewed as code; no migration is generated and applied unread. Every new table arrives in the same migration as its `tenant_id` column, its RLS policy, and its isolation test — the `rls_coverage` CI gate refuses a merge otherwise. Detail: `migrations.md`.

## Cross References

- `02-domain-design/` — the aggregates this schema implements; the authority for every invariant
- `01-system-architecture/05-glossary.md` — naming vocabulary
- `01-system-architecture/10-event-flow.md` — outbox semantics
- `01-system-architecture/13-adr-log.md` — ADR-005, ADR-006, ADR-007, ADR-015, ADR-017, ADR-020, proposed ADR-022
- `12-storage-platform/postgresql.md` — operational configuration, replicas, vacuum, connection pooling
- `14-operations/scaling-strategy.md` §8 — the database scaling ladder these choices anticipate
- `10-testing/integration-testing.md` §8 — the isolation and index assertions run against this schema
- `16-security/` — encryption, credential handling, and the controls this schema assumes
