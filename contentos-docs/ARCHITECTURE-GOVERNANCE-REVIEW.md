# Architecture Governance Review

- **Date:** 2026-07-29
- **Scope:** Phases 1–12, repository-wide
- **Method:** Mechanical extraction and resolution of every cross-document reference, folder listing, placeholder marker, and ADR record
- **Nature:** **Report only.** No approved document was modified. No architecture was changed. No fix was applied.

> **Every finding below is evidence-based**, produced by resolving references against the filesystem rather than by inspection. Counts are exact.

## Summary

| Severity | Count | Nature |
|---|---|---|
| **Critical** | 1 | The ADR log no longer reflects the accepted decision set |
| **High** | 3 | ~123 broken references; a 38,000-word folder invisible in navigation |
| **Medium** | 4 | Superseded placeholders, package naming drift, stale folder descriptions |
| **Low** | 2 | Forward references, one self-correction |
| **Total** | **10** | |

**Nothing found contradicts an architectural decision.** Every issue is a reference, a name, or a navigation artifact. The architecture itself is internally consistent.

---

## G-1 · CRITICAL — The ADR log does not reflect the accepted decision set

**Location:** `01-system-architecture/13-adr-log.md`

**Explanation.** Three separate inaccuracies in the tree's governance root:

| Issue | Evidence |
|---|---|
| ADR-020 recorded as **`Proposed`** | Line 33: `\| 020 \| Transactional outbox + Redis Streams bus \| Proposed \|` |
| **ADR-027 and ADR-028 have no record** | `grep "ADR-027\|ADR-028" 01-system-architecture/` → no match |
| Overview says **"Twenty records"** | Line 8; the log actually contains **26** records and 26 index rows |

The overview has been stale since ADR-021 was added — six records before this review — and states that "ADR-014 through ADR-020 were decided during the v2 documentation build," which omits ADR-021 through ADR-026 entirely.

**Impact.** ADR-020 is the foundation of the Event, Security, Storage, Development Guide, and API phases — roughly 133,000 words of specification. A reader consulting the governance root learns that the decision underneath five phases is unaccepted, and that two ADRs cited across four phases do not exist.

**Recommended fix.**
1. Update the ADR-020 index row status to `Accepted`.
2. Add index rows and records for ADR-027 and ADR-028, summarizing `ADR-027-durable-dead-letter-queue.md` and `ADR-028-replay-coordination.md`.
3. Correct the overview: **"Twenty-eight records"**, and restate the ranges — ADR-001–013 from v1, ADR-014–028 from the v2 build.
4. Decide whether the three standalone ADR files remain authoritative or are folded into the log. **The two must not both be authoritative**, or the next status change updates one and not the other.

---

## G-2 · HIGH — 21 distinct broken reference targets, ~123 occurrences

**Location:** Repository-wide

**Explanation.** Every `folder/file.md` reference was resolved against the filesystem. Twenty-one targets do not exist. They divide into two categories requiring different fixes.

### G-2a — Wrong path; the file exists under another name or location (5 targets, 25 occurrences)

| Referenced | Actual | Refs |
|---|---|---|
| `04-platform/audit-logs.md` | **`04-platform/audit-logs.md`** | 13 |
| `99-open-questions.md` | **`99-open-questions.md`** (repository root) | 9 |
| `01-system-architecture/04-context-map.md` | **`01-system-architecture/04-context-map.md`** | 1 |
| `16-security/threat-model.md` | **`16-security/threat-model.md`** | 1 |
| `04-platform/workspaces.md` | **`04-platform/workspaces.md`** | 1 |

**These are the cheapest and highest-value fixes in this report** — a find-and-replace each, resolving 25 dangling references to documents that already exist.

**`99-open-questions.md` is the most consequential.** Nine documents — including `07-development-guide/implementation-checklists.md`, which instructs AI coding agents to record uncertainty there — point at a path that does not exist. An agent following that instruction cannot find the file.

**Recommended fix.** Correct the paths in the referencing documents. No new files needed.

### G-2b — Genuinely missing; no equivalent file exists (16 targets, ~98 occurrences)

