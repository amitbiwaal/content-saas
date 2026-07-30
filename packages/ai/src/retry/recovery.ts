/**
 * Recovery — deciding what to do with a run that stopped partway.
 *
 * A workflow can be interrupted anywhere: a worker is redeployed, a process is
 * killed, a response never arrives. Recovery reads the state the runtime
 * already keeps and says what should happen. It changes nothing itself.
 *
 * ── Idempotent by construction ──────────────────────────────────────────────
 * `recover` is a pure function of the execution. Calling it twice on the same
 * state gives the same answer, because there is no state of its own to advance.
 * That is what makes recovery safe to run on a schedule, on startup, and again
 * after it half-finished — which is exactly when it gets run.
 *
 * ── It never duplicates successful execution ────────────────────────────────
 * The dangerous recovery is the one that re-dispatches a call that already
 * succeeded. Two things prevent it. A completed run recovers to
 * `ignore-duplicate-completion`, which does nothing. And a resumed call
 * re-dispatches the SAME prepared request, carrying the same idempotency key —
 * so even a genuinely ambiguous interruption cannot become a second generation
 * where the provider honours the key, and is metered honestly as two attempts
 * where it does not.
 *
 * ── It is not a second workflow engine ──────────────────────────────────────
 * It reads `WorkflowExecution` and returns a decision. Advancing the run is the
 * runtime's, and the runtime's state machine still refuses every illegal move
 * whatever this says.
 */

import type { AIRequest } from '@contentos/contracts';

import { pendingRequest, type WorkflowExecution } from '../workflow/engine.js';
import type { WorkflowStatus } from '../workflow/state.js';
import { decideRetry, type DecideOptions, type RetryDecision, type RetryState } from './engine.js';

export const RECOVERY_ACTIONS = [
  'resume',
  'redispatch',
  'retry',
  'fail',
  'ignore-duplicate-completion',
] as const;

export type RecoveryAction = (typeof RECOVERY_ACTIONS)[number];

export function isRecoveryAction(value: unknown): value is RecoveryAction {
  return typeof value === 'string' && (RECOVERY_ACTIONS as readonly string[]).includes(value);
}

export interface RecoveryResult {
  readonly action: RecoveryAction;
  readonly workflowId: string;
  /** The status the run was found in. */
  readonly status: WorkflowStatus;
  /**
   * True when acting on this changes nothing.
   *
   * The property that makes running recovery twice safe: a no-op result is one
   * a caller can apply repeatedly without consequence.
   */
  readonly noop: boolean;
  /**
   * The request to send again, for an interrupted call.
   *
   * The SAME request the runtime prepared, with the same idempotency key —
   * never a rebuilt one, because a rebuilt request is a new call.
   */
  readonly request: AIRequest | null;
  /** The retry decision, where the interruption was a recorded failure. */
  readonly retry: RetryDecision | null;
  readonly detail: string;
}

export interface RecoverOptions {
  /**
   * The failure history for the interrupted call, where there is one.
   *
   * Supplied rather than derived: the runtime does not record provider
   * failures — it records outcomes — and a recovery that invented an attempt
   * history would be deciding from a number it made up.
   */
  readonly retryState?: RetryState;
  readonly decide?: DecideOptions;
}

function result(
  execution: WorkflowExecution,
  action: RecoveryAction,
  noop: boolean,
  detail: string,
  extra: { request?: AIRequest | null; retry?: RetryDecision | null } = {},
): RecoveryResult {
  return Object.freeze({
    action,
    workflowId: execution.workflowId,
    status: execution.state.status,
    noop,
    request: extra.request ?? null,
    retry: extra.retry ?? null,
    detail,
  });
}

/**
 * Decide how to recover an interrupted run.
 *
 * Reads the workflow's own state and nothing else, so the answer is the same
 * however many times it is asked.
 */
export function recover(
  execution: WorkflowExecution,
  options: RecoverOptions = {},
): RecoveryResult {
  const { status } = execution.state;

  switch (status) {
    // The run finished. Recovering it is a no-op, and saying so explicitly is
    // what stops a recovery sweep re-dispatching work that already succeeded.
    case 'completed':
      return result(
        execution,
        'ignore-duplicate-completion',
        true,
        'The run completed. Recovery does nothing; re-dispatching would duplicate work that already succeeded and was already metered.',
      );

    // Already ended the other way. Failing it again would record two outcomes.
    case 'failed':
      return result(execution, 'fail', true, 'The run already failed. Its outcome stands.');

    // The interesting one: a request was prepared and handed off, and no
    // response came back. Whether that call reached the provider is unknowable
    // from here, which is precisely why the same idempotency key is reused.
    case 'awaiting_execution': {
      const request = pendingRequest(execution);
      if (request === null) {
        return result(
          execution,
          'fail',
          false,
          'The run is awaiting an execution it has no prepared request for; there is nothing to send and nothing to wait for.',
        );
      }

      if (options.retryState === undefined) {
        return result(
          execution,
          'redispatch',
          false,
          'No failure was recorded, so the call was interrupted rather than refused. The same request is sent again, carrying the same idempotency key.',
          { request },
        );
      }

      const decision = decideRetry(options.retryState, options.decide ?? {});
      return decision.action === 'retry'
        ? result(
            execution,
            'retry',
            false,
            `The call failed and another attempt is warranted: ${decision.detail}`,
            { request, retry: decision },
          )
        : result(
            execution,
            'fail',
            false,
            `The call failed and no further attempt is warranted: ${decision.detail}`,
            { retry: decision },
          );
    }

    // Interrupted before anything left the process. Nothing was dispatched, so
    // resuming costs nothing and duplicates nothing.
    case 'pending':
    case 'started':
    case 'step_loaded':
    case 'prompt_prepared':
    case 'execution_prepared':
      return result(
        execution,
        'resume',
        false,
        `The run stopped at '${status}', before any request left the process. It resumes from there; nothing was dispatched, so nothing can be duplicated.`,
      );
  }
}

/**
 * Whether two recoveries of the same run agree.
 *
 * Exported because "recovery is idempotent" is a claim, and a claim about
 * repeatability should be checkable by the thing that makes it.
 */
export function sameRecovery(a: RecoveryResult, b: RecoveryResult): boolean {
  return (
    a.action === b.action &&
    a.workflowId === b.workflowId &&
    a.status === b.status &&
    a.noop === b.noop &&
    a.request?.idempotencyKey === b.request?.idempotencyKey &&
    a.retry?.action === b.retry?.action &&
    a.retry?.attempt === b.retry?.attempt
  );
}
