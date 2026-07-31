/**
 * The settlement core against the frozen path, running.
 *
 * The unit suite checks the arithmetic and the guards on values. This drives
 * the FROZEN `credits-service` end to end — authorize, consume, settle —
 * against `credits-db.fixture.ts`, which implements the mechanisms the
 * correctness argument rests on (the advisory lock, the `FOR UPDATE` row lock,
 * both unique constraints, `CHECK (consumed <= amount)`, and guarded
 * transitions), and asserts that the pure layer says exactly what the SQL path
 * did.
 *
 * That is the whole point of a pure twin: if the two can disagree about how
 * much a run cost or how much came back, one of them is lying to a customer.
 */

import { describe, expect, it } from 'vitest';

import type { DomainEvent, EventPublisher, Transaction } from '@contentos/contracts';
import type { AuditWriter, NewAuditRecord } from '@contentos/security';

import { calculateAvailability } from './availability.js';
import { calculateBalance } from './aggregate.js';
import { availableOf, createCreditsDb, type CreditsDb } from './credits-db.fixture.js';
import {
  createCreditsService,
  type AuthorizeSpendCommand,
  type CreditsService,
} from './credits-service.js';
import { HoldError } from './holds.js';
import type { LedgerEntry } from './ledger.js';
import { toCreditReservation } from './reservation.js';
import { createCreditLedgerService } from './service.js';
import {
  assertSettleable,
  computeSettlement,
  planSettlement,
  summarizeSettlements,
  toReservationSettlement,
  toSettlementClosure,
} from './settlement.js';

const ORG = '018f7a1e-0000-7000-8000-0000000000aa';
const WS = '018f7a1e-0000-7000-8000-0000000000bb';
const ACTOR = '018f7a1e-0000-7000-8000-000000000001';
const CORRELATION = '018f7a1e-0000-7000-8000-0000000000dd';
const NOW = new Date('2026-07-31T12:00:00.000Z');
const AT = NOW.toISOString();

interface Rig {
  readonly db: CreditsDb;
  readonly credits: CreditsService;
  readonly published: DomainEvent<unknown>[];
}

function rig(): Rig {
  const published: DomainEvent<unknown>[] = [];
  const now = (): Date => NOW;
  const db = createCreditsDb({ now });

  const publisher: EventPublisher = {
    publish<T>(_tx: Transaction, event: DomainEvent<T>): Promise<void> {
      published.push(event as DomainEvent<unknown>);
      return Promise.resolve();
    },
  };
  const audit: AuditWriter = {
    record(_tx: Transaction, _entry: NewAuditRecord): Promise<string> {
      return Promise.resolve('audit-id');
    },
  };

  let eventSeq = 0;
  const newEventId = (): string =>
    `018f7a1e-0000-7000-9000-${String((eventSeq += 1)).padStart(12, '0')}`;

  const credits = createCreditsService({
    ledger: createCreditLedgerService({ publisher, audit, now, newEventId }),
    publisher,
    lowBalanceThreshold: '10',
    now,
    newEventId,
  });

  return { db, credits, published };
}

const authorize = (over: Partial<AuthorizeSpendCommand> = {}): AuthorizeSpendCommand => ({
  organizationId: ORG,
  workspaceId: WS,
  runId: 'run-0001',
  estimatedMax: '20.000000',
  reason: 'Article pipeline.',
  actor: { id: ACTOR, kind: 'service' },
  correlationId: CORRELATION,
  ...over,
});

/**
 * Reserve, charge each step, and hand back the hold id.
 *
 * Every step of a real run: one authorization, N consumptions, no settle yet.
 */
async function runUpTo(
  r: Rig,
  options: {
    readonly grant: string;
    readonly reserve: string;
    readonly charges: readonly string[];
  },
): Promise<string> {
  r.db.seedGrant(ORG, options.grant);

  const authorized = await r.db.transaction((tx) =>
    r.credits.authorizeSpend(tx, authorize({ estimatedMax: options.reserve })),
  );
  const holdId = authorized.hold.id;

  for (const [index, amount] of options.charges.entries()) {
    await r.db.transaction((tx) =>
      r.credits.recordConsumption(tx, {
        organizationId: ORG,
        holdId,
        amount,
        idempotencyKey: `run-0001:step-${String(index)}`,
        reason: `step ${String(index)}`,
        actor: { id: ACTOR, kind: 'service' },
        correlationId: CORRELATION,
      }),
    );
  }

  return holdId;
}

