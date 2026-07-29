# 99 — Open Questions

> **Status:** Living register. This file supersedes baseline §30 as the **active** tracker of pending architecture decisions. Resolved items stay here for audit. Rule: an AI coding agent that hits an open question **requests a decision — never assumes one.** Architectural resolutions land as ADRs (`01-system-architecture/13-adr-log.md`).

## Resolved

| ID | Question | Resolution | Reference |
|---|---|---|---|
| OQ-1 | Identity provider? | **Better Auth** (self-hosted framework behind `IdentityProvider`) | ADR-012 · `09-integrations/better-auth.md` |
| OQ-2 | Primary keyword/SERP data provider? | **DataForSEO** (metrics + SERP), **Firecrawl** (fetch/parse), **Exa** (semantic discovery) | ADR-012 · `09-integrations/` |
| OQ-3 | Exact model per tier? | **Claude Sonnet** (content/code) · **GPT-5** (reasoning/planning) · **Gemini 2.5 Flash** (fast/cheap) · **Grok** (alternative/trends), all via OpenRouter. **DeepSeek excluded by policy.** *Partial: embeddings model still open (OQ-11).* | ADR-013 · `08-ai-platform/model-selection.md` |
| D-1 | Does this documentation describe the existing Python/FastAPI system or a new one? | **Greenfield v2 rewrite on the TypeScript stack** (NestJS · Temporal · BullMQ · OpenRouter · Better Auth · pgvector→Qdrant · R2). The v1 Python implementation in `backend/`+`frontend/` is superseded, not evolved; its four AUDIT.md blockers become v2 requirements. v1 docs archived to `archive/` | ADR-016 · `00-architecture-review.md` §0 |
| D-2 | Is there an Organization tier above Workspace? | **Yes.** Tenancy is `User → Organization → Workspace → Project`. Billing, SSO, roles, and audit resolve at organization level; `tenant_id` remains the workspace-scoped isolation key, with `organization_id` on every workspace-owned aggregate. Decided before schema design precisely because it cannot be retrofitted | ADR-017 · `02-domain-design/organizations.md` |
| D-3 | Who owns media — the Writing Engine or a platform service? | **Split by concern.** `04-platform/media.md` owns storage, transforms, CDN delivery, and the R2 key scheme; the Writing Engine owns *what* asset to generate and why (media specs). Neither duplicates the other | ADR-018 · `04-platform/media.md` |
| D-4 | Status of the AI Council in v2? | **First-class, fully specified** in `08-ai-platform/ai-council.md`: trigger conditions, mandatory model diversity, genuine conflict detection, user-facing disclosure, and a cost budget. Directly closes AUDIT.md §07 ("one model wearing four masks") | ADR-019 · `08-ai-platform/ai-council.md` |
| OQ-25 | Does AI Memory belong to the AI Platform or the Knowledge Platform? | **Resolved: AI Platform.** Memory stores interaction context and personalization and is **never a source of truth**; the Knowledge Platform stores facts, evidence, entities, citations, embeddings, and grounding and **always is**. Memory may never be cited. The Context Builder combines Knowledge + Memory + Workspace + Request context, marking each segment `source_of_truth` or `derived`. The stores are never merged | ADR-026 · `08-ai-platform/ai-memory.md` |
| OQ-23 | Unified Scoring Contract: who computes what, on what scale, who aggregates? The v1 eight-score model had no home in v2 | **Resolved.** A platform-level contract: canonical `Score` object (integer 0–100, higher always better, confidence orthogonal, mandatory explanation); **12 categories, exactly one producer each**; `contractVersion` separated from opaque `algorithmVersion` so algorithms and models change without contract, API, or schema changes; registry-backed reason codes; a gate that consumes scores and never computes them. **No formula, threshold, or weight is defined** — those stay with the engines. HEO superseded by `human_quality` | ADR-021 · `01-system-architecture/14-scoring-contract.md` |

## Open

