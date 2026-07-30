/**
 * Usage metering against the REAL workflow runtime and provider abstraction.
 *
 * The unit suites price numbers. What they cannot show is the property the
 * increment exists to establish: that a call driven through the whole platform
 * — a workflow step, a prepared request, a provider response — meters into an
 * amount the credits ledger would accept, attributed to the run that caused it.
 *
 * ── The ledger-compatibility claim, and how it is checked here ──────────────
 * `packages/platform` owns the ledger and is a feature package this one may not
 * import, so compatibility cannot be asserted by calling it. It is asserted
 * against the FORMAT the ledger's own migration defines — non-negative
 * NUMERIC(20,6), no sign, no exponent, no leading zeroes — which is the
 * contract that actually has to hold at the boundary.
 */

import { describe, expect, it } from 'vitest';

import {
  awaitExecution,
  buildRequest,
  computeCost,
  createPricingRegistry,
  createPromptCatalogue,
  createWorkflowExecution,
  isLedgerCompatibleAmount,
  ledgerKeyFor,
  loadStep,
  pendingRequest,
  preparePrompt,
  recordExecution,
  recordResponseUsage,
  recordUsage,
  resultOf,
  startWorkflow,
  UsageError,
  type ModelPrice,
  type ModelProvider,
  type PromptTemplate,
  type WorkflowDefinition,
  type WorkflowExecutionContext,
} from '@contentos/ai';
import type { AIRequest, AIResponse, TokenUsage, UsageMetadata } from '@contentos/contracts';

const WS = '018f7a1e-0000-7000-8000-0000000000bb';
const ORG = '018f7a1e-0000-7000-8000-0000000000aa';
const CORRELATION = '018f7a1e-0000-7000-8000-0000000000dd';
const JOB = '018f7a1e-0000-7000-7003-000000000001';

/** The ledger's own acceptance rule, from `0014_platform`'s NUMERIC(20,6). */
const LEDGER_AMOUNT = /^(0|[1-9]\d*)(\.\d{1,6})?$/;

const PRICES: readonly ModelPrice[] = [
  {
    providerId: 'reference',
    model: 'reference-model-2026-05-01',
    currency: 'USD',
    inputPerMillion: '2.5',
    outputPerMillion: '10',
    cachedInputPerMillion: '0.25',
  },
];

const pricing = createPricingRegistry({ version: 'table-2026-07', prices: PRICES });
pricing.seal();

const OUTLINE: PromptTemplate = {
  id: 'planning.outline',
  version: 7,
  taskType: 'planning.outline',
  status: 'active',
  parts: { system: 'You write outlines.', user: 'Write an outline about {{topic}}.' },
  variables: [{ name: 'topic', type: 'string', required: true, description: 'The subject.' }],
  modelHints: { maxOutputTokens: 1024, temperature: 0.2, determinismRequired: false },
  evalSetRef: 'evals/planning.outline',
  owner: 'content-platform',
  changelog: 'Initial version.',
};

const catalogue = createPromptCatalogue([OUTLINE]);

const DEFINITION: WorkflowDefinition = {
  id: 'article.draft',
  version: 1,
  description: 'Outline the article.',
  steps: [
    {
      id: 'outline',
      templateRef: { id: 'planning.outline' },
      capability: 'chat',
      model: 'reference-model',
      timeoutMs: 30_000,
    },
  ],
};

const context: WorkflowExecutionContext = {
  tenant: { tenantId: WS, organizationId: ORG, source: 'event' },
  jobId: JOB,
  correlationId: CORRELATION,
  metadata: { runId: 'run-1' },
};

const tokens = (promptTokens: number, completionTokens: number): TokenUsage => ({
  promptTokens,
  completionTokens,
  totalTokens: promptTokens + completionTokens,
});

function provider(usage: TokenUsage = tokens(1000, 500)): ModelProvider {
  return {
    providerId: 'reference',
    displayName: 'Reference Provider',
    capabilities: ['text', 'chat'],
    health: () =>
      Promise.resolve({
        status: 'healthy' as const,
        reportedAt: '2026-07-30T12:00:00.000Z',
        detail: null,
      }),
    execute: (req: AIRequest): Promise<AIResponse> =>
      Promise.resolve({
        idempotencyKey: req.idempotencyKey,
        providerId: 'reference',
        model: `${req.model}-2026-05-01`,
        content: 'An outline.',
        finishReason: 'stop',
        usage: {
          tokens: usage,
          tokensEstimated: false,
          cost: { currency: 'USD', amount: '0.000000' },
          latencyMs: 91,
        },
        providerMetadata: {},
      }),
  };
}

