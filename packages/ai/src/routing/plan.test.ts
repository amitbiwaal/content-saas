import { describe, expect, it } from 'vitest';

import {
  EXECUTION_MODES,
  freezePlan,
  isRoutingReason,
  isRoutingRejectionCode,
  ROUTING_POLICIES,
  ROUTING_REASONS,
  ROUTING_REJECTION_CODES,
  STREAMING_MODES,
  type ExecutionPlan,
} from './plan.js';

const plan = (): ExecutionPlan => ({
  providerId: 'openai',
  model: 'gpt-4o-2026-05-01',
  canonicalModel: 'writing.standard',
  streamingMode: 'native',
  capability: 'chat',
  executionMode: 'buffered',
  fallbacks: [
    {
      providerId: 'anthropic',
      model: 'claude',
      canonicalModel: 'writing.standard',
      streamingMode: 'native',
    },
  ],
  policy: 'global-default',
  policyVersion: 'v1',
  reasons: ['routing.global_default'],
});

describe('the vocabularies', () => {
  it('has no duplicates in any of them', () => {
    for (const vocabulary of [
      EXECUTION_MODES,
      STREAMING_MODES,
      ROUTING_POLICIES,
      ROUTING_REASONS,
      ROUTING_REJECTION_CODES,
    ]) {
      expect(new Set(vocabulary).size).toBe(vocabulary.length);
    }
  });

  it('offers exactly two execution modes and two streaming modes', () => {
    expect([...EXECUTION_MODES]).toEqual(['buffered', 'streaming']);
    expect([...STREAMING_MODES]).toEqual(['native', 'unsupported']);
  });
});

describe('the guards', () => {
  it('recognises a reason code and nothing else', () => {
    expect(isRoutingReason('routing.explicit_provider')).toBe(true);
    expect(isRoutingReason('routing.budget_filtered')).toBe(false);
    expect(isRoutingReason(7)).toBe(false);
    expect(isRoutingReason(undefined)).toBe(false);
  });

  it('recognises a rejection code and nothing else', () => {
    expect(isRoutingRejectionCode('ProviderUnhealthy')).toBe(true);
    expect(isRoutingRejectionCode('BudgetExceeded')).toBe(false);
    expect(isRoutingRejectionCode(null)).toBe(false);
  });
});

describe('freezing a plan', () => {
  it('freezes the plan, its chain, and every target in it', () => {
    const frozen = freezePlan(plan());

    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen.fallbacks)).toBe(true);
    expect(Object.isFrozen(frozen.fallbacks[0])).toBe(true);
    expect(Object.isFrozen(frozen.reasons)).toBe(true);
  });

  it('refuses a write, rather than accepting one a cast made legal', () => {
    // A plan is evidence of a decision; anything that edits it makes the audit
    // record and the actual call disagree.
    const frozen = freezePlan(plan());
    expect(() => {
      (frozen as unknown as { model: string }).model = 'something-cheaper';
    }).toThrow(TypeError);
  });

  it('leaves an already-frozen plan alone', () => {
    const once = freezePlan(plan());
    expect(freezePlan(once)).toBe(once);
  });
});
