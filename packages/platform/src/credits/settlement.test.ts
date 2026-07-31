import { describe, expect, it } from 'vitest';

import { HoldError, type CreditHold, type HoldErrorCode } from './holds.js';
import { toCreditReservation, type CreditReservation } from './reservation.js';
import {
  assertSettleable,
  closesPermanently,
  computeSettlement,
  isSettlementStatus,
  planSettlement,
  releasableOf,
  SETTLED_STATUS,
  SETTLEMENT_STATUSES,
  summarizeSettlements,
  toReservationSettlement,
  toSettlementClosure,
  type ReservationSettlement,
  type SettlementCommand,
} from './settlement.js';

const ORG = '018f7a1e-0000-7000-8000-0000000000aa';
const WS = '018f7a1e-0000-7000-8000-0000000000bb';
const OPENED = '2026-07-31T09:00:00.000Z';
const CLOSED = '2026-07-31T12:00:00.000Z';
const EXPIRES = '2026-08-01T09:00:00.000Z';

const hold = (overrides: Partial<CreditHold> = {}): CreditHold => ({
  id: 'hold-1',
  tenantId: ORG,
  organizationId: ORG,
  workspaceId: WS,
  runId: 'run-1',
  amount: '10.000000',
  consumed: '0.000000',
  state: 'held',
  expiresAt: EXPIRES,
  reason: 'a content run',
  correlationId: '018f7a1e-0000-7000-8000-0000000000dd',
  createdBy: null,
  metadata: {},
  createdAt: OPENED,
  settledAt: null,
  releasedAt: null,
  ...overrides,
});

/** A closed hold, stamped the way the frozen service stamps each closure. */
const settled = (overrides: Partial<CreditHold> = {}): CreditHold =>
  hold({ state: 'settled', settledAt: CLOSED, ...overrides });

const released = (overrides: Partial<CreditHold> = {}): CreditHold =>
  hold({ state: 'released', releasedAt: CLOSED, ...overrides });

const expired = (overrides: Partial<CreditHold> = {}): CreditHold =>
  hold({ state: 'expired', releasedAt: CLOSED, ...overrides });

const reservation = (overrides: Partial<CreditHold> = {}): CreditReservation =>
  toCreditReservation(hold(overrides));

const command = (overrides: Partial<SettlementCommand> = {}): SettlementCommand => ({
  organizationId: ORG,
  workspaceId: WS,
  executionId: 'run-1',
  reservationId: 'hold-1',
  settledAt: CLOSED,
  ...overrides,
});

/** The code a call fails with, or null when it did not fail. */
const codeOf = (call: () => void): HoldErrorCode | null => {
  try {
    call();
    return null;
  } catch (error) {
    if (error instanceof HoldError) return error.code;
    throw error;
  }
};

// ── The vocabulary ──────────────────────────────────────────────────────────

describe('settlement statuses', () => {
  it('are the three ways a reservation closes', () => {
    expect(SETTLEMENT_STATUSES).toEqual(['consumed', 'released', 'expired']);
  });

  it('name SETTLED as the S5.2 `consumed`, not a fifth state', () => {
    expect(SETTLED_STATUS).toBe('consumed');
    expect(SETTLEMENT_STATUSES).toContain(SETTLED_STATUS);
  });

  it('exclude `active`, which is not a closure', () => {
    expect(isSettlementStatus('active')).toBe(false);
    expect(isSettlementStatus('created')).toBe(false);
    expect(isSettlementStatus('consumed')).toBe(true);
  });

  it('reject anything that is not a status at all', () => {
    expect(isSettlementStatus('SETTLED')).toBe(false);
    expect(isSettlementStatus(null)).toBe(false);
    expect(isSettlementStatus(7)).toBe(false);
  });

  it('are frozen', () => {
    expect(Object.isFrozen(SETTLEMENT_STATUSES)).toBe(true);
  });

  it('all close a reservation permanently', () => {
    for (const status of SETTLEMENT_STATUSES) {
      expect(closesPermanently(status)).toBe(true);
    }
  });
});

