/**
 * The Credits Service — hold → consume → settle.
 *
 * Exercised against `credits-db.fixture.ts`, which implements the mechanisms
 * the correctness argument rests on: the advisory lock, the `FOR UPDATE` row
 * lock, both unique constraints, the `consumed <= amount` CHECK, and guarded
 * state transitions. A fake that accepted everything would let this suite pass
 * while the service double-charged.
 *
 * Concurrency has its own file. RLS and privileges have their own gate, against
 * PostgreSQL 17 — a data structure cannot refuse a privilege.
 */
import { describe, expect, it } from 'vitest';

import type { DomainEvent, EventPublisher, Transaction } from '@contentos/contracts';
import type { AuditWriter, NewAuditRecord } from '@contentos/security';

import { availableOf, createCreditsDb, type CreditsDb } from './credits-db.fixture.js';
import {
  createCreditsService,
  type AuthorizeSpendCommand,
  type CreditsService,
} from './credits-service.js';
import { HoldError, InsufficientCreditsError } from './holds.js';
import { createCreditLedgerService } from './service.js';

const ORG = '018f7a1e-0000-7000-8000-0000000000aa';
const WS = '018f7a1e-0000-7000-8000-0000000000bb';
const WS2 = '018f7a1e-0000-7000-8000-0000000000cc';
const ACTOR = '018f7a1e-0000-7000-8000-000000000001';
const CORRELATION = '018f7a1e-0000-7000-8000-0000000000dd';
const NOW = new Date('2026-07-30T12:00:00.000Z');

interface Rig {
  readonly db: CreditsDb;
  readonly credits: CreditsService;
  readonly published: DomainEvent<unknown>[];
  readonly audits: NewAuditRecord[];
}

function rig(options: { lowBalanceThreshold?: string; now?: () => Date } = {}): Rig {
  const published: DomainEvent<unknown>[] = [];
  const audits: NewAuditRecord[] = [];
  const now = options.now ?? ((): Date => NOW);
  const db = createCreditsDb({ now });

  const publisher: EventPublisher = {
    publish<T>(_tx: Transaction, event: DomainEvent<T>): Promise<void> {
      published.push(event as DomainEvent<unknown>);
      return Promise.resolve();
    },
  };
  const audit: AuditWriter = {
    record(_tx: Transaction, entry: NewAuditRecord): Promise<string> {
      audits.push(entry);
      return Promise.resolve('audit-id');
    },
  };

  let eventSeq = 0;
  const newEventId = (): string =>
    `018f7a1e-0000-7000-9000-${String((eventSeq += 1)).padStart(12, '0')}`;

  const credits = createCreditsService({
    ledger: createCreditLedgerService({ publisher, audit, now, newEventId }),
    publisher,
    lowBalanceThreshold: options.lowBalanceThreshold ?? '10',
    now,
    newEventId,
  });

  return { db, credits, published, audits };
}

function authorize(over: Partial<AuthorizeSpendCommand> = {}): AuthorizeSpendCommand {
  return {
    organizationId: ORG,
    workspaceId: WS,
    runId: 'run-0001',
    estimatedMax: '20.000000',
    reason: 'Article pipeline.',
    actor: { id: ACTOR, kind: 'service' },
    correlationId: CORRELATION,
    ...over,
  };
}

const typesOf = (events: readonly DomainEvent<unknown>[]): string[] =>
  events.map((e) => e.eventType);

