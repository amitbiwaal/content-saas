# Implementation Guide

> **Status:** v1.0 — complete. Phase 17. **Final document of the Editorial Intelligence Engine.**
> **EIE adds no package, no endpoint, no route, and no orchestrator.** It adds five tables, ten events, a set of activities, and a report surface on screens that already exist.

## Overview

**Purpose.** Sequence the implementation of EIE against the approved Implementation Blueprint, and record the four decisions it defers.

**Scope.** EIE-specific build detail. Sprint mechanics, checklists, testing standards, and deployment procedure are owned by `17-implementation/` and `07-development-guide/` and are referenced, never restated.

## Where EIE lands

**The approved Implementation Blueprint predates Phase 17 and contains no editorial sprint.** That is a fact about sequencing, not a defect, and this document does not modify the approved plan.

**EIE belongs in the Content sprint**, at the end of the approved build sequence:

```
Database + Security → Events → Storage → Platform → Knowledge → AI → Content
                                                                      ↑
                                                                     EIE
```

**Every dependency EIE has is satisfied by that point** and none earlier: the AI Gateway and Council (AI), the Evidence Bank and Freshness Engine (Knowledge), the outbox and consumers (Events), RLS and `TenantContext` (Security), and the Temporal Run workflow (Content).

**Sequencing EIE within the Content sprint is the owner's decision.** It is a substantial addition to a sprint the approved plan already scopes, and `17-implementation/sprint-planning.md` is approved. This document states the dependency floor and does not choose the date.

## Implementation sequence

**Eleven steps, ordered by dependency. Each is independently verifiable.**

| # | Step | Depends on |
|---|---|---|
| 1 | **Data model** — five tables, constraints, RLS | Database, Security |
| 2 | **Migration** — one migration, additive | 1 |
| 3 | **Issue store** — write and read paths | 2 |
| 4 | **Capability map + dispatch** | AI Gateway, Prompt Engine |
| 5 | **Collection and validation** | 3, 4 |
| 6 | **Debate engine** | 5 |
| 7 | **Consensus engine** — pure, testable in isolation | 3 |
| 8 | **Revision planner** — pure | 3 |
| 9 | **Coordinator activities + workflow wiring** | 5–8, Temporal |
| 10 | **Events** — outbox integration | 9, Event Platform |
| 11 | **Report surface** — UI + gate envelope | 9, frozen API |

**Steps 7 and 8 depend only on the Issue store and can be built and tested before any editor runs.** They are pure functions over recorded Issues, which means the two most decision-critical components in EIE are the two that need no model, no provider, and no network to verify (`consensus-engine.md`).

**Step 4 before step 5 is deliberate.** Dispatch must exist before collection, because collection's validation rules are defined against what dispatch declares an editor returns.

## Data model

**Five tables, all in the existing schema. No new database, no new schema namespace.**

| Table | Write pattern | Key constraints |
|---|---|---|
| `editorial_runs` | Insert + terminal update | One active run per revision chain |
| `editorial_issues` | **Insert only** | `confidence` `BETWEEN 0 AND 100`; non-empty `recommendation` |
| `editorial_issue_states` | **Append only** | `UNIQUE (issue_id, sequence)` |
| `editorial_debates` | **Written once** | Thread header; one per Issue |
| `editorial_debate_messages` | **Append only** | `UNIQUE (thread_id, sequence)` |
| `editorial_consensus` | **Insert only** | `UNIQUE (run_id, round_number)` |
| `editorial_revision_plans` | **Insert only** | `UNIQUE (run_id, round_number)` |
| `editorial_revision_tasks` | **Insert only** | `UNIQUE (plan_id, sequence)`; **non-empty `issue_refs`** |
| `editorial_reports` | **Insert only** | One per run |

**That is nine tables, not five.** `architecture.md` names five logical groups; four of them are physically two tables each — a written-once header plus its append-only history. The count is stated here rather than left to be discovered during migration, and it is the number the migration creates.

| Logical group | Physical tables |
|---|---|
| Issues | `editorial_issues` + `editorial_issue_states` |
| Debates | `editorial_debates` + `editorial_debate_messages` |
| Plans | `editorial_revision_plans` + `editorial_revision_tasks` |
| Runs · Consensus · Reports | One each |

**Every table has `tenant_id`, RLS enabled, and RLS forced.** `FORCE ROW LEVEL SECURITY` is not optional — omitting it is one of the six RLS failure modes with no symptom, and a table owner bypassing its own policy is invisible until a cross-tenant read reaches a customer (`16-security/tenant-isolation.md`).

