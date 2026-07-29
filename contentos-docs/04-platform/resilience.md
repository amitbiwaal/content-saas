# Resilience

> **Status:** v1.0 — ownership document. Phase 12 governance completion.
> **One circuit breaker, one authority.** The Retry Engine reads breaker state; it does not own it. Two components independently deciding a dependency is unhealthy would produce contradictory behaviour.

## Purpose

Own the circuit breaker as a single platform-wide component, and name the consumers that read its state.

## Scope

**In scope:** ownership of the circuit breaker and the statement that there is exactly one authority on dependency health.

**Not in scope:** retry policy, backoff, budgets, or exhaustion — all owned by `13-event-platform/retry-engine.md`. Timeout values, which belong to the calling component. Provider fallback, owned by the AI Platform.

## Ownership

| Concern | Owner |
|---|---|
| **Circuit breaker implementation and state** | **This document** |
| Retry classification, backoff, budgets, exhaustion | `13-event-platform/retry-engine.md` |
| AI provider retry and fallback | `08-ai-platform/retry-strategy.md` |
| Provider adapter behaviour | `09-integrations/` |
| Timeouts on external calls | The calling component (`07-development-guide/coding-standards.md`) |
| Graceful degradation on dependency loss | The owning platform |

**The breaker is a platform component with one instance per dependency.** Consumers read its state; none maintains its own.

## Responsibilities

**Track dependency health and expose state.** Closed, open, half-open — the standard three, per dependency.

**Be the single authority.** `13-event-platform/retry-engine.md` states this explicitly: *"The breaker is owned by `04-platform/resilience.md`; the Retry Engine only reads its state."* Two components independently classifying a dependency as unhealthy would produce contradictory retry behaviour, so there is one breaker and one authority on it.

**Serve state to retry decisions.** The Retry Engine already specifies how it uses that state:

| Breaker state | Retry behaviour it produces |
|---|---|
| Closed | Normal exponential backoff |
| Open | Delay extended to the half-open window — retrying sooner is guaranteed to fail |
| Half-open | A single probe permitted; success closes the breaker |

**Coordination prevents pointless attempts.** With an open breaker, every retry fails instantly, burning attempts and budget without reaching the dependency. Aligning retry delay to the recovery window is what makes those attempts count.

## Existing references

Three references, all from one document:

| Document | Defers |
|---|---|
| `13-event-platform/retry-engine.md` §Non-responsibilities | Circuit breaker implementation |
| `13-event-platform/retry-engine.md` §Circuit breaker coordination | Breaker ownership and state |
| `13-event-platform/retry-engine.md` §Cross references | Ownership and state |

**A single consumer is the current reality**, and it is why this document is an ownership record rather than a specification. The Retry Engine already documents the interaction fully.

## Related documents

- `13-event-platform/retry-engine.md` — **the consumer; owns everything about retry**
- `08-ai-platform/retry-strategy.md` — model-invocation retry; a separate taxonomy, same guardrail rule
- `08-ai-platform/provider-adapters.md` — provider failure surfaces
- `09-integrations/` — the Provider Layer whose dependencies are tracked
- `07-development-guide/error-handling.md` — `PROVIDER_UNAVAILABLE`, `INFRA_*` classifications the breaker reacts to
- `07-development-guide/coding-standards.md` — every external call has a timeout
- `16-security/api-security.md` — `SafeUrlFetcher`, the single egress chokepoint
- `14-operations/incident-response.md` — dependency outage response

## Operational considerations

**A breaker that opens is a signal, not a failure.** It means a dependency is unhealthy and the platform has stopped amplifying load against it — the intended behaviour.

**Breaker state is observable per dependency.** Retry metrics in `13-event-platform/retry-engine.md` and `06-api/api-observability.md` reflect its effect; the breaker's own state is exposed to operators through `06-api/admin-api.md` §System status as component health.

**Liveness probes never consult the breaker.** A dependency-aware liveness check would fail every instance simultaneously during a dependency blip and restart the fleet (`07-development-guide/deployment-guide.md`).

**Terminal failures never open the breaker.** `AuthorizationFailure` and `ValidationRejected` are not dependency health signals; only transient classes contribute (`13-event-platform/retry-engine.md`).

**The breaker does not implement fallback.** Routing elsewhere is a policy decision owned by the AI Platform, and **provider safety refusals never trigger automatic fallback** regardless of breaker state (`08-ai-platform/retry-strategy.md`).

## Explicitly out of scope

| Out of scope | Where it belongs |
|---|---|
| Retry classification, backoff, jitter, budgets | `13-event-platform/retry-engine.md` |
| Retry exhaustion and DLQ routing | `13-event-platform/retry-engine.md`, `dead-letter-queue.md` |
| Provider fallback and model routing | `08-ai-platform/retry-strategy.md` |
| Timeout values | The calling component |
| Bulkheads and worker concurrency limits | `13-event-platform/workers.md` |
| Rate limiting | `04-platform/rate-limiting.md` |
| Health and readiness probe semantics | `07-development-guide/deployment-guide.md` |
| **Deciding a dependency is unhealthy anywhere else** | **Nowhere — this is the single authority** |