describe('authorizeSpend reserves before any provider call', () => {
  it('creates a hold and reports what is left', async () => {
    const r = rig();
    r.db.seedGrant(ORG, '100');

    const result = await r.db.transaction((tx) => r.credits.authorizeSpend(tx, authorize()));

    expect(result.created).toBe(true);
    expect(result.hold.state).toBe('held');
    expect(result.hold.amount).toBe('20.000000');
    expect(result.hold.consumed).toBe('0.000000');
    expect(result.available).toBe('80.000000');
  });

  it('publishes CreditHeld with the reservation and its expiry', async () => {
    const r = rig();
    r.db.seedGrant(ORG, '100');
    const result = await r.db.transaction((tx) => r.credits.authorizeSpend(tx, authorize()));

    expect(typesOf(r.published)).toEqual(['CreditHeld']);
    expect(r.published[0]?.payload).toMatchObject({
      holdId: result.hold.id,
      organizationId: ORG,
      workspaceId: WS,
      runId: 'run-0001',
      amount: '20.000000',
    });
  });

  it('takes the organization advisory lock FIRST', async () => {
    const r = rig();
    r.db.seedGrant(ORG, '100');
    await r.db.transaction((tx) => r.credits.authorizeSpend(tx, authorize()));
    expect(r.db.calls[0]).toBe('advisory-lock');
  });

  it('reserves the estimated maximum, not the eventual spend', async () => {
    const r = rig();
    r.db.seedGrant(ORG, '100');
    await r.db.transaction((tx) =>
      r.credits.authorizeSpend(tx, authorize({ estimatedMax: '75.500000' })),
    );
    expect(r.db.openHoldTotal(ORG)).toBe('75.500000');
    expect(availableOf(r.db, ORG)).toBe('24.500000');
  });

  it('sets the TTL from the configured window', async () => {
    const r = rig();
    r.db.seedGrant(ORG, '100');
    const result = await r.db.transaction((tx) =>
      r.credits.authorizeSpend(tx, authorize({ ttlMs: 60_000 })),
    );
    expect(result.hold.expiresAt).toBe('2026-07-30T12:01:00.000Z');
  });
});

describe('insufficient balance blocks the run before it starts', () => {
  it('refuses when the balance cannot cover the estimate', async () => {
    const r = rig();
    r.db.seedGrant(ORG, '5');

    await expect(
      r.db.transaction((tx) => r.credits.authorizeSpend(tx, authorize())),
    ).rejects.toThrow(InsufficientCreditsError);
  });

  it('reports what was available, required and short', async () => {
    const r = rig();
    r.db.seedGrant(ORG, '5');
    try {
      await r.db.transaction((tx) => r.credits.authorizeSpend(tx, authorize()));
      expect.unreachable('must refuse');
    } catch (error) {
      const e = error as InsufficientCreditsError;
      expect(e.code).toBe('InsufficientCredits');
      expect(e.available).toBe('5.000000');
      expect(e.required).toBe('20.000000');
      expect(e.shortfall).toBe('15.000000');
    }
  });

  it('writes no hold and publishes nothing', async () => {
    const r = rig();
    r.db.seedGrant(ORG, '5');
    await r.db
      .transaction((tx) => r.credits.authorizeSpend(tx, authorize()))
      .catch(() => undefined);

    expect(r.db.holds).toHaveLength(0);
    expect(r.published).toHaveLength(0);
  });

  // An existing hold reduces what a second run may draw on, even though nothing
  // has been charged yet. That is the reservation doing its job.
  it('counts an open hold against the next authorization', async () => {
    const r = rig();
    r.db.seedGrant(ORG, '30');
    await r.db.transaction((tx) => r.credits.authorizeSpend(tx, authorize()));

    await expect(
      r.db.transaction((tx) =>
        r.credits.authorizeSpend(tx, authorize({ runId: 'run-0002', estimatedMax: '20' })),
      ),
    ).rejects.toThrow(InsufficientCreditsError);
  });

  it('permits exactly the available amount', async () => {
    const r = rig();
    r.db.seedGrant(ORG, '20');
    const result = await r.db.transaction((tx) => r.credits.authorizeSpend(tx, authorize()));
    expect(result.created).toBe(true);
    expect(result.available).toBe('0.000000');
  });

  it('refuses one micro-credit past it', async () => {
    const r = rig();
    r.db.seedGrant(ORG, '19.999999');
    await expect(
      r.db.transaction((tx) => r.credits.authorizeSpend(tx, authorize())),
    ).rejects.toThrow(/0.000001 short/);
  });
});

