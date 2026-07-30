/**
 * Recovery.
 *
 * The property that matters is that running it twice is safe — recovery gets
 * run on a schedule, on startup, and again after it half-finished, which is
 * exactly when a non-idempotent one does damage.
 *
 * The dangerous case is a completed run: re-dispatching it would duplicate work
 * that already succeeded and was already metered.
 */
import { describe, expect, it } from 'vitest';

import { ProviderError, type AIResponse } from '@contentos/contracts';

import { createPromptCatalogue, type PromptCatalogue } from '../prompts/resolver.js';
import type { PromptTemplate } from '../prompts/template.js';
import type { WorkflowDefinition } from '../workflow/definition.js';
import {
  awaitExecution,
  buildRequest,
  createWorkflowExecution,
  fail as failWorkflow,
  loadStep,
  preparePrompt,
  recordExecution,
  start,
  type WorkflowExecution,
  type WorkflowExecutionContext,
} from '../workflow/engine.js';
import { beginRetryState, recordFailure, type RetryState } from './engine.js';
import { DEFAULT_RETRY_POLICY } from './policy.js';
import { isRecoveryAction, RECOVERY_ACTIONS, recover, sameRecovery } from './recovery.js';

const WS = '018f7a1e-0000-7000-8000-0000000000bb';
const ORG = '018f7a1e-0000-7000-8000-0000000000aa';
const CORRELATION = '018f7a1e-0000-7000-8000-0000000000dd';
const JOB = '018f7a1e-0000-7000-7003-000000000001';

const TEMPLATE: PromptTemplate = {
  id: 'planning.outline',
  version: 7,
  taskType: 'planning.outline',
  status: 'active',
  parts: { system: 'You write outlines.', user: 'Write about {{topic}}.' },
  variables: [{ name: 'topic', type: 'string', required: true, description: 'The subject.' }],
  modelHints: { maxOutputTokens: 1024, temperature: 0.2, determinismRequired: false },
  evalSetRef: 'evals/planning.outline',
  owner: 'content-platform',
  changelog: 'Initial version.',
};

const catalogue: PromptCatalogue = createPromptCatalogue([TEMPLATE]);

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
  awaitExecution(buildRequest(preparePrompt(loadStep(start(created())), catalogue)));

const response = (): AIResponse => ({
  idempotencyKey: 'wf-1:outline',
  providerId: 'reference',
  model: 'reference-model-2026-05-01',
  content: 'An outline.',
  finishReason: 'stop',
  usage: {
    tokens: { promptTokens: 12, completionTokens: 30, totalTokens: 42 },
    tokensEstimated: false,
    cost: { currency: 'USD', amount: '0.000420' },
    latencyMs: 91,
  },
  providerMetadata: {},
});

const failedOnce = (code: 'Unavailable' | 'Authentication' = 'Unavailable'): RetryState =>
  recordFailure(beginRetryState('wf-1:outline'), new ProviderError(code, 'reference', 'boom'));

describe('the action vocabulary', () => {
  it('is the five documented actions', () => {
    expect([...RECOVERY_ACTIONS]).toEqual([
      'resume',
      'redispatch',
      'retry',
      'fail',
      'ignore-duplicate-completion',
    ]);
  });

  it('recognises them and nothing else', () => {
    for (const action of RECOVERY_ACTIONS) expect(isRecoveryAction(action)).toBe(true);
    expect(isRecoveryAction('restart')).toBe(false);
  });
});

describe('a completed run is never re-dispatched', () => {
  const done = (): WorkflowExecution => recordExecution(toAwaiting(), response());

  // The dangerous recovery is the one that repeats work already paid for.
  it('ignores the duplicate completion', () => {
    const result = recover(done());
    expect(result.action).toBe('ignore-duplicate-completion');
    expect(result.noop).toBe(true);
  });

  it('hands back nothing to send', () => {
    expect(recover(done()).request).toBeNull();
  });

  it('says why, in terms of the duplication it prevented', () => {
    expect(recover(done()).detail).toContain('already succeeded');
  });

  it('ignores it even when a failure history is supplied', () => {
    expect(recover(done(), { retryState: failedOnce() }).action).toBe(
      'ignore-duplicate-completion',
    );
  });
});

describe('a failed run stays failed', () => {
  const dead = (): WorkflowExecution => failWorkflow(toAwaiting(), 'provider unavailable');

  it('is a no-op', () => {
    const result = recover(dead());
    expect(result.action).toBe('fail');
    expect(result.noop).toBe(true);
  });

  it('offers nothing to dispatch', () => {
    expect(recover(dead()).request).toBeNull();
  });
});

