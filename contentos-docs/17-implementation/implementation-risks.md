# Implementation Risks

> **Status:** v1.0 — complete. Phase 16.
> **This register covers delivery risk, not adversarial threat.** `16-security/threat-model.md` owns 26 threats with attack paths and mitigations. What follows is the risk of building and operating the platform incorrectly — a different register with different owners.

## Overview

**Purpose.** Identify what can go wrong during implementation, with mitigation, detection, recovery, and an owner for each.

**The boundary.** A *threat* is someone attacking the platform. A *risk* here is the team failing to implement a control, missing a schedule, or exceeding a budget. Security appears in both registers with different framing: the threat model asks "can an attacker cross a tenant boundary"; this document asks "will we ship a control that was never verified."

**Scale.** Likelihood and impact are Low / Medium / High. Owners are roles, not names.

---

## Architecture risks

### A1 · Four ADRs remain Proposed

| | |
|---|---|
| **Description** | ADR-022 (PostgreSQL 17 + Drizzle), 023, 024, 025 are unaccepted. **ADR-022 selects the ORM and schema toolchain.** |
| **Impact** | **High** — the repository cannot bootstrap without 022 |
| **Likelihood** | **High** — currently true |
| **Mitigation** | Sprint 0 proceeds on 022 as a working assumption; accept or accept-as-risk **before the first migration ships** |
| **Detection** | The GA gate: every Proposed ADR accepted or accepted-as-risk |
| **Recovery** | A late ORM change is a rewrite of `packages/database` and every query |
| **Owner** | Architect |

**This is the highest-priority open item in the plan.** ADR-025 has no implementation consequence yet — no reference-data table exists — but 022 touches Sprint 0 directly.

### A2 · Specification drift

| | |
|---|---|
| **Description** | ~300,000 words of architecture; implementation diverges silently |
| **Impact** | **High** — a codebase disagreeing with its own specification is the condition ADR-016 exists to have resolved |
| **Likelihood** | Medium |
| **Mitigation** | Conformance suites; PRs cite their specifying document; review asks *where is this specified* |
| **Detection** | **Signature and RLS conformance in CI** |
| **Recovery** | Reconcile in code, or ADR if the architecture was wrong |
| **Owner** | Tech lead |

### A3 · Boundary erosion under delivery pressure

| | |
|---|---|
| **Description** | Import direction, banned imports, or layering crossed to ship faster |
| **Impact** | High — layering survives only while mechanically prevented |
| **Likelihood** | Medium |
| **Mitigation** | Four independent mechanisms configured in Sprint 0, **all blocking** |
| **Detection** | `dependency-cruiser`, `no-restricted-imports`, `exports`, TypeScript |
| **Recovery** | Revert; the gate held |
| **Owner** | Tech lead |

---

## Technical risks

### T1 · RLS misconfiguration with no symptom

| | |
|---|---|
| **Description** | **Six of seven RLS failure modes produce no error** — the application works and returns more data than it should |
| **Impact** | **Critical** — cross-tenant exposure |
| **Likelihood** | Medium without automation; **Low with it** |
| **Mitigation** | **Conformance suite in Sprint 0, before tables accumulate**; policies ship in the table's own migration |
| **Detection** | `rls_policy_violations_total`, `cross_tenant_attempts_total` — both page at count one |
| **Recovery** | Security incident procedure; scope via audit |
| **Owner** | Security owner |

### T2 · Outbox or ordering retrofit

| | |
|---|---|
| **Description** | A component publishes outside the outbox, or ordering breaks under retry |
| **Impact** | High — silent event loss or inverted state |
| **Likelihood** | **Low** — `publish(tx, event)` makes it unrepresentable |
| **Mitigation** | Event Platform in Sprint 1 **before anything that publishes**; signature enforced |
| **Detection** | `ordering_violations_total` pages; publish-side DLQ entries page |
| **Recovery** | Range replay to rebuild affected projections |
| **Owner** | Tech lead |

### T3 · Per-consumer idempotency divergence

| | |
|---|---|
| **Description** | A consumer implements its own duplicate suppression with a different key or window |
| **Impact** | High — duplicate effects the platform believes are impossible |
| **Likelihood** | Medium |
| **Mitigation** | One `IdempotencyGuard`; the guard owns the transaction rather than accepting one |
| **Detection** | Zero suppressions where overlap is expected — pages |
| **Recovery** | Reconcile affected projections; fix the consumer |
| **Owner** | Tech lead |

