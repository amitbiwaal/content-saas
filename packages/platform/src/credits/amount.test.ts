/**
 * Exact arithmetic on credit amounts.
 *
 * The property under test is the one a float would break: every value that goes
 * in comes back identical, and every sum is exact. A ledger has no UPDATE path,
 * so a rounding error written once is permanent.
 */
import { describe, expect, it } from 'vitest';

import {
  addAmounts,
  AMOUNT_SCALE,
  compareAmounts,
  formatAmount,
  isNegative,
  isZeroOrLess,
  parseAmount,
  parseSigned,
  subtractAmounts,
  sumOrZero,
  ZERO,
} from './amount.js';
import { LedgerError } from './ledger.js';

describe('round-tripping is exact', () => {
  const VALUES = [
    '0.000000',
    '0.000001',
    '0.100000',
    '1.000000',
    '12.345678'.slice(0, 9), // '12.345678' trimmed to six places below
    '99999999999999.999999',
    '1234567.891234',
  ];

  for (const value of VALUES) {
    it(`preserves ${value}`, () => {
      expect(formatAmount(parseAmount(value))).toBe(value);
    });
  }

  it('normalises a short form to all six places', () => {
    expect(formatAmount(parseAmount('5'))).toBe('5.000000');
    expect(formatAmount(parseAmount('5.5'))).toBe('5.500000');
  });

  it('declares the scale the column uses', () => {
    expect(AMOUNT_SCALE).toBe(6);
  });
});

describe('the arithmetic a double would get wrong', () => {
  // The canonical demonstration. `0.1 + 0.2 === 0.30000000000000004` in IEEE-754.
  it('adds 0.1 and 0.2 to exactly 0.3', () => {
    const sum = addAmounts(parseAmount('0.1'), parseAmount('0.2'));
    expect(formatAmount(sum)).toBe('0.300000');
    expect(0.1 + 0.2).not.toBe(0.3); // the reason this module exists
  });

  it('keeps integer precision past 2^53', () => {
    const big = '99999999999999.999999';
    expect(formatAmount(parseAmount(big))).toBe(big);
    expect(String(Number(big))).not.toBe(big);
  });

  it('subtracts without drift over many operations', () => {
    let value = parseAmount('1.000000');
    for (let i = 0; i < 1000; i += 1) value = subtractAmounts(value, parseAmount('0.000001'));
    expect(formatAmount(value)).toBe('0.999000');
  });

  it('sums a thousand fractional charges exactly', () => {
    let total = ZERO;
    for (let i = 0; i < 1000; i += 1) total = addAmounts(total, parseAmount('0.000001'));
    expect(formatAmount(total)).toBe('0.001000');
  });
});

describe('signed values — a balance may go below zero', () => {
  it('parses and formats a negative', () => {
    expect(formatAmount(parseSigned('-4.250000'))).toBe('-4.250000');
  });

  it('subtracts past zero', () => {
    const result = subtractAmounts(parseAmount('1.000000'), parseAmount('3.500000'));
    expect(formatAmount(result)).toBe('-2.500000');
    expect(isNegative(result)).toBe(true);
  });

  it('treats zero as neither negative nor positive', () => {
    expect(isNegative(ZERO)).toBe(false);
    expect(isZeroOrLess(ZERO)).toBe(true);
    expect(isZeroOrLess(parseAmount('0.000001'))).toBe(false);
  });

  // `parseAmount` is the ledger's grammar, which forbids a sign. Reading a
  // balance back needs the wider one, and nothing else should.
  it('refuses a negative through the ledger grammar', () => {
    expect(() => parseAmount('-1')).toThrow(LedgerError);
  });

  it('refuses a malformed value through either', () => {
    for (const bad of ['', 'abc', '1e6', '--1', '-']) {
      expect(() => parseSigned(bad), bad).toThrow(LedgerError);
    }
  });

  it('names the value it could not read', () => {
    try {
      parseSigned('not-a-number');
      expect.unreachable('must refuse');
    } catch (error) {
      expect((error as LedgerError).message).toContain('not-a-number');
    }
  });
});

describe('comparison', () => {
  it('orders correctly across the sign boundary', () => {
    expect(compareAmounts(parseSigned('-1'), ZERO)).toBe(-1);
    expect(compareAmounts(ZERO, parseSigned('-1'))).toBe(1);
    expect(compareAmounts(parseAmount('0.000001'), parseAmount('0.000002'))).toBe(-1);
    expect(compareAmounts(parseAmount('5'), parseAmount('5.000000'))).toBe(0);
  });

  // The difference an insufficient-balance check turns on.
  it('separates values one micro-credit apart', () => {
    expect(compareAmounts(parseAmount('10.000000'), parseAmount('10.000001'))).toBe(-1);
  });
});

describe('sums from the database', () => {
  // `SUM()` over no rows is NULL, and an organization with no history is the
  // normal state on day one — not an error.
  it('reads NULL and empty as zero', () => {
    expect(formatAmount(sumOrZero(null))).toBe('0.000000');
    expect(formatAmount(sumOrZero(undefined))).toBe('0.000000');
    expect(formatAmount(sumOrZero(''))).toBe('0.000000');
  });

  it('reads a NUMERIC text value', () => {
    expect(formatAmount(sumOrZero('1234.567890'))).toBe('1234.567890');
  });

  it('reads the bare zero PostgreSQL emits for COALESCE(..., 0)', () => {
    expect(formatAmount(sumOrZero('0'))).toBe('0.000000');
  });

  it('reads a negative sum', () => {
    expect(formatAmount(sumOrZero('-7.500000'))).toBe('-7.500000');
  });
});
