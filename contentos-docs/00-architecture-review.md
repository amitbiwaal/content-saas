# Architecture & Documentation Review

> **Status:** Review artifact, 2026-07-28. One-time deliverable produced before the documentation refactor. Not part of the canonical tree — archive it once the refactor is executed.
> **Method:** Full read of `contentos-docs/` (27 complete docs, 34 placeholders), the 88 KB baseline `ARCHITECTURE_BASELINE_ARCHIVE.md`, the six legacy root documents, and the repository itself (`backend/`, `frontend/`, `render.yaml`).
> **Mandate:** challenge every architectural decision; do not assume the current documentation is correct.

---

## 0. Headline finding

**The documentation does not describe the system that exists.** It describes a different product, in a different language, on a different runtime — and no document in the tree acknowledges this.

| | Documented architecture (`contentos-docs/`, baseline §27) | What is actually in this repository |
|---|---|---|
| Backend | NestJS + TypeScript monorepo | Python / FastAPI / SQLAlchemy 2.0 / Alembic (`backend/app`) |
| Orchestration | Temporal durable workflows + BullMQ | Daemon thread + `asyncio.Queue`, later a detached background worker (`pipeline/hub.py`) |
| AI access | AI Gateway → OpenRouter → Claude Sonnet / GPT-5 / Gemini 2.5 Flash / Grok | Direct provider SDKs per "council seat" (`app/providers/registry.py`) |
| Product model | 11 sequential **Engines**, AI is a component inside them (ADR-001) | **Four-model council debates → Judge reconciles → 8 scores → publish gate** |
| Data providers | DataForSEO + Firecrawl + Exa | Ahrefs-leaning research adapter (BUILD-PLAN), mock path |
| Identity | Better Auth | Hand-rolled stdlib pbkdf2 + HS256 JWT |
| Tenancy | Shared DB + PostgreSQL RLS, `tenant_id` everywhere | `owner_id` scoping, partially missing (AUDIT.md: five endpoints leaked cross-tenant) |
| Vectors / storage | pgvector → Qdrant, Cloudflare R2 | SQLite/Postgres only |
| Deploy | Coolify → Kubernetes | Render (`render.yaml`) |

Two independent audits of the **real** system exist in this repo — `ARCHITECTURE.md` (2026-07-16, grade B−) and `AUDIT.md` (2026-07-28, 4.9/10, four launch blockers). Neither is referenced anywhere in `contentos-docs/`.

**Consequence.** The stated goal is "Claude Code generates the production application from these documents." Executed literally, that produces a **second, incompatible product in TypeScript** alongside 33,000 lines of working Python — not an evolution of it. That may be exactly the intent (a deliberate v2 rewrite), but it is currently an *implicit* decision, and it is the single highest-cost assumption in the entire plan.

**Recommendation:** record it explicitly as **ADR-016 — Greenfield v2 rewrite on the TypeScript stack, superseding the Python MVP**, with a stated migration position for existing customers, data, and the four AUDIT.md blockers. Until that ADR exists, every downstream document rests on an unstated premise. This is decision **D1** in §9.

---

## 1. Architecture weaknesses

**W1 — Tenancy model cannot express the stated customer segments.** Baseline §21 defines tenancy as a single `tenant_id` = workspace. The vision requires `User → Workspace → Organization → Projects`, and the target segments include agencies and enterprises. An agency needs one organization owning many client workspaces, with billing, SSO, roles, and audit at the **org** level. Retrofitting an `organization_id` above `tenant_id` after `03-database/tables.md` is written means touching every table, every RLS policy, and every isolation test. **This must be decided before the schema is written** (decision D2).

**W2 — The event bus is claimed but never chosen.** Baseline §18 specifies producers, consumers, at-least-once delivery, per-aggregate ordering, and dead-letter queues — without ever naming the technology. Redis pub/sub (implied by the stack) does not provide durability or replay; BullMQ is a job queue, not an event log. Worse, **no outbox pattern is documented**, so "at-least-once" is unbacked: writing to PostgreSQL and publishing to the bus is a dual write that can fail between the two. `13-event-platform/` must resolve this (recommendation: transactional outbox in PostgreSQL + relay to BullMQ at v1, with a documented path to Kafka/NATS at S3 scale).

**W3 — CQRS and DDD are stated as principles but applied nowhere.** There is no bounded-context map, no ubiquitous-language glossary, and no aggregate boundaries — `02-domain-design/` is six placeholders. Module boundaries are currently *asserted* rather than *derived*, which is why the responsibility overlaps in §4 exist. A context map plus a glossary should be the first two documents written, before any module doc.

