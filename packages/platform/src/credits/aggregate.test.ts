import { describe, expect, it } from 'vitest';

import {
  assertBalanceConsistent,
  calculateBalance,
  groupTransactions,
  LEDGER_CURRENCY,
  MAX_SCALED_BALANCE,
  reasonsOf,
  toCreditLedger,
} from './aggregate.js';
import {
  LedgerError,
  type LedgerDirection,
  type LedgerEntry,
  type LedgerEntryType,
} from './ledger.js';

const ORG = '018f7a1e-0000-7000-8000-0000000000aa';
const WS = '018f7a1e-0000-7000-8000-0000000000bb';
const AT = '2026-07-31T12:00:00.000Z';

interface Shape {
  readonly id: string;
  readonly amount: string;
  readonly direction: LedgerDirection;
  readonly entryType?: LedgerEntryType;
  readonly idempotencyKey?: string | null;
  readonly organizationId?: string;
}

const entry = (shape: Shape): LedgerEntry => ({
  id: shape.id,
  tenantId: shape.organizationId ?? ORG,
  organizationId: shape.organizationId ?? ORG,
  workspaceId: shape.direction === 'debit' ? WS : null,
  entryType: shape.entryType ?? (shape.direction === 'credit' ? 'grant' : 'consumption'),
  amount: shape.amount,
  direction: shape.direction,
  idempotencyKey: shape.idempotencyKey === undefined ? null : shape.idempotencyKey,
  referenceEntryId: null,
  reason: 'because',
  correlationId: '018f7a1e-0000-7000-8000-0000000000dd',
  createdBy: null,
  metadata: {},
  createdAt: AT,
});

const codeOf = (run: () => unknown): string | null => {
  try {
    run();
    return null;
  } catch (failure) {
    return failure instanceof LedgerError ? failure.code : 'not-a-ledger-error';
  }
};

const balanceOf = (entries: readonly LedgerEntry[]): string =>
  calculateBalance({ organizationId: ORG, entries }).balance;

// ── The invariant ───────────────────────────────────────────────────────────

describe('balance is the sum of the entries', () => {
  it('is zero for a ledger with no history', () => {
    expect(calculateBalance({ organizationId: ORG, entries: [] })).toEqual({
      organizationId: ORG,
      currency: LEDGER_CURRENCY,
      credited: '0.000000',
      debited: '0.000000',
      balance: '0.000000',
      entryCount: 0,
      transactionCount: 0,
    });
  });

  it('adds credits and subtracts debits', () => {
    expect(
      balanceOf([
        entry({ id: 'a', amount: '100.000000', direction: 'credit' }),
        entry({ id: 'b', amount: '30.500000', direction: 'debit' }),
      ]),
    ).toBe('69.500000');
  });

  it('reports both sides separately', () => {
    const balance = calculateBalance({
      organizationId: ORG,
      entries: [
        entry({ id: 'a', amount: '100.000000', direction: 'credit' }),
        entry({ id: 'b', amount: '40.000000', direction: 'debit' }),
        entry({ id: 'c', amount: '10.000000', direction: 'debit' }),
      ],
    });

    expect(balance.credited).toBe('100.000000');
    expect(balance.debited).toBe('50.000000');
    expect(balance.balance).toBe('50.000000');
    expect(balance.entryCount).toBe(3);
  });

  it('goes negative when a correction lands out of order', () => {
    // A balance below zero is legitimate; refusing it would refuse the
    // correction that produced it.
    expect(balanceOf([entry({ id: 'a', amount: '5.000000', direction: 'debit' })])).toBe(
      '-5.000000',
    );
  });

  it('is exact where a float would not be', () => {
    // `0.1 + 0.2` is the canonical demonstration; a ledger has no UPDATE path
    // to correct a rounding error written once.
    expect(
      balanceOf([
        entry({ id: 'a', amount: '0.100000', direction: 'credit' }),
        entry({ id: 'b', amount: '0.200000', direction: 'credit' }),
      ]),
    ).toBe('0.300000');
  });

  it('stays exact past 2^53 scaled units', () => {
    // 9007199254.740993 credits is 9007199254740993 in scaled units — one past
    // 2^53, where a double stops counting. NUMERIC(20,6) allows fourteen
    // integer digits, so this is the boundary the column can actually reach.
    expect(
      balanceOf([
        entry({ id: 'a', amount: '9007199254.740993', direction: 'credit' }),
        entry({ id: 'b', amount: '0.000001', direction: 'credit' }),
      ]),
    ).toBe('9007199254.740994');
  });

  it('keeps all six decimal places', () => {
    expect(balanceOf([entry({ id: 'a', amount: '1.000001', direction: 'credit' })])).toBe(
      '1.000001',
    );
  });
});

