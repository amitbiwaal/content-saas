/**
 * The balance read model.
 *
 * Two properties carry this file: a read is correct whatever state the
 * projection is in, and a threshold event fires on the TRANSITION rather than
 * on every consumption past it.
 */
import { describe, expect, it } from 'vitest';

import type { DomainEvent, EventPublisher, Transaction } from '@contentos/contracts';
import type { AuditWriter, NewAuditRecord } from '@contentos/security';

import { parseAmount, ZERO } from './amount.js';
import {
  classifyThreshold,
  isThresholdState,
  projectBalance,
  readBalance,
  reconcile,
} from './balance.js';
import { createCreditsDb, type CreditsDb } from './credits-db.fixture.js';
import { createCreditsService, type CreditsService } from './credits-service.js';
import { createCreditLedgerService } from './service.js';

const ORG = '018f7a1e-0000-7000-8000-0000000000aa';
const WS = '018f7a1e-0000-7000-8000-0000000000bb';
const ACTOR = '018f7a1e-0000-7000-8000-000000000001';
const CORRELATION = '018f7a1e-0000-7000-8000-0000000000dd';
const NOW = new Date('2026-07-30T12:00:00.000Z');
const LOW = parseAmount('10');

interface Rig {
  readonly db: CreditsDb;
  readonly credits: CreditsService;
  readonly published: DomainEvent<unknown>[];
}

function rig(lowBalanceThreshold = '10'): Rig {
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
    record(_tx: Transaction, _e: NewAuditRecord): Promise<string> {
      return Promise.resolve('a');
    },
  };
  let seq = 0;
  const newEventId = (): string =>
    `018f7a1e-0000-7000-9000-${String((seq += 1)).padStart(12, '0')}`;

  return {
    db,
    published,
    credits: createCreditsService({
      ledger: createCreditLedgerService({ publisher, audit, now, newEventId }),
      publisher,
      lowBalanceThreshold,
      now,
      newEventId,
    }),
  };
}

describe('threshold classification', () => {
  it('reports exhausted at or below zero', () => {
    expect(classifyThreshold(ZERO, LOW)).toBe('exhausted');
    expect(classifyThreshold(parseAmount('0'), LOW)).toBe('exhausted');
  });

  // Reporting `low` below zero would understate the situation.
  it('reports exhausted, not low, for a negative balance', () => {
    expect(classifyThreshold(-1000000n as never, LOW)).toBe('exhausted');
  });

  it('reports low at the threshold and below', () => {
    expect(classifyThreshold(parseAmount('10'), LOW)).toBe('low');
    expect(classifyThreshold(parseAmount('0.000001'), LOW)).toBe('low');
  });

  it('reports ok one micro-credit above it', () => {
    expect(classifyThreshold(parseAmount('10.000001'), LOW)).toBe('ok');
  });

  it('narrows only the three states', () => {
    for (const state of ['ok', 'low', 'exhausted']) expect(isThresholdState(state)).toBe(true);
    for (const state of ['OK', 'empty', '']) expect(isThresholdState(state)).toBe(false);
  });
});

describe('projection', () => {
  it('records the sums and the watermark', async () => {
    const r = rig();
    r.db.seedGrant(ORG, '100', '2026-07-30T11:00:00.000Z');

    const result = await r.db.transaction((tx) => projectBalance(tx, ORG, LOW));

    expect(result.balance).toBe('100.000000');
    expect(result.entriesProjected).toBe(1);
    expect(r.db.balances.get(ORG)?.throughAt).toBe('2026-07-30T11:00:00.000Z');
  });

  // Re-aggregation rather than deltas: a delta applied twice or lost puts the
  // projection permanently out of step with the ledger.
  it('is idempotent — running it five times gives one answer', async () => {
    const r = rig();
    r.db.seedGrant(ORG, '100');
    for (let i = 0; i < 5; i += 1) {
      await r.db.transaction((tx) => projectBalance(tx, ORG, LOW));
    }
    expect(r.db.balances.get(ORG)?.credited).toBe('100.000000');
    expect(r.db.balances.get(ORG)?.entriesProjected).toBe(1);
  });

  it('projects zero for an organization with no history', async () => {
    const r = rig();
    const result = await r.db.transaction((tx) => projectBalance(tx, ORG, LOW));
    expect(result.balance).toBe('0.000000');
    expect(result.entriesProjected).toBe(0);
  });

  it('reconciles with the ledger', async () => {
    const r = rig();
    r.db.seedGrant(ORG, '100');
    await r.db.transaction((tx) => projectBalance(tx, ORG, LOW));

    const result = await r.db.transaction((tx) => reconcile(tx, ORG));
    expect(result.matches).toBe(true);
    expect(result.projected).toBe('100.000000');
    expect(result.ledger).toBe('100.000000');
  });

  // What the daily job pages on.
  it('reports a discrepancy when the projection is behind', async () => {
    const r = rig();
    r.db.seedGrant(ORG, '100');
    await r.db.transaction((tx) => projectBalance(tx, ORG, LOW));
    r.db.seedGrant(ORG, '50', '2026-07-30T13:00:00.000Z');

    const result = await r.db.transaction((tx) => reconcile(tx, ORG));
    expect(result.matches).toBe(false);
    expect(result.projected).toBe('100.000000');
    expect(result.ledger).toBe('150.000000');
  });
});

