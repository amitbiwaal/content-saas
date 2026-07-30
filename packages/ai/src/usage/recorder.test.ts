/**
 * The usage recorder.
 *
 * What it produces is the record of what a call cost. What it must never do is
 * produce a wrong one: an invalid record priced anyway would put an
 * approximately-correct number where an exactly-correct one is expected, and
 * the cost path is the one place that cannot be approximately right.
 *
 * It also writes nothing. There is no executor, no transaction and no table
 * anywhere in this file.
 */
import { describe, expect, it } from 'vitest';

import type { AIResponse, TokenUsage, UsageMetadata } from '@contentos/contracts';

import { createPricingRegistry, type ModelPrice, type PricingRegistry } from './pricing.js';
import {
  isLedgerCompatibleAmount,
  isUsageError,
  ledgerKeyFor,
  recordResponseUsage,
  recordUsage,
  UNKNOWN_TOKENIZER,
  UsageError,
} from './recorder.js';

const WS = '018f7a1e-0000-7000-8000-0000000000bb';
const ORG = '018f7a1e-0000-7000-8000-0000000000aa';
const CORRELATION = '018f7a1e-0000-7000-8000-0000000000dd';

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

function metadata(over: Partial<UsageMetadata> = {}): UsageMetadata {
  return {
    tenantId: WS,
    organizationId: ORG,
    correlationId: CORRELATION,
    idempotencyKey: 'wf-1:outline',
    attempt: 1,
    taskType: 'planning.outline',
    providerId: 'openai',
    model: 'gpt-4o',
    promptVersion: 'planning.outline@7',
    runId: 'wf-1',
    stepId: 'outline',
    ...over,
  };
}

const record = (over: Partial<Parameters<typeof recordUsage>[0]> = {}) =>
  recordUsage({ tokens: tokens(1000, 500), metadata: metadata(), pricing: pricing(), ...over });

describe('canonical usage generation', () => {
  it('records the tokens, the cost and the attribution', () => {
    const result = record();
    expect(result.record.tokens).toEqual(tokens(1000, 500));
    expect(result.record.cost.totalCost).toBe('0.007500');
    expect(result.record.metadata.correlationId).toBe(CORRELATION);
  });

  it('prices from the provider and model on the record', () => {
    expect(record().record.cost.unpriced).toBe(false);
    expect(record({ metadata: metadata({ model: 'gpt-5' }) }).record.cost.unpriced).toBe(true);
  });

  it('records whether the counts were estimated', () => {
    expect(record().record.estimated).toBe(false);
    expect(record({ estimated: true }).record.estimated).toBe(true);
  });

  // Where counts came from, recorded rather than guessed at later.
  it('records the tokenizer, naming it unknown when nobody said', () => {
    expect(record().record.tokenizer).toBe(UNKNOWN_TOKENIZER);
    expect(record({ tokenizer: 'o200k_base' }).record.tokenizer).toBe('o200k_base');
  });

  it('records cached tokens and whether the call was a cache hit', () => {
    const result = record({ cachedTokens: 400, cacheHit: true });
    expect(result.record.cachedTokens).toBe(400);
    expect(result.record.cacheHit).toBe(true);
  });

  it('defaults cached tokens to zero and cacheHit to false', () => {
    expect(record().record.cachedTokens).toBe(0);
    expect(record().record.cacheHit).toBe(false);
  });

  it('produces an identical record from identical input', () => {
    expect(JSON.stringify(record())).toBe(JSON.stringify(record()));
  });
});

describe('the record is immutable', () => {
  it('freezes the result, the record, the tokens and the metadata', () => {
    const result = record();
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.record)).toBe(true);
    expect(Object.isFrozen(result.record.tokens)).toBe(true);
    expect(Object.isFrozen(result.record.metadata)).toBe(true);
    expect(Object.isFrozen(result.record.cost)).toBe(true);
  });

  it('refuses a write to the cost', () => {
    const result = record();
    expect(() => {
      (result.record.cost as { totalCost: string }).totalCost = '0.000000';
    }).toThrow();
  });

  // A caller mutating what it passed in must not change what was recorded.
  it('copies the tokens and metadata rather than sharing them', () => {
    const supplied = tokens(1000, 500);
    const attribution = metadata();
    const result = recordUsage({ tokens: supplied, metadata: attribution, pricing: pricing() });
    expect(result.record.tokens).not.toBe(supplied);
    expect(result.record.metadata).not.toBe(attribution);
  });
});

