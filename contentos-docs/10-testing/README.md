# 09 — Testing

How ContentOS AI proves correctness before code reaches a tenant. This folder is binding on every package in the monorepo: a change that cannot be tested at the level defined here is a design defect, not a testing gap.

Three properties of this system make a generic testing plan insufficient, and they shape every document in this folder:

1. **Multi-tenancy is a correctness property, not a feature.** Cross-tenant leakage is the highest-severity failure the platform can produce (`01-system-architecture/` §21.4). Isolation is therefore asserted by mandatory tests, not by review.
2. **The core pipeline is a durable, long-running workflow** with human waits measured in days (§19). It cannot be tested by "call the endpoint and assert the response."
3. **Model output is non-deterministic.** Traditional assertions do not apply to generated content, so quality is measured by an evaluation harness with score thresholds, not by equality checks.

| File | Covers |
|---|---|
| `testing-strategy.md` | The test taxonomy, CI gate contract, ownership, budgets, flake policy — the anchor document |
| `unit-testing.md` | Pure logic: engines, scoring, policy, contracts; doubles and determinism rules |
| `integration-testing.md` | Real PostgreSQL/Redis, RLS isolation suite, Temporal workflow replay, provider adapters |
| `e2e-testing.md` | Browser-level journeys against a full stack, SSE progress, publishing, billing |
| `ai-evaluation.md` | Prompt eval sets, LLM-as-judge rubrics, regression gates, online evaluation |

## Rules that bind every file here

1. **Every table gets a tenant-isolation test.** A table without one fails CI (`integration-testing.md` §Database Impact).
2. **No test calls a live model provider or a paid data provider in the default suite.** Provider traffic is recorded or stubbed; live calls run only in the nightly `live-providers` suite with a cost cap (`integration-testing.md`).
3. **Model quality is never asserted with `toEqual`.** Generated output is judged by the evaluation harness (`ai-evaluation.md`).
4. **Tests never read or restore production data.** Fixtures are synthetic (`testing-strategy.md` §Security).
5. Test *style* (naming, structure, assertion helpers) is defined in `07-development-guide/coding-standards.md`. Test *strategy* — what must exist and what blocks a merge — is defined here. The two must not restate each other.

Related: `14-operations/deployment.md` consumes the CI gate contract defined in `testing-strategy.md`; `14-operations/monitoring.md` reuses the same SLO definitions that `e2e-testing.md` asserts against.
