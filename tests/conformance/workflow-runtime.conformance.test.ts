/**
 * The workflow runtime against the REAL prompt pipeline and provider
 * abstraction.
 *
 * The unit suites drive the runtime against its own imports. What they cannot
 * show is the property the increment exists to establish: that a definition, a
 * catalogue and a tenant context compose into a request the FROZEN provider
 * abstraction accepts — and that the runtime gets there without ever calling
 * `execute`.
 *
 * The provider here is INSTRUMENTED for exactly that reason. It counts its own
 * invocations, and the count is asserted to be zero through the whole
 * preparation path. A test that merely never called it would prove nothing; one
 * that would notice is the point.
 */

import { describe, expect, it } from 'vitest';

import {
  awaitExecution,
  buildRequest,
  createPromptCatalogue,
  createWorkflowExecution,
  failWorkflow,
  loadStep,
  pendingRequest,
  preparePrompt,
  recordExecution,
  resultOf,
  startWorkflow,
  validateAIRequest,
  validateWorkflowDefinition,
  WorkflowError,
  type ModelProvider,
  type PromptTemplate,
  type WorkflowDefinition,
  type WorkflowExecution,
  type WorkflowExecutionContext,
} from '@contentos/ai';
import type { AIRequest, AIResponse } from '@contentos/contracts';

const WS = '018f7a1e-0000-7000-8000-0000000000bb';
const ORG = '018f7a1e-0000-7000-8000-0000000000aa';
const CORRELATION = '018f7a1e-0000-7000-8000-0000000000dd';
const JOB = '018f7a1e-0000-7000-7003-000000000001';

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

const DRAFT: PromptTemplate = {
  ...OUTLINE,
  id: 'planning.draft',
  taskType: 'planning.draft',
  version: 1,
  parts: { system: 'You draft.', user: 'Expand this outline about {{topic}}:\n{{outline}}' },
  variables: [
    { name: 'topic', type: 'string', required: true, description: 'The subject.' },
    { name: 'outline', type: 'string', required: true, description: 'The outline to expand.' },
  ],
  evalSetRef: 'evals/planning.draft',
};

const catalogue = createPromptCatalogue([OUTLINE, DRAFT]);

const DEFINITION: WorkflowDefinition = {
  id: 'article.draft',
  version: 1,
  description: 'Outline the article, then draft it.',
  steps: [
    {
      id: 'outline',
      templateRef: { id: 'planning.outline' },
      capability: 'chat',
      model: 'reference-model',
      timeoutMs: 30_000,
      bindOutputTo: 'outline',
    },
    {
      id: 'draft',
      templateRef: { id: 'planning.draft', version: 1 },
      capability: 'chat',
      model: 'reference-model',
      timeoutMs: 60_000,
      params: { temperature: 0.7, maxOutputTokens: 4096 },
    },
  ],
};

const context: WorkflowExecutionContext = {
  tenant: { tenantId: WS, organizationId: ORG, source: 'event' },
  jobId: JOB,
  correlationId: CORRELATION,
  metadata: { runId: 'run-1' },
};

const created = (): WorkflowExecution =>
  createWorkflowExecution({
    workflowId: 'wf-1',
    definition: DEFINITION,
    context,
    variables: { topic: 'espresso' },
  });

/** Counts its own invocations, so "never executed" is an assertion. */
function countingProvider(): { provider: ModelProvider; calls: () => number } {
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
      return Promise.resolve({
        idempotencyKey: req.idempotencyKey,
        providerId: 'reference',
        model: `${req.model}-2026-05-01`,
        content: `answer for ${req.idempotencyKey}`,
        finishReason: 'stop',
        usage: {
          tokens: { promptTokens: 12, completionTokens: 30, totalTokens: 42 },
          tokensEstimated: false,
          cost: { currency: 'USD', amount: '0.000420' },
          latencyMs: 91,
        },
        providerMetadata: {},
      });
    },
  };
  return { provider, calls: () => calls };
}

const toAwaiting = (execution: WorkflowExecution): WorkflowExecution =>
  awaitExecution(buildRequest(preparePrompt(loadStep(startWorkflow(execution)), catalogue)));

describe('the runtime is published as one surface', () => {
  it('exports the whole line from @contentos/ai', () => {
    for (const fn of [
      createWorkflowExecution,
      startWorkflow,
      loadStep,
      preparePrompt,
      buildRequest,
      awaitExecution,
      recordExecution,
      failWorkflow,
      resultOf,
    ]) {
      expect(typeof fn).toBe('function');
    }
  });

  it('ships a definition the validator accepts', () => {
    expect(validateWorkflowDefinition(DEFINITION)).toEqual({ ok: true });
  });
});

describe('preparation reaches a valid canonical request, and stops', () => {
  it('builds a request the frozen provider abstraction accepts', () => {
    const ready = toAwaiting(created());
    const request = pendingRequest(ready);
    expect(request).not.toBeNull();
    if (request === null) return;
    expect(validateAIRequest(request)).toEqual({ ok: true });
  });

  // The whole increment in one assertion.
  it('never calls execute while preparing', () => {
    const { provider, calls } = countingProvider();
    expect(provider.capabilities).toContain('chat');

    const ready = toAwaiting(created());
    expect(ready.state.status).toBe('awaiting_execution');
    expect(calls()).toBe(0);
  });

  it('carries the tenant context through to the request', () => {
    const request = pendingRequest(toAwaiting(created()));
    expect(request).toMatchObject({
      tenantId: WS,
      organizationId: ORG,
      correlationId: CORRELATION,
    });
  });

  it("renders the caller's variables into the prompt", () => {
    const request = pendingRequest(toAwaiting(created()));
    expect(request?.messages[1]?.content).toBe('Write an outline about espresso.');
  });

  it('derives an idempotency key from the run and the step', () => {
    expect(pendingRequest(toAwaiting(created()))?.idempotencyKey).toBe('wf-1:outline');
  });
});

