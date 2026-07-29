# Code Review

> **Status:** v1.0 — complete. Phase 11.
> **Review what automation cannot check.** Formatting, import direction, coverage, and licences are already gated. A reviewer spending attention on those has none left for the thing only a human catches: a change that works correctly and quietly contradicts the architecture.

## Overview

**Purpose.** Define what reviewers are accountable for, which changes require additional review, and how architectural drift is caught before it merges.

**The premise.** By the time a PR reaches a human, the pipeline has already verified types, lint, boundaries, coverage, contracts, secrets, licences, and migration compatibility (`ci-cd.md`). Review exists for judgement: does this belong here, does it match what the architecture says, will the next person understand it, and does it fail safely.

**Reviewers never approve undocumented architectural drift.** A change that alters a boundary, an ownership rule, or an invariant requires an ADR first — not a comment noting the divergence, and not a promise to document it later.

## What is already automated

| Verified by CI | Not a review topic |
|---|---|
| Formatting | Prettier is authoritative; style comments are noise |
| Types, lint, custom rules | Including `ctx`-first and duration naming |
| Import direction, banned imports | `dependency-cruiser` and `no-restricted-imports` |
| Coverage thresholds | `10-testing/testing-strategy.md` §9 |
| RLS coverage per table | Enumerated from the live schema |
| Contract and interface drift | Registry-backed |
| Secrets, licences, vulnerabilities | Scanned |
| Migration backward compatibility | Previous release's tests against the new schema |

**A reviewer commenting on formatting has misread their role.** If something mechanical is worth enforcing, it becomes a rule; until then it is not review material.

## Review dimensions

### 1 · Architecture — the primary responsibility

| Question | Why it matters |
|---|---|
| Does this match the specifying document? | The tree is the source of truth |
| Does it cross a boundary the architecture forbids? | Engines never call each other's databases |
| Does it introduce a new dependency direction? | Layering survives only if enforced |
| Does it duplicate something another platform owns? | Duplicate ownership drifts |
| **Does it change a decision recorded in an ADR?** | **Requires a new ADR first** |
| Does it add a component with no home in the docs? | Undocumented components accumulate |

**Architectural drift is the finding automation cannot produce**, because drifted code compiles, passes tests, and works. A caching layer added inside an engine because it was convenient; a direct provider call that bypasses the AI Gateway; a background job reading another engine's tables. Each is locally reasonable and globally wrong.

**The reviewer's question is "where is this specified?"** If the answer is "nowhere," the change either needs a document or should not exist. If the answer contradicts an existing document, the change stops until the document changes through an ADR.

**Every PR touching platform behaviour references the affected documentation** in its description. Where a change alters documented behaviour, the documentation change ships in the same PR.

### 2 · Security

**Security-sensitive changes require an explicit named reviewer** from the security-owning group, in addition to normal approval.

| Triggers explicit security review |
|---|
| Authentication, authorization, or session handling |
| RLS policies, tenant context, or anything in `packages/security` |
| Cryptography, key handling, secret access |
| A new external egress path or a customer-supplied URL |
| File upload, media processing, or content parsing |
| A new event type carrying identifiers |
| Anything in the RLS exception set |
| Deploy, migration, or CI workflow files |

| Question | Anchor |
|---|---|
| Is `TenantContext` established from identity and resource, never from payload? | `16-security/tenant-isolation.md` |
| Are new tables `tenant_id`-carrying with a policy and an isolation test? | `16-security/row-level-security.md` |
| Does any denial path leak existence? 404 across tenants, 403 within | `16-security/authorization.md` |
| Could any new field carry a secret into a log, event, or prompt? | `16-security/secrets-management.md` |
| Is customer-supplied URL fetching routed through `SafeUrlFetcher`? | `16-security/api-security.md` |
| Are new permissions explicit, with no wildcard and no implication? | `16-security/rbac.md` |
| Is the audit record written in the same transaction as the action? | `16-security/audit.md` |

**"Could this field carry a secret?" is the question that catches the most.** A new event payload field, a new log field, a new prompt input — each is a path to a place secrets must never reach, and each looks harmless in isolation.

### 3 · Correctness

