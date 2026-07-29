# ADR Log

> **Status:** v2.0 — complete. The canonical register of architectural decisions. Process, template, and authority: `12-architecture-decisions.md`.
> **Rule:** Accepted records are immutable. Change happens only by supersession.

## Overview

Twenty-eight records. ADR-001 through ADR-013 were established during v1 architecture work and are carried forward with their original reasoning; ADR-014 through ADR-028 were decided during the v2 documentation build. Every binding constraint in this documentation traces to one of these.

## Index

| ADR | Decision | Status | Enforced by |
|---|---|---|---|
| 001 | Engines over agents | Accepted | Review; folder structure |
| 002 | Monorepo, modular monolith | Accepted | Import-boundary lint |
| 003 | NestJS backend | Accepted | — |
| 004 | Temporal for the pipeline, BullMQ for jobs | Accepted | Replay tests |
| 005 | PostgreSQL as system of record | Accepted | — |
| 006 | pgvector first, Qdrant at scale | Accepted | Scaling triggers |
| 007 | Multi-tenancy via shared DB + RLS | Accepted | `rls_coverage` CI gate |
| 008 | Central AI Gateway with policy router | Accepted | Import-boundary lint |
| 009 | Quality gates + Explainability Envelope | Accepted | Contract tests; eval harness |
| 010 | Providers behind stable interfaces | Accepted | Import-boundary lint |
| 011 | Planning and Review as first-class engines; Review precedes SEO | Accepted | Pipeline definition |
| 012 | Formal Provider Layer with named providers | Accepted | Import-boundary lint |
| 013 | Concrete model matrix via OpenRouter; DeepSeek excluded | Accepted | Router policy; lint |
| 014 | Testing and evaluation stack | Accepted | CI gate contract |
| 015 | Release process | Accepted | Pipeline configuration |
| 016 | Greenfield v2 on TypeScript | Accepted | — |
| 017 | Organization above Workspace | Accepted | Schema + RLS tests |
| 018 | Media split | Accepted | Context map; review |
| 019 | AI Council as a specified component | Accepted | Council diversity assertion; eval |
| 020 | Transactional outbox + Redis Streams bus | **Accepted** | Outbox lag monitor; publish signature |
| 021 | Unified Scoring Contract | **Accepted** | Category registry; contract tests; `CHECK` constraints |
| 022 | PostgreSQL 17 + Drizzle ORM | Proposed | `migration_lint`; schema review |
| 023 | Feature flags built in-house, config-backed | Proposed | No provider SDK on the request path |
| 024 | Hierarchical settings resolution | Proposed | Single resolver; import lint on direct layer reads |
| 025 | Reference-data tables as a bounded RLS exception class | Proposed | `rls_coverage` gate allowlist categories |
| 026 | AI Memory in the AI Platform; never a source of truth | **Accepted** | Provenance marking in ContextPackage; citation enforcement |
| 027 | Durable Dead Letter Queue | **Accepted** | `dead_letter_events` CHECK constraints; DLQ depth alerts |
| 028 | Replay Coordination | **Accepted** | Partial unique index on active runs; estimate-before-start |

---

### ADR-001 — Engines over agents

- **Status:** Accepted · **Date:** 2026-07 · **Deciders:** Architect
- **Context:** The source material modeled every capability as an autonomous AI "agent." Agent-centric decomposition makes ownership, testing, cost attribution, and scaling boundaries ambiguous, because responsibility follows a conversation rather than a capability.
- **Decision:** Decompose by **business capability (Engine)**. AI is a component inside an engine, accessed through the AI Platform. Multi-model collaboration is a bounded pattern (AI Council, ADR-019), not the primary structure.
- **Alternatives considered:** Agent-per-capability with a supervisor — rejected for untestability and unpredictable cost; a single monolithic generation service — rejected because lifecycle stages have genuinely different inputs, providers, and quality bars.
- **Consequences:** Clear ownership and blast radius; every stage independently testable and scalable. Costs: more explicit wiring than an agent framework, and multi-model behavior must be deliberately designed rather than emergent.
- **Affects:** `05-content-platform/`, `04-context-map.md`, `05-glossary.md` (the term "agent" is banned).

### ADR-002 — Monorepo, modular monolith

- **Status:** Accepted · **Date:** 2026-07 · **Deciders:** Architect
- **Context:** Small team, many bounded contexts, shared types, and no near-term need for independent deployment cadence.
- **Decision:** One monorepo with `apps/`, `packages/`, `infra/`, `tooling/`. Layers are logical and enforced by lint; several deploy in one process at v1.
- **Alternatives considered:** Microservices from day one — rejected as premature operational cost; polyrepo — rejected for type-sharing friction.
- **Consequences:** Atomic cross-cutting changes, one CI pipeline, shared contracts. Costs: discipline required to prevent boundary erosion, hence mandatory import lint; and a large repository that must stay fast to build.
- **Affects:** `07-development-guide/folder-structure.md`, `07-c4-container.md`.

### ADR-003 — NestJS backend

