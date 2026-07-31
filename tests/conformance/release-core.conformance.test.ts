/**
 * The release core against the closure path that already exists.
 *
 * ── What only this file can check ───────────────────────────────────────────
 *
 * 1. IT IS ONE RELEASE PATH, NOT TWO. SETTLED is the S5.2 `consumed` status,
 *    which is the stored `settled` state, which is a value the database CHECK
 *    already has. No fifth state, no third vocabulary, no settlement table.
 *
 * 2. THE FOUR LAYERS COMPOSE. A ledger balance (S5.1), minus reservations
 *    (S5.2), admits a charge (S5.3), and settling (S5.4) gives back exactly
 *    what was not charged — one arithmetic story, end to end, no database.
 *
 * 3. IT COMPUTES AND NEVER WRITES. No append, no refund, no transaction, no
 *    reopen. Structural, per module.
 *
 * 4. NO PAYMENTS, NO AI, NO DATABASE, NO CLOCK.
 *
 * 5. THE DEVIATIONS, recorded so they cannot be forgotten.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  assertSettleable,
  calculateAvailability,
  calculateBalance,
  closesPermanently,
  computeSettlement,
  HoldError,
  planConsumption,
  planSettlement,
  SETTLED_STATUS,
  SETTLEMENT_STATUSES,
  statusToHoldState,
  summarizeSettlements,
  TERMINAL_RESERVATION_STATUSES,
  toCreditReservation,
  toReservationSettlement,
  toSettlementClosure,
  type CreditHold,
  type LedgerEntry,
  type SettlementCommand,
  type SettlementRepository,
} from '@contentos/platform';
import { describe, expect, it } from 'vitest';

const ORG = '018f7a1e-0000-7000-8000-0000000000aa';
const WS = '018f7a1e-0000-7000-8000-0000000000bb';
const OPENED = '2026-07-31T09:00:00.000Z';
const CLOSED = '2026-07-31T12:00:00.000Z';
const EXPIRES = '2026-08-01T09:00:00.000Z';

const creditsDir = new URL('../../packages/platform/src/credits/', import.meta.url);

const codeOf = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, creditsDir)), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

/** The modules this increment added. */
const NEW_MODULES = ['settlement.ts', 'settlement-repository.ts'] as const;

