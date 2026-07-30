/**
 * Workspace lifecycle — the pure state machine and the capability matrix.
 *
 * Transcribed from the diagram and table in `04-platform/workspaces.md`
 * §Lifecycle. Deleting an arrow or flipping a capability fails here.
 */
import { describe, expect, it } from 'vitest';

import {
  assertWorkspaceTransitionAllowed,
  canTransitionWorkspace,
  capabilitiesOf,
  DELETION_WINDOW_DAYS,
  isWorkspaceStatus,
  QUOTA_COUNTING_STATUSES,
  resolveWorkspaceTarget,
  restoresPreviousWorkspaceStatus,
  WORKSPACE_CAPABILITIES,
  WORKSPACE_INITIAL_STATUS,
  WORKSPACE_STATUSES,
  WORKSPACE_TRANSITION_RULES,
  WORKSPACE_TRANSITIONS,
  WorkspaceError,
  workspaceTransitionsFrom,
  type WorkspaceStatus,
  type WorkspaceTransition,
} from './lifecycle.js';

describe('workspace statuses', () => {
  // The CHECK constraint in migration 0004 is the other half of this contract.
  it('are exactly the four the database CHECK constraint allows', () => {
    expect([...WORKSPACE_STATUSES]).toEqual([
      'active',
      'suspended',
      'archived',
      'pending_deletion',
    ]);
  });

  it('recognises its own members and nothing else', () => {
    for (const status of WORKSPACE_STATUSES) {
      expect(isWorkspaceStatus(status)).toBe(true);
    }
    expect(isWorkspaceStatus('closed')).toBe(false);
    expect(isWorkspaceStatus('past_due')).toBe(false);
    expect(isWorkspaceStatus('')).toBe(false);
  });

  it('provisions into active with a 30-day deletion window', () => {
    expect(WORKSPACE_INITIAL_STATUS).toBe('active');
    expect(DELETION_WINDOW_DAYS).toBe(30);
  });
});

describe('capabilities — reads always remain available', () => {
  // The headline rule: "a suspended customer must be able to export their data
  // — withholding it is both bad practice and, in several jurisdictions,
  // unlawful."
  it('permits reads in EVERY state, including suspended and archived', () => {
    for (const status of WORKSPACE_STATUSES) {
      expect(capabilitiesOf(status).reads, status).toBe(true);
    }
  });

  it('permits new runs and publishing only while active', () => {
    for (const status of WORKSPACE_STATUSES) {
      const expected = status === 'active';
      expect(capabilitiesOf(status).newRuns, status).toBe(expected);
      expect(capabilitiesOf(status).publishing, status).toBe(expected);
    }
  });

  // An archived workspace is retained but does not consume the plan's
  // allowance — that is what makes archiving a usable alternative to deletion.
  it('counts only active and suspended workspaces against quota', () => {
    expect(WORKSPACE_CAPABILITIES.active.countsTowardQuota).toBe(true);
    expect(WORKSPACE_CAPABILITIES.suspended.countsTowardQuota).toBe(true);
    expect(WORKSPACE_CAPABILITIES.archived.countsTowardQuota).toBe(false);
    expect(WORKSPACE_CAPABILITIES.pending_deletion.countsTowardQuota).toBe(false);
  });

  // Derived, not written twice, so the quota query cannot drift from the table.
  it('derives the quota-counting status list from the capability table', () => {
    expect([...QUOTA_COUNTING_STATUSES]).toEqual(['active', 'suspended']);
  });

  it('describes every status', () => {
    for (const status of WORKSPACE_STATUSES) {
      expect(Object.keys(WORKSPACE_CAPABILITIES)).toContain(status);
    }
  });
});

describe('lifecycle transitions — the canonical diagram', () => {
  const ARROWS: readonly (readonly [WorkspaceStatus, WorkspaceTransition])[] = [
    ['active', 'suspend'],
    ['suspended', 'reactivate'],
    ['active', 'archive'],
    ['suspended', 'archive'],
    ['archived', 'restore'],
    ['active', 'request_deletion'],
    ['archived', 'request_deletion'],
    ['pending_deletion', 'cancel_deletion'],
  ];

  for (const [from, transition] of ARROWS) {
    it(`permits '${transition}' from '${from}'`, () => {
      expect(canTransitionWorkspace(from, transition)).toBe(true);
      expect(() => {
        assertWorkspaceTransitionAllowed(from, transition);
      }).not.toThrow();
    });
  }

  it('lands each fixed transition on its documented status', () => {
    expect(resolveWorkspaceTarget('suspend')).toBe('suspended');
    expect(resolveWorkspaceTarget('archive')).toBe('archived');
    expect(resolveWorkspaceTarget('request_deletion')).toBe('pending_deletion');
  });

  it('reports the transitions available from each status', () => {
    expect(workspaceTransitionsFrom('active')).toEqual(['suspend', 'archive', 'request_deletion']);
    expect(workspaceTransitionsFrom('suspended')).toEqual(['reactivate', 'archive']);
    expect(workspaceTransitionsFrom('archived')).toEqual(['restore', 'request_deletion']);
    expect(workspaceTransitionsFrom('pending_deletion')).toEqual(['cancel_deletion']);
  });
});

