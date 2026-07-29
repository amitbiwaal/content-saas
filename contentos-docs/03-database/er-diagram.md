# ER Diagrams

> **Status:** v2.0 — complete. Entity-relationship view of the schema specified in `tables.md`, organized by domain area with aggregate boundaries marked.
> **Authority:** `02-domain-design/`. These diagrams show *relationships and cardinality*; column-level detail, constraints, and traffic profiles are in `tables.md`.

## Overview

Six domain diagrams plus one cross-area overview. Each corresponds to a Phase 2 domain document, and each marks aggregate boundaries explicitly, because the boundary — not the foreign key — is what determines transactional scope and write path.

**Reading the diagrams**

| Notation | Meaning |
|---|---|
| `||--o{` | One to zero-or-many |
| `||--||` | One to one |
| `}o--o{` | Many to many (always via a join table) |
| **AR** in a comment | Aggregate root |
| Dashed grouping in prose | Aggregate boundary — rows inside are written only through the root's repository |

**Two rules visible in every diagram**

1. A foreign key crossing an aggregate boundary is a **reference**, not a composition. It is enforced (`ON DELETE RESTRICT`) but never traversed transactionally: writing an article never writes a revision row in the same aggregate operation.
2. A foreign key crossing a **bounded context** boundary carries no application-level join. `citation_anchors.evidence_id` references Knowledge from Authoring; the constraint protects integrity, while retrieval happens through the Knowledge Platform's published interface.

## 1 · Identity and tenancy

The five tables above the workspace boundary, plus the workspace itself. These are the RLS exceptions documented in `02-domain-design/organizations.md`.

```mermaid
erDiagram
    users ||--o{ organization_memberships : "holds"
    users ||--o{ workspace_memberships : "holds"
    organizations ||--o{ organization_memberships : "grants"
    organizations ||--o{ workspaces : "owns"
    organizations ||--o| sso_configurations : "configures"
    organizations ||--o{ verified_domains : "claims"
    workspaces ||--o{ workspace_memberships : "grants"
    workspaces ||--o{ workspace_settings_history : "records"

    users {
        uuid id PK
        citext email UK
        text status
        boolean email_verified
        jsonb mfa_state
        timestamptz deleted_at
    }
    organizations {
        uuid id PK
        text slug UK
        text status
        jsonb plan_limits
        text billing_ref
        int version
        timestamptz deleted_at
    }
    organization_memberships {
        uuid id PK
        uuid organization_id FK
        uuid user_id FK
        text role
        text status
    }
    sso_configurations {
        uuid id PK
        uuid organization_id FK
        text protocol
        jsonb config
        boolean enforced
    }
    verified_domains {
        uuid id PK
        uuid organization_id FK
        text domain UK
        timestamptz verified_at
    }
    workspaces {
        uuid id PK
        uuid organization_id FK
        text slug
        text status
        jsonb settings
        int version
        timestamptz deleted_at
    }
    workspace_memberships {
        uuid id PK
        uuid tenant_id FK
        uuid user_id FK
        text role
        text status
    }
    workspace_settings_history {
        uuid id PK
        uuid tenant_id FK
        text[] changed_keys
        uuid changed_by
    }
```

**Aggregate boundaries:** `User`, `Organization`, `OrganizationMembership`, `SsoConfiguration`, `Workspace`, and `WorkspaceMembership` are each their own root. Memberships are separate roots because they are written far more frequently than their parents, and nesting them would serialize unrelated writes on a 200-member workspace.

**The tenancy pivot:** `workspaces.id` **is** `tenant_id` everywhere downstream. Every table in every diagram below carries it, plus `organization_id` denormalized from this table.

## 2 · Work management

