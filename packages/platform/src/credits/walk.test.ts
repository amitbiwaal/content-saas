import { describe, expect, it } from 'vitest';

import { LEDGER_CURRENCY } from './aggregate.js';
import { LedgerError, type LedgerDirection, type LedgerEntry } from './ledger.js';
import type { CreditLedgerRepository, LedgerQuery } from './repository.js';
import {
  calculateLedgerBalance,
  DEFAULT_LEDGER_PAGE_SIZE,
  DEFAULT_MAX_LEDGER_ENTRIES,
  loadWholeLedger,
} from './walk.js';

const ORG = '018f7a1e-0000-7000-8000-0000000000aa';

const entry = (index: number, direction: LedgerDirection = 'credit'): LedgerEntry => ({
  id: `entry-${String(index).padStart(4, '0')}`,
  tenantId: ORG,
  organizationId: ORG,
  workspaceId: null,
  entryType: 'grant',
  amount: '1.000000',
  direction,
  idempotencyKey: `txn-${String(index)}`,
  referenceEntryId: null,
  reason: 'because',
  correlationId: '018f7a1e-0000-7000-8000-0000000000dd',
  createdBy: null,
  metadata: {},
  createdAt: `2026-07-31T12:00:${String(index % 60).padStart(2, '0')}.000Z`,
});

/**
 * A repository over an in-memory list.
 *
 * The only implementation in this package, and it lives in a test — which is
 * the point of the port. It honours the keyset contract faithfully, so it
 * doubles as the specification an implementer reads.
 */
function memoryRepository(entries: readonly LedgerEntry[]) {
  const calls = { appendEntry: 0, loadEntry: 0, loadLedger: 0, calculateBalance: 0 };
  const seen: LedgerQuery[] = [];

  const repository: CreditLedgerRepository = {
    appendEntry: () => {
      calls.appendEntry += 1;
      return Promise.resolve();
    },
    loadEntry: (organizationId, entryId) => {
      calls.loadEntry += 1;
      return Promise.resolve(
        entries.find((row) => row.organizationId === organizationId && row.id === entryId) ?? null,
      );
    },
    loadLedger: (query) => {
      calls.loadLedger += 1;
      seen.push(query);

      const key = (row: LedgerEntry): string => `${row.createdAt}|${row.id}`;
      const ordered = [...entries]
        .filter((row) => row.organizationId === query.organizationId)
        .sort((left, right) => (key(left) < key(right) ? -1 : key(left) > key(right) ? 1 : 0));

      const after = query.after;
      const remaining =
        after === null
          ? ordered
          : ordered.filter((row) => key(row) > `${after.createdAt}|${after.entryId}`);

      return Promise.resolve({ entries: remaining.slice(0, query.limit) });
    },
    calculateBalance: () => {
      calls.calculateBalance += 1;
      return Promise.resolve({
        organizationId: ORG,
        currency: LEDGER_CURRENCY,
        credited: '0.000000',
        debited: '0.000000',
        balance: '0.000000',
        entryCount: 0,
        transactionCount: 0,
      });
    },
  };

  return { repository, calls, seen };
}

describe('walking a whole ledger', () => {
  it('reads every entry, once, in order', async () => {
    const entries = Array.from({ length: 5 }, (_, index) => entry(index));
    const { repository } = memoryRepository(entries);
    const whole = await loadWholeLedger({ repository, organizationId: ORG, pageSize: 2 });

    expect(whole.ledger.entries.map((row) => row.id)).toEqual(entries.map((row) => row.id));
    expect(new Set(whole.ledger.entries.map((row) => row.id)).size).toBe(5);
    expect(whole.truncated).toBe(false);
  });

  it('pages by position, never by offset', async () => {
    // The ledger is append-only, so new entries land at the end while a walk is
    // in progress. An offset would skip one every time.
    const { repository, seen } = memoryRepository(
      Array.from({ length: 5 }, (_, index) => entry(index)),
    );
    await loadWholeLedger({ repository, organizationId: ORG, pageSize: 2 });

    expect(seen[0]?.after).toBeNull();
    expect(seen[1]?.after).toEqual({
      createdAt: '2026-07-31T12:00:01.000Z',
      entryId: 'entry-0001',
    });
    expect(JSON.stringify(seen)).not.toContain('offset');
  });

  it('stops when the store returns a short page', async () => {
    // Asking again would be one round trip per walk, forever, for nothing.
    const { repository, calls } = memoryRepository(
      Array.from({ length: 3 }, (_, index) => entry(index)),
    );
    await loadWholeLedger({ repository, organizationId: ORG, pageSize: 10 });

    expect(calls.loadLedger).toBe(1);
  });

  it('handles a ledger with no history', async () => {
    const { repository } = memoryRepository([]);
    const whole = await loadWholeLedger({ repository, organizationId: ORG });

    expect(whole.ledger.entries).toEqual([]);
    expect(whole.truncated).toBe(false);
  });

  it('reads only the organization it was asked for', async () => {
    const { repository, seen } = memoryRepository([entry(0)]);
    await loadWholeLedger({ repository, organizationId: ORG });

    expect(seen[0]?.organizationId).toBe(ORG);
    expect(seen[0]?.workspaceId).toBeNull();
  });

  it('gives the ledger the organization’s own identity', async () => {
    const { repository } = memoryRepository([entry(0)]);
    const whole = await loadWholeLedger({ repository, organizationId: ORG });

    expect(whole.ledger.ledgerId).toBe(ORG);
    expect(whole.ledger.currency).toBe(LEDGER_CURRENCY);
  });

  it('freezes what it returns', async () => {
    const { repository } = memoryRepository([entry(0)]);
    const whole = await loadWholeLedger({ repository, organizationId: ORG });

    expect(Object.isFrozen(whole)).toBe(true);
    expect(Object.isFrozen(whole.ledger)).toBe(true);
    expect(Object.isFrozen(whole.ledger.entries)).toBe(true);
  });
});

