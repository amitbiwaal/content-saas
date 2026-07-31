/**
 * The reservation core against the hold protocol that already exists.
 *
 * ── What only this file can check ───────────────────────────────────────────
 *
 * 1. IT IS ONE RESERVATION SYSTEM, NOT TWO. Every storable status maps to a
 *    hold state the Sprint 1 enum and the database CHECK already have, and the
 *    projection consumes only the holds the frozen service writes.
 *
 * 2. THE PURE AVAILABILITY MATCHES THE SQL ONE. `available = balance − unspent
 *    open holds` is what `balance.ts` computes in PostgreSQL; this computes the
 *    same figure from values, which is what lets one be checked against the
 *    other.
 *
 * 3. THE LEDGER IS UNTOUCHED. Nothing in this layer appends an entry, and
 *    nothing consumes. Structural, per module.
 *
 * 4. NO PAYMENTS, NO AI, NO DATABASE.
 *
 * 5. THE DEVIATIONS, recorded so they cannot be forgotten.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  ACTIVE_RESERVATION_STATUS,
  assertReservationTransitionAllowed,
  assertSufficient,
  calculateAvailability,
  calculateBalance,
  expiredAmong,
  HOLD_STATES,
  HoldError,
  InsufficientCreditsError,
  isExpired,
  LEDGER_CURRENCY,
  OPEN_HOLD_STATE,
  RESERVATION_STATUSES,
  statusOf,
  statusToHoldState,
  TERMINAL_HOLD_STATES,
  TERMINAL_RESERVATION_STATUSES,
  toCreditReservation,
  type CreditHold,
  type CreditReservationRepository,
  type LedgerEntry,
} from '@contentos/platform';
import { describe, expect, it } from 'vitest';

const ORG = '018f7a1e-0000-7000-8000-0000000000aa';
const WS = '018f7a1e-0000-7000-8000-0000000000bb';
const AT = '2026-07-31T12:00:00.000Z';
const LATER = '2026-08-01T12:00:00.000Z';

const creditsDir = new URL('../../packages/platform/src/credits/', import.meta.url);

const codeOf = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, creditsDir)), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

/** The modules this increment added. */
const NEW_MODULES = ['reservation.ts', 'availability.ts', 'reservation-repository.ts'] as const;

const holdsMigration = (): string =>
  readFileSync(
    fileURLToPath(
      new URL('../../infrastructure/migrations/0022_credits_service.sql', import.meta.url),
    ),
    'utf8',
  );

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

const entry = (amount: string, direction: 'credit' | 'debit'): LedgerEntry => ({
  id: `entry-${amount}-${direction}`,
  tenantId: ORG,
  organizationId: ORG,
  workspaceId: direction === 'debit' ? WS : null,
  entryType: direction === 'credit' ? 'grant' : 'consumption',
  amount,
  direction,
  idempotencyKey: null,
  referenceEntryId: null,
  reason: 'because',
  correlationId: '018f7a1e-0000-7000-8000-0000000000dd',
  createdBy: null,
  metadata: {},
  createdAt: AT,
});

// ── 1 · One reservation system, not two ─────────────────────────────────────

