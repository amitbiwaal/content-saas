/**
 * The workflow runtime.
 *
 * ── Deterministic by construction, not by discipline ────────────────────────
 * Every transition is a PURE FUNCTION from one execution to the next. Nothing
 * mutates, nothing reads a clock, nothing reads a random source, and every
 * returned state is frozen. "Workflow state must be deterministic" is therefore
 * not a rule someone has to remember — the same execution and the same command
 * cannot produce two different results, because there is nowhere for a
 * difference to come from.
 *
 * The absence of timestamps is part of that. A `startedAt` would make two
 * otherwise identical runs differ, and the workflow has no use for one: when
 * things happened is the job row's business (S2.1), which has a server clock.
 *
 * ── It never executes ───────────────────────────────────────────────────────
 * `buildRequest` produces the canonical `AIRequest` and stops. `execute` is
 * never called, imported, or reachable from this file. `recordExecution` is how
 * a response gets in, and it is the caller who obtained it.
 *
 * ── It never interprets ─────────────────────────────────────────────────────
 * The runtime reads a response's identity — which call it answered — and
 * carries its content to wherever the definition says. It never reads the
 * content to decide anything. Every decision here is a function of the
 * definition and the cursor.
 */

import type {
  AIParameters,
  AIRequest,
  AIResponse,
  FinishReason,
  TenantContext,
  Usage,
} from '@contentos/contracts';

import type { CompiledPrompt } from '../prompts/compile.js';
import { prepareExecution, type PromptExecutionRequest } from '../prompts/execution.js';
import type { PromptCatalogue } from '../prompts/resolver.js';
import type { PromptTemplateRef } from '../prompts/template.js';
import {
  validateWorkflowDefinition,
  type WorkflowDefinition,
  type WorkflowStep,
} from './definition.js';
import {
  assertTransitionAllowed,
  INITIAL_WORKFLOW_STATUS,
  WorkflowError,
  type WorkflowStatus,
} from './state.js';

/**
 * Everything the run is FOR, and nothing that changes as it advances.
 *
 * `TenantContext` is the existing one from `@contentos/contracts` — the same
 * type the dispatcher reconstructs and every handler receives. A second tenant
 * shape would be a second thing to keep in step with ADR-017.
 */
export interface WorkflowExecutionContext {
  readonly tenant: TenantContext;
  /** The job this workflow is the execution of (S2.1). */
  readonly jobId: string;
  readonly correlationId: string;
  /** Free-form, carried and never read. Strings only, so it stays loggable. */
  readonly metadata: Readonly<Record<string, string>>;
}

/** What one finished step recorded. Typed facts, plus the output it produced. */
export interface WorkflowStepResult {
  readonly stepId: string;
  /** `'planning.outline@7'` — resolves to the exact prompt, permanently. */
  readonly promptVersion: string;
  readonly idempotencyKey: string;
  readonly providerId: string;
  readonly model: string;
  readonly finishReason: FinishReason;
  readonly usage: Usage;
  /**
   * Carried, never interpreted. The runtime hands it to the next step's
   * variables when the definition says to, and makes no decision from it.
   */
  readonly content: string;
}

export interface WorkflowState {
  readonly status: WorkflowStatus;
  /** Which step is current. -1 before the first is loaded. */
  readonly stepIndex: number;
  readonly stepId: string | null;
  /** The prompt reference of the loaded step — it changes as the run advances. */
  readonly promptRef: PromptTemplateRef | null;
  readonly compiled: CompiledPrompt | null;
  readonly prepared: PromptExecutionRequest | null;
  /** The variable scope: the start values, plus whatever steps have bound. */
  readonly variables: Readonly<Record<string, unknown>>;
  readonly completedSteps: readonly WorkflowStepResult[];
  readonly failure: string | null;
}

export interface WorkflowExecution {
  /** This run's identity. Supplied, never generated — generation is not pure. */
  readonly workflowId: string;
  readonly definition: WorkflowDefinition;
  readonly context: WorkflowExecutionContext;
  readonly state: WorkflowState;
}

