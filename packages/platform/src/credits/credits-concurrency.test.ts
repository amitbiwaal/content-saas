/**
 * Concurrency — the Sprint Gate's central claim.
 *
 * Every test here runs the real service against `credits-db.fixture.ts`, whose
 * advisory lock and `FOR UPDATE` row lock are real FIFO queues. `Promise.all`
 * interleaves the calls at every await point, which is exactly the interleaving
 * the locks exist to prevent.
 *
 * ── The suite proves the race is real before proving it is prevented ────────
 * The first test disables the advisory lock and shows the double-reservation
 * happening. Without that, "no double-charge" could be passing because the
 * interleaving never occurred, and the guard would be untested.
 *
 * Real parallelism across backend connections is asserted separately, at CI
 * step 5c, against PostgreSQL 17. Interleaving promises is not the same as
 * interleaving processes, and neither substitutes for the other.
 */
import { describe, expect, it } from 'vitest';

import type { DomainEvent, EventPublisher, Transaction } from '@contentos/contracts';
import type { AuditWriter, NewAuditRecord } from '@contentos/security';

import { compareAmounts, parseAmount, parseSigned } from './amount.js';
import { availableOf, createCreditsDb, type CreditsDb } from './credits-db.fixture.js';
import { createCreditsService, type CreditsService } from './credits-service.js';
import { InsufficientCreditsError } from './holds.js';
import { createCreditLedgerService } from './service.js';

const ORG = '018f7a1e-0000-7000-8000-0000000000aa';
const OTHER_ORG = '018f7a1e-0000-7000-8000-0000000000a9';
const WS = '018f7a1e-0000-7000-8000-0000000000bb';
const ACTOR = '018f7a1e-0000-7000-8000-000000000001';
const CORRELATION = '018f7a1e-0000-7000-8000-0000000000dd';
const NOW = new Date('2026-07-30T12:00:00.000Z');

interface Rig {
  readonly db: CreditsDb;
  readonly credits: CreditsService;
  readonly published: DomainEvent<unknown>[];
}

function rig(options: { disableAdvisoryLock?: boolean } = {}): Rig {
  const published: DomainEvent<unknown>[] = [];
  const now = (): Date => NOW;
  const db = createCreditsDb({
    now,
    ...(options.disableAdvisoryLock === undefined
      ? {}
      : { disableAdvisoryLock: options.disableAdvisoryLock }),
  });

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

  return {
    db,
    published,
    credits: createCreditsService({
      ledger: createCreditLedgerService({ publisher, audit, now, newEventId }),
      publisher,
      lowBalanceThreshold: '10',
      now,
      newEventId,
    }),
  };
}

const settled = async <T>(work: Promise<T>[]): Promise<PromiseSettledResult<T>[]> =>
  Promise.allSettled(work);

const fulfilled = <T>(results: PromiseSettledResult<T>[]): T[] =>
  results
    .filter((r): r is PromiseFulfilledResult<T> => r.status === 'fulfilled')
    .map((r) => r.value);

const rejectedWith = (results: PromiseSettledResult<unknown>[], type: unknown): number =>
  results.filter((r) => r.status === 'rejected' && r.reason instanceof (type as never)).length;

function authorizeN(r: Rig, count: number, estimate: string) {
  return Array.from({ length: count }, (_, i) =>
    r.db.transaction((tx) =>
      r.credits.authorizeSpend(tx, {
        organizationId: ORG,
        workspaceId: WS,
        runId: `run-${String(i).padStart(4, '0')}`,
        estimatedMax: estimate,
        reason: 'Parallel run start.',
        actor: { id: ACTOR, kind: 'service' },
        correlationId: CORRELATION,
      }),
    ),
  );
}

describe('the race is real — the guard is what prevents it', () => {
  // Not an assertion about desired behaviour: a demonstration that the
  // interleaving this suite relies on actually happens. If this ever stops
  // over-reserving, every test below has stopped testing anything.
  it('WITHOUT the advisory lock, parallel authorizations over-reserve', async () => {
    const r = rig({ disableAdvisoryLock: true });
    r.db.seedGrant(ORG, '100');

    const results = await settled(authorizeN(r, 10, '20'));
    const created = fulfilled(results).filter((x) => x.created).length;

    // Ten runs each reserving 20 against a balance of 100: at most five may
    // succeed. Without serialisation they all read the same balance first.
    expect(created).toBeGreaterThan(5);
    expect(parseSigned(availableOf(r.db, ORG)) < 0n).toBe(true);
  });
});