### T4 · Migration failure at production volume

| | |
|---|---|
| **Description** | A migration verified against seed data locks or times out against 10⁸ rows |
| **Impact** | High — write outage |
| **Likelihood** | Medium |
| **Mitigation** | Staging runs production-shaped volume; index builds concurrent and outside deploys; duration estimated in CI |
| **Detection** | Migration duration exceeding its window pages |
| **Recovery** | **Roll forward** — migrations are not rolled back |
| **Owner** | Tech lead |

---

## Security risks

**Framed as implementation failure, not attack.** The adversarial view is `16-security/threat-model.md`.

### S1 · A control shipped but never verified

| | |
|---|---|
| **Description** | A control exists in code, is never exercised, and does not work |
| **Impact** | **Critical** — false assurance is worse than a known gap |
| **Likelihood** | Medium |
| **Mitigation** | Denial-path tests per endpoint; cross-tenant assertion per table; **threat-model detection coverage measured, not assumed** |
| **Detection** | Coverage gate at 100%; a threat with no signal is a labelled accepted risk |
| **Recovery** | Implement the test; assess exposure via audit |
| **Owner** | Security owner |

### S2 · A secret reaches a log, event, or prompt

| | |
|---|---|
| **Description** | A credential appears in an observable surface |
| **Impact** | **Critical** — provider or database compromise |
| **Likelihood** | Low |
| **Mitigation** | **`SecretValue.toString()`/`toJSON()` return `[REDACTED]`**; allowlisted log serialization; registry rejects credential-patterned event fields; **structural exclusion from the Context Builder** |
| **Detection** | `redaction_pattern_hits_total`; committed-secret scan on diff **and history** |
| **Recovery** | **Emergency rotation without overlap** |
| **Owner** | Security owner |

### S3 · A local shortcut reaches production

| | |
|---|---|
| **Description** | A development convenience — disabled auth, skipped validation — ships |
| **Impact** | **Critical** |
| **Likelihood** | **Low** — no such flag exists |
| **Mitigation** | Auth, authorization, RLS, tenant scoping, the outbox, scanning, and validation are **never disabled in any environment**; no configuration flag can disable them; `nodeEnv=production` rejects dummy secrets |
| **Detection** | Conformance; `tenant_context_missing_total` must be zero |
| **Recovery** | Patch and audit for prior exposure |
| **Owner** | Security owner |

---

## AI risks

### AI1 · Prompt injection is not fully solvable

| | |
|---|---|
| **Description** | Instructions in fetched content influence model behaviour |
| **Impact** | Medium — content quality; **not secret disclosure** |
| **Likelihood** | **High** — it will be attempted |
| **Mitigation** | Consequences bounded: **secrets structurally absent from prompts**, no side effect reachable from source text, grounding requires evidence anchors |
| **Detection** | Guardrail block rate; credential patterns in output; grounding failures |
| **Recovery** | Block the source; re-run affected generations |
| **Owner** | Security owner |

**The residual is stated rather than mitigated away** (`16-security/threat-model.md` T-14).

### AI2 · Cost overrun

| | |
|---|---|
| **Description** | Model spend exceeds unit economics |
| **Impact** | **High** — margin |
| **Likelihood** | **High** without controls |
| **Mitigation** | Per-call budgets; credits charged atomically with holds; **Council budget capped**; semantic cache |
| **Detection** | Cost per tenant against baseline; **cost is a closed-beta gate** |
| **Recovery** | Throttle; adjust routing policy; reprice |
| **Owner** | Product owner |

### AI3 · Provider deprecation or behaviour change

| | |
|---|---|
| **Description** | A model is retired or its behaviour shifts |
| **Impact** | Medium |
| **Likelihood** | **High** — routine in this market |
| **Mitigation** | Providers behind stable interfaces (ADR-010, ADR-012); **no model named in architecture or API**; routing is policy |
| **Detection** | Evaluation regression; provider deprecation notices |
| **Recovery** | Update routing policy — **no code change** |
| **Owner** | Tech lead |

### AI4 · Output quality below the product bar