| Question |
|---|
| Are error paths handled, or only the happy path? |
| Is every failure typed with a stable code and correct retryability? |
| Are concurrent callers safe — is the invariant enforced in the database? |
| Is the operation idempotent where it will be redelivered? |
| Does anything swallow an exception or float a promise? |
| Are boundary conditions covered — empty, single, maximum, null? |

**"Is the invariant enforced in the database?" is the question that separates durable correctness from hopeful correctness.** An application-level check has a race window; a `UNIQUE` constraint does not. The tree has consistently pushed invariants downward, and review is where a new one gets placed correctly (`03-database/tables.md`).

**Idempotency is asked wherever an operation is event-driven.** At-least-once delivery makes redelivery certain, not hypothetical (`13-event-platform/idempotency.md`).

### 4 · Error handling

| Question | Anchor |
|---|---|
| Does every error subclass `PlatformError` with a stable code? | `error-handling.md` |
| Is `retryability` correct — would retrying plausibly help? | `13-event-platform/retry-engine.md` |
| Is any terminal failure classified as transient? | Guardrail, validation, schema, unknown type, authorization |
| Does any internal detail reach a response? | `16-security/api-security.md` |
| Is the error logged once, at the handling boundary? | `logging-guide.md` |

**Misclassifying a terminal failure as transient is the most damaging error-handling defect available.** It multiplies load on a failing dependency, delays the operator signal, and in the guardrail case re-attempts something the platform has already refused.

### 5 · Performance

| Question |
|---|
| Is any query unbounded, or missing a `tenant_id`-leading index? |
| Any N+1 across a collection? |
| Is pagination cursor-based rather than offset? |
| Is independent async work parallelized? |
| Does any hot path add a network round trip that could be avoided? |
| Are new metric labels bounded — no `tenant_id`, no ids? |

**Metric cardinality is reviewed because it fails catastrophically and late.** A `tenant_id` label multiplies every series by the customer count and takes down the metrics backend before the platform notices (`16-security/security-observability.md`).

### 6 · Observability

| Question |
|---|
| Can this failure be diagnosed from telemetry alone? |
| Does every record carry `correlationId`? |
| Are new metrics named per the owning platform's frozen catalogue? |
| Do invariant-class signals route to the breach path, not an ordinary counter? |
| Is anything logged that must not be? |

**"Could I diagnose this at 3am from telemetry alone?" is the framing question.** Code that works and cannot be observed becomes an incident nobody can shorten.

### 7 · API and contract compatibility

| Question | Anchor |
|---|---|
| Is this a compatible change, or does it need a new version? | `13-event-platform/versioning.md` |
| Does it change the meaning of a field while keeping its shape? | **Breaking** — every check passes and every consumer breaks |
| Would an old consumer still work? | Downcast must be possible |
| Is a frozen interface signature altered? | Requires the owning document's update |

**Changing meaning while keeping shape is the most dangerous change in the platform**, because no automated check catches it. `ArticlePublished` shifting from "published to CMS" to "queued for publication" is schema-identical and breaks every consumer.

### 8 · Testing

| Question |
|---|
| Would these tests fail if the code were wrong, or only if it threw? |
| Are denial and failure paths tested, not just success? |
| Any time, randomness, ordering, or sleep dependency? |
| Are fakes preferred to mocks; is the database real? |
| Does each test create its own tenant? |

**"Would this fail if the code were wrong?" catches the most useless tests** — those asserting a function returns without throwing (`testing-guide.md`).

### 9 · Maintainability and documentation

| Question |
|---|
| Will this be understandable in six months without the author? |
| Is the abstraction earned by two real callers, or speculative? |
| Do comments explain **why**, citing a source document for non-obvious constraints? |
| Is affected documentation updated in this PR? |
| Any TODO, commented-out code, or dead export? |

**Speculative abstraction is worth pushing back on.** A generic interface with one implementation is a guess about the future that constrains the present; the second real caller is when the abstraction is earned.

## Depth by risk

| Change | Reviewers | Depth |
|---|---|---|
| Formatting, comments, docs | 1 | Light |
| Bug fix, isolated | 1 | Standard |
| New feature | 1 | Full checklist |
| **Security-sensitive** | **2, one named security reviewer** | Full + security |
| **Schema migration** | **2, one database owner** | Full + migration |
| **New event type or version** | **2, one contract owner** | Full + compatibility |
| **Architecture-affecting** | **2 + ADR approved first** | Full + ADR |
| CI workflow, deploy config | 2, one code owner | Full + security |