describe('parallel authorization cannot over-reserve', () => {
  it('admits exactly as many runs as the balance covers', async () => {
    const r = rig();
    r.db.seedGrant(ORG, '100');

    const results = await settled(authorizeN(r, 10, '20'));

    expect(fulfilled(results).filter((x) => x.created)).toHaveLength(5);
    expect(rejectedWith(results, InsufficientCreditsError)).toBe(5);
  });

  it('never lets available balance go negative', async () => {
    const r = rig();
    r.db.seedGrant(ORG, '100');
    await settled(authorizeN(r, 20, '20'));

    expect(availableOf(r.db, ORG)).toBe('0.000000');
    expect(r.db.openHoldTotal(ORG)).toBe('100.000000');
  });

  it('holds the invariant with an amount that does not divide evenly', async () => {
    const r = rig();
    r.db.seedGrant(ORG, '100');
    await settled(authorizeN(r, 20, '30'));

    // Three fit; the fourth would leave −20.
    expect(r.db.openHoldTotal(ORG)).toBe('90.000000');
    expect(compareAmounts(parseAmount(r.db.openHoldTotal(ORG)), parseAmount('100')) <= 0).toBe(
      true,
    );
  });

  it('holds it at micro-credit resolution', async () => {
    const r = rig();
    r.db.seedGrant(ORG, '0.000010');
    await settled(authorizeN(r, 20, '0.000001'));

    expect(r.db.openHoldTotal(ORG)).toBe('0.000010');
    expect(availableOf(r.db, ORG)).toBe('0.000000');
  });

  it('publishes exactly one CreditHeld per hold actually created', async () => {
    const r = rig();
    r.db.seedGrant(ORG, '100');
    await settled(authorizeN(r, 10, '20'));

    expect(r.published.filter((e) => e.eventType === 'CreditHeld')).toHaveLength(5);
    expect(r.db.holds).toHaveLength(5);
  });

  // The lock is per organization. Serialising the whole platform on one lock
  // would make every run start wait behind every other customer's.
  it('does not serialise across organizations', async () => {
    const r = rig();
    r.db.seedGrant(ORG, '100');
    r.db.seedGrant(OTHER_ORG, '100');

    const both = await settled([
      ...authorizeN(r, 5, '20'),
      ...Array.from({ length: 5 }, (_, i) =>
        r.db.transaction((tx) =>
          r.credits.authorizeSpend(tx, {
            organizationId: OTHER_ORG,
            workspaceId: WS,
            runId: `other-${String(i)}`,
            estimatedMax: '20',
            reason: 'Parallel run start.',
            actor: { id: ACTOR, kind: 'service' },
            correlationId: CORRELATION,
          }),
        ),
      ),
    ]);

    expect(fulfilled(both).filter((x) => x.created)).toHaveLength(10);
    expect(r.db.openHoldTotal(ORG)).toBe('100.000000');
    expect(r.db.openHoldTotal(OTHER_ORG)).toBe('100.000000');
  });
});

describe('parallel authorization of ONE run reserves once', () => {
  it('creates a single hold from ten concurrent attempts', async () => {
    const r = rig();
    r.db.seedGrant(ORG, '100');

    const results = await settled(
      Array.from({ length: 10 }, () =>
        r.db.transaction((tx) =>
          r.credits.authorizeSpend(tx, {
            organizationId: ORG,
            workspaceId: WS,
            runId: 'run-retried',
            estimatedMax: '20',
            reason: 'Temporal retry storm.',
            actor: { id: ACTOR, kind: 'service' },
            correlationId: CORRELATION,
          }),
        ),
      ),
    );

    const values = fulfilled(results);
    expect(values).toHaveLength(10);
    expect(values.filter((v) => v.created)).toHaveLength(1);
    expect(r.db.holds).toHaveLength(1);
    expect(new Set(values.map((v) => v.hold.id)).size).toBe(1);
  });

  it('reserves the amount once, not ten times', async () => {
    const r = rig();
    r.db.seedGrant(ORG, '100');
    await settled(
      Array.from({ length: 10 }, () =>
        r.db.transaction((tx) =>
          r.credits.authorizeSpend(tx, {
            organizationId: ORG,
            workspaceId: WS,
            runId: 'run-retried',
            estimatedMax: '20',
            reason: 'Temporal retry storm.',
            actor: { id: ACTOR, kind: 'service' },
            correlationId: CORRELATION,
          }),
        ),
      ),
    );
    expect(r.db.openHoldTotal(ORG)).toBe('20.000000');
    expect(r.published.filter((e) => e.eventType === 'CreditHeld')).toHaveLength(1);
  });
});