**Immutability is enforced by constraint and privilege, not convention.** The insert-only tables have no `UPDATE` grant for the application role. A code review cannot reliably catch an `UPDATE` that a missing grant makes impossible (`issue-model.md`).

## Migration

**One additive migration. No existing table is altered.**

| Property | Value |
|---|---|
| Type | **Additive only** — `CREATE TABLE`, indexes, policies |
| Existing tables changed | **None** |
| Backfill | **None** — no historical editorial data exists |
| Reversible | Yes — drop, with no data dependency |
| Deploy coupling | **None** — safe to apply before code ships |

**No existing table is touched, which makes this the least risky class of migration the platform has.** The gate verdict CHECK constraint remains exactly as approved: three verdicts, unchanged, because EIE's five outcomes map onto them rather than extending them (`consensus-engine.md`).

**Migration mechanics — tooling, ordering, review, and rollback — are owned by `07-development-guide/migration-guide.md`** and are not restated here.

## API

**EIE adds no endpoints. The frozen 127-endpoint surface already covers it.**

| Need | Existing endpoint |
|---|---|
| Trigger editorial review | `POST /v1/workspaces/{workspaceId}/ai/review` |
| Read the verdict | `GET /v1/articles/{articleId}/revisions/{revisionNumber}/gates` |
| Run status | Existing run endpoints |

**The API surface is frozen and this document does not break the freeze.** A dedicated editorial-report endpoint would be a 128th endpoint and a change to `06-api/api-reference.md`, which is approved — so it is **deferred to the owner**, not added (see *Deferred decisions*).

**The verdict response exposes no provider, no model, no routing decision, and no per-model token count**, matching the approved AI API rules that EIE inherits (`06-api/ai-api.md`).

## Events

**Ten event types through the transactional outbox (ADR-020), each published in the same transaction as the state change it describes.**

`IssueCreated` · `IssueResolved` · `DebateStarted` · `DebateResolved` · `ConsensusReached` · `RevisionRequested` · `RevisionCompleted` · `EditorialPassed` · `EditorialBlocked` · `ResearchEscalated`

**Registration follows the approved registry process**, including the frozen envelope fields and the `producer` attribution. Event types are never reused and every version is immutable (`13-event-platform/versioning.md`).

**Payloads carry identifiers only.** No draft text, no Issue prose, no evidence content — an event stream carrying editorial text would become a second copy of the record under different retention and access control (`13-event-platform/event-registry.md`).

## Workers, storage, and scheduler

| Concern | EIE requirement |
|---|---|
| **Workers** | **None new.** Editors run as Temporal activities |
| **Queues** | **None new.** Existing task queues |
| **Storage** | **None.** No objects; no R2 usage |
| **Scheduler** | **None.** EIE is run-triggered, never scheduled |

**EIE stores no objects at all.** Issues, debates, decisions, and plans are structured records; the draft they describe is owned by the Content Platform and referenced by `revisionId`. Nothing in the editorial process produces a blob (`12-storage-platform/README.md`).

**There is no editorial scheduler.** EIE runs when a Run reaches the Review stage. A scheduled editorial sweep would be a second trigger path for a process that already has one (`orchestration.md`).

## UI

**No new route. The Review screen already exists.**

```
/w/{slug}/content/{articleId}/review        → Gate results  (approved)
```

**The editorial report renders on that screen**, using the approved article status vocabulary — `in_review`, `revalidating`, `gate_blocked` — with no new status value (`15-application-ui/content.md`).

| Rule | Source |
|---|---|
| Status is read-only; transitions come from APIs | `15-application-ui/content.md` |
| No provider names, no routing, no raw prompts | `06-api/ai-api.md` |
| All ten Common UI States implemented | `15-application-ui/error-and-loading-patterns.md` |
| Design tokens are authoritative | `15-application-ui/design-system.md` |
| Accessibility is mandatory | `15-application-ui/accessibility.md` |

**Editor identity is shown; model identity is not.** A reader sees that the Safety Editor raised an Issue — that is the product. Which model served the role is a routing decision the UI has no access to and no reason to display (`provider-mapping.md`).

**Sixteen editors producing dozens of Issues is a presentation problem, not just a rendering one.** The report groups by hierarchy rank and severity, and defaults to showing blocking Issues only — a flat list of forty findings communicates less than five ranked ones.

