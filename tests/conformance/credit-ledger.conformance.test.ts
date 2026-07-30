/**
 * The credit ledger against the REAL event platform.
 *
 * Three things a unit test in `packages/platform` cannot check, because that
 * package may not import `packages/events`:
 *
 *   - the envelopes survive the frozen validator's payload rules;
 *   - a real registry built from the platform's own contribution accepts them;
 *   - they survive the serializer intact, which is what makes them replayable.
 *
 * The last one carries the most weight for a financial record. Replay
 * reconstructs a balance read model from the outbox, so an amount that does not
 * come back byte-for-byte is a balance that silently disagrees with the ledger
 * it was rebuilt from — and the ledger has no UPDATE path to reconcile against.
 */

import { describe, expect, it } from 'vitest';

import { createEventRegistry, createEventSerializer, validateEnvelope } from '@contentos/events';
import {
  CREDIT_ACCOUNT_AGGREGATE,
  CREDIT_EVENT_TYPES,
  CREDIT_PRODUCER,
  CREDIT_STREAM,
  createCreditLedgerService,
  creditAdjusted,
  creditConsumed,
  creditExpired,
  creditGranted,
  creditRefunded,
  PLATFORM_EVENT_DECLARATIONS,
  type LedgerExecutor,
} from '@contentos/platform';
import type { DomainEvent, EventPublisher, Transaction } from '@contentos/contracts';
import type { AuditWriter, NewAuditRecord } from '@contentos/security';

const ORG = '018f7a1e-0000-7000-8000-0000000000aa';
const WS = '018f7a1e-0000-7000-8000-0000000000bb';
const ENTRY = '018f7a1e-0000-7000-8000-0000000000e1';
const ORIGINAL = '018f7a1e-0000-7000-8000-0000000000e0';
const ACTOR = '018f7a1e-0000-7000-8000-000000000001';
const EVENT_ID = '018f7a1e-0000-7000-8000-0000000000ee';
const CORRELATION = '018f7a1e-0000-7000-8000-0000000000dd';

const ctx = {
  eventId: EVENT_ID,
  correlationId: CORRELATION,
  causationId: null,
  occurredAt: '2026-07-30T12:00:00.000Z',
};

const base = { entryId: ENTRY, organizationId: ORG, amount: '12.500000' } as const;

const EVENTS: readonly DomainEvent<unknown>[] = [
  creditGranted(ctx, { ...base, direction: 'credit' }),
  creditConsumed(ctx, { ...base, direction: 'debit', workspaceId: WS }),
  creditRefunded(ctx, { ...base, direction: 'credit', referenceEntryId: ORIGINAL }),
  creditAdjusted(ctx, { ...base, direction: 'debit' }),
  creditExpired(ctx, { ...base, direction: 'debit' }),
];

describe('ledger events satisfy the frozen envelope contract', () => {
  for (const event of EVENTS) {
    it(`${event.eventType} validates`, () => {
      const result = validateEnvelope(event);
      expect(result.ok, JSON.stringify(result)).toBe(true);
    });
  }

  it('builds one envelope per declared type', () => {
    expect(EVENTS.map((e) => e.eventType).sort()).toEqual([...CREDIT_EVENT_TYPES].sort());
  });
});

describe('a real registry, built from the platform contribution, accepts them', () => {
  const registry = createEventRegistry([...PLATFORM_EVENT_DECLARATIONS]);

  for (const event of EVENTS) {
    it(`registers and validates ${event.eventType}`, () => {
      expect(registry.isRegistered(event.eventType, 1)).toBe(true);
      const result = registry.validate(event);
      expect(result.ok, JSON.stringify(result)).toBe(true);
    });
  }

  it('routes the whole family to the credit stream', () => {
    for (const eventType of CREDIT_EVENT_TYPES) {
      expect(registry.streamFor(eventType), eventType).toBe(CREDIT_STREAM);
    }
  });

  // Adding the ledger must not have collided with anything Sprint 1 declared —
  // a duplicate type or producer is a startup failure, not a warning.
  it('builds without a collision against every other platform declaration', () => {
    expect(() => createEventRegistry([...PLATFORM_EVENT_DECLARATIONS])).not.toThrow();
  });
});