- **Status:** Accepted · **Date:** 2026-07 · **Deciders:** Architect
- **Context:** TypeScript backend with a module-per-capability structure, DI for testability, and clear boundaries for AI-generated code.
- **Decision:** NestJS for all backend services.
- **Alternatives considered:** Fastify with hand-rolled structure — more freedom, less enforced structure; the framework's opinions are a feature when much code is agent-generated.
- **Consequences:** Modules map 1:1 to engines; DI makes the core/shell split natural. Costs: decorator-heavy idiom and a learning curve for contributors from other ecosystems.
- **Affects:** `07-c4-container.md`, `08-c4-component.md`, `07-development-guide/coding-standards.md`.

### ADR-004 — Temporal for the pipeline, BullMQ for jobs

- **Status:** Accepted · **Date:** 2026-07 · **Deciders:** Architect
- **Context:** The content pipeline runs for minutes to days, includes human approval waits, must survive deploys and crashes, and must never double-charge on retry. The v1 system tied run lifetime to an HTTP connection and lost work on every deploy (`archive/ARCHITECTURE.md`).
- **Decision:** **Temporal** for the pipeline — durable state, retries, timers, signals, crash-safe resume. **BullMQ** for fire-and-forget and scheduled jobs.
- **Alternatives considered:** BullMQ alone — no durable human waits or resumption; LangGraph — orchestration coupled to an AI framework, weaker operational maturity; database-backed state machine — reimplementing Temporal badly.
- **Consequences:** Runs resume from the last durable step; approval waits cost zero compute. Costs: a stateful control-plane service to operate, workflow determinism constraints, and mandatory replay testing.
- **Affects:** `07-c4-container.md`, `13-event-platform/`, `10-testing/integration-testing.md`.

### ADR-005 — PostgreSQL as system of record

- **Status:** Accepted · **Date:** 2026-07 · **Deciders:** Architect
- **Context:** Strongly relational data (organizations, workspaces, articles, revisions, reports, ledger) with strict integrity and audit requirements.
- **Decision:** PostgreSQL is the system of record for all durable business state.
- **Alternatives considered:** Document store — rejected for weak referential integrity on a highly relational model; polyglot persistence from day one — rejected as premature.
- **Consequences:** Transactions, constraints, RLS, and `pgvector` in one system; a single, well-understood backup and restore story. Costs: it becomes the primary scaling constraint, addressed by the documented ladder.
- **Affects:** `03-database/`, `12-storage-platform/postgresql.md`.

### ADR-006 — pgvector first, Qdrant at scale

- **Status:** Accepted · **Date:** 2026-07 · **Deciders:** Architect
- **Context:** Semantic retrieval is required from day one; a dedicated vector database is an additional system to operate, secure, and back up.
- **Decision:** `pgvector` inside the primary database at v1; migrate to Qdrant when documented thresholds are met.
- **Alternatives considered:** Qdrant from day one — better recall at scale, unnecessary operational cost at v1; external hosted vector services — added latency and another tenancy boundary to secure.
- **Consequences:** One fewer system; vectors inherit RLS and PITR automatically. Costs: vector workload contends with transactional load, and a migration is deferred rather than avoided (criteria in `14-operations/scaling-strategy.md` §8; OQ-6).
- **Affects:** `11-knowledge-platform/vector-search.md`, `12-storage-platform/qdrant.md`.

### ADR-007 — Multi-tenancy via shared DB + RLS

- **Status:** Accepted · **Date:** 2026-07 · **Deciders:** Architect
- **Context:** B2B customers require strict isolation; the v1 system enforced scoping in application code and leaked five endpoints (`AUDIT.md`).
- **Decision:** Shared database with `tenant_id` on every table and **PostgreSQL Row-Level Security** enforcing isolation. Tenant context is set per request into the session variable RLS reads. Vector, cache, and object-storage keys are tenant-scoped.
- **Alternatives considered:** Schema-per-tenant — migration complexity at thousands of tenants, retained as an enterprise option; database-per-tenant — highest isolation and highest operational cost, reserved for regulated or white-label cases.
- **Consequences:** Isolation survives application bugs, because the database refuses the row. Costs: every table must carry the column and policy; RLS predicates must be index-supported at scale; a superuser connection silently bypasses RLS, so test and runtime roles are constrained.
- **Affects:** `03-database/`, `16-security/`, `10-testing/integration-testing.md` (`rls_coverage` gate).

### ADR-008 — Central AI Gateway with policy router

- **Status:** Accepted · **Date:** 2026-07 · **Deciders:** Architect
- **Context:** Thirteen engines need model access. Direct provider calls would scatter keys, retries, costs, and safety controls beyond any possibility of governance.
- **Decision:** All AI requests pass through one **AI Gateway**, which resolves prompts, assembles context, applies guardrails, checks the semantic cache, delegates model choice to a **policy Model Router**, meters cost, and emits `CreditConsumed`. No module calls a provider directly.
- **Alternatives considered:** A shared client library — no central enforcement, drift inevitable; per-engine integration — the failure mode this decision exists to prevent.
- **Consequences:** Cost, routing, caching, guardrails, and evaluation become tractable; routing changes without a deploy. Costs: one indirection hop, and the Gateway is the platform's hottest service and a single point of failure — mitigated by statelessness and horizontal scaling.
- **Affects:** `08-ai-platform/`, `09-integrations/openrouter.md`, import-boundary lint.

