# ContentOS AI — Engineering Documentation

The canonical engineering blueprint for **ContentOS AI**, an enterprise Content Intelligence Operating System. This tree is the single source of truth from which the production application is generated.

**Baseline superseded.** `ARCHITECTURE_BASELINE_ARCHIVE.md` (formerly `01_SYSTEM_ARCHITECTURE.md`) is frozen historical reference; v1 product documents live in `archive/`. Where anything conflicts with this tree, this tree wins — amendable only through an ADR (`01-system-architecture/13-adr-log.md`).

## Structure

| Folder | Owns |
|---|---|
| `01-system-architecture/` | Source of truth: vision, layered design, C4 views, context map, glossary, runtime flows, topology, ADRs |
| `02-domain-design/` | Bounded contexts: entities, aggregates, invariants, lifecycles, domain events |
| `03-database/` | Physical PostgreSQL schema: ER diagrams, tables, RLS, indexes, migrations |
| `04-platform/` | Platform services: auth, workspace, organizations, users, roles, billing, credits, notifications, media, workflow, templates, settings, audit logs, feature flags |
| `05-content-platform/` | The 13 content intelligence engines: keyword → SERP → competitor → research → planning → knowledge → writing → review → SEO → publishing → analytics → optimization → refresh |
| `06-api/` | Public API contracts and the conventions every endpoint follows |
| `07-development-guide/` | How humans and AI coding agents work in the codebase |
| `08-ai-platform/` | Gateway, router, prompts, context, memory, tools, validation, guardrails, streaming, cost, AI observability, AI Council |
| `09-integrations/` | Provider Layer: the provider pattern, eight providers, shared retry/rate-limit/versioning/webhook policy |
| `10-testing/` | Test taxonomy, CI gate contract, unit/integration/E2E/load/regression, AI evaluation |
| `11-knowledge-platform/` | Evidence Bank, knowledge and entity graphs, citations, vector search, embeddings, retrieval, provenance, freshness, deduplication |
| `12-storage-platform/` | Binary object storage: objects, blobs, media processing, CDN, backups, disaster recovery, retention |
| `13-event-platform/` | Transactional outbox, event bus, registry, consumers, workers, retry, DLQ, replay, ordering, versioning |
| `14-operations/` | Release process, monitoring, incident response, backup/recovery, scaling |
| `16-security/` | Cross-cutting controls: authentication, authorization, RBAC, RLS, tenant isolation, API security, secrets, encryption, audit, compliance, threat model, incident response |
| `99-open-questions.md` | Living register of pending decisions |
| `00-architecture-review.md` | One-time pre-refactor review (2026-07-28); archive once the refactor completes |

## Conventions (bind every document)

- **Engine** = a bounded business capability. AI is a component *inside* an engine, never the unit of decomposition (ADR-001).
- **Tenancy is `Organization → Workspace → Project`** (ADR-017). Every row, cache key, object path, and vector namespace carries `tenant_id`; PostgreSQL RLS enforces isolation.
- Every recommendation ships in an **Explainability Envelope**: `{ recommendation, reason, evidence[], expected_impact, confidence }`.
- **Grounding invariant:** by Publishing, every factual claim traces to an Evidence Bank source via the Citation Engine, or is explicitly flagged.
- All model-provider calls go through the **AI Gateway** only (`08-ai-platform/`). External providers live in the **Provider Layer** (`09-integrations/`).
- Architecture changes happen **only via ADRs**.

## Status

| State | Folders |
|---|---|
| Complete | `08-ai-platform` (5 of 14) · `09-integrations` (8 of 14) · `10-testing` (5 of 8) · `14-operations` (5 of 8) · `99-open-questions.md` |
| Partially complete | `05-content-platform`: `planning-engine.md`, `review-engine.md` |
| Placeholders | `01` · `02` · `03` · `06` · `07` |
| Not yet created | `04-platform` · `11-knowledge-platform` · `12-storage-platform` · `13-event-platform` |

**Writing order** (each phase internally consistent before the next): `01` → `02` → `03` → `12` + `13` → `04` → `11` → `05` → `08` → `06` → `09` → `10` + `14` → `07`.