describe('a retried authorization converges', () => {
  it('returns the hold it already made, without a second one', async () => {
    const r = rig();
    r.db.seedGrant(ORG, '100');

    const first = await r.db.transaction((tx) => r.credits.authorizeSpend(tx, authorize()));
    const second = await r.db.transaction((tx) => r.credits.authorizeSpend(tx, authorize()));

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.hold.id).toBe(first.hold.id);
    expect(r.db.holds).toHaveLength(1);
  });

  it('publishes no second CreditHeld', async () => {
    const r = rig();
    r.db.seedGrant(ORG, '100');
    await r.db.transaction((tx) => r.credits.authorizeSpend(tx, authorize()));
    await r.db.transaction((tx) => r.credits.authorizeSpend(tx, authorize()));
    expect(typesOf(r.published)).toEqual(['CreditHeld']);
  });

  // Reserving twice for one run is the double-spend the run id exists to stop.
  it('does not reserve twice even when the estimate changed', async () => {
    const r = rig();
    r.db.seedGrant(ORG, '100');
    await r.db.transaction((tx) => r.credits.authorizeSpend(tx, authorize()));
    await r.db.transaction((tx) => r.credits.authorizeSpend(tx, authorize({ estimatedMax: '90' })));
    expect(r.db.openHoldTotal(ORG)).toBe('20.000000');
  });

  it('converges on a hold that has already been settled', async () => {
    const r = rig();
    r.db.seedGrant(ORG, '100');
    const first = await r.db.transaction((tx) => r.credits.authorizeSpend(tx, authorize()));
    await r.db.transaction((tx) =>
      r.credits.settle(tx, {
        organizationId: ORG,
        holdId: first.hold.id,
        actor: { id: ACTOR, kind: 'service' },
        correlationId: CORRELATION,
      }),
    );

    const retry = await r.db.transaction((tx) => r.credits.authorizeSpend(tx, authorize()));
    expect(retry.created).toBe(false);
    expect(retry.hold.state).toBe('settled');
    expect(r.db.holds).toHaveLength(1);
  });
});