// ── The arithmetic ──────────────────────────────────────────────────────────

describe('computeSettlement', () => {
  it('releases what was not consumed', () => {
    const summary = computeSettlement({ reserved: '10.000000', consumed: '4.000000' });

    expect(summary.reserved).toBe('10.000000');
    expect(summary.consumed).toBe('4.000000');
    expect(summary.released).toBe('6.000000');
  });

  it('releases the whole reservation when nothing was consumed', () => {
    const summary = computeSettlement({ reserved: '10.000000', consumed: '0.000000' });

    expect(summary.released).toBe('10.000000');
    expect(summary.usage).toBe('unused');
  });

  it('releases nothing when the reservation was consumed exactly', () => {
    const summary = computeSettlement({ reserved: '10.000000', consumed: '10.000000' });

    expect(summary.released).toBe('0.000000');
    expect(summary.usage).toBe('exhausted');
  });

  it('calls a part-spent reservation partial', () => {
    expect(computeSettlement({ reserved: '10.000000', consumed: '0.000001' }).usage).toBe(
      'partial',
    );
    expect(computeSettlement({ reserved: '10.000000', consumed: '9.999999' }).usage).toBe(
      'partial',
    );
  });

  it('calls a reservation of nothing unused, not exhausted', () => {
    // Degenerate but reachable: nothing was spent either way, and reporting it
    // as exhausted would say a run used up credits it never had.
    expect(computeSettlement({ reserved: '0.000000', consumed: '0.000000' }).usage).toBe('unused');
  });

  it('refuses to report a negative release', () => {
    // The table CHECKs this and every charge is bounded, so it should be
    // unreachable — which is exactly why it is worth asserting: the figure is
    // what a customer is told came back to them.
    expect(codeOf(() => computeSettlement({ reserved: '10.000000', consumed: '10.000001' }))).toBe(
      'HoldExceeded',
    );
  });

  it('refuses a negative amount outright', () => {
    expect(() => computeSettlement({ reserved: '-1.000000', consumed: '0.000000' })).toThrow();
    expect(() => computeSettlement({ reserved: '10.000000', consumed: '-1.000000' })).toThrow();
  });

  it('keeps the sixth decimal place', () => {
    const summary = computeSettlement({ reserved: '0.000003', consumed: '0.000001' });

    expect(summary.released).toBe('0.000002');
  });

  it('does not go through a float', () => {
    // 0.1 + 0.2 is the canonical demonstration; at ledger scale the same class
    // of error shows up as a cent nobody can account for.
    const summary = computeSettlement({ reserved: '0.300000', consumed: '0.100000' });

    expect(summary.released).toBe('0.200000');
  });

  it('handles a reservation larger than a safe integer of scaled units', () => {
    const summary = computeSettlement({ reserved: '9007199254.740993', consumed: '0.000001' });

    expect(summary.released).toBe('9007199254.740992');
  });

  it('is frozen', () => {
    const summary = computeSettlement({ reserved: '10.000000', consumed: '4.000000' });

    expect(Object.isFrozen(summary)).toBe(true);
    expect(() => {
      (summary as { released: string }).released = '999.000000';
    }).toThrow();
  });
});

// ── The guard ───────────────────────────────────────────────────────────────

