# Git Workflow — Superseded

> **This document has been superseded.**

**Replacement document:** `07-development-guide/ci-cd.md`

**Replacement section:** **§Source control workflow**, with the release path in `deployment-guide.md`.

| Original intent | Now specified in |
|---|---|
| Branching model | `ci-cd.md` §Source control workflow |
| Commit message conventions | `ci-cd.md` §Source control workflow — Conventional Commits, signed |
| PR process and branch protection | `ci-cd.md` §Source control workflow and §Gate summary |
| CI gate contract | **`10-testing/testing-strategy.md` §9** — authoritative, referenced never restated |
| Release/promotion handoff | `deployment-guide.md` §Environment promotion → `14-operations/deployment.md` |
| Release and versioning strategy | `deployment-guide.md` §Build and artifact; `06-api/api-versioning.md` for the API surface |
| Hotfix path | `ci-cd.md` §Source control workflow |

## Migration note

**The hotfix rule is stated explicitly in the replacement and is worth carrying forward:** hotfixes use the same pipeline as any other change. There is no expedited path that skips gates, because the changes most likely to break production are the ones written fastest.

The CI gate contract remains owned by `10-testing/testing-strategy.md` §9, exactly as this placeholder instructed. `ci-cd.md` composes the pipeline and references those thresholds; it does not redefine them.