## Testing

**Four layers. Standards are owned by `10-testing/testing-strategy.md`.**

| Layer | What EIE requires |
|---|---|
| **Unit** | Consensus, planner, and confidence as pure functions |
| **Property** | **Same Issue set → same outcome**, including shuffled input order |
| **Integration** | Dispatch, collection, validation, outbox, RLS |
| **Policy** | **Eight editorial `taskType` keys resolve to ≥3 distinct candidate sets** |

**The property tests are the ones that matter.** Determinism claimed in prose is not determinism; generated Issue sets evaluated twice, and evaluated in shuffled order, must produce identical verdicts, identical plans, and identical confidences.

**Three invariants get explicit tests**, because each fails silently otherwise:

1. **Acyclicity** — Issue dependency graphs and task graphs reject cycles at write
2. **Traceability** — every accepted Issue is planned or listed as remaining, never neither
3. **No default verdict** — a consensus failure never yields `pass` on any path

**RLS conformance is tested per table**, using the approved cross-tenant read suite rather than a bespoke one (`16-security/tenant-isolation.md`).

**The routing-policy test is the only guard on board diversity.** EIE cannot assert distinctness at runtime, so a policy collapsing all editorial keys onto one candidate set would produce a monoculture board that only this test would catch (`provider-mapping.md`).

## Monitoring

**Signals are declared in the document that owns each component.** The four that page:

| Alert | Owner document |
|---|---|
| Consensus computation failure | `orchestration.md` |
| Plan construction failure | `revision-planner.md` |
| Rank 1–2 editor failure (R1) | `provider-mapping.md` |
| Malformed confidence discards | `confidence-engine.md` |

**All four are invariants, not SLOs.** They target zero and page at count one, and they are never aggregated into a rate — a single occurrence means a customer's run halted or a safety review did not happen (`13-event-platform/observability.md`).

**No metric, log, event, or trace attribute carries a provider, model, or family label.** Telemetry is as real an exfiltration path for provider identity as an API response.

## Performance

| Dimension | Characteristic |
|---|---|
| **Round latency** | Bounded by the slowest of 16 parallel dispatches |
| **Rounds per run** | Capped by policy; 2–3 typical |
| **Cost per run** | 16 dispatches × rounds, plus debate |
| **Debate cost** | Only contested Issues; most rounds debate few |
| **Consensus, planning, confidence** | **Negligible — no model calls** |

**The dominant cost is dispatch breadth, and it is deliberate.** Sixteen parallel calls per round is the price of a board rather than a reviewer; reducing it by running fewer editors would remove exactly the coverage that makes the engine worth having.

**Debate is the variable cost.** A round with no contested Issues costs one dispatch wave; a heavily contested one costs several more. Capping debate rounds at 2 bounds it (`debate-engine.md`).

**The first optimisation available is not fewer editors — it is fewer rounds**, and the lever is revision plan quality. A plan the Writer can execute completely converges in two rounds; a vague one converges in four at double the cost (`revision-planner.md`).

## Future extension points

**Four extensions are reserved. None is implemented, and none reserves a schema field.**

| Extension | Reserved boundary | Would consume |
|---|---|---|
| **Editorial Memory Engine** | Read-only view over historical Issues | `editorial_issues` |
| **Learning Engine** | Calibration factor applied to Prediction Confidence | Issue outcomes across runs |
| **Reviewer Analytics** | Aggregate queries over Issues and consensus | All EIE tables |
| **Customer-specific Editorial Policies** | Per-workspace severity and threshold overrides | Resolved settings (ADR-024) |

**No columns are added now for future use.** A nullable column reserved for an unbuilt feature is a column every query, migration, and code path carries for no benefit — and it invariably acquires a second, undocumented meaning before the feature arrives.

**Each extension is a consumer, not a modification.** All four read EIE records and write elsewhere, which is why none requires a change to the tables, the events, or the decision logic.

**Two boundaries hold for all four:**

- **AI Memory is never a source of truth (ADR-026).** An Editorial Memory Engine informs; it never supplies a finding, and no Issue may originate from memory.
- **Customer policies may adjust thresholds, never the hierarchy or the rule order.** A workspace that could reorder the eighteen ranks or disable R1 could configure away its own safety review.

**Customer-specific policies are the extension with real design risk**, because a per-workspace threshold makes verdicts non-comparable across workspaces and complicates every aggregate metric. That is a reason to design it deliberately, not to reserve a field for it now.

