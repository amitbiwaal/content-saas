import { describe, expect, it } from 'vitest';

import {
  assertConsumable,
  CONSUMPTION_REASON,
  planConsumption,
  remainingAfter,
  toCreditConsumption,
  toSettlementResult,
  type ConsumptionCommand,
} from './consumption.js';
import { HoldError, type CreditHold, type HoldState } from './holds.js';
import type { LedgerEntry, LedgerEntryType } from './ledger.js';
import { toCreditReservation, type CreditReservation } from './reservation.js';

const ORG = '018f7a1e-0000-7000-8000-0000000000aa';
const WS = '018f7a1e-0000-7000-8000-0000000000bb';
const OTHER = '018f7a1e-0000-7000-8000-0000000000cc';
const AT = '2026-07-31T12:00:00.000Z';
const LATER = '2026-08-01T12:00:00.000Z';

const hold = (overrides: Partial<CreditHold> = {}): CreditHold => ({
  id: 'hold-1',
  tenantId: ORG,
  organizationId: ORG,
  workspaceId: WS,
  runId: 'run-1',
  amount: '10.000000',
  consumed: '0.000000',
  state: 'held',
  expiresAt: LATER,
  reason: 'a run',
  correlationId: '018f7a1e-0000-7000-8000-0000000000dd',
  createdBy: null,
  metadata: {},
  createdAt: AT,
  settledAt: null,
  releasedAt: null,
  ...overrides,
});

const reservation = (overrides: Partial<CreditHold> = {}): CreditReservation =>
  toCreditReservation(hold(overrides));

const entry = (overrides: Partial<LedgerEntry> = {}): LedgerEntry => ({
  id: 'entry-1',
  tenantId: ORG,
  organizationId: ORG,
  workspaceId: WS,
  entryType: 'consumption',
  amount: '4.000000',
  direction: 'debit',
  idempotencyKey: 'run-1:step-1',
  referenceEntryId: null,
  reason: 'the outline step',
  correlationId: '018f7a1e-0000-7000-8000-0000000000dd',
  createdBy: null,
  metadata: { holdId: 'hold-1', runId: 'run-1' },
  createdAt: AT,
  ...overrides,
});

const command = (overrides: Partial<ConsumptionCommand> = {}): ConsumptionCommand => ({
  organizationId: ORG,
  workspaceId: WS,
  executionId: 'run-1',
  reservationId: 'hold-1',
  amount: '4.000000',
  idempotencyKey: 'run-1:step-1',
  note: 'the outline step',
  ...overrides,
});

const codeOf = (run: () => unknown): string | null => {
  try {
    run();
    return null;
  } catch (failure) {
    return failure instanceof HoldError ? failure.code : 'not-a-hold-error';
  }
};

// ── The projection ──────────────────────────────────────────────────────────

describe('reading a ledger entry as a consumption', () => {
  it('carries every field the increment names', () => {
    const consumption = toCreditConsumption(entry());

    expect(consumption.consumptionId).toBe('entry-1');
    expect(consumption.reservationId).toBe('hold-1');
    expect(consumption.executionId).toBe('run-1');
    expect(consumption.organizationId).toBe(ORG);
    expect(consumption.workspaceId).toBe(WS);
    expect(consumption.amount).toBe('4.000000');
    expect(consumption.createdAt).toBe(AT);
  });

  it('takes its identity from the ledger entry', () => {
    // A consumption is not a record of its own; a second id would be a second
    // thing to reconcile against the entry.
    expect(toCreditConsumption(entry({ id: 'entry-9' })).consumptionId).toBe('entry-9');
  });

  it('reads the reservation and run the frozen service recorded', () => {
    const consumption = toCreditConsumption(
      entry({ metadata: { holdId: 'hold-7', runId: 'run-7' } }),
    );

    expect(consumption.reservationId).toBe('hold-7');
    expect(consumption.executionId).toBe('run-7');
  });

  it('always records CREDIT_CONSUMPTION', () => {
    expect(toCreditConsumption(entry()).reason).toBe(CONSUMPTION_REASON);
    expect(CONSUMPTION_REASON).toBe('CREDIT_CONSUMPTION');
  });

  it('carries the caller’s note and idempotency key', () => {
    const consumption = toCreditConsumption(entry());

    expect(consumption.note).toBe('the outline step');
    expect(consumption.idempotencyKey).toBe('run-1:step-1');
  });

  it('refuses an entry of any other type', () => {
    // Reading a grant as a consumption would put a credit in a spend report.
    for (const entryType of ['grant', 'refund', 'adjustment', 'expiry'] as LedgerEntryType[]) {
      expect(codeOf(() => toCreditConsumption(entry({ entryType })))).toBe('InvalidHoldState');
    }
  });

  it('refuses one with no workspace attribution', () => {
    expect(codeOf(() => toCreditConsumption(entry({ workspaceId: null })))).toBe(
      'InvalidHoldState',
    );
  });

  it('refuses one that names no reservation or run', () => {
    expect(codeOf(() => toCreditConsumption(entry({ metadata: {} })))).toBe('HoldNotFound');
    expect(codeOf(() => toCreditConsumption(entry({ metadata: { runId: 'run-1' } })))).toBe(
      'HoldNotFound',
    );
    expect(codeOf(() => toCreditConsumption(entry({ metadata: { holdId: 'hold-1' } })))).toBe(
      'HoldNotFound',
    );
  });

  it('is frozen through', () => {
    const consumption = toCreditConsumption(entry());

    expect(Object.isFrozen(consumption)).toBe(true);
    expect(() => {
      (consumption as { amount: string }).amount = '999.000000';
    }).toThrow();
  });
});