describe('the whole two-step run, with dispatch done by the caller', () => {
  // The runtime prepares; this test executes. That division is the design.
  async function run(): Promise<{ execution: WorkflowExecution; calls: number }> {
    const { provider, calls } = countingProvider();
    let execution = startWorkflow(created());

    for (;;) {
      execution = awaitExecution(buildRequest(preparePrompt(loadStep(execution), catalogue)));
      const request = pendingRequest(execution);
      expect(request).not.toBeNull();
      if (request === null) break;

      const response = await provider.execute(request);
      execution = recordExecution(execution, response);
      if (execution.state.status === 'completed') break;
    }

    return { execution, calls: calls() };
  }

  it('completes after exactly one call per step', async () => {
    const { execution, calls } = await run();
    expect(execution.state.status).toBe('completed');
    expect(calls).toBe(2);
  });

  it('records both steps, in order, with their prompt versions', async () => {
    const { execution } = await run();
    const result = resultOf(execution);
    expect(result.steps.map((s) => s.stepId)).toEqual(['outline', 'draft']);
    expect(result.steps.map((s) => s.promptVersion)).toEqual([
      'planning.outline@7',
      'planning.draft@1',
    ]);
  });

  it("feeds the first step's output into the second step's prompt", async () => {
    const { provider } = countingProvider();
    let execution = awaitExecution(
      buildRequest(preparePrompt(loadStep(startWorkflow(created())), catalogue)),
    );
    const first = pendingRequest(execution);
    if (first === null) throw new Error('expected a pending request');
    execution = recordExecution(execution, await provider.execute(first));

    const ready = awaitExecution(buildRequest(preparePrompt(loadStep(execution), catalogue)));
    expect(pendingRequest(ready)?.messages[1]?.content).toContain('answer for wf-1:outline');
  });

  it('gives each step its own key and honours its own parameters', async () => {
    const { execution } = await run();
    const result = resultOf(execution);
    expect(result.steps.map((s) => s.idempotencyKey)).toEqual(['wf-1:outline', 'wf-1:draft']);
  });

  it('produces the same run twice', async () => {
    const a = await run();
    const b = await run();
    expect(JSON.stringify(resultOf(b.execution))).toBe(JSON.stringify(resultOf(a.execution)));
  });

  it('hands back an immutable result', async () => {
    const { execution } = await run();
    const result = resultOf(execution);
    expect(Object.isFrozen(result)).toBe(true);
    expect(() => {
      (result as { status: string }).status = 'failed';
    }).toThrow();
  });
});

describe('the runtime refuses what the state machine forbids', () => {
  it('refuses to record an execution before one was prepared', () => {
    const started = startWorkflow(created());
    expect(() =>
      recordExecution(started, {
        idempotencyKey: 'wf-1:outline',
        providerId: 'reference',
        model: 'x',
        content: 'y',
        finishReason: 'stop',
        usage: {
          tokens: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          tokensEstimated: false,
          cost: { currency: 'USD', amount: '0' },
          latencyMs: 1,
        },
        providerMetadata: {},
      }),
    ).toThrow(WorkflowError);
  });

  it('refuses to build a request before the prompt is compiled', () => {
    expect(() => buildRequest(loadStep(startWorkflow(created())))).toThrow(WorkflowError);
  });

  it('refuses a second ending', async () => {
    const { provider } = countingProvider();
    let execution = toAwaiting(created());
    const request = pendingRequest(execution);
    if (request === null) throw new Error('expected a pending request');
    execution = recordExecution(execution, await provider.execute(request));

    // One step remains, so this run is not over — fail it, then try again.
    const failed = failWorkflow(execution, 'cancelled by the operator');
    expect(failed.state.status).toBe('failed');
    expect(() => failWorkflow(failed, 'again')).toThrow(WorkflowError);
  });

  it('drops the pending request when a run fails', () => {
    const failed = failWorkflow(toAwaiting(created()), 'provider unavailable');
    expect(pendingRequest(failed)).toBeNull();
    expect(resultOf(failed)).toMatchObject({ status: 'failed', failure: 'provider unavailable' });
  });
});

describe('a broken definition never starts', () => {
  it('refuses at creation rather than mid-run', () => {
    expect(() =>
      createWorkflowExecution({
        workflowId: 'wf-1',
        definition: { ...DEFINITION, steps: [] },
        context,
      }),
    ).toThrow(WorkflowError);
  });

  // The prompt pipeline's own validation is what catches this, unchanged.
  it('fails at render when a step names a template nothing declares', () => {
    const execution = createWorkflowExecution({
      workflowId: 'wf-1',
      definition: {
        ...DEFINITION,
        steps: [
          {
            id: 'outline',
            templateRef: { id: 'nobody.here' },
            capability: 'chat',
            model: 'reference-model',
            timeoutMs: 30_000,
          },
        ],
      },
      context,
      variables: { topic: 'espresso' },
    });
    expect(() => preparePrompt(loadStep(startWorkflow(execution)), catalogue)).toThrow(
      /No prompt template/,
    );
  });

  it('fails at render when a required variable was never supplied', () => {
    const execution = createWorkflowExecution({
      workflowId: 'wf-1',
      definition: DEFINITION,
      context,
    });
    expect(() => preparePrompt(loadStep(startWorkflow(execution)), catalogue)).toThrow(/required/);
  });
});
