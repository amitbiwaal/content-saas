/**
 * The workflow state machine.
 *
 * The load-bearing assertion is the negative one: every move NOT in the table
 * is refused. The three rejections the increment names — execution before
 * preparation, execution after completion, duplicate completion — are all
 * consequences of that, and each is asserted directly as well, because a
 * property that holds by accident is one that stops holding by accident.
 */
import { describe, expect, it } from 'vitest';

import {
  assertTransitionAllowed,
  canTransition,
  INITIAL_WORKFLOW_STATUS,
  isTerminalWorkflowStatus,
  isWorkflowError,
  isWorkflowStatus,
  isWorkflowTransition,
  TERMINAL_WORKFLOW_STATUSES,
  transitionsFrom,
  WORKFLOW_STATUSES,
  WORKFLOW_TRANSITION_RULES,
  WORKFLOW_TRANSITIONS,
  WorkflowError,
  type WorkflowStatus,
  type WorkflowTransition,
} from './state.js';

/** The eight, written out independently of the module. */
const CANONICAL_STATUSES = [
  'pending',
  'started',
  'step_loaded',
  'prompt_prepared',
  'execution_prepared',
  'awaiting_execution',
  'completed',
  'failed',
];

describe('the state vocabulary', () => {
  it('is exactly the documented states', () => {
    expect([...WORKFLOW_STATUSES]).toEqual(CANONICAL_STATUSES);
  });

  it('recognises them and nothing else', () => {
    for (const status of CANONICAL_STATUSES) expect(isWorkflowStatus(status), status).toBe(true);
    for (const other of ['running', 'PENDING', '', null, 7]) {
      expect(isWorkflowStatus(other), String(other)).toBe(false);
    }
  });

  it('starts every workflow pending', () => {
    expect(INITIAL_WORKFLOW_STATUS).toBe('pending');
  });

  it('names two terminal states', () => {
    expect([...TERMINAL_WORKFLOW_STATUSES].sort()).toEqual(['completed', 'failed']);
    for (const status of TERMINAL_WORKFLOW_STATUSES) {
      expect(isTerminalWorkflowStatus(status), status).toBe(true);
    }
    for (const status of ['pending', 'started', 'awaiting_execution'] as const) {
      expect(isTerminalWorkflowStatus(status), status).toBe(false);
    }
  });

  it('names the seven transitions', () => {
    expect([...WORKFLOW_TRANSITIONS]).toEqual([
      'start',
      'loadStep',
      'preparePrompt',
      'buildRequest',
      'awaitExecution',
      'recordExecution',
      'fail',
    ]);
    for (const t of WORKFLOW_TRANSITIONS) expect(isWorkflowTransition(t)).toBe(true);
    expect(isWorkflowTransition('retry')).toBe(false);
  });
});

describe('the one legal line', () => {
  const LINE: [WorkflowStatus, WorkflowTransition, WorkflowStatus | null][] = [
    ['pending', 'start', 'started'],
    ['started', 'loadStep', 'step_loaded'],
    ['step_loaded', 'preparePrompt', 'prompt_prepared'],
    ['prompt_prepared', 'buildRequest', 'execution_prepared'],
    ['execution_prepared', 'awaitExecution', 'awaiting_execution'],
    ['awaiting_execution', 'recordExecution', null],
  ];

  for (const [from, transition, to] of LINE) {
    it(`${from} --${transition}--> ${to ?? '(depends on the cursor)'}`, () => {
      expect(canTransition(from, transition)).toBe(true);
      expect(WORKFLOW_TRANSITION_RULES[transition].to).toBe(to);
      expect(() => {
        assertTransitionAllowed(from, transition);
      }).not.toThrow();
    });
  }

  // No branching: each state offers its one move onward, plus the ending.
  it('offers exactly one way forward from every live state', () => {
    for (const [from] of LINE) {
      const forward = transitionsFrom(from).filter((t) => t !== 'fail');
      expect(forward, from).toHaveLength(1);
    }
  });

  it('gives every transition but fail a single legal origin', () => {
    for (const transition of WORKFLOW_TRANSITIONS) {
      if (transition === 'fail') continue;
      const origins = WORKFLOW_STATUSES.filter((status) => canTransition(status, transition));
      expect(origins, transition).toHaveLength(1);
      expect(origins[0], transition).toBe(WORKFLOW_TRANSITION_RULES[transition].from);
    }
  });

  // Only `recordExecution` has a target the table cannot name, and it depends
  // on the cursor alone.
  it('names a fixed target for every transition but recordExecution', () => {
    for (const transition of WORKFLOW_TRANSITIONS) {
      const { to } = WORKFLOW_TRANSITION_RULES[transition];
      if (transition === 'recordExecution') expect(to).toBeNull();
      else expect(to, transition).not.toBeNull();
    }
  });
});