// ── Which reservations may be consumed ──────────────────────────────────────

describe('only an active reservation may be consumed', () => {
  it('accepts an active one', () => {
    expect(
      codeOf(() => {
        assertConsumable(reservation());
      }),
    ).toBeNull();
  });

  it('refuses a released one', () => {
    expect(
      codeOf(() => {
        assertConsumable(reservation({ state: 'released' }));
      }),
    ).toBe('HoldNotOpen');
  });

  it('refuses an expired one', () => {
    expect(
      codeOf(() => {
        assertConsumable(reservation({ state: 'expired' }));
      }),
    ).toBe('HoldNotOpen');
  });

  it('refuses one already consumed', () => {
    expect(
      codeOf(() => {
        assertConsumable(reservation({ state: 'settled' }));
      }),
    ).toBe('HoldNotOpen');
  });

  it('says a charge arriving now is two deciders disagreeing', () => {
    expect(() => {
      assertConsumable(reservation({ state: 'released' }));
    }).toThrow(/two deciders disagreeing/);
  });

  it('refuses every terminal state', () => {
    for (const state of ['settled', 'released', 'expired'] as HoldState[]) {
      expect(
        codeOf(() => {
          assertConsumable(reservation({ state }));
        }),
      ).toBe('HoldNotOpen');
    }
  });
});

// ── Planning a settlement ───────────────────────────────────────────────────

describe('planning a settlement', () => {
  it('says exactly what one ledger entry would record', () => {
    const plan = planConsumption({ command: command(), reservation: reservation() });

    expect(plan).toEqual({
      reservationId: 'hold-1',
      organizationId: ORG,
      workspaceId: WS,
      executionId: 'run-1',
      reason: CONSUMPTION_REASON,
      amount: '4.000000',
      idempotencyKey: 'run-1:step-1',
      note: 'the outline step',
      remainingAfter: '6.000000',
      exhausts: false,
    });
  });

  it('says when a charge fills the reservation exactly', () => {
    const plan = planConsumption({
      command: command({ amount: '10.000000' }),
      reservation: reservation(),
    });

    expect(plan.remainingAfter).toBe('0.000000');
    expect(plan.exhausts).toBe(true);
  });

  it('accounts for what was already consumed', () => {
    const plan = planConsumption({
      command: command({ amount: '3.000000' }),
      reservation: reservation({ consumed: '4.000000' }),
    });

    expect(plan.remainingAfter).toBe('3.000000');
  });

  it('is frozen', () => {
    expect(
      Object.isFrozen(planConsumption({ command: command(), reservation: reservation() })),
    ).toBe(true);
  });

  it('reads no clock and generates nothing', () => {
    const first = planConsumption({ command: command(), reservation: reservation() });
    const second = planConsumption({ command: command(), reservation: reservation() });

    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });
});