describe('a read is correct whatever the projection is doing', () => {
  it('uses the projection when it is current', async () => {
    const r = rig();
    r.db.seedGrant(ORG, '100');
    await r.db.transaction((tx) => projectBalance(tx, ORG, LOW));

    const reading = await r.db.transaction((tx) => readBalance(tx, ORG));
    expect(reading.source).toBe('projection');
    expect(reading.projectionStale).toBe(false);
    expect(reading.balance).toBe('100.000000');
  });

  // The fallback. Slower, and always right.
  it('falls back to the ledger when an entry has landed since', async () => {
    const r = rig();
    r.db.seedGrant(ORG, '100');
    await r.db.transaction((tx) => projectBalance(tx, ORG, LOW));
    r.db.seedGrant(ORG, '50', '2026-07-30T13:00:00.000Z');

    const reading = await r.db.transaction((tx) => readBalance(tx, ORG));
    expect(reading.source).toBe('ledger');
    expect(reading.projectionStale).toBe(true);
    // The point: the figure is right even though the cache is wrong.
    expect(reading.balance).toBe('150.000000');
  });

  it('falls back when there is no projection at all', async () => {
    const r = rig();
    r.db.seedGrant(ORG, '100');
    const reading = await r.db.transaction((tx) => readBalance(tx, ORG));
    expect(reading.source).toBe('ledger');
    expect(reading.balance).toBe('100.000000');
  });

  it('reports zero, from the projection, for a brand-new organization', async () => {
    const r = rig();
    await r.db.transaction((tx) => projectBalance(tx, ORG, LOW));
    const reading = await r.db.transaction((tx) => readBalance(tx, ORG));
    expect(reading.balance).toBe('0.000000');
    expect(reading.projectionStale).toBe(false);
  });

  it('subtracts open holds from available but not from balance', async () => {
    const r = rig();
    r.db.seedGrant(ORG, '100');
    await r.db.transaction((tx) =>
      r.credits.authorizeSpend(tx, {
        organizationId: ORG,
        workspaceId: WS,
        runId: 'run-1',
        estimatedMax: '30',
        reason: 'Pipeline.',
        actor: { id: ACTOR, kind: 'service' },
        correlationId: CORRELATION,
      }),
    );

    const reading = await r.db.transaction((tx) => readBalance(tx, ORG));
    expect(reading.balance).toBe('100.000000');
    expect(reading.held).toBe('30.000000');
    expect(reading.available).toBe('70.000000');
  });

  it('stops counting a hold once it closes', async () => {
    const r = rig();
    r.db.seedGrant(ORG, '100');
    const created = await r.db.transaction((tx) =>
      r.credits.authorizeSpend(tx, {
        organizationId: ORG,
        workspaceId: WS,
        runId: 'run-1',
        estimatedMax: '30',
        reason: 'Pipeline.',
        actor: { id: ACTOR, kind: 'service' },
        correlationId: CORRELATION,
      }),
    );
    await r.db.transaction((tx) =>
      r.credits.release(tx, {
        organizationId: ORG,
        holdId: created.hold.id,
        cause: 'failed',
        actor: { id: ACTOR, kind: 'service' },
        correlationId: CORRELATION,
      }),
    );

    const reading = await r.db.transaction((tx) => readBalance(tx, ORG));
    expect(reading.held).toBe('0.000000');
    expect(reading.available).toBe('100.000000');
  });

  // Never authorize from a known-stale model.
  it('authorizes correctly against a stale projection', async () => {
    const r = rig();
    r.db.seedGrant(ORG, '5');
    await r.db.transaction((tx) => projectBalance(tx, ORG, LOW));
    // A grant the projection has not seen.
    r.db.seedGrant(ORG, '95', '2026-07-30T13:00:00.000Z');

    const result = await r.db.transaction((tx) =>
      r.credits.authorizeSpend(tx, {
        organizationId: ORG,
        workspaceId: WS,
        runId: 'run-1',
        estimatedMax: '50',
        reason: 'Pipeline.',
        actor: { id: ACTOR, kind: 'service' },
        correlationId: CORRELATION,
      }),
    );
    // A stale read would have refused this at 5 available.
    expect(result.created).toBe(true);
  });
});