```mermaid
erDiagram
    workspaces ||--o{ projects : "contains"
    projects ||--o{ tasks : "tracks"
    projects ||--o{ calendar_items : "schedules"
    projects ||--o{ articles : "organizes"
    workspaces ||--o{ templates : "defines"
    templates ||--o{ template_versions : "versions"
    template_versions ||..o{ projects : "referenced as default"
    users ||--o{ tasks : "assigned"
    articles ||--o{ tasks : "referenced by"
    articles ||--o{ calendar_items : "planned for"

    projects {
        uuid id PK
        uuid tenant_id FK
        uuid organization_id
        text slug
        text target_site
        jsonb defaults
        text status
        timestamptz deleted_at
    }
    tasks {
        uuid id PK
        uuid tenant_id
        uuid project_id FK
        uuid article_id FK
        text type
        uuid assignee_id FK
        text state
        timestamptz due_at
    }
    calendar_items {
        uuid id PK
        uuid tenant_id
        uuid project_id FK
        uuid article_id FK
        date planned_for
        text state
    }
    templates {
        uuid id PK
        uuid tenant_id
        text name
        text status
    }
    template_versions {
        uuid template_id PK
        int version PK
        jsonb body
        timestamptz published_at
    }
```

**Cardinality note:** an article has *at most one open task per type* and *at most one active calendar item* — enforced by partial unique indexes rather than by cardinality in the diagram, since both constraints are state-dependent (`tables.md`).

## 3 · Research: Discovery and Knowledge

```mermaid
erDiagram
    projects ||--o{ research_runs : "scopes"
    articles ||--o{ research_runs : "may belong to"
    research_runs ||--o{ keyword_sets : "produces"
    keyword_sets ||--o{ keywords : "contains"
    research_runs ||--o{ serp_datasets : "produces"
    serp_datasets ||--o{ serp_entries : "contains"
    research_runs ||--o{ competitor_profiles : "produces"
    research_runs ||--o{ source_documents : "retrieves"
    source_documents ||--o{ evidence_items : "excerpted into"
    evidence_items ||--o{ evidence_embeddings : "chunked into"
    evidence_items ||--o{ entity_mentions : "mentions"
    extracted_entities ||--o{ entity_mentions : "referenced by"
    evidence_items ||--o| evidence_items : "superseded_by"

    research_runs {
        uuid id PK
        uuid tenant_id
        uuid project_id FK
        uuid article_id FK
        jsonb scope
        text status
        jsonb degradations
    }
    keywords {
        uuid id PK
        uuid tenant_id
        uuid keyword_set_id FK
        text term
        text locale
        int volume
        int difficulty
        text intent
        timestamptz as_of
    }
    serp_entries {
        uuid id PK
        uuid tenant_id
        uuid serp_dataset_id FK
        int position
        text url
        jsonb structural_summary
    }
    competitor_profiles {
        uuid id PK
        uuid tenant_id
        text domain
        jsonb structure
        jsonb gaps
        timestamptz analyzed_at
    }
    source_documents {
        uuid id PK
        uuid tenant_id
        jsonb provenance
        text fingerprint
        text archive_ref
        jsonb trust
        jsonb freshness
        text status
    }
    evidence_items {
        uuid id PK
        uuid tenant_id
        uuid source_id FK
        jsonb provenance
        text fingerprint UK
        int4range range
        text excerpt
        text status
        uuid superseded_by FK
    }
    evidence_embeddings {
        uuid id PK
        uuid tenant_id
        uuid evidence_id FK
        int chunk_index
        vector embedding
    }
    extracted_entities {
        uuid id PK
        uuid tenant_id
        text type
        text canonical_name
    }
```

**The lifetime asymmetry that shapes this diagram:** `research_runs` are short-lived work records; `evidence_items` outlive every run and article that used them. That is why evidence is its own aggregate root with its own retention policy and why the FK from runs to evidence is `RESTRICT`, not `CASCADE`. Deleting a run must never delete knowledge.

**`evidence_embeddings` is the only `CASCADE` in the schema** because embeddings are derived data, fully rebuildable from evidence plus the R2 archive.

## 4 · Articles: Authoring and Quality

