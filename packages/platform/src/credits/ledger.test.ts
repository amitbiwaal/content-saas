/**
 * The ledger model.
 *
 * Two properties carry most of the weight here, and both are about a record
 * that can never be corrected: the sign lives on the type rather than the
 * magnitude, and the amount stays an exact decimal string.
 */
import { describe, expect, it } from 'vitest';

import {
  assertValidAmount,
  IMPLIED_DIRECTION,
  isLedgerDirection,
  isLedgerEntryType,
  LEDGER_ENTRY_TYPES,
  LedgerError,
  resolveDirection,
  type LedgerEntryType,
} from './ledger.js';

/**
 * The five, written out independently of the module.
 *
 * `03-database/tables.md` §8 and the migration's CHECK. Adding a sixth entry
 * type is a schema change; editing the module without editing this fails.
 */
const CANONICAL_ENTRY_TYPES = ['grant', 'consumption', 'refund', 'adjustment', 'expiry'];

describe('the entry-type vocabulary is fixed', () => {
  it('is exactly the five documented types', () => {
    expect([...LEDGER_ENTRY_TYPES].sort()).toEqual([...CANONICAL_ENTRY_TYPES].sort());
  });

  it('recognises each of them and nothing else', () => {
    for (const type of CANONICAL_ENTRY_TYPES) expect(isLedgerEntryType(type), type).toBe(true);
    for (const type of ['chargeback', 'GRANT', '', 'hold']) {
      expect(isLedgerEntryType(type), type).toBe(false);
    }
  });

  it('recognises the two directions and nothing else', () => {
    expect(isLedgerDirection('credit')).toBe(true);
    expect(isLedgerDirection('debit')).toBe(true);
    for (const value of ['CREDIT', 'positive', '+', '']) {
      expect(isLedgerDirection(value), value).toBe(false);
    }
  });
});

describe('sign is carried by the entry type', () => {
  const IMPLIED: [LedgerEntryType, 'credit' | 'debit'][] = [
    ['grant', 'credit'],
    ['refund', 'credit'],
    ['consumption', 'debit'],
    ['expiry', 'debit'],
  ];

  for (const [entryType, direction] of IMPLIED) {
    it(`resolves ${entryType} to ${direction} with nothing supplied`, () => {
      expect(resolveDirection(entryType)).toBe(direction);
    });

    it(`accepts ${direction} stated redundantly for ${entryType}`, () => {
      expect(resolveDirection(entryType, direction)).toBe(direction);
    });

    // Coercing would produce a row indistinguishable from a legitimate one on a
    // table with no UPDATE path.
    it(`REFUSES the opposite direction for ${entryType}`, () => {
      const opposite = direction === 'credit' ? 'debit' : 'credit';
      expect(() => resolveDirection(entryType, opposite)).toThrow(LedgerError);
      try {
        resolveDirection(entryType, opposite);
      } catch (error) {
        expect((error as LedgerError).code).toBe('DirectionContradictsType');
      }
    });
  }

  // Support may add or remove, which is why it is audited and needs a reason.
  it('requires an explicit direction for an adjustment', () => {
    expect(() => resolveDirection('adjustment')).toThrow(/must be stated/);
    try {
      resolveDirection('adjustment');
    } catch (error) {
      expect((error as LedgerError).code).toBe('DirectionRequired');
    }
  });

  it('accepts either direction for an adjustment', () => {
    expect(resolveDirection('adjustment', 'credit')).toBe('credit');
    expect(resolveDirection('adjustment', 'debit')).toBe('debit');
  });

  // A default here would silently pick a side for the one operation performed
  // by a human, on an immutable row.
  it('declares no implied direction for an adjustment', () => {
    expect(IMPLIED_DIRECTION['adjustment']).toBeUndefined();
    expect(Object.keys(IMPLIED_DIRECTION)).toHaveLength(4);
  });
});

describe('amounts are exact non-negative decimals', () => {
  const VALID = ['0', '1', '100', '0.000001', '100.5', '999999999999.999999'];
  for (const amount of VALID) {
    it(`accepts ${amount}`, () => {
      expect(() => {
        assertValidAmount(amount);
      }).not.toThrow();
    });
  }

  // Sign belongs to the entry type; an exponent and a leading zero are both
  // ways of writing a value the column will silently reinterpret.
  const INVALID: [string, string][] = [
    ['-1', 'a negative magnitude'],
    ['+1', 'an explicit sign'],
    ['1e6', 'scientific notation'],
    ['0.0000001', 'a seventh decimal place'],
    ['', 'nothing at all'],
    ['abc', 'not a number'],
    ['1.', 'a trailing point'],
    ['.5', 'a leading point'],
    ['01', 'a leading zero'],
    ['1 000', 'a separator'],
    ['NaN', 'NaN'],
    ['Infinity', 'Infinity'],
  ];
  for (const [amount, why] of INVALID) {
    it(`rejects '${amount}' — ${why}`, () => {
      expect(() => {
        assertValidAmount(amount);
      }).toThrow(LedgerError);
    });
  }

  it('rejects a value wider than NUMERIC(20,6)', () => {
    expect(() => {
      assertValidAmount('999999999999999.999999');
    }).toThrow(/exceeds NUMERIC/);
  });

  it('accepts exactly twenty significant digits', () => {
    expect(() => {
      assertValidAmount('99999999999999.999999');
    }).not.toThrow();
  });

  it('reports the code and names the offending value', () => {
    try {
      assertValidAmount('-5');
      expect.unreachable('a negative amount must be refused');
    } catch (error) {
      expect((error as LedgerError).code).toBe('InvalidAmount');
      expect((error as LedgerError).message).toContain('-5');
    }
  });
});
