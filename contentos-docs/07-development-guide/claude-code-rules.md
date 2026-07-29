# Claude Code Rules — Superseded

> **This document has been superseded.**

**Replacement document:** `07-development-guide/implementation-checklists.md`

**Replacement section:** **Part 1 — Rules for AI coding agents**, which is binding on every agent-authored change.

| Original intent | Now specified in |
|---|---|
| Source-of-truth rule: implement only documented architecture | Part 1 §The source-of-truth rule |
| Boundary rules: import direction; engines communicate via contracts | Part 1 §Invariants an agent must never break; `project-structure.md` §Import direction |
| AI egress rule: models reached only through the AI Gateway | Part 1 §Invariants (ADR-019) |
| Tenancy rule: `tenant_id` plus an RLS policy on every table | Part 1 §Invariants; `16-security/row-level-security.md` |
| Open questions: request a decision, never assume one | Part 1 §The source-of-truth rule — five-row decision table |
| Change process: architectural changes only via ADRs | Part 1 §The change-process rule |
| Definition of done | Part 1 §Definition of done |

## Migration note

Part 1 adds two rules this placeholder did not enumerate, both specific to agent-authored work:

- **Never weaken a failing test.** Deleting, skipping, loosening an assertion, or adding a lint exclusion converts a caught defect into a shipped one.
- **Never bypass a gate.** Coverage exclusions, `eslint-disable`, `@ts-expect-error`, and pipeline skips each require an explicit, reviewed justification.

The source-of-truth rule is also stated more precisely than "never invent architecture": unspecified, ambiguous, apparently-wrong, and mutually-contradictory situations each have a distinct prescribed action, and three of the four are **stop and ask**.
