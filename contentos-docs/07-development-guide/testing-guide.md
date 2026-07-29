# Testing Guide

> **Status:** v1.0 — complete. Phase 11.
> **This document is about writing tests, not about which tests are required.** Levels, coverage thresholds, mandatory isolation tests, and the CI gate contract are owned by `10-testing/testing-strategy.md` §9 and are referenced here, never restated.

## Overview

**Purpose.** Ten phases specified what must be true of the system. `10-testing/` specified which tests prove it. This document specifies how those tests are written so they are readable, fast, deterministic, and worth maintaining.

**The boundary, stated once.** `10-testing/testing-strategy.md` owns the taxonomy, the CI gate contract, and coverage policy. `10-testing/unit-testing.md`, `integration-testing.md`, `e2e-testing.md`, and `ai-evaluation.md` own per-level strategy. **This document owns authoring conventions and the developer's local workflow.** A threshold appearing in both would drift, so thresholds appear only there.

**Authoritative thresholds, for reference:** ≥ 85% lines in the engine and contracts packages, ≥ 70% elsewhere, no threshold on `apps/web` (`10-testing/testing-strategy.md` §9).

## Test anatomy

**Every test follows arrange–act–assert, with the three phases visually separated.**

```ts
it('rejects a publish outside a transaction', async () => {
  // arrange
  const publisher = new OutboxPublisher(db, registry, clock);
  const event = anEvent({ eventType: 'ArticlePublished' });

  // act
  const attempt = () => publisher.publish(null as never, event);

  // assert
  await expect(attempt).rejects.toThrow(MissingTransactionError);
});
```

**One behaviour per test.** A test asserting four things fails on the first and hides the other three, and its name cannot describe what it covers.

**Test names state the behaviour, not the method.** `rejects a publish outside a transaction` tells a reader what broke; `publish() test 3` does not. Names read as sentences completing "it…".

**No logic in tests.** No loops building expectations, no conditionals, no helper that computes the expected value using the same algorithm as the code — that asserts the implementation against itself and passes when both are wrong.

## Determinism

**A flaky test is worse than no test**, because it trains everyone to re-run rather than investigate.

| Source of flake | Rule |
|---|---|
| **Time** | Inject `Clock`; `Date.now()` is banned in core code (`coding-standards.md`) |
| **Randomness** | Inject `Random`; seed it in tests |
| **Ordering** | Never depend on array or map iteration order |
| **Concurrency** | No `sleep`-based synchronization; await real conditions |
| **Shared state** | Each test gets its own tenant and its own data |
| **External services** | Never called in unit or integration tests |

**`sleep(100)` is the most common flake in an async codebase.** It passes on a fast machine and fails in CI under load. Tests await the actual condition — a promise, a state change, a queue drain — rather than guessing how long it takes.

**Every test creates its own tenant.** Tests sharing a tenant leak state through the database, cache, and event streams, and produce failures that depend on execution order. A per-test tenant also means every test exercises tenant scoping incidentally, which is free coverage of the platform's most important property.

**Flakes are quarantined and fixed, never re-run.** A test that fails intermittently is deleted or fixed within the sprint; leaving it quarantined indefinitely is the same as deleting it while pretending otherwise.

## Fixtures and builders

**Test data uses builders with sensible defaults and explicit overrides.**

```ts
const article = anArticle({ status: 'published' });
// every other field defaulted — the test says status is what matters
```

**Builders make tests state their own relevance.** A test constructing a fully-populated object forces the reader to work out which of thirty fields matters. A builder overriding one field says it directly.

**Fixtures never share mutable state.** Each call returns a fresh object; a module-level fixture mutated by one test corrupts the next in a way that depends on order.

**Factories live in `tests/` or the package's own fixtures**, never in production code. A builder imported from `src/` is production surface with no production consumer.

**IDs are generated, not hard-coded.** Hard-coded UUIDs collide across parallel tests and hide ordering bugs that a real UUIDv7 would expose.

## Doubles