describe('recordConsumption converts a hold into immutable entries', () => {
  async function held(r: Rig, grant = '100', estimate = '20') {
    r.db.seedGrant(ORG, grant);
    const result = await r.db.transaction((tx) =>
      r.credits.authorizeSpend(tx, authorize({ estimatedMax: estimate })),
    );
    return result.hold;
  }

  const consume = (holdId: string, amount: string, key: string) => ({
    organizationId: ORG,
    holdId,
    amount,
    idempotencyKey: key,
    reason: 'AI call.',
    actor: { id: ACTOR, kind: 'service' as const },
    correlationId: CORRELATION,
  });

  it('appends a consumption entry attributed to the hold workspace', async () => {
    const r = rig();
    const hold = await held(r);

    const result = await r.db.transaction((tx) =>
      r.credits.recordConsumption(tx, consume(hold.id, '3.250000', 'run-0001:step-1')),
    );

    expect(result.created).toBe(true);
    expect(result.entry.entryType).toBe('consumption');
    expect(result.entry.direction).toBe('debit');
    expect(result.entry.workspaceId).toBe(WS);
    expect(result.entry.amount).toBe('3.250000');
  });

  it('records the hold and run on the entry so a charge is traceable', async () => {
    const r = rig();
    const hold = await held(r);
    const result = await r.db.transaction((tx) =>
      r.credits.recordConsumption(tx, consume(hold.id, '1', 'run-0001:step-1')),
    );
    expect(result.entry.metadata).toMatchObject({ holdId: hold.id, runId: 'run-0001' });
  });

  it('advances the hold consumption', async () => {
    const r = rig();
    const hold = await held(r);
    await r.db.transaction((tx) =>
      r.credits.recordConsumption(tx, consume(hold.id, '3', 'run-0001:step-1')),
    );
    const after = await r.db.transaction((tx) =>
      r.credits.recordConsumption(tx, consume(hold.id, '4', 'run-0001:step-2')),
    );
    expect(after.hold.consumed).toBe('7.000000');
  });

  it('reduces the balance by exactly what was charged', async () => {
    const r = rig();
    const hold = await held(r);
    await r.db.transaction((tx) =>
      r.credits.recordConsumption(tx, consume(hold.id, '3.500000', 'run-0001:step-1')),
    );
    expect(r.db.ledgerBalance(ORG)).toBe('96.500000');
  });

  // The reservation is the bound on worst-case spend. Past it, the run is
  // overspending its authorization.
  it('refuses a charge that would exceed the reservation', async () => {
    const r = rig();
    const hold = await held(r, '100', '10');
    await expect(
      r.db.transaction((tx) =>
        r.credits.recordConsumption(tx, consume(hold.id, '10.000001', 'run-0001:step-1')),
      ),
    ).rejects.toThrow(/exceed its reservation/);
  });

  it('permits a charge for exactly the reservation', async () => {
    const r = rig();
    const hold = await held(r, '100', '10');
    const result = await r.db.transaction((tx) =>
      r.credits.recordConsumption(tx, consume(hold.id, '10', 'run-0001:step-1')),
    );
    expect(result.hold.consumed).toBe('10.000000');
  });

  it('refuses a charge against a hold that does not exist', async () => {
    const r = rig();
    await expect(
      r.db.transaction((tx) =>
        r.credits.recordConsumption(tx, consume('018f7a1e-0000-7000-8000-00000000ffff', '1', 'k')),
      ),
    ).rejects.toThrow(HoldError);
  });

  it('refuses a charge against a closed hold', async () => {
    const r = rig();
    const hold = await held(r);
    await r.db.transaction((tx) =>
      r.credits.release(tx, {
        organizationId: ORG,
        holdId: hold.id,
        cause: 'cancelled',
        actor: { id: ACTOR, kind: 'service' },
        correlationId: CORRELATION,
      }),
    );

    await expect(
      r.db.transaction((tx) =>
        r.credits.recordConsumption(tx, consume(hold.id, '1', 'run-0001:step-1')),
      ),
    ).rejects.toThrow(/can only be recorded against an open hold/);
  });

  describe('a retried charge converges — exactly-once financial effect', () => {
    it('writes no second ledger entry', async () => {
      const r = rig();
      const hold = await held(r);
      const key = 'run-0001:step-1:call-1';

      const first = await r.db.transaction((tx) =>
        r.credits.recordConsumption(tx, consume(hold.id, '3', key)),
      );
      const retry = await r.db.transaction((tx) =>
        r.credits.recordConsumption(tx, consume(hold.id, '3', key)),
      );

      expect(first.created).toBe(true);
      expect(retry.created).toBe(false);
      expect(retry.entry.id).toBe(first.entry.id);
      expect(r.db.entries.filter((e) => e.entryType === 'consumption')).toHaveLength(1);
    });

    // The whole point: `consumed` advances from the ledger's answer, not the
    // request, so the hold and the ledger cannot disagree.
    it('does not advance the hold a second time', async () => {
      const r = rig();
      const hold = await held(r);
      const key = 'run-0001:step-1:call-1';

      await r.db.transaction((tx) => r.credits.recordConsumption(tx, consume(hold.id, '3', key)));
      const retry = await r.db.transaction((tx) =>
        r.credits.recordConsumption(tx, consume(hold.id, '3', key)),
      );

      expect(retry.hold.consumed).toBe('3.000000');
      expect(r.db.holds[0]?.consumed).toBe('3.000000');
    });

    it('leaves the balance unchanged', async () => {
      const r = rig();
      const hold = await held(r);
      const key = 'run-0001:step-1:call-1';
      await r.db.transaction((tx) => r.credits.recordConsumption(tx, consume(hold.id, '3', key)));
      const before = r.db.ledgerBalance(ORG);
      await r.db.transaction((tx) => r.credits.recordConsumption(tx, consume(hold.id, '3', key)));
      expect(r.db.ledgerBalance(ORG)).toBe(before);
    });

    it('publishes no second CreditConsumed', async () => {
      const r = rig();
      const hold = await held(r);
      const key = 'run-0001:step-1:call-1';
      await r.db.transaction((tx) => r.credits.recordConsumption(tx, consume(hold.id, '3', key)));
      const before = r.published.filter((e) => e.eventType === 'CreditConsumed').length;
      await r.db.transaction((tx) => r.credits.recordConsumption(tx, consume(hold.id, '3', key)));
      expect(r.published.filter((e) => e.eventType === 'CreditConsumed')).toHaveLength(before);
    });

    it('ten retries of one charge move the balance once', async () => {
      const r = rig();
      const hold = await held(r);
      const key = 'run-0001:step-1:call-1';
      for (let i = 0; i < 10; i += 1) {
        await r.db.transaction((tx) => r.credits.recordConsumption(tx, consume(hold.id, '2', key)));
      }
      expect(r.db.ledgerBalance(ORG)).toBe('98.000000');
      expect(r.db.holds[0]?.consumed).toBe('2.000000');
    });
  });
});

