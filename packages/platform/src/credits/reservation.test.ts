import { describe, expect, it } from 'vitest';

import { HOLD_STATES, HoldError, type CreditHold, type HoldState } from './holds.js';
import {
  ACTIVE_RESERVATION_STATUS,
  assertExpirable,
  assertTransitionAllowed,
  canTransition,
  expiredAmong,
  HOLD_STATE_TO_STATUS,
  INITIAL_RESERVATION_STATUS,
  isExpired,
  isReservationStatus,
  isTerminalReservationStatus,
  RESERVATION_STATUSES,
  RESERVATION_TRANSITION_RULES,
  RESERVATION_TRANSITIONS,
  STATUS_TO_HOLD_STATE,
  statusOf,
  statusToHoldState,
  targetOf,
  TERMINAL_RESERVATION_STATUSES,
  toCreditReservation,
  transitionsFrom,
  type ReservationStatus,
} from './reservation.js';

const ORG = '018f7a1e-0000-7000-8000-0000000000aa';
const WS = '018f7a1e-0000-7000-8000-0000000000bb';
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
  metadata: { note: 'carried' },
  createdAt: AT,
  settledAt: null,
  releasedAt: null,
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

// ── The vocabulary ──────────────────────────────────────────────────────────

describe('the reservation vocabulary', () => {
  it('is the lifecycle the increment specifies', () => {
    expect([...RESERVATION_STATUSES]).toEqual([
      'created',
      'active',
      'consumed',
      'released',
      'expired',
    ]);
  });

  it('starts at created, which no row carries', () => {
    expect(INITIAL_RESERVATION_STATUS).toBe('created');
    expect(HOLD_STATES).not.toContain('created' as unknown as HoldState);
  });

  it('reserves credits in exactly one status', () => {
    expect(ACTIVE_RESERVATION_STATUS).toBe('active');
  });

  it('treats consumed, released and expired as terminal', () => {
    expect([...TERMINAL_RESERVATION_STATUSES]).toEqual(['consumed', 'released', 'expired']);
    for (const status of RESERVATION_STATUSES) {
      expect(isTerminalReservationStatus(status)).toBe(
        TERMINAL_RESERVATION_STATUSES.includes(status),
      );
    }
  });

  it('recognises its own members and nothing else', () => {
    expect(isReservationStatus('active')).toBe(true);
    expect(isReservationStatus('ACTIVE')).toBe(false);
    expect(isReservationStatus('held')).toBe(false);
    expect(isReservationStatus(3)).toBe(false);
  });
});

// ── The machine ─────────────────────────────────────────────────────────────

describe('the transitions the increment allows', () => {
  it('walks CREATED → ACTIVE → CONSUMED', () => {
    let status: ReservationStatus = INITIAL_RESERVATION_STATUS;
    status = assertTransitionAllowed(status, 'activate');
    expect(status).toBe('active');
    expect(assertTransitionAllowed(status, 'consume')).toBe('consumed');
  });

  it('allows release and expiry from active', () => {
    expect(targetOf('active', 'release')).toBe('released');
    expect(targetOf('active', 'expire')).toBe('expired');
  });

  it('activates only from created', () => {
    for (const status of RESERVATION_STATUSES) {
      expect(canTransition(status, 'activate')).toBe(status === 'created');
    }
  });

  it('consumes, releases and expires only from active', () => {
    for (const transition of ['consume', 'release', 'expire'] as const) {
      for (const status of RESERVATION_STATUSES) {
        expect(canTransition(status, transition)).toBe(status === 'active');
      }
    }
  });
});

describe('the transitions it forbids', () => {
  it('never returns to active', () => {
    // Re-entering would reserve credits a second time from a reservation that
    // had already been accounted for.
    for (const status of RESERVATION_STATUSES) {
      if (status === 'created') continue;
      for (const transition of RESERVATION_TRANSITIONS) {
        expect(targetOf(status, transition)).not.toBe('active');
      }
    }
  });

  it('leaves no edge out of a terminal status', () => {
    for (const status of TERMINAL_RESERVATION_STATUSES) {
      expect(transitionsFrom(status)).toEqual([]);
      for (const transition of RESERVATION_TRANSITIONS) {
        expect(canTransition(status, transition)).toBe(false);
      }
    }
  });

  it('refuses a second expiry', () => {
    expect(codeOf(() => assertTransitionAllowed('expired', 'expire'))).toBe('InvalidHoldState');
  });

  it('refuses a settle that arrives after a release', () => {
    // Two deciders disagreeing, not a state change. Overwriting would make the
    // disagreement invisible.
    expect(codeOf(() => assertTransitionAllowed('released', 'consume'))).toBe('InvalidHoldState');
  });

  it('refuses consuming a reservation that was never activated', () => {
    expect(codeOf(() => assertTransitionAllowed('created', 'consume'))).toBe('InvalidHoldState');
  });

  it('names what WOULD have been legal', () => {
    expect(() => assertTransitionAllowed('created', 'consume')).toThrow(/Available: activate/);
  });

  it('says so when the status is terminal, rather than listing nothing', () => {
    expect(() => assertTransitionAllowed('consumed', 'release')).toThrow(/'consumed' is terminal/);
  });
});