### ADR-009 — Quality gates and the Explainability Envelope

- **Status:** Accepted · **Date:** 2026-07 · **Deciders:** Architect + Content
- **Context:** Generated content cannot be trusted by default. v1 shipped a fact-checker that accepted fabricated sources via regex, laundering invention into apparent verification (`AUDIT.md` §00).
- **Decision:** Content passes measured **Quality Gates** with verdicts `pass` / `soft-warn` / `block` before advancing. Every recommendation the platform surfaces carries an **Explainability Envelope**: `{ recommendation, reason, evidence[], expected_impact, confidence }`. A claim is supported only if it resolves to Evidence Bank content through the Citation Engine.
- **Alternatives considered:** Advisory scoring without gating — rejected, because a score nobody enforces changes no outcome; human review of everything — does not scale and is not what customers buy.
- **Consequences:** Grounding is structural rather than aspirational; users can audit any recommendation. Costs: throughput reduced by blocked content, thresholds must be tuned per content type (OQ-4), and every recommendation-producing code path carries the envelope obligation.
- **Affects:** `05-content-platform/review-engine.md`, `11-knowledge-platform/citation-engine.md`, `10-testing/ai-evaluation.md`.

### ADR-010 — Providers behind stable interfaces

- **Status:** Accepted · **Date:** 2026-07 · **Deciders:** Architect
- **Context:** Every external dependency changes pricing, limits, or contracts eventually; some disappear.
- **Decision:** Every external capability is consumed through a domain-owned interface (`KeywordDataProvider`, `ModelProvider`, `PublishTarget`, …). Only adapter packages import vendor SDKs, and vendor types never cross inward.
- **Alternatives considered:** Direct SDK use with the intent to abstract later — abstraction after the fact is always more expensive and rarely happens.
- **Consequences:** Vendor swaps are localized; every provider gets uniform timeout, retry, circuit-breaker, and rate-limit policy; tests can replay recorded responses. Costs: one mapping layer per provider, and the discipline not to leak convenient vendor fields upward.
- **Affects:** `09-integrations/README.md`, `04-context-map.md` (anti-corruption layer).

### ADR-011 — Planning and Review as first-class engines; Review precedes SEO

- **Status:** Accepted · **Date:** 2026-07 · **Deciders:** Architect + Content
- **Context:** The original pipeline moved from Research to Writing, with no planning stage and quality checks applied after SEO optimization.
- **Decision:** **Planning** and **Review** become first-class engines. Pipeline order places **Review before SEO**, so structural optimization applies only to content that has already passed quality; SEO's structural changes trigger a fast re-validation of readability and citation integrity before Publishing.
- **Alternatives considered:** Planning inside Writing — produces generic, evidence-thin content and wastes premium tokens on unfocused drafts; Review after SEO — optimizes content that may then be rejected, wasting the work.
- **Consequences:** Writing becomes execution rather than exploration; only gate-passed content is optimized. Costs: two more pipeline stages and an additional human checkpoint.
- **Affects:** `05-content-platform/planning-engine.md`, `review-engine.md`, `seo-engine.md`.

### ADR-012 — Formal Provider Layer with named providers

- **Status:** Accepted · **Date:** 2026-07 · **Deciders:** Founder + Architect
- **Context:** ADR-010 established the pattern; the concrete vendors were still open (OQ-1, OQ-2).
- **Decision:** The Provider Layer is a named architectural layer. v1 providers: **OpenRouter** (models), **DataForSEO** (keywords, SERP), **Firecrawl** (fetch/parse), **Exa** (semantic discovery), **Better Auth** (identity), **Stripe** (payments), **Google Search Console** and **GA4** (performance), plus CMS publish targets.
- **Alternatives considered:** Multiple redundant data vendors from day one — cost and integration burden before there is evidence of need.
- **Consequences:** Concrete cost model and integration scope; per-provider documentation with auth, limits, retries, and response mapping. Costs: single-vendor dependency per capability, with OpenRouter the most consequential (OQ-11).
- **Affects:** `09-integrations/`, `06-c4-context.md`.

### ADR-013 — Concrete model matrix via OpenRouter; DeepSeek excluded

- **Status:** Accepted · **Date:** 2026-07 · **Deciders:** Founder + AI Engineer
- **Context:** Routing policy needs concrete models per tier; cost and quality vary by an order of magnitude across tiers.
- **Decision:** **Gemini 2.5 Flash** = Fast/Cheap; **Claude Sonnet** = Mid/Content; **GPT-5** = Premium/Reasoning; **Grok** = Alternative voice. All via OpenRouter under the AI Gateway. **DeepSeek is excluded by policy.** Tier assignments are versioned routing policy; exact model identifiers live in config.
- **Alternatives considered:** Single-model simplicity — 3–10× cost for classification and extraction work with no quality gain; direct provider SDKs — more integration surface, less routing flexibility (retained as a fallback path, OQ-11).
- **Consequences:** Cost is steerable per task type; model changes are policy edits. Costs: OpenRouter is a single point of failure for all model access; embeddings remain unresolved (OQ-11).
- **Affects:** `08-ai-platform/model-selection.md`, `model-router.md`.

