/**
 * Exact decimal money, in the credits ledger's own format.
 *
 * `08-ai-platform/cost-management.md` domain rule 12 and
 * `03-database/tables.md` §1.1: amounts are NUMERIC and floating-point money is
 * prohibited. This file is why that holds here — every value is a **decimal
 * string** outside and a scaled `bigint` inside, and no arithmetic anywhere in
 * the cost path touches a double.
 *
 * ── The concrete failure this prevents ──────────────────────────────────────
 * `0.1 + 0.2 !== 0.3` in IEEE-754, and integer precision is gone past 2^53. A
 * per-million price multiplied by a token count in floats produces a cost that
 * is very nearly right, every time, in a direction nobody notices until the
 * provider invoice disagrees.
 *
 * ── Why this is not imported from `packages/platform` ───────────────────────
 * `packages/platform/src/credits/amount.ts` does the same arithmetic for the
 * ledger. Two feature packages may not import each other
 * (`07-development-guide/project-structure.md` rule 4), so this cannot reuse
 * it — and moving it would edit code this increment declares frozen. The FORMAT
 * is deliberately identical, which is the property that matters: a total
 * computed here passes to the ledger with no conversion, and the conformance
 * suite asserts exactly that.
 */

/** Six decimal places, as NUMERIC(20,6) stores. */
export const COST_SCALE = 6;

const SCALE_FACTOR = 10n ** BigInt(COST_SCALE);

/**
 * Prices are quoted per MILLION tokens, as every provider quotes them.
 *
 * Stated as a constant rather than folded into the arithmetic so that a reader
 * checking a cost by hand knows which unit the number is in.
 */
export const PRICE_UNIT_TOKENS = 1_000_000n;

/**
 * The ledger's own acceptance rule: non-negative, at most six decimal places,
 * no sign, no exponent, no leading zeroes.
 */
export const DECIMAL_PATTERN = /^(0|[1-9]\d*)(\.\d{1,6})?$/;

/** NUMERIC(20,6) leaves fourteen digits before the point. */
const MAX_INTEGER_DIGITS = 20 - COST_SCALE;
const MAX_SCALED = 10n ** BigInt(20) - 1n;

export class DecimalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecimalError';
  }
}

export function isDecimalString(value: unknown): value is string {
  return typeof value === 'string' && DECIMAL_PATTERN.test(value);
}

/** A decimal string to its scaled bigint. Rejects anything the ledger would. */
export function parseDecimal(value: string): bigint {
  if (!DECIMAL_PATTERN.test(value)) {
    throw new DecimalError(
      `'${value}' is not a non-negative decimal with at most ${String(COST_SCALE)} places, written without a sign, exponent or leading zeroes.`,
    );
  }
  const [whole = '0', fraction = ''] = value.split('.');
  if (whole.length > MAX_INTEGER_DIGITS) {
    throw new DecimalError(`'${value}' exceeds NUMERIC(20,${String(COST_SCALE)}).`);
  }
  return BigInt(whole) * SCALE_FACTOR + BigInt(fraction.padEnd(COST_SCALE, '0'));
}

/** Back to the canonical string, always with all six places. */
export function formatDecimal(scaled: bigint): string {
  if (scaled < 0n) {
    throw new DecimalError(`A cost cannot be negative; got ${String(scaled)} scaled.`);
  }
  if (scaled > MAX_SCALED) {
    throw new DecimalError(`${String(scaled)} scaled exceeds NUMERIC(20,${String(COST_SCALE)}).`);
  }
  const whole = scaled / SCALE_FACTOR;
  const fraction = (scaled % SCALE_FACTOR).toString().padStart(COST_SCALE, '0');
  return `${whole.toString()}.${fraction}`;
}

/** Zero, written the way every other amount is. */
export const ZERO_COST = formatDecimal(0n);

/**
 * What `tokens` cost at `pricePerMillion`.
 *
 * ── Rounding, stated rather than inherited ──────────────────────────────────
 * The exact product rarely lands on a six-decimal boundary, so a rule is
 * needed and any rule loses or creates a fraction of a micro-dollar. This one
 * rounds HALF UP — the rule a reader checking the number by hand would apply,
 * which is worth more here than a marginally less biased alternative nobody
 * can reproduce mentally.
 *
 * All-integer: the numerator is a bigint product and the half is added before
 * a single integer division. No step of it is representable as a float.
 */
export function costOfTokens(tokens: number, pricePerMillionScaled: bigint): bigint {
  if (!Number.isInteger(tokens) || tokens < 0) {
    throw new DecimalError(`Token counts are non-negative integers; got ${String(tokens)}.`);
  }
  if (pricePerMillionScaled < 0n) {
    throw new DecimalError('A price cannot be negative.');
  }
  const numerator = BigInt(tokens) * pricePerMillionScaled;
  return (numerator + PRICE_UNIT_TOKENS / 2n) / PRICE_UNIT_TOKENS;
}

/** Sum, in scaled space, so no intermediate is ever a string or a float. */
export function sumScaled(values: readonly bigint[]): bigint {
  return values.reduce((total, value) => total + value, 0n);
}
