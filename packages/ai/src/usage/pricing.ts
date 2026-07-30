/**
 * The pricing registry — versioned reference data.
 *
 * Spec: `08-ai-platform/cost-management.md` §"Cost computation". Price tables
 * are versioned, and every cost row records the version it used. Without that,
 * a provider price change would silently rewrite the apparent cost of
 * historical work and make month-over-month margin analysis meaningless.
 *
 * ── This is not a second provider registry ──────────────────────────────────
 * It maps `(providerId, model)` to a price, where that one maps provider ids to
 * adapters. What they share is a DISCIPLINE, applied here rather than
 * duplicated: assembled at the process edge, duplicates refused, verified at
 * startup, immutable afterwards. A price that could change mid-process would
 * mean two calls in one run costing different amounts for the same tokens, with
 * nothing recording which rate applied.
 */

import { DecimalError, isDecimalString, parseDecimal } from './decimal.js';

/**
 * What one model costs, per MILLION tokens.
 *
 * Prices are strings for the same reason costs are: a price parsed from a
 * float has already lost precision before the first multiplication.
 */
export interface ModelPrice {
  readonly providerId: string;
  readonly model: string;
  readonly currency: string;
  /** Per million input tokens. */
  readonly inputPerMillion: string;
  /** Per million output tokens. */
  readonly outputPerMillion: string;
  /**
   * Per million cache-read tokens.
   *
   * Optional, and defaulting to the input price rather than to zero: a
   * provider that reports cached tokens without a discounted rate charges the
   * normal one, and defaulting to zero would under-meter every such call.
   */
  readonly cachedInputPerMillion?: string;
}

/** A price with its decimals already parsed. Nothing downstream re-parses. */
export interface ResolvedPrice {
  readonly providerId: string;
  readonly model: string;
  readonly currency: string;
  readonly pricingVersion: string;
  readonly inputScaled: bigint;
  readonly outputScaled: bigint;
  readonly cachedInputScaled: bigint;
}

export const PRICING_ERROR_CODES = [
  'DuplicatePrice',
  'InvalidPrice',
  'RegistrySealed',
  'UnknownPrice',
] as const;

export type PricingErrorCode = (typeof PRICING_ERROR_CODES)[number];

export class PricingError extends Error {
  readonly code: PricingErrorCode;

  constructor(code: PricingErrorCode, message: string) {
    super(message);
    this.name = 'PricingError';
    this.code = code;
  }
}

export function isPricingError(value: unknown): value is PricingError {
  return value instanceof PricingError;
}

const CURRENCY = /^[A-Z]{3}$/;
/** Free-form but present: 'openrouter-2026-07', 'v3'. */
const VERSION = /^[a-z0-9][a-z0-9._-]*$/i;

const key = (providerId: string, model: string): string => `${providerId}::${model}`;

/** What a price must satisfy. Checked at registration, where the mistake is. */
export function assertPriceValid(price: ModelPrice): void {
  if (typeof price.providerId !== 'string' || price.providerId.trim() === '') {
    throw new PricingError('InvalidPrice', 'A price names the provider it applies to.');
  }
  if (typeof price.model !== 'string' || price.model.trim() === '') {
    throw new PricingError(
      'InvalidPrice',
      `Provider '${price.providerId}' registered a price for no model.`,
    );
  }
  if (typeof price.currency !== 'string' || !CURRENCY.test(price.currency)) {
    throw new PricingError(
      'InvalidPrice',
      `'${String(price.currency)}' is not an ISO 4217 currency code.`,
    );
  }
  for (const [field, value] of [
    ['inputPerMillion', price.inputPerMillion],
    ['outputPerMillion', price.outputPerMillion],
    ['cachedInputPerMillion', price.cachedInputPerMillion],
  ] as const) {
    if (value === undefined) continue;
    if (!isDecimalString(value)) {
      throw new PricingError(
        'InvalidPrice',
        `${price.providerId}/${price.model} ${field} is '${String(value)}'; a price is a non-negative decimal string with at most six places — never a float, which loses money before the first multiplication.`,
      );
    }
  }
}

