/**
 * The canonical event envelope — FROZEN.
 *
 * Specified by `13-event-platform/event-apis.md` §"The canonical event envelope".
 * That document is canonical: where it disagrees with any other Phase 8
 * document, it wins.
 *
 * Adding a field to this envelope is an ADR, not a patch (event-apis.md rule 2).
 *
 * ADR-017 — `tenantId` is the workspace and the RLS key; `organizationId` is the
 * commercial boundary and is never the isolation key.
 * ADR-020 — every event reaches the bus through the transactional outbox.
 */

/**
 * All eleven fields are required. `causationId` is nullable but always present
 * (event-apis.md D-4: the optional-vs-null ambiguity is removed).
 */
export interface DomainEvent<T> {
  /** UUIDv7 — globally unique, time-ordered. Identity across outbox, bus, DLQ, replay. */
  readonly eventId: string;
  /** PascalCase past tense: 'ArticlePublished'. */
  readonly eventType: string;
  /** Payload schema version. Registry validation and version transformation. */
  readonly eventVersion: number;
  /** 'Article'. */
  readonly aggregateType: string;
  /** The ONLY ordering/partition key (event-apis.md rule 4). */
  readonly aggregateId: string;
  /** Workspace — never optional. ADR-017. */
  readonly tenantId: string;
  /** Commercial boundary — ADR-017. */
  readonly organizationId: string;
  /** Groups everything caused by one request. The primary incident query. */
  readonly correlationId: string;
  /** Direct parent; null for root events. Never optional. */
  readonly causationId: string | null;
  /** Component that published. Attribution on DLQ entries and contract ownership. */
  readonly producer: string;
  /**
   * ISO 8601 UTC, from the injected Clock.
   *
   * String, not `Date`, because it crosses a serialization boundary and must
   * round-trip byte-identically through the outbox, the bus, the DLQ, and
   * replay (event-apis.md D-5). Handlers use this, never wall-clock.
   */
  readonly occurredAt: string;
  readonly payload: T;
}

/**
 * The envelope field names, frozen. Used by the registry's structural check and
 * by the conformance suite that asserts the envelope has not drifted.
 */
export const ENVELOPE_FIELDS = [
  'eventId',
  'eventType',
  'eventVersion',
  'aggregateType',
  'aggregateId',
  'tenantId',
  'organizationId',
  'correlationId',
  'causationId',
  'producer',
  'occurredAt',
  'payload',
] as const;

export type EnvelopeField = (typeof ENVELOPE_FIELDS)[number];