const holdOf = (r: Rig, holdId: string): Awaited<ReturnType<CreditsService['findHold']>> => {
  const found = r.db.holds.find((hold) => hold.id === holdId);
  if (found === undefined) throw new Error(`no hold ${holdId}`);
  return {
    id: found.id,
    tenantId: found.tenantId,
    organizationId: found.organizationId,
    workspaceId: found.workspaceId,
    runId: found.runId,
    amount: found.amount,
    consumed: found.consumed,
    state: found.state as 'held' | 'settled' | 'released' | 'expired',
    expiresAt: found.expiresAt,
    reason: found.reason,
    correlationId: found.correlationId,
    createdBy: found.createdBy,
    metadata: found.metadata,
    createdAt: found.createdAt,
    settledAt: found.settledAt,
    releasedAt: found.releasedAt,
  };
};

const settleCommand = (holdId: string): Parameters<CreditsService['settle']>[1] => ({
  organizationId: ORG,
  holdId,
  actor: { id: ACTOR, kind: 'service' },
  correlationId: CORRELATION,
});

const command = (holdId: string): Parameters<typeof planSettlement>[0]['command'] => ({
  organizationId: ORG,
  workspaceId: WS,
  executionId: 'run-0001',
  reservationId: holdId,
  settledAt: AT,
});

const settledPayloadOf = (r: Rig): { consumed: string; released: string; amount: string } => {
  const event = r.published.find((published) => published.eventType === 'CreditSettled');
  if (event === undefined) throw new Error('no CreditSettled event');
  return event.payload as { consumed: string; released: string; amount: string };
};

/** The ledger, as the S5.1 fold reads it out of the fixture. */
const entriesOf = (r: Rig): LedgerEntry[] =>
  r.db.entries.map((entry) => ({
    id: entry.id,
    tenantId: entry.tenantId,
    organizationId: entry.organizationId,
    workspaceId: entry.workspaceId,
    entryType: entry.entryType as LedgerEntry['entryType'],
    amount: entry.amount,
    direction: entry.direction as LedgerEntry['direction'],
    idempotencyKey: entry.idempotencyKey,
    referenceEntryId: entry.referenceEntryId,
    reason: entry.reason,
    correlationId: entry.correlationId,
    createdBy: entry.createdBy,
    metadata: entry.metadata,
    createdAt: entry.createdAt,
  }));

// ── The pure layer agrees with the SQL path ─────────────────────────────────

describe('the settlement the pure layer plans is the one the service performs', () => {
  it('agrees on a partially consumed reservation', async () => {
    const r = rig();
    const holdId = await runUpTo(r, {
      grant: '100',
      reserve: '20.000000',
      charges: ['4.000000', '3.500000'],
    });

    const planned = planSettlement({
      command: command(holdId),
      reservation: toCreditReservation(holdOf(r, holdId)),
    });

    const result = await r.db.transaction((tx) => r.credits.settle(tx, settleCommand(holdId)));
    const closure = toSettlementClosure(result);

    expect(closure.outcome).toBe('settled');
    expect(closure.settlement.reserved).toBe(planned.reserved);
    expect(closure.settlement.consumed).toBe(planned.consumed);
    expect(closure.settlement.released).toBe(planned.released);
    expect(closure.settlement.usage).toBe('partial');
  });

  it('agrees with the figure the frozen CreditSettled event carries', async () => {
    // Two implementations of `amount − consumed` — one inline in the service's
    // event callback, one here. If they can disagree, a customer's statement
    // and their balance disagree.
    const r = rig();
    const holdId = await runUpTo(r, {
      grant: '100',
      reserve: '20.000000',
      charges: ['7.250000'],
    });

    const result = await r.db.transaction((tx) => r.credits.settle(tx, settleCommand(holdId)));
    const settlement = toSettlementClosure(result).settlement;
    const payload = settledPayloadOf(r);

    expect(settlement.reserved).toBe(payload.amount);
    expect(settlement.consumed).toBe(payload.consumed);
    expect(settlement.released).toBe(payload.released);
    expect(settlement.released).toBe('12.750000');
  });

  it('agrees on a fully consumed reservation', async () => {
    const r = rig();
    const holdId = await runUpTo(r, {
      grant: '100',
      reserve: '20.000000',
      charges: ['20.000000'],
    });

    const result = await r.db.transaction((tx) => r.credits.settle(tx, settleCommand(holdId)));
    const settlement = toSettlementClosure(result).settlement;

    expect(settlement.released).toBe('0.000000');
    expect(settlement.usage).toBe('exhausted');
    expect(settlement.released).toBe(settledPayloadOf(r).released);
  });

  it('agrees on a reservation nothing was charged against', async () => {
    const r = rig();
    const holdId = await runUpTo(r, { grant: '100', reserve: '20.000000', charges: [] });

    const result = await r.db.transaction((tx) => r.credits.settle(tx, settleCommand(holdId)));
    const settlement = toSettlementClosure(result).settlement;

    expect(settlement.consumed).toBe('0.000000');
    expect(settlement.released).toBe('20.000000');
    expect(settlement.usage).toBe('unused');
  });

  it('reads the instant the service stamped, not one of its own', async () => {
    const r = rig();
    const holdId = await runUpTo(r, { grant: '100', reserve: '20.000000', charges: [] });

    const result = await r.db.transaction((tx) => r.credits.settle(tx, settleCommand(holdId)));

    expect(toSettlementClosure(result).settlement.settledAt).toBe(result.hold.settledAt);
  });
});