### ADR-014 — Testing and evaluation stack

- **Status:** Accepted · **Date:** 2026-07-28 · **Deciders:** Architect
- **Context:** Three properties resist conventional testing: tenant isolation must be proven against a real database, durable workflows must be proven against real time-skipping execution, and model output is non-deterministic.
- **Decision:** **Vitest** (unit), **Testcontainers** with real PostgreSQL and Redis (integration), the **Temporal test environment** (workflow replay and time skipping), **Playwright** (E2E), **k6** (load), and a custom **evaluation harness** gating prompt promotion. A CI **gate contract** defines exactly which checks block a merge and a deploy, including a mandatory per-table RLS isolation test.
- **Alternatives considered:** Jest — heavier monorepo configuration and slower cold start; mocked databases for integration tests — proves nothing about RLS, which is the property most worth proving.
- **Consequences:** Isolation and idempotency become build-time guarantees; quality regressions are caught before promotion. Costs: integration suites need containers, and evaluation runs consume real tokens with a budget ceiling.
- **Affects:** `10-testing/`, CI configuration.

### ADR-015 — Release process

- **Status:** Accepted · **Date:** 2026-07-28 · **Deciders:** Architect
- **Context:** Deploys occur while workflows are days into execution, jobs are mid-retry, and SSE connections are open. A naive stop-migrate-start breaks all three.
- **Decision:** Build once and promote the same digest; **expand → backfill → contract** migrations across three releases so the previous version always runs against the current schema; feature flags decouple deploy from release; workers drain rather than terminate; post-deploy verification failure triggers **automatic rollback** within 10 minutes.
- **Alternatives considered:** Maintenance windows — unacceptable for a global product; in-place breaking migrations — makes rollback impossible, which is the whole point of the design.
- **Consequences:** Every deploy is reversible; zero-downtime schema evolution. Costs: schema changes span three releases, and contract migrations require discipline to actually land.
- **Affects:** `14-operations/deployment.md`, `03-database/migrations.md`.

### ADR-016 — Greenfield v2 on TypeScript

- **Status:** Accepted · **Date:** 2026-07-28 · **Deciders:** Founder + Architect
- **Context:** A working v1 exists — Python/FastAPI backend, Next.js frontend, ~33k LOC, deployed. Two audits found it structurally unable to become multi-tenant SaaS without redesign: run state coupled to the HTTP connection, application-level tenant scoping that leaked five endpoints, plaintext CMS credentials, a fact-checker accepting fabricated sources by regex, and no payment path (`archive/ARCHITECTURE.md`, `AUDIT.md`).
- **Decision:** Build **v2 greenfield on the TypeScript stack** defined in this documentation. v1 is superseded, not evolved. Its four blockers become explicit v2 acceptance criteria. v1 documents are archived; the codebase remains operational until v2 replaces it.
- **Alternatives considered:** Incremental hardening of v1 — the foundational faults (run durability, tenancy model) require rewriting the core anyway, and a language split across the platform would double the toolchain permanently; hybrid Python core with TypeScript edges — doubles testing, deployment, and hiring surface for no architectural gain.
- **Consequences:** One language across web, API, workers, and contracts; durability and isolation designed in rather than retrofitted. Costs: substantial rebuild effort, a migration path required for existing customers and data, and two systems operating in parallel during transition.
- **Affects:** every document; `archive/`.

### ADR-017 — Organization above Workspace

- **Status:** Accepted · **Date:** 2026-07-28 · **Deciders:** Founder + Architect
- **Context:** The baseline modeled tenancy as workspace-only. Agencies need one commercial entity owning many isolated client workspaces; enterprises need SSO, roles, and audit above the workspace. Adding this tier after schema design means touching every table, every RLS policy, and every isolation test.
- **Decision:** Tenancy is **User → Organization → Workspace → Project**. The **organization** owns billing, subscription, SSO, org-level roles, and audit aggregation. The **workspace** remains the isolation boundary: `tenant_id` is the workspace identifier and the RLS key. `organization_id` is carried on workspace-owned aggregates for org-scoped queries without cross-tenant joins.
- **Alternatives considered:** Workspace-only with an "agency" flag — cannot express org-level billing or SSO without special cases everywhere; organization as the RLS key — too coarse, since client data within an agency must be separable.
- **Consequences:** Agency and enterprise segments are addressable at launch; billing and identity resolve at the right level. Costs: two identifiers on most tables, a two-level role model, and permission resolution that must union org-level and workspace-level roles.
- **Affects:** `02-domain-design/organizations.md`, `03-database/`, `04-platform/`, `16-security/rbac.md`.

### ADR-018 — Media split

- **Status:** Accepted · **Date:** 2026-07-28 · **Deciders:** Architect
- **Context:** Media generation was claimed by both the Writing Engine (media specs) and a platform media service (storage, transforms, CDN), with a "future Media Engine" noted separately — three partial owners.
- **Decision:** Split by concern. **Authoring owns generation intent**: what asset is needed, why, its purpose, placement, and alt text (`MediaSpec`). **The Platform Layer owns the asset**: generation dispatch, storage, transforms, optimization, CDN delivery, and the R2 key scheme. Neither duplicates the other.
- **Alternatives considered:** A single Media Engine owning intent and storage — mixes an editorial decision with an infrastructure concern and pulls storage policy into the content pipeline; keeping everything in Writing — makes media unusable outside article production.
- **Consequences:** Media becomes reusable across content types and surfaces; storage policy, retention, and CDN behavior evolve independently of editorial logic. Costs: two documents must stay coherent about one user-visible feature.
- **Affects:** `04-platform/media.md`, `05-content-platform/writing-engine.md`, `04-context-map.md`.

