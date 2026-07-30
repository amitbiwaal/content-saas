/**
 * Retry and recovery against the REAL workflow runtime, provider abstraction
 * and meter.
 *
 * The unit suites decide about states built by hand. What they cannot show is
 * the property the increment exists to establish: that a real run, interrupted
 * and recovered, never duplicates a successful execution — and that the retry
 * of a real failure meters as a second attempt rather than a second charge for
 * the first.
 *
 * ── This is not the event platform's retry engine ───────────────────────────
 * `packages/events` decides whether an EVENT is redelivered to a consumer group
 * or dead-lettered; this decides whether an AI CALL is attempted again. Both
 * are imported here under distinct names, and the suite asserts they are
 * genuinely different objects answering different questions — which is the
 * check that would catch one quietly becoming a copy of the other.
 */

import { describe, expect, it } from 'vitest';

import {
  awaitExecution,
  beginRetryState,
  buildRequest,
  createPricingRegistry,
  createPromptCatalogue,
  createWorkflowExecution,
  decideRetry,
  DEFAULT_RETRY_POLICY,
  failWorkflow,
  loadStep,
  nextAttemptNumber,
  pendingRequest,
  preparePrompt,
  recordExecution,
  recordFailure,
  recordSuccess,
  recordUsage,
  recover,
  sameRecovery,
  settle,
  startWorkflow,
  type ModelProvider,
  type PromptTemplate,
  type RetryState,
  type WorkflowDefinition,
  type WorkflowExecution,
  type WorkflowExecutionContext,
} from '@contentos/ai';
import { createRetryEngine as createEventRetryEngine } from '@contentos/events';
import { ProviderError, type AIRequest, type AIResponse } from '@contentos/contracts';

const WS = '018f7a1e-0000-7000-8000-0000000000bb';
const ORG = '018f7a1e-0000-7000-8000-0000000000aa';
const CORRELATION = '018f7a1e-0000-7000-8000-0000000000dd';
const JOB = '018f7a1e-0000-7000-7003-000000000001';

const TEMPLATE: PromptTemplate = {
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

const catalogue = createPromptCatalogue([TEMPLATE]);

const pricing = createPricingRegistry({
  version: 'table-2026-07',
  prices: [
    {
      providerId: 'reference',
      model: 'reference-model-2026-05-01',
      currency: 'USD',
      inputPerMillion: '2.5',
      outputPerMillion: '10',
    },
  ],
});
pricing.seal();

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
  metadata: {},
};

const created = (): WorkflowExecution =>
  createWorkflowExecution({
    workflowId: 'wf-1',
    definition: DEFINITION,
    context,
    variables: { topic: 'espresso' },
  });

const toAwaiting = (): WorkflowExecution =>
  awaitExecution(buildRequest(preparePrompt(loadStep(startWorkflow(created())), catalogue)));

/** Fails a given number of times, then succeeds. Counts every dispatch. */
function flakyProvider(failures: number): { provider: ModelProvider; calls: () => number } {
  let calls = 0;
  const provider: ModelProvider = {
    providerId: 'reference',
    displayName: 'Reference Provider',
    capabilities: ['text', 'chat'],
    health: () =>
      Promise.resolve({
        status: 'healthy' as const,
        reportedAt: '2026-07-30T12:00:00.000Z',
        detail: null,
      }),
    execute: (req: AIRequest): Promise<AIResponse> => {
      calls += 1;
      if (calls <= failures) {
        return Promise.reject(new ProviderError('Unavailable', 'reference', 'capacity blip'));
      }
      return Promise.resolve({
        idempotencyKey: req.idempotencyKey,
        providerId: 'reference',
        model: `${req.model}-2026-05-01`,
        content: 'An outline.',
        finishReason: 'stop',
        usage: {
          tokens: { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 },
          tokensEstimated: false,
          cost: { currency: 'USD', amount: '0.000000' },
          latencyMs: 91,
        },
        providerMetadata: {},
      });
    },
  };
  return { provider, calls: () => calls };
}

const attribution = (attempt: number) => ({
  tenantId: WS,
  organizationId: ORG,
  correlationId: CORRELATION,
  idempotencyKey: 'wf-1:outline',
  attempt,
  taskType: 'planning.outline',
  providerId: 'reference',
  model: 'reference-model-2026-05-01',
  promptVersion: 'planning.outline@7',
  runId: 'wf-1',
  stepId: 'outline',
});

