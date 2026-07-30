/**
 * Exact decimal money.
 *
 * The assertions that matter here are the ones a float would fail. `0.1 + 0.2`
 * is the famous one, but the dangerous one is quieter: a per-million price
 * multiplied by a token count produces a number that is very nearly right,
 * every time, in a direction nobody notices until the provider invoice
 * disagrees.
 */
import { describe, expect, it } from 'vitest';

import {
  COST_SCALE,
  costOfTokens,
  DecimalError,
  formatDecimal,
  isDecimalString,
  parseDecimal,
  PRICE_UNIT_TOKENS,
  sumScaled,
  ZERO_COST,
} from './decimal.js';

describe("the format is the ledger's", () => {
  it('stores six decimal places', () => {
    expect(COST_SCALE).toBe(6);
    expect(ZERO_COST).toBe('0.000000');
  });

  it('accepts what the ledger accepts', () => {
    for (const value of ['0', '0.000001', '1', '1.5', '12345.678901', '99999999999999']) {
      expect(isDecimalString(value), value).toBe(true);
    }
  });

  it('refuses a sign, an exponent, a leading zero or too much precision', () => {
    for (const value of ['-1', '+1', '1e-6', '01.5', '.5', '1.', '0.0000001', '', 'abc']) {
      expect(isDecimalString(value), value).toBe(false);
    }
  });

  it('refuses a number, which is the whole point', () => {
    expect(isDecimalString(1.5)).toBe(false);
    expect(isDecimalString(0)).toBe(false);
  });
});

describe('parse and format round-trip exactly', () => {
  it('always writes all six places', () => {
    expect(formatDecimal(parseDecimal('1'))).toBe('1.000000');
    expect(formatDecimal(parseDecimal('1.5'))).toBe('1.500000');
    expect(formatDecimal(parseDecimal('0.000001'))).toBe('0.000001');
  });

  it('round-trips every scale', () => {
    for (const value of ['0', '0.1', '0.12', '0.123456', '7.5', '1000000.000001']) {
      expect(formatDecimal(parseDecimal(value)), value).toBe(
        value.includes('.')
          ? `${value.split('.')[0] ?? '0'}.${(value.split('.')[1] ?? '').padEnd(6, '0')}`
          : `${value}.000000`,
      );
    }
  });

  // The failure a double would produce, asserted directly.
  it('adds decimals exactly, where a float would not', () => {
    expect(0.1 + 0.2).not.toBe(0.3);
    const exact = sumScaled([parseDecimal('0.1'), parseDecimal('0.2')]);
    expect(formatDecimal(exact)).toBe('0.300000');
  });

  it('keeps precision past 2^53, where a float loses integers', () => {
    const big = '99999999999999.999999';
    expect(formatDecimal(parseDecimal(big))).toBe(big);
  });

  it('refuses a value the ledger would', () => {
    for (const value of ['-1', '1e6', '0.0000001']) {
      expect(() => parseDecimal(value), value).toThrow(DecimalError);
    }
  });

  it('refuses more integer digits than NUMERIC(20,6) holds', () => {
    expect(() => parseDecimal('999999999999999')).toThrow(/exceeds NUMERIC/);
  });

  it('refuses to format a negative', () => {
    expect(() => formatDecimal(-1n)).toThrow(/cannot be negative/);
  });
});

describe('cost from tokens', () => {
  const perMillion = (price: string): bigint => parseDecimal(price);

  it('prices a million tokens at exactly the quoted rate', () => {
    expect(formatDecimal(costOfTokens(1_000_000, perMillion('2.5')))).toBe('2.500000');
  });

  it('prices zero tokens at zero', () => {
    expect(formatDecimal(costOfTokens(0, perMillion('2.5')))).toBe('0.000000');
  });

  it('prices at a rate of zero', () => {
    expect(formatDecimal(costOfTokens(1_000_000, perMillion('0')))).toBe('0.000000');
  });

  it('prices a realistic call', () => {
    // 1,000 prompt tokens at $2.50/M.
    expect(formatDecimal(costOfTokens(1000, perMillion('2.5')))).toBe('0.002500');
  });

  it('scales linearly', () => {
    const one = costOfTokens(1000, perMillion('3'));
    const ten = costOfTokens(10_000, perMillion('3'));
    expect(ten).toBe(one * 10n);
  });

  // Rounding is half up, stated rather than inherited.
  it('rounds a half up', () => {
    // 1 token at $2.50/M = 0.0000025 exactly, which is a half at six places.
    expect(formatDecimal(costOfTokens(1, perMillion('2.5')))).toBe('0.000003');
  });

  it('rounds below a half down', () => {
    expect(formatDecimal(costOfTokens(1, perMillion('2.4')))).toBe('0.000002');
  });

  it('rounds above a half up', () => {
    expect(formatDecimal(costOfTokens(1, perMillion('2.6')))).toBe('0.000003');
  });

  it('quotes per million, as every provider does', () => {
    expect(PRICE_UNIT_TOKENS).toBe(1_000_000n);
  });

  // Same inputs, same output — every time, on every machine.
  it('is deterministic across repeated calls', () => {
    const expected = costOfTokens(123_457, perMillion('1.234567'));
    for (let i = 0; i < 100; i += 1) {
      expect(costOfTokens(123_457, perMillion('1.234567'))).toBe(expected);
    }
  });

  // The quiet failure: a float would drift here and stay plausible.
  it('agrees with the exact rational answer on an awkward rate', () => {
    // 333,333 tokens at $1.234567/M = 0.411521...  →  0.411522 half up.
    // Exact: 333333 * 1234567 / 1e12 = 411521.740611 / 1e6.
    expect(formatDecimal(costOfTokens(333_333, perMillion('1.234567')))).toBe('0.411522');
  });

  it('refuses a fractional or negative token count', () => {
    for (const tokens of [-1, 1.5, Number.NaN]) {
      expect(() => costOfTokens(tokens, perMillion('1')), String(tokens)).toThrow(DecimalError);
    }
  });

  it('refuses a negative price', () => {
    expect(() => costOfTokens(1, -1n)).toThrow(/cannot be negative/);
  });
});

describe('summing', () => {
  it('sums in scaled space, never through strings', () => {
    const total = sumScaled([parseDecimal('0.1'), parseDecimal('0.02'), parseDecimal('0.003')]);
    expect(formatDecimal(total)).toBe('0.123000');
  });

  it('sums nothing to zero', () => {
    expect(formatDecimal(sumScaled([]))).toBe(ZERO_COST);
  });
});