### ADR-019 — AI Council as a specified component

- **Status:** Accepted · **Date:** 2026-07-28 · **Deciders:** Founder + Architect
- **Context:** Multi-model deliberation is the differentiator inherited from v1, but the v1 implementation was frequently one model wearing four masks, with manufactured rather than detected conflicts and no disclosure to the user (`AUDIT.md` §07). ADR-001 also demotes agent-style collaboration as a decomposition strategy.
- **Decision:** The **AI Council** is a first-class, fully specified component of the AI Platform — not a decomposition strategy. It is invoked for a bounded set of high-value decisions, and it must: enforce **model diversity** (participants come from genuinely different model families, verified at dispatch); perform **real conflict detection** on substantive disagreement rather than synthesizing debate; **disclose** participants and disagreements to the user; and operate under an explicit **cost budget** with a fallback to single-model execution when the budget or diversity requirement cannot be met.
- **Alternatives considered:** Drop the Council — simpler and cheaper, but discards a genuine quality mechanism for hard judgments; keep it unspecified — recreates the v1 theatre, which is worse than not having it because it misleads the user.
- **Consequences:** Deliberation is real and auditable, or it does not run. Costs: council calls are the platform's most expensive AI operation, so trigger conditions must stay narrow; diversity enforcement means a provider outage can disable the Council, which must degrade gracefully and visibly.
- **Affects:** `08-ai-platform/ai-council.md`, `05-content-platform/review-engine.md`, `10-testing/ai-evaluation.md`.

### ADR-020 — Transactional outbox + Redis Streams event bus

- **Status:** **Proposed** · **Date:** 2026-07-28 · **Deciders:** Architect (pending founder acceptance)
- **Context:** The baseline claimed at-least-once delivery, per-aggregate ordering, and dead-letter queues without naming a bus or addressing the dual-write problem. Writing state to PostgreSQL and then publishing to a bus can produce a committed state change with no event, or an event for a rolled-back transaction. Both corrupt downstream state silently, and the lifecycle loop that defines the product depends on events never being lost.
- **Decision:** Producers write a **transactional outbox row inside the same transaction as the state change**. An **Outbox Relay** publishes committed rows to **Redis Streams** (one stream per event type, consumer groups per subscriber). Consumers deduplicate by `eventId` against a `processed_events` table, giving exactly-once effect. The bus sits behind an `EventBus` interface so Kafka or NATS can replace Redis Streams at S3 scale without producer or consumer changes.
- **Alternatives considered:** Direct publish after commit — the dual-write problem, rejected outright; Redis pub/sub — no durability or replay, a consumer restart loses events; BullMQ as the bus — a job queue, not a topic, so independent fan-out to multiple consumer groups is awkward; Kafka at v1 — correct at scale, unjustified operational cost below S3.
- **Consequences:** An event exists if and only if its transaction committed; Redis becomes transport rather than truth, so stream loss is recoverable by republishing from the outbox. Costs: publication latency of up to ~2 seconds; an outbox table that must be pruned and indexed; a relay process to operate; and consumers that must implement idempotency rather than assume it.
- **Affects:** `10-event-flow.md`, `13-event-platform/`, `03-database/tables.md`, `07-c4-container.md`.

### ADR-021 — Unified Scoring Contract

- **Status:** **Accepted** · **Date:** 2026-07-28 · **Deciders:** Founder (commissioned) + Architect
- **Context:** Five engines measure content quality — Review, SEO, Optimization, Refresh, Analytics — and nothing prevented each from inventing its own score structure. The v1 system's eight scores (SEO/AEO/GEO/HEO/EEAT/Fact/Spam/Publish) had no home in v2, and `00-architecture-review.md` §W5 identified scoring ownership as unassigned. Phases 2–4 were written around the gap: `02-domain-design/articles.md` fixed the *shape* of a score (0–100 with confidence) and deliberately left computation unassigned; `02-domain-design/analytics.md` restricted Optimization to measured metrics only; `03-database/tables.md` constrained the range without defining semantics. The gap blocked Phase 5, because four engine documents could not be written without inventing the model they share.
- **Decision:** Adopt a **Unified Scoring Contract** — a platform-level contract that every engine producing or consuming a quality measure must speak. Specification: `14-scoring-contract.md`. Its load-bearing elements: a canonical `Score` object (integer 0–100, higher always better, confidence orthogonal to value, mandatory explanation); **twelve canonical categories with exactly one producer each**; separation of **`contractVersion`** (stable, owned by the contract) from **`algorithmVersion`** (opaque, owned by the producer) so algorithms and models change without touching APIs, schema, or consumers; registry-backed reason codes rather than free prose; a gate interface that consumes scores and never computes them; and an `inputsDigest` validity rule that makes caching decidable without knowledge of any algorithm. The contract defines **no formula, threshold, weight, heuristic, or model reference**.
- **Alternatives considered:** Per-engine score schemas — the status quo this replaces; guarantees incommensurable scales, a gate that compares numbers meaning different things, and no cross-engine trend analysis. A single monolithic quality score — loses the diagnostic value that makes recommendations actionable, and forces one weighting on every content type. Deferring until engines are built — every engine would ship a schema, and unification afterwards would be a breaking migration across five engines, the API, and the UI.
- **Consequences:** Every quality measure is comparable, explainable, cacheable, and versioned; a model or algorithm replacement is an `algorithmVersion` bump with no downstream change; new categories are additive; the v1 eight-score model is absorbed with `human_quality` superseding HEO. Costs: producers must emit `not_applicable` rather than omitting categories they own; consumers must tolerate unknown categories; two registries (categories, reason codes) must be maintained alongside code; and `analyzer_reports` requires an additive expand/contract migration, including a `confidence` unit change from `NUMERIC 0–1` to integer 0–100.
- **Affects:** `14-scoring-contract.md`, `05-glossary.md`, `02-domain-design/articles.md`, `02-domain-design/analytics.md`, `03-database/tables.md`, `03-database/migrations.md`, `04-platform/settings.md`, `04-platform/templates.md`, all of `05-content-platform/`, `10-testing/ai-evaluation.md`, `06-api/`.