**W4 — The AI Council contradicts ADR-001 without resolution.** ADR-001 ("engines over agents") demotes multi-model collaboration to "a bounded pattern, not the primary structure." Yet the Council is the existing product's core differentiator and AUDIT.md §07 found it is "frequently one model wearing four masks, and nothing discloses it." The new docs mention the Council in three places and specify it in none. Either it is a first-class AI Platform component with a real specification, or it is dropped — the current ambiguity lets an implementer build theatre again.

**W5 — Scoring ownership is split three ways.** The Review Engine computes quality scores, the SEO Engine computes an SEO score, and the existing product has eight scores (SEO/AEO/GEO/HEO/EEAT/Fact/Spam/Publish) that appear in **no** new document. Adding Optimization and Refresh engines makes it four modules that can each claim "what to improve." A single **Scoring contract** — who computes what, on what scale, who aggregates — is missing and must be defined once.

**W6 — Frontend has no architecture at all.** The tree specifies APIs, engines, and platforms, but the dashboard exists only as the phrase "Next.js (App Router)". No state management, no streaming/SSE client contract, no route map, no design-system spec, no accessibility or i18n position. AUDIT.md §02 found real UX defects (an editor that silently deletes content and autosaves the loss). A `15-frontend/` folder is missing from the proposed structure.

**W7 — Cost is architecturally central but has no owning document.** Credits, AI spend, provider spend, and per-article margin are referenced across billing, credits, AI gateway, and operations, but nobody owns the model end to end. Pricing (OQ-10) is blocked on it.

---

## 2. Missing modules

**Platform services with zero specification** — every one of these is referenced by other documents but specified nowhere: authentication, workspace, **organizations**, users, roles-permissions, billing, credits, notifications, media, workflow, template, settings, audit-logs, feature-flags. Fifteen documents.

**Content lifecycle stages with no module.** The vision mandates that every stage exists in the architecture. **Optimization** and **Refresh** currently exist only as bullet points inside the Analytics Engine's outputs. Two documents.

**AI Platform components specified in the brief but absent:** prompt-library, memory, tool-calling, output-validation, guardrails, streaming, cost-management, AI observability. Memory and the AI Council appear in baseline §12.5–12.6 and are consumed by the Writing and Review engines — they are load-bearing, not optional. Eight-plus documents.

**Integration policy documents:** provider-pattern, retry-policy, rate-limit-policy, api-versioning, webhooks. Today each of the eight provider docs restates its own retry and rate-limit policy — the shared policy should be defined once and referenced. Five documents.

---

## 3. Missing platforms

| Platform | Current state | Why it must be its own folder |
|---|---|---|
| **Knowledge** | One file, `11-knowledge-platform/README.md` | Evidence Bank, Knowledge Graph, Entity Graph, Citation Engine, Vector Search, embeddings, RAG pipeline, trust scoring, freshness, deduplication — ten subsystems compressed into one document that cannot exceed 3,000 words. Grounding is the product's central promise; this is the least defensible compression in the tree |
| **Storage** | Baseline §14 table only (four rows) | Which data lives where, why, and how each store scales is referenced by every engine. No document owns retention, partitioning, or the R2 object-key scheme |
| **Event** | Baseline §18 + one placeholder | See W2. Event catalog, producers, consumers, queues, workers, scheduler, retry, DLQ — this is the system's async backbone and it has no home |

The proposed `11`/`12`/`13` folders correctly fix all three.

---

## 4. Duplicate responsibilities

| Duplication | Evidence | Resolution |
|---|---|---|
| **Two sources of truth for the architecture** | 88 KB baseline (complete) vs `contentos-docs/` (34 placeholders that say "derives from baseline §N") | Archive the baseline as instructed; the folder tree becomes canonical |
| **Four legacy root documents describe a different product** | `ARCHITECTURE.md`, `ContentOS-AI-PRD.md`, `BUILD-PLAN.md`, `README.md`, `DEPLOYMENT.md` — council/judge/8-scores model | Move to `archive/`; keep `AUDIT.md` accessible as the record of defects the v2 must not repeat |
| **`model-selection.md` exists twice** | Root copy and `08-ai-platform/model-selection.md`, near-identical | Delete the root copy |
| **AI Gateway documented twice** | `08-ai-platform/ai-gateway.md` (pointer stub) and `08-ai-platform/ai-gateway.md` (real spec) | Delete the stub; the module list references folder 08 |
| **Media** | Writing Engine "media specs" (baseline §11.5) vs a proposed `04-platform/media.md` vs §29.3's "future Media Engine" | Decide once: **platform service** for storage/transform/CDN, **content engine** for what image to generate and why. Split along that line (decision D3) |
| **Workflow/Template vs the orchestrator** | Proposed `04-platform/workflow.md` risks re-specifying Temporal | Scope `workflow.md` to *user-facing* editorial workflow (assignment, approval chains, statuses); Temporal remains infrastructure |
| **Retry/rate-limit policy** | Repeated in all eight integration docs | Extract to `08-ai-platform/retry-strategy.md` + `rate-limit-policy.md` |
| **Testing strategy** | Was drifting between `07-development-guide/coding-standards.md` and `10-testing/` | Already resolved this session (style vs strategy split) |