describe('determinism', () => {
  const entries = [
    entry({ id: 'a', amount: '10.000000', direction: 'credit' }),
    entry({ id: 'b', amount: '3.250000', direction: 'debit' }),
    entry({ id: 'c', amount: '7.750000', direction: 'credit' }),
  ];

  it('gives the same answer twice', () => {
    expect(calculateBalance({ organizationId: ORG, entries })).toEqual(
      calculateBalance({ organizationId: ORG, entries }),
    );
  });

  it('does not depend on the order the entries arrived in', () => {
    // Which matters because a projection is built by a consumer that saw them
    // in a different order from the reader that checks it.
    const reversed = [...entries].reverse();
    expect(balanceOf(reversed)).toBe(balanceOf(entries));
  });

  it('reads no clock and generates nothing', () => {
    const first = calculateBalance({ organizationId: ORG, entries });
    const second = calculateBalance({ organizationId: ORG, entries });
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });
});

describe('currency', () => {
  it('is credits, and only credits', () => {
    expect(LEDGER_CURRENCY).toBe('credits');
    expect(calculateBalance({ organizationId: ORG, entries: [] }).currency).toBe('credits');
  });

  it('carries no ISO 4217 code anywhere', () => {
    // Credits are bought with money and are not money; a currency field that
    // could hold 'USD' would let dollars be added to credits.
    const balance = calculateBalance({ organizationId: ORG, entries: [] });
    expect(JSON.stringify(balance)).not.toMatch(/USD|EUR|GBP/);
  });
});

// ── What a plain sum would hide ─────────────────────────────────────────────

describe('duplicate transactions', () => {
  it('are refused, because a retry must charge once', () => {
    expect(
      codeOf(() =>
        calculateBalance({
          organizationId: ORG,
          entries: [
            entry({ id: 'a', amount: '5.000000', direction: 'debit', idempotencyKey: 'run-1' }),
            entry({ id: 'b', amount: '5.000000', direction: 'debit', idempotencyKey: 'run-1' }),
          ],
        }),
      ),
    ).toBe('DuplicateTransactionId');
  });

  it('name the transaction that repeated', () => {
    try {
      calculateBalance({
        organizationId: ORG,
        entries: [
          entry({ id: 'a', amount: '5.000000', direction: 'debit', idempotencyKey: 'run-1' }),
          entry({ id: 'b', amount: '5.000000', direction: 'debit', idempotencyKey: 'run-1' }),
        ],
      });
      throw new Error('expected a refusal');
    } catch (failure) {
      expect(failure).toBeInstanceOf(LedgerError);
      if (!(failure instanceof LedgerError)) return;
      expect(failure.message).toMatch(/run-1/);
    }
  });

  it('do not confuse entries with no key at all', () => {
    // A support adjustment and a manual grant have no natural key, which is why
    // they are audited instead. Two of them are not a duplicate.
    expect(
      balanceOf([
        entry({ id: 'a', amount: '5.000000', direction: 'credit', idempotencyKey: null }),
        entry({ id: 'b', amount: '5.000000', direction: 'credit', idempotencyKey: null }),
      ]),
    ).toBe('10.000000');
  });

  it('are counted, so a caller can see how many transactions contributed', () => {
    const balance = calculateBalance({
      organizationId: ORG,
      entries: [
        entry({ id: 'a', amount: '1.000000', direction: 'credit', idempotencyKey: 'run-1' }),
        entry({ id: 'b', amount: '1.000000', direction: 'credit', idempotencyKey: 'run-2' }),
        entry({ id: 'c', amount: '1.000000', direction: 'credit', idempotencyKey: null }),
      ],
    });

    expect(balance.entryCount).toBe(3);
    expect(balance.transactionCount).toBe(2);
  });
});

