# Event APIs

> **Status:** v1.0 — complete. New in Phase 8. **Canonical interface registry.**
> **This document is the frozen contract.** Where it disagrees with any other Phase 8 document, this one wins. It closes nine drift items found by extracting every declared interface rather than assuming consistency.

## Overview

**Purpose.** Phase 8 declared 52 interfaces across 13 documents, written in sequence. Written that way, signatures drift: a handler acquires a parameter in one document and a different one in another, a type is used in four places and declared in none. This document extracts them all, resolves the conflicts, and freezes the result.

**Scope of authority.** This is a **drift resolution**, not a redesign. No architectural decision from ADR-020, ADR-027, or ADR-028 is revisited; no approved behaviour changes. Where two documents specified incompatible signatures for the same concept, one form is chosen and the divergence is recorded below.

## The canonical event envelope — FROZEN

```ts
interface DomainEvent<T> {
  eventId: string;          // UUIDv7 — globally unique, time-ordered
  eventType: string;        // PascalCase past tense: 'ArticlePublished'
  eventVersion: number;     // payload schema version
  aggregateType: string;    // 'Article'
  aggregateId: string;      // the ONLY ordering/partition key
  tenantId: string;         // workspace — never optional
  organizationId: string;   // commercial boundary — ADR-017
  correlationId: string;    // groups everything caused by one request
  causationId: string | null;  // direct parent; null for root events
  producer: string;         // component that published
  occurredAt: string;       // ISO 8601 UTC, from the injected Clock
  payload: T;
}
```

**Every field is required. `causationId` is nullable but always present.**

| Field | Why it is mandatory |
|---|---|
| `eventId` | Identity across outbox, bus, DLQ, replay, idempotency markers |
| `eventType` + `eventVersion` | Registry validation and version transformation |
| `aggregateType` + `aggregateId` | The sole ordering dimension (`ordering.md`) |
| `tenantId` + `organizationId` | RLS context reconstruction at every consumer |
| `correlationId` | The primary incident query |
| `causationId` | Causal chain reconstruction and cross-type causal ordering |
| `producer` | Attribution on DLQ entries and contract ownership |
| `occurredAt` | Handlers must use this, never wall-clock (`replay.md`) |

### Payload rules

**The payload carries business identifiers and immutable event data. Nothing else.**

| Never in a payload | Reason |
|---|---|
| Credentials, tokens, keys | Events fan out to notification channels and webhook subscribers with weaker controls than the source table |
| Large content — article bodies, drafts, research text | Events are notifications; the payload would duplicate the source of truth and go stale |
| Blobs, binary, base64 | Media is referenced by id; storage is owned by the Storage Platform (ADR-018) |
| Mutable state | Events are immutable facts; a mutable field is a lie by the time it is read |
| Unbounded arrays of objects | Unbounded payloads break stream limits and produce publish-side poison rows |

Enforcement is at registration, not by convention: schemas require `additionalProperties: false`, and content-shaped fields, credential patterns, and `format: 'email'` are rejected (`event-registry.md`).

**Scoring interaction (ADR-021).** Events about scores carry the integer score, its `category`, and the `contractVersion` — identifiers and immutable values. They **never** carry the explanation, the evidence array, or `algorithmVersion` internals; those live in the owning engine's tables and are referenced by id. A consumer needing the explanation reads it from the owner rather than from the event, which keeps the payload bounded and the Explainability Envelope single-sourced (`01-system-architecture/14-scoring-contract.md`).

## Shared types — declared here

Ten types were referenced across Phase 8 and declared nowhere. They are defined here as the canonical source.