describe('retry and recovery are published as one surface', () => {
  it('exports the engine, the policy and recovery from @contentos/ai', () => {
    for (const fn of [beginRetryState, recordFailure, decideRetry, settle, recover]) {
      expect(typeof fn).toBe('function');
    }
  });

  // The check that would catch one quietly becoming a copy of the other.
  it("is a different thing from the event platform's retry engine", () => {
    const events = createEventRetryEngine();
    // The event engine decides about an event and a consumer group...
    const eventDecision = events.decide({
      eventId: '018f7a1e-0000-7000-8000-000000000001',
      eventType: 'JobQueued',
      consumerGroup: 'ai-job-runner',
      attempt: 1,
      code: 'SchemaViolation',
    });
    expect(eventDecision.action).toBe('dead-letter');

    // ...and this one decides about an AI call and a provider error class.
    const aiDecision = decideRetry(
      recordFailure(beginRetryState('wf-1:outline'), new ProviderError('RateLimit', 'x', 'slow')),
    );
    expect(aiDecision.action).toBe('retry');
    expect(Object.keys(aiDecision)).toContain('delayMs');
    expect(Object.keys(eventDecision)).not.toContain('delayMs');
  });
});

describe('a real run that fails, retries and succeeds', () => {
  async function runWithRetries(failures: number) {
    const { provider, calls } = flakyProvider(failures);
    let execution = toAwaiting();
    let retryState: RetryState = beginRetryState('wf-1:outline');
    const metered: string[] = [];

    for (;;) {
      const request = pendingRequest(execution);
      if (request === null) throw new Error('expected a pending request');

      const attempt = nextAttemptNumber(retryState);
      try {
        const response = await provider.execute(request);
        retryState = recordSuccess(retryState);
        metered.push(
          recordUsage({
            tokens: response.usage.tokens,
            metadata: attribution(attempt),
            pricing,
          }).ledgerIdempotencyKey,
        );
        execution = recordExecution(execution, response);
        break;
      } catch (error) {
        retryState = recordFailure(retryState, error as ProviderError);
        const decision = decideRetry(retryState);
        if (decision.action === 'fail') {
          retryState = settle(retryState, decision);
          execution = failWorkflow(execution, decision.detail);
          break;
        }
        // A retry would wait `decision.delayMs`; waiting is the scheduler's.
      }
    }

    return { execution, retryState, calls: calls(), metered };
  }

  it('completes after one transient failure', async () => {
    const { execution, retryState, calls } = await runWithRetries(1);
    expect(execution.state.status).toBe('completed');
    expect(retryState.status).toBe('succeeded');
    expect(calls).toBe(2);
  });

  // Every retry reuses the key, so the provider can deduplicate and the meter
  // separates the attempts rather than the requests.
  it('reuses one idempotency key across every attempt', async () => {
    const { execution } = await runWithRetries(1);
    expect(execution.state.completedSteps[0]?.idempotencyKey).toBe('wf-1:outline');
  });

  it('meters the successful attempt as attempt two, not a second request', async () => {
    const { metered } = await runWithRetries(1);
    expect(metered).toEqual(['wf-1:outline#2']);
  });

  it('gives up once the attempts allowed are used, and fails the run', async () => {
    const { execution, retryState, calls } = await runWithRetries(99);
    expect(execution.state.status).toBe('failed');
    expect(retryState.status).toBe('exhausted');
    // Two attempts for Unavailable, per the spec's table.
    expect(calls).toBe(2);
  });

  it('records why it stopped, in the failure the run carries', async () => {
    const { execution } = await runWithRetries(99);
    expect(execution.state.failure).toContain('2 of 2');
  });

  it('runs identically twice', async () => {
    const a = await runWithRetries(1);
    const b = await runWithRetries(1);
    expect(b.metered).toEqual(a.metered);
    expect(b.calls).toBe(a.calls);
  });
});

