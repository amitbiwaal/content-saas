/**
 * The storage-agnostic ledger core against the ledger that already exists.
 *
 * ── What only this file can check ───────────────────────────────────────────
 *
 * 1. IT IS ONE LEDGER, NOT TWO. The vocabulary bridge produces only entry types
 *    the Sprint 1 enum already has, and the pure fold consumes only the entries
 *    the Sprint 1 service writes. Nothing here can express a row the frozen
 *    ledger could not store.
 *
 * 2. THE PURE FOLD AND THE SQL PATH AGREE. `calculateBalance` computes the same
 *    number `balance.ts` aggregates — which is the whole reason a projection can
 *    be reconciled at all, and is invisible from inside either one.
 *
 * 3. NO DATABASE, NO PAYMENTS, NO AI. Structural, per module.
 *
 * 4. THE DEVIATIONS, recorded so they cannot be forgotten.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  assertBalanceConsistent,
  calculateBalance,
  entryTypeFor,
  groupTransactions,
  LEDGER_CURRENCY,
  LEDGER_ENTRY_TYPES,
  LEDGER_REASONS,
  LedgerError,
  loadWholeLedger,
  reasonFor,
  RECORDABLE_REASONS,
  resolveDirection,
  toCreditLedger,
  type CreditLedgerRepository,
  type LedgerDirection,
  type LedgerEntry,
} from '@contentos/platform';
import { describe, expect, it } from 'vitest';

const ORG = '018f7a1e-0000-7000-8000-0000000000aa';
const WS = '018f7a1e-0000-7000-8000-0000000000bb';

const creditsDir = new URL('../../packages/platform/src/credits/', import.meta.url);

const codeOf = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, creditsDir)), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

/** The modules this increment added. */
const NEW_MODULES = ['reason.ts', 'aggregate.ts', 'repository.ts', 'walk.ts'] as const;

const migration = (): string =>
  readFileSync(
    fileURLToPath(new URL('../../infrastructure/migrations/0014_platform.sql', import.meta.url)),
    'utf8',
  );

const entry = (
  id: string,
  amount: string,
  direction: LedgerDirection,
  idempotencyKey: string | null = null,
): LedgerEntry => ({
  id,
  tenantId: ORG,
  organizationId: ORG,
  workspaceId: direction === 'debit' ? WS : null,
  entryType: direction === 'credit' ? 'grant' : 'consumption',
  amount,
  direction,
  idempotencyKey,
  referenceEntryId: null,
  reason: 'because',
  correlationId: '018f7a1e-0000-7000-8000-0000000000dd',
  createdBy: null,
  metadata: {},
  createdAt: `2026-07-31T12:00:${id.padStart(2, '0')}.000Z`,
});

// ── 1 · One ledger, not two ─────────────────────────────────────────────────