describe('parallel consumption cannot double-charge', () => {
  async function openHold(r: Rig, grant = '100', estimate = '50') {
    r.db.seedGrant(ORG, grant);
    const result = await r.db.transaction((tx) =>
      r.credits.authorizeSpend(tx, {
        organizationId: ORG,
        workspaceId: WS,
        runId: 'run-0001',
        estimatedMax: estimate,
        reason: 'Article pipeline.',
        actor: { id: ACTOR, kind: 'service' },
        correlationId: CORRELATION,
      }),
    );
    return result.hold.id;
  }

  const charge = (r: Rig, holdId: string, amount: string, key: string) =>
    r.db.transaction((tx) =>
      r.credits.recordConsumption(tx, {
        organizationId: ORG,
        holdId,
        amount,
        idempotencyKey: key,
        reason: 'AI call.',
        actor: { id: ACTOR, kind: 'service' },
        correlationId: CORRELATION,
      }),
    );

  // The single most important assertion in this increment.
  it('records ONE entry from twenty concurrent retries of one charge', async () => {
    const r = rig();
    const holdId = await openHold(r);

    const results = await settled(
      Array.from({ length: 20 }, () => charge(r, holdId, '5', 'run-0001:step-1:call-1')),
    );

    const values = fulfilled(results);
    expect(values).toHaveLength(20);
    expect(values.filter((v) => v.created)).toHaveLength(1);
    expect(r.db.entries.filter((e) => e.entryType === 'consumption')).toHaveLength(1);
  });

  it('moves the balance exactly once', async () => {
    const r = rig();
    const holdId = await openHold(r);
    await settled(Array.from({ length: 20 }, () => charge(r, holdId, '5', 'one-key')));

    expect(r.db.ledgerBalance(ORG)).toBe('95.000000');
    expect(r.db.holds[0]?.consumed).toBe('5.000000');
  });

  it('publishes one CreditConsumed', async () => {
    const r = rig();
    const holdId = await openHold(r);
    await settled(Array.from({ length: 20 }, () => charge(r, holdId, '5', 'one-key')));
    expect(r.published.filter((e) => e.eventType === 'CreditConsumed')).toHaveLength(1);
  });

  it('all twenty callers see the same entry id', async () => {
    const r = rig();
    const holdId = await openHold(r);
    const results = await settled(
      Array.from({ length: 20 }, () => charge(r, holdId, '5', 'one-key')),
    );
    expect(new Set(fulfilled(results).map((v) => v.entry.id)).size).toBe(1);
  });

  // Different keys are different charges, and the reservation bounds them.
  it('never lets distinct concurrent charges exceed the reservation', async () => {
    const r = rig();
    const holdId = await openHold(r, '1000', '50');

    await settled(
      Array.from({ length: 20 }, (_, i) => charge(r, holdId, '10', `call-${String(i)}`)),
    );

    const hold = r.db.holds[0];
    expect(hold).toBeDefined();
    if (hold === undefined) return;
    expect(compareAmounts(parseAmount(hold.consumed), parseAmount(hold.amount)) <= 0).toBe(true);
    expect(hold.consumed).toBe('50.000000');
  });

  it('the ledger and the hold agree after the storm', async () => {
    const r = rig();
    const holdId = await openHold(r, '1000', '50');
    await settled(
      Array.from({ length: 20 }, (_, i) => charge(r, holdId, '10', `call-${String(i)}`)),
    );

    const charged = r.db.entries
      .filter((e) => e.entryType === 'consumption')
      .reduce((total, e) => total + parseAmount(e.amount), 0n);
    expect(charged).toBe(parseAmount(r.db.holds[0]?.consumed ?? '0'));
  });
});

