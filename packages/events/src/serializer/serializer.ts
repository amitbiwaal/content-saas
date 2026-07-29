/**
 * Event serializer — the wire format.
 *
 * Spec: `13-event-platform/event-apis.md` and `versioning.md`.
 *
 * THE ENVELOPE MUST ROUND-TRIP BYTE-IDENTICALLY through the outbox, the bus,
 * the DLQ, and replay. That is why `occurredAt` is an ISO 8601 STRING rather
 * than a `Date` (D-5): a Date re-serialises through the local timezone and
 * millisecond truncation, so a replayed event would differ from the one that
 * was published — and the DLQ record would no longer match the original.
 *
 * EVERY EVENT IS IMMUTABLE. Deserialization never rewrites a historical event:
 * version transformation happens in memory, on read, at the delivery path
 * (`registry.transform`). This module moves bytes; it does not interpret them.
 */

import { ENVELOPE_FIELDS, type DomainEvent } from '@contentos/contracts';

import { assertValidEnvelope, type ValidationIssue } from '../envelope/validation.js';

export class DeserializationError extends Error {
  /** Terminal: malformed bytes are never retried into correctness. */
  readonly code = 'SchemaViolation';
  readonly issues: readonly ValidationIssue[];

  constructor(message: string, issues: readonly ValidationIssue[] = []) {
    super(message);
    this.name = 'DeserializationError';
    this.issues = issues;
  }
}

/**
 * Canonical field order.
 *
 * Serialising in a FIXED order rather than whatever `Object.keys` yields makes
 * the output byte-stable for a given event, so two encodings of the same event
 * are identical strings. That is what lets a consumer compare, hash, or
 * deduplicate on the encoded form.
 */
function canonical(event: DomainEvent<unknown>): Record<string, unknown> {
  return {
    eventId: event.eventId,
    eventType: event.eventType,
    eventVersion: event.eventVersion,
    aggregateType: event.aggregateType,
    aggregateId: event.aggregateId,
    tenantId: event.tenantId,
    organizationId: event.organizationId,
    correlationId: event.correlationId,
    causationId: event.causationId,
    producer: event.producer,
    occurredAt: event.occurredAt,
    payload: event.payload,
  };
}

export interface EventSerializer {
  /** Validates BEFORE encoding, so malformed events never reach the wire. */
  serialize(event: DomainEvent<unknown>): string;
  deserialize(raw: string): DomainEvent<unknown>;
  /** Redis Streams carries flat field/value pairs, not a JSON document. */
  toStreamFields(event: DomainEvent<unknown>): Record<string, string>;
  fromStreamFields(fields: Record<string, string>): DomainEvent<unknown>;
}

const REQUIRED = new Set<string>(ENVELOPE_FIELDS);

function parseObject(raw: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new DeserializationError('Event is not valid JSON.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new DeserializationError('Event must decode to an object.');
  }
  return parsed as Record<string, unknown>;
}

/**
 * FORWARD COMPATIBILITY: unrecognised top-level fields are IGNORED, not
 * rejected. A consumer running an older build must tolerate an envelope
 * written by a newer one — otherwise every additive change becomes a breaking
 * one, and the deprecation window that `versioning.md` depends on cannot exist.
 *
 * The reverse is not tolerated: a MISSING required field is an error, because
 * an envelope without tenancy or an ordering key cannot be handled safely at
 * all.
 */
/**
 * Read a required string field.
 *
 * `String(value)` on an object yields '[object Object]' — a garbage identifier
 * that would pass through here and only fail later, or worse, become a real
 * aggregateId. At a trust boundary the decode must reject the wrong TYPE, not
 * coerce it into a plausible-looking string.
 */
function text(source: Record<string, unknown>, field: string): string {
  const value = source[field];
  if (typeof value !== 'string') {
    throw new DeserializationError(
      `Envelope field '${field}' must be a string; received ${typeof value}.`,
      [{ field, code: 'WRONG_TYPE', detail: `expected string, received ${typeof value}` }],
    );
  }
  return value;
}

function toEnvelope(source: Record<string, unknown>): DomainEvent<unknown> {
  const missing = [...REQUIRED].filter((f) => !Object.prototype.hasOwnProperty.call(source, f));
  if (missing.length > 0) {
    throw new DeserializationError(
      `Envelope is missing required field(s): ${missing.join(', ')}.`,
      missing.map((f) => ({ field: f, code: 'MISSING_FIELD', detail: 'required' })),
    );
  }

  return {
    eventId: text(source, 'eventId'),
    eventType: text(source, 'eventType'),
    eventVersion: Number(source['eventVersion']),
    aggregateType: text(source, 'aggregateType'),
    aggregateId: text(source, 'aggregateId'),
    tenantId: text(source, 'tenantId'),
    organizationId: text(source, 'organizationId'),
    correlationId: text(source, 'correlationId'),
    causationId: source['causationId'] === null ? null : text(source, 'causationId'),
    producer: text(source, 'producer'),
    occurredAt: text(source, 'occurredAt'),
    payload: source['payload'],
  };
}

export function createEventSerializer(): EventSerializer {
  return {
    serialize(event): string {
      // Validate before encoding. An invalid event must fail at its producer,
      // not at a consumer that cannot do anything about it.
      assertValidEnvelope(event);
      return JSON.stringify(canonical(event));
    },

    deserialize(raw): DomainEvent<unknown> {
      const event = toEnvelope(parseObject(raw));
      // Re-validated on the way in: bytes may have come from a producer running
      // different code, and the boundary is where that stops being assumed.
      assertValidEnvelope(event);
      return event;
    },

    /**
     * Redis Streams entries are flat field/value maps. The envelope is split so
     * `eventType`, `aggregateId` and `tenantId` are readable without decoding
     * the payload — which is what lets the bus filter and route without
     * understanding the event.
     */
    toStreamFields(event): Record<string, string> {
      assertValidEnvelope(event);
      return {
        eventId: event.eventId,
        eventType: event.eventType,
        eventVersion: String(event.eventVersion),
        aggregateType: event.aggregateType,
        aggregateId: event.aggregateId,
        tenantId: event.tenantId,
        organizationId: event.organizationId,
        correlationId: event.correlationId,
        // Redis stores strings only; a root event's null becomes the empty
        // string and is restored on the way back.
        causationId: event.causationId ?? '',
        producer: event.producer,
        occurredAt: event.occurredAt,
        payload: JSON.stringify(event.payload),
      };
    },

    fromStreamFields(fields): DomainEvent<unknown> {
      const payloadRaw = fields['payload'];
      if (payloadRaw === undefined) {
        throw new DeserializationError('Stream entry is missing the payload field.');
      }
      let payload: unknown;
      try {
        payload = JSON.parse(payloadRaw);
      } catch {
        throw new DeserializationError('Stream entry payload is not valid JSON.');
      }

      const event = toEnvelope({
        ...fields,
        eventVersion: Number(fields['eventVersion']),
        causationId: fields['causationId'] === '' ? null : fields['causationId'],
        payload,
      });
      assertValidEnvelope(event);
      return event;
    },
  };
}
