/**
 * The job lifecycle — the pure state machine.
 *
 * ```
 * queued ──start──▶ running ──complete──▶ completed
 *                       ├────fail─────▶ failed
 *                       └───cancel────▶ cancelled
 * ```
 *
 * No persistence and no events: this is what the service validates against, and
 * what a test can exercise without a database.
 *
 * ── The transitions are declared, not implied ───────────────────────────────
 * Every legal move is a named entry with its `from` and `to`. Anything not in
 * the table is illegal by construction, so "which moves are allowed?" is
 * answerable by reading one list rather than by tracing conditionals — and
 * adding a move is a visible change to that list.
 *
 * ── Cancel is reachable only from `running` ─────────────────────────────────
 * DELIBERATE, and worth flagging: the increment's diagram is linear —
 * `QUEUED → RUNNING → COMPLETED | FAILED | CANCELLED` — so a queued job cannot
 * be cancelled. Cancelling before work starts is the obvious real need and this
 * refuses it; widening the machine on that reasoning would be inventing a
 * transition the increment did not specify. It is one entry to add when asked.
 *
 * ── Terminal is terminal ────────────────────────────────────────────────────
 * There is no edge out of `completed`, `failed` or `cancelled`, and none
 * between them. A completion arriving after a cancellation is not a state
 * change; it is a report that two deciders disagreed, and answering it by
 * overwriting would make the disagreement invisible.
 */

export const JOB_STATUSES = ['queued', 'running', 'completed', 'failed', 'cancelled'] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

/** The only state a runner may claim. */
export const INITIAL_JOB_STATUS = 'queued';

export const TERMINAL_JOB_STATUSES: readonly JobStatus[] = ['completed', 'failed', 'cancelled'];

export const JOB_TRANSITIONS = ['start', 'complete', 'fail', 'cancel'] as const;

export type JobTransition = (typeof JOB_TRANSITIONS)[number];

export interface JobTransitionRule {
  /** The one state this move is legal from. */
  readonly from: JobStatus;
  readonly to: JobStatus;
  /** Whether the move must state why. */
  readonly requiresReason: boolean;
}

/**
 * The whole machine. Each move has exactly ONE legal origin, which is what
 * makes "illegal transition" a lookup rather than a judgement.
 */
export const JOB_TRANSITION_RULES: Readonly<Record<JobTransition, JobTransitionRule>> = {
  start: { from: 'queued', to: 'running', requiresReason: false },
  complete: { from: 'running', to: 'completed', requiresReason: false },
  // A failure nobody explained cannot be triaged, and a cancellation nobody
  // explained cannot be distinguished from a bug.
  fail: { from: 'running', to: 'failed', requiresReason: true },
  cancel: { from: 'running', to: 'cancelled', requiresReason: true },
};

export function isJobStatus(value: string): value is JobStatus {
  return (JOB_STATUSES as readonly string[]).includes(value);
}

export function isTerminalJobStatus(status: JobStatus): boolean {
  return TERMINAL_JOB_STATUSES.includes(status);
}

export function isJobTransition(value: string): value is JobTransition {
  return (JOB_TRANSITIONS as readonly string[]).includes(value);
}

export function canTransition(from: JobStatus, transition: JobTransition): boolean {
  return JOB_TRANSITION_RULES[transition].from === from;
}

/** Every move legal out of a status. Empty for all three terminal states. */
export function transitionsFrom(status: JobStatus): readonly JobTransition[] {
  return JOB_TRANSITIONS.filter((transition) => canTransition(status, transition));
}

export function targetOf(transition: JobTransition): JobStatus {
  return JOB_TRANSITION_RULES[transition].to;
}

export type JobErrorCode =
  | 'JobNotFound'
  | 'IllegalTransition'
  | 'ReasonRequired'
  | 'InvalidJobState'
  | 'JobTypeRequired';

export class JobError extends Error {
  readonly code: JobErrorCode;

  constructor(code: JobErrorCode, message: string) {
    super(message);
    this.name = 'JobError';
    this.code = code;
  }
}

/**
 * Refuse an illegal move, naming what WOULD be legal.
 *
 * The message carries the current state and the moves available from it,
 * because the caller asking for an illegal one is usually holding a stale view
 * of the job rather than making an error of intent.
 */
export function assertTransitionAllowed(from: JobStatus, transition: JobTransition): void {
  if (canTransition(from, transition)) return;

  const available = transitionsFrom(from);
  throw new JobError(
    'IllegalTransition',
    isTerminalJobStatus(from)
      ? `Cannot ${transition} a job that is already ${from}; terminal states have no outgoing transitions.`
      : `Cannot ${transition} a job that is ${from}; ${transition} is only legal from '${JOB_TRANSITION_RULES[transition].from}'. Available: ${available.length === 0 ? 'none' : available.join(', ')}.`,
  );
}

/** A move that must state why, refused when it does not. */
export function assertReasonPresent(transition: JobTransition, reason: string | null): void {
  if (!JOB_TRANSITION_RULES[transition].requiresReason) return;
  if (reason !== null && reason.trim() !== '') return;

  throw new JobError(
    'ReasonRequired',
    `A job may not be ${targetOf(transition)} without a reason; it is the only place the why is recorded, since events carry no free text.`,
  );
}

/** A job row as it exists in `jobs`. */
export interface Job {
  readonly id: string;
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly organizationId: string;
  readonly jobType: string;
  readonly status: JobStatus;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly payload: Readonly<Record<string, unknown>>;
  /** Set for `failed` and `cancelled`, null otherwise. */
  readonly reason: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt: string | null;
  /** When the job STOPPED, whichever way it ended. */
  readonly completedAt: string | null;
}
