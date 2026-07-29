# `@contentos/contracts`

**Specified by** [`13-event-platform/event-apis.md`](../../contentos-docs/13-event-platform/event-apis.md) and [`01-system-architecture/14-scoring-contract.md`](../../contentos-docs/01-system-architecture/14-scoring-contract.md).

## What this package owns

| Concern                                                     | Source of truth                   |
| ----------------------------------------------------------- | --------------------------------- |
| The canonical event envelope — **frozen**                   | `13-event-platform/event-apis.md` |
| `EventPublisher` / `OutboxPublisher`                        | ADR-020                           |
| Shared types (`TenantContext`, `Page<T>`, `Transaction`, …) | `event-apis.md` D-8               |
| The Unified Scoring Contract                                | ADR-021                           |
| The twelve canonical score categories                       | `14-scoring-contract.md` §3       |
| Gate verdict composition                                    | `14-scoring-contract.md` §6       |

## Rules that govern this package

**Zero dependencies.** This package may import nothing — not `database`, not `security`, nothing. It is imported by every layer including the browser bundle, and one dependency on `database` would pull Drizzle into the frontend build (`07-development-guide/project-structure.md` rule 3).

**`src/index.ts` is the only barrel.** Anything not exported there is internal, and the `exports` field blocks deep imports so `@contentos/contracts/src/scoring/score` fails to resolve rather than merely failing review.

**The envelope is frozen.** Adding a field is an ADR, not a patch (`event-apis.md` rule 2).

**Publishing requires a transaction handle, by signature.** `EventPublisher.publish(tx, event)` has no overload without one and no fire-and-forget path — publishing outside a transaction is unrepresentable, which is how ADR-020's dual-write elimination is enforced structurally rather than by review.

**No formula, threshold, weight, or model reference belongs here.** The scoring contract fixes shape and semantics; measurement belongs to the producing engines and may change freely without amending it.

**Exactly one producer per score category.** A second producer is an architectural defect, caught by a startup check against `score_category_registry`.

## Notes carried forward

`Transaction` is declared structurally rather than imported from Drizzle, so this package acquires no dependency on `packages/database`. **ADR-022 (PostgreSQL 17 + Drizzle) is still Proposed** — the working assumption is recorded in `01-system-architecture/99-open-questions.md`, and it must be accepted or accepted-as-risk before the first migration ships (`17-implementation/implementation-order.md`, Sprint 0 risks).