| ID | Question | Impact | Owner | Status |
|---|---|---|---|---|
| OQ-4 | Default Quality Gate thresholds per content type (YMYL vs general)? | Output quality vs throughput | Content + Architect | Open |
| OQ-5 | Concurrency model: single-author + review vs real-time collaborative editing? | Frontend + data model complexity | Product + Frontend | Open |
| OQ-6 | Future vector database: cutover criteria from pgvector to Qdrant (scale thresholds)? | Knowledge Platform roadmap | Architect + DevOps | Open |
| OQ-7 | Data residency / multi-region requirements for enterprise segments? | Tenancy + deployment topology | Founder | Open |
| OQ-8 | Plagiarism / AI-detection third-party providers, and how estimates are surfaced? | Review Engine accuracy + legal framing | Content + Legal | Open |
| OQ-9 | Retention policy for Evidence Bank and generated media per plan tier? | Storage cost, compliance | DevOps + Legal | Open |
| OQ-10 | Credit pricing model and per-operation credit costs? | Billing, unit economics | Founder | Open |
| OQ-11 | Additional AI providers: embeddings model choice; direct provider SDK fallback if OpenRouter degrades? (DeepSeek remains excluded by policy — not open.) | AI Platform resilience + cost | AI Engineer | Open |
| OQ-12 | Future CMS adapters beyond the seven v1 targets (e.g., Wix, Squarespace, Framer, headless CMSs)? | Publishing Engine roadmap | Product + Backend | Open |
| OQ-13 | Future payment gateways: Razorpay (India) timeline; others per region? | Billing coverage | Founder | Open |
| OQ-14 | Conversions source: GA4 only vs supplementary server-side events? | Analytics accuracy (ROI) | Product + Backend | Open |
| OQ-15 | Planning defaults: auto-approval confidence threshold; revise-loop cap per tier? | Pipeline throughput vs control | Content + Architect | Open |
| OQ-16 | Prompt promotion workflow: who approves template version promotions; eval-set ownership? | AI Platform governance | AI Engineer | Open |
| OQ-17 | Judge model for AI evaluation: which model, panel size, self-preference mitigation, and who owns quarterly human calibration? | Quality gating credibility | AI Engineer + Content | Open |
| OQ-18 | Staging/test data strategy: synthetic-only (current position) vs anonymized production clone for realistic scale testing? | Compliance + load-test fidelity | Architect + Legal | Open |
| OQ-19 | Paging vendor and on-call model: 24×7 vs business-hours SEV1 coverage at launch? | Incident response targets, enterprise commitments | Founder + DevOps | Open |
| OQ-20 | Disaster-recovery tier: single-region PITR (current) vs cross-region warm standby; committed regional-outage RTO? | Cost vs recovery time; enterprise due diligence | Founder + DevOps | Open |
| OQ-21 | Live-provider contract suite and load-test environment: cadence, sizing, and monthly cost ceiling? | CI cost, drift detection | DevOps | Open |
| OQ-22 | **ADR-020 acceptance:** transactional outbox + Redis Streams as the event bus. Proposed and written against in `01-system-architecture/10-event-flow.md`; needs founder acceptance to move to Accepted | Event durability, `13-event-platform/` design | Founder + Architect | Open |
| OQ-24 | Temporal: managed service vs self-hosted at launch? | Deployment topology, cost, data residency | DevOps + Founder | Open |
| OQ-26 | ADR authority as the team grows beyond a single architect: who accepts an ADR? | Governance | Founder | Open |
| OQ-27 | **ADR-022 acceptance:** PostgreSQL 17 + Drizzle ORM + Drizzle Kit, SQL-first, Prisma-compatible core schema. Directed during Phase 3 and written against throughout `03-database/`; needs formal acceptance | Data layer, migrations, ORM | Founder + Architect | Open |
| OQ-28 | **ADR-023 acceptance:** feature flags built in-house rather than a vendor SDK. Build cost vs vendor cost and request-path dependency | Release process, incident mitigation | Founder + Architect | Open |
| OQ-29 | **ADR-024 acceptance:** hierarchical settings resolution with tighten-only keys and run snapshotting | Every configurable behaviour | Architect | Open |
| OQ-30 | **ADR-025 acceptance:** reference-data tables as a second bounded RLS exception class (`plans`, `settings_registry`, `permission_catalogue`, `role_permissions`, `flags`, `flag_rules`) | Tenant-isolation gate integrity | Architect | Open |

## Process

1. Open a question here with impact + owner.
2. Decide; if architectural, record an ADR.
3. Move the row to **Resolved** with the reference. Never delete rows.
