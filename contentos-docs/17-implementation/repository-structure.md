# Repository Structure

> **Status:** v1.0 — complete. Phase 16.
> **The layout is frozen in `07-development-guide/project-structure.md` and is not redefined here.** This document says which parts exist at bootstrap, which arrive per sprint, and how the boundary enforcement is wired.

## Overview

**Purpose.** Describe the repository as it is built: what Sprint 0 creates, what each later sprint adds, and how the frozen layout's rules become executable checks.

**Scope.** Sequencing and tooling configuration. Package boundaries, import direction, and banned imports are specified in `07-development-guide/project-structure.md` and are cited, never restated.

## The frozen layout, as sequenced

```
contentos/
├── apps/web · apps/admin
├── services/api
├── workers/host
├── packages/
│   ├── contracts · domain · database · security
│   ├── events · storage · platform
│   ├── ai · knowledge · content
│   ├── integrations · observability
├── infrastructure/ · scripts/ · tests/ · docs/
```

| Package | Created in | Reason |
|---|---|---|
| `contracts` | **Sprint 0** | Zero dependencies; everything imports it |
| `database` | **Sprint 0** | Schema, migrations, RLS policies |
| `security` | **Sprint 0** | `TenantContext`, authn, authz, audit |
| `observability` | Sprint 0 | Logging and tracing from the first commit |
| `events` | **Sprint 1** | Outbox, bus, consumers |
| `platform` | Sprint 1 | Billing, credits, rate limiting, notifications |
| `storage` | Sprint 2 | Objects, media, drivers |
| `knowledge` | Sprint 2 | Evidence, entities, retrieval |
| `ai` | Sprint 3 | Gateway, guardrails, council |
| `content` | Sprint 4 | The engines |
| `integrations` | Sprint 2 | Providers, as each is needed |
| `apps/web` | **Sprint 0** | Shell against frozen contracts |
| `apps/admin` | Sprint 6 | Operator console |
| `services/api` | Sprint 0 | The only inbound surface |
| `workers/host` | Sprint 1 | Arrives with the Event Platform |

**`contracts` is created first and has zero dependencies.** It holds the event envelope, the scoring contract, and shared identifier types, and is imported by every layer including the browser bundle. One dependency on `database` would pull Drizzle into the frontend build.

**`apps/web` is scaffolded in Sprint 0** despite having no backend, because the API is frozen and the UI track is the largest parallelization opportunity (`implementation-strategy.md`).

**A package is created when its first real code lands**, not preemptively. An empty package with a `package.json` is a boundary nobody is testing.

## Sprint 0 scaffold

**What exists after bootstrap and before any feature:**

```
contentos/
├── apps/web/              # shell, design tokens, routing
├── services/api/          # bootstrap, health, config, pipeline middleware
├── packages/
│   ├── contracts/         # envelope, score, branded ids
│   ├── database/          # schema, first migrations, RLS policies
│   ├── security/          # TenantContext, authn, authz, audit
│   └── observability/     # logger, tracer, metrics
├── infrastructure/
│   ├── containers/        # compose for local
│   └── environments/      # non-secret config
├── scripts/dev · db · ci
├── tests/conformance/     # RLS suite — exists before tables accumulate
└── docs/                  # this tree
```

**`tests/conformance/` exists in Sprint 0 with the RLS suite already running.** It enumerates `information_schema` and cross-references the isolation test registry, so a table added in Sprint 1 without a policy fails the build immediately rather than accumulating debt (`10-testing/testing-strategy.md`).

**The pipeline middleware exists before the endpoints do.** Size limits, rate limiting, authentication, CSRF, validation, tenant resolution, and authorization are ordered once in `services/api` — a later endpoint inherits them rather than re-implementing them (`16-security/api-security.md`).

## Package internals

**Every package follows the same shape**, specified in `07-development-guide/project-structure.md`:

```
packages/<name>/
├── src/
│   ├── index.ts          # the ONLY barrel — the public surface
│   ├── <feature>/
│   │   ├── <thing>.ts
│   │   ├── <thing>.test.ts
│   │   └── internal/     # not exported
│   └── types.ts
├── package.json          # exports field blocks deep imports
└── README.md             # names its specifying architecture document
```

**Every package README names its specifying document in the first line.** A developer or agent opening `packages/events` reaches `13-event-platform/` in one hop rather than searching.

**`exports` in `package.json` blocks deep imports**, so `@contentos/storage/src/internal/thing` fails to resolve rather than merely failing review.

## Boundary enforcement, wired

**Four independent mechanisms, configured in Sprint 0**, because each catches what the others miss.

| Mechanism | Catches | Config location |
|---|---|---|
| TypeScript project references | Unresolvable cross-package imports | `tsconfig.json` per package |
| `package.json` `exports` | Deep imports past the public surface | Each package |
| `no-restricted-imports` | **A provider SDK outside its permitted package** | Root ESLint config |
| `dependency-cruiser` | **Illegal layer direction, cycles** | `.dependency-cruiser.js` |

**All four block the build; none warns.** A boundary rule enforced by a warning erodes at exactly the rate people are busy (`07-development-guide/ci-cd.md`).

**The banned-import table is configured from `07-development-guide/project-structure.md` verbatim** — S3 SDKs only in `packages/storage/src/drivers/**`, model providers only in `packages/ai/src/providers/**`, Drizzle only in `packages/database/**`, raw customer-URL `fetch` only in the `SafeUrlFetcher` module.