| | |
|---|---|
| **Description** | Generated content does not meet the quality the product promises |
| **Impact** | **High** — the product's core value |
| **Likelihood** | Medium |
| **Mitigation** | Quality gates with three verdicts; grounding invariant; AI Council for high-stakes evaluation |
| **Detection** | Gate block rate; evaluation harness; design-partner feedback |
| **Recovery** | Prompt and policy iteration — behind flags |
| **Owner** | Product owner |

---

## Operational risks

### O1 · Untested recovery

| | |
|---|---|
| **Description** | Backups exist and have never been restored |
| **Impact** | **Critical** — unrecoverable data loss |
| **Likelihood** | Medium |
| **Mitigation** | **Weekly restore tests; quarterly DR drill** — both exit criteria, not plans |
| **Detection** | `verified_backup_age_seconds` — **never completion age** |
| **Recovery** | None if it fails when needed |
| **Owner** | Ops owner |

### O2 · Alert fatigue

| | |
|---|---|
| **Description** | Too many alerts; real ones ignored |
| **Impact** | High — detection exists and is not acted on |
| **Likelihood** | Medium |
| **Mitigation** | **Invariant alerts separated from SLO alerts**; the invariant board reads zero with no thresholds to interpret |
| **Detection** | Alert volume; acknowledgement latency |
| **Recovery** | Tune SLO alerts; **never suppress an invariant** |
| **Owner** | Ops owner |

### O3 · On-call not ready at open beta

| | |
|---|---|
| **Description** | Rotation exists; runbooks untested |
| **Impact** | High — long incidents |
| **Likelihood** | Medium |
| **Mitigation** | Runbook entries are a Definition of Done criterion; incident response rehearsed in Sprint 7 |
| **Detection** | Time to detect and contain, measured |
| **Recovery** | Escalate; write the missing runbook in the postmortem |
| **Owner** | Ops owner |

---

## Performance risks

### P1 · Pipeline duration exceeds tolerance

| | |
|---|---|
| **Description** | A run takes longer than users will wait |
| **Impact** | Medium |
| **Likelihood** | Medium |
| **Mitigation** | Durable resumable runs; progress visible; **human gates are explicit rather than hidden waits** |
| **Detection** | Per-stage latency; time-to-available |
| **Recovery** | Parallelize stages; adjust depth |
| **Owner** | Tech lead |

### P2 · pgvector at scale

| | |
|---|---|
| **Description** | Vector search degrades as the corpus grows |
| **Impact** | Medium |
| **Likelihood** | Medium |
| **Mitigation** | **ADR-006 accepts the migration to Qdrant at documented thresholds**; embeddings are derived and regenerable |
| **Detection** | Retrieval latency against SLO; scaling triggers |
| **Recovery** | Execute the accepted migration |
| **Owner** | Architect |

### P3 · Connection pool exhaustion

| | |
|---|---|
| **Description** | Worker fleets exhaust the pool before CPU |
| **Impact** | High — platform-wide |
| **Likelihood** | Medium |
| **Mitigation** | **Worker concurrency derived from pool size, not chosen freely**; transaction pooling |
| **Detection** | Pool saturation; `authz_fail_closed_total` |
| **Recovery** | Reduce concurrency; scale the pooler |
| **Owner** | Ops owner |

---

## Infrastructure and dependency risks

| ID | Risk | Impact | Likelihood | Mitigation | Owner |
|---|---|---|---|---|---|
| **I1** | **Single-region; 8-hour RTO for regional loss** | High | Low | Accepted and stated; active-active would be a different architecture requiring an ADR | Architect |
| **I2** | **Single-region KMS blocks recovery** | **Critical** | Low | **Multi-region KMS is a hard prerequisite** for the stated RTO | Ops owner |
| I3 | Provider outage | Medium | High | Circuit breaker; degradation defined per provider; **evidence never fabricated** | Tech lead |
| **D1** | **Zero-day in a trusted dependency** | High | Medium | **Detectable, not preventable**; runtime egress restrictions bound exfiltration | Security owner |
| D2 | Supply-chain compromise | Critical | Low | Signed commits; ephemeral CI credentials; **`ignore-scripts` by default**; provenance attestation | Security owner |
| D3 | Provider API breaking change | Medium | Medium | Provider Layer; recorded fixtures detect drift | Tech lead |

**I2 is the one most likely to be discovered too late.** A restore into a region where the KMS is unavailable produces a running system full of unreadable ciphertext — and it looks like it succeeded (`12-storage-platform/disaster-recovery.md`).