---

## 5. Boundary violations

1. **A platform inside a module list.** `knowledge-engine.md` sits in `05-content-platform/` while being labelled "Knowledge Platform" in the same table. Fixed by folder 11.
2. **Platform services and content engines share one folder.** `05-content-platform/` mixes cross-cutting services with pipeline stages, which is precisely the separation the new `04`/`05` split enforces.
3. **Analytics owns both ingestion and recommendation.** With Optimization and Refresh becoming engines, Analytics must be cut back to *measurement* only; recommendation moves out. Otherwise three modules write refresh recommendations.
4. **Review vs SEO score ownership** (see W5).
5. **`06-api/README.md` admits its own conventions are undefined** — resource docs cannot be written until versioning, error envelope, pagination, idempotency, and rate limits are fixed. This blocks five to eight documents.
6. **No enforcement artifact for the AI-egress rule.** "Only the AI Gateway calls providers" is stated in four documents; the lint rule that enforces it is described only in `10-testing/testing-strategy.md`. `07-development-guide/folder-structure.md` must carry the actual boundary matrix.

---

## 6. Future scaling risks

| Risk | Trigger | Mitigation owner |
|---|---|---|
| Org-above-workspace retrofit | First agency or enterprise customer | Decide D2 **now**, before `03-database/` |
| Single PostgreSQL for content + evidence + analytics + events + cost telemetry | ~10k articles/day | `12-storage-platform/`, `14-operations/scaling-strategy.md` (ladder already specified) |
| No read models / CQRS anywhere | Analytics dashboards contending with the write path | `13-event-platform/` + read-model projections |
| Dual-write between DB and event bus | Any bus outage | Outbox pattern (W2) |
| RLS predicate cost at scale | S3 volumes | `tenant_id`-leading indexes, already asserted at build time |
| pgvector ceiling | Index > 50 GB / p95 > 200 ms | OQ-6; concrete criteria already drafted in `scaling-strategy.md` §8 |
| Data residency | First EU enterprise deal | OQ-7 — unresolved, and it constrains storage, backup, and deployment topology |
| Prompt/model drift | Provider-side model updates | Eval harness already specified |

---

## 7. Documentation gaps

- **No glossary / ubiquitous language.** "Engine", "module", "platform", "tenant", "workspace", and "project" are used with drifting meaning across folders.
- **No bounded-context map.**
- **No frontend architecture** (W6).
- **No cost model document** (W7).
- **No data-retention / compliance document** — GDPR export/delete is asserted in five places, specified in none (OQ-9 still open).
- **No non-functional budget per module** — global NFRs exist (§6); per-engine latency and cost budgets do not.
- **No security folder.** Security sections exist inside every document, but there is no single threat model, RBAC permission matrix, or prompt-injection defense specification.
- **Path defect:** the tree is nested as `contentos-docs/contentos-docs/`, while every cross-reference in every document assumes `contentos-docs/<folder>`. Must be flattened.
- **18 open questions**, several of which block schema design (OQ-4 gate thresholds, OQ-6 vector cutover, OQ-7 residency, OQ-10 credit pricing).

---

## 8. Migration map (old → new canonical structure)

| Current | Target | Action |
|---|---|---|
| `contentos-docs/contentos-docs/*` | `contentos-docs/*` | Flatten the double nesting |
| `ARCHITECTURE_BASELINE_ARCHIVE.md` | `ARCHITECTURE_BASELINE_ARCHIVE.md` | Rename; never modify again |
| `ARCHITECTURE.md`, `ContentOS-AI-PRD.md`, `BUILD-PLAN.md`, `DEPLOYMENT.md`, root `README.md`, root `model-selection.md` | `archive/` | Move; they describe the v1 product |
| `AUDIT.md` | keep at root | The defect record v2 must not repeat |
| `01-system-architecture/` (10 docs) | `01-system-architecture/` | Keep + add `context-map.md`, `glossary.md`, ADR-014/015/016 |
| `02-domain-design/` (6) | `02-domain-design/` | Keep + add `organizations.md` if D2 = yes |
| `03-database/` (4) | `03-database/` | Keep |
| `05-content-platform/` platform-ish content | `04-platform/` (16 docs) | New folder, 15 specs to write |
| `05-content-platform/` content engines (11) | `05-content-platform/` (14 docs) | Move planning + review (complete); add optimization, refresh |
| `11-knowledge-platform/README.md` | `11-knowledge-platform/` (11 docs) | Split into ten subsystem specs |
| `08-ai-platform/ai-gateway.md` | — | Delete (superseded by folder 08) |
| `06-api/` (5) | `06-api/` | Renumber + define conventions first |
| `07-development-guide/` (4) | `07-development-guide/` | Renumber |
| `08-ai-platform/` (5 complete) | `08-ai-platform/` (14) | Renumber + 9 new specs |
| `09-integrations/` (8 complete) | `09-integrations/` (14) | Renumber + 5 policy specs |
| `10-testing/` (5 complete) | `10-testing/` (8) | Renumber + load-testing, regression-testing |
| `14-operations/` (5 complete) | `14-operations/` (8) | Renumber + ci-cd, disaster-recovery |
| — | `12-storage-platform/` (7) | New |
| — | `13-event-platform/` (10) | New |
| `99-open-questions.md` | `99-open-questions.md` | Keep, extend |

