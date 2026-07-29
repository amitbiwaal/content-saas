# Development Checklists

> **Status:** v1.0 — complete. Phase 16.
> **These are work breakdowns, not readiness gates.** `07-development-guide/implementation-checklists.md` Part 3 asks *does this platform meet its specification*. These ask *what tasks, in what order, and which can run at the same time*.

## Overview

**Purpose.** Per bounded context: the implementation tasks by dimension, with parallelization marked.

**Boundary with Phase 11.** Part 3 of that document is the architecture gate for each platform and is cited at the end of every checklist here. Neither restates the other — a task list and a gate answer different questions, and duplicating either would create drift.

**Notation.** **∥** work can proceed in parallel with its siblings · **→** must follow the item above it.

## Universal prerequisites

**Before any context checklist begins:**

- [ ] Healthy local environment — all ten assertions (`repository-bootstrap.md`)
- [ ] The specifying architecture document read
- [ ] API contracts identified in `06-api/api-reference.md`
- [ ] Permissions named from `16-security/rbac.md`
- [ ] Events named from `13-event-platform/event-registry.md`
- [ ] Upstream contexts landed and verified

---

## Security

**Sprint 0 · Critical path · Blocks everything**

| Dimension | Tasks |
|---|---|
| **Database** | → RLS policies with `ENABLE` + `FORCE` on every workspace-owned table · → the five exception tables and no more · → `contentos_app` without `BYPASSRLS`, owning no tables · → `audit_log` with revoked `UPDATE`/`DELETE` and the immutability trigger |
| **Backend** | ∥ `TenantContext` immutable, three entry points · ∥ authentication via Better Auth · ∥ authorization evaluation, default deny · ∥ audit writer taking a `Transaction` · ∥ secret store client · ∥ encryption envelope |
| Frontend | ∥ Sign-in, MFA, step-up flows |
| Workers | — |
| Events | — (audit is not an event) |
| **Security** | → transaction pooling; statement pooling refused · → hash chain per tenant |
| Observability | ∥ Invariant metrics emitting at zero |
| **Testing** | → **RLS conformance enumerating `information_schema`** · ∥ denial-path tests · ∥ cross-tenant isolation per table |
| Documentation | ∥ Package README naming `16-security/` |
| Deployment | → Roles created before the app connects |
| **Acceptance** | Zero rows without context · cross-tenant write rejected by `WITH CHECK` · a sixth exception table fails the build |

**The conformance suite is written before the tables it checks.** Adding it after tables accumulate means auditing every one retroactively.

**Gate:** `07-development-guide/implementation-checklists.md` §Security Platform.

---

## Events

**Sprint 1 · Critical path · Blocks Storage, Platform, Knowledge, Content**

| Dimension | Tasks |
|---|---|
| **Database** | → `outbox_events` with `publish_attempts` and the partial pending index · → `processed_events`, monthly partitions · → `dead_letter_events` (ADR-027) · → `replay_runs` with the partial unique index (ADR-028) |
| **Backend** | → `EventPublisher.publish(tx, event)` — **signature first** · → registry with pre-commit validation · ∥ `EventBus` over Redis Streams · ∥ retry engine with classification · ∥ idempotency guard · ∥ aggregate barrier |
| Frontend | — |
| **Workers** | → `workers/host` with lifecycle, heartbeats, lease renewal · → consumer group runtimes · ∥ graceful drain |
| **Events** | → relay reading the **primary only**, aggregate-grouped batches |
| Security | → Consumers use the RLS role; context validated per delivery |
| Observability | ∥ Relay lag, consumer lag in seconds, DLQ depth, ordering violations |
| **Testing** | → publish-outside-transaction is a compile error · → idempotency under redelivery · → ordering under retry, failover, replay · ∥ poison quarantine |
| Documentation | ∥ README naming `13-event-platform/` |
| Deployment | → `WEB_CONCURRENCY=1` for seamless reconnect |
| **Acceptance** | Event exists iff its transaction committed · rolled-back transaction publishes nothing · relay lag p95 < 2 s |

**The publisher signature lands before any producer exists.** Once `publish(tx, event)` is the only shape, publishing outside a transaction is unrepresentable rather than reviewed for.

**Gate:** §Event Platform.

---

## Storage

**Sprint 2 · Off critical path · Blocks Knowledge**

