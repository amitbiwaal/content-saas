/**
 * The credit ledger event envelopes.
 *
 * The two properties worth pinning are both about what the payload does NOT
 * carry: the operator's reason text, and an amount that has been through a
 * JavaScript number.
 */
import { describe, expect, it } from 'vitest';

import {
  CREDIT_ACCOUNT_AGGREGATE,
  CREDIT_EVENT_TYPES,
  CREDIT_PRODUCER,
  creditAdjusted,
  creditConsumed,
  creditEventTenantId,
  creditExpired,
  creditGranted,
  creditRefunded,
} from './events.js';

const ORG = '018f7a1e-0000-7000-8000-0000000000aa';
const WS = '018f7a1e-0000-7000-8000-0000000000bb';
const ENTRY = '018f7a1e-0000-7000-8000-0000000000e1';
const ORIGINAL = '018f7a1e-0000-7000-8000-0000000000e0';
const EVENT_ID = '018f7a1e-0000-7000-8000-0000000000ee';
const CORRELATION = '018f7a1e-0000-7000-8000-0000000000dd';

const ctx = {
  eventId: EVENT_ID,
  correlationId: CORRELATION,
  causationId: null,
  occurredAt: '2026-07-30T12:00:00.000Z',
};

const base = { entryId: ENTRY, organizationId: ORG, amount: '12.500000' } as const;

const ALL = [
  ['CreditGranted', creditGranted({ ...ctx }, { ...base, direction: 'credit' })],
  ['CreditConsumed', creditConsumed({ ...ctx }, { ...base, direction: 'debit', workspaceId: WS })],
  [
    'CreditRefunded',
    creditRefunded({ ...ctx }, { ...base, direction: 'credit', referenceEntryId: ORIGINAL }),
  ],
  ['CreditAdjusted', creditAdjusted({ ...ctx }, { ...base, direction: 'debit' })],
  ['CreditExpired', creditExpired({ ...ctx }, { ...base, direction: 'debit' })],
] as const;

describe('the ledger event vocabulary', () => {
  it('declares the five types the entry types map onto', () => {
    expect([...CREDIT_EVENT_TYPES].sort()).toEqual([
      'CreditAdjusted',
      'CreditConsumed',
      'CreditExpired',
      'CreditGranted',
      'CreditRefunded',
    ]);
  });

  // The hold protocol and the balance engine do not exist yet; declaring their
  // events would register types nothing can emit.
  it('declares nothing from the hold protocol or the balance engine', () => {
    for (const absent of [
      'CreditHeld',
      'CreditSettled',
      'CreditReleased',
      'CreditsLow',
      'CreditsExhausted',
    ]) {
      expect(CREDIT_EVENT_TYPES as readonly string[], absent).not.toContain(absent);
    }
  });

  it('builds one envelope per declared type', () => {
    expect(ALL.map(([type]) => type).sort()).toEqual([...CREDIT_EVENT_TYPES].sort());
  });
});

describe('every ledger event carries the credit account envelope', () => {
  for (const [type, event] of ALL) {
    it(`${type} names the account aggregate and the organization tenant`, () => {
      expect(event).toMatchObject({
        eventType: type,
        eventVersion: 1,
        aggregateType: CREDIT_ACCOUNT_AGGREGATE,
        // Balance resolves per organization, so ordering must too.
        aggregateId: ORG,
        tenantId: ORG,
        organizationId: ORG,
        producer: CREDIT_PRODUCER,
        eventId: EVENT_ID,
        correlationId: CORRELATION,
        causationId: null,
        occurredAt: '2026-07-30T12:00:00.000Z',
      });
    });
  }

  it('resolves the tenant to the organization, which is what the column CHECKs', () => {
    expect(creditEventTenantId(ORG)).toBe(ORG);
  });
});

describe('payload discipline', () => {
  // A JSON number would round-trip through an IEEE-754 double, and the ledger
  // has no UPDATE path to correct what that loses.
  for (const [type, event] of ALL) {
    it(`${type} serialises the amount as a string`, () => {
      const payload = JSON.parse(JSON.stringify(event.payload)) as { amount: unknown };
      expect(typeof payload.amount).toBe('string');
      expect(payload.amount).toBe('12.500000');
      expect(JSON.stringify(event.payload)).toContain('"12.500000"');
    });
  }

  it('preserves a value a double would round', () => {
    const event = creditConsumed(ctx, {
      entryId: ENTRY,
      organizationId: ORG,
      amount: '0.100000',
      direction: 'debit',
      workspaceId: WS,
    });
    const round = JSON.parse(JSON.stringify(event.payload)) as { amount: string };
    expect(round.amount).toBe('0.100000');
  });

  // The reason is operator-written free text and reaches consumers with weaker
  // controls than the row does. There is nowhere in the payload types to put
  // it; this pins that the builders cannot be talked into one either.
  it('carries no reason text anywhere in any payload', () => {
    const REASON = 'goodwill-credit-for-incident-4471';
    for (const [type, event] of ALL) {
      expect(JSON.stringify(event.payload), type).not.toContain(REASON);
      expect(Object.keys(event.payload as object), type).not.toContain('reason');
    }
  });

  it('attributes consumption to a workspace and nothing else', () => {
    const consumed = creditConsumed(ctx, { ...base, direction: 'debit', workspaceId: WS });
    expect(consumed.payload.workspaceId).toBe(WS);
    // The workspace is attribution, not scope: the tenant stays the organization.
    expect(consumed.tenantId).toBe(ORG);

    for (const [type, event] of ALL) {
      if (type === 'CreditConsumed') continue;
      expect(Object.keys(event.payload as object), type).not.toContain('workspaceId');
    }
  });

  it('links a refund to the charge it reverses', () => {
    const refund = creditRefunded(ctx, {
      ...base,
      direction: 'credit',
      referenceEntryId: ORIGINAL,
    });
    expect(refund.payload.referenceEntryId).toBe(ORIGINAL);
  });

  it('carries the causation id of the event that caused it', () => {
    const caused = creditConsumed(
      { ...ctx, causationId: '018f7a1e-0000-7000-8000-0000000000c9' },
      { ...base, direction: 'debit', workspaceId: WS },
    );
    expect(caused.causationId).toBe('018f7a1e-0000-7000-8000-0000000000c9');
  });
});
