/**
 * The runtime.
 *
 * Two properties carry this file. Every transition is a PURE function, so the
 * same execution and the same command cannot produce two different results —
 * "deterministic" is a consequence of the shape rather than a rule someone has
 * to remember. And nothing here executes: `buildRequest` produces what a
 * provider would be given and stops.
 */
import { describe, expect, it } from 'vitest';

import type { AIResponse } from '@contentos/contracts';

import { createPromptCatalogue, type PromptCatalogue } from '../prompts/resolver.js';
import type { PromptTemplate } from '../prompts/template.js';
import type { WorkflowDefinition, WorkflowStep } from './definition.js';
import {
  awaitExecution,
  buildRequest,
  createWorkflowExecution,
  fail,
  idempotencyKeyFor,
  loadStep,
  pendingRequest,
  preparePrompt,
  recordExecution,
  resultOf,
  start,
  type WorkflowExecution,
  type WorkflowExecutionContext,
} from './engine.js';
import { WorkflowError } from './state.js';

const WS = '018f7a1e-0000-7000-8000-0000000000bb';
const ORG = '018f7a1e-0000-7000-8000-0000000000aa';
const CORRELATION = '018f7a1e-0000-7000-8000-0000000000dd';
const JOB = '018f7a1e-0000-7000-7003-000000000001';

function template(over: Partial<PromptTemplate> = {}): PromptTemplate {
  return {
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
    ...over,
  };
}

const catalogue: PromptCatalogue = createPromptCatalogue([
  template(),
  template({
    id: 'planning.draft',
    taskType: 'planning.draft',
    version: 1,
    parts: { system: 'You draft.', user: 'Expand {{outline}} about {{topic}}.' },
    variables: [
      { name: 'topic', type: 'string', required: true, description: 'The subject.' },
      { name: 'outline', type: 'string', required: true, description: 'The outline.' },
    ],
  }),
]);

function step(over: Partial<WorkflowStep> = {}): WorkflowStep {
  return {
    id: 'outline',
    templateRef: { id: 'planning.outline' },
    capability: 'chat',
    model: 'reference-model',
    timeoutMs: 30_000,
    ...over,
  };
}

function definition(over: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    id: 'article.draft',
    version: 1,
    description: 'Outline, then draft.',
    steps: [step()],
    ...over,
  };
}

const context: WorkflowExecutionContext = {
  tenant: { tenantId: WS, organizationId: ORG, source: 'event' },
  jobId: JOB,
  correlationId: CORRELATION,
  metadata: { runId: 'run-1' },
};

function created(over: Partial<WorkflowDefinition> = {}): WorkflowExecution {
  return createWorkflowExecution({
    workflowId: 'wf-1',
    definition: definition(over),
    context,
    variables: { topic: 'espresso' },
  });
}

function response(over: Partial<AIResponse> = {}): AIResponse {
  return {
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
    ...over,
  };
}

/** Drive a created execution to the point where a caller would dispatch. */
function toAwaiting(execution: WorkflowExecution): WorkflowExecution {
  return awaitExecution(buildRequest(preparePrompt(loadStep(start(execution)), catalogue)));
}

describe('the run advances one box at a time', () => {
  it('walks the whole line', () => {
    const a = created();
    expect(a.state.status).toBe('pending');
    const b = start(a);
    expect(b.state.status).toBe('started');
    const c = loadStep(b);
    expect(c.state.status).toBe('step_loaded');
    const d = preparePrompt(c, catalogue);
    expect(d.state.status).toBe('prompt_prepared');
    const e = buildRequest(d);
    expect(e.state.status).toBe('execution_prepared');
    const f = awaitExecution(e);
    expect(f.state.status).toBe('awaiting_execution');
    const g = recordExecution(f, response());
    expect(g.state.status).toBe('completed');
  });

  it('loads the first step and names it', () => {
    const loaded = loadStep(start(created()));
    expect(loaded.state.stepIndex).toBe(0);
    expect(loaded.state.stepId).toBe('outline');
    expect(loaded.state.promptRef).toEqual({ id: 'planning.outline' });
  });

  it('has no step loaded before it starts', () => {
    const a = created();
    expect(a.state.stepIndex).toBe(-1);
    expect(a.state.stepId).toBeNull();
    expect(a.state.promptRef).toBeNull();
  });

  it('refuses to load a step that does not exist', () => {
    const done = recordExecution(toAwaiting(created()), response());
    // Completed, so the transition is refused before the index is even read.
    expect(() => loadStep(done)).toThrow(WorkflowError);
  });
});