| Referenced | Refs | Assessment |
|---|---|---|
| **`16-security/prompt-injection.md`** | **24** | **Highest count in the tree.** Threat T-14 is specified in `threat-model.md`; the dedicated document was never created |
| **`12-storage-platform/redis.md`** | **14** | Cache, locks, heartbeats, lease state — load-bearing for Phase 8 and `tenant-isolation.md` |
| **`04-platform/rate-limiting.md`** | **13** | Rate-limit *values* per plan; referenced by every API document |
| `12-storage-platform/postgresql.md` | 7 | Pooling, replicas, tuning |
| `11-knowledge-platform/retrieval-pipeline.md` | 6 | Superseded in substance by `retrieval-pipeline.md` |
| `13-event-platform/event-registry.md` | 5 | Superseded by `event-registry.md` + `event-apis.md` |
| `03-database/tables.md` | 4 | Constraints are specified inside `tables.md` |
| `12-storage-platform/storage-abstraction.md` | 4 | Superseded by `storage-abstraction.md` |
| `12-storage-platform/qdrant.md` | 4 | See G-8 |
| `13-event-platform/event-registry.md` | 4 | Superseded by `event-registry.md` |
| `09-integrations/README.md` | 3 | Pattern described in `09-integrations/README.md` |
| `11-knowledge-platform/evidence-bank.md` | 3 | Reliability scoring lives in `evidence-bank.md` |
| `04-platform/resilience.md` | 3 | Circuit breaker ownership; cited by `retry-engine.md` |
| `04-platform/caching.md` | 2 | Cache strategy; cited by `tenant-isolation.md` |
| `08-ai-platform/retry-strategy.md` | 1 | Covered by `08-ai-platform/retry-strategy.md` |
| `13-event-platform/workers.md` | 1 | Superseded by `workers.md` |

**Three require a decision rather than a redirect** — `prompt-injection.md`, `redis.md`, and `rate-limiting.md` are referenced 51 times between them and have no existing document covering their subject.

**The remainder are superseded in substance.** Later phases produced documents covering the same ground under different names; the references were never updated.

**Recommended fix.**
1. **Redirect the 13 superseded targets** to the documents that replaced them (`rag-pipeline.md` → `retrieval-pipeline.md`, `event-catalog.md` → `event-registry.md`, and so on).
2. **Decide on the three genuine gaps.** Either write them, or redirect: `prompt-injection.md` → `16-security/threat-model.md` T-14 and `08-ai-platform/guardrails.md`; `rate-limiting.md` → create, since no document holds plan limit values; `redis.md` → create or scope elsewhere (see G-6).
3. Add a CI reference-resolution check so this cannot recur.

---

## G-3 · HIGH — The root README omits `16-security/` entirely

**Location:** `README.md`, Structure table

**Explanation.** `grep -c "16-security" README.md` returns **0**. The folder contains 14 documents and 38,280 words specifying every security control the platform depends on — RLS, tenant isolation, authentication, authorization, encryption, audit, compliance, threat model, incident response — and it is invisible in the tree's primary navigation.

**Impact.** A reader entering through the README concludes security is undocumented. Eighty-five documents defer their controls to that folder.

**Recommended fix.** Add `16-security/` to the Structure table. Note that folder `15` is not yet created, so the numbering gap is intentional and worth stating.

---

## G-4 · HIGH — Root README folder descriptions contradict delivered scope

**Location:** `README.md`, Structure table

**Explanation.** Three descriptions describe folders that were built differently.

| Folder | README says | Actually contains |
|---|---|---|
| `12-storage-platform/` | "PostgreSQL, Redis, Qdrant, R2: what lives where" | **Binary object storage only** — 11 documents on objects, media, CDN, backups, DR, retention |
| `13-event-platform/` | "…events, **catalog, queues**, workers, **scheduler**, retry, DLQ" | No catalog, queues, or scheduler documents exist |
| `11-knowledge-platform/` | "…embeddings, **RAG**, **trust**, freshness…" | No `rag-pipeline.md` or `trust-scoring.md` |