```ts
type BusEntryId = string;      // OPAQUE — transport-specific, never persisted by a consumer
type BusPosition = string;     // opaque stream position for replay-from cursors

interface Transaction {
  // The ORM transaction handle. Drizzle's transaction type (ADR-022).
  // Passed by reference; never constructed by the Event Platform.
}

interface TenantContext {
  tenantId: string;
  organizationId: string;
  readonly source: 'event' | 'request';
}

interface Page<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

interface JobContext {
  jobName: string;
  windowStartedAt: Date;
  attempt: number;
}

type BarrierToken = string;    // opaque lease handle for (group, aggregateId)

interface WorkerHealth {
  status: 'starting' | 'ready' | 'draining' | 'unhealthy';
  hostedGroups: string[];
  inFlight: number;
  lastHeartbeatAt: Date;
}

type ReplayAttemptOutcome =
  | { outcome: 'delivered' }
  | { outcome: 'suppressed-duplicate' }
  | { outcome: 'failed'; code: string; message: string };

type NewDeadLetterEntry = Omit<
  DeadLetterEntry,
  'id' | 'status' | 'deadLetteredAt' | 'resolvedAt' | 'resolvedBy' | 'resolutionNote'
>;
```

**`TenantContext.source` is readonly and discriminated** so that context reconstructed from an event is distinguishable from request-derived context in audit and diagnostics. Consumers always receive `'event'`.

**Date representation is split deliberately.** The envelope's `occurredAt` is an **ISO 8601 string** because it crosses a serialization boundary and must round-trip byte-identically through the outbox, the bus, the DLQ, and replay. Persisted records and in-process interfaces use `Date`. The boundary is the envelope: string on the wire, `Date` in memory.

## API surface 1 — Publish

```ts
interface EventPublisher {
  publish<T>(tx: Transaction, event: DomainEvent<T>): Promise<void>;
}

interface OutboxPublisher extends EventPublisher {
  publishBatch<T>(tx: Transaction, events: DomainEvent<T>[]): Promise<void>;
}
```

**`EventPublisher` is what domain components depend on.** One method, and it requires a transaction handle — no overload without one, no ambient variant, no fire-and-forget path. Publishing outside a transaction is **unrepresentable**, which is how ADR-020's dual-write elimination is enforced structurally rather than by review (`transactional-outbox.md`).

**`OutboxPublisher` is the implementation** and adds batch publication. Components depend on the narrow interface; the wide one exists for the relay and for producers emitting several events in one transaction — including the atomic dual publication used during a breaking-change migration (`versioning.md`).

**Registry validation happens inside `publish`, before commit.** An unregistered type or a schema violation throws, and the producer's state change rolls back with it. Unknown types and invalid payloads cannot reach the outbox (`event-registry.md`).

## API surface 2 — Subscribe and consume

```ts
interface RegisteredHandler {
  eventType: string;
  version: number;               // exactly one version per handler
  group: string;
  handle(
    event: DomainEvent<unknown>,
    ctx: TenantContext,
    tx: Transaction,
    signal: AbortSignal,
  ): Promise<void>;
}
```

**This is the single canonical handler interface.** `EventHandler` from `consumer-groups.md` is superseded; it was the same concept with a narrower signature and no `group`.

**All four parameters are required and each is load-bearing:**

| Parameter | Why it cannot be dropped |
|---|---|
| `event` | The immutable fact being handled |
| `ctx` | Tenant context from the envelope — never ambient (`consumer-groups.md`) |
| `tx` | The handler's writes **must** commit with the idempotency marker in one transaction (`idempotency.md`) |
| `signal` | Cancellation on shutdown, lease expiry, and timeout (`workers.md`) |

**Handlers contain no version branching.** A handler declares one version; the delivery path transforms the event to that version before invocation (`versioning.md`).

```ts
interface EventBus {
  append(event: DomainEvent<unknown>): Promise<BusEntryId>;
  readGroup(options: ReadGroupOptions): AsyncIterable<DeliveredEvent>;
  ack(group: string, entryId: BusEntryId): Promise<void>;
  claimStalled(group: string, options: ClaimOptions): Promise<DeliveredEvent[]>;
  pendingCount(group: string, eventType?: string): Promise<number>;
  trim(eventType: string, olderThan: Date): Promise<number>;
}

interface DeliveredEvent {
  entryId: BusEntryId;
  event: DomainEvent<unknown>;
  deliveryCount: number;
  firstDeliveredAt: string;
}
```