describe('the vocabulary bridges, it does not fork', () => {
  it('maps every storable status onto a frozen hold state', () => {
    for (const status of RESERVATION_STATUSES) {
      if (status === 'created') continue;
      expect(HOLD_STATES).toContain(statusToHoldState(status));
    }
  });

  it('maps onto states the DATABASE already CHECKs', () => {
    // The constraint is the real boundary: a bridge that emitted a fifth value
    // would fail at the column, mid-transaction.
    const sql = holdsMigration();
    for (const status of RESERVATION_STATUSES) {
      if (status === 'created') continue;
      expect(sql).toContain(`'${statusToHoldState(status)}'`);
    }
  });

  it('names every hold state the database can hold', () => {
    for (const state of HOLD_STATES) {
      expect(RESERVATION_STATUSES).toContain(statusOf(state));
    }
  });

  it('agrees with the frozen open and terminal sets', () => {
    // If the two disagreed, availability computed here and availability
    // computed in SQL would subtract different reservations.
    expect(statusToHoldState(ACTIVE_RESERVATION_STATUS)).toBe(OPEN_HOLD_STATE);
    expect(TERMINAL_RESERVATION_STATUSES.map(statusToHoldState).sort()).toEqual(
      [...TERMINAL_HOLD_STATES].sort(),
    );
  });

  it('adds no hold state, no table and no migration', () => {
    for (const file of NEW_MODULES) {
      expect(codeOf(file)).not.toMatch(/CREATE TABLE|ALTER TABLE|INSERT INTO|UPDATE .+ SET /i);
    }
    expect([...HOLD_STATES]).toEqual(['held', 'settled', 'released', 'expired']);
  });

  it('consumes the frozen hold shape rather than a record of its own', () => {
    const code = codeOf('reservation.ts');
    expect(code).toMatch(/from '\.\/holds\.js'/);
    expect(code).not.toMatch(/interface CreditHold\b/);
  });

  it('reuses the frozen remaining-amount rule rather than restating it', () => {
    // The `− consumed` is the one subtraction that decides whether a customer
    // can run anything; a second implementation could quietly disagree.
    const code = codeOf('reservation.ts');
    expect(code).toMatch(/remainingOf/);
    expect(code).not.toMatch(/parseFloat|Number\(|toFixed/);
  });

  it('reuses the frozen error taxonomy rather than a second one', () => {
    for (const file of NEW_MODULES) {
      expect(codeOf(file)).not.toMatch(/class \w*Error extends/);
    }
    expect(new HoldError('InvalidHoldState', 'x').name).toBe('HoldError');
    expect(new InsufficientCreditsError('1', '2', '1')).toBeInstanceOf(HoldError);
  });
});

// ── 2 · The pure availability matches the SQL formula ───────────────────────

describe('availability is balance minus unspent open holds', () => {
  it('composes with the ledger fold from S5.1', () => {
    // One number, computed end to end from entries and reservations, with no
    // database anywhere in it.
    const balance = calculateBalance({
      organizationId: ORG,
      entries: [entry('100.000000', 'credit'), entry('20.000000', 'debit')],
    });

    const availability = calculateAvailability({
      balance,
      reservations: [toCreditReservation(hold({ amount: '30.000000' }))],
    });

    expect(availability.balance).toBe('80.000000');
    expect(availability.reserved).toBe('30.000000');
    expect(availability.available).toBe('50.000000');
  });

  it('subtracts the unspent part only, as `balance.ts` documents', () => {
    // "The `− consumed` is what keeps a charge from being subtracted twice,
    // once as a ledger debit and again as a live reservation."
    const balance = calculateBalance({
      organizationId: ORG,
      entries: [entry('100.000000', 'credit'), entry('10.000000', 'debit')],
    });

    const availability = calculateAvailability({
      balance,
      reservations: [toCreditReservation(hold({ amount: '30.000000', consumed: '10.000000' }))],
    });

    expect(availability.reserved).toBe('20.000000');
    expect(availability.available).toBe('70.000000');
  });

  it('produces the six-place strings the column round-trips', () => {
    const availability = calculateAvailability({
      balance: calculateBalance({ organizationId: ORG, entries: [entry('1.5', 'credit')] }),
      reservations: [],
    });

    for (const figure of [availability.balance, availability.reserved, availability.available]) {
      expect(figure).toMatch(/^-?\d+\.\d{6}$/);
    }
  });

  it('refuses a reservation the remainder cannot cover, before anything runs', () => {
    const availability = calculateAvailability({
      balance: calculateBalance({ organizationId: ORG, entries: [entry('10.000000', 'credit')] }),
      reservations: [toCreditReservation(hold({ amount: '8.000000' }))],
    });

    expect(() => {
      assertSufficient(availability, '5.000000');
    }).toThrow(InsufficientCreditsError);
  });
});

describe('expiration is deterministic', () => {
  it('depends only on the instant it is given', () => {
    const reservation = toCreditReservation(hold({ expiresAt: LATER }));

    expect(isExpired(reservation, AT)).toBe(false);
    expect(isExpired(reservation, LATER)).toBe(true);
  });

  it('never reclaims one that has already closed', () => {
    const closed = ['settled', 'released', 'expired'] as const;
    const reservations = closed.map((state) => toCreditReservation(hold({ state, expiresAt: AT })));

    expect(expiredAmong(reservations, LATER)).toEqual([]);
  });

  it('refuses a second expiry through the machine', () => {
    expect(() => assertReservationTransitionAllowed('expired', 'expire')).toThrow(HoldError);
  });

  it('never lets an expired reservation become active again', () => {
    for (const status of TERMINAL_RESERVATION_STATUSES) {
      expect(() => assertReservationTransitionAllowed(status, 'activate')).toThrow(HoldError);
    }
  });
});

// ── 3 · The ledger is untouched ─────────────────────────────────────────────

describe('the reservation layer never touches the ledger', () => {
  it('appends no entry and posts no amount', () => {
    for (const file of NEW_MODULES) {
      const code = codeOf(file);
      expect(code).not.toMatch(/appendEntry|createCreditLedgerService|LedgerEntry\b/);
      expect(code).not.toMatch(/creditGranted|creditConsumed|creditRefunded|creditAdjusted/);
    }
  });

  it('consumes nothing', () => {
    // Consumption writes a ledger debit, which is the one thing this layer must
    // not do — and the frozen service already owns it, atomically.
    for (const file of NEW_MODULES) {
      const code = codeOf(file);
      expect(code).not.toMatch(/recordConsumption|consumeReservation/);
    }
  });

  it('reads the balance rather than deriving one', () => {
    // A reservation that could change the balance would make operational state
    // financial state.
    const code = codeOf('availability.ts');
    expect(code).toMatch(/balance: LedgerBalance/);
    expect(code).not.toMatch(/calculateBalance\(/);
  });

  it('offers no ledger operation on its port', () => {
    const code = codeOf('reservation-repository.ts');
    expect(code).not.toMatch(/Ledger|entry|balance/i);
    expect(code).toMatch(/createReservation\(/);
    expect(code).toMatch(/releaseReservation\(/);
    expect(code).toMatch(/expireReservation\(/);
    expect(code).toMatch(/listReservations\(/);
  });
});

describe('the new modules depend on nothing they may not', () => {
  it('import no driver and write no SQL', () => {
    for (const file of NEW_MODULES) {
      const code = codeOf(file);
      expect(code).not.toMatch(/from '(pg|postgres|mysql2|knex|drizzle|prisma)/);
      expect(code).not.toMatch(/SELECT .+ FROM |INSERT INTO|createPool|\.query\(/i);
      expect(code).not.toMatch(/CreditsExecutor|LedgerExecutor/);
      expect(code).not.toMatch(/@contentos\/contracts/);
    }
  });

  it('import no payment SDK', () => {
    for (const file of NEW_MODULES) {
      expect(codeOf(file)).not.toMatch(/stripe|paddle|braintree|paypal|adyen/i);
    }
  });

  it('import nothing from the AI platform', () => {
    for (const file of NEW_MODULES) {
      const code = codeOf(file);
      expect(code).not.toMatch(/@contentos\/ai/);
      expect(code).not.toMatch(/provider|orchestrator|workflow|prompt/i);
    }
  });

  it('read no clock', () => {
    // A sweep and a reader that disagreed about whether a reservation had
    // expired would hold a customer's balance down invisibly.
    for (const file of NEW_MODULES) {
      expect(codeOf(file)).not.toMatch(/Date\.now\(|new Date\(|Math\.random\(|randomUUID/);
    }
  });

  it('ship a port with no implementation of it', () => {
    const code = codeOf('reservation-repository.ts');
    expect(code).toMatch(/interface CreditReservationRepository/);
    expect(code).not.toMatch(/^export (async )?function/m);
    expect(code).not.toMatch(/^export const/m);
  });
});

// ── 4 · Immutability ────────────────────────────────────────────────────────

describe('reservations are immutable', () => {
  it('are frozen through', () => {
    const reservation = toCreditReservation(hold());

    expect(Object.isFrozen(reservation)).toBe(true);
    expect(Object.isFrozen(reservation.metadata)).toBe(true);
    expect(() => {
      (reservation as { status: string }).status = 'active';
    }).toThrow();
  });

  it('so is an availability reading', () => {
    const availability = calculateAvailability({
      balance: calculateBalance({ organizationId: ORG, entries: [] }),
      reservations: [],
    });

    expect(Object.isFrozen(availability)).toBe(true);
    expect(availability.currency).toBe(LEDGER_CURRENCY);
  });
});

// ── 5 · Deviations ──────────────────────────────────────────────────────────

describe('recorded deviations', () => {
  it('DEVIATION: this increment extends the Sprint 1 hold protocol', () => {
    // A complete reservation system already existed — `holds.ts`,
    // `credits-service.ts` (authorizeSpend / settle / release / TTL sweep),
    // `credit_holds`, and the SQL availability formula in `balance.ts`.
    // Building a second one would have let the same credits be reserved twice.
    // What was missing was the transition table, a pure availability
    // calculation, and a port for readers with no database.
    expect(codeOf('reservation.ts')).toMatch(/from '\.\/holds\.js'/);
    expect(codeOf('availability.ts')).toMatch(/from '\.\/holds\.js'/);
  });

  it('DEVIATION: CREATED is a moment, not a stored value', () => {
    // A hold is born `held`. CREATED is the machine's entry point, which every
    // state machine has and no store persists; `statusToHoldState` refuses it
    // by name rather than inventing a row or a migration.
    expect(RESERVATION_STATUSES).toContain('created');
    expect(HOLD_STATES).not.toContain('created' as never);
    expect(() => statusToHoldState('created')).toThrow(HoldError);
  });

  it('DEVIATION: CONSUMED is the commercial name for `settled`', () => {
    // The increment's word for a reservation whose run finished. The stored
    // value does not change, and this increment records no consumption.
    expect(statusToHoldState('consumed')).toBe('settled');
    expect(statusOf('settled')).toBe('consumed');
  });

  it('DEVIATION: the machine throws rather than returning a refusal value', () => {
    // One error convention inside one module beats consistency with packages
    // that do not share it. `InvalidHoldState` is the existing code.
    expect(() => assertReservationTransitionAllowed('consumed', 'release')).toThrow(HoldError);
  });

  it('DEVIATION: insufficient credits reuses the frozen error', () => {
    // It already carries available, required and shortfall, and already says no
    // provider call was made. A second error would be two things to catch.
    expect(new InsufficientCreditsError('1.000000', '2.000000', '1.000000').code).toBe(
      'InsufficientCredits',
    );
  });

  it('DEVIATION: the port offers no consume, no update and no delete', () => {
    // Consumption is a ledger write and belongs to the frozen service; a
    // reservation is closed by release or expiry, never edited.
    const code = codeOf('reservation-repository.ts');
    expect(code).not.toMatch(/updateReservation|deleteReservation|consumeReservation/);
  });

  it('DEVIATION: expiry and release are separate operations', () => {
    // They mean different things to an operator: a release is a run that ended,
    // an expiry is usually a run that was lost.
    const code = codeOf('reservation-repository.ts');
    expect(code).toMatch(/releaseReservation\(/);
    expect(code).toMatch(/expireReservation\(/);

    const repository: CreditReservationRepository | null = null;
    expect(repository).toBeNull();
  });
});