### ADR-022 — PostgreSQL 17 and Drizzle ORM

- **Status:** **Proposed** · **Date:** 2026-07-28 · **Deciders:** Founder (directed) + Architect
- **Context:** ADR-005 chose PostgreSQL as the system of record but fixed neither a major version nor an ORM. Phase 3 cannot specify a schema without both: the version determines which features are available to the schema (native `uuidv7()`, vacuum behaviour, TOAST compression), and the ORM determines where constraints, RLS, and partitioning are expressed.
- **Decision:** Target **PostgreSQL 17**. Use **Drizzle ORM** as the primary data-access layer and **Drizzle Kit** for migrations, SQL-first — generated SQL is reviewed, edited, and committed, never applied unread. Keep the core entity schema **Prisma-compatible** as a design constraint: no feature in the ORM-facing schema that Prisma cannot introspect without `Unsupported` fallbacks. Advanced features — RLS policies, partitioning, `pgvector` operators, partial unique indexes, JSONB `CHECK` constraints — live in raw SQL migrations, which is where they belong under any ORM.
- **Alternatives considered:** Prisma as primary — better ecosystem maturity, but its migration engine handles raw-SQL features and partitioning poorly, and this schema depends heavily on both; TypeORM — weaker type inference and a heavier runtime; raw SQL with a query builder only — maximum control, but loses the compile-time type inference that makes agent-generated data access safe. PostgreSQL 16 — viable, but 17's vacuum memory management and B-tree multi-value lookups apply directly to this schema's largest append-only tables.
- **Consequences:** One type source for the application, one SQL source for the schema, and no ORM abstraction obscuring the constraints that carry the platform's invariants. Costs: two artifacts to keep aligned (Drizzle schema and SQL migrations); Prisma compatibility is a constraint on the core tables that must be checked, not assumed; and Drizzle's ecosystem is younger than Prisma's, so tooling gaps may need filling.
- **Affects:** `03-database/` (all four documents), `07-development-guide/coding-standards.md`, `packages/db`.

### ADR-023 — Feature flags built in-house, config-backed

- **Status:** **Proposed** · **Date:** 2026-07-28 · **Deciders:** Architect
- **Context:** ADR-015 decouples deploy from release using feature flags, and `14-operations/incident-response.md` makes "disable the flag" the first mitigation step in every playbook. Neither specified where flags live. Flag evaluation sits on every request path, so the choice determines whether an external dependency can degrade every request in the platform.
- **Decision:** Build flags in-house, backed by PostgreSQL, published to Redis, and cached in-process with a 5-second TTL. Three flag kinds are distinguished — release, operational (kill switches), and entitlement (derived from Billing, never hand-set). Evaluation performs **no I/O** and fails to the call site's code default, never to an exception. Kill switches take precedence over all other rules.
- **Alternatives considered:** A vendor SDK (LaunchDarkly, Flagsmith) — mature targeting and UI, but adds a third-party dependency to every request, sends tenant identifiers externally, and prices per seat; environment variables — no runtime change without a deploy, which defeats the purpose.
- **Consequences:** No external dependency on the request path, no customer data leaving the platform, full audit in our own log, and no per-seat cost as the platform grows. Costs: we build targeting and the admin surface ourselves, and flag lifecycle hygiene (owners, `retire_by` dates, stale-flag alerts) becomes our responsibility rather than a vendor's.
- **Affects:** `04-platform/feature-flags.md`, `14-operations/deployment.md`, `14-operations/incident-response.md`.

### ADR-024 — Hierarchical settings resolution

