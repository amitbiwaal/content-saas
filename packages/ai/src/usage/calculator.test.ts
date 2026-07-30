/**
 * The cost calculator.
 *
 * Deterministic, exact, and — for a model nothing prices — still a row. That
 * last one is the rule most easily lost: dropping the row would make a missing
 * price table entry look like free work, which is the one outcome
 * `cost-management.md` forbids.
 */
import { describe, expect, it } from 'vitest';

import type { TokenUsage } from '@contentos/contracts';

import { computeCost, costFrom, DEFAULT_CURRENCY, unpricedBreakdown } from './calculator.js';
import { createPricingRegistry, type ModelPrice, type PricingRegistry } from './pricing.js';

const tokens = (promptTokens: number, completionTokens: number): TokenUsage => ({
  promptTokens,
  completionTokens,
  totalTokens: promptTokens + completionTokens,
});

function price(over: Partial<ModelPrice> = {}): ModelPrice {
  return {
    providerId: 'openai',
    model: 'gpt-4o',
    currency: 'USD',
    inputPerMillion: '2.5',
    outputPerMillion: '10',
    ...over,
  };
}

const pricing = (...prices: ModelPrice[]): PricingRegistry =>
  createPricingRegistry({
    version: 'table-2026-07',
    prices: prices.length > 0 ? prices : [price()],
  });

const input = (over: Partial<Parameters<typeof computeCost>[0]> = {}) => ({
  tokens: tokens(1000, 500),
  providerId: 'openai',
  model: 'gpt-4o',
  ...over,
});

describe('a priced call', () => {
  it('costs input and output at their own rates', () => {
    const cost = computeCost(input(), pricing());
    // 1000 @ $2.50/M = 0.0025; 500 @ $10/M = 0.005.
    expect(cost.promptCost).toBe('0.002500');
    expect(cost.completionCost).toBe('0.005000');
    expect(cost.totalCost).toBe('0.007500');
  });

  it('records the currency and the price table version', () => {
    const cost = computeCost(input(), pricing());
    expect(cost.currency).toBe('USD');
    expect(cost.pricingVersion).toBe('table-2026-07');
    expect(cost.unpriced).toBe(false);
  });

  it('totals exactly what the parts add to', () => {
    const cost = computeCost(input({ tokens: tokens(333_333, 111_111) }), pricing());
    const sum = Number(cost.promptCost) + Number(cost.completionCost) + Number(cost.cachedCost);
    expect(Number(cost.totalCost)).toBeCloseTo(sum, 6);
  });

  it('costs a call with no output', () => {
    const cost = computeCost(input({ tokens: tokens(1000, 0) }), pricing());
    expect(cost.completionCost).toBe('0.000000');
    expect(cost.totalCost).toBe('0.002500');
  });

  it('costs a call with no tokens at all at zero, and still prices it', () => {
    const cost = computeCost(input({ tokens: tokens(0, 0) }), pricing());
    expect(cost.totalCost).toBe('0.000000');
    expect(cost.unpriced).toBe(false);
  });

  it('costs a large call without losing a micro-dollar', () => {
    const cost = computeCost(input({ tokens: tokens(1_000_000, 1_000_000) }), pricing());
    expect(cost.promptCost).toBe('2.500000');
    expect(cost.completionCost).toBe('10.000000');
    expect(cost.totalCost).toBe('12.500000');
  });
});