```mermaid
erDiagram
    projects ||--o{ articles : "organizes"
    articles ||--o{ outline_versions : "plans via"
    articles ||--o{ article_revisions : "snapshots as"
    article_revisions ||--o{ citation_anchors : "grounds via"
    article_revisions ||--o{ media_specs : "declares"
    articles ||--o{ analyzer_reports : "judged by"
    articles ||--o{ gate_verdicts : "gated by"
    evidence_items ||--o{ citation_anchors : "supports"
    media_assets ||--o{ media_specs : "fulfilled by"

    articles {
        uuid id PK
        uuid tenant_id
        uuid organization_id
        uuid project_id FK
        jsonb brief
        text type
        text status
        int current_revision
        uuid approved_outline_id FK
        int version
        timestamptz deleted_at
    }
    outline_versions {
        uuid id PK
        uuid tenant_id
        uuid article_id FK
        int version_number
        jsonb intent
        jsonb persona
        jsonb clusters
        jsonb sections
        jsonb coverage
        text status
    }
    article_revisions {
        uuid id PK
        uuid tenant_id
        uuid article_id FK
        int revision_number
        jsonb sections
        text content_hash
        text origin
    }
    citation_anchors {
        uuid id PK
        uuid tenant_id
        uuid revision_id FK
        text claim_text
        int4range offsets
        uuid evidence_id FK
        boolean supported
    }
    media_specs {
        uuid id PK
        uuid tenant_id
        uuid revision_id FK
        text kind
        text purpose
        text alt_text
        uuid asset_ref FK
    }
    analyzer_reports {
        uuid id PK
        uuid tenant_id
        uuid article_id FK
        int revision_number
        text analyzer
        jsonb findings
        int score
        numeric confidence
    }
    gate_verdicts {
        uuid id PK
        uuid tenant_id
        uuid article_id FK
        int revision_number
        text verdict
        jsonb reasons
        jsonb threshold_snapshot
        jsonb annotations
    }
```

**Three structural decisions visible here:**

`analyzer_reports` and `gate_verdicts` reference `(article_id, revision_number)` rather than `revision_id` — the composite is the `ArticleVersion` value object from the glossary, and using it directly makes "this verdict judged exactly these bytes" enforceable and readable.

`citation_anchors.evidence_id` is the **grounding chain in physical form**: it crosses from Authoring into Knowledge with `ON DELETE RESTRICT`, so evidence in use by published content cannot be deleted. This single constraint is what makes the grounding invariant durable rather than aspirational.

`media_specs.asset_ref` implements the ADR-018 split: the spec (intent) belongs to Authoring, the asset belongs to the Platform Layer, and the FK is nullable because a spec legitimately exists before its asset does.

## 5 · Publishing

```mermaid
erDiagram
    projects ||--o{ publish_targets : "configures"
    articles ||--o{ publish_packages : "assembled into"
    gate_verdicts ||--o{ publish_packages : "authorizes"
    publish_packages ||--o{ publish_attempts : "executed as"
    publish_targets ||--o{ publish_attempts : "targets"
    publish_attempts ||--o| published_content : "produces"
    articles ||--o{ published_content : "live as"
    articles ||--o{ publish_schedules : "scheduled by"

    publish_targets {
        uuid id PK
        uuid tenant_id
        uuid project_id FK
        text type
        text credential_ref
        jsonb capabilities
        jsonb mapping
        text status
        timestamptz deleted_at
    }
    publish_packages {
        uuid id PK
        uuid tenant_id
        uuid article_id FK
        int revision_number
        uuid verdict_id FK
        jsonb body
        jsonb seo
        jsonb media
        text status
    }
    publish_attempts {
        uuid id PK
        uuid tenant_id
        uuid package_id FK
        uuid target_id FK
        text idempotency_key UK
        text mode
        text state
        jsonb failure
        text result_url
        text external_ref
    }
    published_content {
        uuid id PK
        uuid tenant_id
        uuid article_id FK
        uuid target_id FK
        text url
        int live_revision
        text external_ref
        text state
    }
    publish_schedules {
        uuid id PK
        uuid tenant_id
        uuid article_id FK
        uuid[] target_ids
        timestamptz scheduled_for
        text state
    }
```

**`publish_packages.verdict_id` is the authorization chain in physical form.** A package cannot exist without a verdict row, and the verdict row carries the threshold snapshot in force when it was issued. Together they make "what authorized this publication?" answerable from the database alone, months later.

**`ux_publish_attempts__idempotency_key`** is the single most consequential constraint in the schema. `idempotency_key = (article_version, target_id, mode)` means a retried publish physically cannot write twice to a customer's live site.

## 6 · Analytics and performance