describe('the walk is bounded', () => {
  it('stops at the bound, and says so', async () => {
    // A balance from a truncated walk is a partial sum wearing the name of a
    // total — which is exactly the mistake this makes impossible to make
    // quietly.
    const { repository } = memoryRepository(Array.from({ length: 10 }, (_, index) => entry(index)));
    const whole = await loadWholeLedger({
      repository,
      organizationId: ORG,
      pageSize: 3,
      maxEntries: 4,
    });

    expect(whole.truncated).toBe(true);
    expect(whole.ledger.entries).toHaveLength(4);
  });

  it('does not claim truncation when the ledger simply ran out', async () => {
    const { repository } = memoryRepository(Array.from({ length: 4 }, (_, index) => entry(index)));
    const whole = await loadWholeLedger({
      repository,
      organizationId: ORG,
      pageSize: 2,
      maxEntries: 100,
    });

    expect(whole.truncated).toBe(false);
  });

  it('has a stated default rather than an unbounded loop', () => {
    // A job that would read ten million rows should be a decision somebody
    // made, not the default.
    expect(DEFAULT_MAX_LEDGER_ENTRIES).toBe(100_000);
    expect(DEFAULT_LEDGER_PAGE_SIZE).toBe(200);
  });
});

describe('a balance from a whole ledger', () => {
  it('sums what the walk read', async () => {
    const { repository } = memoryRepository([
      entry(0, 'credit'),
      entry(1, 'credit'),
      entry(2, 'debit'),
    ]);
    const balance = await calculateLedgerBalance({ repository, organizationId: ORG });

    expect(balance.credited).toBe('2.000000');
    expect(balance.debited).toBe('1.000000');
    expect(balance.balance).toBe('1.000000');
  });

  it('refuses a truncated walk rather than returning a partial total', async () => {
    // A partial balance is worse than no balance, because it looks like one.
    const { repository } = memoryRepository(Array.from({ length: 10 }, (_, index) => entry(index)));

    await expect(
      calculateLedgerBalance({ repository, organizationId: ORG, maxEntries: 3 }),
    ).rejects.toBeInstanceOf(LedgerError);
  });

  it('says how to get a total instead', async () => {
    const { repository } = memoryRepository(Array.from({ length: 10 }, (_, index) => entry(index)));

    try {
      await calculateLedgerBalance({ repository, organizationId: ORG, maxEntries: 3 });
      throw new Error('expected a refusal');
    } catch (failure) {
      expect(failure).toBeInstanceOf(LedgerError);
      if (!(failure instanceof LedgerError)) return;
      expect(failure.code).toBe('InconsistentBalance');
      expect(failure.message).toMatch(/projection/);
    }
  });

  it('carries a duplicate-transaction refusal straight up', async () => {
    const duplicated = [entry(0), { ...entry(1), idempotencyKey: 'txn-0' }];
    const { repository } = memoryRepository(duplicated);

    try {
      await calculateLedgerBalance({ repository, organizationId: ORG });
      throw new Error('expected a refusal');
    } catch (failure) {
      expect(failure).toBeInstanceOf(LedgerError);
      if (!(failure instanceof LedgerError)) return;
      expect(failure.code).toBe('DuplicateTransactionId');
    }
  });
});

describe('the walk never writes', () => {
  it('appends nothing', async () => {
    const { repository, calls } = memoryRepository([entry(0)]);
    await loadWholeLedger({ repository, organizationId: ORG });
    await calculateLedgerBalance({ repository, organizationId: ORG });

    expect(calls.appendEntry).toBe(0);
  });

  it('reads the ledger rather than asking the store for a total', async () => {
    // The pure fold is the point: the answer must be computable from entries
    // alone, so that a projection has something to be checked against.
    const { repository, calls } = memoryRepository([entry(0)]);
    await calculateLedgerBalance({ repository, organizationId: ORG });

    expect(calls.loadLedger).toBeGreaterThan(0);
    expect(calls.calculateBalance).toBe(0);
  });
});