describe('nothing mutates', () => {
  // The previous execution stays valid and unchanged, which is what makes the
  // runtime safe to hand around and impossible to advance twice by accident.
  it('leaves the previous execution untouched', () => {
    const a = created();
    const b = start(a);
    expect(a.state.status).toBe('pending');
    expect(b.state.status).toBe('started');
    expect(b).not.toBe(a);
  });

  it('freezes every execution it returns', () => {
    const a = created();
    expect(Object.isFrozen(a)).toBe(true);
    expect(Object.isFrozen(a.state)).toBe(true);
    expect(Object.isFrozen(start(a).state)).toBe(true);
  });

  it('refuses a write to the state', () => {
    const a = created();
    expect(() => {
      (a.state as { status: string }).status = 'completed';
    }).toThrow();
  });

  it('freezes the completed step list and each result', () => {
    const done = recordExecution(toAwaiting(created()), response());
    expect(Object.isFrozen(done.state.completedSteps)).toBe(true);
    expect(Object.isFrozen(done.state.completedSteps[0])).toBe(true);
  });
});

describe('progression is deterministic', () => {
  it('produces an identical execution from identical input', () => {
    const first = toAwaiting(created());
    const second = toAwaiting(created());
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('is identical through to completion', () => {
    const first = recordExecution(toAwaiting(created()), response());
    const second = recordExecution(toAwaiting(created()), response());
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  // No clock and no random source: a timestamp would make two otherwise
  // identical runs differ, and when things happened is the job row's business.
  it('carries no timestamp anywhere in the state', () => {
    const done = recordExecution(toAwaiting(created()), response());
    const serialized = JSON.stringify(done);
    expect(serialized).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  });

  it('derives the idempotency key rather than generating one', () => {
    expect(idempotencyKeyFor('wf-1', 'outline')).toBe('wf-1:outline');
    expect(toAwaiting(created()).state.prepared?.request.idempotencyKey).toBe('wf-1:outline');
  });

  // Two runs of the same workflow at the same step produce the same key, which
  // is what makes a redelivery a repeat rather than a second charge.
  it('gives one step in one run exactly one key', () => {
    const a = toAwaiting(created());
    const b = toAwaiting(created());
    expect(b.state.prepared?.request.idempotencyKey).toBe(a.state.prepared?.request.idempotencyKey);
  });

  it('gives different runs different keys', () => {
    const other = createWorkflowExecution({
      workflowId: 'wf-2',
      definition: definition(),
      context,
      variables: { topic: 'espresso' },
    });
    expect(toAwaiting(other).state.prepared?.request.idempotencyKey).toBe('wf-2:outline');
  });
});

describe('the canonical request it builds', () => {
  it('carries the compiled prompt as its messages', () => {
    const ready = toAwaiting(created());
    expect(ready.state.prepared?.request.messages[1]?.content).toBe('Write about espresso.');
  });

  it('carries the tenant context it was given', () => {
    const request = toAwaiting(created()).state.prepared?.request;
    expect(request).toMatchObject({
      tenantId: WS,
      organizationId: ORG,
      correlationId: CORRELATION,
    });
  });

  it('takes the task type from the template, not the workflow', () => {
    expect(toAwaiting(created()).state.prepared?.request.taskType).toBe('planning.outline');
  });

  it('takes the model, capability and timeout from the step', () => {
    const request = toAwaiting(created()).state.prepared?.request;
    expect(request).toMatchObject({
      model: 'reference-model',
      capability: 'chat',
      timeoutMs: 30_000,
    });
  });

  it("uses the step's own parameters when it states them", () => {
    const stated = created({
      steps: [step({ params: { temperature: 0.9, maxOutputTokens: 4096 } })],
    });
    expect(toAwaiting(stated).state.prepared?.request.params).toEqual({
      temperature: 0.9,
      maxOutputTokens: 4096,
    });
  });

  // The workflow adopting the template's hints is visible here; the prompt
  // pipeline still never applies them on its own.
  it("adopts the template's hints when the step is silent", () => {
    expect(toAwaiting(created()).state.prepared?.request.params).toEqual({
      temperature: 0.2,
      maxOutputTokens: 1024,
    });
  });

  it('exposes the pending request only while one is pending', () => {
    expect(pendingRequest(created())).toBeNull();
    expect(pendingRequest(start(created()))).toBeNull();
    expect(pendingRequest(toAwaiting(created()))).not.toBeNull();
    expect(pendingRequest(recordExecution(toAwaiting(created()), response()))).toBeNull();
  });
});

describe('several steps, in order', () => {
  const twoStep = (): WorkflowExecution =>
    created({
      steps: [
        step({ id: 'outline', bindOutputTo: 'outline' }),
        step({ id: 'draft', templateRef: { id: 'planning.draft' } }),
      ],
    });

  // Back to `started`, not straight to the next step: every step traverses the
  // same six boxes, so one uniform loop drives the whole run.
  it('returns for the next step rather than completing', () => {
    const after = recordExecution(toAwaiting(twoStep()), response());
    expect(after.state.status).toBe('started');
    expect(after.state.stepIndex).toBe(0);
    expect(after.state.stepId).toBeNull();
  });

  it('loads the next step when asked, advancing the cursor there', () => {
    const loaded = loadStep(recordExecution(toAwaiting(twoStep()), response()));
    expect(loaded.state.status).toBe('step_loaded');
    expect(loaded.state.stepIndex).toBe(1);
    expect(loaded.state.stepId).toBe('draft');
  });

  it('completes only after the last step', () => {
    const afterFirst = recordExecution(toAwaiting(twoStep()), response());
    const ready = awaitExecution(buildRequest(preparePrompt(loadStep(afterFirst), catalogue)));
    const done = recordExecution(ready, response({ idempotencyKey: 'wf-1:draft' }));
    expect(done.state.status).toBe('completed');
    expect(done.state.completedSteps.map((s) => s.stepId)).toEqual(['outline', 'draft']);
  });

  // The whole of the data flow: a name, and the content bound to it.
  it("binds a step's output into the next step's variables", () => {
    const after = recordExecution(toAwaiting(twoStep()), response({ content: 'I. Grind' }));
    expect(after.state.variables).toEqual({ topic: 'espresso', outline: 'I. Grind' });

    const ready = awaitExecution(buildRequest(preparePrompt(loadStep(after), catalogue)));
    expect(ready.state.prepared?.request.messages[1]?.content).toBe(
      'Expand I. Grind about espresso.',
    );
  });

  it('leaves the variables alone when a step binds nothing', () => {
    const after = recordExecution(toAwaiting(created()), response());
    expect(after.state.variables).toEqual({ topic: 'espresso' });
  });

  it('clears the compiled prompt and request between steps', () => {
    const after = recordExecution(toAwaiting(twoStep()), response());
    expect(after.state.compiled).toBeNull();
    expect(after.state.prepared).toBeNull();
  });

  it('runs a two-step workflow identically every time', () => {
    const run = (): string => {
      const first = recordExecution(toAwaiting(twoStep()), response({ content: 'I. Grind' }));
      const ready = awaitExecution(buildRequest(preparePrompt(loadStep(first), catalogue)));
      return JSON.stringify(recordExecution(ready, response({ idempotencyKey: 'wf-1:draft' })));
    };
    expect(run()).toBe(run());
  });
});

describe('a response must answer the call that was made', () => {
  // Recording a mismatched pair would attribute one step's cost and output to
  // another.
  it('refuses a response with a different idempotency key', () => {
    expect(() =>
      recordExecution(toAwaiting(created()), response({ idempotencyKey: 'wf-9:other' })),
    ).toThrow(WorkflowError);
  });

  it('reports that as ResponseMismatch and names both keys', () => {
    try {
      recordExecution(toAwaiting(created()), response({ idempotencyKey: 'wf-9:other' }));
      expect.unreachable('must refuse');
    } catch (error) {
      expect((error as WorkflowError).code).toBe('ResponseMismatch');
      expect((error as WorkflowError).message).toContain('wf-9:other');
      expect((error as WorkflowError).message).toContain('wf-1:outline');
    }
  });
});

describe('what a finished step records', () => {
  it('records the typed facts and the output', () => {
    const done = recordExecution(toAwaiting(created()), response());
    expect(done.state.completedSteps[0]).toEqual({
      stepId: 'outline',
      promptVersion: 'planning.outline@7',
      idempotencyKey: 'wf-1:outline',
      providerId: 'reference',
      model: 'reference-model-2026-05-01',
      finishReason: 'stop',
      usage: response().usage,
      content: 'An outline.',
    });
  });

  // The prompt version resolves to the exact template, permanently — which is
  // what makes a past run explainable.
  it('records which prompt version ran', () => {
    const done = recordExecution(toAwaiting(created()), response());
    expect(done.state.completedSteps[0]?.promptVersion).toBe('planning.outline@7');
  });
});

describe('failure', () => {
  it('is legal from anywhere the run has not ended', () => {
    expect(fail(created(), 'cancelled').state.status).toBe('failed');
    expect(fail(start(created()), 'cancelled').state.status).toBe('failed');
    expect(fail(toAwaiting(created()), 'provider unavailable').state.status).toBe('failed');
  });

  it('records the reason', () => {
    expect(fail(created(), 'budget exhausted').state.failure).toBe('budget exhausted');
  });

  // A failure nobody can read is one nobody can act on.
  it('refuses a failure with no reason', () => {
    expect(() => fail(created(), '  ')).toThrow(/must say why/);
  });

  it('refuses to fail a run that already ended', () => {
    const done = recordExecution(toAwaiting(created()), response());
    expect(() => fail(done, 'too late')).toThrow(WorkflowError);
  });

  it('drops the pending request, so nothing can be dispatched afterwards', () => {
    const failed = fail(toAwaiting(created()), 'provider unavailable');
    expect(failed.state.prepared).toBeNull();
    expect(pendingRequest(failed)).toBeNull();
  });
});

describe('the result', () => {
  it('is available once the run completes', () => {
    const done = recordExecution(toAwaiting(created()), response());
    expect(resultOf(done)).toMatchObject({
      workflowId: 'wf-1',
      definitionId: 'article.draft',
      definitionVersion: 1,
      status: 'completed',
      failure: null,
    });
    expect(resultOf(done).steps).toHaveLength(1);
  });

  it('is available on failure, with what was done before it', () => {
    const failed = fail(toAwaiting(created()), 'provider unavailable');
    expect(resultOf(failed)).toMatchObject({ status: 'failed', failure: 'provider unavailable' });
    expect(resultOf(failed).steps).toEqual([]);
  });

  // A partial result would read as a complete one.
  it('is refused while the run is still going', () => {
    for (const execution of [created(), start(created()), toAwaiting(created())]) {
      expect(() => resultOf(execution)).toThrow(/no result yet/);
    }
  });

  it('is frozen', () => {
    const result = resultOf(recordExecution(toAwaiting(created()), response()));
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.steps)).toBe(true);
  });

  it('refuses a write', () => {
    const result = resultOf(recordExecution(toAwaiting(created()), response()));
    expect(() => {
      (result as { status: string }).status = 'failed';
    }).toThrow();
  });

  it('does not change when the execution it came from is advanced again', () => {
    const done = recordExecution(toAwaiting(created()), response());
    const result = resultOf(done);
    expect(() => recordExecution(done, response())).toThrow();
    expect(result.steps).toHaveLength(1);
  });
});

describe('a definition is checked before the run starts', () => {
  // A workflow that fails halfway because step 4 names no model has already
  // spent the money for steps 1 to 3.
  it('refuses an invalid definition at creation', () => {
    expect(() =>
      createWorkflowExecution({
        workflowId: 'wf-1',
        definition: definition({ steps: [] }),
        context,
      }),
    ).toThrow(WorkflowError);
  });

  it('reports that as InvalidDefinition', () => {
    try {
      createWorkflowExecution({
        workflowId: 'wf-1',
        definition: definition({ id: 'BAD' }),
        context,
      });
      expect.unreachable('must refuse');
    } catch (error) {
      expect((error as WorkflowError).code).toBe('InvalidDefinition');
    }
  });

  it('requires a workflow id, since it is half of every idempotency key', () => {
    expect(() =>
      createWorkflowExecution({ workflowId: '  ', definition: definition(), context }),
    ).toThrow(/needs an id/);
  });

  it('starts with an empty variable scope when none is given', () => {
    const bare = createWorkflowExecution({
      workflowId: 'wf-1',
      definition: definition(),
      context,
    });
    expect(bare.state.variables).toEqual({});
  });
});
