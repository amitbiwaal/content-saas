/**
 * The content run state machine.
 *
 *   CREATED → COMPILING → READY → RUNNING → COMPLETED | FAILED | CANCELLED
 *
 * ── Why a second state machine, next to the workflow runtime's ─────────────
 * They describe different things. The workflow runtime's states are about ONE
 * step's progress — loaded, prompt prepared, request built, awaiting execution.
 * These are about the RUN: whether it has been compiled, whether it is under
 * way, and how it ended. A run that failed to compile never had a workflow
 * execution at all, and there is no runtime status that says so.
 *
 * ── Transitions are data, and illegal ones throw ───────────────────────────
 * The same discipline the job and workflow machines use. A transition table a
 * reader can see beats a chain of `if`s that has to be reconstructed, and a
 * thrown `IllegalTransition` is a defect surfaced rather than a run quietly in
 * two states at once.
 *
 * ── Cancellation is reachable from anywhere before a terminal state ────────
 * A caller may cancel while a run is compiling or mid-flight. Making cancel
 * reachable only from RUNNING would mean a cancel arriving during compilation
 * had nowhere to go, and the run would finish work nobody wanted.
 */

export const RUN_STATUSES = [
  'created',
  'compiling',
  'ready',
  'running',
  'completed',
  'failed',
  'cancelled',
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

export function isRunStatus(value: unknown): value is RunStatus {
  return typeof value === 'string' && (RUN_STATUSES as readonly string[]).includes(value);
}

export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = Object.freeze([
  'completed',
  'failed',
  'cancelled',
]);

export function isTerminalRunStatus(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.includes(status);
}

export const RUN_TRANSITIONS = ['compile', 'ready', 'start', 'complete', 'fail', 'cancel'] as const;

export type RunTransition = (typeof RUN_TRANSITIONS)[number];

export interface RunTransitionRule {
  readonly from: RunStatus;
  readonly transition: RunTransition;
  readonly to: RunStatus;
}

/**
 * The whole machine, as data.
 *
 * `fail` is reachable from every non-terminal state because every stage can
 * fail: resolution, compilation and execution each have their own way of going
 * wrong, and a machine that only failed from RUNNING would need a second
 * mechanism for the other two.
 */
export const RUN_TRANSITION_RULES: readonly RunTransitionRule[] = Object.freeze([
  { from: 'created', transition: 'compile', to: 'compiling' },
  { from: 'compiling', transition: 'ready', to: 'ready' },
  { from: 'ready', transition: 'start', to: 'running' },
  { from: 'running', transition: 'complete', to: 'completed' },

  { from: 'created', transition: 'fail', to: 'failed' },
  { from: 'compiling', transition: 'fail', to: 'failed' },
  { from: 'ready', transition: 'fail', to: 'failed' },
  { from: 'running', transition: 'fail', to: 'failed' },

  { from: 'created', transition: 'cancel', to: 'cancelled' },
  { from: 'compiling', transition: 'cancel', to: 'cancelled' },
  { from: 'ready', transition: 'cancel', to: 'cancelled' },
  { from: 'running', transition: 'cancel', to: 'cancelled' },
]);

export const INITIAL_RUN_STATUS: RunStatus = 'created';

export const RUN_ERROR_CODES = ['IllegalTransition', 'InvalidRun'] as const;

export type RunErrorCode = (typeof RUN_ERROR_CODES)[number];

export class RunError extends Error {
  readonly code: RunErrorCode;
  constructor(code: RunErrorCode, message: string) {
    super(message);
    this.name = 'RunError';
    this.code = code;
  }
}

export function isRunError(value: unknown): value is RunError {
  return value instanceof RunError;
}

/** Where a transition leads, or null when it is not allowed from here. */
export function targetOf(from: RunStatus, transition: RunTransition): RunStatus | null {
  return (
    RUN_TRANSITION_RULES.find((rule) => rule.from === from && rule.transition === transition)?.to ??
    null
  );
}

export function canTransition(from: RunStatus, transition: RunTransition): boolean {
  return targetOf(from, transition) !== null;
}

/** Every transition available from a state. For an error message and a test. */
export function transitionsFrom(from: RunStatus): readonly RunTransition[] {
  return Object.freeze(
    RUN_TRANSITION_RULES.filter((rule) => rule.from === from).map((rule) => rule.transition),
  );
}

/**
 * Assert and resolve. Throws rather than returning null, because every caller
 * here is about to move a run and a forgotten null check would move it anyway.
 */
export function assertTransitionAllowed(from: RunStatus, transition: RunTransition): RunStatus {
  const to = targetOf(from, transition);
  if (to === null) {
    const available = transitionsFrom(from);
    throw new RunError(
      'IllegalTransition',
      `A run in '${from}' cannot '${transition}'. ${
        available.length === 0 ? `'${from}' is terminal.` : `Available: ${available.join(', ')}.`
      }`,
    );
  }
  return to;
}
