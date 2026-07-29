# Folder Structure — Superseded

> **This document has been superseded.**

**Replacement document:** `07-development-guide/project-structure.md`

**Replacement sections:**

| Original intent | Now specified in |
|---|---|
| Monorepo layout | `project-structure.md` §Canonical layout — **frozen** |
| Boundary rules and import direction | `project-structure.md` §Import direction |
| Provider SDK containment; AI Gateway as sole model egress | `project-structure.md` §Banned imports |
| Decision table: where new code goes | `project-structure.md` §Where new code goes |
| Enforcement via lint rules in CI | `project-structure.md` §Enforcement; gates in `ci-cd.md` §Stage 2 |

## Migration note

**Five approved documents still reference this filename.** They resolve to a supersession notice rather than a specification until their references are updated to `project-structure.md`.

**`project-structure.md` records a naming reconciliation** in its §Naming drift with approved documents: four package names used in earlier approved documents — `packages/db`, `packages/engines`, `packages/config`, `tooling/test` — differ from the frozen layout. The coverage thresholds in `10-testing/testing-strategy.md` §9 remain authoritative and apply to the packages under their frozen names.