describe('an interrupted call is re-sent with the same key', () => {
  // Whether the call reached the provider is unknowable from here, which is
  // precisely why the key is reused rather than regenerated.
  it('re-dispatches the request the runtime prepared', () => {
    const result = recover(toAwaiting());
    expect(result.action).toBe('redispatch');
    expect(result.noop).toBe(false);
    expect(result.request?.idempotencyKey).toBe('wf-1:outline');
  });

  it('hands back the same request object the runtime holds, not a rebuilt one', () => {
    const execution = toAwaiting();
    expect(recover(execution).request).toBe(execution.state.prepared?.request);
  });

  it('says why re-sending is safe', () => {
    expect(recover(toAwaiting()).detail).toContain('same idempotency key');
  });
});

describe('an interrupted call that failed is decided by the retry engine', () => {
  it('retries when the failure is retryable and attempts remain', () => {
    const result = recover(toAwaiting(), { retryState: failedOnce() });
    expect(result.action).toBe('retry');
    expect(result.retry).toMatchObject({ action: 'retry', attempt: 2, delayMs: 500 });
    expect(result.request?.idempotencyKey).toBe('wf-1:outline');
  });

  it('fails when the failure is not retryable', () => {
    const result = recover(toAwaiting(), { retryState: failedOnce('Authentication') });
    expect(result.action).toBe('fail');
    expect(result.retry?.reason).toBe('non-retryable-failure');
  });

  // Nothing should be handed back to send when the answer is not to send it.
  it('offers no request when it decides to fail', () => {
    expect(recover(toAwaiting(), { retryState: failedOnce('Authentication') }).request).toBeNull();
  });

  it('fails when the attempts are exhausted', () => {
    let state = failedOnce();
    state = recordFailure(state, new ProviderError('Unavailable', 'reference', 'again'));
    expect(recover(toAwaiting(), { retryState: state }).retry?.reason).toBe('attempts-exhausted');
  });

  it('passes the deadline through to the decision', () => {
    const result = recover(toAwaiting(), {
      retryState: failedOnce(),
      decide: { remainingMs: 10 },
    });
    expect(result.action).toBe('fail');
    expect(result.retry?.reason).toBe('deadline-exceeded');
  });

  it('passes a custom policy through', () => {
    const result = recover(toAwaiting(), {
      retryState: failedOnce(),
      decide: { policy: { ...DEFAULT_RETRY_POLICY, baseDelayMs: 2000, maxAttemptsByCode: {} } },
    });
    expect(result.retry?.delayMs).toBe(2000);
  });
});

describe('a run interrupted before dispatch just resumes', () => {
  // Nothing left the process, so resuming costs nothing and duplicates nothing.
  it('resumes from wherever it stopped', () => {
    const stages: [string, WorkflowExecution][] = [
      ['pending', created()],
      ['started', start(created())],
      ['step_loaded', loadStep(start(created()))],
      ['prompt_prepared', preparePrompt(loadStep(start(created())), catalogue)],
      ['execution_prepared', buildRequest(preparePrompt(loadStep(start(created())), catalogue))],
    ];
    for (const [status, execution] of stages) {
      const result = recover(execution);
      expect(result.action, status).toBe('resume');
      expect(result.status, status).toBe(status);
      expect(result.request, status).toBeNull();
    }
  });

  it('explains that nothing was dispatched', () => {
    expect(recover(created()).detail).toContain('nothing was dispatched');
  });
});

describe('recovery is idempotent', () => {
  // It gets run on a schedule, on startup, and again after it half-finished.
  it('gives the same answer however many times it is asked', () => {
    for (const execution of [
      created(),
      start(created()),
      toAwaiting(),
      recordExecution(toAwaiting(), response()),
      failWorkflow(toAwaiting(), 'gone'),
    ]) {
      const first = recover(execution);
      for (let i = 0; i < 20; i += 1) {
        expect(sameRecovery(recover(execution), first), execution.state.status).toBe(true);
      }
    }
  });

  it('gives an identical result for an identical failure history', () => {
    const execution = toAwaiting();
    const a = recover(execution, { retryState: failedOnce() });
    const b = recover(execution, { retryState: failedOnce() });
    expect(sameRecovery(b, a)).toBe(true);
  });

  it('changes nothing about the execution it read', () => {
    const execution = toAwaiting();
    recover(execution);
    recover(execution);
    expect(execution.state.status).toBe('awaiting_execution');
    expect(execution.state.completedSteps).toHaveLength(0);
  });

  it('freezes its result', () => {
    const result = recover(toAwaiting());
    expect(Object.isFrozen(result)).toBe(true);
    expect(() => {
      (result as { action: string }).action = 'fail';
    }).toThrow();
  });

  it('reports which run it decided about', () => {
    expect(recover(toAwaiting()).workflowId).toBe('wf-1');
  });

  // sameRecovery is the claim's own checker, so it must be able to say no.
  it('can tell two different recoveries apart', () => {
    const resumed = recover(created());
    const redispatched = recover(toAwaiting());
    expect(sameRecovery(resumed, redispatched)).toBe(false);
  });
});