describe('ledger compatibility', () => {
  // The claim this increment makes about its output, checked directly.
  it('produces an amount the ledger format accepts', () => {
    expect(isLedgerCompatibleAmount(record().chargeableAmount)).toBe(true);
  });

  it('produces a ledger-shaped amount for every part of the breakdown', () => {
    const cost = record().record.cost;
    for (const amount of [cost.promptCost, cost.completionCost, cost.cachedCost, cost.totalCost]) {
      expect(isLedgerCompatibleAmount(amount), amount).toBe(true);
    }
  });

  it('writes every amount with all six places, as NUMERIC(20,6) stores', () => {
    for (const amount of [record().chargeableAmount, record().record.cost.promptCost]) {
      expect(amount).toMatch(/^\d+\.\d{6}$/);
    }
  });

  it('refuses to call a float ledger-compatible', () => {
    expect(isLedgerCompatibleAmount(0.0075)).toBe(false);
    expect(isLedgerCompatibleAmount('0.0075')).toBe(true);
  });

  // Metering is keyed on (idempotencyKey, attempt), so each genuine provider
  // call meters exactly once and a retry is a second charge rather than a
  // duplicate of the first.
  it('keys a ledger entry on the request and the attempt', () => {
    expect(ledgerKeyFor('wf-1:outline', 1)).toBe('wf-1:outline#1');
    expect(record().ledgerIdempotencyKey).toBe('wf-1:outline#1');
  });

  it('gives two attempts of one request two keys', () => {
    const first = record({ metadata: metadata({ attempt: 1 }) });
    const second = record({ metadata: metadata({ attempt: 2 }) });
    expect(second.ledgerIdempotencyKey).not.toBe(first.ledgerIdempotencyKey);
  });

  it('gives two recordings of one attempt the same key', () => {
    expect(record().ledgerIdempotencyKey).toBe(record().ledgerIdempotencyKey);
  });
});

describe('what may reach a ledger', () => {
  it('marks a priced, non-zero call chargeable', () => {
    const result = record();
    expect(result.chargeable).toBe(true);
    expect(result.chargeableAmount).toBe('0.007500');
  });

  // A ledger entry for nothing costs more to store and reconcile than the
  // amount it records.
  it('marks a zero-cost call unchargeable, and still records it', () => {
    const result = record({ tokens: tokens(0, 0) });
    expect(result.chargeable).toBe(false);
    expect(result.chargeableAmount).toBe('0.000000');
    expect(result.record.tokens.totalTokens).toBe(0);
  });

  it('marks an unpriced call unchargeable, and still records it', () => {
    const result = record({ metadata: metadata({ model: 'gpt-5' }) });
    expect(result.chargeable).toBe(false);
    expect(result.record.cost.unpriced).toBe(true);
    expect(result.record.metadata.model).toBe('gpt-5');
  });

  it('marks a genuinely free priced call unchargeable but priced', () => {
    const free = pricing(price({ inputPerMillion: '0', outputPerMillion: '0' }));
    const result = record({ pricing: free });
    expect(result.chargeable).toBe(false);
    expect(result.record.cost.unpriced).toBe(false);
  });
});

describe('invalid usage is refused', () => {
  it('refuses a negative or fractional count', () => {
    for (const bad of [
      { promptTokens: -1, completionTokens: 0, totalTokens: -1 },
      { promptTokens: 1.5, completionTokens: 0, totalTokens: 1.5 },
    ]) {
      expect(() => record({ tokens: bad }), JSON.stringify(bad)).toThrow(UsageError);
    }
  });

  // Two numbers that do not add up mean one of them is wrong, and cost reads
  // both of them.
  it('refuses counts that do not add up', () => {
    expect(() =>
      record({ tokens: { promptTokens: 100, completionTokens: 100, totalTokens: 999 } }),
    ).toThrow(/must equal/);
  });

  it('refuses a negative cached count', () => {
    expect(() => record({ cachedTokens: -1 })).toThrow(UsageError);
  });

  // More cached than prompt means the two came from different calls.
  it('refuses more cached tokens than prompt tokens', () => {
    expect(() => record({ tokens: tokens(100, 0), cachedTokens: 500 })).toThrow(/exceeds prompt/);
  });

  it('reports token problems as InvalidUsage', () => {
    try {
      record({ tokens: { promptTokens: -1, completionTokens: 0, totalTokens: -1 } });
      expect.unreachable('must refuse');
    } catch (error) {
      expect(isUsageError(error)).toBe(true);
      expect((error as UsageError).code).toBe('InvalidUsage');
    }
  });

  // A caller wrong in three ways should learn all three.
  it('reports every problem at once', () => {
    try {
      record({ tokens: { promptTokens: -1, completionTokens: -2, totalTokens: 99 } });
      expect.unreachable('must refuse');
    } catch (error) {
      expect((error as UsageError).issues.length).toBeGreaterThanOrEqual(3);
    }
  });

  it('prices nothing when the usage is invalid', () => {
    // The throw is the assertion: an invalid record must not produce a cost.
    expect(() =>
      record({ tokens: { promptTokens: 1, completionTokens: 1, totalTokens: 5 } }),
    ).toThrow();
  });
});