describe('parallel closure resolves to one outcome', () => {
  async function openHold(r: Rig) {
    r.db.seedGrant(ORG, '100');
    const result = await r.db.transaction((tx) =>
      r.credits.authorizeSpend(tx, {
        organizationId: ORG,
        workspaceId: WS,
        runId: 'run-0001',
        estimatedMax: '20',
        reason: 'Article pipeline.',
        actor: { id: ACTOR, kind: 'service' },
        correlationId: CORRELATION,
      }),
    );
    return result.hold.id;
  }

  const close = (holdId: string) => ({
    organizationId: ORG,
    holdId,
    actor: { id: ACTOR, kind: 'service' as const },
    correlationId: CORRELATION,
  });

  it('ten concurrent settles produce one settlement', async () => {
    const r = rig();
    const holdId = await openHold(r);

    const results = await settled(
      Array.from({ length: 10 }, () =>
        r.db.transaction((tx) => r.credits.settle(tx, close(holdId))),
      ),
    );

    expect(fulfilled(results).filter((v) => !v.converged)).toHaveLength(1);
    expect(r.published.filter((e) => e.eventType === 'CreditSettled')).toHaveLength(1);
  });

  // A settle and a release racing must not both take effect: the hold would be
  // reported as settled to one caller and released to the other.
  it('a settle racing a release leaves exactly one terminal state', async () => {
    const r = rig();
    const holdId = await openHold(r);

    await settled([
      r.db.transaction((tx) => r.credits.settle(tx, close(holdId))),
      r.db.transaction((tx) => r.credits.release(tx, { ...close(holdId), cause: 'failed' })),
    ]);

    const terminal = r.published.filter(
      (e) => e.eventType === 'CreditSettled' || e.eventType === 'CreditReleased',
    );
    expect(terminal).toHaveLength(1);
    expect(['settled', 'released']).toContain(r.db.holds[0]?.state);
  });

  it('a suspension racing a settle releases at most the holds still open', async () => {
    const r = rig();
    const holdId = await openHold(r);

    const results = await settled([
      r.db.transaction((tx) => r.credits.settle(tx, close(holdId))),
      r.db.transaction((tx) =>
        r.credits.releaseOpenHolds(tx, {
          organizationId: ORG,
          cause: 'suspended',
          correlationId: CORRELATION,
        }),
      ),
    ]);

    expect(results.every((x) => x.status === 'fulfilled')).toBe(true);
    const closures = r.published.filter(
      (e) => e.eventType === 'CreditSettled' || e.eventType === 'CreditReleased',
    );
    expect(closures).toHaveLength(1);
  });
});

describe('the projection reconciles with the ledger after concurrent load', () => {
  it('balance equals credited minus debited, exactly', async () => {
    const r = rig();
    r.db.seedGrant(ORG, '1000');
    const hold = await r.db.transaction((tx) =>
      r.credits.authorizeSpend(tx, {
        organizationId: ORG,
        workspaceId: WS,
        runId: 'run-0001',
        estimatedMax: '100',
        reason: 'Article pipeline.',
        actor: { id: ACTOR, kind: 'service' },
        correlationId: CORRELATION,
      }),
    );

    await settled(
      Array.from({ length: 25 }, (_, i) =>
        r.db.transaction((tx) =>
          r.credits.recordConsumption(tx, {
            organizationId: ORG,
            holdId: hold.hold.id,
            amount: '4',
            idempotencyKey: `call-${String(i)}`,
            reason: 'AI call.',
            actor: { id: ACTOR, kind: 'service' },
            correlationId: CORRELATION,
          }),
        ),
      ),
    );

    const reading = await r.db.transaction((tx) => r.credits.balanceOf(tx, ORG));
    expect(reading.balance).toBe(r.db.ledgerBalance(ORG));
    expect(reading.balance).toBe('900.000000');
  });
});