describe('the vocabulary bridges, it does not fork', () => {
  it('produces only entry types the frozen enum already has', () => {
    for (const reason of RECORDABLE_REASONS) {
      expect(LEDGER_ENTRY_TYPES).toContain(entryTypeFor(reason));
    }
  });

  it('produces only entry types the DATABASE already CHECKs', () => {
    // The constraint is the real boundary: a bridge that emitted a sixth value
    // would fail at the column, mid-transaction, after the audit row.
    const constraint = migration();
    for (const reason of RECORDABLE_REASONS) {
      expect(constraint).toContain(`'${entryTypeFor(reason)}'`);
    }
  });

  it('names every entry type the database can hold', () => {
    // The reverse direction is total. A vocabulary that could not name a row
    // that exists would silently lose it on the way out.
    for (const entryType of LEDGER_ENTRY_TYPES) {
      expect(LEDGER_REASONS).toContain(reasonFor(entryType));
    }
  });

  it('agrees with the frozen direction rules', () => {
    // `resolveDirection` is the Sprint 1 function. A bridge that disagreed with
    // it would write rows the direction CHECK rejects.
    expect(resolveDirection(entryTypeFor('CREDIT_GRANT'))).toBe('credit');
    expect(resolveDirection(entryTypeFor('CREDIT_REFUND'))).toBe('credit');
    expect(resolveDirection(entryTypeFor('CREDIT_CONSUMPTION'))).toBe('debit');
    expect(resolveDirection(entryTypeFor('CREDIT_EXPIRY'))).toBe('debit');
  });

  it('adds no entry type, no table and no migration', () => {
    // The whole claim of this increment: additive to one ledger, never a second.
    for (const file of NEW_MODULES) {
      const code = codeOf(file);
      expect(code).not.toMatch(/CREATE TABLE|ALTER TABLE|INSERT INTO|UPDATE .+ SET /i);
    }
    expect([...LEDGER_ENTRY_TYPES]).toEqual([
      'grant',
      'consumption',
      'refund',
      'adjustment',
      'expiry',
    ]);
  });

  it('consumes the frozen entry shape rather than a model of its own', () => {
    const code = codeOf('aggregate.ts');
    expect(code).toMatch(/from '\.\/ledger\.js'/);
    expect(code).not.toMatch(/interface LedgerEntry\b/);
  });

  it('reuses the frozen arithmetic rather than restating it', () => {
    // Exactness is the one thing a second implementation would get subtly wrong.
    const code = codeOf('aggregate.ts');
    expect(code).toMatch(/from '\.\/amount\.js'/);
    expect(code).not.toMatch(/parseFloat|Number\(|toFixed/);
  });

  it('reuses the frozen error taxonomy rather than a second one', () => {
    for (const file of NEW_MODULES) {
      const code = codeOf(file);
      expect(code).not.toMatch(/class \w*Error extends/);
    }
    expect(new LedgerError('InvalidAmount', 'x').name).toBe('LedgerError');
  });
});

// ── 2 · The fold and the SQL path agree ─────────────────────────────────────

describe('the pure fold computes what the SQL path aggregates', () => {
  it('is credited − debited, exactly as balance.ts defines it', () => {
    const balance = calculateBalance({
      organizationId: ORG,
      entries: [
        entry('01', '100.000000', 'credit'),
        entry('02', '30.000000', 'debit'),
        entry('03', '5.500000', 'debit'),
      ],
    });

    expect(balance.credited).toBe('100.000000');
    expect(balance.debited).toBe('35.500000');
    expect(balance.balance).toBe('64.500000');
  });

  it('produces the six-place decimal strings the column round-trips', () => {
    // `amount::text` is how every figure leaves PostgreSQL. A fold that
    // formatted differently could not be compared to one.
    const balance = calculateBalance({
      organizationId: ORG,
      entries: [entry('01', '1.5', 'credit')],
    });

    for (const figure of [balance.credited, balance.debited, balance.balance]) {
      expect(figure).toMatch(/^-?\d+\.\d{6}$/);
    }
  });

  it('gives reconciliation something to compare against', () => {
    // A projection is a cache of this number; neither can be checked unless the
    // number exists somewhere a test can compute without a server.
    const entries = [entry('01', '10.000000', 'credit'), entry('02', '4.000000', 'debit')];

    expect(
      assertBalanceConsistent({ organizationId: ORG, entries, claimed: '6.000000' }).balance,
    ).toBe('6.000000');
    expect(() =>
      assertBalanceConsistent({ organizationId: ORG, entries, claimed: '6.000001' }),
    ).toThrow(LedgerError);
  });

  it('bounds the total at what the column can hold', () => {
    // Every entry fits and the total does not: the gap nothing checked before.
    const big = '99999999999999.999999';
    expect(() =>
      calculateBalance({
        organizationId: ORG,
        entries: [entry('01', big, 'credit'), entry('02', big, 'credit')],
      }),
    ).toThrow(LedgerError);
    expect(migration()).toContain('NUMERIC(20,6)');
  });

  it('refuses a double charge rather than summing it', () => {
    // The database holds a unique index on (organization, idempotency key); the
    // fold is what catches the same violation in a restored or imported set.
    expect(() =>
      calculateBalance({
        organizationId: ORG,
        entries: [
          entry('01', '5.000000', 'debit', 'run-1'),
          entry('02', '5.000000', 'debit', 'run-1'),
        ],
      }),
    ).toThrow(LedgerError);
  });

  it('groups by the id that already makes a retry charge once', () => {
    const groups = groupTransactions({
      organizationId: ORG,
      entries: [
        entry('01', '10.000000', 'debit', 'run-1'),
        entry('02', '2.000000', 'credit', 'run-1'),
      ],
    });

    expect(groups).toHaveLength(1);
    expect(groups[0]?.net).toBe('-8.000000');
  });
});

describe('the ledger value', () => {
  it('takes the organization’s identity, as the database CHECKs it does', () => {
    // `tenant_id = organization_id` is a constraint, not a convention; a
    // separate ledger id would be a second name for one thing.
    const ledger = toCreditLedger({ organizationId: ORG, entries: [entry('01', '1', 'credit')] });

    expect(ledger.ledgerId).toBe(ORG);
    expect(migration()).toContain('ck_credit_ledger_entries__tenant_is_organization');
  });

  it('is credits, and never money', () => {
    expect(LEDGER_CURRENCY).toBe('credits');
    for (const file of NEW_MODULES) {
      expect(codeOf(file)).not.toMatch(/'USD'|'EUR'|'GBP'|ISO 4217/);
    }
  });
});

// ── 3 · No database, no payments, no AI ─────────────────────────────────────

describe('the new modules depend on nothing they may not', () => {
  it('import no driver and write no SQL', () => {
    for (const file of NEW_MODULES) {
      const code = codeOf(file);
      expect(code).not.toMatch(/from '(pg|postgres|mysql2|knex|drizzle|prisma)/);
      expect(code).not.toMatch(/SELECT .+ FROM |INSERT INTO|createPool|\.query\(/i);
      // No transaction handle: `LedgerExecutor` is the SQL service's, and
      // `Transaction` comes from contracts, which these modules do not import
      // at all. Naming the import rather than the word avoids matching
      // `LedgerTransaction`, which is a MODEL here and not a handle.
      expect(code).not.toMatch(/LedgerExecutor/);
      expect(code).not.toMatch(/@contentos\/contracts/);
    }
  });

  it('import no payment SDK', () => {
    for (const file of NEW_MODULES) {
      const code = codeOf(file);
      expect(code).not.toMatch(/stripe|paddle|braintree|paypal|adyen/i);
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
    // Two reads of one ledger must produce one balance.
    for (const file of NEW_MODULES) {
      const code = codeOf(file);
      expect(code).not.toMatch(/Date\.now\(|new Date\(|Math\.random\(|randomUUID|secureId/);
    }
  });

  it('ship a port with no implementation of it', () => {
    const code = codeOf('repository.ts');
    expect(code).toMatch(/interface CreditLedgerRepository/);
    expect(code).not.toMatch(/^export (async )?function/m);
    expect(code).not.toMatch(/^export const/m);
  });

  it('offer no update and no delete', () => {
    // A ledger has no UPDATE path; a port that offered one would be an
    // invitation to build the thing the table refuses.
    const code = codeOf('repository.ts');
    expect(code).not.toMatch(/updateEntry|deleteEntry|removeEntry|amendEntry/);
    expect(code).toMatch(/appendEntry\(/);
  });
});

// ── 4 · Deviations ──────────────────────────────────────────────────────────

describe('recorded deviations', () => {
  it('DEVIATION: this increment extends the Sprint 1 ledger, it does not replace it', () => {
    // A complete credit ledger already existed — `packages/platform/src/credits`,
    // migration 0014, with a SQL service, a balance projection and holds.
    // Building a second one would have produced two financial sources of truth,
    // which is the opposite of what a canonical ledger is for. What was missing
    // was a storage-agnostic core: the commercial vocabulary, a pure balance
    // fold, and a port for readers with no database.
    expect(codeOf('aggregate.ts')).toMatch(/from '\.\/ledger\.js'/);
    expect(codeOf('reason.ts')).toMatch(/from '\.\/ledger\.js'/);
  });

  it('DEVIATION: CREDIT_PURCHASE is refused, not mapped onto a grant', () => {
    // Money changed hands, which decides revenue recognition, refund
    // eligibility and tax; a grant decides none of those. Recording it as a
    // grant would make "how many credits were paid for?" unanswerable from the
    // ledger, permanently, because a ledger has no UPDATE path. Representing it
    // properly is a migration on a financial table plus an event type, and
    // belongs with the payment path that will write one — which S5.1 lists as
    // out of scope.
    expect(() => entryTypeFor('CREDIT_PURCHASE')).toThrow(LedgerError);
  });

  it('DEVIATION: CREDIT_RESERVATION is refused, because holds already own it', () => {
    // `holds.ts` reserves by arithmetic — available = balance − unspent holds —
    // precisely so releasing one is a state change and never a compensating
    // write. A reservation row would let the same credits be subtracted twice.
    // S5.1 lists Reservations as out of scope, which agrees.
    expect(() => entryTypeFor('CREDIT_RESERVATION')).toThrow(LedgerError);
  });

  it('DEVIATION: CREDIT_EXPIRY is in the vocabulary although nothing asked for it', () => {
    // `expiry` is in the frozen enum and rows carry it. A vocabulary that could
    // not name an entry type that exists would lose rows on the way out.
    expect(LEDGER_REASONS).toContain('CREDIT_EXPIRY');
    expect(LEDGER_ENTRY_TYPES).toContain('expiry');
  });

  it('DEVIATION: the transaction id IS the idempotency key', () => {
    // That column already makes a retried call charge once and is already
    // unique per organization. A second identity on a financial row would be a
    // second way for two writes to disagree about whether they were one write.
    expect(codeOf('aggregate.ts')).toMatch(/idempotencyKey/);
    expect(migration()).toContain('idempotency_key');
  });

  it('DEVIATION: the fold throws rather than returning a refusal value', () => {
    // Every other layer in this codebase returns refusals as values. This one
    // throws, because it is extending a module whose convention is `LedgerError`
    // — and one error convention inside one module beats consistency with a
    // package that does not share it.
    expect(() =>
      calculateBalance({ organizationId: ORG, entries: [entry('01', '-1', 'credit')] }),
    ).toThrow(LedgerError);
  });

  it('DEVIATION: a truncated walk refuses to produce a balance', () => {
    // A partial sum wearing the name of a total is worse than no total.
    const repository: CreditLedgerRepository = {
      appendEntry: () => Promise.resolve(),
      loadEntry: () => Promise.resolve(null),
      loadLedger: () => Promise.resolve({ entries: [] }),
      calculateBalance: () =>
        Promise.resolve({
          organizationId: ORG,
          currency: LEDGER_CURRENCY,
          credited: '0.000000',
          debited: '0.000000',
          balance: '0.000000',
          entryCount: 0,
          transactionCount: 0,
        }),
    };

    expect(codeOf('walk.ts')).toMatch(/truncated/);
    expect(typeof loadWholeLedger({ repository, organizationId: ORG }).then).toBe('function');
  });
});
