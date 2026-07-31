/**
 * The settlement core against the consumption path that already exists.
 *
 * ── What only this file can check ───────────────────────────────────────────
 *
 * 1. IT IS ONE CONSUMPTION PATH, NOT TWO. The plan describes exactly the entry
 *    the frozen `recordConsumption` writes — one `consumption` row, of a type
 *    the database CHECK already has, carrying the metadata the frozen service
 *    already records.
 *
 * 2. THE THREE LAYERS COMPOSE. A ledger balance (S5.1), minus reservations
 *    (S5.2), admits a settlement (S5.3) whose charge then shows up in the
 *    balance — one arithmetic story, end to end, with no database in it.
 *
 * 3. IT PLANS AND NEVER WRITES. No append, no update, no transaction, no
 *    refund. Structural, per module.
 *
 * 4. NO PAYMENTS, NO AI, NO DATABASE.
 *
 * 5. THE DEVIATIONS, recorded so they cannot be forgotten.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  assertConsumable,
  assertSufficient,
  calculateAvailability,
  calculateBalance,
  CONSUMPTION_REASON,
  entryTypeFor,
  hasSufficient,
  HoldError,
  LEDGER_ENTRY_TYPES,
  planConsumption,
  toCreditConsumption,
  toCreditReservation,
  toSettlementResult,
  type ConsumptionCommand,
  type ConsumptionRepository,
  type CreditHold,
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
const NEW_MODULES = ['consumption.ts', 'consumption-repository.ts'] as const;

const ledgerMigration = (): string =>
  readFileSync(
    fileURLToPath(new URL('../../infrastructure/migrations/0014_platform.sql', import.meta.url)),
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

/** A grant, with its own transaction id: the fold refuses a reused one. */
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

// ── 1 · One consumption path, not two ───────────────────────────────────────