**`EventBus` is the swap point.** `RedisStreamsBus` today; `KafkaBus` at S3 without touching a consumer, because `entryId` is opaque and never persisted (`event-bus.md`, ADR-020).

## API surface 3 — Registry

```ts
interface EventRegistry {
  validate(event: DomainEvent<unknown>): ValidationResult;
  isRegistered(eventType: string, version: number): boolean;
  streamFor(eventType: string): string;
  consumersOf(eventType: string): ConsumerDeclaration[];
  transform(event: DomainEvent<unknown>, targetVersion: number): DomainEvent<unknown>;
  supportedVersions(eventType: string): VersionState[];
  retirementEligibility(eventType: string, version: number): RetirementCheck;
}
```

**`VersionRegistry` from `versioning.md` is merged into `EventRegistry`.** They were one component described in two documents; the registry is source-controlled and loaded at startup, so a split runtime interface implied a separation that does not exist.

**Consumer version declaration is reconciled as follows:**

```ts
interface ConsumerDeclaration {
  consumerGroup: string;
  component: string;
  versions: number[];            // the GROUP's set — normally one
  criticality: 'standard' | 'critical';
  handlerIdempotencyKey: string;
  onUnknownVersion: 'transform' | 'dead-letter';
}
```

**A group declares a set; each handler declares exactly one version.** `versions` contains more than one element only during a migration window, and it is what makes "a version cannot be retired while a consumer declares it" enforceable. `RegisteredHandler.version` is singular and is the transformation target. Both statements from `event-registry.md` and `versioning.md` hold.

## API surface 4 — Replay

```ts
interface ReplayCoordinator {
  estimate(request: ReplayRequest): Promise<ReplayEstimate>;
  start(request: ReplayRequest, actor: string): Promise<ReplayRun>;
  status(runId: string): Promise<ReplayRun>;
  pause(runId: string, actor: string): Promise<void>;
  resume(runId: string, actor: string): Promise<void>;
  abort(runId: string, actor: string, reason: string): Promise<void>;
}
```

`targetGroups` is required in every `ReplayRequest` variant — accidental broadcast is a compile error. Registry validation is re-run on every replayed event and cannot be bypassed (`replay.md`, ADR-028).

## API surface 5 — Dead letter queue

```ts
interface DeadLetterQueue {
  quarantine(entry: NewDeadLetterEntry): Promise<string>;
  get(id: string): Promise<DeadLetterEntry | null>;
  query(q: DeadLetterQuery): Promise<Page<DeadLetterEntry>>;
  summarize(q: DeadLetterQuery): Promise<FailureGroup[]>;
  eligibility(id: string): Promise<ReplayEligibility>;
  resolve(id: string, actor: string, note: string): Promise<void>;
  discard(id: string, actor: string, note: string): Promise<void>;
  appendReplayAttempt(id: string, outcome: ReplayAttemptOutcome): Promise<void>;
}
```

**No `delete` method exists.** Removal happens only through retention of already-resolved or already-discarded entries; `actor` and `note` are required parameters on both terminal transitions (`dead-letter-queue.md`, ADR-027).

## API surface 6 — Worker

```ts
interface Worker {
  register(handlers: RegisteredHandler[], schedules: RegisteredSchedule[]): void;
  start(): Promise<void>;
  shutdown(graceMs: number): Promise<ShutdownReport>;
  health(): WorkerHealth;
}
```

Boot validates every handler against the registry and fails the process on any mismatch. `ShutdownReport.abandoned` must be zero on a clean deploy (`workers.md`).

## API surface 7 — Consumer runtime

