/**
 * The cost calculator.
 *
 * Deterministic by construction: integers in, integers through, a string out.
 * The same tokens at the same price produce the same six decimal places every
 * time, on every machine, because no step of the computation is representable
 * as a double.
 *
 * ── An unpriced model is not an error ───────────────────────────────────────
 * It produces a zero-cost breakdown flagged `unpriced`. Dropping the row is the
 * one outcome `cost-management.md` forbids: a missing price table entry is a
 * configuration defect, and a dropped row makes it look like free work. The
 * flag is what turns it into an alert instead.
 */

import type { CostBreakdown, TokenUsage } from '@contentos/contracts';

import { costOfTokens, formatDecimal, sumScaled, ZERO_COST } from './decimal.js';
import type { PricingRegistry, ResolvedPrice } from './pricing.js';

export interface CostInput {
  readonly tokens: TokenUsage;
  /** Prompt-cache reads, priced at the cached rate. Part of `promptTokens`. */
  readonly cachedTokens?: number;
  readonly providerId: string;
  readonly model: string;
}

/** The currency an unpriced row is denominated in — it has no price to ask. */
export const DEFAULT_CURRENCY = 'USD';

/** A breakdown of nothing, for a model no table covers. */
export function unpricedBreakdown(pricingVersion: string): CostBreakdown {
  return Object.freeze({
    currency: DEFAULT_CURRENCY,
    promptCost: ZERO_COST,
    completionCost: ZERO_COST,
    cachedCost: ZERO_COST,
    totalCost: ZERO_COST,
    pricingVersion,
    unpriced: true,
  });
}

/**
 * Cost from tokens and a resolved price.
 *
 * Cached tokens are subtracted from the prompt tokens and priced separately:
 * a provider reporting them has already counted them in `promptTokens`, so
 * pricing both would charge the cache read twice.
 */
export function costFrom(input: CostInput, price: ResolvedPrice): CostBreakdown {
  const cached = input.cachedTokens ?? 0;
  const billablePrompt = Math.max(0, input.tokens.promptTokens - cached);

  const promptScaled = costOfTokens(billablePrompt, price.inputScaled);
  const completionScaled = costOfTokens(input.tokens.completionTokens, price.outputScaled);
  const cachedScaled = costOfTokens(cached, price.cachedInputScaled);

  return Object.freeze({
    currency: price.currency,
    promptCost: formatDecimal(promptScaled),
    completionCost: formatDecimal(completionScaled),
    cachedCost: formatDecimal(cachedScaled),
    // Summed in scaled space: adding three formatted strings would mean
    // parsing them back, and the total is what a ledger reads.
    totalCost: formatDecimal(sumScaled([promptScaled, completionScaled, cachedScaled])),
    pricingVersion: price.pricingVersion,
    unpriced: false,
  });
}

/**
 * Cost from tokens, looked up in a registry.
 *
 * Never throws for a missing price — see the note at the top of the file.
 */
export function computeCost(input: CostInput, pricing: PricingRegistry): CostBreakdown {
  const price = pricing.find(input.providerId, input.model);
  return price === null ? unpricedBreakdown(pricing.version) : costFrom(input, price);
}