---

## Cost risks

| ID | Risk | Impact | Likelihood | Mitigation | Detection | Owner |
|---|---|---|---|---|---|---|
| **C1** | **Unit economics unknown until closed beta** | High | Medium | Cost attribution per tenant from Sprint 3; **cost is a closed-beta gate** | Estimated cost reconciled monthly against the provider bill | Product owner |
| C2 | Storage growth unbounded | Medium | Medium | Retention policies; GC; derived assets excluded from backup | Growth rate versus content creation rate | Ops owner |
| C3 | Semantic cache ineffective | Medium | Medium | Cache is the largest cost lever; hit ratio monitored | Cache hit ratio; cost per operation | Tech lead |

**C1's mitigation is a gate, not a measurement.** A unit economics problem found at open beta is a pricing crisis; found at closed beta it is a tuning exercise.

---

## Schedule risks

### SC1 · Sprint 1 is oversized

| | |
|---|---|
| **Description** | Event Platform + tenancy + Platform services in one sprint |
| **Impact** | Medium |
| **Likelihood** | **High** — stated, not discovered |
| **Mitigation** | **The 1a/1b split, decided at Sprint 1 planning** |
| **Detection** | Sprint 0 velocity |
| **Recovery** | Split; order within does not change |
| **Owner** | Tech lead |

### SC2 · The critical path does not parallelize

| | |
|---|---|
| **Description** | Nine serial nodes; adding people does not shorten it |
| **Impact** | High — schedule is bounded by dependency, not capacity |
| **Likelihood** | **Certain** — a property, not a risk event |
| **Mitigation** | Off-path tracks absorb additional capacity; UI runs from Sprint 0 |
| **Detection** | Exit criteria met on time |
| **Recovery** | Reduce scope, never reorder dependencies |
| **Owner** | Tech lead |

### SC3 · Specification completeness creates false estimate confidence

| | |
|---|---|
| **Description** | Behaviour is specified, so estimates feel certain — but **integration is where uncertainty lives** |
| **Impact** | Medium |
| **Likelihood** | Medium |
| **Mitigation** | **Size the integration, not the implementation**; widen estimates at the three integration-first points |
| **Detection** | Carry-forward count; criteria missed |
| **Recovery** | Re-estimate; escalate on a second miss |
| **Owner** | Tech lead |

---

## Top five, ranked

| Rank | Risk | Why |
|---|---|---|
| **1** | **A1 — ADR-022 unaccepted** | Blocks Sprint 0; currently true |
| **2** | **T1 — RLS with no symptom** | Critical impact; the conformance suite is the entire defence |
| **3** | **I2 — single-region KMS** | Critical, silent, and discovered during recovery |
| **4** | **AI2 — cost overrun** | High likelihood without controls; affects viability |
| **5** | **O1 — untested recovery** | Unrecoverable when it matters |

**Four of five are mitigated by something that must exist early** — an ADR decision, a Sprint 0 test suite, an infrastructure prerequisite, and a Sprint 3 measurement. None is mitigated by working harder later.

## Business rules

1. **This register is delivery risk**; `16-security/threat-model.md` owns adversarial threat.
2. **Every risk has a named owner role.**
3. **Residual risk is stated, never mitigated away in prose** — AI1 and D1 are not solvable.
4. **Mitigations reference an implemented control**, or the risk is unmitigated and says so.
5. **Detection signals are named metrics**, not intentions.
6. **The register is reviewed at each sprint planning** and at each release stage.
7. **A risk realised becomes a postmortem finding** and updates this register.

## Cross references

- `16-security/threat-model.md` — **the adversarial register, 26 threats**
- `16-security/row-level-security.md` — the six symptomless failure modes
- `16-security/secrets-management.md` — redaction and emergency rotation
- `12-storage-platform/disaster-recovery.md` — the multi-region KMS prerequisite
- `12-storage-platform/backups.md` — verified backup age
- `13-event-platform/` — outbox, ordering, idempotency
- `08-ai-platform/` — cost, guardrails, provider abstraction
- `01-system-architecture/13-adr-log.md` — ADR-006, ADR-010, ADR-016, ADR-022
- `implementation-order.md` · `sprint-planning.md` — where mitigations are scheduled
- `testing-roadmap.md` — the suites several mitigations depend on