describe('threshold events fire on the transition only', () => {
  async function spend(r: Rig, holdId: string, amount: string, key: string) {
    return r.db.transaction((tx) =>
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
  }

  async function withHold(r: Rig, grant: string, estimate: string) {
    r.db.seedGrant(ORG, grant);
    const result = await r.db.transaction((tx) =>
      r.credits.authorizeSpend(tx, {
        organizationId: ORG,
        workspaceId: WS,
        runId: 'run-1',
        estimatedMax: estimate,
        reason: 'Pipeline.',
        actor: { id: ACTOR, kind: 'service' },
        correlationId: CORRELATION,
      }),
    );
    return result.hold.id;
  }

  const thresholdEvents = (r: Rig): string[] =>
    r.published
      .filter((e) => e.eventType === 'CreditsLow' || e.eventType === 'CreditsExhausted')
      .map((e) => e.eventType);

  it('publishes nothing while the balance stays above the threshold', async () => {
    const r = rig('10');
    const holdId = await withHold(r, '100', '50');
    await spend(r, holdId, '10', 'k1');
    expect(thresholdEvents(r)).toEqual([]);
  });

  it('publishes CreditsLow when the balance crosses down', async () => {
    const r = rig('10');
    const holdId = await withHold(r, '100', '95');
    await spend(r, holdId, '95', 'k1');

    expect(thresholdEvents(r)).toEqual(['CreditsLow']);
    expect(r.published.at(-1)?.payload).toMatchObject({
      organizationId: ORG,
      balance: '5.000000',
      threshold: '10.000000',
      previousState: 'ok',
    });
  });

  // A balance that sits below the threshold for a week is one event, not one
  // per consumption.
  it('does NOT republish while it stays low', async () => {
    const r = rig('10');
    const holdId = await withHold(r, '100', '99');
    await spend(r, holdId, '95', 'k1');
    await spend(r, holdId, '1', 'k2');
    await spend(r, holdId, '1', 'k3');

    expect(thresholdEvents(r)).toEqual(['CreditsLow']);
  });

  it('publishes CreditsExhausted on the way to zero', async () => {
    const r = rig('10');
    const holdId = await withHold(r, '100', '100');
    await spend(r, holdId, '95', 'k1');
    await spend(r, holdId, '5', 'k2');

    expect(thresholdEvents(r)).toEqual(['CreditsLow', 'CreditsExhausted']);
    expect(r.published.at(-1)?.payload).toMatchObject({
      balance: '0.000000',
      previousState: 'low',
    });
  });

  it('goes straight to exhausted when one charge clears the balance', async () => {
    const r = rig('10');
    const holdId = await withHold(r, '100', '100');
    await spend(r, holdId, '100', 'k1');
    expect(thresholdEvents(r)).toEqual(['CreditsExhausted']);
    expect(r.published.at(-1)?.payload).toMatchObject({ previousState: 'ok' });
  });

  it('does not republish exhausted', async () => {
    const r = rig('10');
    const holdId = await withHold(r, '100', '100');
    await spend(r, holdId, '100', 'k1');
    // Nothing left to spend, but a grant arriving and being spent again would.
    await r.db.transaction((tx) => projectBalance(tx, ORG, LOW));
    expect(thresholdEvents(r)).toEqual(['CreditsExhausted']);
  });

  // Recovery is recorded but not announced: there is no CreditsRecovered in the
  // contract, and inventing one would put an undeclared type on the bus.
  it('resets silently on recovery, and re-announces on the next dip', async () => {
    const r = rig('10');
    const holdId = await withHold(r, '100', '95');
    await spend(r, holdId, '95', 'k1');
    expect(thresholdEvents(r)).toEqual(['CreditsLow']);

    // Settle first: an open hold still reserves whatever it has not spent.
    await r.db.transaction((tx) =>
      r.credits.settle(tx, {
        organizationId: ORG,
        holdId,
        actor: { id: ACTOR, kind: 'service' },
        correlationId: CORRELATION,
      }),
    );
    r.db.seedGrant(ORG, '100', '2026-07-30T13:00:00.000Z');
    await r.db.transaction((tx) => projectBalance(tx, ORG, LOW));
    expect(r.db.balances.get(ORG)?.thresholdState).toBe('ok');
    expect(thresholdEvents(r)).toEqual(['CreditsLow']);

    const second = await r.db.transaction((tx) =>
      r.credits.authorizeSpend(tx, {
        organizationId: ORG,
        workspaceId: WS,
        runId: 'run-2',
        estimatedMax: '100',
        reason: 'Pipeline.',
        actor: { id: ACTOR, kind: 'service' },
        correlationId: CORRELATION,
      }),
    );
    await spend(r, second.hold.id, '99', 'k2');
    expect(thresholdEvents(r)).toEqual(['CreditsLow', 'CreditsLow']);
  });

  it('honours a configured threshold other than the default', async () => {
    const r = rig('50');
    const holdId = await withHold(r, '100', '60');
    await spend(r, holdId, '55', 'k1');
    expect(thresholdEvents(r)).toEqual(['CreditsLow']);
    expect(r.published.at(-1)?.payload).toMatchObject({ threshold: '50.000000' });
  });

  // A retried charge changed nothing, so there is nothing to announce.
  it('publishes no threshold event for a converged retry', async () => {
    const r = rig('10');
    const holdId = await withHold(r, '100', '95');
    await spend(r, holdId, '95', 'k1');
    const before = thresholdEvents(r).length;
    await spend(r, holdId, '95', 'k1');
    expect(thresholdEvents(r)).toHaveLength(before);
  });
});