**The `SafeUrlFetcher` restriction is configured in Sprint 0** even though no provider fetch exists yet, because adding the rule after the first `fetch` lands means auditing every call site (`16-security/api-security.md`).

**Custom lint rules ship in Sprint 0**: `ctx: TenantContext` first, duration naming (`ttlSeconds`, never `ttl`), no floating promises, no cross-package relative imports.

## Tooling configuration

| Tool | Configured | Notes |
|---|---|---|
| pnpm workspaces | Sprint 0 | Strict, non-flat `node_modules` |
| TypeScript | Sprint 0 | `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` |
| ESLint | Sprint 0 | Including the custom rules above |
| Prettier | Sprint 0 | **Not configurable per package** |
| `dependency-cruiser` | Sprint 0 | Layer map, including unmapped-package default |
| `knip` | Sprint 0 | Unused dependencies, exports, files |
| Vitest | Sprint 0 | Unit and integration |
| Playwright | Sprint 1 | E2E, once auth exists |
| Drizzle Kit | Sprint 0 | Per ADR-022 |

**Every version is pinned exactly; no ranges anywhere** (`07-development-guide/dependency-management.md`).

**`ignore-scripts` is enabled from the first install**, with an allowlist that starts empty. Adding the control after dependencies accumulate means auditing every existing `postinstall`.

**An unmapped package defaults to the most restrictive layer** — it may import only `contracts` — so a new package fails loudly rather than importing freely.

## Naming reconciliation carried forward

**`07-development-guide/project-structure.md` records four package names used in earlier approved documents that differ from the frozen layout.** The implementation uses the frozen names:

| Referenced elsewhere | Built as |
|---|---|
| `packages/db` | **`packages/database`** |
| `packages/engines/*` | **`packages/content`** |
| `packages/config` | Config module inside `packages/platform` |
| `tooling/test` | `tests/` + per-package fixtures |

**`10-testing/testing-strategy.md` §9 remains authoritative on coverage thresholds** — ≥ 85% lines in the engine and contracts packages, ≥ 70% elsewhere, none on `apps/web` — and the CI configuration applies them to the packages under their frozen names.

**This is a configuration detail, not an architectural change.** The mapping is recorded in the approved document and is implemented as recorded.

## Environments and secrets in the repository

| Path | Contains |
|---|---|
| `infrastructure/environments/` | **Non-secret configuration and secret *names*** |
| `infrastructure/containers/` | Dockerfiles, local compose |
| `infrastructure/monitoring/` | Dashboards and alerts as code |
| `.env.example` | Local-only template, no real values |

**No secret ever appears in `infrastructure/`**, enforced by a committed-secret scan on every commit and on history (`07-development-guide/ci-cd.md`).

**`.env` is loaded only in local development.** A deployed process that reads a `.env` file will eventually read one left in an image (`07-development-guide/configuration.md`).

**Dashboards and alerts are code from Sprint 0.** A dashboard configured by hand is lost on provider migration and drifts from the metric names the platform actually emits.

## Growth expectations

| Sprint | Packages | Notes |
|---|---|---|
| 0 | 4 + 2 apps + 1 service | Substrate |
| 1 | +2 | Events, platform; `workers/host` |
| 2 | +3 | Storage, knowledge, integrations |
| 3 | +1 | AI |
| 4 | +1 | Content |
| 6 | — | `apps/admin` |

**Twelve packages, two apps, one service, one worker host — the layout as frozen.** No package is added beyond it without an ADR, because a new package layer is an architectural change (`07-development-guide/project-structure.md`).

**New code inside an existing package needs no ceremony.** The decision table in the frozen layout answers where it goes, and its last row is the one that prevents drift: code used by exactly one package belongs to that package's `internal/` until a second caller genuinely exists.

## Business rules

1. **The layout is frozen**; this document sequences it and configures its enforcement.
2. **`contracts` is created first with zero dependencies.**
3. **A package is created when its first real code lands.**
4. **`apps/web` is scaffolded in Sprint 0** against frozen API contracts.
5. **`tests/conformance/` and the RLS suite exist in Sprint 0**, before tables accumulate.
6. **The request pipeline exists before the endpoints.**
7. **All four boundary mechanisms are configured in Sprint 0 and block the build.**
8. **`SafeUrlFetcher` and `ignore-scripts` restrictions are configured before they are needed.**
9. **An unmapped package defaults to the most restrictive layer.**
10. **Every package README names its specifying document.**
11. **Exact dependency versions; no ranges.**
12. **Frozen package names are used**; the four-way mapping is honoured in CI configuration.
13. **No secret in `infrastructure/`**, enforced by scan.
14. **Dashboards and alerts are code from Sprint 0.**
15. **Twelve packages; a thirteenth layer requires an ADR.**

## Cross references

- `07-development-guide/project-structure.md` — **the frozen layout, import direction, banned imports, the decision table**
- `07-development-guide/dependency-management.md` — pinning, install scripts, licences
- `07-development-guide/coding-standards.md` — the custom lint rules configured here
- `07-development-guide/ci-cd.md` — gate wiring and blocking behaviour
- `07-development-guide/configuration.md` — `.env` policy, environment values
- `07-development-guide/local-development.md` — what bootstrap produces locally
- `10-testing/testing-strategy.md` — coverage thresholds applied to frozen names
- `16-security/api-security.md` — the pipeline and `SafeUrlFetcher`
- `16-security/row-level-security.md` — the conformance suite
- `repository-bootstrap.md` — the developer path through this structure
- `implementation-order.md` — the sprints that populate it
