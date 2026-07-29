import { describe, expect, it } from 'vitest';

import { ENVELOPE_FIELDS } from './envelope.js';
import type { DomainEvent } from './envelope.js';

describe('canonical event envelope (FROZEN)', () => {
  // event-apis.md rule 2 — adding a field is an ADR, not a patch.
  it('freezes exactly the twelve declared fields', () => {
    expect(ENVELOPE_FIELDS).toEqual([
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
    ]);
  });

  // D-3 — `producer` had no source before Phase 8 added it to the envelope.
  it('includes producer, required by DeadLetterEntry attribution', () => {
    expect(ENVELOPE_FIELDS).toContain('producer');
  });

  // D-9 — organizationId is required by ADR-017 and is a column on outbox_events.
  it('retains organizationId for RLS context reconstruction', () => {
    expect(ENVELOPE_FIELDS).toContain('organizationId');
  });

  it('populates every frozen field on a well-formed event', () => {
    const event: DomainEvent<{ articleId: string }> = {
      eventId: '01927f3a-0000-7000-8000-000000000001',
      eventType: 'ArticlePublished',
      eventVersion: 1,
      aggregateType: 'Article',
      aggregateId: 'art-1',
      tenantId: 'ws-1',
      organizationId: 'org-1',
      correlationId: 'corr-1',
      causationId: null,
      producer: 'content-platform',
      occurredAt: '2026-07-29T10:00:00.000Z',
      payload: { articleId: 'art-1' },
    };

    for (const field of ENVELOPE_FIELDS) {
      expect(Object.prototype.hasOwnProperty.call(event, field), field).toBe(true);
    }
  });

  // D-4 — causationId is nullable but always present, never optional.
  it('carries causationId as null on a root event rather than omitting it', () => {
    const root: DomainEvent<Record<string, never>> = {
      eventId: '01927f3a-0000-7000-8000-000000000002',
      eventType: 'RunStarted',
      eventVersion: 1,
      aggregateType: 'Run',
      aggregateId: 'run-1',
      tenantId: 'ws-1',
      organizationId: 'org-1',
      correlationId: 'corr-1',
      causationId: null,
      producer: 'content-platform',
      occurredAt: '2026-07-29T10:00:00.000Z',
      payload: {},
    };
    expect(root.causationId).toBeNull();
    expect('causationId' in root).toBe(true);
  });

  // D-5 — the envelope is the wire contract: ISO 8601 string, not Date.
  it('represents occurredAt as an ISO 8601 string that round-trips byte-identically', () => {
    const wire = '2026-07-29T10:00:00.000Z';
    expect(new Date(wire).toISOString()).toBe(wire);
  });
});
