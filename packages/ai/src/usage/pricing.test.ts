/**
 * The pricing registry.
 *
 * Two properties carry it. A duplicate is refused, because otherwise the rate
 * applied depends on composition order and nothing records which one it was.
 * And it shuts after startup, because a price that could change mid-process
 * means two calls in one run costing different amounts for the same tokens.
 */
import { describe, expect, it } from 'vitest';

import { formatDecimal } from './decimal.js';
import {
  assertPriceValid,
  createPricingRegistry,
  isPricingError,
  PRICING_ERROR_CODES,
  PricingError,
  type ModelPrice,
  type PricingRegistry,
} from './pricing.js';

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

function loaded(...prices: ModelPrice[]): PricingRegistry {
  return createPricingRegistry({ version: 'v1', prices });
}

describe('registration', () => {
  it('registers and resolves a price', () => {
    const registry = loaded(price());
    const found = registry.get('openai', 'gpt-4o');
    expect(found.currency).toBe('USD');
    expect(formatDecimal(found.inputScaled)).toBe('2.500000');
    expect(formatDecimal(found.outputScaled)).toBe('10.000000');
  });

  it('records the pricing version on every resolved price', () => {
    expect(loaded(price()).get('openai', 'gpt-4o').pricingVersion).toBe('v1');
  });

  it('keeps registration order', () => {
    const registry = loaded(price({ model: 'a' }), price({ model: 'b' }), price({ model: 'c' }));
    expect(registry.list().map((p) => p.model)).toEqual(['a', 'b', 'c']);
  });

  it('prices the same model for two providers', () => {
    const registry = loaded(price({ providerId: 'openai' }), price({ providerId: 'azure-openai' }));
    expect(registry.has('openai', 'gpt-4o')).toBe(true);
    expect(registry.has('azure-openai', 'gpt-4o')).toBe(true);
  });

  // A second entry would silently shadow the first.
  it('refuses a duplicate provider and model', () => {
    const registry = loaded(price());
    expect(() => {
      registry.register(price({ inputPerMillion: '99' }));
    }).toThrow(PricingError);
  });

  it('reports a duplicate as DuplicatePrice and names the pair', () => {
    const registry = loaded(price());
    try {
      registry.register(price());
      expect.unreachable('must refuse');
    } catch (error) {
      expect(isPricingError(error)).toBe(true);
      expect((error as PricingError).code).toBe('DuplicatePrice');
      expect((error as PricingError).message).toContain('openai/gpt-4o');
    }
  });

  it('leaves the first price intact after a rejected duplicate', () => {
    const registry = loaded(price());
    expect(() => {
      registry.register(price({ inputPerMillion: '99' }));
    }).toThrow();
    expect(formatDecimal(registry.get('openai', 'gpt-4o').inputScaled)).toBe('2.500000');
  });

  it('refuses a duplicate supplied in the constructor list', () => {
    expect(() => loaded(price(), price())).toThrow(/already priced/);
  });
});

describe('a price must be exact before it is stored', () => {
  it('refuses a float, which has already lost precision', () => {
    expect(() => {
      assertPriceValid(price({ inputPerMillion: 2.5 as never }));
    }).toThrow(/never a float/);
  });

  it('refuses a malformed decimal', () => {
    for (const value of ['-1', '1e-6', '.5', '0.0000001', '01.5', '']) {
      expect(() => {
        assertPriceValid(price({ inputPerMillion: value }));
      }, value).toThrow(PricingError);
    }
  });

  it('refuses a price with no provider or model', () => {
    expect(() => {
      assertPriceValid(price({ providerId: '  ' }));
    }).toThrow(/names the provider/);
    expect(() => {
      assertPriceValid(price({ model: '' }));
    }).toThrow(/no model/);
  });

  it('refuses a currency that is not ISO 4217', () => {
    for (const currency of ['usd', 'DOLLARS', 'US', '']) {
      expect(() => {
        assertPriceValid(price({ currency }));
      }, currency).toThrow(/ISO 4217/);
    }
  });

  it('accepts a zero rate, which is a real commercial arrangement', () => {
    expect(() => {
      assertPriceValid(price({ inputPerMillion: '0', outputPerMillion: '0' }));
    }).not.toThrow();
  });

  it('reports every invalid price as InvalidPrice', () => {
    try {
      loaded(price({ inputPerMillion: 'free' }));
      expect.unreachable('must refuse');
    } catch (error) {
      expect((error as PricingError).code).toBe('InvalidPrice');
    }
  });

  // Every cost row records a version; a blank one makes a historical cost
  // unattributable to a rate.
  it('refuses a registry with no usable version', () => {
    for (const version of ['', '  ', undefined as never]) {
      expect(() => createPricingRegistry({ version }), String(version)).toThrow(/pricing version/);
    }
  });
});