```mermaid
erDiagram
    published_content ||--|| url_registry : "tracked as"
    articles ||--o{ url_registry : "measured via"
    url_registry ||--o{ performance_snapshots : "measured by"
    url_registry ||--o{ ranking_changes : "detected on"
    url_registry ||--o{ decay_signals : "signals"
    url_registry ||--o{ performance_rollups : "aggregated into"
    decay_signals ||--o{ optimization_actions : "justifies"
    decay_signals ||--o{ refresh_plans : "triggers"
    articles ||--o{ optimization_actions : "improves"
    articles ||--o{ refresh_plans : "refreshes"
    refresh_plans ||--o| research_runs : "starts"

    url_registry {
        uuid id PK
        uuid tenant_id
        uuid project_id FK
        uuid article_id FK
        text url UK
        text gsc_property
        text ga_property
        text state
    }
    performance_snapshots {
        uuid id PK
        uuid tenant_id
        uuid url_id FK
        date window_start
        date window_end
        text granularity
        jsonb search
        jsonb traffic
        jsonb conversions
        jsonb completeness
        timestamptz as_of
    }
    performance_rollups {
        uuid id PK
        uuid tenant_id
        uuid url_id FK
        text period
        jsonb metrics
    }
    ranking_changes {
        uuid id PK
        uuid tenant_id
        uuid url_id FK
        text keyword
        jsonb delta
        jsonb confidence
        text direction
    }
    decay_signals {
        uuid id PK
        uuid tenant_id
        uuid url_id FK
        uuid article_id FK
        text type
        text severity
        jsonb supporting_metrics
    }
    optimization_actions {
        uuid id PK
        uuid tenant_id
        uuid article_id FK
        text type
        jsonb envelope
        text state
        jsonb baseline
        jsonb outcome
    }
    refresh_plans {
        uuid id PK
        uuid tenant_id
        uuid article_id FK
        jsonb scope
        jsonb envelope
        text state
        uuid run_id FK
    }
```

**`refresh_plans.run_id → research_runs.id` closes the lifecycle loop physically.** Measurement produces a refresh plan, which starts a research run, which produces evidence, which produces a new revision — the same tables the original article used. The loop in `01-system-architecture/02-product-vision.md` is not a metaphor; it is a cycle in this graph.

`performance_snapshots` is the highest-volume table in the platform and is partitioned by `(tenant_id, window_start)` from day one (`indexes.md`).

## 7 · Platform and infrastructure

```mermaid
erDiagram
    workspaces ||--o{ credit_holds : "reserves"
    organizations ||--o{ credit_ledger_entries : "billed to"
    workspaces ||--o{ ai_call_costs : "consumes"
    articles ||--o{ ai_call_costs : "attributed to"
    workspaces ||--o{ media_assets : "stores"
    outbox_events ||--o{ processed_events : "consumed as"

    outbox_events {
        bigserial id PK
        uuid tenant_id
        uuid organization_id
        uuid event_id UK
        text event_type
        int event_version
        text aggregate_type
        uuid aggregate_id
        uuid correlation_id
        uuid causation_id
        jsonb payload
        timestamptz published_at
    }
    processed_events {
        text consumer_group PK
        uuid event_id PK
        timestamptz processed_at
    }
    audit_log {
        uuid id PK
        uuid tenant_id
        uuid organization_id
        uuid actor_id
        text action
        text target_type
        uuid target_id
        jsonb before
        jsonb after
        uuid correlation_id
    }
    idempotency_keys {
        uuid id PK
        uuid tenant_id
        text endpoint
        text key
        jsonb response
        timestamptz expires_at
    }
    credit_holds {
        uuid id PK
        uuid tenant_id
        uuid organization_id
        uuid run_id
        numeric amount
        text state
    }
    credit_ledger_entries {
        uuid id PK
        uuid tenant_id
        uuid organization_id
        text entry_type
        numeric amount
        uuid hold_id FK
        uuid correlation_id
    }
    ai_call_costs {
        uuid id PK
        uuid tenant_id
        uuid article_id
        text task_type
        text model
        text prompt_version
        int prompt_tokens
        int completion_tokens
        numeric cost_usd
        boolean cache_hit
    }
    media_assets {
        uuid id PK
        uuid tenant_id
        text kind
        text object_key
        jsonb transforms
        text status
    }
```