describe('settlement and release close the hold', () => {
  async function heldHold(r: Rig, estimate = '20') {
    r.db.seedGrant(ORG, '100');
    const result = await r.db.transaction((tx) =>
      r.credits.authorizeSpend(tx, authorize({ estimatedMax: estimate })),
    );
    return result.hold;
  }

  const close = (holdId: string) => ({
    organizationId: ORG,
    holdId,
    actor: { id: ACTOR, kind: 'service' as const },
    correlationId: CORRELATION,
  });

  it('settles a hold and reports what was consumed and released', async () => {
    const r = rig();
    const hold = await heldHold(r);
    await r.db.transaction((tx) =>
      r.credits.recordConsumption(tx, {
        organizationId: ORG,
        holdId: hold.id,
        amount: '7.500000',
        idempotencyKey: 'k1',
        reason: 'AI call.',
        actor: { id: ACTOR, kind: 'service' },
        correlationId: CORRELATION,
      }),
    );

    const result = await r.db.transaction((tx) => r.credits.settle(tx, close(hold.id)));

    expect(result.hold.state).toBe('settled');
    expect(result.converged).toBe(false);
    expect(result.event?.payload).toMatchObject({
      consumed: '7.500000',
      released: '12.500000',
    });
  });

  // The unused remainder was never deducted — leaving `held` frees it by
  // arithmetic, so there is no compensating write to get wrong.
  it('returns the unused remainder to available balance', async () => {
    const r = rig();
    const hold = await heldHold(r);
    await r.db.transaction((tx) =>
      r.credits.recordConsumption(tx, {
        organizationId: ORG,
        holdId: hold.id,
        amount: '5',
        idempotencyKey: 'k1',
        reason: 'AI call.',
        actor: { id: ACTOR, kind: 'service' },
        correlationId: CORRELATION,
      }),
    );
    // 100 granted, 5 spent, 15 still reserved. The 5 is a ledger debit, so
    // counting the whole 20 here would subtract it twice.
    expect(availableOf(r.db, ORG)).toBe('80.000000');

    await r.db.transaction((tx) => r.credits.settle(tx, close(hold.id)));
    expect(availableOf(r.db, ORG)).toBe('95.000000');
  });

  it('releases a failed run in full', async () => {
    const r = rig();
    const hold = await heldHold(r);

    const result = await r.db.transaction((tx) =>
      r.credits.release(tx, { ...close(hold.id), cause: 'failed' }),
    );

    expect(result.hold.state).toBe('released');
    expect(result.event?.payload).toMatchObject({ cause: 'failed', consumed: '0.000000' });
    expect(availableOf(r.db, ORG)).toBe('100.000000');
    expect(r.db.ledgerBalance(ORG)).toBe('100.000000');
  });

  // A run that failed midway keeps what it actually spent; only the reservation
  // is returned. The charge is in the ledger and there is no path to erase it.
  it('releasing after partial consumption keeps the charge', async () => {
    const r = rig();
    const hold = await heldHold(r);
    await r.db.transaction((tx) =>
      r.credits.recordConsumption(tx, {
        organizationId: ORG,
        holdId: hold.id,
        amount: '4',
        idempotencyKey: 'k1',
        reason: 'AI call.',
        actor: { id: ACTOR, kind: 'service' },
        correlationId: CORRELATION,
      }),
    );
    await r.db.transaction((tx) => r.credits.release(tx, { ...close(hold.id), cause: 'failed' }));

    expect(r.db.ledgerBalance(ORG)).toBe('96.000000');
    expect(availableOf(r.db, ORG)).toBe('96.000000');
  });

  it('a repeated settle converges rather than settling twice', async () => {
    const r = rig();
    const hold = await heldHold(r);
    await r.db.transaction((tx) => r.credits.settle(tx, close(hold.id)));
    const retry = await r.db.transaction((tx) => r.credits.settle(tx, close(hold.id)));

    expect(retry.converged).toBe(true);
    expect(retry.event).toBeNull();
    expect(r.published.filter((e) => e.eventType === 'CreditSettled')).toHaveLength(1);
  });

  it('a repeated release converges', async () => {
    const r = rig();
    const hold = await heldHold(r);
    await r.db.transaction((tx) => r.credits.release(tx, { ...close(hold.id), cause: 'failed' }));
    const retry = await r.db.transaction((tx) =>
      r.credits.release(tx, { ...close(hold.id), cause: 'failed' }),
    );
    expect(retry.converged).toBe(true);
    expect(r.published.filter((e) => e.eventType === 'CreditReleased')).toHaveLength(1);
  });

  // Overwriting a release with a settle would hide that two deciders disagreed.
  it('settling an already-released hold reports the state it actually reached', async () => {
    const r = rig();
    const hold = await heldHold(r);
    await r.db.transaction((tx) => r.credits.release(tx, { ...close(hold.id), cause: 'failed' }));

    const result = await r.db.transaction((tx) => r.credits.settle(tx, close(hold.id)));
    expect(result.converged).toBe(true);
    expect(result.hold.state).toBe('released');
  });

  it('refuses to close a hold that does not exist', async () => {
    const r = rig();
    await expect(
      r.db.transaction((tx) => r.credits.settle(tx, close('018f7a1e-0000-7000-8000-00000000ffff'))),
    ).rejects.toThrow(/does not exist/);
  });
});