| Double | Use for | Avoid for |
|---|---|---|
| **Stub** | Returning fixed data from a dependency | Asserting behaviour |
| **Fake** | A working in-memory implementation (`InMemoryBus`) | — |
| **Mock** | Asserting an interaction genuinely matters | Everything else |
| **Real** | Databases, Redis, MinIO in integration tests | External paid providers |

**Prefer fakes to mocks.** `InMemoryBus` implementing `EventBus` (`13-event-platform/event-bus.md`) tests real behaviour through a real interface. A mock asserting `append()` was called once tests that the code calls a method, which is a restatement of the code rather than a check on it.

**Mock only at architectural boundaries** — provider adapters, the AI Gateway, the KMS. Mocking internal collaborators couples tests to structure, so every refactor breaks tests without any behaviour changing.

**Never mock the database.** A mocked query asserts the test author's model of PostgreSQL, and the discrepancies that matter — RLS semantics, constraint behaviour, transaction isolation — are exactly what a mock gets wrong. Integration tests use real PostgreSQL; unit tests do not touch persistence at all (`10-testing/integration-testing.md`).

**Never mock the object store.** MinIO in CI provides real S3 semantics — conditional writes, multipart minimums, listing consistency — which a mock does not (`12-storage-platform/storage-abstraction.md`).

## Writing tests per level

**Level definitions and requirements are in `10-testing/`.** What follows is authoring guidance for each.

### Unit

Pure functions and the functional core. No I/O, no clock, no database.

**The functional core exists to make this level cheap** (`coding-standards.md`). A decision function taking inputs and returning a decision needs no setup, runs in microseconds, and covers the branches that matter. Where a unit test needs elaborate mocking, the code has I/O in its core and the design is the finding.

### Integration

Real PostgreSQL, real Redis, real MinIO — via containers. Cross-package behaviour.

**Every integration test runs inside a transaction that rolls back**, except those testing commit behaviour. Rollback isolation is faster than truncation and leaves no residue between tests.

**Tenant isolation assertions belong here and are close to free.** Given per-test tenants, asserting that tenant A cannot see tenant B's rows is a few lines, and it exercises the platform's load-bearing guarantee (`16-security/row-level-security.md`).

### Contract

Assert that a consumer's expectations match a producer's schema.

**Event contract tests read the registry**, not a copy. A test asserting a hand-written schema drifts from the registered one and passes while production breaks (`13-event-platform/event-registry.md`).

**Interface signature tests belong in `tests/conformance/`** and assert the frozen APIs have not drifted — the mechanism that would have caught the ten drift items the Phase 10 review found by hand (`12-storage-platform/storage-apis.md`).

### End-to-end

Full stack through the API. Deliberately few.

**E2E tests cover journeys, not features.** Sign up → create workspace → run a pipeline → publish. A feature-per-E2E-test suite becomes the slowest and flakiest part of CI and duplicates integration coverage.

### Performance

Scripted against the NFRs, run on a schedule rather than per commit.

**Thresholds map to stated targets** — relay lag p95 < 2 s, presign p95 < 10 ms — so a regression fails against the specification rather than a number someone chose.

### Security

Authorization, isolation, and input validation as executable assertions.

**Every denial path gets a test.** A permission that is never tested for *denial* is a permission that may be granting more than intended; positive-only tests pass on a system that allows everything (`16-security/authorization.md`).

**RLS conformance is generated, not hand-written.** A CI job enumerates the schema and cross-references the isolation test registry, so a new table without a policy or an isolation test fails the merge gate (`10-testing/testing-strategy.md`).

### Property-based

For invariants over generated inputs, where examples cannot cover the space.

| Good fit | Why |
|---|---|
| Idempotency key derivation | Same event always yields the same key, across all shapes |
| Version transforms | Upcast-then-downcast round-trips |
| Ciphertext envelope | Encrypt-then-decrypt returns the input, all sizes |
| Ordering comparators | Transitivity and antisymmetry hold |