describe('recovery never duplicates a successful execution', () => {
  async function completedRun() {
    const { provider, calls } = flakyProvider(0);
    let execution = toAwaiting();
    const request = pendingRequest(execution);
    if (request === null) throw new Error('expected a pending request');
    execution = recordExecution(execution, await provider.execute(request));
    return { execution, calls };
  }

  // The whole increment in one assertion.
  it('recovering a completed run dispatches nothing', async () => {
    const { execution, calls } = await completedRun();
    const before = calls();

    for (let i = 0; i < 5; i += 1) {
      const result = recover(execution);
      expect(result.action).toBe('ignore-duplicate-completion');
      expect(result.request).toBeNull();
    }

    expect(calls()).toBe(before);
  });

  it('recovering an interrupted run hands back the same request, not a new one', () => {
    const execution = toAwaiting();
    const original = pendingRequest(execution);
    const recovered = recover(execution).request;
    expect(recovered).toBe(original);
    expect(recovered?.idempotencyKey).toBe('wf-1:outline');
  });

  it('agrees with itself across repeated sweeps of the same run', async () => {
    const { execution } = await completedRun();
    const first = recover(execution);
    for (let i = 0; i < 10; i += 1) expect(sameRecovery(recover(execution), first)).toBe(true);
  });

  it('recovers a run interrupted before dispatch by resuming it', () => {
    expect(recover(startWorkflow(created())).action).toBe('resume');
    expect(recover(startWorkflow(created())).request).toBeNull();
  });
});

describe('terminal state protection', () => {
  it('refuses to retry a call that already succeeded', () => {
    const succeeded = recordSuccess(beginRetryState('wf-1:outline'));
    expect(decideRetry(succeeded)).toMatchObject({ action: 'fail', reason: 'already-settled' });
  });

  it('refuses to record a late failure against a succeeded call', () => {
    const succeeded = recordSuccess(beginRetryState('wf-1:outline'));
    expect(() =>
      recordFailure(succeeded, new ProviderError('Timeout', 'reference', 'late')),
    ).toThrow(/settled/);
  });

  it('refuses to recover a failed run into another attempt', () => {
    const dead = failWorkflow(toAwaiting(), 'gone');
    const result = recover(dead, {
      retryState: recordFailure(
        beginRetryState('wf-1:outline'),
        new ProviderError('Unavailable', 'reference', 'blip'),
      ),
    });
    expect(result.action).toBe('fail');
    expect(result.noop).toBe(true);
    expect(result.request).toBeNull();
  });

  // The runtime's own state machine is the second refusal, and it still holds
  // whatever recovery says.
  it('leaves the workflow state machine in charge of the transition', () => {
    const done = recordExecution(toAwaiting(), {
      idempotencyKey: 'wf-1:outline',
      providerId: 'reference',
      model: 'reference-model-2026-05-01',
      content: 'An outline.',
      finishReason: 'stop',
      usage: {
        tokens: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        tokensEstimated: false,
        cost: { currency: 'USD', amount: '0.000000' },
        latencyMs: 1,
      },
      providerMetadata: {},
    });
    expect(recover(done).action).toBe('ignore-duplicate-completion');
    // And even if a caller ignored that, the runtime refuses.
    expect(() => failWorkflow(done, 'ignoring the recovery')).toThrow();
  });
});

describe("the spec's two normative rules hold end to end", () => {
  // Rule 2: automatically re-running a refused prompt converts a supplier's
  // safety judgment into an obstacle to route around.
  it('never retries a provider safety refusal, at any policy', () => {
    const refused = recordFailure(
      beginRetryState('wf-1:outline'),
      new ProviderError('ContentFiltered', 'reference', 'refused on safety grounds'),
    );
    for (const maxAttempts of [1, 2, 10, 100]) {
      const decision = decideRetry(refused, {
        policy: { ...DEFAULT_RETRY_POLICY, maxAttempts, maxAttemptsByCode: {} },
      });
      expect(decision.action, String(maxAttempts)).toBe('fail');
      expect(decision.reason, String(maxAttempts)).toBe('non-retryable-failure');
    }
  });

  it('never retries our own malformed request', () => {
    const ours = recordFailure(
      beginRetryState('wf-1:outline'),
      new ProviderError('Validation', 'reference', 'messages must not be empty'),
    );
    expect(decideRetry(ours).action).toBe('fail');
  });

  it('recovers a safety refusal to a permanent failure, not a retry', () => {
    const refused = recordFailure(
      beginRetryState('wf-1:outline'),
      new ProviderError('ContentFiltered', 'reference', 'refused'),
    );
    expect(recover(toAwaiting(), { retryState: refused }).action).toBe('fail');
  });
});