// ── Released credits come back by arithmetic ────────────────────────────────

describe('settling gives the unspent credits back', () => {
  it('returns the remainder to availability, with no compensating entry', async () => {
    const r = rig();
    const holdId = await runUpTo(r, {
      grant: '100',
      reserve: '20.000000',
      charges: ['4.000000'],
    });

    // Held: the ledger is down 4, and 16 is still committed to the run.
    expect(availableOf(r.db, ORG)).toBe('80.000000');

    const before = r.db.entries.length;
    await r.db.transaction((tx) => r.credits.settle(tx, settleCommand(holdId)));

    // Settled: only the 4 that became a debit is gone.
    expect(availableOf(r.db, ORG)).toBe('96.000000');
    expect(r.db.entries.length).toBe(before);
  });

  it('is the same figure the pure availability calculation gives', async () => {
    const r = rig();
    const holdId = await runUpTo(r, {
      grant: '100',
      reserve: '20.000000',
      charges: ['4.000000'],
    });
    await r.db.transaction((tx) => r.credits.settle(tx, settleCommand(holdId)));

    const availability = calculateAvailability({
      balance: calculateBalance({ organizationId: ORG, entries: entriesOf(r) }),
      reservations: [toCreditReservation(holdOf(r, holdId))],
    });

    expect(availability.reserved).toBe('0.000000');
    expect(availability.available).toBe('96.000000');
    expect(availability.available).toBe(availableOf(r.db, ORG));
  });

  it('never gives back what was consumed', async () => {
    const r = rig();
    const holdId = await runUpTo(r, {
      grant: '100',
      reserve: '20.000000',
      charges: ['4.000000'],
    });
    await r.db.transaction((tx) => r.credits.settle(tx, settleCommand(holdId)));

    const balance = calculateBalance({ organizationId: ORG, entries: entriesOf(r) });

    expect(balance.balance).toBe('96.000000');
    expect(balance.debited).toBe('4.000000');
  });
});

// ── The ledger is untouched ─────────────────────────────────────────────────

describe('settlement appends nothing', () => {
  it('writes no entry of any kind', async () => {
    const r = rig();
    const holdId = await runUpTo(r, {
      grant: '100',
      reserve: '20.000000',
      charges: ['4.000000'],
    });

    const snapshot = entriesOf(r);
    await r.db.transaction((tx) => r.credits.settle(tx, settleCommand(holdId)));

    expect(entriesOf(r)).toEqual(snapshot);
  });

  it('writes no refund entry', async () => {
    const r = rig();
    const holdId = await runUpTo(r, {
      grant: '100',
      reserve: '20.000000',
      charges: ['4.000000'],
    });
    await r.db.transaction((tx) => r.credits.settle(tx, settleCommand(holdId)));

    expect(entriesOf(r).map((entry) => entry.entryType)).toEqual(['grant', 'consumption']);
  });

  it('leaves every prior entry exactly as it was', async () => {
    const r = rig();
    const holdId = await runUpTo(r, {
      grant: '100',
      reserve: '20.000000',
      charges: ['4.000000', '1.000000'],
    });

    const before = calculateBalance({ organizationId: ORG, entries: entriesOf(r) });
    await r.db.transaction((tx) => r.credits.settle(tx, settleCommand(holdId)));
    const after = calculateBalance({ organizationId: ORG, entries: entriesOf(r) });

    expect(after).toEqual(before);
  });
});

// ── The reservation closes, once and for good ───────────────────────────────

