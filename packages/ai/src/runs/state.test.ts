import { describe, expect, it } from 'vitest';

import {
  assertTransitionAllowed,
  canTransition,
  INITIAL_RUN_STATUS,
  isRunError,
  isRunStatus,
  isTerminalRunStatus,
  RUN_STATUSES,
  RUN_TRANSITION_RULES,
  RUN_TRANSITIONS,
  targetOf,
  transitionsFrom,
  TERMINAL_RUN_STATUSES,
  type RunStatus,
} from './state.js';

describe('the run status vocabulary', () => {
  it('is exactly the seven states the increment names', () => {
    expect([...RUN_STATUSES]).toEqual([
      'created',
      'compiling',
      'ready',
      'running',
      'completed',
      'failed',
      'cancelled',
    ]);
  });

  it('starts at created', () => {
    expect(INITIAL_RUN_STATUS).toBe('created');
  });

  it('recognises its own members and nothing else', () => {
    expect(isRunStatus('running')).toBe(true);
    expect(isRunStatus('RUNNING')).toBe(false);
    expect(isRunStatus('paused')).toBe(false);
    expect(isRunStatus(3)).toBe(false);
  });

  it('treats completed, failed and cancelled as terminal', () => {
    expect([...TERMINAL_RUN_STATUSES]).toEqual(['completed', 'failed', 'cancelled']);
    for (const status of RUN_STATUSES) {
      expect(isTerminalRunStatus(status)).toBe(TERMINAL_RUN_STATUSES.includes(status));
    }
  });
});

describe('the happy path', () => {
  it('walks CREATED → COMPILING → READY → RUNNING → COMPLETED', () => {
    let status: RunStatus = INITIAL_RUN_STATUS;
    status = assertTransitionAllowed(status, 'compile');
    expect(status).toBe('compiling');
    status = assertTransitionAllowed(status, 'ready');
    expect(status).toBe('ready');
    status = assertTransitionAllowed(status, 'start');
    expect(status).toBe('running');
    status = assertTransitionAllowed(status, 'complete');
    expect(status).toBe('completed');
  });

  it('only completes from running', () => {
    for (const status of RUN_STATUSES) {
      expect(canTransition(status, 'complete')).toBe(status === 'running');
    }
  });
});

describe('failure and cancellation', () => {
  it('can fail from every non-terminal state', () => {
    // Each stage has its own way of going wrong; a machine that only failed
    // from RUNNING would need a second mechanism for resolution and
    // compilation.
    for (const status of RUN_STATUSES) {
      expect(canTransition(status, 'fail')).toBe(!isTerminalRunStatus(status));
    }
  });

  it('can cancel from every non-terminal state', () => {
    for (const status of RUN_STATUSES) {
      expect(canTransition(status, 'cancel')).toBe(!isTerminalRunStatus(status));
    }
  });

  it('cannot move out of a terminal state at all', () => {
    for (const status of TERMINAL_RUN_STATUSES) {
      expect(transitionsFrom(status)).toEqual([]);
      for (const transition of RUN_TRANSITIONS) {
        expect(canTransition(status, transition)).toBe(false);
      }
    }
  });
});

describe('refusing an illegal transition', () => {
  it('throws a RunError carrying IllegalTransition', () => {
    try {
      assertTransitionAllowed('created', 'complete');
      throw new Error('expected a refusal');
    } catch (failure) {
      expect(isRunError(failure)).toBe(true);
      if (!isRunError(failure)) return;
      expect(failure.code).toBe('IllegalTransition');
    }
  });

  it('names what WOULD have been legal', () => {
    // A caller asking for an illegal move usually holds a stale view; the
    // useful half of the message is what the run is actually ready for.
    expect(() => assertTransitionAllowed('created', 'start')).toThrow(
      /Available: compile, fail, cancel/,
    );
  });

  it('says so when the state is terminal, rather than listing nothing', () => {
    expect(() => assertTransitionAllowed('completed', 'fail')).toThrow(/'completed' is terminal/);
  });

  it('never advances a run it refused', () => {
    // The one property that matters: a rejected transition leaves the caller
    // holding the state it had.
    expect(targetOf('completed', 'cancel')).toBeNull();
    expect(targetOf('running', 'ready')).toBeNull();
  });
});

describe('the transition table', () => {
  it('never gives one (from, transition) pair two targets', () => {
    const seen = new Set<string>();
    for (const rule of RUN_TRANSITION_RULES) {
      const key = `${rule.from}/${rule.transition}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  it('names only declared statuses and transitions', () => {
    for (const rule of RUN_TRANSITION_RULES) {
      expect(RUN_STATUSES).toContain(rule.from);
      expect(RUN_STATUSES).toContain(rule.to);
      expect(RUN_TRANSITIONS).toContain(rule.transition);
    }
  });

  it('leaves every state reachable from created', () => {
    // An unreachable state is a state nothing can produce, which is a lie in
    // the vocabulary rather than a feature.
    const reached = new Set<RunStatus>([INITIAL_RUN_STATUS]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const rule of RUN_TRANSITION_RULES) {
        if (reached.has(rule.from) && !reached.has(rule.to)) {
          reached.add(rule.to);
          grew = true;
        }
      }
    }
    expect([...reached].sort()).toEqual([...RUN_STATUSES].sort());
  });

  it('is frozen', () => {
    expect(Object.isFrozen(RUN_TRANSITION_RULES)).toBe(true);
  });
});