describe('the transition table', () => {
  it('never gives one (from, transition) pair two targets', () => {
    const seen = new Set<string>();
    for (const rule of RESERVATION_TRANSITION_RULES) {
      const key = `${rule.from}/${rule.transition}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  it('names only declared statuses and transitions', () => {
    for (const rule of RESERVATION_TRANSITION_RULES) {
      expect(RESERVATION_STATUSES).toContain(rule.from);
      expect(RESERVATION_STATUSES).toContain(rule.to);
      expect(RESERVATION_TRANSITIONS).toContain(rule.transition);
    }
  });

  it('leaves every status reachable from created', () => {
    const reached = new Set<ReservationStatus>([INITIAL_RESERVATION_STATUS]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const rule of RESERVATION_TRANSITION_RULES) {
        if (reached.has(rule.from) && !reached.has(rule.to)) {
          reached.add(rule.to);
          grew = true;
        }
      }
    }
    expect([...reached].sort()).toEqual([...RESERVATION_STATUSES].sort());
  });

  it('is frozen', () => {
    expect(Object.isFrozen(RESERVATION_TRANSITION_RULES)).toBe(true);
  });
});

// ── The two vocabularies ────────────────────────────────────────────────────

describe('mapping onto the stored hold states', () => {
  it('maps each storable status to its frozen state', () => {
    expect(statusToHoldState('active')).toBe('held');
    expect(statusToHoldState('consumed')).toBe('settled');
    expect(statusToHoldState('released')).toBe('released');
    expect(statusToHoldState('expired')).toBe('expired');
  });

  it('produces only states the frozen enum already has', () => {
    // Nothing here invents a state, which is what keeps this a bridge rather
    // than a second reservation system.
    for (const status of RESERVATION_STATUSES) {
      if (status === 'created') continue;
      expect(HOLD_STATES).toContain(statusToHoldState(status));
    }
  });

  it('refuses created, because no row carries it', () => {
    expect(codeOf(() => statusToHoldState('created'))).toBe('InvalidHoldState');
    expect(() => statusToHoldState('created')).toThrow(/before it exists/);
  });

  it('refuses a status it has never heard of', () => {
    expect(codeOf(() => statusToHoldState('paused' as ReservationStatus))).toBe('InvalidHoldState');
  });

  it('is total in the other direction: every stored state has a name', () => {
    for (const state of HOLD_STATES) {
      expect(isReservationStatus(statusOf(state))).toBe(true);
    }
  });

  it('round-trips every storable status', () => {
    for (const status of RESERVATION_STATUSES) {
      if (status === 'created') continue;
      expect(statusOf(statusToHoldState(status))).toBe(status);
    }
  });

  it('round-trips every stored state', () => {
    for (const state of HOLD_STATES) {
      expect(statusToHoldState(statusOf(state))).toBe(state);
    }
  });

  it('has tables that agree, and are frozen', () => {
    for (const [status, state] of Object.entries(STATUS_TO_HOLD_STATE)) {
      expect(HOLD_STATE_TO_STATUS[state]).toBe(status);
    }
    expect(Object.isFrozen(STATUS_TO_HOLD_STATE)).toBe(true);
    expect(Object.isFrozen(HOLD_STATE_TO_STATUS)).toBe(true);
  });
});

// ── The projection ──────────────────────────────────────────────────────────

describe('reading a hold as a reservation', () => {
  it('carries every field the increment names', () => {
    const reservation = toCreditReservation(hold());

    expect(reservation.reservationId).toBe('hold-1');
    expect(reservation.organizationId).toBe(ORG);
    expect(reservation.workspaceId).toBe(WS);
    expect(reservation.executionId).toBe('run-1');
    expect(reservation.amount).toBe('10.000000');
    expect(reservation.createdAt).toBe(AT);
    expect(reservation.expiresAt).toBe(LATER);
    expect(reservation.status).toBe('active');
  });

  it('reports what is still held down, not the whole reservation', () => {
    // What has been spent is already a ledger debit; counting it again would
    // show the customer less than they have.
    expect(toCreditReservation(hold({ consumed: '4.000000' })).remaining).toBe('6.000000');
  });

  it('holds nothing down once it is closed', () => {
    for (const state of ['settled', 'released', 'expired'] as const) {
      expect(toCreditReservation(hold({ state, consumed: '4.000000' })).remaining).toBe('0.000000');
    }
  });

  it('carries the metadata a hold arrived with', () => {
    const reservation = toCreditReservation(hold());

    expect(reservation.metadata.reason).toBe('a run');
    expect(reservation.metadata.correlationId).toBe('018f7a1e-0000-7000-8000-0000000000dd');
    expect(reservation.metadata.createdBy).toBeNull();
    expect(reservation.metadata.attributes).toEqual({ note: 'carried' });
  });

  it('names the status in the commercial vocabulary', () => {
    expect(toCreditReservation(hold({ state: 'settled' })).status).toBe('consumed');
    expect(toCreditReservation(hold({ state: 'released' })).status).toBe('released');
    expect(toCreditReservation(hold({ state: 'expired' })).status).toBe('expired');
  });

  it('is frozen through', () => {
    const reservation = toCreditReservation(hold());

    expect(Object.isFrozen(reservation)).toBe(true);
    expect(Object.isFrozen(reservation.metadata)).toBe(true);
    expect(() => {
      (reservation as { amount: string }).amount = '999.000000';
    }).toThrow();
  });

  it('does not alias the hold it came from', () => {
    const source = hold();
    const reservation = toCreditReservation(source);

    expect(reservation.metadata.attributes).not.toBe(source.metadata);
  });
});

// ── Expiration ──────────────────────────────────────────────────────────────

describe('expiration is deterministic', () => {
  it('reads no clock — the instant is supplied', () => {
    const reservation = toCreditReservation(hold({ expiresAt: LATER }));

    expect(isExpired(reservation, AT)).toBe(false);
    expect(isExpired(reservation, LATER)).toBe(true);
    expect(isExpired(reservation, '2026-09-01T00:00:00.000Z')).toBe(true);
  });

  it('gives the same answer twice for the same instant', () => {
    const reservation = toCreditReservation(hold());
    expect(isExpired(reservation, LATER)).toBe(isExpired(reservation, LATER));
  });

  it('expires nothing that is already closed', () => {
    // A terminal reservation has already stopped being subtracted; calling it
    // expired afterwards would rewrite why it closed.
    for (const state of ['settled', 'released', 'expired'] as const) {
      expect(isExpired(toCreditReservation(hold({ state })), '2026-09-01T00:00:00.000Z')).toBe(
        false,
      );
    }
  });

  it('selects exactly what a sweep would reclaim', () => {
    const reservations = [
      toCreditReservation(hold({ id: 'a', expiresAt: AT })),
      toCreditReservation(hold({ id: 'b', expiresAt: '2026-09-01T00:00:00.000Z' })),
      toCreditReservation(hold({ id: 'c', expiresAt: AT, state: 'released' })),
    ];

    expect(expiredAmong(reservations, LATER).map((one) => one.reservationId)).toEqual(['a']);
  });

  it('freezes what it selects', () => {
    expect(Object.isFrozen(expiredAmong([], AT))).toBe(true);
  });
});

describe('refusing to expire', () => {
  const expiring = (reservation: CreditHold, now: string): (() => void) => {
    const value = toCreditReservation(reservation);
    return () => {
      assertExpirable(value, now);
    };
  };

  it('accepts one whose TTL has elapsed', () => {
    expect(codeOf(expiring(hold({ expiresAt: AT }), LATER))).toBeNull();
  });

  it('refuses a second expiry', () => {
    expect(codeOf(expiring(hold({ state: 'expired', expiresAt: AT }), LATER))).toBe(
      'InvalidHoldState',
    );
  });

  it('says an expired reservation never becomes active again', () => {
    expect(expiring(hold({ state: 'expired', expiresAt: AT }), LATER)).toThrow(
      /cannot become active again/,
    );
  });

  it('refuses expiring one whose TTL has not elapsed', () => {
    // Releasing credits a live run is still counting on.
    expect(codeOf(expiring(hold({ expiresAt: LATER }), AT))).toBe('InvalidHoldState');
  });

  it('refuses expiring a settled or released reservation', () => {
    for (const state of ['settled', 'released'] as const) {
      expect(codeOf(expiring(hold({ state, expiresAt: AT }), LATER))).toBe('InvalidHoldState');
    }
  });

  it('names the reservation, so the page is actionable', () => {
    expect(expiring(hold({ id: 'hold-9', state: 'expired' }), LATER)).toThrow(/hold-9/);
  });
});