describe('invalid amounts', () => {
  it('are refused with the ledger’s own grammar', () => {
    // A value this accepted and the column refused would be a balance nobody
    // could write back.
    for (const amount of ['-1.000000', '1.0000001', '1e3', '+1.0', '01.0', 'nonsense']) {
      expect(codeOf(() => balanceOf([entry({ id: 'a', amount, direction: 'credit' })]))).toBe(
        'InvalidAmount',
      );
    }
  });

  it('accept what the column accepts', () => {
    for (const amount of ['0', '0.000001', '12.5', '99999999999999.999999']) {
      expect(codeOf(() => balanceOf([entry({ id: 'a', amount, direction: 'credit' })]))).toBeNull();
    }
  });
});

describe('overflow', () => {
  it('refuses a total NUMERIC(20,6) could not hold', () => {
    // Nothing bounded the SUM before: every entry fits and the total does not,
    // and the failure would arrive as a driver error inside somebody else's
    // transaction.
    const big = '99999999999999.999999';
    expect(
      codeOf(() =>
        balanceOf([
          entry({ id: 'a', amount: big, direction: 'credit' }),
          entry({ id: 'b', amount: big, direction: 'credit' }),
        ]),
      ),
    ).toBe('BalanceOverflow');
  });

  it('refuses an overflowing debit side too', () => {
    const big = '99999999999999.999999';
    expect(
      codeOf(() =>
        balanceOf([
          entry({ id: 'a', amount: big, direction: 'debit' }),
          entry({ id: 'b', amount: big, direction: 'debit' }),
        ]),
      ),
    ).toBe('BalanceOverflow');
  });

  it('accepts a total that just fits', () => {
    expect(
      codeOf(() =>
        balanceOf([entry({ id: 'a', amount: '99999999999999.999999', direction: 'credit' })]),
      ),
    ).toBeNull();
  });

  it('bounds at the column’s own limit', () => {
    expect(MAX_SCALED_BALANCE).toBe(10n ** 20n);
  });
});

describe('foreign entries', () => {
  it('are refused, because summing one moves credits between customers', () => {
    expect(
      codeOf(() =>
        calculateBalance({
          organizationId: ORG,
          entries: [
            entry({ id: 'a', amount: '5.000000', direction: 'credit' }),
            entry({
              id: 'b',
              amount: '5.000000',
              direction: 'credit',
              organizationId: '018f7a1e-0000-7000-8000-0000000000cc',
            }),
          ],
        }),
      ),
    ).toBe('ForeignEntry');
  });
});

// ── Reconciliation ──────────────────────────────────────────────────────────

describe('checking a balance somebody else computed', () => {
  const entries = [
    entry({ id: 'a', amount: '10.000000', direction: 'credit' }),
    entry({ id: 'b', amount: '4.000000', direction: 'debit' }),
  ];

  it('accepts one that agrees', () => {
    expect(
      assertBalanceConsistent({ organizationId: ORG, entries, claimed: '6.000000' }).balance,
    ).toBe('6.000000');
  });

  it('accepts a differently written but equal figure', () => {
    expect(
      codeOf(() => assertBalanceConsistent({ organizationId: ORG, entries, claimed: '6' })),
    ).toBeNull();
  });

  it('refuses one that does not', () => {
    expect(
      codeOf(() => assertBalanceConsistent({ organizationId: ORG, entries, claimed: '7.000000' })),
    ).toBe('InconsistentBalance');
  });

  it('names both figures, so the page is actionable', () => {
    try {
      assertBalanceConsistent({ organizationId: ORG, entries, claimed: '7.000000' });
      throw new Error('expected a refusal');
    } catch (failure) {
      expect(failure).toBeInstanceOf(LedgerError);
      if (!(failure instanceof LedgerError)) return;
      expect(failure.message).toMatch(/7\.000000/);
      expect(failure.message).toMatch(/6\.000000/);
    }
  });

  it('accepts a negative claim it can verify', () => {
    expect(
      codeOf(() =>
        assertBalanceConsistent({
          organizationId: ORG,
          entries: [entry({ id: 'a', amount: '5.000000', direction: 'debit' })],
          claimed: '-5.000000',
        }),
      ),
    ).toBeNull();
  });
});

// ── Transactions ────────────────────────────────────────────────────────────