```ts
interface ConsumerGroupRuntime {
  start(): Promise<void>;
  stop(graceMs: number): Promise<void>;
  status(): GroupStatus;
}

interface RetryEngine {
  decide(context: RetryContext): Promise<RetryDecision>;
  recordAttempt(context: RetryContext, classification: Classification): Promise<void>;
  budgetState(scope: RetryBudget['scope'], key: string): Promise<BudgetState>;
}

interface IdempotencyGuard {
  execute<T>(
    event: DomainEvent<unknown>,
    group: string,
    strategy: IdempotencyKeyDerivation['strategy'],
    work: (tx: Transaction) => Promise<T>,
  ): Promise<IdempotentResult<T>>;
  wasProcessed(group: string, key: IdempotencyKey): Promise<boolean>;
}

interface AggregateBarrier {
  acquire(group: string, aggregateId: string, eventId: string): Promise<BarrierToken | 'held'>;
  release(token: BarrierToken): Promise<void>;
  releaseWithGap(token: BarrierToken, deadLetteredEventId: string): Promise<void>;
  heldCount(group: string): Promise<number>;
}
```

**Delivery composition order is fixed** — barrier, then idempotency, then handler:

```ts
const token = await barrier.acquire(group, event.aggregateId, event.eventId);
if (token === 'held') return;                    // released for later redelivery
try {
  await guard.execute(event, group, strategy, (tx) =>
    handler.handle(event, ctx, tx, signal));
  await barrier.release(token);
} catch (err) {
  const decision = await retry.decide({ ...ctx, error: err });
  if (decision.action === 'dead-letter') {
    await dlq.quarantine(entry);
    await barrier.releaseWithGap(token, event.eventId);
  }
}
```

**The order is not arbitrary.** The barrier must be outermost or a held event would consume an idempotency marker before being deferred. Idempotency must wrap the handler so the marker and the effects share one transaction. Retry is outermost on the failure path because it decides the entry's fate after everything else has declined to handle it.

## Consistency review

Extracted from all 13 documents. Nine items found; all resolved.

| # | Drift | Resolution |
|---|---|---|
| **D-1** | **Three handler signatures**: `(event, ctx)` in `consumer-groups.md`, `(event, ctx, signal)` in `workers.md`, `(event, ctx, tx)` in `idempotency.md` and `replay.md` | Canonical `(event, ctx, tx, signal)`. All four are load-bearing; none can be dropped without losing a guarantee. |
| **D-2** | **Two handler interfaces**: `EventHandler` and `RegisteredHandler` | `RegisteredHandler` is canonical. `EventHandler` superseded — same concept, narrower, missing `group`. |
| **D-3** | **`producer` required by `DeadLetterEntry` but absent from the Phase 1 envelope** | Added to the frozen envelope. The DLQ field previously had **no source** — a genuine gap, now closed. |
| **D-4** | **`causationId?: string` (optional) vs `string \| null`** | `causationId: string \| null` — always present, null for root events. Optional-vs-null ambiguity removed. |
| **D-5** | **`occurredAt: string` in the envelope vs `Date` in records** | Envelope is the wire contract: ISO 8601 **string**, byte-identical through outbox, bus, DLQ, replay. Persisted records use `Date`. |
| **D-6** | **`versions: number[]` vs "a consumer declares exactly one version"** | Group declares a set (>1 only during migration); each handler declares one. Both source statements hold. |
| **D-7** | **`EventPublisher` vs `OutboxPublisher`** | Not a conflict: narrow interface for domain components, wide implementation adding `publishBatch`. Now stated as `extends`. |
| **D-8** | **Ten types used but declared nowhere** — `BusEntryId`, `BusPosition`, `Transaction`, `TenantContext`, `Page<T>`, `JobContext`, `BarrierToken`, `WorkerHealth`, `ReplayAttemptOutcome`, `NewDeadLetterEntry` | All declared above. |
| **D-9** | **`organizationId` in the Phase 1 envelope, absent from the Phase 8 field list** | **Retained.** Required by ADR-017 and already a column on `outbox_events`; dropping it would break RLS context reconstruction. |

**D-3 and D-9 are the two worth flagging to a reviewer.** D-3 adds a field to an envelope specified in Phase 1 — a change to an approved contract, made because the DLQ's mandated `producer` field otherwise had nothing to populate it. D-9 retains a field that the Phase 8 instruction did not list; removing it was not an option, because `organizationId` is a column on `outbox_events` and the commercial boundary in ADR-017.

**No behavioural drift was found.** Every conflict was in signature or type representation. No document contradicted another on a guarantee, an ordering rule, or a retry classification.