| Dimension | Tasks |
|---|---|
| **Database** | → `media_assets` with `reference_count`, `CHECK (>= 0)`, `deleted_at`, partial index |
| **Backend** | → `ObjectStoreDriver` with capability declaration · ∥ MinIO driver · ∥ R2 driver · → the sixteen frozen operations · ∥ presigned URL issuance |
| Frontend | ∥ Upload, library, detail, derivatives |
| **Workers** | ∥ Malware scanning, sandboxed · ∥ derivation jobs · ∥ retention GC · ∥ orphan detection |
| Events | → `MediaUploadInitiated`, `MediaAvailable` **through the outbox only** |
| **Security** | → Tenant-prefixed server-constructed keys · → SSE-KMS on every write · → magic-byte detection |
| Observability | ∥ Checksum mismatches, dangling references, verified backup age |
| **Testing** | → driver conformance **against real MinIO** · ∥ immutability via conditional write · ∥ reference-counted deletion |
| Documentation | ∥ README naming `12-storage-platform/` |
| Deployment | → Buckets, versioning, Object Lock, multipart abort lifecycle rule |
| **Acceptance** | Upload reaches `available` p95 < 60 s · deletion refused while referenced · no key ever leaves the API |

**Both drivers are built together.** A single-driver abstraction is an abstraction nobody has tested.

**Gate:** §Storage Platform.

---

## Platform services

**Sprint 1 · Critical path · Blocks AI**

**All five services are mutually independent — the largest intra-context parallel opportunity.**

| Service | Key tasks |
|---|---|
| **Credits** ∥ | → atomic charge with holds · → 402 on exhaustion · → release on failure · **concurrency tests are a gate** |
| Rate limiting ∥ | → pre-auth by IP, post-auth by subject and tenant · → headers on every response |
| Notifications ∥ | → inbox, preferences, delivery consumer |
| Workflow ∥ | → boards, queues, assignment |
| Settings + flags ∥ | → hierarchical resolution · → **no flag gates a security control** |

| Dimension | Tasks |
|---|---|
| Database | → `credit_holds`, `credit_ledger_entries` · ∥ per-service tables |
| Events | → published through the outbox |
| Security | → every table `tenant_id` + policy + isolation test |
| Observability | ∥ Credit balance, rate-limit rejections, notification delivery |
| **Testing** | → **credit concurrency under parallel load** · ∥ limit enforcement · ∥ idempotent webhooks |
| **Acceptance** | Ledger reconciles exactly · no double-charge under concurrency · limits enforced on both dimensions |

**Credit accounting is the riskiest item in this context because it is money.** Its concurrency test is a sprint gate, not a nice-to-have.

**Gate:** §Platform Services.

---

## Knowledge

**Sprint 2 · Off critical path · Blocks Content**

| Dimension | Tasks |
|---|---|
| **Database** | → Evidence, entities, provenance, citations · → **every vector index leads with `tenant_id`** |
| **Backend** | → Evidence Bank · ∥ entity graph · ∥ retrieval with **query-time tenant filtering** · ∥ provenance chain · ∥ freshness · ∥ deduplication producing candidates only |
| Frontend | ∥ Explorer, evidence detail, provenance, entities, freshness |
| **Workers** | ∥ Embedding pipeline · ∥ freshness sweeps · ∥ dedup candidate generation |
| Events | → `EntityCurated`, `EntityMerged`, `EvidenceSuperseded` |
| **Security** | → **query-time filtering, never post-filtering** · → derived data excluded from backup |
| Observability | ∥ Foreign-tenant vector results (must be zero) · ∥ provenance integrity |
| **Testing** | → cross-tenant retrieval returns nothing · ∥ merges preserve lineage · ∥ property tests on freshness |
| **Acceptance** | Zero foreign-tenant results · merges preserve every evidence id · authoritative entities never auto-merge |

**Post-filtering is rejected in review, not caught in test.** It leaks existence through result counts even when the filter works.

**Gate:** §Knowledge Platform.

---

## AI

**Sprint 3 · Critical path · Blocks Content**

| Dimension | Tasks |
|---|---|
| Database | → `ai_call_costs` · → memory tenant-scoped and RLS-protected |
| **Backend** | → AI Gateway as sole egress · → **Context Builder with structural secret exclusion** · → Prompt Engine with escaped variables · ∥ guardrails · ∥ Council with enforced diversity · ∥ cost attribution |
| Frontend | ∥ Generation, review, Council disclosure, usage |
| Workers | ∥ Long-running generation |
| Events | → `AiGenerationRequested`, `AiCostRecorded` |
| **Security** | → **secrets structurally absent from prompts** · → output scanned for credential patterns · → prompts never logged |
| Observability | ∥ Cost per tenant · ∥ guardrail block rate · ∥ provider latency |
| **Testing** | → **no secret can reach a prompt — structural, not filtered** · → guardrail blocks never retried · → safety refusal never auto-falls-back · ∥ injection resistance evaluation |
| **Acceptance** | Cost within envelope and reconciling with the ledger · no model or provider exposed anywhere · scores conform to ADR-021 |

**Structural exclusion is tested by construction, not by filtering.** A test asserting no secret appeared is weaker than a Context Builder that cannot receive one.

**Gate:** §AI Platform.

---

## Content

**Sprint 4 · Critical path · Terminal**