export interface WorkflowResult {
  readonly workflowId: string;
  readonly definitionId: string;
  readonly definitionVersion: number;
  readonly status: 'completed' | 'failed';
  readonly steps: readonly WorkflowStepResult[];
  readonly failure: string | null;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.getOwnPropertyNames(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

/** The next execution. The previous one is untouched and still valid. */
function next(execution: WorkflowExecution, state: Partial<WorkflowState>): WorkflowExecution {
  return deepFreeze({ ...execution, state: { ...execution.state, ...state } });
}

export interface StartWorkflowOptions {
  readonly workflowId: string;
  readonly definition: WorkflowDefinition;
  readonly context: WorkflowExecutionContext;
  /** The starting variable scope. Steps may add to it; nothing removes from it. */
  readonly variables?: Readonly<Record<string, unknown>>;
}

/**
 * Create a pending execution.
 *
 * The definition is validated HERE. A workflow that fails halfway through
 * because step 4 names no model has already spent the money for steps 1 to 3.
 */
export function createWorkflowExecution(options: StartWorkflowOptions): WorkflowExecution {
  const result = validateWorkflowDefinition(options.definition);
  if (!result.ok) {
    throw new WorkflowError(
      'InvalidDefinition',
      `Workflow '${String(options.definition.id)}' cannot run: ${result.issues
        .map((i) => `${i.field} ${i.code}`)
        .join(', ')}.`,
    );
  }
  if (options.workflowId.trim() === '') {
    throw new WorkflowError(
      'InvalidDefinition',
      "A workflow execution needs an id; it is half of every step's idempotency key.",
    );
  }

  return deepFreeze({
    workflowId: options.workflowId,
    definition: options.definition,
    context: options.context,
    state: {
      status: INITIAL_WORKFLOW_STATUS,
      stepIndex: -1,
      stepId: null,
      promptRef: null,
      compiled: null,
      prepared: null,
      variables: { ...(options.variables ?? {}) },
      completedSteps: [],
      failure: null,
    },
  });
}

/** START. */
export function start(execution: WorkflowExecution): WorkflowExecution {
  assertTransitionAllowed(execution.state.status, 'start');
  return next(execution, { status: 'started' });
}

/** LOAD STEP — the next one, which is always the next index. */
export function loadStep(execution: WorkflowExecution): WorkflowExecution {
  assertTransitionAllowed(execution.state.status, 'loadStep');

  const index = execution.state.stepIndex + 1;
  const step = execution.definition.steps[index];
  if (step === undefined) {
    throw new WorkflowError(
      'NoSuchStep',
      `Workflow '${execution.definition.id}' has ${String(execution.definition.steps.length)} steps and none at index ${String(index)}.`,
    );
  }

  return next(execution, {
    status: 'step_loaded',
    stepIndex: index,
    stepId: step.id,
    promptRef: step.templateRef,
    compiled: null,
    prepared: null,
  });
}

function currentStep(execution: WorkflowExecution): WorkflowStep {
  const step = execution.definition.steps[execution.state.stepIndex];
  if (step === undefined) {
    throw new WorkflowError('StepNotLoaded', 'No step is loaded.');
  }
  return step;
}

/**
 * PREPARE PROMPT — resolve and compile through the existing pipeline.
 *
 * The catalogue is passed in rather than held: a runtime that owned one would
 * be a second place templates live, and the composition root already builds
 * exactly one.
 */
export function preparePrompt(
  execution: WorkflowExecution,
  catalogue: PromptCatalogue,
): WorkflowExecution {
  assertTransitionAllowed(execution.state.status, 'preparePrompt');
  const step = currentStep(execution);

  const compiled = catalogue.render({
    templateRef: step.templateRef,
    variables: execution.state.variables,
    tenantId: execution.context.tenant.tenantId,
    correlationId: execution.context.correlationId,
  });

  return next(execution, { status: 'prompt_prepared', compiled });
}

/**
 * The key a retry of this step would reuse.
 *
 * Derived, not generated: two runs of the same workflow at the same step
 * produce the same key, which is what makes a redelivery a repeat rather than
 * a second charge.
 */
export function idempotencyKeyFor(workflowId: string, stepId: string): string {
  return `${workflowId}:${stepId}`;
}

/**
 * BUILD EXECUTION REQUEST — the canonical `AIRequest`, and nothing more.
 *
 * This is the closest the runtime comes to a provider. It produces what a
 * provider would be given and hands it back to the caller.
 */
export function buildRequest(execution: WorkflowExecution): WorkflowExecution {
  assertTransitionAllowed(execution.state.status, 'buildRequest');
  const step = currentStep(execution);
  const compiled = execution.state.compiled;
  if (compiled === null) {
    throw new WorkflowError('PromptNotPrepared', 'The prompt for this step has not been compiled.');
  }

  // Stated by the step, or the template's hints where the step is silent. The
  // workflow choosing to adopt the hints is visible here; `prepareExecution`
  // still never applies them on its own.
  const params: AIParameters = step.params ?? {
    temperature: compiled.hints.temperature,
    maxOutputTokens: compiled.hints.maxOutputTokens,
    ...(compiled.hints.seed === undefined ? {} : { seed: compiled.hints.seed }),
  };

  const request: AIRequest = {
    taskType: compiled.taskType,
    capability: step.capability,
    model: step.model,
    messages: compiled.messages,
    params,
    timeoutMs: step.timeoutMs,
    idempotencyKey: idempotencyKeyFor(execution.workflowId, step.id),
    correlationId: execution.context.correlationId,
    tenantId: execution.context.tenant.tenantId,
    organizationId: execution.context.tenant.organizationId,
  };

  const prepared = prepareExecution({ compiled, request, capability: step.capability });
  return next(execution, { status: 'execution_prepared', prepared });
}

/**
 * WAIT FOR EXECUTION.
 *
 * The state in which the workflow holds nothing and is doing nothing — which
 * is the whole reason it is a state rather than a gap between two calls. A run
 * parked here can be persisted, resumed, or abandoned, and the fact that it was
 * waiting is recorded rather than inferred.
 */
export function awaitExecution(execution: WorkflowExecution): WorkflowExecution {
  assertTransitionAllowed(execution.state.status, 'awaitExecution');
  if (execution.state.prepared === null) {
    throw new WorkflowError('RequestNotBuilt', 'No execution request has been built.');
  }
  return next(execution, { status: 'awaiting_execution' });
}

/**
 * Record what came back, and advance.
 *
 * The next state is `step_loaded` when a step remains and `completed` when none
 * does — a function of the cursor, never of the response.
 */
export function recordExecution(
  execution: WorkflowExecution,
  response: AIResponse,
): WorkflowExecution {
  assertTransitionAllowed(execution.state.status, 'recordExecution');
  const step = currentStep(execution);
  const prepared = execution.state.prepared;
  if (prepared === null) {
    throw new WorkflowError('RequestNotBuilt', 'No execution request has been built.');
  }

  // A response carrying a different key answered a different call; recording it
  // here would attribute one step's cost and output to another.
  if (response.idempotencyKey !== prepared.request.idempotencyKey) {
    throw new WorkflowError(
      'ResponseMismatch',
      `The response answers '${response.idempotencyKey}' but step '${step.id}' asked '${prepared.request.idempotencyKey}'.`,
    );
  }

  const result: WorkflowStepResult = {
    stepId: step.id,
    promptVersion: prepared.promptVersion,
    idempotencyKey: prepared.request.idempotencyKey,
    providerId: response.providerId,
    model: response.model,
    finishReason: response.finishReason,
    usage: response.usage,
    content: response.content,
  };

  const variables =
    step.bindOutputTo === undefined
      ? execution.state.variables
      : { ...execution.state.variables, [step.bindOutputTo]: response.content };

  // Back to `started` when a step remains, so the next one traverses the same
  // six boxes this one did. Advancing the cursor HERE would let steps 2..N skip
  // LOAD STEP, and a caller could no longer drive the run with one uniform
  // loop — which is exactly how the asymmetry would be discovered: as a caller
  // bug, much later.
  const done = execution.state.stepIndex + 1 >= execution.definition.steps.length;

  return next(execution, {
    status: done ? 'completed' : 'started',
    completedSteps: [...execution.state.completedSteps, result],
    variables,
    stepId: null,
    promptRef: null,
    compiled: null,
    prepared: null,
  });
}

/** End the run. Legal from anywhere that has not already ended. */
export function fail(execution: WorkflowExecution, reason: string): WorkflowExecution {
  assertTransitionAllowed(execution.state.status, 'fail');
  if (reason.trim() === '') {
    throw new WorkflowError(
      'IllegalTransition',
      'A failed workflow must say why; a failure nobody can read is one nobody can act on.',
    );
  }
  return next(execution, {
    status: 'failed',
    failure: reason,
    compiled: null,
    prepared: null,
  });
}

/**
 * The terminal outcome.
 *
 * Only from a terminal state: a result read from a running workflow would be a
 * partial one that reads as complete.
 */
export function resultOf(execution: WorkflowExecution): WorkflowResult {
  const { status } = execution.state;
  if (status !== 'completed' && status !== 'failed') {
    throw new WorkflowError(
      'IllegalTransition',
      `Workflow '${execution.workflowId}' is '${status}' and has no result yet; a partial result would read as a complete one.`,
    );
  }

  return deepFreeze({
    workflowId: execution.workflowId,
    definitionId: execution.definition.id,
    definitionVersion: execution.definition.version,
    status,
    steps: [...execution.state.completedSteps],
    failure: execution.state.failure,
  });
}

/** The request a caller should execute now, or null if none is pending. */
export function pendingRequest(execution: WorkflowExecution): AIRequest | null {
  return execution.state.status === 'awaiting_execution' && execution.state.prepared !== null
    ? execution.state.prepared.request
    : null;
}
