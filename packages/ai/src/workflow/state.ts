/**
 * The workflow state machine.
 *
 * One line, exactly as the increment draws it:
 *
 *   pending → started → step_loaded → prompt_prepared → execution_prepared
 *           → awaiting_execution → (started | completed)
 *
 * and `failed` from anywhere that has not finished.
 *
 * ── Why each box is its own state ───────────────────────────────────────────
 * They could be collapsed — "running" would cover five of them. They are not,
 * because the rejections the increment asks for are only expressible if the
 * machine can tell them apart:
 *
 *   execution before preparation — refused because recording a result is legal
 *     only from `awaiting_execution`, which is reachable only through
 *     `execution_prepared`;
 *   execution after completion — refused because `completed` has no outgoing
 *     transitions at all;
 *   duplicate completion — the same fact, and the reason terminal states are
 *     terminal rather than merely discouraged.
 *
 * ── The one edge that looks like a loop, and is not ─────────────────────────
 * `awaiting_execution → started` returns for the NEXT step, so every step
 * traverses the same six boxes. The cursor only ever increases, the step count
 * is fixed by the definition, and no condition decides where to go — which step
 * follows is the next index or nothing. That is a linear traversal of a fixed
 * list, not a loop and not a branch.
 */

export const WORKFLOW_STATUSES = [
  'pending',
  'started',
  'step_loaded',
  'prompt_prepared',
  'execution_prepared',
  'awaiting_execution',
  'completed',
  'failed',
] as const;

export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number];

export function isWorkflowStatus(value: unknown): value is WorkflowStatus {
  return typeof value === 'string' && (WORKFLOW_STATUSES as readonly string[]).includes(value);
}

/** Nothing leaves these. A workflow ends once. */
export const TERMINAL_WORKFLOW_STATUSES: readonly WorkflowStatus[] = ['completed', 'failed'];

export function isTerminalWorkflowStatus(status: WorkflowStatus): boolean {
  return TERMINAL_WORKFLOW_STATUSES.includes(status);
}

export const INITIAL_WORKFLOW_STATUS: WorkflowStatus = 'pending';

export const WORKFLOW_TRANSITIONS = [
  'start',
  'loadStep',
  'preparePrompt',
  'buildRequest',
  'awaitExecution',
  'recordExecution',
  'fail',
] as const;

export type WorkflowTransition = (typeof WORKFLOW_TRANSITIONS)[number];

export function isWorkflowTransition(value: unknown): value is WorkflowTransition {
  return typeof value === 'string' && (WORKFLOW_TRANSITIONS as readonly string[]).includes(value);
}

export interface WorkflowTransitionRule {
  readonly from: WorkflowStatus;
  /**
   * Null where the target depends on the position rather than the transition:
   * `recordExecution` lands on `started` when a step remains and `completed`
   * when none does. That is the only such case, and it is a function of the
   * cursor alone — never of what a model returned.
   */
  readonly to: WorkflowStatus | null;
}

export const WORKFLOW_TRANSITION_RULES: Readonly<
  Record<WorkflowTransition, WorkflowTransitionRule>
> = {
  start: { from: 'pending', to: 'started' },
  loadStep: { from: 'started', to: 'step_loaded' },
  preparePrompt: { from: 'step_loaded', to: 'prompt_prepared' },
  buildRequest: { from: 'prompt_prepared', to: 'execution_prepared' },
  awaitExecution: { from: 'execution_prepared', to: 'awaiting_execution' },
  recordExecution: { from: 'awaiting_execution', to: null },
  // `fail` is the exception: it is legal from every state that has not ended.
  fail: { from: 'pending', to: 'failed' },
};

export const WORKFLOW_ERROR_CODES = [
  'IllegalTransition',
  'InvalidDefinition',
  'StepNotLoaded',
  'PromptNotPrepared',
  'RequestNotBuilt',
  'ResponseMismatch',
  'NoSuchStep',
] as const;

export type WorkflowErrorCode = (typeof WORKFLOW_ERROR_CODES)[number];

export class WorkflowError extends Error {
  readonly code: WorkflowErrorCode;

  constructor(code: WorkflowErrorCode, message: string) {
    super(message);
    this.name = 'WorkflowError';
    this.code = code;
  }
}

export function isWorkflowError(value: unknown): value is WorkflowError {
  return value instanceof WorkflowError;
}

/** Whether a move is legal from a state. `fail` is legal until the end. */
export function canTransition(from: WorkflowStatus, transition: WorkflowTransition): boolean {
  if (transition === 'fail') return !isTerminalWorkflowStatus(from);
  return WORKFLOW_TRANSITION_RULES[transition].from === from;
}

/** Every move legal from a state, in declaration order. */
export function transitionsFrom(status: WorkflowStatus): readonly WorkflowTransition[] {
  return WORKFLOW_TRANSITIONS.filter((transition) => canTransition(status, transition));
}

/**
 * Refuse an illegal move, naming what WOULD have been legal.
 *
 * A caller asking for one usually holds a stale view of the workflow, so the
 * useful half of the message is what the workflow is actually ready for.
 */
export function assertTransitionAllowed(
  from: WorkflowStatus,
  transition: WorkflowTransition,
): void {
  if (canTransition(from, transition)) return;

  if (isTerminalWorkflowStatus(from)) {
    throw new WorkflowError(
      'IllegalTransition',
      `Cannot ${transition} a workflow that is already '${from}': a terminal workflow has no outgoing transitions, and a second ending would record two outcomes for one run.`,
    );
  }

  const legal = transitionsFrom(from);
  throw new WorkflowError(
    'IllegalTransition',
    `Cannot ${transition} from '${from}'; '${transition}' is only legal from '${WORKFLOW_TRANSITION_RULES[transition].from}'. From '${from}' the legal moves are: ${legal.join(', ')}.`,
  );
}