| Dimension | Tasks |
|---|---|
| **Database** | → `articles` with the fourteen-status CHECK · → `outline_versions`, `article_revisions` append-only · → `citation_anchors` with the grounding CHECK |
| **Backend** | → Temporal orchestration first · **then engines ∥** — keyword, SERP, competitor, research wiring, planning, writing, review, SEO, publishing, analytics, optimization, refresh |
| Frontend | ∥ List, overview, outline, editor, review, citations, history |
| **Workers** | → Temporal activities, **idempotent on `(workflow_id, step)`** |
| Events | → `ArticleCreated` … `ArticlePublished` |
| **Security** | → `publish:execute` separated from `article:update` · → fetched content treated as untrusted |
| Observability | ∥ Gate verdicts · ∥ per-stage latency · ∥ run outcomes |
| **Testing** | → **replay tests for every workflow** · → writing blocked without an approved outline · → publish verifies the verdict **for that revision** · ∥ citations resolve |
| **Acceptance** | Full run completes and survives a worker restart · a `block` cannot be overridden by any path · one active run per article |

**Orchestration lands before any engine.** Engines built without it acquire their own scheduling, which then has to be removed.

**Gate:** §Content Platform.

---

## Integrations

**Sprint 2 onward · Fully parallel · Blocks nothing directly**

| Dimension | Tasks |
|---|---|
| Backend | ∥ **One adapter per provider, independent** — DataForSEO, Firecrawl, Exa, OpenRouter, Stripe, GSC, GA4, Better Auth |
| Security | → **`SafeUrlFetcher` for every customer-supplied URL** · → credentials from the secret store |
| Observability | ∥ Per-provider latency, error rate, quota |
| **Testing** | ∥ Recorded fixtures per provider · → SSRF validation including redirect re-validation |
| **Acceptance** | No provider identity leaves the Provider Layer · a provider outage degrades, never fabricates |

**Every adapter is independently buildable against a fixture** — the cleanest parallel work in the plan.

---

## API

**Continuous · Follows each context**

| Dimension | Tasks |
|---|---|
| **Backend** | → Request pipeline **once**, in order · **then endpoints ∥ per resource** |
| Security | → Inherited from the pipeline; no per-route re-implementation |
| Observability | ∥ RED metrics by route template |
| **Testing** | → contract tests against the registry · → **route table matches `api-reference.md`** · ∥ per-endpoint denial tests |
| **Acceptance** | 127 endpoints match the registry · an endpoint absent from it does not exist |

---

## Applications

**Sprint 0 onward · Fully parallel against frozen contracts**

| Dimension | Tasks |
|---|---|
| Frontend | → Design tokens · → shell and navigation · → **the sixteen-state catalogue** · **then screens ∥ as APIs land** |
| Security | → Permission-driven absence · → 404-versus-403 rendering |
| **Testing** | → **accessibility gate from the first component** · ∥ E2E journeys as APIs land |
| **Acceptance** | Every screen in `15-application-ui/` reachable · no orphan screens · keyboard-only journeys pass |

**The state catalogue is built before the screens.** Screens built first each invent their own loading and error handling, and reconciling them afterwards is a rewrite.

---

## Parallelization summary

| Fully parallel | Serial within context | Blocks the path |
|---|---|---|
| Provider adapters | Security → Events | Security |
| UI shell and screens | Orchestration → engines | Events |
| Platform's five services | Pipeline → endpoints | Platform |
| Knowledge subsystems | Driver → operations | AI |
| Storage media processing | Tokens → shell → screens | Content |

## Business rules

1. **These are work breakdowns; Phase 11 Part 3 holds the readiness gates.**
2. **Universal prerequisites precede every context checklist.**
3. **The RLS conformance suite is written before the tables it checks.**
4. **The publisher signature lands before any producer.**
5. **Both storage drivers are built together.**
6. **Credit concurrency testing is a gate, not a nice-to-have.**
7. **Post-filtering in retrieval is rejected in review.**
8. **Secret exclusion from prompts is structural, not filtered.**
9. **Orchestration lands before any engine.**
10. **The request pipeline is built once and inherited.**
11. **The UI state catalogue precedes the screens.**
12. **Parallel work integrates through frozen contracts, never coordination.**
13. **Every checklist ends by citing its Phase 11 gate.**

## Cross references

- `07-development-guide/implementation-checklists.md` — **the per-platform readiness gates every checklist cites**
- `module-dependencies.md` — what genuinely blocks what
- `implementation-order.md` — the sprints these checklists populate
- `testing-roadmap.md` — when each test type arrives
- `repository-bootstrap.md` — the prerequisites
- `06-api/api-reference.md` — the endpoint registry
- `16-security/` · `13-event-platform/` · `12-storage-platform/` · `11-knowledge-platform/` · `08-ai-platform/` · `05-content-platform/` — the specifications