describe('cost is deterministic', () => {
  it('produces an identical breakdown every time', () => {
    const registry = pricing();
    const first = computeCost(input({ tokens: tokens(123_457, 65_432) }), registry);
    for (let i = 0; i < 50; i += 1) {
      expect(computeCost(input({ tokens: tokens(123_457, 65_432) }), registry)).toEqual(first);
    }
  });

  it('produces an identical breakdown from a rebuilt registry', () => {
    const a = computeCost(input(), pricing());
    const b = computeCost(input(), pricing());
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  // Different rates must give different costs, or "deterministic" would be
  // satisfied by a constant.
  it('changes when the price changes', () => {
    const cheap = computeCost(input(), pricing(price({ inputPerMillion: '1' })));
    const dear = computeCost(input(), pricing(price({ inputPerMillion: '5' })));
    expect(dear.promptCost).not.toBe(cheap.promptCost);
  });

  it('changes when the tokens change', () => {
    const registry = pricing();
    const small = computeCost(input({ tokens: tokens(10, 10) }), registry);
    const large = computeCost(input({ tokens: tokens(10_000, 10_000) }), registry);
    expect(large.totalCost).not.toBe(small.totalCost);
  });
});

describe('cached tokens', () => {
  // A provider reporting cache reads has already counted them in promptTokens,
  // so pricing both would charge the cache read twice.
  it('subtracts cached tokens from the billable prompt', () => {
    const cost = computeCost(
      input({ tokens: tokens(1000, 0), cachedTokens: 400 }),
      pricing(price({ cachedInputPerMillion: '0.25' })),
    );
    // 600 @ $2.50/M = 0.0015; 400 @ $0.25/M = 0.0001.
    expect(cost.promptCost).toBe('0.001500');
    expect(cost.cachedCost).toBe('0.000100');
    expect(cost.totalCost).toBe('0.001600');
  });

  it('costs the same as an uncached call when the rates match', () => {
    const registry = pricing();
    const uncached = computeCost(input({ tokens: tokens(1000, 0) }), registry);
    const cached = computeCost(input({ tokens: tokens(1000, 0), cachedTokens: 400 }), registry);
    expect(cached.totalCost).toBe(uncached.totalCost);
  });

  it('makes the saving visible when a discounted rate is quoted', () => {
    const registry = pricing(price({ cachedInputPerMillion: '0' }));
    const cached = computeCost(input({ tokens: tokens(1000, 0), cachedTokens: 1000 }), registry);
    expect(cached.totalCost).toBe('0.000000');
    expect(cached.cachedCost).toBe('0.000000');
  });

  it('never bills a negative prompt when cached exceeds prompt', () => {
    const cost = computeCost(input({ tokens: tokens(100, 0), cachedTokens: 500 }), pricing());
    expect(cost.promptCost).toBe('0.000000');
  });

  it('reports zero cached cost when nothing was cached', () => {
    expect(computeCost(input(), pricing()).cachedCost).toBe('0.000000');
  });
});

describe('an unpriced model is a row, not a gap', () => {
  it('produces a zero-cost breakdown flagged unpriced', () => {
    const cost = computeCost(input({ model: 'gpt-5' }), pricing());
    expect(cost.unpriced).toBe(true);
    expect(cost.totalCost).toBe('0.000000');
    expect(cost.promptCost).toBe('0.000000');
    expect(cost.completionCost).toBe('0.000000');
  });

  it('does not throw, because a dropped row looks like free work', () => {
    expect(() => computeCost(input({ model: 'gpt-5' }), pricing())).not.toThrow();
  });

  it('still records which table failed to price it', () => {
    expect(computeCost(input({ model: 'gpt-5' }), pricing()).pricingVersion).toBe('table-2026-07');
  });

  it('treats an unknown provider the same way', () => {
    expect(computeCost(input({ providerId: 'anthropic' }), pricing()).unpriced).toBe(true);
  });

  it('denominates an unpriced row in the default currency', () => {
    expect(unpricedBreakdown('v1').currency).toBe(DEFAULT_CURRENCY);
  });

  it('is distinguishable from a genuinely free priced call', () => {
    const free = computeCost(
      input(),
      pricing(price({ inputPerMillion: '0', outputPerMillion: '0' })),
    );
    const unknown = computeCost(input({ model: 'gpt-5' }), pricing());
    expect(free.totalCost).toBe(unknown.totalCost);
    expect(free.unpriced).toBe(false);
    expect(unknown.unpriced).toBe(true);
  });
});

describe('the breakdown is immutable', () => {
  it('is frozen', () => {
    expect(Object.isFrozen(computeCost(input(), pricing()))).toBe(true);
    expect(Object.isFrozen(unpricedBreakdown('v1'))).toBe(true);
  });

  it('refuses a write', () => {
    const cost = computeCost(input(), pricing());
    expect(() => {
      (cost as { totalCost: string }).totalCost = '0.000000';
    }).toThrow();
  });
});

describe('costFrom, given a resolved price directly', () => {
  it('prices without consulting a registry', () => {
    const resolved = pricing().get('openai', 'gpt-4o');
    const cost = costFrom(input(), resolved);
    expect(cost.totalCost).toBe('0.007500');
    expect(cost.pricingVersion).toBe('table-2026-07');
  });
});
