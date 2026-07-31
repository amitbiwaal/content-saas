/**
 * The credit hold model — `04-platform/credits.md` §"Hold lifecycle".
 *
 * The states and the rules about them. No persistence: this is what the service
 * validates against, and what a test can exercise without a database.
 *
 * ```
 * [*] --> held : authorizeSpend
 * held --> settled : run reached a terminal state
 * held --> released : run failed before consumption / cancelled
 * held --> expired : hold TTL elapsed without settlement
 * ```
 *
 * ── Terminal is terminal ────────────────────────────────────────────────────
 * There is no edge out of `settled`, `released` or `expired`, and no edge
 * between them. A settle arriving after a release is not a state change; it is
 * a report that two deciders disagreed, and answering it by overwriting would
 * make the disagreement invisible.
 *
 * ── Why a released hold needs no refund ─────────────────────────────────────
 * A hold reserves nothing physically. Available balance is
 * `ledger balance − sum(amount − consumed of OPEN holds)`, so leaving `held`
 * releases the reservation by arithmetic. There is no compensating write to
 * forget, and no window where the credits are deducted twice.
 *
 * The `− consumed` matters: what has been spent is already a ledger debit, so
 * counting the whole reservation would subtract it a second time and show the
 * customer a balance below the real one.
 */

import { compareAmounts, formatAmount, parseAmount, type ScaledAmount } from './amount.js';

export const HOLD_STATES = ['held', 'settled', 'released', 'expired'] as const;

export type HoldState = (typeof HOLD_STATES)[number];

/** The only state that reserves credits. */
export const OPEN_HOLD_STATE = 'held';

export const TERMINAL_HOLD_STATES: readonly HoldState[] = ['settled', 'released', 'expired'];

export function isHoldState(value: string): value is HoldState {
  return (HOLD_STATES as readonly string[]).includes(value);
}

export function isTerminal(state: HoldState): boolean {
  return TERMINAL_HOLD_STATES.includes(state);
}

/**
 * The default TTL — 24 hours, "longer than the p99 pipeline".
 *
 * Too short strands a legitimate long run; too long lets a crashed orchestrator
 * hold a customer's balance down invisibly. The document picks 24h and the
 * sweep alerts on anything that reaches it, because an expired hold usually
 * means a lost workflow rather than a slow one.
 */
export const DEFAULT_HOLD_TTL_MS = 24 * 60 * 60 * 1000;

export type HoldErrorCode =
  | 'InsufficientCredits'
  | 'HoldNotFound'
  | 'HoldNotOpen'
  | 'HoldExceeded'
  | 'InvalidHoldState'
  | 'RunIdRequired'
  // ── Added by the settlement core ──────────────────────────────────────────
  // One taxonomy for one module: a second error type beside `HoldError` would
  // mean catching two things to learn one fact.
  /**
   * A charge whose identifiers do not match the reservation it names.
   *
   * Its own code because it is a different mistake from a bad state: the
   * reservation is fine, and the caller is about to file a charge under the
   * wrong organization, workspace or run — which bills the wrong client, in a
   * table with no UPDATE path.
   */
  | 'ConsumptionMismatch';

export class HoldError extends Error {
  readonly code: HoldErrorCode;

  constructor(code: HoldErrorCode, message: string) {
    super(message);
    this.name = 'HoldError';
    this.code = code;
  }
}

/**
 * Refused BEFORE any provider is called, which is the whole point of the
 * protocol — `402`, with what would have been needed.
 */
export class InsufficientCreditsError extends HoldError {
  readonly available: string;
  readonly required: string;
  readonly shortfall: string;

  constructor(available: string, required: string, shortfall: string) {
    super(
      'InsufficientCredits',
      `Insufficient credits: ${required} required, ${available} available, ${shortfall} short. No provider call was made.`,
    );
    this.name = 'InsufficientCreditsError';
    this.available = available;
    this.required = required;
    this.shortfall = shortfall;
  }
}

export interface CreditHold {
  readonly id: string;
  readonly tenantId: string;
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly runId: string;
  /** The reserved maximum. */
  readonly amount: string;
  /** Actual spend recorded against it so far. */
  readonly consumed: string;
  readonly state: HoldState;
  readonly expiresAt: string;
  readonly reason: string;
  readonly correlationId: string;
  readonly createdBy: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly settledAt: string | null;
  readonly releasedAt: string | null;
}

/** What is left of the reservation. Zero once the hold is closed. */
export function remainingOf(hold: CreditHold): ScaledAmount {
  const amount = parseAmount(hold.amount);
  const consumed = parseAmount(hold.consumed);
  return (hold.state === OPEN_HOLD_STATE ? amount - consumed : 0n) as ScaledAmount;
}

/**
 * A consumption must fit inside its reservation.
 *
 * The bound is also a CHECK on the table, so this cannot be the only guard —
 * but a constraint violation surfaces as an opaque driver error mid-transaction
 * and this names the hold, the request and the headroom.
 */
export function assertFitsWithinHold(hold: CreditHold, amount: ScaledAmount): void {
  if (hold.state !== OPEN_HOLD_STATE) {
    throw new HoldError(
      'HoldNotOpen',
      `Hold '${hold.id}' is ${hold.state}; consumption can only be recorded against an open hold.`,
    );
  }
  if (compareAmounts(amount, remainingOf(hold)) === 1) {
    throw new HoldError(
      'HoldExceeded',
      `Recording ${formatAmount(amount)} against hold '${hold.id}' would exceed its reservation of ${hold.amount} (already ${hold.consumed}). The reservation is the bound on worst-case spend.`,
    );
  }
}

/** Why a hold left `held`. Recorded on the event and the audit trail. */
export type HoldClosure = 'settled' | 'released' | 'expired';

export function stateFor(closure: HoldClosure): HoldState {
  return closure;
}