## Deferred decisions

**Four decisions are recorded rather than made. None blocks implementation.**

| # | Decision | Why deferred |
|---|---|---|
| **D-1** | **Editorial Issues and the Explainability Envelope** | See below — **warrants an ADR** |
| **D-2** | A dedicated editorial-report endpoint | Would be a 128th endpoint; `06-api/api-reference.md` is approved |
| **D-3** | EIE's position within the Content sprint | `17-implementation/sprint-planning.md` is approved |
| **D-4** | Auto-fix executor for `autoFixCandidate` tasks | The flag is defined; no executor is specified |

**D-1 is the one that needs a decision before launch.** ADR-009 requires every recommendation the platform surfaces to carry an Explainability Envelope `{ recommendation, reason, evidence[], expected_impact, confidence }` with non-empty `evidence[]` enforced by a `CHECK` where persisted.

**`EditorialIssue` carries four of those five fields and omits `expected_impact`** — and `issue-model.md` explicitly permits an empty `evidence` array, which is precisely the shape that triggers research escalation. The two are not reconcilable by wording.

**Three readings are possible**, and choosing between them is an architectural decision, not an editorial one:

1. The envelope governs **persisted recommendation records** — the Review and SEO surfaces — and `editorial_issues` is a different record type
2. EIE Issues must additionally be expressible as envelopes, requiring `expected_impact`
3. The gate verdict alone carries the envelope, with `evidence[]` drawn from blocking Issues

**This document does not decide.** `issue-model.md` and ADR-009 are both approved, and reconciling them by silently reinterpreting either would be exactly the kind of quiet redesign the governance rules exclude. **A Proposed ADR — next available number ADR-029 — is the correct instrument**, and it is recommended before the Content sprint begins.

## Business rules

1. **EIE adds no package, endpoint, route, worker, queue, bucket, or scheduler.**
2. **The migration is additive**; no existing table is altered.
3. **Nine tables**, five logical groups; every one tenant-scoped with RLS **enabled and forced**.
4. **Insert-only tables have no `UPDATE` grant** — immutability by privilege.
5. **The gate verdict CHECK constraint is unchanged**: three verdicts.
6. **The frozen API surface covers EIE.** No 128th endpoint is added.
7. **The Review screen renders the report**; no new route, no new status value.
8. **Editor identity is shown; model identity is never.**
9. **Consensus, planner, and confidence are buildable and testable before any editor runs.**
10. **Determinism is verified by property test**, including shuffled input order.
11. **Acyclicity, traceability, and no-default-verdict have explicit tests.**
12. **The routing-policy test is the only guard on board diversity.**
13. **Four alerts are invariants**: they target zero and page at count one.
14. **No telemetry carries provider, model, or family identity.**
15. **Four extensions are reserved; none reserves a schema field.**
16. **AI Memory is never a source of truth**; no Issue may originate from memory.
17. **Customer policies may adjust thresholds, never the hierarchy or the rule order.**
18. **Four decisions are deferred to the owner**, and D-1 warrants a Proposed ADR.

## Cross references

- `architecture.md` — components, tables, events, codebase placement
- `orchestration.md` — activities, workflow wiring, alerting
- `consensus-engine.md` — the pure decision logic
- `revision-planner.md` — plan construction and its failure signal
- `confidence-engine.md` — the three dimensions
- `provider-mapping.md` — capability map, dispatch, the diversity test
- `issue-model.md` — the Issue record, immutability, extension points
- `17-implementation/sprint-planning.md` — **the approved sprint sequence**
- `17-implementation/implementation-order.md` — the approved build order
- `17-implementation/testing-roadmap.md` — test sequencing
- `07-development-guide/migration-guide.md` — migration mechanics
- `07-development-guide/implementation-checklists.md` — the AI-agent build rules
- `10-testing/testing-strategy.md` — testing standards
- `16-security/tenant-isolation.md` — RLS, `TenantContext`
- `13-event-platform/event-registry.md` — event registration and payload rules
- `13-event-platform/versioning.md` — immutable event versions
- `15-application-ui/content.md` — the Review screen
- `06-api/api-reference.md` — **the frozen endpoint surface**
- `06-api/ai-api.md` — provider-hiding rules
- `01-system-architecture/13-adr-log.md` — **ADR-009**, ADR-020, ADR-024, ADR-026