describe('the plan describes the entry the frozen service writes', () => {
  it('records the entry type the S5.1 vocabulary names', () => {
    const plan = planConsumption({ command: command(), reservation: toCreditReservation(hold()) });

    expect(plan.reason).toBe(CONSUMPTION_REASON);
    expect(entryTypeFor(plan.reason)).toBe('consumption');
  });

  it('records a type the DATABASE already CHECKs', () => {
    // A plan that named a fifth entry type would fail at the column,
    // mid-transaction, after the audit row.
    expect(ledgerMigration()).toContain(`'${entryTypeFor(CONSUMPTION_REASON)}'`);
    expect(LEDGER_ENTRY_TYPES).toContain('consumption');
  });

  it('names exactly one entry, never a batch', () => {
    const plan = planConsumption({ command: command(), reservation: toCreditReservation(hold()) });

    expect(plan.amount).toBe('4.000000');
    expect(Array.isArray(plan)).toBe(false);
  });

  it('reads back the metadata the frozen service records', () => {
    // `recordConsumption` writes `{ holdId, runId }` onto every consumption
    // entry; this reads exactly those, so the two cannot drift.
    const consumption = toCreditConsumption(entry());

    expect(consumption.reservationId).toBe('hold-1');
    expect(consumption.executionId).toBe('run-1');
    expect(codeOf('credits-service.ts')).toMatch(/holdId: hold\.id, runId: hold\.runId/);
  });

  it('reuses the frozen bound rather than restating it', () => {
    // "Does this charge fit inside its reservation" is the rule that makes a
    // reservation a real ceiling; a second implementation could disagree.
    const code = codeOf('consumption.ts');
    expect(code).toMatch(/assertFitsWithinHold/);
    expect(code).not.toMatch(/parseFloat|Number\(|toFixed/);
  });

  it('reuses the frozen error taxonomy rather than a second one', () => {
    for (const file of NEW_MODULES) {
      expect(codeOf(file)).not.toMatch(/class \w*Error extends/);
    }
    expect(new HoldError('ConsumptionMismatch', 'x').name).toBe('HoldError');
  });

  it('adds no table and no migration', () => {
    for (const file of NEW_MODULES) {
      expect(codeOf(file)).not.toMatch(/CREATE TABLE|ALTER TABLE|INSERT INTO|UPDATE .+ SET /i);
    }
  });
});

// ── 2 · The three layers compose ────────────────────────────────────────────

describe('ledger, reservation and settlement are one arithmetic story', () => {
  it('admits a settlement the availability covers, and reflects it afterwards', () => {
    // Before: 100 granted, 30 reserved → 70 available.
    const before = calculateBalance({
      organizationId: ORG,
      entries: [grant('100.000000')],
    });
    const reservation = toCreditReservation(hold({ amount: '30.000000' }));
    const availability = calculateAvailability({ balance: before, reservations: [reservation] });

    expect(availability.available).toBe('70.000000');
    expect(hasSufficient(availability, '30.000000')).toBe(true);

    // The charge fits inside the reservation, so it needs no new availability.
    const plan = planConsumption({
      command: command({ amount: '20.000000' }),
      reservation,
    });
    expect(plan.remainingAfter).toBe('10.000000');

    // After: the charge is a ledger debit, and the reservation holds less down.
    const after = calculateBalance({
      organizationId: ORG,
      entries: [grant('100.000000'), entry({ id: 'charge', amount: '20.000000' })],
    });
    const settled = calculateAvailability({
      balance: after,
      reservations: [toCreditReservation(hold({ amount: '30.000000', consumed: '20.000000' }))],
    });

    expect(after.balance).toBe('80.000000');
    expect(settled.reserved).toBe('10.000000');
    // 80 − 10: the charge was subtracted once, as a debit, and the reservation
    // stopped holding down the part that has already been spent.
    expect(settled.available).toBe('70.000000');
  });

  it('never subtracts a charge twice', () => {
    // The `− consumed` rule, checked end to end: a fully consumed reservation
    // holds nothing down, and the balance carries the whole charge.
    const balance = calculateBalance({
      organizationId: ORG,
      entries: [grant('100.000000'), entry({ id: 'charge', amount: '30.000000' })],
    });
    const availability = calculateAvailability({
      balance,
      reservations: [toCreditReservation(hold({ amount: '30.000000', consumed: '30.000000' }))],
    });

    expect(availability.available).toBe('70.000000');
  });

  it('refuses a reservation the availability cannot cover, before anything runs', () => {
    const availability = calculateAvailability({
      balance: calculateBalance({
        organizationId: ORG,
        entries: [grant('10.000000')],
      }),
      reservations: [toCreditReservation(hold({ amount: '8.000000' }))],
    });

    expect(() => {
      assertSufficient(availability, '5.000000');
    }).toThrow(HoldError);
  });
});

// ── 3 · It plans and never writes ───────────────────────────────────────────

describe('the settlement core writes nothing', () => {
  it('appends no ledger entry', () => {
    for (const file of NEW_MODULES) {
      const code = codeOf(file);
      expect(code).not.toMatch(/\.append\(|createCreditLedgerService|appendEntry\(/);
    }
  });

  it('never updates or rewrites anything', () => {
    // A ledger has no UPDATE path; a mistake is corrected by a compensating
    // entry, which is a different operation in a different increment.
    for (const file of NEW_MODULES) {
      const code = codeOf(file);
      expect(code).not.toMatch(/updateEntry|rewriteBalance|projectBalance|reconcile\(/);
    }
  });

  it('implements no refund', () => {
    for (const file of NEW_MODULES) {
      const code = codeOf(file);
      expect(code).not.toMatch(/refund/i);
    }
  });

  it('releases nothing', () => {
    // Reservation release is out of scope and already belongs to the frozen
    // service.
    for (const file of NEW_MODULES) {
      expect(codeOf(file)).not.toMatch(/releaseReservation|releaseOpenHolds|expireStaleHolds/);
    }
  });

  it('offers no amendment on its port', () => {
    const code = codeOf('consumption-repository.ts');
    expect(code).not.toMatch(/updateConsumption|deleteConsumption|refundConsumption/);
    expect(code).toMatch(/recordConsumption\(/);
    expect(code).toMatch(/loadConsumption\(/);
    expect(code).toMatch(/listConsumption\(/);
  });

  it('ships a port with no implementation of it', () => {
    const code = codeOf('consumption-repository.ts');
    expect(code).toMatch(/interface ConsumptionRepository/);
    expect(code).not.toMatch(/^export (async )?function/m);
    expect(code).not.toMatch(/^export const/m);
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
      expect(codeOf(file)).not.toMatch(/stripe|paddle|braintree|paypal|adyen|invoice|tax/i);
    }
  });

  it('import nothing from the AI platform', () => {
    for (const file of NEW_MODULES) {
      const code = codeOf(file);
      expect(code).not.toMatch(/@contentos\/ai/);
      expect(code).not.toMatch(/provider|orchestrator|workflow|prompt/i);
    }
  });

  it('read no clock and generate no ids', () => {
    // The consumption id is the ledger entry's, and a plan must be the same
    // plan twice.
    for (const file of NEW_MODULES) {
      expect(codeOf(file)).not.toMatch(/Date\.now\(|new Date\(|Math\.random\(|randomUUID|secureId/);
    }
  });
});

// ── 4 · Idempotency and immutability ────────────────────────────────────────

describe('idempotency', () => {
  it('requires a key, because an unkeyed charge cannot converge', () => {
    expect(() =>
      planConsumption({
        command: command({ idempotencyKey: '' }),
        reservation: toCreditReservation(hold()),
      }),
    ).toThrow(HoldError);
  });

  it('carries the key through to what would be written', () => {
    expect(
      planConsumption({ command: command(), reservation: toCreditReservation(hold()) })
        .idempotencyKey,
    ).toBe('run-1:step-1');
  });

  it('reports a converged retry as success, not as a duplicate error', () => {
    // Reporting it as an error would turn every Temporal retry into an
    // incident; the frozen service returns `created: false` for exactly this.
    const result = toSettlementResult({ entry: entry(), hold: hold(), created: false });

    expect(result.outcome).toBe('converged');
    expect(result.consumption.consumptionId).toBe('entry-1');
  });

  it('is backed by the ledger’s own unique index', () => {
    // The single source of truth for "did this happen" — which is why the
    // frozen service advances `consumed` from the result, not the request.
    expect(codeOf('credits-service.ts')).toMatch(/findByIdempotencyKey/);
    expect(ledgerMigration()).toContain('idempotency_key');
  });
});

describe('immutability', () => {
  it('freezes a consumption through', () => {
    const consumption = toCreditConsumption(entry());

    expect(Object.isFrozen(consumption)).toBe(true);
    expect(() => {
      (consumption as { amount: string }).amount = '999.000000';
    }).toThrow();
  });

  it('freezes a plan and a result through', () => {
    const plan = planConsumption({ command: command(), reservation: toCreditReservation(hold()) });
    const result = toSettlementResult({ entry: entry(), hold: hold(), created: true });

    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.reservation)).toBe(true);
  });

  it('leaves a consumed reservation terminal', () => {
    const result = toSettlementResult({
      entry: entry(),
      hold: hold({ state: 'settled', consumed: '10.000000' }),
      created: true,
    });

    expect(result.reservation.status).toBe('consumed');
    expect(() => {
      assertConsumable(result.reservation);
    }).toThrow(HoldError);
  });
});

// ── 5 · Deviations ──────────────────────────────────────────────────────────

describe('recorded deviations', () => {
  it('DEVIATION: this increment extends the Sprint 1 consumption path', () => {
    // `recordConsumption` already settles atomically — row lock, idempotency
    // convergence, ledger-append-decides, `consumed` advanced from the result.
    // What was missing was the pipeline as a function, the commercial
    // projection, and a port for readers with no database.
    expect(codeOf('consumption.ts')).toMatch(/from '\.\/holds\.js'/);
    expect(codeOf('consumption.ts')).toMatch(/from '\.\/reservation\.js'/);
  });

  it('DEVIATION: the outcome is `SettlementResult`, not `ConsumptionResult`', () => {
    // `ConsumptionResult` is already exported by the frozen service for its own
    // richer shape (entry, hold, created, events, projection). Redefining it
    // would break every existing caller; this projects it instead.
    expect(codeOf('credits-service.ts')).toMatch(/interface ConsumptionResult/);
    expect(codeOf('consumption.ts')).toMatch(/type SettlementResult/);
    expect(codeOf('consumption.ts')).not.toMatch(/interface ConsumptionResult/);
  });

  it('DEVIATION: `ConsumptionReason` is a narrowing, not a third vocabulary', () => {
    // A consumption entry carries exactly one reason. Expressing that as a type
    // means a projection cannot claim a consumption that records a grant; a new
    // enum would be a third vocabulary for one fact.
    expect(codeOf('consumption.ts')).toMatch(/Extract<LedgerReason, 'CREDIT_CONSUMPTION'>/);
    expect(CONSUMPTION_REASON).toBe('CREDIT_CONSUMPTION');
  });

  it('DEVIATION: one consumption does not close its reservation', () => {
    // A run charges per step and settles once at the end: `recordConsumption`
    // advances `consumed`, `settle` closes the hold. The increment's pipeline
    // reads as one-charge-then-terminal, which a multi-step workflow — the
    // ordinary case here — could not express.
    const plan = planConsumption({
      command: command({ amount: '4.000000' }),
      reservation: toCreditReservation(hold()),
    });

    expect(plan.exhausts).toBe(false);
    expect(plan.remainingAfter).toBe('6.000000');
  });

  it('DEVIATION: `ConsumptionMismatch` is a new error code', () => {
    // Identifiers that disagree with the reservation are a different mistake
    // from a bad state: the reservation is fine, and the caller is about to
    // bill the wrong client in a table with no UPDATE path.
    expect(codeOf('holds.ts')).toMatch(/'ConsumptionMismatch'/);
  });

  it('DEVIATION: the guards throw rather than returning refusal values', () => {
    // One error convention inside one module beats consistency with packages
    // that do not share it.
    expect(() => planConsumption({ command: command(), reservation: null })).toThrow(HoldError);
  });

  it('DEVIATION: the port takes a PLAN, not a command', () => {
    // Validation happens before the store is reached, so an implementation
    // cannot be handed a settlement the guards would have refused.
    const repository: ConsumptionRepository | null = null;
    expect(repository).toBeNull();
    expect(codeOf('consumption-repository.ts')).toMatch(
      /recordConsumption\(plan: SettlementPlan\)/,
    );
  });
});