- **Status:** **Proposed** · **Date:** 2026-07-28 · **Deciders:** Architect
- **Context:** ADR-017 established `Organization → Workspace → Project`, and Phase 2 placed configuration at all three levels — organization plan ceilings, workspace gate thresholds and brand voice, project defaults. Nothing specified precedence. Without one owner, every consumer would implement its own resolution, and the pipeline and the UI displaying it would diverge on edge cases.
- **Decision:** A single Settings Service owns precedence, validation, and resolution. Most specific scope wins; a **key registry** declares each key's type, minimum scope, default, range, and whether lower scopes may override it; **tighten-only** keys (gate thresholds, approval requirements) may be narrowed but never loosened, validated against the resolved parent value; resolved settings are **snapshotted at pipeline-run start** so a mid-run change cannot alter a run's behaviour or its verdict; resolved responses carry **provenance** — which scope supplied each value.
- **Alternatives considered:** Precedence implemented per consumer — guarantees divergence; flat per-scope configuration with no inheritance — forces agencies to re-enter policy per client workspace; a normalized key-value table per scope — turns one settings read into three joins on a path that runs at every pipeline start.
- **Consequences:** One definition of effective configuration; support can answer "why is this article requiring approval?" from provenance; compliance controls cannot be weakened from below. Costs: a registry to maintain alongside the code that uses it, and cache invalidation that must cascade to all scopes beneath a change.
- **Affects:** `04-platform/settings.md`, `04-platform/workspaces.md`, `04-platform/projects.md`, `04-platform/organizations.md`, `05-content-platform/review-engine.md`.

### ADR-025 — Reference-data tables as a bounded RLS exception class

- **Status:** **Proposed** · **Date:** 2026-07-28 · **Deciders:** Architect
- **Context:** ADR-007 requires `tenant_id` and an RLS policy on every table, with five named identity exceptions and the rule that a sixth requires an ADR. Phase 4 introduced four tables that are global reference data with genuinely no tenant dimension: `plans`, `settings_registry`, `permission_catalogue`/`role_permissions`, and `flags`/`flag_rules`. Allowlisting them silently would erode the rule that makes the RLS-coverage gate meaningful.
- **Decision:** Define a second, bounded exception class: **global reference data** — tables that are seeded by migration, identical for every customer, contain no customer data, and are read-only to application roles. Members: `plans`, `settings_registry`, `permission_catalogue`, `role_permissions`, `flags`, `flag_rules`. Each is registered in the RLS-coverage allowlist with a written justification and a read-only grant. Membership in this class requires meeting all four criteria, and adding a table to it requires amending this ADR.
- **Alternatives considered:** A synthetic `tenant_id` sentinel — meaningless data and a policy that protects nothing; duplicating reference data per tenant — enormous write amplification for identical rows; leaving them silently allowlisted — the erosion this ADR exists to prevent.
- **Consequences:** The RLS-coverage gate keeps a complete, justified account of every exception, in two named classes rather than an ad-hoc list. Costs: the coverage checker gains a second allowlist category, and a reviewer must verify the four criteria rather than only the identity-boundary argument.
- **Affects:** `03-database/tables.md`, `04-platform/billing.md`, `settings.md`, `permissions.md`, `feature-flags.md`, `10-testing/integration-testing.md`.

### ADR-026 — AI Memory belongs to the AI Platform; never a source of truth

- **Status:** **Accepted** · **Date:** 2026-07-28 · **Deciders:** Founder (directed) + Architect · **Resolves:** OQ-25
- **Context:** Memory shapes generation (an AI Platform concern) and also stores things the system has learned (superficially a Knowledge Platform concern). The ambiguity was recorded as OQ-25 and left open through Phases 1–5. It could not remain open into Phase 6, because the Context Builder must know which sources may support a citation and which may not.
- **Decision:** **AI Memory belongs to the AI Platform.** It stores interaction context and personalization — preferences, prior decisions, voice profiles, rejected suggestions, terminology. The **Knowledge Platform** stores facts, evidence, entities, citations, embeddings, and grounding. **AI Memory is never a source of truth; the Knowledge Platform always is.** A claim may never originate in memory, and memory may never be cited. The **Context Builder** combines four sources — Knowledge Platform, AI Memory, Workspace Context, Request Context — before Prompt Engine execution, marking each segment's provenance as `source_of_truth` or `derived`. The two stores are never merged.
- **Alternatives considered:** Memory in the Knowledge Platform — would place non-provenanced, decaying, inference-adjacent data in the store whose defining property is mandatory provenance, and would make "can this support a citation?" a per-row judgment rather than a structural fact. A single unified store — same defect, plus it would put a customer-correctable preference in the same lifecycle as immutable evidence.
- **Consequences:** The platform's *correctness* has no dependency on memory availability — a memory outage degrades personalization and nothing else, which is why memory is classed as derived and excluded from the authoritative backup set. Poisoned memory can affect tone or angle but **cannot introduce a false claim into grounded content**, because it is structurally uncitable. Costs: two stores to operate; the Context Builder must reconcile four sources under one token budget; and memory must be independently inspectable and correctable by customers, since unexplained personalization is indistinguishable from unpredictable behaviour.
- **Affects:** `08-ai-platform/ai-memory.md`, `08-ai-platform/context-builder.md`, `11-knowledge-platform/`, `14-operations/backup-recovery.md` §3.1.

### ADR-027 — Durable Dead Letter Queue

