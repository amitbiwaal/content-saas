import { describe, expect, it } from 'vitest';

import { LedgerError, LEDGER_ENTRY_TYPES, type LedgerEntryType } from './ledger.js';
import {
  ENTRY_TYPE_TO_REASON,
  entryTypeFor,
  isLedgerReason,
  isRecordableReason,
  LEDGER_REASONS,
  REASON_TO_ENTRY_TYPE,
  reasonFor,
  RECORDABLE_REASONS,
  type LedgerReason,
} from './reason.js';

const codeOf = (run: () => unknown): string | null => {
  try {
    run();
    return null;
  } catch (failure) {
    return failure instanceof LedgerError ? failure.code : 'not-a-ledger-error';
  }
};

describe('the commercial vocabulary', () => {
  it('names every reason the commercial platform uses', () => {
    expect([...LEDGER_REASONS]).toEqual([
      'CREDIT_GRANT',
      'CREDIT_PURCHASE',
      'CREDIT_RESERVATION',
      'CREDIT_CONSUMPTION',
      'CREDIT_REFUND',
      'CREDIT_ADJUSTMENT',
      'CREDIT_EXPIRY',
    ]);
  });

  it('recognises its own members and nothing else', () => {
    expect(isLedgerReason('CREDIT_GRANT')).toBe(true);
    expect(isLedgerReason('credit_grant')).toBe(false);
    expect(isLedgerReason('grant')).toBe(false);
    expect(isLedgerReason('CREDIT_TRANSFER')).toBe(false);
    expect(isLedgerReason(7)).toBe(false);
  });

  it('is spelled so it can never be mistaken for an entry type', () => {
    // Two vocabularies that looked alike would be two values somebody passes to
    // the wrong function.
    for (const reason of LEDGER_REASONS) {
      expect(LEDGER_ENTRY_TYPES).not.toContain(reason as unknown as LedgerEntryType);
    }
    for (const entryType of LEDGER_ENTRY_TYPES) {
      expect(LEDGER_REASONS).not.toContain(entryType as unknown as LedgerReason);
    }
  });
});

describe('mapping a reason onto a row', () => {
  it('maps each recordable reason to its frozen entry type', () => {
    expect(entryTypeFor('CREDIT_GRANT')).toBe('grant');
    expect(entryTypeFor('CREDIT_CONSUMPTION')).toBe('consumption');
    expect(entryTypeFor('CREDIT_REFUND')).toBe('refund');
    expect(entryTypeFor('CREDIT_ADJUSTMENT')).toBe('adjustment');
    expect(entryTypeFor('CREDIT_EXPIRY')).toBe('expiry');
  });

  it('produces only entry types the frozen enum already has', () => {
    // Nothing here invents a row type, which is what keeps this a bridge rather
    // than a second ledger.
    for (const reason of RECORDABLE_REASONS) {
      expect(LEDGER_ENTRY_TYPES).toContain(entryTypeFor(reason));
    }
  });

  it('says which reasons are rows at all', () => {
    expect([...RECORDABLE_REASONS]).toEqual([
      'CREDIT_GRANT',
      'CREDIT_CONSUMPTION',
      'CREDIT_REFUND',
      'CREDIT_ADJUSTMENT',
      'CREDIT_EXPIRY',
    ]);
    expect(isRecordableReason('CREDIT_PURCHASE')).toBe(false);
    expect(isRecordableReason('CREDIT_RESERVATION')).toBe(false);
  });
});

describe('refusing a reason that is not a row', () => {
  it('refuses a purchase rather than recording it as a grant', () => {
    // Mapping it onto `grant` would make "how many credits were paid for?"
    // unanswerable from the ledger, permanently.
    expect(codeOf(() => entryTypeFor('CREDIT_PURCHASE'))).toBe('UnrepresentableReason');
  });

  it('says why, and what it would take', () => {
    try {
      entryTypeFor('CREDIT_PURCHASE');
      throw new Error('expected a refusal');
    } catch (failure) {
      expect(failure).toBeInstanceOf(LedgerError);
      if (!(failure instanceof LedgerError)) return;
      expect(failure.message).toMatch(/revenue recognition/);
      expect(failure.message).toMatch(/migration on a financial table/);
    }
  });

  it('refuses a reservation, and names where reservations live', () => {
    // Holds reserve by arithmetic; a reservation row would let the same credits
    // be subtracted twice.
    try {
      entryTypeFor('CREDIT_RESERVATION');
      throw new Error('expected a refusal');
    } catch (failure) {
      expect(failure).toBeInstanceOf(LedgerError);
      if (!(failure instanceof LedgerError)) return;
      expect(failure.code).toBe('UnrepresentableReason');
      expect(failure.message).toMatch(/hold API/);
      expect(failure.message).toMatch(/subtracted twice/);
    }
  });

  it('refuses a reason it has never heard of, with a different code', () => {
    // Not knowing a name and knowing it cannot be a row are different mistakes.
    expect(codeOf(() => entryTypeFor('CREDIT_TRANSFER' as LedgerReason))).toBe('InvalidEntryType');
  });
});

describe('naming a row that already exists', () => {
  it('is total: every entry type has a reason', () => {
    // The forward direction may refuse, because a caller can ask for something
    // that is not a row. This one cannot, because the row is already there.
    for (const entryType of LEDGER_ENTRY_TYPES) {
      expect(isLedgerReason(reasonFor(entryType))).toBe(true);
    }
  });

  it('round-trips every recordable reason', () => {
    for (const reason of RECORDABLE_REASONS) {
      expect(reasonFor(entryTypeFor(reason))).toBe(reason);
    }
  });

  it('round-trips every entry type', () => {
    for (const entryType of LEDGER_ENTRY_TYPES) {
      expect(entryTypeFor(reasonFor(entryType))).toBe(entryType);
    }
  });

  it('refuses an entry type this build does not know', () => {
    expect(codeOf(() => reasonFor('transfer' as LedgerEntryType))).toBe('InvalidEntryType');
  });
});

describe('the mapping tables', () => {
  it('agree with each other in both directions', () => {
    for (const [reason, entryType] of Object.entries(REASON_TO_ENTRY_TYPE)) {
      expect(ENTRY_TYPE_TO_REASON[entryType]).toBe(reason);
    }
  });

  it('cover every entry type the database CHECKs', () => {
    expect(Object.keys(ENTRY_TYPE_TO_REASON).sort()).toEqual([...LEDGER_ENTRY_TYPES].sort());
  });

  it('are frozen', () => {
    expect(Object.isFrozen(REASON_TO_ENTRY_TYPE)).toBe(true);
    expect(Object.isFrozen(ENTRY_TYPE_TO_REASON)).toBe(true);
    expect(Object.isFrozen(RECORDABLE_REASONS)).toBe(true);
  });
});