describe('every illegal move is refused', () => {
  // The exhaustive negative: all fifty-six status × transition pairs, minus the
  // ones the line and the ending allow.
  const LEGAL = new Set([
    'pending:start',
    'started:loadStep',
    'step_loaded:preparePrompt',
    'prompt_prepared:buildRequest',
    'execution_prepared:awaitExecution',
    'awaiting_execution:recordExecution',
  ]);

  for (const from of WORKFLOW_STATUSES) {
    for (const transition of WORKFLOW_TRANSITIONS) {
      const legal =
        LEGAL.has(`${from}:${transition}`) ||
        (transition === 'fail' && !isTerminalWorkflowStatus(from));
      if (legal) continue;

      it(`refuses ${transition} from ${from}`, () => {
        expect(canTransition(from, transition)).toBe(false);
        expect(() => {
          assertTransitionAllowed(from, transition);
        }).toThrow(WorkflowError);
      });
    }
  }

  it('reports the code as IllegalTransition', () => {
    try {
      assertTransitionAllowed('pending', 'recordExecution');
      expect.unreachable('must refuse');
    } catch (error) {
      expect(isWorkflowError(error)).toBe(true);
      expect((error as WorkflowError).code).toBe('IllegalTransition');
    }
  });

  // A caller asking for an illegal move usually holds a stale view, so the
  // useful half of the message is what the workflow is actually ready for.
  it('names what would have been legal instead', () => {
    try {
      assertTransitionAllowed('started', 'buildRequest');
      expect.unreachable('must refuse');
    } catch (error) {
      const message = (error as WorkflowError).message;
      expect(message).toContain("from 'started'");
      expect(message).toContain("only legal from 'prompt_prepared'");
      expect(message).toContain('loadStep');
    }
  });
});

describe('the three rejections the increment names', () => {
  // Recording a result is legal only from awaiting_execution, which is
  // reachable only through execution_prepared.
  it('refuses execution before preparation', () => {
    for (const before of [
      'pending',
      'started',
      'step_loaded',
      'prompt_prepared',
      'execution_prepared',
    ] as const) {
      expect(canTransition(before, 'recordExecution'), before).toBe(false);
    }
  });

  it('refuses execution after completion', () => {
    expect(canTransition('completed', 'recordExecution')).toBe(false);
    expect(() => {
      assertTransitionAllowed('completed', 'recordExecution');
    }).toThrow(/no outgoing transitions/);
  });

  // A second ending would record two outcomes for one run.
  it('refuses a duplicate completion', () => {
    for (const from of TERMINAL_WORKFLOW_STATUSES) {
      for (const transition of WORKFLOW_TRANSITIONS) {
        expect(canTransition(from, transition), `${from}:${transition}`).toBe(false);
      }
      expect(transitionsFrom(from), from).toEqual([]);
    }
  });

  it('refuses to fail a workflow that already ended', () => {
    expect(canTransition('failed', 'fail')).toBe(false);
    expect(canTransition('completed', 'fail')).toBe(false);
  });
});

describe('failing is legal until the end, and only until then', () => {
  it('is offered from every live state', () => {
    for (const status of WORKFLOW_STATUSES) {
      if (isTerminalWorkflowStatus(status)) continue;
      expect(canTransition(status, 'fail'), status).toBe(true);
      expect(transitionsFrom(status), status).toContain('fail');
    }
  });

  it('is the only move that has more than one origin', () => {
    const multi = WORKFLOW_TRANSITIONS.filter(
      (t) => WORKFLOW_STATUSES.filter((s) => canTransition(s, t)).length > 1,
    );
    expect(multi).toEqual(['fail']);
  });
});