function metadata(over: Partial<UsageMetadata> = {}): UsageMetadata {
  return {
    tenantId: WS,
    organizationId: ORG,
    correlationId: CORRELATION,
    idempotencyKey: 'wf-1:outline',
    attempt: 1,
    taskType: 'planning.outline',
    providerId: 'reference',
    model: 'reference-model-2026-05-01',
    promptVersion: 'planning.outline@7',
    runId: 'wf-1',
    stepId: 'outline',
    ...over,
  };
}

describe('metering is published as one surface', () => {
  it('exports the pricing registry, the calculator and the recorder', () => {
    for (const fn of [createPricingRegistry, computeCost, recordUsage, recordResponseUsage]) {
      expect(typeof fn).toBe('function');
    }
  });

  // Cost crosses the capability boundary: credits consumes consumption and
  // billing reads cost, and neither may import `packages/ai`.
  it('publishes the usage contracts from @contentos/contracts', async () => {
    const contracts: Record<string, unknown> = await import('@contentos/contracts');
    expect(Object.keys(contracts)).toContain('USAGE_METADATA_FIELDS');
  });

  // ...while the meter itself stays in the AI package.
  it('keeps the pricing registry out of @contentos/contracts', async () => {
    const contracts: Record<string, unknown> = await import('@contentos/contracts');
    for (const name of ['createPricingRegistry', 'computeCost', 'recordUsage']) {
      expect(Object.keys(contracts), name).not.toContain(name);
    }
  });
});

describe('a call driven through the whole platform meters correctly', () => {
  async function meterOneStep() {
    let execution = awaitExecution(
      buildRequest(
        preparePrompt(
          loadStep(
            startWorkflow(
              createWorkflowExecution({
                workflowId: 'wf-1',
                definition: DEFINITION,
                context,
                variables: { topic: 'espresso' },
              }),
            ),
          ),
          catalogue,
        ),
      ),
    );

    const request = pendingRequest(execution);
    if (request === null) throw new Error('expected a pending request');

    const response = await provider().execute(request);
    execution = recordExecution(execution, response);

    const step = resultOf(execution).steps[0];
    if (step === undefined) throw new Error('expected a completed step');

    const usage = recordResponseUsage(
      response,
      {
        tenantId: execution.context.tenant.tenantId,
        organizationId: execution.context.tenant.organizationId,
        correlationId: execution.context.correlationId,
        attempt: 1,
        taskType: request.taskType,
        promptVersion: step.promptVersion,
        runId: execution.workflowId,
        stepId: step.stepId,
      },
      pricing,
    );

    return { execution, usage, request };
  }

  it('prices the call from the tokens the provider reported', async () => {
    const { usage } = await meterOneStep();
    // 1000 @ $2.50/M + 500 @ $10/M.
    expect(usage.record.cost.totalCost).toBe('0.007500');
    expect(usage.record.cost.unpriced).toBe(false);
  });

  // correlationId is the join that makes "what did this run cost?" a query.
  it('attributes the cost to the tenant, the run and the step that caused it', async () => {
    const { usage } = await meterOneStep();
    expect(usage.record.metadata).toMatchObject({
      tenantId: WS,
      organizationId: ORG,
      correlationId: CORRELATION,
      runId: 'wf-1',
      stepId: 'outline',
      taskType: 'planning.outline',
    });
  });

  // "Did that prompt change cost more?" is only answerable if the version is
  // on the row.
  it('records the prompt version that produced the call', async () => {
    const { usage } = await meterOneStep();
    expect(usage.record.metadata.promptVersion).toBe('planning.outline@7');
  });

  it('keys the ledger entry on the request the workflow derived', async () => {
    const { usage, request } = await meterOneStep();
    expect(request.idempotencyKey).toBe('wf-1:outline');
    expect(usage.ledgerIdempotencyKey).toBe('wf-1:outline#1');
  });

  it('prices the model that actually ran, not the one asked for', async () => {
    const { usage, request } = await meterOneStep();
    expect(request.model).toBe('reference-model');
    expect(usage.record.metadata.model).toBe('reference-model-2026-05-01');
  });

  it('meters identically on a second run of the same work', async () => {
    const first = await meterOneStep();
    const second = await meterOneStep();
    expect(JSON.stringify(second.usage)).toBe(JSON.stringify(first.usage));
  });
});