describe('a settled reservation is terminal', () => {
  it('cannot be consumed again', async () => {
    const r = rig();
    const holdId = await runUpTo(r, {
      grant: '100',
      reserve: '20.000000',
      charges: ['4.000000'],
    });
    await r.db.transaction((tx) => r.credits.settle(tx, settleCommand(holdId)));

    await expect(
      r.db.transaction((tx) =>
        r.credits.recordConsumption(tx, {
          organizationId: ORG,
          holdId,
          amount: '1.000000',
          idempotencyKey: 'run-0001:late',
          reason: 'a step that arrived after the run ended',
          actor: { id: ACTOR, kind: 'service' },
          correlationId: CORRELATION,
        }),
      ),
    ).rejects.toBeInstanceOf(HoldError);
  });

  it('is refused by the pure guard too', async () => {
    const r = rig();
    const holdId = await runUpTo(r, { grant: '100', reserve: '20.000000', charges: [] });
    await r.db.transaction((tx) => r.credits.settle(tx, settleCommand(holdId)));

    expect(() => {
      assertSettleable(toCreditReservation(holdOf(r, holdId)));
    }).toThrow(HoldError);
  });

  it('reports a second settle as converged, and moves nothing', async () => {
    const r = rig();
    const holdId = await runUpTo(r, {
      grant: '100',
      reserve: '20.000000',
      charges: ['4.000000'],
    });

    const first = await r.db.transaction((tx) => r.credits.settle(tx, settleCommand(holdId)));
    const available = availableOf(r.db, ORG);

    const second = await r.db.transaction((tx) => r.credits.settle(tx, settleCommand(holdId)));

    expect(toSettlementClosure(first).outcome).toBe('settled');
    expect(toSettlementClosure(second).outcome).toBe('converged');
    expect(availableOf(r.db, ORG)).toBe(available);
    expect(r.published.filter((e) => e.eventType === 'CreditSettled')).toHaveLength(1);
  });

  it('reports a settle that met a release as diverged', async () => {
    const r = rig();
    const holdId = await runUpTo(r, {
      grant: '100',
      reserve: '20.000000',
      charges: ['4.000000'],
    });

    await r.db.transaction((tx) =>
      r.credits.release(tx, { ...settleCommand(holdId), cause: 'failed' }),
    );
    const late = await r.db.transaction((tx) => r.credits.settle(tx, settleCommand(holdId)));

    // The frozen service reports this only as `converged: true`. The credits
    // are right either way; what is wrong is that two deciders disagreed.
    expect(late.converged).toBe(true);
    expect(toSettlementClosure(late).outcome).toBe('diverged');
    expect(toSettlementClosure(late).settlement.status).toBe('released');
  });

  it('reports the release of a failed run as its own settlement', async () => {
    const r = rig();
    const holdId = await runUpTo(r, {
      grant: '100',
      reserve: '20.000000',
      charges: ['4.000000'],
    });

    const result = await r.db.transaction((tx) =>
      r.credits.release(tx, { ...settleCommand(holdId), cause: 'failed' }),
    );
    const settlement = toReservationSettlement(result.hold);

    expect(settlement.status).toBe('released');
    expect(settlement.consumed).toBe('4.000000');
    expect(settlement.released).toBe('16.000000');
  });
});

// ── Reporting across a billing period ───────────────────────────────────────

describe('many runs, one period', () => {
  it('adds up to what the ledger says was spent', async () => {
    const r = rig();
    r.db.seedGrant(ORG, '500');

    const settlements = [];
    for (const [index, charge] of ['4.000000', '11.500000', '0.000000'].entries()) {
      const authorized = await r.db.transaction((tx) =>
        r.credits.authorizeSpend(
          tx,
          authorize({ runId: `run-${String(index)}`, estimatedMax: '20.000000' }),
        ),
      );
      if (charge !== '0.000000') {
        await r.db.transaction((tx) =>
          r.credits.recordConsumption(tx, {
            organizationId: ORG,
            holdId: authorized.hold.id,
            amount: charge,
            idempotencyKey: `run-${String(index)}:step-0`,
            reason: 'a step',
            actor: { id: ACTOR, kind: 'service' },
            correlationId: CORRELATION,
          }),
        );
      }
      const result = await r.db.transaction((tx) =>
        r.credits.settle(tx, settleCommand(authorized.hold.id)),
      );
      settlements.push(toSettlementClosure(result).settlement);
    }

    const period = summarizeSettlements(settlements);
    const balance = calculateBalance({ organizationId: ORG, entries: entriesOf(r) });

    expect(period.reserved).toBe('60.000000');
    expect(period.consumed).toBe('15.500000');
    expect(period.released).toBe('44.500000');
    // The one figure that must reconcile: what the settlements say was spent is
    // what the ledger actually debited.
    expect(period.consumed).toBe(balance.debited);
    expect(availableOf(r.db, ORG)).toBe('484.500000');
  });

  it('computes the same total from the closed reservations directly', async () => {
    const r = rig();
    const holdId = await runUpTo(r, {
      grant: '100',
      reserve: '20.000000',
      charges: ['4.000000'],
    });
    await r.db.transaction((tx) => r.credits.settle(tx, settleCommand(holdId)));

    const fromHold = toReservationSettlement(holdOf(r, holdId));
    const fromFigures = computeSettlement({ reserved: '20.000000', consumed: '4.000000' });

    expect(fromHold.released).toBe(fromFigures.released);
    expect(summarizeSettlements([fromHold]).released).toBe(fromFigures.released);
  });
});
