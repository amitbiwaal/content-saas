/**
 * The job lifecycle state machine.
 *
 * The load-bearing assertion is the negative one: every move NOT in the
 * transition table is refused. A state machine tested only on its happy path is
 * a set of suggestions.
 */
import { describe, expect, it } from 'vitest';

import {
  assertReasonPresent,
  assertTransitionAllowed,
  canTransition,
  INITIAL_JOB_STATUS,
  isJobStatus,
  isJobTransition,
  isTerminalJobStatus,
  JOB_STATUSES,
  JOB_TRANSITION_RULES,
  JOB_TRANSITIONS,
  JobError,
  targetOf,
  TERMINAL_JOB_STATUSES,
  transitionsFrom,
  type JobStatus,
  type JobTransition,
} from './job.js';

/** The five, written out independently of the module. */
const CANONICAL_STATUSES = ['queued', 'running', 'completed', 'failed', 'cancelled'];

describe('the state vocabulary', () => {
  it('is exactly the five documented states', () => {
    expect([...JOB_STATUSES].sort()).toEqual([...CANONICAL_STATUSES].sort());
  });

  it('recognises them and nothing else', () => {
    for (const status of CANONICAL_STATUSES) expect(isJobStatus(status), status).toBe(true);
    for (const status of ['QUEUED', 'pending', 'done', '']) {
      expect(isJobStatus(status), status).toBe(false);
    }
  });

  it('starts every job queued', () => {
    expect(INITIAL_JOB_STATUS).toBe('queued');
  });

  it('names three terminal states and two live ones', () => {
    expect([...TERMINAL_JOB_STATUSES].sort()).toEqual(['cancelled', 'completed', 'failed']);
    expect(isTerminalJobStatus('queued')).toBe(false);
    expect(isTerminalJobStatus('running')).toBe(false);
    for (const status of TERMINAL_JOB_STATUSES) {
      expect(isTerminalJobStatus(status), status).toBe(true);
    }
  });

  it('names the four transitions', () => {
    expect([...JOB_TRANSITIONS].sort()).toEqual(['cancel', 'complete', 'fail', 'start']);
    for (const transition of JOB_TRANSITIONS) expect(isJobTransition(transition)).toBe(true);
    expect(isJobTransition('restart')).toBe(false);
  });
});

describe('the legal moves', () => {
  const LEGAL: [JobStatus, JobTransition, JobStatus][] = [
    ['queued', 'start', 'running'],
    ['running', 'complete', 'completed'],
    ['running', 'fail', 'failed'],
    ['running', 'cancel', 'cancelled'],
  ];

  for (const [from, transition, to] of LEGAL) {
    it(`${from} --${transition}--> ${to}`, () => {
      expect(canTransition(from, transition)).toBe(true);
      expect(targetOf(transition)).toBe(to);
      expect(() => {
        assertTransitionAllowed(from, transition);
      }).not.toThrow();
    });
  }

  it('offers exactly one move out of queued', () => {
    expect(transitionsFrom('queued')).toEqual(['start']);
  });

  it('offers three out of running', () => {
    expect([...transitionsFrom('running')].sort()).toEqual(['cancel', 'complete', 'fail']);
  });

  // Every move has exactly one legal origin, which is what makes an illegal
  // transition a lookup rather than a judgement.
  it('gives every transition a single origin', () => {
    for (const transition of JOB_TRANSITIONS) {
      const origins = JOB_STATUSES.filter((status) => canTransition(status, transition));
      expect(origins, transition).toHaveLength(1);
      expect(origins[0], transition).toBe(JOB_TRANSITION_RULES[transition].from);
    }
  });
});

describe('every illegal move is refused', () => {
  // The exhaustive negative: all twenty status × transition pairs, minus the
  // four legal ones. A machine tested only forwards is a set of suggestions.
  const LEGAL = new Set(['queued:start', 'running:complete', 'running:fail', 'running:cancel']);

  for (const from of JOB_STATUSES) {
    for (const transition of JOB_TRANSITIONS) {
      if (LEGAL.has(`${from}:${transition}`)) continue;
      it(`refuses ${transition} from ${from}`, () => {
        expect(canTransition(from, transition)).toBe(false);
        expect(() => {
          assertTransitionAllowed(from, transition);
        }).toThrow(JobError);
      });
    }
  }

  it('reports the code as IllegalTransition', () => {
    try {
      assertTransitionAllowed('completed', 'start');
      expect.unreachable('must refuse');
    } catch (error) {
      expect((error as JobError).code).toBe('IllegalTransition');
    }
  });

  // A caller asking for an illegal move usually holds a stale view of the job.
  it('names what would have been legal instead', () => {
    try {
      assertTransitionAllowed('queued', 'complete');
      expect.unreachable('must refuse');
    } catch (error) {
      const message = (error as JobError).message;
      expect(message).toContain('queued');
      expect(message).toContain("only legal from 'running'");
      expect(message).toContain('start');
    }
  });

  it('says plainly that a terminal state has no way out', () => {
    for (const status of TERMINAL_JOB_STATUSES) {
      try {
        assertTransitionAllowed(status, 'complete');
        expect.unreachable('must refuse');
      } catch (error) {
        expect((error as JobError).message, status).toContain('no outgoing transitions');
      }
    }
  });

  // There is no edge between the terminal states: a completion arriving after
  // a cancellation is two deciders disagreeing, not a state change.
  it('refuses every move between terminal states', () => {
    for (const from of TERMINAL_JOB_STATUSES) {
      for (const transition of JOB_TRANSITIONS) {
        expect(canTransition(from, transition), `${from}:${transition}`).toBe(false);
      }
      expect(transitionsFrom(from), from).toEqual([]);
    }
  });

  // Flagged deliberately: the increment's diagram is linear, so cancelling
  // before work starts is not a move this machine has.
  it('refuses to cancel a queued job, as the declared machine has no such edge', () => {
    expect(canTransition('queued', 'cancel')).toBe(false);
    expect(() => {
      assertTransitionAllowed('queued', 'cancel');
    }).toThrow(/only legal from 'running'/);
  });
});

describe('the moves that must explain themselves', () => {
  it('requires a reason to fail or cancel', () => {
    for (const transition of ['fail', 'cancel'] as const) {
      expect(JOB_TRANSITION_RULES[transition].requiresReason, transition).toBe(true);
      expect(() => {
        assertReasonPresent(transition, null);
      }, transition).toThrow(JobError);
      expect(() => {
        assertReasonPresent(transition, '   ');
      }, transition).toThrow(/without a reason/);
    }
  });

  it('accepts a stated reason', () => {
    expect(() => {
      assertReasonPresent('fail', 'provider timeout');
    }).not.toThrow();
  });

  // A reason on a successful job would be a result in disguise.
  it('requires none to start or complete', () => {
    for (const transition of ['start', 'complete'] as const) {
      expect(JOB_TRANSITION_RULES[transition].requiresReason, transition).toBe(false);
      expect(() => {
        assertReasonPresent(transition, null);
      }, transition).not.toThrow();
    }
  });

  it('reports the code as ReasonRequired', () => {
    try {
      assertReasonPresent('cancel', null);
      expect.unreachable('must refuse');
    } catch (error) {
      expect((error as JobError).code).toBe('ReasonRequired');
    }
  });
});