describe('the TTL sweep reclaims stranded holds', () => {
  it('expires a hold past its TTL and publishes the release', async () => {
    let clock = NOW;
    const r = rig({ now: () => clock });
    r.db.seedGrant(ORG, '100');
    await r.db.transaction((tx) => r.credits.authorizeSpend(tx, authorize({ ttlMs: 1000 })));

    clock = new Date(NOW.getTime() + 2000);
    const result = await r.db.transaction((tx) => r.credits.expireStaleHolds(tx, ORG, CORRELATION));

    expect(result.released).toHaveLength(1);
    expect(result.released[0]?.state).toBe('expired');
    expect(r.published.filter((e) => e.eventType === 'CreditReleased')).toHaveLength(1);
    expect(r.published.at(-1)?.payload).toMatchObject({ cause: 'expired' });
  });

  it('returns the reservation to available balance', async () => {
    let clock = NOW;
    const r = rig({ now: () => clock });
    r.db.seedGrant(ORG, '100');
    await r.db.transaction((tx) => r.credits.authorizeSpend(tx, authorize({ ttlMs: 1000 })));
    expect(availableOf(r.db, ORG)).toBe('80.000000');

    clock = new Date(NOW.getTime() + 2000);
    await r.db.transaction((tx) => r.credits.expireStaleHolds(tx, ORG, CORRELATION));
    expect(availableOf(r.db, ORG)).toBe('100.000000');
  });

  it('leaves a hold inside its TTL alone', async () => {
    const r = rig();
    r.db.seedGrant(ORG, '100');
    await r.db.transaction((tx) => r.credits.authorizeSpend(tx, authorize()));
    const result = await r.db.transaction((tx) => r.credits.expireStaleHolds(tx, ORG, CORRELATION));
    expect(result.released).toHaveLength(0);
  });

  // A crashed orchestrator otherwise keeps an organization out of its own
  // credits until the sweep happens to run.
  it('sweeps on the way into the next authorization', async () => {
    let clock = NOW;
    const r = rig({ now: () => clock });
    r.db.seedGrant(ORG, '100');
    await r.db.transaction((tx) =>
      r.credits.authorizeSpend(tx, authorize({ estimatedMax: '90', ttlMs: 1000 })),
    );

    clock = new Date(NOW.getTime() + 2000);
    const second = await r.db.transaction((tx) =>
      r.credits.authorizeSpend(tx, authorize({ runId: 'run-0002', estimatedMax: '90' })),
    );

    expect(second.created).toBe(true);
    expect(second.expired).toHaveLength(1);
  });

  it('is idempotent — a second sweep expires nothing', async () => {
    let clock = NOW;
    const r = rig({ now: () => clock });
    r.db.seedGrant(ORG, '100');
    await r.db.transaction((tx) => r.credits.authorizeSpend(tx, authorize({ ttlMs: 1000 })));
    clock = new Date(NOW.getTime() + 2000);

    await r.db.transaction((tx) => r.credits.expireStaleHolds(tx, ORG, CORRELATION));
    const again = await r.db.transaction((tx) => r.credits.expireStaleHolds(tx, ORG, CORRELATION));
    expect(again.released).toHaveLength(0);
  });
});