describe('cached input pricing', () => {
  // A provider that reports cached tokens without a discounted rate charges
  // the normal one; defaulting to zero would under-meter every such call.
  it('defaults to the input rate, not to zero', () => {
    const resolved = loaded(price()).get('openai', 'gpt-4o');
    expect(resolved.cachedInputScaled).toBe(resolved.inputScaled);
  });

  it('uses a discounted rate when one is quoted', () => {
    const registry = loaded(price({ cachedInputPerMillion: '0.25' }));
    expect(formatDecimal(registry.get('openai', 'gpt-4o').cachedInputScaled)).toBe('0.250000');
  });

  it('accepts a cached rate of zero when that is the arrangement', () => {
    const registry = loaded(price({ cachedInputPerMillion: '0' }));
    expect(formatDecimal(registry.get('openai', 'gpt-4o').cachedInputScaled)).toBe('0.000000');
  });

  it('refuses a malformed cached rate', () => {
    expect(() => loaded(price({ cachedInputPerMillion: '-1' }))).toThrow(PricingError);
  });
});

describe('lookup', () => {
  const registry = loaded(price(), price({ model: 'gpt-4o-mini', inputPerMillion: '0.15' }));

  // Null rather than a throw: a missing price produces a flagged zero row, not
  // a dropped one.
  it('returns null for a model nothing prices', () => {
    expect(registry.find('openai', 'gpt-5')).toBeNull();
    expect(registry.find('anthropic', 'gpt-4o')).toBeNull();
  });

  it('throws from get, for callers that require a price', () => {
    expect(() => registry.get('openai', 'gpt-5')).toThrow(/No price for openai\/gpt-5/);
  });

  it('names the table and what it prices, so a typo is visible', () => {
    try {
      registry.get('openai', 'gpt-4');
      expect.unreachable('must throw');
    } catch (error) {
      expect((error as PricingError).code).toBe('UnknownPrice');
      expect((error as PricingError).message).toContain("'v1'");
      expect((error as PricingError).message).toContain('openai::gpt-4o');
    }
  });

  it('says so plainly when nothing is priced', () => {
    expect(() => createPricingRegistry({ version: 'v1' }).get('openai', 'gpt-4o')).toThrow(
      /\(none\)/,
    );
  });

  it('reports absence without throwing', () => {
    expect(registry.has('openai', 'gpt-4o')).toBe(true);
    expect(registry.has('openai', 'gpt-5')).toBe(false);
  });

  it('does not confuse one provider with another', () => {
    expect(registry.find('azure-openai', 'gpt-4o')).toBeNull();
  });
});

describe('immutability after startup', () => {
  it('is open before sealing', () => {
    const registry = createPricingRegistry({ version: 'v1' });
    expect(registry.sealed).toBe(false);
    expect(() => {
      registry.register(price());
    }).not.toThrow();
  });

  it('refuses a registration after sealing', () => {
    const registry = loaded(price());
    registry.seal();
    expect(registry.sealed).toBe(true);
    expect(() => {
      registry.register(price({ model: 'gpt-4o-mini' }));
    }).toThrow(/after startup/);
  });

  it('refuses an unregistration after sealing', () => {
    const registry = loaded(price());
    registry.seal();
    expect(() => {
      registry.unregister('openai', 'gpt-4o');
    }).toThrow(PricingError);
  });

  it('reports a write after sealing as RegistrySealed', () => {
    const registry = loaded(price());
    registry.seal();
    try {
      registry.register(price({ model: 'other' }));
      expect.unreachable('must refuse');
    } catch (error) {
      expect((error as PricingError).code).toBe('RegistrySealed');
    }
  });

  it('still reads after sealing — that is the point of sealing', () => {
    const registry = loaded(price());
    registry.seal();
    expect(registry.get('openai', 'gpt-4o').model).toBe('gpt-4o');
    expect(registry.list()).toHaveLength(1);
  });

  it('hands out a frozen list', () => {
    const registry = loaded(price());
    const list = registry.list();
    expect(Object.isFrozen(list)).toBe(true);
  });

  it('seals idempotently', () => {
    const registry = loaded(price());
    registry.seal();
    expect(() => {
      registry.seal();
    }).not.toThrow();
    expect(registry.sealed).toBe(true);
  });
});

describe('unregistration, before the door closes', () => {
  it('removes a price and frees the pair', () => {
    const registry = loaded(price());
    registry.unregister('openai', 'gpt-4o');
    expect(registry.has('openai', 'gpt-4o')).toBe(false);
    expect(() => {
      registry.register(price({ inputPerMillion: '3' }));
    }).not.toThrow();
  });

  it('refuses to remove what was never priced', () => {
    const registry = loaded(price());
    try {
      registry.unregister('openai', 'gpt-5');
      expect.unreachable('must refuse');
    } catch (error) {
      expect((error as PricingError).code).toBe('UnknownPrice');
    }
  });

  it('names its error codes in one place', () => {
    expect([...PRICING_ERROR_CODES].sort()).toEqual([
      'DuplicatePrice',
      'InvalidPrice',
      'RegistrySealed',
      'UnknownPrice',
    ]);
  });
});
