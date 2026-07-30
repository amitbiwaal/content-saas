/**
 * Workspace lifecycle — `02-domain-design/workspace.md` §Lifecycle and
 * `04-platform/workspaces.md` §Lifecycle.
 *
 * Pure. No SQL, no clock, no events.
 *
 * The four states are FIXED by `ck_workspaces__status` in migration 0004.
 * `purge` is deliberately absent: the state diagram's `PendingDeletion --> [*]`
 * leaves the state machine entirely, its producer is the Retention worker, and
 * it is an ordered destruction sequence across content, knowledge and object
 * storage — not a status change (`04-platform/workspaces.md` §"Implementation
 * notes").
 */

/** Ordered as the lifecycle diagram reads. */
export const WORKSPACE_STATUSES = ['active', 'suspended', 'archived', 'pending_deletion'] as const;

export type WorkspaceStatus = (typeof WORKSPACE_STATUSES)[number];

export function isWorkspaceStatus(value: string): value is WorkspaceStatus {
  return (WORKSPACE_STATUSES as readonly string[]).includes(value);
}

/**
 * What a workspace can do in each state — `04-platform/workspaces.md` §Lifecycle.
 *
 * READS ARE TRUE IN EVERY STATE, and that is a rule rather than a coincidence:
 * "a suspended customer must be able to export their data — withholding it is
 * both bad practice and, in several jurisdictions, unlawful". It is a table
 * rather than scattered `if (status === …)` checks so that a new state cannot
 * be added without deciding, in one place, what it permits.
 */
export interface WorkspaceCapabilities {
  readonly reads: boolean;
  readonly newRuns: boolean;
  readonly publishing: boolean;
  /** `archived` and `pending_deletion` do NOT consume plan quota. */
  readonly countsTowardQuota: boolean;
}

export const WORKSPACE_CAPABILITIES: Readonly<Record<WorkspaceStatus, WorkspaceCapabilities>> = {
  active: { reads: true, newRuns: true, publishing: true, countsTowardQuota: true },
  suspended: { reads: true, newRuns: false, publishing: false, countsTowardQuota: true },
  archived: { reads: true, newRuns: false, publishing: false, countsTowardQuota: false },
  pending_deletion: { reads: true, newRuns: false, publishing: false, countsTowardQuota: false },
};

export function capabilitiesOf(status: WorkspaceStatus): WorkspaceCapabilities {
  return WORKSPACE_CAPABILITIES[status];
}

/**
 * The statuses that consume plan quota.
 *
 * Derived from the capability table rather than written twice, so the quota
 * query and the documented matrix cannot drift apart.
 */
export const QUOTA_COUNTING_STATUSES: readonly WorkspaceStatus[] = WORKSPACE_STATUSES.filter(
  (status) => WORKSPACE_CAPABILITIES[status].countsTowardQuota,
);

export const WORKSPACE_TRANSITIONS = [
  'suspend',
  'reactivate',
  'archive',
  'restore',
  'request_deletion',
  'cancel_deletion',
] as const;

export type WorkspaceTransition = (typeof WORKSPACE_TRANSITIONS)[number];

export type WorkspaceTransitionTarget =
  | { readonly kind: 'fixed'; readonly status: WorkspaceStatus }
  | {
      readonly kind: 'restore';
      readonly permitted: readonly WorkspaceStatus[];
      readonly fallback: WorkspaceStatus;
    };

export interface WorkspaceTransitionRule {
  readonly from: readonly WorkspaceStatus[];
  readonly target: WorkspaceTransitionTarget;
}

/**
 * The state machine, transcribed from the lifecycle diagram.
 *
 * Three transitions RESTORE rather than fix a status, and each is load-bearing:
 *
 *  - `restore` from `archived` may land on `suspended`, because a workspace
 *    that was suspended before being archived is still suspended afterwards.
 *    Un-archiving is not a pardon.
 *  - `cancel_deletion` may land on `archived`, because cancelling a deletion
 *    request must not silently un-archive.
 *  - `reactivate` restores the status recorded at suspension, which is what
 *    makes an organization-level cascade correct: "a workspace archived before
 *    an organization suspension stays archived".
 */
export const WORKSPACE_TRANSITION_RULES: Readonly<
  Record<WorkspaceTransition, WorkspaceTransitionRule>
> = {
  suspend: {
    from: ['active'],
    target: { kind: 'fixed', status: 'suspended' },
  },
  reactivate: {
    from: ['suspended'],
    target: { kind: 'restore', permitted: ['active'], fallback: 'active' },
  },
  archive: {
    from: ['active', 'suspended'],
    target: { kind: 'fixed', status: 'archived' },
  },
  restore: {
    from: ['archived'],
    target: { kind: 'restore', permitted: ['active', 'suspended'], fallback: 'active' },
  },
  request_deletion: {
    from: ['active', 'archived'],
    target: { kind: 'fixed', status: 'pending_deletion' },
  },
  cancel_deletion: {
    from: ['pending_deletion'],
    target: { kind: 'restore', permitted: ['active', 'archived'], fallback: 'active' },
  },
};

/** A workspace is provisioned active. */
export const WORKSPACE_INITIAL_STATUS: WorkspaceStatus = 'active';

/** `pending_deletion` opens a 30-day recovery window; after it, purge is irreversible. */
export const DELETION_WINDOW_DAYS = 30;

export type WorkspaceErrorCode =
  | 'InvalidTransition'
  | 'WorkspaceNotFound'
  | 'ConcurrentModification'
  | 'SlugAlreadyTaken'
  | 'QuotaExceeded'
  | 'OrganizationNotFound'
  | 'OrganizationNotActive'
  | 'TenantContextMismatch';

export class WorkspaceError extends Error {
  readonly code: WorkspaceErrorCode;

  constructor(code: WorkspaceErrorCode, message: string) {
    super(message);
    this.name = 'WorkspaceError';
    this.code = code;
  }
}

export function canTransitionWorkspace(
  from: WorkspaceStatus,
  transition: WorkspaceTransition,
): boolean {
  return WORKSPACE_TRANSITION_RULES[transition].from.includes(from);
}

export function workspaceTransitionsFrom(status: WorkspaceStatus): readonly WorkspaceTransition[] {
  return WORKSPACE_TRANSITIONS.filter((t) => canTransitionWorkspace(status, t));
}

export function assertWorkspaceTransitionAllowed(
  from: WorkspaceStatus,
  transition: WorkspaceTransition,
): void {
  if (!canTransitionWorkspace(from, transition)) {
    const allowed = WORKSPACE_TRANSITION_RULES[transition].from.join(', ');
    throw new WorkspaceError(
      'InvalidTransition',
      `Cannot '${transition}' a workspace in status '${from}'; permitted from: ${allowed}.`,
    );
  }
}

/**
 * The status a transition lands in.
 *
 * `recordedPrevious` is read back from the audit trail and is consulted only by
 * restoring transitions, and only when it is a value that transition is allowed
 * to produce.
 */
export function resolveWorkspaceTarget(
  transition: WorkspaceTransition,
  recordedPrevious: string | null = null,
): WorkspaceStatus {
  const { target } = WORKSPACE_TRANSITION_RULES[transition];
  if (target.kind === 'fixed') return target.status;

  if (
    recordedPrevious !== null &&
    isWorkspaceStatus(recordedPrevious) &&
    target.permitted.includes(recordedPrevious)
  ) {
    return recordedPrevious;
  }
  return target.fallback;
}

export function restoresPreviousWorkspaceStatus(transition: WorkspaceTransition): boolean {
  return WORKSPACE_TRANSITION_RULES[transition].target.kind === 'restore';
}
