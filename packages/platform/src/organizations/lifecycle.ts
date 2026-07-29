/**
 * Organization lifecycle — `02-domain-design/organizations.md` §Lifecycle.
 *
 * Pure. No SQL, no clock, no events: the state machine is the part that has to
 * be obviously correct, so it is separated from everything that makes a test
 * need a database.
 *
 * The five states are FIXED by `ck_organizations__status` in migration 0003.
 * This module and that CHECK constraint must agree — a status the database
 * refuses is not a state, and one the database allows but this module does not
 * know about is a row nothing can transition.
 */

/** Ordered as the lifecycle diagram reads, not alphabetically. */
export const ORGANIZATION_STATUSES = [
  'active',
  'past_due',
  'suspended',
  'pending_closure',
  'closed',
] as const;

export type OrganizationStatus = (typeof ORGANIZATION_STATUSES)[number];

export function isOrganizationStatus(value: string): value is OrganizationStatus {
  return (ORGANIZATION_STATUSES as readonly string[]).includes(value);
}

/**
 * Transitions are NAMED, not inferred from a (from, to) pair.
 *
 * Two different causes can produce the same pair — a grace timer elapsing and
 * an abuse action both move an organization to `suspended` — and they carry
 * different reasons and audit actions. Naming the transition keeps the cause in
 * the type system instead of in a comment.
 */
export const ORGANIZATION_TRANSITIONS = [
  'payment_failed',
  'payment_recovered',
  'suspend',
  'reactivate',
  'request_closure',
  'cancel_closure',
  'close',
] as const;

export type OrganizationTransition = (typeof ORGANIZATION_TRANSITIONS)[number];

/**
 * Where a transition lands.
 *
 * `restore` is the interesting one. Reactivation does NOT force `active`: an
 * organization suspended while it was already `past_due` still owes money when
 * the suspension lifts, and silently clearing that would be a revenue-integrity
 * bug. The same reasoning is why lifting a cancelled closure must not lift a
 * suspension that was in force when closure was requested.
 *
 * `permitted` bounds what a restore may produce. The recorded prior status is
 * read back from the audit trail, and a value outside this set — corrupted,
 * hand-edited, or written by an older revision of this code — falls back rather
 * than being trusted into a nonsensical state.
 */
export type TransitionTarget =
  | { readonly kind: 'fixed'; readonly status: OrganizationStatus }
  | {
      readonly kind: 'restore';
      readonly permitted: readonly OrganizationStatus[];
      readonly fallback: OrganizationStatus;
    };

export interface TransitionRule {
  readonly from: readonly OrganizationStatus[];
  readonly target: TransitionTarget;
}

/**
 * The state machine, transcribed from the lifecycle diagram.
 *
 * `closed` appears in no `from` list. It is terminal, and terminality is
 * expressed by absence rather than by a guard that could be forgotten at one
 * call site.
 */
export const TRANSITION_RULES: Readonly<Record<OrganizationTransition, TransitionRule>> = {
  payment_failed: {
    from: ['active'],
    target: { kind: 'fixed', status: 'past_due' },
  },
  payment_recovered: {
    from: ['past_due'],
    target: { kind: 'fixed', status: 'active' },
  },
  // Both a policy/abuse action and an elapsed grace timer arrive here; the
  // cause travels in `reason`, which the event payload requires anyway.
  suspend: {
    from: ['active', 'past_due'],
    target: { kind: 'fixed', status: 'suspended' },
  },
  reactivate: {
    from: ['suspended'],
    target: { kind: 'restore', permitted: ['active', 'past_due'], fallback: 'active' },
  },
  request_closure: {
    from: ['active', 'past_due', 'suspended'],
    target: { kind: 'fixed', status: 'pending_closure' },
  },
  cancel_closure: {
    from: ['pending_closure'],
    target: {
      kind: 'restore',
      permitted: ['active', 'past_due', 'suspended'],
      fallback: 'active',
    },
  },
  close: {
    from: ['pending_closure'],
    target: { kind: 'fixed', status: 'closed' },
  },
};

/** The status an organization is provisioned into. */
export const INITIAL_STATUS: OrganizationStatus = 'active';

/** `pending_closure` is a 30-day window: read-only, exportable, cancellable. */
export const CLOSURE_WINDOW_DAYS = 30;

export type OrganizationErrorCode =
  | 'InvalidTransition'
  | 'OrganizationNotFound'
  | 'ConcurrentModification'
  | 'SlugAlreadyTaken';

/**
 * Typed, because callers branch on the failure.
 *
 * A cross-organization access attempt is answered `404` and a slug race is
 * answered `409`; a single untyped Error would make the API layer parse
 * message strings to tell them apart.
 */
export class OrganizationError extends Error {
  readonly code: OrganizationErrorCode;

  constructor(code: OrganizationErrorCode, message: string) {
    super(message);
    this.name = 'OrganizationError';
    this.code = code;
  }
}

export function canTransition(
  from: OrganizationStatus,
  transition: OrganizationTransition,
): boolean {
  return TRANSITION_RULES[transition].from.includes(from);
}

/** Every transition permitted out of a status. Empty for `closed`. */
export function transitionsFrom(status: OrganizationStatus): readonly OrganizationTransition[] {
  return ORGANIZATION_TRANSITIONS.filter((t) => canTransition(status, t));
}

export function assertTransitionAllowed(
  from: OrganizationStatus,
  transition: OrganizationTransition,
): void {
  if (!canTransition(from, transition)) {
    const allowed = TRANSITION_RULES[transition].from.join(', ');
    throw new OrganizationError(
      'InvalidTransition',
      `Cannot '${transition}' an organization in status '${from}'; permitted from: ${allowed || '(none — terminal)'}.`,
    );
  }
}

/**
 * The status a transition lands in.
 *
 * `recordedPrevious` is the prior status read back from the audit trail. It is
 * consulted ONLY by restoring transitions, and only when it is a value that
 * transition is allowed to produce.
 */
export function resolveTarget(
  transition: OrganizationTransition,
  recordedPrevious: string | null = null,
): OrganizationStatus {
  const { target } = TRANSITION_RULES[transition];
  if (target.kind === 'fixed') return target.status;

  if (
    recordedPrevious !== null &&
    isOrganizationStatus(recordedPrevious) &&
    target.permitted.includes(recordedPrevious)
  ) {
    return recordedPrevious;
  }
  return target.fallback;
}

/** True when the transition restores a recorded prior status rather than a fixed one. */
export function restoresPreviousStatus(transition: OrganizationTransition): boolean {
  return TRANSITION_RULES[transition].target.kind === 'restore';
}