**The `12-storage-platform/` mismatch is the root cause of G-2b's `redis.md` and `postgresql.md` gaps.** Phase 10 scoped that folder to binary object storage; the README still describes it as the data-stores folder, and 21 references were written against the README's model.

**Recommended fix.** Update the three descriptions to match delivered contents, and resolve the data-store documentation question raised in G-6.

---

## G-5 · MEDIUM — Eight superseded placeholder files remain

**Location:** `06-api/`, `07-development-guide/`

**Explanation.** All eight still carry `> **Status:** Placeholder — to be written`.

| File | Superseded by | Inbound refs |
|---|---|---|
| `06-api/authentication.md` | `06-api/authentication-api.md` | 0 |
| `06-api/articles.md` | `06-api/content-api.md` | 1 |
| `06-api/publishing.md` | `content-api.md` publish action | 1 |
| `06-api/research.md` | `06-api/research-api.md` | 0 |
| `06-api/keywords.md` | Not yet covered | 0 |
| `07-development-guide/folder-structure.md` | `project-structure.md` | 5 |
| `07-development-guide/claude-code-rules.md` | `implementation-checklists.md` Part 1 | 1 |
| `07-development-guide/git-workflow.md` | `ci-cd.md` §Source control | 1 |

**`06-api/authentication.md` additionally contains a superseded architectural assumption.** Its TODO list specifies "token contents and claims (`user_id`, **`tenant_id`, `roles`**)." `16-security/authentication.md` overturned exactly that: **no token carries permissions or roles**, and `Subject` carries no `tenantId`. A reader finding the placeholder would implement the wrong model.

**`07-development-guide/folder-structure.md` has 5 inbound references** and is the most-cited placeholder.

**Recommended fix.** Delete the seven superseded files after redirecting their inbound references. Retain `06-api/keywords.md` — no document covers keyword endpoints yet — or delete it and record the gap.

---

## G-6 · MEDIUM — The data-store documentation has no home

**Location:** `12-storage-platform/`, cross-phase

**Explanation.** Twenty-five references across Phases 4–9 point at `12-storage-platform/redis.md` (14), `postgresql.md` (7), and `qdrant.md` (4). Phase 10 scoped that folder to binary object storage as instructed, so those documents were not created and the folder's README records the gap.

**This is a structural decision, not a defect.** Three resolutions are available:

| Option | Consequence |
|---|---|
| Create the three inside `12-storage-platform/` | Restores the README's original model; widens the folder beyond its Phase 10 scope |
| Create a separate data-stores folder | Clean separation; requires a new top-level folder and updating 25 references |
| Redirect to existing documents | Cheapest; `redis.md` has no clean substitute — Redis usage is specified across `tenant-isolation.md`, `workers.md`, and `retry-engine.md` with no single owner |

**Recommended fix.** Owner decision. The `redis.md` gap is the substantive one — Redis holds cache, locks, heartbeats, leases, and idempotency counters, and no document owns its configuration, eviction policy, or failure behaviour.

---

## G-7 · MEDIUM — Package naming drift across four names

**Location:** `01-system-architecture/`, `10-testing/`, `07-development-guide/project-structure.md`

**Explanation.** Phase 11 froze the repository layout. Four package names in earlier approved documents do not match it.

| Earlier documents | Phase 11 frozen | Locations |
|---|---|---|
| `packages/engines/*` | **`packages/content`** | `03-high-level-architecture.md:215`, `10-testing/testing-strategy.md` §9 |
| `packages/db` | **`packages/database`** | `13-adr-log.md:239` (ADR-022 Affects) |
| `packages/config` | Config module inside `packages/platform` | `03-high-level-architecture.md:122`, `08-c4-component.md:127` |
| `tooling/test` | `tests/` + package fixtures | `10-testing/testing-strategy.md` |

**`10-testing/testing-strategy.md` §9 is the consequential one.** Its coverage gate reads "≥ 85% lines in `packages/engines/*`" — a path that does not exist in the frozen layout, so the CI gate as written would match nothing.

`project-structure.md` records the four-way mapping rather than silently renaming, but the approved documents still carry the old names.

**Recommended fix.** Update the four references to the frozen names. `10-testing/testing-strategy.md` §9 is highest priority, because it is an executable gate rather than prose.