describe('invalid attribution is refused', () => {
  it('requires the three identifiers to be UUIDs', () => {
    for (const field of ['tenantId', 'organizationId', 'correlationId'] as const) {
      expect(() => record({ metadata: metadata({ [field]: 'nope' }) }), field).toThrow(UsageError);
    }
  });

  // A record without a correlation id is a defect: it is the join that makes
  // "what did this run cost?" a query rather than an estimate.
  it('refuses a record with no correlation id', () => {
    expect(() => record({ metadata: metadata({ correlationId: '' }) })).toThrow(/correlationId/);
  });

  it('requires the identifying strings', () => {
    for (const field of ['idempotencyKey', 'taskType', 'providerId', 'model'] as const) {
      expect(() => record({ metadata: metadata({ [field]: '  ' }) }), field).toThrow(UsageError);
    }
  });

  it('requires an attempt of at least one', () => {
    for (const attempt of [0, -1, 1.5]) {
      expect(() => record({ metadata: metadata({ attempt }) }), String(attempt)).toThrow(
        UsageError,
      );
    }
  });

  // Present-but-null, never absent — the optional-versus-null ambiguity is the
  // one that makes a query silently skip rows.
  it('requires the nullable fields to be present', () => {
    const { promptVersion: _dropped, ...rest } = metadata();
    expect(() => record({ metadata: rest as UsageMetadata })).toThrow(/promptVersion/);
  });

  it('accepts null for the fields that may not apply', () => {
    expect(() =>
      record({ metadata: metadata({ promptVersion: null, runId: null, stepId: null }) }),
    ).not.toThrow();
  });

  it('reports attribution problems as InvalidMetadata', () => {
    try {
      record({ metadata: metadata({ tenantId: 'nope' }) });
      expect.unreachable('must refuse');
    } catch (error) {
      expect((error as UsageError).code).toBe('InvalidMetadata');
    }
  });
});

describe('metering a provider response', () => {
  function response(over: Partial<AIResponse> = {}): AIResponse {
    return {
      idempotencyKey: 'wf-1:outline',
      providerId: 'openai',
      model: 'gpt-4o',
      content: 'An outline.',
      finishReason: 'stop',
      usage: {
        tokens: tokens(1000, 500),
        tokensEstimated: false,
        cost: { currency: 'USD', amount: '0.000000' },
        latencyMs: 91,
      },
      providerMetadata: {},
      ...over,
    };
  }

  const attribution = {
    tenantId: WS,
    organizationId: ORG,
    correlationId: CORRELATION,
    attempt: 1,
    taskType: 'planning.outline',
    promptVersion: 'planning.outline@7',
    runId: 'wf-1',
    stepId: 'outline',
  };

  it('meters straight from the response', () => {
    const result = recordResponseUsage(response(), attribution, pricing());
    expect(result.record.cost.totalCost).toBe('0.007500');
    expect(result.ledgerIdempotencyKey).toBe('wf-1:outline#1');
  });

  // The model that actually ran is not necessarily the one asked for, and
  // pricing the wrong one is how a fallback becomes invisible in the report.
  it('prices the model that actually ran', () => {
    const fellBack = response({ model: 'gpt-4o-mini' });
    const registry = pricing(
      price(),
      price({ model: 'gpt-4o-mini', inputPerMillion: '0.15', outputPerMillion: '0.6' }),
    );
    const result = recordResponseUsage(fellBack, attribution, registry);
    expect(result.record.metadata.model).toBe('gpt-4o-mini');
    expect(result.record.cost.totalCost).toBe('0.000450');
  });

  it('takes the provider from the response too', () => {
    const result = recordResponseUsage(
      response({ providerId: 'azure-openai' }),
      attribution,
      pricing(),
    );
    expect(result.record.metadata.providerId).toBe('azure-openai');
    expect(result.record.cost.unpriced).toBe(true);
  });

  it('carries the estimate flag through from the response', () => {
    const estimated = response({
      usage: { ...response().usage, tokensEstimated: true },
    });
    expect(recordResponseUsage(estimated, attribution, pricing()).record.estimated).toBe(true);
  });

  it('takes the idempotency key from the response, which echoes the request', () => {
    const other = response({ idempotencyKey: 'wf-9:draft' });
    expect(recordResponseUsage(other, attribution, pricing()).ledgerIdempotencyKey).toBe(
      'wf-9:draft#1',
    );
  });

  it('accepts cache details the response does not carry', () => {
    const result = recordResponseUsage(response(), attribution, pricing(), {
      tokenizer: 'o200k_base',
      cachedTokens: 400,
      cacheHit: true,
    });
    expect(result.record.tokenizer).toBe('o200k_base');
    expect(result.record.cacheHit).toBe(true);
  });
});