export interface PricingRegistry {
  /** Throws once sealed, on a duplicate, and on an invalid price. */
  register(price: ModelPrice): void;
  /** Throws once sealed, and on a pair that was never registered. */
  unregister(providerId: string, model: string): void;
  /**
   * The price, or null when none covers this model.
   *
   * Null rather than a throw: an unpriced model produces a zero-cost row
   * flagged `unpriced` plus an alert, because a missing price table entry is a
   * configuration defect that would otherwise appear as free work. Dropping
   * the row is the one outcome the spec forbids.
   */
  find(providerId: string, model: string): ResolvedPrice | null;
  /** Throws `UnknownPrice`, for callers that require one. */
  get(providerId: string, model: string): ResolvedPrice;
  has(providerId: string, model: string): boolean;
  /** Registration order, frozen. */
  list(): readonly ResolvedPrice[];
  readonly version: string;
  /** Ends registration. Idempotent. */
  seal(): void;
  readonly sealed: boolean;
}

export interface PricingRegistryOptions {
  /** Recorded on every cost row this registry prices. */
  readonly version: string;
  readonly prices?: readonly ModelPrice[];
}

export function createPricingRegistry(options: PricingRegistryOptions): PricingRegistry {
  if (typeof options.version !== 'string' || !VERSION.test(options.version)) {
    throw new PricingError(
      'InvalidPrice',
      `'${String(options.version)}' is not a usable pricing version; every cost row records one, and a blank version makes a historical cost unattributable to a rate.`,
    );
  }

  const prices = new Map<string, ResolvedPrice>();
  let sealed = false;

  const resolve = (price: ModelPrice): ResolvedPrice => {
    assertPriceValid(price);
    try {
      return {
        providerId: price.providerId,
        model: price.model,
        currency: price.currency,
        pricingVersion: options.version,
        inputScaled: parseDecimal(price.inputPerMillion),
        outputScaled: parseDecimal(price.outputPerMillion),
        // Defaults to the input rate, not to zero — see the field's note.
        cachedInputScaled: parseDecimal(price.cachedInputPerMillion ?? price.inputPerMillion),
      };
    } catch (error) {
      if (error instanceof DecimalError) {
        throw new PricingError(
          'InvalidPrice',
          `${price.providerId}/${price.model}: ${error.message}`,
        );
      }
      throw error;
    }
  };

  const registry: PricingRegistry = {
    register(price): void {
      if (sealed) {
        throw new PricingError(
          'RegistrySealed',
          `Cannot register ${String(price.providerId)}/${String(price.model)} after startup: prices are fixed when the process starts, so two calls in one run cannot cost different amounts for the same tokens.`,
        );
      }
      const resolved = resolve(price);
      const k = key(resolved.providerId, resolved.model);
      // Two entries for one model means the rate applied depends on
      // composition order, and nothing records which one it was.
      if (prices.has(k)) {
        throw new PricingError(
          'DuplicatePrice',
          `${resolved.providerId}/${resolved.model} is already priced; a second entry would silently shadow the first.`,
        );
      }
      prices.set(k, resolved);
    },

    unregister(providerId, model): void {
      if (sealed) {
        throw new PricingError(
          'RegistrySealed',
          `Cannot unregister ${providerId}/${model} after startup.`,
        );
      }
      if (!prices.delete(key(providerId, model))) {
        throw new PricingError(
          'UnknownPrice',
          `${providerId}/${model} is not priced, so there is nothing to remove.`,
        );
      }
    },

    find(providerId, model): ResolvedPrice | null {
      return prices.get(key(providerId, model)) ?? null;
    },

    get(providerId, model): ResolvedPrice {
      const found = prices.get(key(providerId, model));
      if (found === undefined) {
        throw new PricingError(
          'UnknownPrice',
          `No price for ${providerId}/${model} in table '${options.version}'. Priced: ${[...prices.keys()].join(', ') || '(none)'}.`,
        );
      }
      return found;
    },

    has(providerId, model): boolean {
      return prices.has(key(providerId, model));
    },

    list: () => Object.freeze([...prices.values()]),

    get version(): string {
      return options.version;
    },

    seal(): void {
      sealed = true;
    },

    get sealed(): boolean {
      return sealed;
    },
  };

  for (const price of options.prices ?? []) registry.register(price);
  return registry;
}