**Property tests are added where an invariant is stated in the architecture**, not everywhere. Their value is finding the input nobody imagined; their cost is slow, hard-to-reproduce failures when applied to things examples cover fine.

**Failing cases are shrunk and pinned as example tests**, so a found bug stays found without re-running the generator.

### Mutation

Applied selectively, to the highest-consequence pure logic only.

| Applied to | Not applied to |
|---|---|
| Retry classification, idempotency derivation, authorization evaluation, scoring | Adapters, I/O shells, UI, generated code |

**Mutation testing answers the question coverage cannot**: whether the tests would notice if the code were wrong. High coverage with weak assertions scores badly, which is the point.

**It is too slow for every commit** and runs on a schedule against a narrow set. Applying it repository-wide produces hours of runtime and a backlog of surviving mutants nobody triages.

## Local workflow

| Command | Runs |
|---|---|
| `pnpm test` | Unit tests, watch mode, current package |
| `pnpm test:integration` | Containers up, integration suite |
| `pnpm test:e2e` | Full stack |
| `pnpm test:conformance` | RLS, drivers, interface signatures |
| `pnpm test:changed` | Tests affected by the working diff |
| `pnpm test:ci` | Everything CI runs, locally |

**`pnpm test:ci` exists so a developer can reproduce a pipeline failure without pushing.** A gate that can only be evaluated on CI turns every failure into a multi-minute round trip.

**Containers are managed by the test harness**, not by a documented manual sequence. A test run starts what it needs and tears it down (`local-development.md`).

**Watch mode is the default for unit tests** and the reason unit tests must stay fast: a sub-second loop changes how much testing gets done.

## Reviewing tests

Tests are reviewed with the same rigour as production code (`code-review.md`):

| Check | Question |
|---|---|
| Behaviour | Does the name describe what broke when it fails? |
| Assertions | Would this fail if the code were wrong, or only if it threw? |
| Determinism | Any time, randomness, ordering, or sleep dependency? |
| Isolation | Own tenant, own data, no shared mutable fixtures? |
| Doubles | Fakes over mocks; no mocked database? |
| Coverage of denial | Are failure and denial paths tested, not just success? |

**"Would this fail if the code were wrong?" is the question that catches the most useless tests.** A test asserting a function returns without throwing covers lines and proves nothing.

## Business rules

1. **`10-testing/` owns strategy, thresholds, and gates**; this document owns authoring.
2. **One behaviour per test**; names describe the behaviour.
3. **No logic in tests** — no loops, conditionals, or computed expectations.
4. **Time and randomness are injected**, never ambient.
5. **No `sleep`-based synchronization.**
6. **Every test creates its own tenant.**
7. **Flakes are fixed or deleted**, never re-run.
8. **Builders with defaults and explicit overrides**; no shared mutable fixtures.
9. **Fakes over mocks**; mock only at architectural boundaries.
10. **Never mock the database or the object store.**
11. **Integration tests roll back** unless testing commit behaviour.
12. **Contract tests read the registry**, not a copy.
13. **Denial paths are tested**, not only success paths.
14. **Property tests target stated invariants**; failures are pinned as examples.
15. **Mutation testing is selective and scheduled.**
16. **Test factories never live in production code.**

## Cross references

- `10-testing/testing-strategy.md` — **taxonomy, coverage thresholds, CI gate contract**
- `10-testing/unit-testing.md` · `integration-testing.md` · `e2e-testing.md` — per-level strategy
- `10-testing/ai-evaluation.md` — model output evaluation
- `coding-standards.md` — functional core, injected clock, purity rules
- `project-structure.md` — where each test kind lives; the drift note on package names
- `local-development.md` — container harness and seed data
- `ci-cd.md` — pipeline stages running these suites
- `code-review.md` — the test review checklist
- `16-security/row-level-security.md` — RLS conformance requirements
- `13-event-platform/event-registry.md` — contract test source
- `12-storage-platform/storage-abstraction.md` — driver conformance against real MinIO
