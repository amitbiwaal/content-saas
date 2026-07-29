# Local Development

> **Status:** v1.0 — complete. Phase 11.
> **Local runs the same architecture as production, with the same controls on.** Authentication, RLS, tenant scoping, and the real event bus are all live. A shortcut that disables one produces code paths tested only with it off — and the shortcut always reaches production eventually.

## Overview

**Purpose.** Specify prerequisites, the container environment, seed data, and the debugging workflow, such that a new machine reaches a working stack in one command.

**The governing rule.** Where a local difference from production is genuinely necessary, it is declared in the table below and enforced. Everything not in that table is identical. An undeclared divergence is a defect, because it means something works locally for reasons nobody understands.

**The event bus is real Redis Streams locally, not `InMemoryBus`.** The in-memory implementation exists for unit tests (`13-event-platform/event-bus.md`); running it in development would hide consumer group behaviour, pending-entry recovery, and ordering — the parts most likely to be wrong.

## Prerequisites

| Tool | Version | Pinned by |
|---|---|---|
| Node.js | 22 LTS | `.nvmrc`, `engines` |
| pnpm | Exact | `packageManager` |
| Docker + Compose | Current | — |
| Git | Current | — |

**Node and pnpm versions are enforced, not suggested. [CI]** `engine-strict` makes a wrong Node version a clear error rather than a confusing runtime failure, and the same version is pinned in the container base image (`dependency-management.md`).

**No global installs are required.** Every tool the project needs is a dev dependency invoked through pnpm scripts. A README instructing `npm i -g` produces a machine-dependent toolchain and version skew nobody can reproduce.

## One command

```bash
pnpm setup
```

| Step | Action |
|---|---|
| 1 | Verify Node and pnpm versions |
| 2 | `pnpm install --frozen-lockfile` |
| 3 | Start containers; wait for health |
| 4 | Create the database; apply all migrations |
| 5 | Apply RLS policies and verify conformance |
| 6 | Create buckets in MinIO |
| 7 | Seed tenants, users, and content |
| 8 | Print test credentials and URLs |

**Setup is idempotent.** Running it twice is safe and re-converges a drifted environment — the most common developer action after pulling a branch that changed migrations.

**Step 5 runs the RLS conformance suite during setup**, so a developer whose local database is missing policies learns immediately rather than after writing a feature against an unprotected schema (`16-security/row-level-security.md`).

## Containers

```yaml
# infrastructure/containers/docker-compose.dev.yml
services:
  postgres:      # 17 with pgvector — matches production major
  redis:         # 7.x — event bus, cache, locks, leases
  minio:         # S3-compatible object storage
  mailpit:       # SMTP capture — nothing leaves the machine
  clamav:        # malware scanning
```

| Service | Mirrors | Why not a substitute |
|---|---|---|
| **PostgreSQL 17 + pgvector** | Production exactly | RLS, constraints, and vector search semantics cannot be emulated |
| **Redis 7** | Production exactly | Consumer groups, pending entries, idle claims |
| **MinIO** | R2/S3 via the driver | Real S3 protocol: conditional writes, multipart minimums, listing consistency |
| **Mailpit** | SMTP | Captures mail; **nothing is ever delivered** |
| **ClamAV** | Production scanner | The upload pipeline blocks on it (`12-storage-platform/blob-lifecycle.md`) |

**The database major version matches production exactly.** PostgreSQL minor differences are tolerable; a major difference changes planner behaviour, and RLS conformance on 16 proves nothing about 17.

**MinIO rather than a mock is the same decision made in `storage-abstraction.md`.** A mocked object store asserts the author's model of S3, and the discrepancies that matter are exactly the ones a mock gets wrong.

**ClamAV runs locally because the pipeline genuinely blocks on it.** Skipping it means objects reach `Available` by a path that does not exist in production, and the developer never sees the scanning stage they are about to change.

**Mailpit guarantees no outbound mail.** A local environment configured against a real SMTP relay will, eventually, email a real customer from a seed fixture.

## Seed data

**Seeds are realistic and multi-tenant. Two tenants minimum, always.**