describe('the amount is one the credits ledger would accept', () => {
  it("matches the ledger's NUMERIC(20,6) acceptance rule", () => {
    const result = recordUsage({ tokens: tokens(1000, 500), metadata: metadata(), pricing });
    expect(result.chargeableAmount).toMatch(LEDGER_AMOUNT);
    expect(isLedgerCompatibleAmount(result.chargeableAmount)).toBe(true);
  });

  it('holds for every part of the breakdown, not just the total', () => {
    const { cost } = recordUsage({
      tokens: tokens(333_333, 111_111),
      metadata: metadata(),
      pricing,
      cachedTokens: 1000,
    }).record;
    for (const amount of [cost.promptCost, cost.completionCost, cost.cachedCost, cost.totalCost]) {
      expect(amount, amount).toMatch(LEDGER_AMOUNT);
    }
  });

  it('holds across a wide range of call sizes', () => {
    for (const [prompt, completion] of [
      [0, 0],
      [1, 1],
      [999, 1],
      [1_000_000, 1_000_000],
      [12_345_678, 8_765_432],
    ] as const) {
      const result = recordUsage({
        tokens: tokens(prompt, completion),
        metadata: metadata(),
        pricing,
      });
      expect(result.chargeableAmount, `${String(prompt)}/${String(completion)}`).toMatch(
        LEDGER_AMOUNT,
      );
    }
  });

  it('never produces a negative, an exponent or a bare integer', () => {
    const amount = recordUsage({
      tokens: tokens(1, 0),
      metadata: metadata(),
      pricing,
    }).chargeableAmount;
    expect(amount).not.toContain('-');
    expect(amount).not.toContain('e');
    expect(amount).toContain('.');
  });

  // The ledger stores exactly six places; a value with more would be rounded
  // by the database, silently, on insert.
  it('never exceeds the six places the ledger stores', () => {
    const { cost } = recordUsage({
      tokens: tokens(7, 3),
      metadata: metadata(),
      pricing,
    }).record;
    expect(cost.totalCost.split('.')[1]).toHaveLength(6);
  });
});

describe('an unpriced model is metered, not dropped', () => {
  it('records the call at zero with the flag set', () => {
    const result = recordUsage({
      tokens: tokens(1000, 500),
      metadata: metadata({ model: 'a-model-nobody-priced' }),
      pricing,
    });
    expect(result.record.cost.unpriced).toBe(true);
    expect(result.chargeable).toBe(false);
    expect(result.record.tokens.totalTokens).toBe(1500);
  });

  it('still names the price table that failed to cover it', () => {
    const result = recordUsage({
      tokens: tokens(1, 1),
      metadata: metadata({ model: 'unknown' }),
      pricing,
    });
    expect(result.record.cost.pricingVersion).toBe('table-2026-07');
  });
});

describe('the meter refuses what it cannot account for', () => {
  it('refuses counts that do not add up', () => {
    expect(() =>
      recordUsage({
        tokens: { promptTokens: 10, completionTokens: 10, totalTokens: 99 },
        metadata: metadata(),
        pricing,
      }),
    ).toThrow(UsageError);
  });

  it('refuses a record with no correlation id', () => {
    expect(() =>
      recordUsage({ tokens: tokens(1, 1), metadata: metadata({ correlationId: '' }), pricing }),
    ).toThrow(UsageError);
  });

  it('refuses a negative count before it can reach a price', () => {
    expect(() =>
      recordUsage({
        tokens: { promptTokens: -1, completionTokens: 0, totalTokens: -1 },
        metadata: metadata(),
        pricing,
      }),
    ).toThrow(UsageError);
  });
});

describe('a retry is a second charge, a redelivery is not', () => {
  it('gives each attempt its own ledger key', () => {
    const first = recordUsage({ tokens: tokens(1000, 500), metadata: metadata(), pricing });
    const retry = recordUsage({
      tokens: tokens(1100, 400),
      metadata: metadata({ attempt: 2 }),
      pricing,
    });
    expect(retry.ledgerIdempotencyKey).toBe(ledgerKeyFor('wf-1:outline', 2));
    expect(retry.ledgerIdempotencyKey).not.toBe(first.ledgerIdempotencyKey);
  });

  it('gives two recordings of one attempt one key and one amount', () => {
    const a = recordUsage({ tokens: tokens(1000, 500), metadata: metadata(), pricing });
    const b = recordUsage({ tokens: tokens(1000, 500), metadata: metadata(), pricing });
    expect(b.ledgerIdempotencyKey).toBe(a.ledgerIdempotencyKey);
    expect(b.chargeableAmount).toBe(a.chargeableAmount);
  });
});
