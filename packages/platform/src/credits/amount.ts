/**
 * Exact arithmetic on credit amounts.
 *
 * `NUMERIC(20,6)` is exact; IEEE-754 is not. `0.1 + 0.2` is the canonical
 * demonstration, and integers stop being exact past 2^53 — a limit a credit
 * balance at scale reaches. The ledger has no UPDATE path, so a rounding error
 * written once is permanent and reconciliation would report a discrepancy
 * nobody could explain.
 *
 * Every value here is therefore a **decimal string** outside and a `bigint`
 * scaled by 10^6 inside. There is no `number` in this module and no float
 * anywhere in the money path.
 *
 * Aggregation over the ledger is still done by PostgreSQL, which is exact too.
 * These helpers are for what has to happen in the process: comparing a balance
 * against a request, subtracting open holds, classifying a threshold.
 */

import { assertValidAmount, LedgerError } from './ledger.js';

/** `NUMERIC(20,6)` — six fractional digits. */
export const AMOUNT_SCALE = 6;

const SCALE_FACTOR = 10n ** BigInt(AMOUNT_SCALE);

/**
 * A signed amount in scaled minor units.
 *
 * Branded so a raw `bigint` — a count, an id, a millisecond — cannot be passed
 * where an amount is meant. Money and quantities look identical at runtime and
 * that is precisely when they get swapped.
 */
export type ScaledAmount = bigint & { readonly __scaled: unique symbol };

const scaled = (value: bigint): ScaledAmount => value as ScaledAmount;

export const ZERO: ScaledAmount = scaled(0n);

/**
 * Parse a non-negative decimal string, as the ledger accepts it.
 *
 * Reuses the ledger's validation rather than restating the grammar: a value
 * this module would accept and the column would not is a runtime failure
 * halfway through a transaction.
 */
export function parseAmount(amount: string): ScaledAmount {
  assertValidAmount(amount);
  const [whole = '0', fraction = ''] = amount.split('.');
  return scaled(BigInt(whole) * SCALE_FACTOR + BigInt(fraction.padEnd(AMOUNT_SCALE, '0')));
}

/**
 * Parse a value that PostgreSQL produced, which may be negative.
 *
 * A balance is `credited - debited` and can legitimately be below zero if a
 * correction lands out of order, so the ledger's non-negative grammar does not
 * apply. Everything else about the format does.
 */
export function parseSigned(amount: string): ScaledAmount {
  const negative = amount.startsWith('-');
  const magnitude = negative ? amount.slice(1) : amount;
  try {
    return negative ? scaled(0n - parseAmount(magnitude)) : parseAmount(magnitude);
  } catch {
    throw new LedgerError(
      'InvalidAmount',
      `'${amount}' is not a NUMERIC(20,${String(AMOUNT_SCALE)}) value the balance can be read from.`,
    );
  }
}

/** Back to the canonical string form, always with all six decimal places. */
export function formatAmount(value: ScaledAmount): string {
  const negative = value < 0n;
  // `0n - value` rather than `-value`: the brand makes the operand a subtype of
  // bigint, which unary negation is not typed to accept.
  const magnitude = negative ? 0n - value : (value as bigint);
  const whole = magnitude / SCALE_FACTOR;
  const fraction = (magnitude % SCALE_FACTOR).toString().padStart(AMOUNT_SCALE, '0');
  return `${negative ? '-' : ''}${whole.toString()}.${fraction}`;
}

export const addAmounts = (a: ScaledAmount, b: ScaledAmount): ScaledAmount => scaled(a + b);
export const subtractAmounts = (a: ScaledAmount, b: ScaledAmount): ScaledAmount => scaled(a - b);

/** −1, 0 or 1. Named rather than inlined so call sites read as intent. */
export function compareAmounts(a: ScaledAmount, b: ScaledAmount): -1 | 0 | 1 {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export const isNegative = (value: ScaledAmount): boolean => value < 0n;
export const isZeroOrLess = (value: ScaledAmount): boolean => value <= 0n;

/**
 * Sum a column PostgreSQL returned, treating NULL as zero.
 *
 * `SUM()` over no rows is NULL, and an organization with no ledger history is
 * the normal state on day one — not an error, and not a reason to refuse a
 * balance read.
 */
export function sumOrZero(value: string | null | undefined): ScaledAmount {
  return value === null || value === undefined || value === '' ? ZERO : parseSigned(value);
}