| Seeded | Contents |
|---|---|
| Organizations | 2, on different plans |
| Workspaces | 3 — two under org A, one under org B |
| Users | One per role, plus one multi-org user |
| Projects, articles, keywords | Enough to exercise listing and pagination |
| Media | A few objects through the full lifecycle to `Available` |
| Events | A populated outbox with delivered and pending entries |
| Knowledge | Entities and evidence with real provenance |

**Two tenants is the non-negotiable minimum, and it is the most valuable property of the seed set.** With one tenant, every cross-tenant bug is invisible: an unscoped query returns the right answer, a missing `WHERE tenant_id` looks correct, and an unprefixed cache key never collides. With two, those defects surface during ordinary development rather than in a security review.

**A multi-organization user is seeded deliberately**, because that is the case where identity spans tenants and workspace switching is exercised (`16-security/rbac.md`).

**Seeds are deterministic — fixed UUIDs, fixed timestamps from an injected clock.** A test user whose id changes on every seed makes bookmarks, saved requests, and shared reproduction steps useless.

**Seed data is obviously fake.** `acme-test.example` and `Test User A`, never plausible real names or domains. Screenshots of local environments end up in tickets and demos.

## Test credentials

| User | Role | Purpose |
|---|---|---|
| `owner@acme-test.example` | Org Owner | Administrative paths; self-grant flow |
| `admin@acme-test.example` | Workspace Admin | Full workspace access |
| `editor@acme-test.example` | Editor | Content creation and publishing |
| `contributor@acme-test.example` | Contributor | **No publish, no export** |
| `viewer@acme-test.example` | Viewer | Read-only |
| `multi@acme-test.example` | Member of both orgs | Tenant switching |
| `outsider@other-test.example` | Org B only | **Negative testing** |

**The outsider account is the most useful one in the list.** Verifying that a change did not open a cross-tenant path requires an account that *should* be denied, and its absence is why denial paths go untested (`testing-guide.md`).

**Passwords are identical, weak, and documented.** Local credentials are not secrets; unique generated ones would be copied into scripts and eventually committed.

**Local users authenticate through the real authentication path** — real Argon2id, real sessions, real MFA where enrolled. A bypass would leave the login path exercised only by tests.

## What differs from production

**This table is the complete set. Anything not listed is identical.**

| Difference | Reason | Enforcement |
|---|---|---|
| MinIO instead of R2 | No cloud dependency | Driver config |
| Mailpit instead of SMTP | No outbound mail | Config |
| Local secret store with dummy values | No production credentials locally | **Rejected if `nodeEnv=production`** |
| Log level `debug` | Diagnosis | Config |
| Relaxed rate limits | Iteration speed | Config |
| Single-process worker | Simplicity | Config |
| No CDN — origin directly | No edge locally | Config |
| Seed data present | Development needs data | Seed script |

**Never different, in any environment:**

| Always on |
|---|
| **Authentication** — real credential verification |
| **Authorization** — real permission evaluation |
| **RLS** — enabled with `FORCE` on every workspace-owned table |
| **Tenant scoping** — cache keys, object keys, vector filters |
| **The transactional outbox** — no direct event publication |
| **Malware scanning** — the pipeline blocks on it |
| **Input validation** — `.strict()` schemas |

**No environment flag disables any of these, and none is reachable by configuration. [CI]** A `SKIP_AUTH` or `DISABLE_RLS` variable is the shortcut that reaches production — usually via a copied deployment manifest, occasionally via a default. `nodeEnv === 'production'` additionally rejects dummy secrets and refuses `.env` loading (`configuration.md`).

## Running

| Command | Runs |
|---|---|
| `pnpm dev` | API, worker, and web with hot reload |
| `pnpm dev:api` · `dev:worker` · `dev:web` | Individually |
| `pnpm db:migrate` · `db:reset` · `db:seed` | Database lifecycle |
| `pnpm test` | Unit tests, watch mode |
| `pnpm test:ci` | Everything CI runs |
| `pnpm containers:down` | Stop and clean |

**Hot reload is per-surface**: `next dev` for the web app, `tsx watch` for API and worker.

**Worker hot reload restarts the process rather than patching modules.** A worker holds consumer group leases and in-flight handlers; hot-swapping a handler mid-delivery produces a state no production path reaches. Restart triggers the same graceful drain production uses — which means the drain path gets exercised dozens of times a day (`13-event-platform/workers.md`).