describe('replay compatibility — the serializer round-trip', () => {
  const serializer = createEventSerializer();

  for (const event of EVENTS) {
    it(`${event.eventType} survives serialize → deserialize unchanged`, () => {
      const restored = serializer.deserialize(serializer.serialize(event));
      expect(restored).toEqual(event);
    });

    it(`${event.eventType} survives the Redis Streams field encoding`, () => {
      const restored = serializer.fromStreamFields(serializer.toStreamFields(event));
      expect(restored).toEqual(event);
    });
  }

  // The reason a financial ledger cares: a replayed balance must equal the
  // recorded one, to the last of six decimal places.
  it('preserves an amount a double would round', () => {
    const event = creditConsumed(ctx, {
      entryId: ENTRY,
      organizationId: ORG,
      amount: '0.100000',
      direction: 'debit',
      workspaceId: WS,
    });
    const restored = serializer.deserialize(serializer.serialize(event));
    expect((restored.payload as { amount: unknown }).amount).toBe('0.100000');
  });

  it('preserves a magnitude past the safe-integer range', () => {
    const event = creditGranted(ctx, {
      entryId: ENTRY,
      organizationId: ORG,
      amount: '99999999999999.999999',
      direction: 'credit',
    });
    const restored = serializer.deserialize(serializer.serialize(event));
    expect((restored.payload as { amount: unknown }).amount).toBe('99999999999999.999999');
    // The whole point of the string: this is what a number would have become.
    expect(String(Number('99999999999999.999999'))).not.toBe('99999999999999.999999');
  });
});

describe('the service emits what the registry accepts', () => {
  /** Minimal executor: the wiring is what is under test, not the SQL. */
  function wiring(): {
    tx: LedgerExecutor;
    publisher: EventPublisher;
    audit: AuditWriter;
    published: DomainEvent<unknown>[];
    audits: NewAuditRecord[];
  } {
    const published: DomainEvent<unknown>[] = [];
    const audits: NewAuditRecord[] = [];
    const tx = {
      query<T>(sql: string, params?: readonly unknown[]): Promise<readonly T[]> {
        if (!sql.includes('INSERT INTO credit_ledger_entries')) return Promise.resolve([]);
        const p = [...(params ?? [])] as (string | null)[];
        return Promise.resolve([
          {
            id: ENTRY,
            tenantId: p[0],
            organizationId: p[0],
            workspaceId: p[1],
            entryType: p[2],
            amount: p[3],
            direction: p[4],
            idempotencyKey: p[5],
            referenceEntryId: p[6],
            reason: p[7],
            correlationId: p[8],
            createdBy: p[9],
            metadata: {},
            createdAt: '2026-07-30T12:00:00.000Z',
          },
        ] as unknown as T[]);
      },
    } as unknown as LedgerExecutor;

    return {
      tx,
      published,
      audits,
      publisher: {
        publish<T>(_tx: Transaction, event: DomainEvent<T>): Promise<void> {
          published.push(event as DomainEvent<unknown>);
          return Promise.resolve();
        },
      },
      audit: {
        record(_tx: Transaction, entry: NewAuditRecord): Promise<string> {
          audits.push(entry);
          return Promise.resolve('audit-id');
        },
      },
    };
  }

  const registry = createEventRegistry([...PLATFORM_EVENT_DECLARATIONS]);

  const APPENDS = [
    ['grant', {}],
    ['consumption', { workspaceId: WS }],
    ['refund', { referenceEntryId: ORIGINAL }],
    ['adjustment', { direction: 'debit' as const }],
    ['expiry', {}],
  ] as const;

  for (const [entryType, extra] of APPENDS) {
    it(`the event append() publishes for a ${entryType} passes the real registry`, async () => {
      const w = wiring();
      const service = createCreditLedgerService({
        publisher: w.publisher,
        audit: w.audit,
        now: () => new Date('2026-07-30T12:00:00.000Z'),
        newEventId: () => EVENT_ID,
      });

      await service.append(w.tx, {
        organizationId: ORG,
        entryType,
        amount: '3.250000',
        reason: 'Conformance fixture.',
        actor: { id: ACTOR, kind: 'service' },
        correlationId: CORRELATION,
        ...extra,
      });

      expect(w.published).toHaveLength(1);
      const event = w.published[0];
      expect(event).toBeDefined();
      if (event === undefined) return;

      const result = registry.validate(event);
      expect(result.ok, JSON.stringify(result)).toBe(true);
      expect(event).toMatchObject({
        aggregateType: CREDIT_ACCOUNT_AGGREGATE,
        producer: CREDIT_PRODUCER,
        tenantId: ORG,
        organizationId: ORG,
      });
    });
  }

  // The service builds the envelope from the row it just wrote, so the
  // round-trip has to hold for what it actually emits, not only for fixtures.
  it('publishes an event that replays intact', async () => {
    const w = wiring();
    const service = createCreditLedgerService({
      publisher: w.publisher,
      audit: w.audit,
      now: () => new Date('2026-07-30T12:00:00.000Z'),
      newEventId: () => EVENT_ID,
    });
    await service.append(w.tx, {
      organizationId: ORG,
      entryType: 'consumption',
      workspaceId: WS,
      amount: '0.000001',
      reason: 'Smallest recordable charge.',
      actor: { id: ACTOR, kind: 'service' },
      correlationId: CORRELATION,
    });

    const serializer = createEventSerializer();
    const event = w.published[0];
    expect(event).toBeDefined();
    if (event === undefined) return;
    expect(serializer.deserialize(serializer.serialize(event))).toEqual(event);
    expect((event.payload as { amount: unknown }).amount).toBe('0.000001');
  });
});