const migration = (name: string): string =>
  readFileSync(
    fileURLToPath(new URL(`../../infrastructure/migrations/${name}`, import.meta.url)),
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

const settledHold = (overrides: Partial<CreditHold> = {}): CreditHold =>
  hold({ state: 'settled', settledAt: CLOSED, ...overrides });

const entry = (overrides: Partial<LedgerEntry> = {}): LedgerEntry => ({
  id: 'entry-1',
  tenantId: ORG,
  organizationId: ORG,
  workspaceId: WS,
  entryType: 'consumption',
  amount: '4.000000',
  direction: 'debit',
  idempotencyKey: 'run-1:step-0',
  referenceEntryId: null,
  reason: 'the outline step',
  correlationId: '018f7a1e-0000-7000-8000-0000000000dd',
  createdBy: null,
  metadata: { holdId: 'hold-1', runId: 'run-1' },
  createdAt: OPENED,
  ...overrides,
});

const grant = (amount: string): LedgerEntry =>
  entry({
    id: `grant-${amount}`,
    entryType: 'grant',
    direction: 'credit',
    amount,
    workspaceId: null,
    idempotencyKey: `grant-${amount}`,
    metadata: {},
  });

const command = (overrides: Partial<SettlementCommand> = {}): SettlementCommand => ({
  organizationId: ORG,
  workspaceId: WS,
  executionId: 'run-1',
  reservationId: 'hold-1',
  settledAt: CLOSED,
  ...overrides,
});

// ── 1 · One release path, not two ───────────────────────────────────────────

describe('SETTLED is the state the system already had', () => {
  it('is the S5.2 `consumed` status, not a fifth one', () => {
    // The increment names the terminal state SETTLED; S5.2 named it CONSUMED.
    // Adding a status for the same fact would be a second reservation model.
    expect(SETTLED_STATUS).toBe('consumed');
  });

  it('maps to the stored state the DATABASE already CHECKs', () => {
    expect(statusToHoldState(SETTLED_STATUS)).toBe('settled');
    expect(migration('0022_credits_service.sql')).toContain(
      "CHECK (state IN ('held', 'settled', 'released', 'expired'))",
    );
  });

  it('covers exactly the terminal statuses of the frozen machine', () => {
    // A status added to the machine must not silently go unreportable here.
    expect([...SETTLEMENT_STATUSES].sort()).toEqual([...TERMINAL_RESERVATION_STATUSES].sort());
  });

  it('every one of them closes a reservation for good', () => {
    // "Closed reservations cannot reserve, consume or release again" — read
    // straight off the frozen transition table rather than restated.
    for (const status of SETTLEMENT_STATUSES) {
      expect(closesPermanently(status)).toBe(true);
    }
  });

  it('reads whichever timestamp column the closure CHECK guarantees', () => {
    // `(state = 'settled') = (settled_at IS NOT NULL)` and
    // `(state IN ('released','expired')) = (released_at IS NOT NULL)`.
    const sql = migration('0022_credits_service.sql');
    expect(sql).toContain("CHECK ((state = 'settled') = (settled_at IS NOT NULL))");
    expect(sql).toContain("CHECK ((state IN ('released', 'expired')) = (released_at IS NOT NULL))");

    expect(toReservationSettlement(settledHold()).settledAt).toBe(CLOSED);
    expect(toReservationSettlement(hold({ state: 'released', releasedAt: CLOSED })).settledAt).toBe(
      CLOSED,
    );
  });

  it('reuses the frozen error taxonomy rather than a second one', () => {
    for (const file of NEW_MODULES) {
      expect(codeOf(file)).not.toMatch(/class \w*Error extends/);
    }
    expect(new HoldError('SettlementMismatch', 'x').name).toBe('HoldError');
  });

  it('reuses the frozen state machine rather than restating it', () => {
    // `canTransition` is the one table that says which moves are legal; a
    // second copy could disagree about whether a settled reservation is closed.
    expect(codeOf('settlement.ts')).toMatch(/canTransition/);
  });

  it('adds no table and no migration', () => {
    for (const file of NEW_MODULES) {
      expect(codeOf(file)).not.toMatch(/CREATE TABLE|ALTER TABLE|INSERT INTO|UPDATE .+ SET /i);
    }
  });

  it('gives a settlement the reservation’s own id', () => {
    // No settlement table means no settlement id; a second id would be a second
    // thing to reconcile against the reservation.
    const settlement = toReservationSettlement(settledHold());
    expect(settlement.settlementId).toBe(settlement.reservationId);
    expect(settlement.settlementId).toBe('hold-1');
  });
});

// ── 2 · The four layers compose ─────────────────────────────────────────────

describe('ledger, reservation, consumption and settlement are one story', () => {
  it('gives back exactly what was reserved and not charged', () => {
    // 100 granted, 10 reserved → 90 available.
    const balanceBefore = calculateBalance({
      organizationId: ORG,
      entries: [grant('100.000000')],
    });
    const reservation = toCreditReservation(hold());
    const before = calculateAvailability({
      balance: balanceBefore,
      reservations: [reservation],
    });
    expect(before.available).toBe('90.000000');

    // One 4.00 charge against it.
    const charge = planConsumption({
      command: {
        organizationId: ORG,
        workspaceId: WS,
        executionId: 'run-1',
        reservationId: 'hold-1',
        amount: '4.000000',
        idempotencyKey: 'run-1:step-0',
        note: 'the outline step',
      },
      reservation,
    });
    expect(charge.remainingAfter).toBe('6.000000');

    // Settling reports 6.00 released...
    const settlement = planSettlement({
      command: command(),
      reservation: toCreditReservation(hold({ consumed: '4.000000' })),
    });
    expect(settlement.released).toBe('6.000000');

    // ...and afterwards the balance is down only the 4.00 that became a debit,
    // with nothing still held.
    const after = calculateAvailability({
      balance: calculateBalance({
        organizationId: ORG,
        entries: [grant('100.000000'), entry({ id: 'charge', amount: '4.000000' })],
      }),
      reservations: [toCreditReservation(settledHold({ consumed: '4.000000' }))],
    });

    // 90 available while held, plus the 6 the settlement released. The credits
    // came back by arithmetic, with no entry written anywhere.
    expect(after.reserved).toBe('0.000000');
    expect(after.available).toBe('96.000000');
    expect(Number(before.available) + Number(settlement.released)).toBe(Number(after.available));
  });

  it('gives back the whole reservation when nothing was charged', () => {
    const settlement = planSettlement({
      command: command(),
      reservation: toCreditReservation(hold()),
    });
    const after = calculateAvailability({
      balance: calculateBalance({ organizationId: ORG, entries: [grant('100.000000')] }),
      reservations: [toCreditReservation(settledHold())],
    });

    expect(settlement.released).toBe('10.000000');
    expect(after.available).toBe('100.000000');
  });

  it('gives back nothing when the reservation was spent to the limit', () => {
    const settlement = planSettlement({
      command: command(),
      reservation: toCreditReservation(hold({ consumed: '10.000000' })),
    });
    const after = calculateAvailability({
      balance: calculateBalance({
        organizationId: ORG,
        entries: [grant('100.000000'), entry({ id: 'charge', amount: '10.000000' })],
      }),
      reservations: [toCreditReservation(settledHold({ consumed: '10.000000' }))],
    });

    expect(settlement.released).toBe('0.000000');
    expect(settlement.usage).toBe('exhausted');
    expect(after.available).toBe('90.000000');
  });

  it('a settled reservation can no longer be charged', () => {
    // The S5.3 guard and the S5.4 guard must agree that a closed reservation is
    // closed, or a late step could charge a run that has already been billed.
    const closed = toCreditReservation(settledHold());

    expect(() => {
      assertSettleable(closed);
    }).toThrow(HoldError);
    expect(() =>
      planConsumption({
        command: {
          organizationId: ORG,
          workspaceId: WS,
          executionId: 'run-1',
          reservationId: 'hold-1',
          amount: '1.000000',
          idempotencyKey: 'run-1:late',
          note: 'a late step',
        },
        reservation: closed,
      }),
    ).toThrow(HoldError);
  });

  it('a billing period reconciles against the ledger', () => {
    const settlements = [
      toReservationSettlement(settledHold({ id: 'a', amount: '10.000000', consumed: '4.000000' })),
      toReservationSettlement(settledHold({ id: 'b', amount: '20.000000', consumed: '1.500000' })),
    ];
    const period = summarizeSettlements(settlements);
    const balance = calculateBalance({
      organizationId: ORG,
      entries: [
        grant('100.000000'),
        entry({ id: 'c1', amount: '4.000000', idempotencyKey: 'a:0' }),
        entry({ id: 'c2', amount: '1.500000', idempotencyKey: 'b:0' }),
      ],
    });

    expect(period.consumed).toBe('5.500000');
    expect(period.released).toBe('24.500000');
    // The one figure that must reconcile: settled spend IS ledger spend.
    expect(period.consumed).toBe(balance.debited);
  });
});

// ── 3 · It computes and never writes ────────────────────────────────────────

describe('the release core writes nothing', () => {
  it('appends no ledger entry', () => {
    for (const file of NEW_MODULES) {
      expect(codeOf(file)).not.toMatch(/\.append\(|createCreditLedgerService|appendEntry\(/);
    }
  });

  it('implements no refund', () => {
    // "Settlement never appends refund entries." The unspent credits were never
    // deducted; there is nothing to compensate for.
    for (const file of NEW_MODULES) {
      expect(codeOf(file)).not.toMatch(/refund/i);
    }
  });

  it('never modifies a ledger entry or a balance', () => {
    for (const file of NEW_MODULES) {
      expect(codeOf(file)).not.toMatch(
        /updateEntry|rewriteBalance|projectBalance|reconcile\(|recordGrant/,
      );
    }
  });

  it('never reopens a reservation', () => {
    // There is no edge back into `active`; an interface that could move a
    // closed reservation there would be a second reservation model.
    for (const file of NEW_MODULES) {
      expect(codeOf(file)).not.toMatch(/reopen|reactivate|'active'|unsettle/);
    }
  });

  it('offers no amendment on its port', () => {
    const code = codeOf('settlement-repository.ts');
    expect(code).not.toMatch(/updateSettlement|deleteSettlement|refundSettlement|reopenSettlement/);
    expect(code).toMatch(/settleReservation\(/);
    expect(code).toMatch(/loadSettlement\(/);
    expect(code).toMatch(/listSettlements\(/);
  });

  it('ships a port with no implementation of it', () => {
    const code = codeOf('settlement-repository.ts');
    expect(code).toMatch(/interface SettlementRepository/);
    expect(code).not.toMatch(/^export (async )?function/m);
    expect(code).not.toMatch(/^export const/m);
  });

  it('takes a settlement the guards already produced, not a raw command', () => {
    // Validation happens before the store is reached, so an implementation
    // cannot be handed a settlement the guards would have refused.
    const repository: SettlementRepository | null = null;
    expect(repository).toBeNull();
    expect(codeOf('settlement-repository.ts')).toMatch(
      /settleReservation\(settlement: ReservationSettlement\)/,
    );
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
      expect(codeOf(file)).not.toMatch(/stripe|paddle|braintree|paypal|adyen|invoice|tax|webhook/i);
    }
  });

  it('import nothing from the AI platform', () => {
    for (const file of NEW_MODULES) {
      const code = codeOf(file);
      expect(code).not.toMatch(/@contentos\/ai/);
      expect(code).not.toMatch(/provider|orchestrat|workflow|prompt|model|token/i);
    }
  });

  it('read no clock and generate no ids', () => {
    // `settledAt` is supplied. A store that timestamped its own settlement
    // would make two readers disagree about the billing period.
    for (const file of NEW_MODULES) {
      expect(codeOf(file)).not.toMatch(/Date\.now\(|new Date\(|Math\.random\(|randomUUID|secureId/);
    }
  });

  it('use no float anywhere in the money path', () => {
    for (const file of NEW_MODULES) {
      expect(codeOf(file)).not.toMatch(/parseFloat|Number\(|toFixed|\* 100|\/ 100/);
    }
  });
});

// ── 4 · Determinism ─────────────────────────────────────────────────────────

describe('a settlement is the same settlement twice', () => {
  it('plans identically from identical inputs', () => {
    const reservation = toCreditReservation(hold({ consumed: '4.000000' }));

    expect(planSettlement({ command: command(), reservation })).toEqual(
      planSettlement({ command: command(), reservation }),
    );
  });

  it('reports the same figures from the plan and from the stored row', () => {
    // The pure path and the stored path must agree, or a customer sees one
    // number before the run ends and another after.
    expect(
      planSettlement({
        command: command(),
        reservation: toCreditReservation(hold({ consumed: '4.000000' })),
      }),
    ).toEqual(toReservationSettlement(settledHold({ consumed: '4.000000' })));
  });

  it('freezes everything it returns', () => {
    const settlement = toReservationSettlement(settledHold());
    const closure = toSettlementClosure({ hold: settledHold(), converged: false });

    expect(Object.isFrozen(settlement)).toBe(true);
    expect(Object.isFrozen(closure)).toBe(true);
    expect(Object.isFrozen(closure.settlement)).toBe(true);
    expect(Object.isFrozen(computeSettlement({ reserved: '1.000000', consumed: '0.000000' }))).toBe(
      true,
    );
  });
});

// ── 5 · Deviations ──────────────────────────────────────────────────────────

describe('recorded deviations', () => {
  it('DEVIATION: this increment extends the Sprint 1 closure path', () => {
    // `settle()` already closes atomically and guards the transition inside the
    // UPDATE. What was missing was the arithmetic as a function, the projection,
    // and a port for readers with no database.
    expect(codeOf('credits-service.ts')).toMatch(/SET state = 'settled'/);
    expect(codeOf('credits-service.ts')).toMatch(/AND state = 'held'/);
    expect(codeOf('settlement.ts')).toMatch(/from '\.\/reservation\.js'/);
  });

  it('DEVIATION: SETTLED is a narrowing of the S5.2 vocabulary', () => {
    expect(codeOf('settlement.ts')).toMatch(
      /Extract<ReservationStatus, 'consumed' \| 'released' \| 'expired'>/,
    );
  });

  it('DEVIATION: a settlement describes releases and expiries too', () => {
    // The increment describes the settle path. A report that could not describe
    // the other two ways a reservation closes would send every reader back to
    // the hold table — and the arithmetic is identical.
    expect(toReservationSettlement(hold({ state: 'released', releasedAt: CLOSED })).status).toBe(
      'released',
    );
    expect(toReservationSettlement(hold({ state: 'expired', releasedAt: CLOSED })).status).toBe(
      'expired',
    );
  });

  it('DEVIATION: the guard rejects, and the service still converges', () => {
    // "Reject: already settled reservation" is the guard's job. The frozen
    // service reports a retried settle as `converged` and must keep doing so —
    // failing an orchestrator's retry would turn every retry into an incident.
    expect(() => {
      assertSettleable(toCreditReservation(settledHold()));
    }).toThrow(HoldError);
    expect(toSettlementClosure({ hold: settledHold(), converged: true }).outcome).toBe('converged');
  });

  it('DEVIATION: a settle that met a release is reported as diverged', () => {
    // The frozen service reports this only as `converged: true`. It is not an
    // ordinary retry: two deciders disagreed about how the run ended.
    expect(
      toSettlementClosure({
        hold: hold({ state: 'released', releasedAt: CLOSED }),
        converged: true,
      }).outcome,
    ).toBe('diverged');
  });

  it('DEVIATION: `SettlementMismatch` is a new error code', () => {
    // Beside `ConsumptionMismatch` rather than folded into it: a charge is
    // filed by a workflow step and a settlement by the orchestrator at the end
    // of a run, so they page different people.
    expect(codeOf('holds.ts')).toMatch(/'SettlementMismatch'/);
    expect(
      (() => {
        try {
          planSettlement({
            command: command({ workspaceId: 'other' }),
            reservation: toCreditReservation(hold()),
          });
          return null;
        } catch (error) {
          return error instanceof HoldError ? error.code : null;
        }
      })(),
    ).toBe('SettlementMismatch');
  });

  it('DEVIATION: usage metering is not imported, because it cannot be', () => {
    // The increment lists Usage Metering as a reuse. It lives in `packages/ai`,
    // a sibling feature package, and dependency-cruiser forbids feature→feature
    // imports. Nothing here needs it: settlement is arithmetic over amounts the
    // ledger already recorded.
    for (const file of NEW_MODULES) {
      expect(codeOf(file)).not.toMatch(/@contentos\/ai/);
    }
  });

  it('DEVIATION: the guards throw rather than returning refusal values', () => {
    // One error convention inside one module, matching S5.1–S5.3.
    expect(() => planSettlement({ command: command(), reservation: null })).toThrow(HoldError);
  });
});