**`db:reset` drops, migrates, and reseeds in one step**, because migration branch-switching is frequent and a half-migrated local database produces failures that look like code bugs.

## Debugging

| Target | Method |
|---|---|
| API / worker | Node inspector; VS Code launch configs committed |
| Web | Browser devtools; React DevTools |
| Database | Any client on the mapped port; `db:shell` script |
| **Redis streams** | `redis:streams` script — pending entries, consumer lag |
| Object storage | MinIO console |
| Mail | Mailpit web UI |
| Traces | Local OpenTelemetry collector + Jaeger |

**Launch configurations are committed**, not left to each developer. Attaching a debugger to a worker inside a container is fiddly enough that most people skip it if it is not one click.

**The `redis:streams` script exists because event platform bugs are otherwise invisible.** Inspecting a consumer group's pending entries, delivery counts, and idle times is how a stuck consumer is diagnosed, and doing it by hand requires remembering `XPENDING` syntax (`13-event-platform/consumer-groups.md`).

**Local tracing is worth the setup.** The platform links a producer trace to a consumer trace by `correlationId` across the async boundary; seeing that locally is how a developer learns the model before an incident requires it (`13-event-platform/observability.md`).

## Common failures

| Symptom | Cause | Fix |
|---|---|---|
| Queries return zero rows | No tenant context set | Set context — this is RLS working |
| `already-exists` on write | Conditional write; key reused | Objects are immutable (`12-storage-platform/object-storage.md`) |
| Uploads stuck at `scanning` | ClamAV not running | `pnpm containers:up` |
| Events never delivered | Worker not running | `pnpm dev:worker` |
| Auth fails after reseed | Sessions invalidated | Log in again |
| Migration conflict after pull | Divergent branch migrations | `pnpm db:reset` |

**"Queries return zero rows" is listed first because it is the most common and most misdiagnosed.** It is not a bug — it is RLS failing closed on a missing tenant context, and every developer hits it once (`16-security/row-level-security.md`).

## Business rules

1. **`pnpm setup` reaches a working stack in one command** and is idempotent.
2. **Container versions match production majors.**
3. **The event bus is real Redis Streams locally**, never `InMemoryBus`.
4. **MinIO, not a mock**, for object storage.
5. **ClamAV runs; the pipeline blocks on it.**
6. **Mailpit captures all mail; nothing is delivered.**
7. **Seeds create at least two tenants**, always.
8. **Seeds are deterministic and obviously fake.**
9. **A negative-test outsider account is seeded.**
10. **Local users authenticate through the real path.**
11. **Auth, authorization, RLS, tenant scoping, the outbox, scanning, and validation are never disabled** in any environment.
12. **No configuration flag can disable a security control.**
13. **Differences from production are declared in one table**; undeclared divergence is a defect.
14. **Worker reload restarts and drains**, exercising the production path.
15. **Debugger launch configurations are committed.**
16. **No global tool installs are required.**

## Observability

Local telemetry runs the production pipeline against a local collector — metrics to Prometheus, traces to Jaeger, logs to stdout in the same JSON schema (`logging-guide.md`).

**Running real telemetry locally catches instrumentation bugs before they reach production.** A metric with unbounded cardinality, a missing `correlationId`, or a payload accidentally attached to a span are all visible locally and invisible in code review.

**Local dashboards mirror the production ones**, including the invariant board that reads all-zero (`16-security/security-observability.md`). A developer who has seen it green knows what a violation looks like.

## Cross references

- `configuration.md` — environment values, production guards, `.env` policy
- `project-structure.md` — where scripts and container definitions live
- `testing-guide.md` — the container harness shared with integration tests
- `dependency-management.md` — runtime version pinning
- `migration-guide.md` — migration workflow and `db:reset`
- `logging-guide.md` — the local log schema
- `16-security/row-level-security.md` — conformance during setup; zero-row behaviour
- `16-security/rbac.md` — the roles seeded as test users
- `13-event-platform/event-bus.md` — why local uses real Streams
- `13-event-platform/workers.md` — graceful drain on reload
- `12-storage-platform/storage-abstraction.md` — MinIO as the local driver
- `12-storage-platform/blob-lifecycle.md` — the scanning gate