describe('assertSettleable', () => {
  it('admits an active reservation', () => {
    expect(
      codeOf(() => {
        assertSettleable(reservation());
      }),
    ).toBeNull();
  });

  it('refuses an already settled reservation', () => {
    const code = codeOf(() => {
      assertSettleable(toCreditReservation(settled()));
    });

    expect(code).toBe('HoldNotOpen');
  });

  it('says "already settled" rather than "is consumed", so an operator can act', () => {
    let message = '';
    try {
      assertSettleable(toCreditReservation(settled()));
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain('already settled');
    expect(message).toContain('hold-1');
  });

  it('refuses a released reservation', () => {
    expect(
      codeOf(() => {
        assertSettleable(toCreditReservation(released()));
      }),
    ).toBe('HoldNotOpen');
  });

  it('refuses an expired reservation', () => {
    expect(
      codeOf(() => {
        assertSettleable(toCreditReservation(expired()));
      }),
    ).toBe('HoldNotOpen');
  });

  it('names the reservation and the state it is actually in', () => {
    let message = '';
    try {
      assertSettleable(toCreditReservation(expired()));
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain('hold-1');
    expect(message).toContain('expired');
  });
});

// ── The pipeline ────────────────────────────────────────────────────────────

describe('planSettlement', () => {
  it('closes an active reservation and says what came back', () => {
    const plan = planSettlement({
      command: command(),
      reservation: reservation({ consumed: '4.000000' }),
    });

    expect(plan.status).toBe(SETTLED_STATUS);
    expect(plan.reserved).toBe('10.000000');
    expect(plan.consumed).toBe('4.000000');
    expect(plan.released).toBe('6.000000');
    expect(plan.settledAt).toBe(CLOSED);
  });

  it('carries every identifier from the reservation, not the command', () => {
    const plan = planSettlement({ command: command(), reservation: reservation() });

    expect(plan.settlementId).toBe('hold-1');
    expect(plan.reservationId).toBe('hold-1');
    expect(plan.executionId).toBe('run-1');
    expect(plan.organizationId).toBe(ORG);
    expect(plan.workspaceId).toBe(WS);
  });

  it('gives a settlement the reservation’s own id', () => {
    // A settlement is not a second record; a second id would be a second thing
    // to reconcile against the reservation.
    const plan = planSettlement({ command: command(), reservation: reservation() });

    expect(plan.settlementId).toBe(plan.reservationId);
  });

  it('handles a fully consumed reservation', () => {
    const plan = planSettlement({
      command: command(),
      reservation: reservation({ consumed: '10.000000' }),
    });

    expect(plan.released).toBe('0.000000');
    expect(plan.usage).toBe('exhausted');
  });

  it('handles a reservation nothing was charged against', () => {
    const plan = planSettlement({ command: command(), reservation: reservation() });

    expect(plan.released).toBe('10.000000');
    expect(plan.usage).toBe('unused');
  });

  it('requires an instant, because a settlement with no time has no billing period', () => {
    expect(
      codeOf(() =>
        planSettlement({ command: command({ settledAt: '' }), reservation: reservation() }),
      ),
    ).toBe('SettlementMismatch');
    expect(
      codeOf(() =>
        planSettlement({ command: command({ settledAt: '   ' }), reservation: reservation() }),
      ),
    ).toBe('SettlementMismatch');
  });

  it('refuses an unknown reservation', () => {
    expect(codeOf(() => planSettlement({ command: command(), reservation: null }))).toBe(
      'HoldNotFound',
    );
  });

  it('refuses a released reservation', () => {
    expect(
      codeOf(() =>
        planSettlement({ command: command(), reservation: toCreditReservation(released()) }),
      ),
    ).toBe('HoldNotOpen');
  });

  it('refuses an expired reservation', () => {
    expect(
      codeOf(() =>
        planSettlement({ command: command(), reservation: toCreditReservation(expired()) }),
      ),
    ).toBe('HoldNotOpen');
  });

  it('refuses a second settlement of the same reservation', () => {
    expect(
      codeOf(() =>
        planSettlement({ command: command(), reservation: toCreditReservation(settled()) }),
      ),
    ).toBe('HoldNotOpen');
  });

  it('checks the state before the identifiers', () => {
    // A settled reservation with a mismatched workspace is a closed
    // reservation first; leading with the workspace would send an operator
    // looking for a bug that is not there.
    expect(
      codeOf(() =>
        planSettlement({
          command: command({ workspaceId: 'someone-else' }),
          reservation: toCreditReservation(settled()),
        }),
      ),
    ).toBe('HoldNotOpen');
  });

  it('refuses a settlement for the wrong organization', () => {
    expect(
      codeOf(() =>
        planSettlement({
          command: command({ organizationId: 'other-org' }),
          reservation: reservation(),
        }),
      ),
    ).toBe('SettlementMismatch');
  });

  it('refuses a settlement for the wrong workspace', () => {
    expect(
      codeOf(() =>
        planSettlement({
          command: command({ workspaceId: 'other-ws' }),
          reservation: reservation(),
        }),
      ),
    ).toBe('SettlementMismatch');
  });

  it('refuses a settlement for the wrong run', () => {
    expect(
      codeOf(() =>
        planSettlement({ command: command({ executionId: 'run-2' }), reservation: reservation() }),
      ),
    ).toBe('SettlementMismatch');
  });

  it('refuses a command that names a different reservation than the one supplied', () => {
    expect(
      codeOf(() =>
        planSettlement({
          command: command({ reservationId: 'hold-2' }),
          reservation: reservation(),
        }),
      ),
    ).toBe('SettlementMismatch');
  });

  it('checks identity before arithmetic', () => {
    // Attribution first: a release credited to the wrong workspace is wrong
    // even when the figures are right.
    expect(
      codeOf(() =>
        planSettlement({
          command: command({ workspaceId: 'other-ws' }),
          reservation: reservation({ consumed: '4.000000' }),
        }),
      ),
    ).toBe('SettlementMismatch');
  });

  it('is frozen through', () => {
    const plan = planSettlement({ command: command(), reservation: reservation() });

    expect(Object.isFrozen(plan)).toBe(true);
    expect(() => {
      (plan as { released: string }).released = '999.000000';
    }).toThrow();
  });

  it('is the same plan twice', () => {
    // No clock, no id generation: the same inputs must produce the same
    // settlement, or a retry would report a different release.
    expect(planSettlement({ command: command(), reservation: reservation() })).toEqual(
      planSettlement({ command: command(), reservation: reservation() }),
    );
  });
});

// ── Reading a closed reservation ────────────────────────────────────────────

describe('toReservationSettlement', () => {
  it('reads a settled hold', () => {
    const settlement = toReservationSettlement(settled({ consumed: '3.000000' }));

    expect(settlement.status).toBe('consumed');
    expect(settlement.released).toBe('7.000000');
    expect(settlement.settledAt).toBe(CLOSED);
  });

  it('reads a released hold, and reports the release as the whole remainder', () => {
    const settlement = toReservationSettlement(released({ consumed: '3.000000' }));

    expect(settlement.status).toBe('released');
    expect(settlement.released).toBe('7.000000');
  });

  it('reads an expired hold', () => {
    const settlement = toReservationSettlement(expired());

    expect(settlement.status).toBe('expired');
    expect(settlement.released).toBe('10.000000');
  });

  it('takes the instant from whichever column the closure stamped', () => {
    expect(toReservationSettlement(settled()).settledAt).toBe(CLOSED);
    expect(toReservationSettlement(released()).settledAt).toBe(CLOSED);
  });

  it('refuses a reservation that is still open', () => {
    // Reporting an open reservation as settled would show its credits released
    // while a run is still entitled to spend them.
    expect(codeOf(() => toReservationSettlement(hold()))).toBe('HoldNotOpen');
  });

  it('refuses a closed reservation that records no instant', () => {
    expect(codeOf(() => toReservationSettlement(hold({ state: 'settled', settledAt: null })))).toBe(
      'InvalidHoldState',
    );
  });

  it('is frozen through', () => {
    const settlement = toReservationSettlement(settled());

    expect(Object.isFrozen(settlement)).toBe(true);
  });

  it('agrees with what the plan said would happen', () => {
    // The pure path and the stored path must produce the same figures, or a
    // customer sees one number before the run ends and another after.
    const plan = planSettlement({
      command: command(),
      reservation: reservation({ consumed: '4.000000' }),
    });
    const stored = toReservationSettlement(settled({ consumed: '4.000000' }));

    expect(stored).toEqual(plan);
  });
});

// ── The outcome ─────────────────────────────────────────────────────────────

describe('toSettlementClosure', () => {
  it('reports a close this call made as settled', () => {
    const closure = toSettlementClosure({ hold: settled(), converged: false });

    expect(closure.outcome).toBe('settled');
    expect(closure.settlement.status).toBe('consumed');
  });

  it('reports a retry that found it already settled as converged, not as an error', () => {
    // An orchestrator retrying its end-of-run settle has succeeded; reporting
    // it as a failure would turn every retry into an incident.
    const closure = toSettlementClosure({ hold: settled(), converged: true });

    expect(closure.outcome).toBe('converged');
  });

  it('reports a settle that met a release as diverged', () => {
    // Something decided the run failed while this caller believed it
    // succeeded. The credits are right either way; the disagreement is not.
    const closure = toSettlementClosure({ hold: released(), converged: true });

    expect(closure.outcome).toBe('diverged');
    expect(closure.settlement.status).toBe('released');
  });

  it('reports a settle that met the TTL sweep as diverged', () => {
    const closure = toSettlementClosure({ hold: expired(), converged: true });

    expect(closure.outcome).toBe('diverged');
    expect(closure.settlement.status).toBe('expired');
  });

  it('carries the settlement in every outcome', () => {
    for (const closed of [settled(), released(), expired()]) {
      const closure = toSettlementClosure({ hold: closed, converged: true });
      expect(closure.settlement.reservationId).toBe('hold-1');
    }
  });

  it('refuses to describe a hold that is still open', () => {
    expect(codeOf(() => toSettlementClosure({ hold: hold(), converged: false }))).toBe(
      'HoldNotOpen',
    );
  });

  it('is frozen', () => {
    const closure = toSettlementClosure({ hold: settled(), converged: false });

    expect(Object.isFrozen(closure)).toBe(true);
  });
});

// ── Reporting ───────────────────────────────────────────────────────────────

describe('summarizeSettlements', () => {
  const settlementOf = (reserved: string, consumed: string): ReservationSettlement =>
    toReservationSettlement(settled({ amount: reserved, consumed }));

  it('adds a billing period up', () => {
    const summary = summarizeSettlements([
      settlementOf('10.000000', '4.000000'),
      settlementOf('20.000000', '20.000000'),
      settlementOf('5.000000', '0.000000'),
    ]);

    expect(summary.reserved).toBe('35.000000');
    expect(summary.consumed).toBe('24.000000');
    expect(summary.released).toBe('11.000000');
  });

  it('reports an empty period as unused rather than failing', () => {
    const summary = summarizeSettlements([]);

    expect(summary.reserved).toBe('0.000000');
    expect(summary.released).toBe('0.000000');
    expect(summary.usage).toBe('unused');
  });

  it('does not depend on the order it saw them in', () => {
    const a = settlementOf('10.000000', '4.000000');
    const b = settlementOf('20.000000', '1.000000');

    expect(summarizeSettlements([a, b])).toEqual(summarizeSettlements([b, a]));
  });

  it('keeps the sixth decimal place across many settlements', () => {
    const summary = summarizeSettlements(
      Array.from({ length: 3 }, () => settlementOf('0.000002', '0.000001')),
    );

    expect(summary.released).toBe('0.000003');
  });
});

describe('releasableOf', () => {
  it('says what an active reservation would give back', () => {
    expect(releasableOf(reservation({ consumed: '4.000000' }))).toBe('6.000000');
  });

  it('says zero for a reservation that has been spent to the limit', () => {
    expect(releasableOf(reservation({ consumed: '10.000000' }))).toBe('0.000000');
  });

  it('answers from the reservation’s own figures, not its remaining', () => {
    // `remaining` is zero once a reservation closes, which would report a
    // closed reservation as having released nothing.
    expect(releasableOf(toCreditReservation(settled({ consumed: '4.000000' })))).toBe('6.000000');
  });
});