**CODEOWNERS enforces the second reviewer** on security, database, contract, and workflow paths, so the requirement is mechanical rather than remembered.

**An architecture-affecting change without an approved ADR is closed, not reviewed.** Reviewing it invites negotiating architecture in a PR thread, which is how decisions get made without a record.

## Authoring for review

| Rule |
|---|
| PRs are small — one logical change |
| The description states **what, why, and which documents are affected** |
| Non-obvious decisions are called out by the author |
| Self-review before requesting review |
| All CI gates green before review is requested |
| Behavioural changes list how they were verified |

**Requesting review with a red pipeline wastes a reviewer's time on findings the machine already produced.**

**The author calling out their own uncertainty is the highest-value line in a description** — it directs attention where it is most needed, and reviewers routinely miss what authors already suspect.

## Conduct

| Practice |
|---|
| Comment on code, never the author |
| Distinguish blocking from non-blocking; label the latter `nit:` |
| Explain the reasoning, or link the rule |
| Approve when it is good enough, not when it is what you'd have written |
| Escalate design disagreements out of the thread |
| Reviewers respond within one business day |

**"Approve when it is good enough" is a real standard, not a concession.** Withholding approval over preference converts review into a bottleneck, and a slow review process gets routed around.

**Design disagreements move out of the PR thread.** A thread is a poor medium for an architectural argument, and the outcome belongs in an ADR where it is discoverable.

## Business rules

1. **Reviewers never approve undocumented architectural drift.**
2. **Architecture-affecting changes require an approved ADR first.**
3. **Security-sensitive changes require a named security reviewer.**
4. **CODEOWNERS enforces second reviewers mechanically.**
5. **PRs reference affected platform documentation.**
6. **Documentation changes ship in the PR that changes behaviour.**
7. **Automation-covered concerns are not review topics.**
8. **All gates green before review is requested.**
9. **Every error is checked for correct retryability classification.**
10. **New tables are checked for `tenant_id`, policy, and isolation test.**
11. **New payload, log, and prompt fields are checked for secret exposure.**
12. **Metric labels are checked for cardinality.**
13. **Meaning changes are treated as breaking**, regardless of shape.
14. **Tests are reviewed for whether they would fail on wrong code.**
15. **Speculative abstraction is challenged.**
16. **Design disagreements move to an ADR.**

## The reviewer's minimum

Three questions, asked on every PR regardless of size:

1. **Where is this specified, and does it match?**
2. **What happens when this fails?**
3. **Could this expose one tenant's data to another?**

**The third is asked even on changes that appear unrelated to tenancy**, because the leaks that matter come from cache keys, log fields, and search filters rather than from code that looks security-relevant (`16-security/tenant-isolation.md`).

## Observability

- **Metrics:** `pull_requests_total{outcome}`, `time_to_first_review_seconds`, `time_to_merge_seconds`, `review_iterations`, `post_merge_defects_total{severity}`, `adr_required_blocks_total`.
- **Alerts:** `time_to_first_review_seconds` p95 above one business day (review is a bottleneck and will be routed around); `post_merge_defects_total` rising (review or gates are insufficient); `adr_required_blocks_total` rising (architectural pressure is building — the docs may be wrong, not the changes).

**A rising ADR-block count is a signal about the architecture, not about the developers.** Repeated attempts to cross the same boundary usually mean the boundary is in the wrong place, and that belongs in an open question rather than in repeated rejections.

## Cross references

- `ci-cd.md` — what automation already gates
- `coding-standards.md` — the conventions reviewed against
- `project-structure.md` — boundaries and where code belongs
- `error-handling.md` — codes and retryability classification
- `testing-guide.md` — the test review criteria
- `logging-guide.md` — what must never be logged
- `migration-guide.md` — the migration review path
- `implementation-checklists.md` — rules for AI coding agents
- `01-system-architecture/13-adr-log.md` — **the only path to architectural change**
- `99-open-questions.md` — where unresolved tension is recorded
- `16-security/` — every security anchor referenced above
- `13-event-platform/versioning.md` — compatible versus breaking
- `10-testing/testing-strategy.md` — coverage and gate contract