## Business rules

1. **This document is canonical.** Where it disagrees with another Phase 8 document, this one wins.
2. **The envelope is frozen.** Adding a field is an ADR, not a patch.
3. **All eleven envelope fields are required**; `causationId` is nullable but present.
4. **`aggregateId` is the only partition key.**
5. **Payloads carry identifiers and immutable values only** — never credentials, content, or blobs.
6. **Publishing requires a transaction handle**, enforced by signature.
7. **Registry validation occurs before commit**; unknown types and schema violations never reach the outbox.
8. **One handler interface**, four required parameters.
9. **Delivery composes barrier → idempotency → handler**, with retry on the failure path.
10. **`entryId` is opaque** and never persisted by a consumer.
11. **No API can discard an event** — `RetryDecision` has no drop variant, the DLQ has no delete.
12. **Every event is immutable**; transformation is in memory, on read.

## Database impact

**No new tables and no schema change in this document.** Phase 8's total database footprint is:

| Change | Type | ADR |
|---|---|---|
| `outbox_events.publish_attempts INTEGER NOT NULL DEFAULT 0` | Additive column, expand migration | ADR-020 |
| `dead_letter_events` | New table | **ADR-027** |
| `replay_runs` | New table | **ADR-028** |

Everything else reuses Phase 3 as specified: `outbox_events`, `processed_events`, `audit_log` (`03-database/tables.md` §8).

## Security

- The envelope carries **identifiers only**; `tenantId` and `organizationId` reconstruct RLS context at every consumer.
- **Payload content rules are enforced at registration**, not by convention.
- Consumers use the **RLS-enforced application role**; background work never bypasses isolation.
- `TenantContext` is required on every handler invocation and can only originate from the envelope.
- DLQ inspection and replay are privileged operations, audited synchronously with actor and note.
- Reference `16-security/`; this document defines no controls of its own.

## Performance

| Surface | Target |
|---|---|
| `publish` | p95 < 10 ms added to the producer's transaction |
| Relay lag | p95 < 2 s, p99 < 10 s |
| Idempotency check | p95 < 3 ms |
| Barrier acquire | p95 < 2 ms |
| Retry decision | p95 < 5 ms |
| Handler dispatch overhead | p95 < 2 ms above handler duration |
| Version transform | p95 < 1 ms per step; zero on the current version |

## Observability

Metric names are frozen in `observability.md` and are not restated here. The invariant set this registry guarantees, each with a page-on-occurrence alert:

| Invariant | Signal |
|---|---|
| No event loss | `dlq_entries_total{source="publish"}` |
| Per-aggregate ordering | `ordering_violations_total` |
| Exactly-once effects | `external_claims_unconfirmed` |
| Registry gate held | `terminal_failures_total{code="SchemaViolation"}` |
| Replay safety | `replay_runs_total{outcome="failed"}` |

## Cross references

- `README.md` — platform guarantees and scope
- `event-bus.md` — `EventBus`, `DeliveredEvent`, transport swap
- `transactional-outbox.md` — `EventPublisher`, ADR-020, `publish_attempts`
- `event-registry.md` — validation, declarations, payload content rule
- `consumer-groups.md` — delivery distribution and tenant context
- `workers.md` — `Worker`, lifecycle, cancellation
- `retry-engine.md` — `RetryDecision`, terminal classifications
- `dead-letter-queue.md` — `DeadLetterQueue`, ADR-027
- `replay.md` — `ReplayCoordinator`, ADR-028
- `idempotency.md` — `IdempotencyGuard`, exactly-once effects
- `ordering.md` — `AggregateBarrier`, partition key
- `versioning.md` — transformation, deprecation lifecycle
- `observability.md` — frozen metric catalogue
- `01-system-architecture/10-event-flow.md` — the Phase 1 envelope this freezes
- `01-system-architecture/13-adr-log.md` — ADR-020, ADR-027, ADR-028
- `01-system-architecture/14-scoring-contract.md` — ADR-021 payload interaction
- `03-database/tables.md` §8 — outbox, processed events, audit log