describe('grouping entries into transactions', () => {
  it('groups by the id that already makes a retry charge once', () => {
    const groups = groupTransactions({
      organizationId: ORG,
      entries: [
        entry({ id: 'a', amount: '10.000000', direction: 'debit', idempotencyKey: 'run-1' }),
        entry({ id: 'b', amount: '2.000000', direction: 'credit', idempotencyKey: 'run-1' }),
        entry({ id: 'c', amount: '4.000000', direction: 'debit', idempotencyKey: 'run-2' }),
      ],
    });

    expect(groups.map((group) => group.transactionId)).toEqual(['run-1', 'run-2']);
    expect(groups[0]?.entries).toHaveLength(2);
  });

  it('nets each one', () => {
    const groups = groupTransactions({
      organizationId: ORG,
      entries: [
        entry({ id: 'a', amount: '10.000000', direction: 'debit', idempotencyKey: 'run-1' }),
        entry({ id: 'b', amount: '2.000000', direction: 'credit', idempotencyKey: 'run-1' }),
      ],
    });

    expect(groups[0]?.net).toBe('-8.000000');
  });

  it('leaves out entries that are not transactions', () => {
    // Inventing an id for a manual adjustment would make it look like a machine
    // write that could be retried.
    expect(
      groupTransactions({
        organizationId: ORG,
        entries: [
          entry({ id: 'a', amount: '1.000000', direction: 'credit', idempotencyKey: null }),
        ],
      }),
    ).toEqual([]);
  });

  it('refuses a foreign entry here too', () => {
    expect(
      codeOf(() =>
        groupTransactions({
          organizationId: ORG,
          entries: [
            entry({
              id: 'a',
              amount: '1.000000',
              direction: 'credit',
              idempotencyKey: 'k',
              organizationId: '018f7a1e-0000-7000-8000-0000000000cc',
            }),
          ],
        }),
      ),
    ).toBe('ForeignEntry');
  });
});

// ── The ledger as a value ───────────────────────────────────────────────────

describe('the ledger value', () => {
  const entries = [entry({ id: 'a', amount: '1.000000', direction: 'credit' })];

  it('takes its identity from the organization that owns the account', () => {
    // A separate ledger id would be a second name for one thing, and the first
    // time the two were written independently they would disagree.
    const ledger = toCreditLedger({ organizationId: ORG, entries });
    expect(ledger.ledgerId).toBe(ORG);
    expect(ledger.organizationId).toBe(ORG);
  });

  it('adds nothing and drops nothing', () => {
    expect(toCreditLedger({ organizationId: ORG, entries }).entries).toEqual(entries);
  });

  it('names the reasons its entries carry', () => {
    expect(
      reasonsOf([
        entry({ id: 'a', amount: '1.000000', direction: 'credit', entryType: 'grant' }),
        entry({ id: 'b', amount: '1.000000', direction: 'debit', entryType: 'consumption' }),
        entry({ id: 'c', amount: '1.000000', direction: 'debit', entryType: 'expiry' }),
      ]),
    ).toEqual(['CREDIT_GRANT', 'CREDIT_CONSUMPTION', 'CREDIT_EXPIRY']);
  });
});

describe('immutability', () => {
  const entries = [entry({ id: 'a', amount: '1.000000', direction: 'credit' })];

  it('freezes a balance through', () => {
    const balance = calculateBalance({ organizationId: ORG, entries });
    expect(Object.isFrozen(balance)).toBe(true);
    expect(() => {
      (balance as { balance: string }).balance = '999.000000';
    }).toThrow();
  });

  it('freezes a ledger through', () => {
    const ledger = toCreditLedger({ organizationId: ORG, entries });
    expect(Object.isFrozen(ledger)).toBe(true);
    expect(Object.isFrozen(ledger.entries)).toBe(true);
    expect(() => {
      (ledger.entries as { length: number }).length = 0;
    }).toThrow();
  });

  it('freezes transactions through', () => {
    const groups = groupTransactions({
      organizationId: ORG,
      entries: [entry({ id: 'a', amount: '1.000000', direction: 'credit', idempotencyKey: 'k' })],
    });
    expect(Object.isFrozen(groups)).toBe(true);
    expect(Object.isFrozen(groups[0])).toBe(true);
  });

  it('does not alias the entries it was handed', () => {
    const given = [...entries];
    const ledger = toCreditLedger({ organizationId: ORG, entries: given });
    expect(ledger.entries).not.toBe(given);
  });
});