describe('lifecycle transitions — what is refused', () => {
  it('refuses arrows the diagram does not draw', () => {
    expect(canTransitionWorkspace('suspended', 'suspend')).toBe(false);
    expect(canTransitionWorkspace('archived', 'reactivate')).toBe(false);
    expect(canTransitionWorkspace('active', 'restore')).toBe(false);
    expect(canTransitionWorkspace('pending_deletion', 'archive')).toBe(false);
    expect(canTransitionWorkspace('pending_deletion', 'suspend')).toBe(false);
    expect(canTransitionWorkspace('suspended', 'request_deletion')).toBe(false);
  });

  it('throws a typed InvalidTransition naming the permitted origins', () => {
    let caught: unknown;
    try {
      assertWorkspaceTransitionAllowed('archived', 'reactivate');
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(WorkspaceError);
    expect((caught as WorkspaceError).code).toBe('InvalidTransition');
    expect((caught as WorkspaceError).message).toContain('suspended');
  });

  it('leaves no status without an exit — none of the four is a trap', () => {
    for (const status of WORKSPACE_STATUSES) {
      expect(workspaceTransitionsFrom(status).length, status).toBeGreaterThan(0);
    }
  });
});

describe('restoring transitions', () => {
  it('identifies which transitions restore rather than fix a status', () => {
    expect(restoresPreviousWorkspaceStatus('reactivate')).toBe(true);
    expect(restoresPreviousWorkspaceStatus('restore')).toBe(true);
    expect(restoresPreviousWorkspaceStatus('cancel_deletion')).toBe(true);
    expect(restoresPreviousWorkspaceStatus('suspend')).toBe(false);
    expect(restoresPreviousWorkspaceStatus('archive')).toBe(false);
    expect(restoresPreviousWorkspaceStatus('request_deletion')).toBe(false);
  });

  // Un-archiving is not a pardon: a workspace suspended before it was archived
  // is still suspended once it comes back.
  it('returns an archived workspace to the suspension it was archived under', () => {
    expect(resolveWorkspaceTarget('restore', 'suspended')).toBe('suspended');
    expect(resolveWorkspaceTarget('restore', 'active')).toBe('active');
    expect(resolveWorkspaceTarget('restore', null)).toBe('active');
  });

  // Cancelling a deletion request must not silently un-archive.
  it('returns a cancelled deletion to the status that preceded the request', () => {
    expect(resolveWorkspaceTarget('cancel_deletion', 'archived')).toBe('archived');
    expect(resolveWorkspaceTarget('cancel_deletion', 'active')).toBe('active');
    expect(resolveWorkspaceTarget('cancel_deletion', null)).toBe('active');
  });

  it('reactivates a suspended workspace to active', () => {
    expect(resolveWorkspaceTarget('reactivate', 'active')).toBe('active');
    expect(resolveWorkspaceTarget('reactivate', null)).toBe('active');
  });

  // A recorded value outside the permitted set is corrupt or was written by an
  // older revision; it is not trusted into a nonsensical state.
  it('refuses to restore a status the transition cannot produce', () => {
    expect(resolveWorkspaceTarget('restore', 'pending_deletion')).toBe('active');
    expect(resolveWorkspaceTarget('restore', 'archived')).toBe('active');
    expect(resolveWorkspaceTarget('cancel_deletion', 'suspended')).toBe('active');
    expect(resolveWorkspaceTarget('cancel_deletion', 'pending_deletion')).toBe('active');
    expect(resolveWorkspaceTarget('reactivate', 'archived')).toBe('active');
    expect(resolveWorkspaceTarget('reactivate', 'not-a-status')).toBe('active');
  });

  it('ignores a recorded status on a transition that does not restore', () => {
    expect(resolveWorkspaceTarget('suspend', 'archived')).toBe('suspended');
    expect(resolveWorkspaceTarget('archive', 'suspended')).toBe('archived');
  });
});

describe('state machine integrity', () => {
  it('names only known statuses in every rule', () => {
    for (const transition of WORKSPACE_TRANSITIONS) {
      const rule = WORKSPACE_TRANSITION_RULES[transition];
      expect(rule.from.length).toBeGreaterThan(0);
      for (const from of rule.from) {
        expect(isWorkspaceStatus(from)).toBe(true);
      }
      if (rule.target.kind === 'fixed') {
        expect(isWorkspaceStatus(rule.target.status)).toBe(true);
      } else {
        expect(rule.target.permitted.length).toBeGreaterThan(0);
        expect(rule.target.permitted).toContain(rule.target.fallback);
      }
    }
  });

  // Purge leaves the state machine entirely — it is the Retention worker's
  // ordered destruction sequence, not a status.
  it('models no purge transition', () => {
    expect([...WORKSPACE_TRANSITIONS]).not.toContain('purge');
    expect(WORKSPACE_STATUSES as readonly string[]).not.toContain('purged');
  });
});
