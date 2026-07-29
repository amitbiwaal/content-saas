import { describe, expect, it } from 'vitest';

import type { DomainEvent } from '@contentos/contracts';

import { createEventSerializer, DeserializationError } from './serializer.js';

const serializer = createEventSerializer();

function event(over: Partial<DomainEvent<unknown>> = {}): DomainEvent<unknown> {
  return {
    eventId: '018f7a1e-0000-7000-8000-000000000001',
    eventType: 'ArticlePublished',
    eventVersion: 1,
    aggregateType: 'Article',
    aggregateId: '018f7a1e-0000-7000-8000-0000000000c1',
    tenantId: '018f7a1e-0000-7000-8000-0000000000bb',
    organizationId: '018f7a1e-0000-7000-8000-0000000000aa',
    correlationId: '018f7a1e-0000-7000-8000-0000000000dd',
    causationId: null,
    producer: 'content-platform',
    occurredAt: '2026-07-29T10:00:00.000Z',
    payload: { articleId: 'a1', revision: 4 },
    ...over,
  };
}

describe('round-trip fidelity', () => {
  it('restores an identical envelope', () => {
    const original = event();
    expect(serializer.deserialize(serializer.serialize(original))).toEqual(original);
  });

  // A Date would re-serialise through the local timezone and lose fidelity, so
  // a replayed event would differ from the one published.
  it('preserves occurredAt byte-identically', () => {
    const at = '2026-07-29T10:00:00.123Z';
    expect(serializer.deserialize(serializer.serialize(event({ occurredAt: at }))).occurredAt).toBe(
      at,
    );
  });

  it('preserves a null causationId on a root event', () => {
    expect(serializer.deserialize(serializer.serialize(event())).causationId).toBeNull();
  });

  it('preserves a non-null causationId', () => {
    const id = '018f7a1e-0000-7000-8000-0000000000ee';
    expect(
      serializer.deserialize(serializer.serialize(event({ causationId: id }))).causationId,
    ).toBe(id);
  });

  it('preserves payload values exactly, including nested structures', () => {
    const payload = { nested: { count: 0, flag: false, list: [1, 2, 3] }, ratio: 0.125 };
    expect(serializer.deserialize(serializer.serialize(event({ payload }))).payload).toEqual(
      payload,
    );
  });

  // Byte-stable output is what lets a consumer hash or deduplicate on the
  // encoded form.
  it('encodes deterministically regardless of source key order', () => {
    const a = serializer.serialize(event());
    const reordered = { ...event() };
    expect(serializer.serialize(reordered)).toBe(a);
  });
});

describe('validation at the boundary', () => {
  it('refuses to serialize a malformed envelope', () => {
    expect(() => serializer.serialize(event({ tenantId: 'not-a-uuid' }))).toThrow(/tenantId/);
  });

  it('refuses to serialize a payload carrying a credential', () => {
    expect(() => serializer.serialize(event({ payload: { apiKey: 'sk-live' } }))).toThrow();
  });

  it('rejects non-JSON input', () => {
    expect(() => serializer.deserialize('{not json')).toThrow(DeserializationError);
  });

  it('rejects a JSON array', () => {
    expect(() => serializer.deserialize('[]')).toThrow(/must decode to an object/);
  });

  // An envelope without tenancy or an ordering key cannot be handled safely.
  it('rejects an envelope missing a required field', () => {
    const { tenantId: _omitted, ...partial } = event() as Record<string, unknown>;
    expect(() => serializer.deserialize(JSON.stringify(partial))).toThrow(
      /missing required field/i,
    );
  });

  it('names every missing field', () => {
    try {
      serializer.deserialize(JSON.stringify({ eventId: 'x' }));
      expect.fail('should have thrown');
    } catch (error) {
      expect((error as DeserializationError).issues.length).toBeGreaterThan(5);
    }
  });

  it('classifies a malformed event as terminal, never retried', () => {
    try {
      serializer.deserialize('{');
      expect.fail('should have thrown');
    } catch (error) {
      expect((error as DeserializationError).code).toBe('SchemaViolation');
    }
  });
});

describe('forward compatibility', () => {
  // Otherwise every additive change becomes a breaking one, and the
  // deprecation window versioning.md depends on cannot exist.
  it('ignores an unrecognised field written by a newer producer', () => {
    const withExtra = { ...event(), futureField: 'added in a later release' };
    const decoded = serializer.deserialize(JSON.stringify(withExtra));
    expect(decoded).toEqual(event());
    expect(decoded).not.toHaveProperty('futureField');
  });

  it('accepts a higher eventVersion without rewriting it', () => {
    const decoded = serializer.deserialize(serializer.serialize(event({ eventVersion: 7 })));
    expect(decoded.eventVersion).toBe(7);
  });
});

describe('Redis Streams field encoding', () => {
  it('round-trips through flat field/value pairs', () => {
    const original = event();
    expect(serializer.fromStreamFields(serializer.toStreamFields(original))).toEqual(original);
  });

  // The bus routes and filters without decoding the payload.
  it('exposes routing identifiers as top-level fields', () => {
    const fields = serializer.toStreamFields(event());
    expect(fields['eventType']).toBe('ArticlePublished');
    expect(fields['aggregateId']).toBe('018f7a1e-0000-7000-8000-0000000000c1');
    expect(fields['tenantId']).toBe('018f7a1e-0000-7000-8000-0000000000bb');
  });

  it('encodes every field as a string, as Redis requires', () => {
    for (const value of Object.values(serializer.toStreamFields(event()))) {
      expect(typeof value).toBe('string');
    }
  });

  it('represents a null causationId as an empty string and restores it', () => {
    const fields = serializer.toStreamFields(event());
    expect(fields['causationId']).toBe('');
    expect(serializer.fromStreamFields(fields).causationId).toBeNull();
  });

  it('rejects a stream entry with no payload field', () => {
    const { payload: _dropped, ...fields } = serializer.toStreamFields(event());
    expect(() => serializer.fromStreamFields(fields)).toThrow(/missing the payload/);
  });

  it('rejects a stream entry whose payload is not JSON', () => {
    const fields = { ...serializer.toStreamFields(event()), payload: '{oops' };
    expect(() => serializer.fromStreamFields(fields)).toThrow(/not valid JSON/);
  });
});