describe('suspension releases outstanding holds', () => {
  async function twoWorkspaces(r: Rig) {
    r.db.seedGrant(ORG, '100');
    await r.db.transaction((tx) =>
      r.credits.authorizeSpend(
        tx,
        authorize({ runId: 'run-a', workspaceId: WS, estimatedMax: '10' }),
      ),
    );
    await r.db.transaction((tx) =>
      r.credits.authorizeSpend(
        tx,
        authorize({ runId: 'run-b', workspaceId: WS2, estimatedMax: '15' }),
      ),
    );
  }

  it('releases every open hold under a suspended organization', async () => {
    const r = rig();
    await twoWorkspaces(r);

    const result = await r.db.transaction((tx) =>
      r.credits.releaseOpenHolds(tx, {
        organizationId: ORG,
        cause: 'suspended',
        correlationId: CORRELATION,
      }),
    );

    expect(result.released).toHaveLength(2);
    expect(availableOf(r.db, ORG)).toBe('100.000000');
    expect(r.published.filter((e) => e.eventType === 'CreditReleased')).toHaveLength(2);
  });

  it('releases only that workspace when a workspace is suspended', async () => {
    const r = rig();
    await twoWorkspaces(r);

    const result = await r.db.transaction((tx) =>
      r.credits.releaseOpenHolds(tx, {
        organizationId: ORG,
        workspaceId: WS,
        cause: 'suspended',
        correlationId: CORRELATION,
      }),
    );

    expect(result.released).toHaveLength(1);
    expect(result.released[0]?.workspaceId).toBe(WS);
    // The rest of the organization is still running.
    expect(r.db.openHoldTotal(ORG)).toBe('15.000000');
  });

  it('is idempotent — a redelivery releases nothing', async () => {
    const r = rig();
    await twoWorkspaces(r);
    const command = {
      organizationId: ORG,
      cause: 'suspended' as const,
      correlationId: CORRELATION,
    };

    await r.db.transaction((tx) => r.credits.releaseOpenHolds(tx, command));
    const again = await r.db.transaction((tx) => r.credits.releaseOpenHolds(tx, command));

    expect(again.released).toHaveLength(0);
    expect(r.published.filter((e) => e.eventType === 'CreditReleased')).toHaveLength(2);
  });

  it('leaves settled holds untouched', async () => {
    const r = rig();
    await twoWorkspaces(r);
    const first = r.db.holds[0];
    expect(first).toBeDefined();
    if (first === undefined) return;

    await r.db.transaction((tx) =>
      r.credits.settle(tx, {
        organizationId: ORG,
        holdId: first.id,
        actor: { id: ACTOR, kind: 'service' },
        correlationId: CORRELATION,
      }),
    );
    const result = await r.db.transaction((tx) =>
      r.credits.releaseOpenHolds(tx, {
        organizationId: ORG,
        cause: 'suspended',
        correlationId: CORRELATION,
      }),
    );

    expect(result.released).toHaveLength(1);
    expect(r.db.holds[0]?.state).toBe('settled');
  });
});

describe('lookup', () => {
  it('finds a hold by run id and by hold id', async () => {
    const r = rig();
    r.db.seedGrant(ORG, '100');
    const created = await r.db.transaction((tx) => r.credits.authorizeSpend(tx, authorize()));

    const byRun = await r.db.transaction((tx) => r.credits.findHoldByRun(tx, ORG, 'run-0001'));
    const byId = await r.db.transaction((tx) => r.credits.findHold(tx, ORG, created.hold.id));

    expect(byRun?.id).toBe(created.hold.id);
    expect(byId?.id).toBe(created.hold.id);
  });

  it('returns null for a run nothing holds', async () => {
    const r = rig();
    expect(await r.db.transaction((tx) => r.credits.findHoldByRun(tx, ORG, 'nope'))).toBeNull();
  });
});