**Scale:** target tree ≈ **145 documents**. 22 of the 27 complete documents carry over (renumbered, cross-references rewritten). **~120 documents remain**, ≈ 300,000 words at the mandated 1,500–3,000 each.

---

## 9. Improvement recommendations, prioritized

**P0 — resolve before any document is written**

| # | Decision | Why it blocks |
|---|---|---|
| **D1** | Greenfield TypeScript v2 rewrite vs documenting/evolving the existing Python system | Determines whether 145 documents describe a system that will be built or one that already exists in another language |
| **D2** | Organization tier above Workspace: in or out for v1 | Cannot be retrofitted after `03-database/tables.md` |
| **D3** | Media split: platform service vs content engine | Two folders currently claim it |
| **D4** | AI Council: first-class specified component or dropped | It is the v1 product's differentiator and the subject of an audit finding |

**P1 — structural, before module docs**
1. Flatten the `contentos-docs/contentos-docs/` nesting; archive the baseline and legacy root docs.
2. Write `01-system-architecture/04-context-map.md` and `glossary.md` **first** — every later document depends on stable vocabulary and boundaries.
3. Fix `06-api/README.md` conventions (versioning, error envelope, pagination, idempotency, rate limits, streaming) before any resource doc.
4. Choose the event-bus technology and adopt the transactional outbox pattern (W2).
5. Define the single **Scoring contract** (W5), including the fate of the eight legacy scores.

**P2 — additions to the proposed structure**
- Add `15-frontend/` (dashboard architecture, state, streaming client, design system, accessibility) — currently a blind spot.
- Add `16-security/threat-model.md` and a `roles-permissions` matrix owned by `04-platform/`.
- Add a cost-model document under `04-platform/credits.md` or `08-ai-platform/cost-management.md` — one owner, not both.

**P3 — proposed writing order** (each phase internally consistent before the next)
1. `01` architecture + context map + glossary + ADRs (13)
2. `02` domain design (8)
3. `03` database (5)
4. `12` storage + `13` event platform (17) — schema and events settle before modules
5. `04` platform (16)
6. `11` knowledge platform (11)
7. `05` content platform (14)
8. `08` AI platform additions (9)
9. `06` API (10)
10. `09` integrations additions (5)
11. `10` testing + `14` operations additions (4)
12. `07` development guide (5) — last, since it codifies everyone else's boundaries

---

## 10. What is already sound

Not everything needs changing. These decisions survive scrutiny and should be reused, not re-litigated:

- **Engines over agents (ADR-001)** — correct; agent-shaped decomposition is what produced the "one model wearing four masks" finding in the existing system.
- **AI Gateway as sole egress (ADR-008)** — the right call, and the only reason cost, guardrails, and evaluation are tractable.
- **Shared DB + RLS (ADR-007)** — correct for v1, with the org caveat in W1.
- **Temporal for the pipeline (ADR-004)** — directly fixes `ARCHITECTURE.md`'s foundational fault (run lifetime == connection lifetime).
- **Review before SEO (ADR-011)** — correct sequencing.
- **Explainability Envelope + grounding invariant** — the product's actual moat, and the direct answer to AUDIT.md's fact-checker blocker.
- **Folders 07–10 as written** — complete, cross-referenced, and implementation-ready; they carry over with renumbering only.

---

## Cross References

- `ARCHITECTURE_BASELINE_ARCHIVE.md` — historical baseline (post-rename)
- `AUDIT.md` — defect record of the v1 implementation
- `99-open-questions.md` — OQ-1…OQ-21, plus D1–D4 to be added on resolution
- `01-system-architecture/13-adr-log.md` — ADR-014, ADR-015, and the proposed ADR-016