describe('the refusals the pipeline names', () => {
  it('refuses an unknown reservation', () => {
    expect(codeOf(() => planConsumption({ command: command(), reservation: null }))).toBe(
      'HoldNotFound',
    );
  });

  it('refuses a released, expired or already-consumed one', () => {
    for (const state of ['released', 'expired', 'settled'] as HoldState[]) {
      expect(
        codeOf(() => planConsumption({ command: command(), reservation: reservation({ state }) })),
      ).toBe('HoldNotOpen');
    }
  });

  it('refuses a charge larger than the reservation', () => {
    // The reservation is the bound on worst-case spend.
    expect(
      codeOf(() =>
        planConsumption({ command: command({ amount: '11.000000' }), reservation: reservation() }),
      ),
    ).toBe('HoldExceeded');
  });

  it('refuses a charge larger than what is LEFT', () => {
    expect(
      codeOf(() =>
        planConsumption({
          command: command({ amount: '7.000000' }),
          reservation: reservation({ consumed: '4.000000' }),
        }),
      ),
    ).toBe('HoldExceeded');
  });

  it('accepts one that fills the remainder exactly', () => {
    expect(
      codeOf(() =>
        planConsumption({
          command: command({ amount: '6.000000' }),
          reservation: reservation({ consumed: '4.000000' }),
        }),
      ),
    ).toBeNull();
  });

  it('refuses a missing idempotency key', () => {
    // An unkeyed consumption has no way to converge, and the ledger has no
    // UPDATE path to correct a double charge.
    expect(
      codeOf(() =>
        planConsumption({ command: command({ idempotencyKey: '  ' }), reservation: reservation() }),
      ),
    ).toBe('ConsumptionMismatch');
  });

  it('refuses a missing note', () => {
    expect(
      codeOf(() => planConsumption({ command: command({ note: '' }), reservation: reservation() })),
    ).toBe('ConsumptionMismatch');
  });

  it('checks identity before money', () => {
    // A charge against a reservation that is fine, filed under the wrong
    // workspace, bills the wrong client — permanently.
    expect(
      codeOf(() =>
        planConsumption({
          command: command({ workspaceId: OTHER, amount: '999.000000' }),
          reservation: reservation(),
        }),
      ),
    ).toBe('ConsumptionMismatch');
  });

  it('refuses a mismatched organization', () => {
    expect(
      codeOf(() =>
        planConsumption({
          command: command({ organizationId: OTHER }),
          reservation: reservation(),
        }),
      ),
    ).toBe('ConsumptionMismatch');
  });

  it('refuses a mismatched workspace', () => {
    expect(
      codeOf(() =>
        planConsumption({ command: command({ workspaceId: OTHER }), reservation: reservation() }),
      ),
    ).toBe('ConsumptionMismatch');
  });

  it('refuses a mismatched run', () => {
    expect(
      codeOf(() =>
        planConsumption({ command: command({ executionId: 'run-9' }), reservation: reservation() }),
      ),
    ).toBe('ConsumptionMismatch');
  });

  it('refuses a mismatched reservation id', () => {
    expect(
      codeOf(() =>
        planConsumption({
          command: command({ reservationId: 'hold-9' }),
          reservation: reservation(),
        }),
      ),
    ).toBe('ConsumptionMismatch');
  });

  it('refuses an amount the ledger grammar would not accept', () => {
    for (const amount of ['-1.000000', '1.0000001', 'nonsense']) {
      expect(
        codeOf(() => planConsumption({ command: command({ amount }), reservation: reservation() })),
      ).not.toBeNull();
    }
  });

  it('names the reservation on every refusal, so a page is actionable', () => {
    expect(() =>
      planConsumption({ command: command(), reservation: reservation({ state: 'expired' }) }),
    ).toThrow(/hold-1/);
  });
});

// ── The outcome ─────────────────────────────────────────────────────────────

describe('reading what a settlement did', () => {
  it('reports a new charge as recorded', () => {
    const result = toSettlementResult({ entry: entry(), hold: hold(), created: true });

    expect(result.outcome).toBe('recorded');
    expect(result.consumption.consumptionId).toBe('entry-1');
    expect(result.reservation.reservationId).toBe('hold-1');
  });

  it('reports a retry as converged, not as a failure', () => {
    // A retried AI call that finds its charge already recorded has succeeded;
    // reporting it as an error would turn every retry into an incident.
    const result = toSettlementResult({ entry: entry(), hold: hold(), created: false });

    expect(result.outcome).toBe('converged');
    expect(result.consumption.consumptionId).toBe('entry-1');
  });

  it('carries the reservation as it stands after the charge', () => {
    const result = toSettlementResult({
      entry: entry(),
      hold: hold({ consumed: '4.000000' }),
      created: true,
    });

    expect(result.reservation.consumed).toBe('4.000000');
    expect(result.reservation.remaining).toBe('6.000000');
  });

  it('shows a consumed reservation as terminal', () => {
    const result = toSettlementResult({
      entry: entry(),
      hold: hold({ state: 'settled', consumed: '10.000000' }),
      created: true,
    });

    expect(result.reservation.status).toBe('consumed');
    expect(result.reservation.remaining).toBe('0.000000');
  });

  it('is frozen through', () => {
    const result = toSettlementResult({ entry: entry(), hold: hold(), created: true });

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.consumption)).toBe(true);
    expect(Object.isFrozen(result.reservation)).toBe(true);
  });
});

describe('what is left after a charge', () => {
  it('subtracts from the unspent remainder', () => {
    expect(remainingAfter(reservation(), '4.000000')).toBe('6.000000');
    expect(remainingAfter(reservation({ consumed: '4.000000' }), '3.000000')).toBe('3.000000');
  });

  it('is exact where a float would not be', () => {
    expect(remainingAfter(reservation({ amount: '0.300000' }), '0.100000')).toBe('0.200000');
  });
});