---

## G-8 · LOW — Correction: the Qdrant references are not stale

**Location:** This reviewer's earlier reporting

**Explanation.** In Phase 10 and Phase 12 summaries I described `12-storage-platform/qdrant.md` as "stale, since Phase 1 selected pgvector." **That was wrong.**

**ADR-006 — "pgvector first, Qdrant at scale" — is Accepted**, and `11-deployment-topology.md` names Qdrant as a separate data-zone service at the S3 tier. Qdrant is a planned scale migration, not a superseded choice.

The reference is therefore a **forward reference to an unwritten document**, in the same category as the other data-store gaps — not a contradiction.

**Recommended fix.** None to the architecture. Resolve `qdrant.md` under G-6 alongside `redis.md` and `postgresql.md`.

---

## G-9 · LOW — Forward references to `15-application-ui/`

**Location:** `01-system-architecture/01-executive-summary.md`, `02-product-vision.md`, `03-high-level-architecture.md` (6 occurrences)

**Explanation.** Phase 1 named `15-application-ui/` as an approved future folder. It does not yet exist. These are intentional forward references to planned work, not defects.

**Recommended fix.** None now. They resolve when Phase 15 is built. If Phase 15 is deferred indefinitely, convert them to a note in `99-open-questions.md`.

---

## G-10 · LOW — Duplicate authority risk between the ADR log and standalone ADR files

**Location:** `01-system-architecture/13-adr-log.md` and the three new `ADR-0NN-*.md` files

**Explanation.** ADR-020 now exists in two places: a `Proposed` record in the log, and an `Accepted` standalone file. ADR-027 and ADR-028 exist only as standalone files. The tree has two ADR conventions.

Each standalone file carries a governance note stating the log has not been modified, so the divergence is disclosed rather than silent — but it is still a divergence.

**Recommended fix.** Choose one convention:
- **Log is authoritative** — fold the three records in, keep the standalone files as expanded appendices explicitly marked non-authoritative, or delete them.
- **Standalone files are authoritative** — reduce the log to an index, and migrate ADR-001–026 to individual files.

**The first is less work and preserves 26 existing records in place.** Whichever is chosen, only one may carry status.

---

## Recommended sequence

| Order | Action | Resolves | Effort |
|---|---|---|---|
| 1 | Update the ADR log — status, two records, overview count | G-1, G-10 | Low |
| 2 | Fix the 5 wrong-path targets (25 references) | G-2a | Low |
| 3 | Add `16-security/` to the root README; correct three folder descriptions | G-3, G-4 | Low |
| 4 | Correct `10-testing/testing-strategy.md` §9 package paths | G-7 | Low |
| 5 | Redirect the 13 superseded reference targets | G-2b | Medium |
| 6 | Delete 7 superseded placeholders after redirecting | G-5 | Medium |
| 7 | Decide on the data-store documentation | G-6 | **Decision** |
| 8 | Decide on `prompt-injection.md` and `rate-limiting.md` | G-2b | **Decision** |
| 9 | Add a CI reference-resolution check | Prevents recurrence | Medium |

**Steps 1–4 are mechanical, resolve the Critical and both High findings, and touch no architecture.**

**Steps 7 and 8 are the only owner decisions in this report.** Everything else is a correction with an unambiguous target.

## What was verified clean

| Property | Result |
|---|---|
| Architectural contradictions between phases | **None found** |
| Duplicate ownership of a specification | **None found** |
| ADR violations in later phases | **None found** |
| Conflicting invariants | **None found** |
| `PUT` used anywhere in the API | **None** |
| Placeholder or TODO markers in Phase 8–12 output | **None** |
| Interface signature drift within a phase | Resolved in-phase (Phase 8: 9 items; Phase 10: 10; Phase 12: 8) |

**The architecture is internally consistent.** Every finding in this report is about how documents point at each other, not about what they say.

## Scope note

This review covered reference integrity, naming, navigation, and ADR governance, as instructed. It did **not** review technical correctness, completeness of any specification, or fitness of any decision — those were reviewed within their phases.

**No fix in this report has been applied.** No approved document was modified.