**`outbox_events` has no foreign keys by design.** It must be writable in the same transaction as any state change in any table without creating a dependency cycle, and it must survive the deletion of the aggregate it describes — an `ArticlePurged` event referencing a deleted article is exactly the case that matters.

**`credit_ledger_entries` carries both `tenant_id` and `organization_id`**: consumption is attributed per workspace, billing resolves per organization (ADR-017). Commerce's full schema — plans, subscriptions, invoices — is owned by `04-platform/billing.md` and specified in Phase 5; only the tables Phase 1 and Phase 2 already depend on appear here.

## 8 · Cross-area overview

Aggregate roots only, with the pipeline path highlighted.

```mermaid
erDiagram
    organizations ||--o{ workspaces : ""
    workspaces ||--o{ projects : ""
    projects ||--o{ articles : ""
    projects ||--o{ research_runs : ""
    projects ||--o{ publish_targets : ""
    research_runs ||--o{ evidence_items : ""
    evidence_items ||--o{ citation_anchors : ""
    articles ||--o{ article_revisions : ""
    article_revisions ||--o{ citation_anchors : ""
    articles ||--o{ gate_verdicts : ""
    gate_verdicts ||--o{ publish_packages : ""
    publish_packages ||--o{ publish_attempts : ""
    publish_attempts ||--o| published_content : ""
    published_content ||--|| url_registry : ""
    url_registry ||--o{ performance_snapshots : ""
    performance_snapshots ||--o{ decay_signals : ""
    decay_signals ||--o{ refresh_plans : ""
    refresh_plans ||--o{ research_runs : ""
```

Read clockwise from `projects`: research produces evidence, evidence grounds revisions, revisions earn verdicts, verdicts authorize packages, packages become live URLs, URLs produce measurements, measurements trigger refresh, refresh starts research. **Every arrow in that cycle is a foreign key**, which is what makes the lifecycle auditable end to end: given a live URL, the chain back to the evidence supporting each claim is a series of joins, not a reconstruction.

## Cardinality summary

| Relationship | Cardinality | Enforcement |
|---|---|---|
| organization → workspaces | 1 : 1..N | FK; organization must have ≥1 workspace (application invariant) |
| workspace → projects | 1 : 1..N | FK; default project created with workspace |
| project → articles | 1 : 0..N | FK `RESTRICT` |
| article → revisions | 1 : 0..N | FK; `UNIQUE (article_id, revision_number)` |
| article → outline versions | 1 : 0..N | FK; `UNIQUE (article_id, version_number)` |
| (article, revision) → analyzer report | 1 : 0..1 per analyzer | `UNIQUE (article_id, revision_number, analyzer)` |
| (article, revision) → gate verdict | 1 : 0..N (re-gates) | Append-only; latest by `created_at` is current |
| package → attempts | 1 : 1..N (one per target) | FK; `UNIQUE (idempotency_key)` |
| (article, target) → published content | 1 : 0..1 live | Partial unique `WHERE state IN ('live','updating')` |
| published content → url registry | 1 : 1 | `UNIQUE (url)` |
| url → snapshots | 1 : 0..N | Partitioned; `UNIQUE (url_id, window_start, granularity, as_of)` |
| article → open task per type | 1 : 0..1 | Partial unique `WHERE state NOT IN ('done','cancelled')` |
| article → active calendar item | 1 : 0..1 | Partial unique `WHERE state IN ('planned','scheduled','in_progress')` |
| evidence → embeddings | 1 : 1..N chunks | FK `CASCADE` (only cascade in the schema) |

## Cross References

- `tables.md` — column-level specification, constraints, traffic profiles, and the invariant traceability matrix
- `indexes.md` — index strategy, partitioning, pgvector configuration
- `migrations.md` — the order in which these tables are created
- `02-domain-design/` — the aggregates these entities implement
- `01-system-architecture/04-context-map.md` — the context boundaries the cross-context FKs cross
- `11-knowledge-platform/` — subsystems operating over the evidence and embedding tables