- **Status:** **Accepted** · **Date:** 2026-07-29 · **Deciders:** Founder (accepted) + Architect · **Full record:** `ADR-027-durable-dead-letter-queue.md`
- **Context:** ADR-020 guarantees an event exists if and only if its transaction committed; it does not say what happens when an event that exists cannot be delivered. Two surfaces produce permanently undeliverable events: publish-side, where a poison row blocks the relay's ordered claim and one bad row becomes a platform-wide outage; and delivery-side, where a handler fails terminally or exhausts retry. Without a defined destination both reduce to retry-forever or drop, and drop violates the platform's hardest rule.
- **Decision:** Every permanently undeliverable event becomes a durable, inspectable, replayable record in **PostgreSQL** — `dead_letter_events`, workspace-owned and RLS-protected. Publish-side quarantine after `publish_attempts` exceeds threshold keeps the relay alive. Every record retains `correlationId`, producer, consumer group, failure reason, complete retry history, and the **byte-identical payload**. **Discard requires a named actor and a reason**, enforced by CHECK constraint, and is never automatic. **There is no delete operation.** Quarantined records are never auto-deleted; resolved and discarded records are retained 90 days.
- **Alternatives considered:** A Redis DLQ stream — entries must survive eviction and sit for weeks, and a stream cannot be queried by correlation, code, or age; drop after N retries — violates the no-silent-loss rule outright; retry forever — blocks the relay or burns budget while hiding the signal; reuse `outbox_events` with a status column — a dead letter is a `(event, consumer_group)` fact and the outbox has no such dimension.
- **Consequences:** No event is silently discarded on any path; a poison row cannot block the relay; failures are triageable by cause, correlation, and age. Costs: one additive table; **operator attention is required**, since a growing DLQ is an incident rather than a capacity problem; consumers stop acknowledging if the DLQ is unavailable, converting a DLQ outage into delivery backpressure.
- **Affects:** `13-event-platform/dead-letter-queue.md`, `retry-engine.md`, `transactional-outbox.md`, `06-api/admin-api.md`.

### ADR-028 — Replay Coordination

- **Status:** **Accepted** · **Date:** 2026-07-29 · **Deciders:** Founder (accepted) + Architect · **Full record:** `ADR-028-replay-coordination.md`
- **Context:** ADR-020 makes events durable and ADR-027 makes failures recoverable; both create the obligation that something must be able to re-deliver. Replay is the most dangerous capability in the platform because it re-delivers real events to real consumers with real side effects. The failure mode is not "replay does not work" but "replay worked, on more consumers than intended" — an operator rebuilding one projection who also re-delivers to the notification consumer sends customers a week of duplicate emails, which no idempotency check can retract.
- **Decision:** Replay is a **privileged, scoped, estimated, checkpointed** operation that reads from **PostgreSQL, never the bus** — Redis trims after seven days, so replaying from a stream produces a silently partial rebuild. `targetGroups` is **required and non-empty**; there is no broadcast and no way to express one. **Estimation precedes execution** and is enforced. **Registry validation is re-run on every replayed event** and cannot be bypassed. **Idempotency is the sole duplicate defence** — replay adds no special-case suppression. A run holds an exclusive coordination token per target group, enforced by a partial unique index. Replay is operator-only; customers get visibility, not control.
- **Alternatives considered:** Replay from the bus — trimmed retention produces silently partial rebuilds; broadcast with per-consumer opt-out — fails open, and a consumer that forgot to opt out receives duplicates; replay-specific duplicate suppression — a second mechanism alongside idempotency, and the less-exercised one is the one that is wrong; automatic replay on drift detection — removes the human judgment that scopes the operation; in-place truncate-and-replay — leaves customers reading empty data for the rebuild's duration.
- **Consequences:** Projections rebuild without downtime; consumer bugs are recoverable across full history; DLQ entries are deliverable long after the failure; erased tenants are never resurrected. Costs: replay requires an operator, with no self-service path; **`outbox_events` retention bounds how far back a rebuild can reach**, so drift older than the window requires a backup restore; handlers must be idempotent and must use `originalOccurredAt`; targeted replay is out of order by definition.
- **Affects:** `13-event-platform/replay.md`, `idempotency.md`, `ordering.md`, `dead-letter-queue.md`, `06-api/admin-api.md`.

## Cross References

- `12-architecture-decisions.md` — process, template, authority, and agent obligations
- `99-open-questions.md` — pending decisions, including those these ADRs partially resolve
- `00-architecture-review.md` — the review that produced ADR-016 through ADR-020
- `AUDIT.md` · `archive/ARCHITECTURE.md` — the v1 evidence behind ADR-009, ADR-016, and ADR-019

## Open Questions

- **ADR-020 was accepted on 2026-07-29** and is recorded above. ADR-021 was accepted on 2026-07-28. Both entries that previously appeared here as pending have been resolved.
- **Four records remain Proposed:** ADR-022 (PostgreSQL 17 + Drizzle ORM), ADR-023 (feature flags in-house), ADR-024 (hierarchical settings resolution), and ADR-025 (reference-data tables as a bounded RLS exception class). Each is recorded in `99-open-questions.md`, and the documentation is written against them as working assumptions.
