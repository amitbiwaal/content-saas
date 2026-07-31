import { describe, expect, it } from 'vitest';

import {
  assertTransitionAllowed,
  canTransition,
  DRAFT_STATUSES,
  DRAFT_TRANSITION_RULES,
  DRAFT_TRANSITIONS,
  INITIAL_DRAFT_STATUS,
  isDraftError,
  isDraftStatus,
  isTerminalDraftStatus,
  targetOf,
  TERMINAL_DRAFT_STATUSES,
  transitionsFrom,
  type DraftStatus,
} from './status.js';

describe('the draft status vocabulary', () => {
  it('is exactly the four states the lifecycle has', () => {
    expect([...DRAFT_STATUSES]).toEqual(['draft', 'ready', 'submitted', 'discarded']);
  });

  it('starts as a draft', () => {
    expect(INITIAL_DRAFT_STATUS).toBe('draft');
  });

  it('recognises its own members and nothing else', () => {
    expect(isDraftStatus('ready')).toBe(true);
    expect(isDraftStatus('READY')).toBe(false);
    expect(isDraftStatus('archived')).toBe(false);
    expect(isDraftStatus(2)).toBe(false);
  });

  it('treats submitted and discarded as terminal', () => {
    expect([...TERMINAL_DRAFT_STATUSES]).toEqual(['submitted', 'discarded']);
    for (const status of DRAFT_STATUSES) {
      expect(isTerminalDraftStatus(status)).toBe(TERMINAL_DRAFT_STATUSES.includes(status));
    }
  });
});

describe('the happy path', () => {
  it('walks DRAFT → READY → SUBMITTED', () => {
    let status: DraftStatus = INITIAL_DRAFT_STATUS;
    status = assertTransitionAllowed(status, 'ready');
    expect(status).toBe('ready');
    status = assertTransitionAllowed(status, 'submit');
    expect(status).toBe('submitted');
  });

  it('only submits from ready', () => {
    for (const status of DRAFT_STATUSES) {
      expect(canTransition(status, 'submit')).toBe(status === 'ready');
    }
  });
});

describe('editing', () => {
  it('returns a ready draft to draft', () => {
    // An edit invalidates the validation that made it ready; leaving it READY
    // would let it carry a claim about content it no longer holds.
    expect(targetOf('ready', 'edit')).toBe('draft');
  });

  it('keeps a draft a draft', () => {
    expect(targetOf('draft', 'edit')).toBe('draft');
  });

  it('can re-validate a draft that is already ready', () => {
    expect(targetOf('ready', 'ready')).toBe('ready');
  });
});

describe('terminal states', () => {
  it('cannot be left at all', () => {
    for (const status of TERMINAL_DRAFT_STATUSES) {
      expect(transitionsFrom(status)).toEqual([]);
      for (const transition of DRAFT_TRANSITIONS) {
        expect(canTransition(status, transition)).toBe(false);
      }
    }
  });

  it('refuse an edit to a submitted draft', () => {
    // It is the record of what was submitted; editing it would rewrite the
    // provenance of a run that already happened.
    expect(() => assertTransitionAllowed('submitted', 'edit')).toThrow(/'submitted' is terminal/);
  });

  it('cannot discard something already discarded', () => {
    expect(canTransition('discarded', 'discard')).toBe(false);
  });
});

describe('refusing an illegal transition', () => {
  it('throws a DraftError carrying IllegalTransition', () => {
    try {
      assertTransitionAllowed('draft', 'submit');
      throw new Error('expected a refusal');
    } catch (failure) {
      expect(isDraftError(failure)).toBe(true);
      if (!isDraftError(failure)) return;
      expect(failure.code).toBe('IllegalTransition');
    }
  });

  it('names what WOULD have been legal', () => {
    expect(() => assertTransitionAllowed('draft', 'submit')).toThrow(
      /Available: edit, ready, discard/,
    );
  });

  it('never advances a draft it refused', () => {
    expect(targetOf('draft', 'submit')).toBeNull();
    expect(targetOf('submitted', 'discard')).toBeNull();
  });
});

describe('the transition table', () => {
  it('never gives one (from, transition) pair two targets', () => {
    const seen = new Set<string>();
    for (const rule of DRAFT_TRANSITION_RULES) {
      const key = `${rule.from}/${rule.transition}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  it('names only declared statuses and transitions', () => {
    for (const rule of DRAFT_TRANSITION_RULES) {
      expect(DRAFT_STATUSES).toContain(rule.from);
      expect(DRAFT_STATUSES).toContain(rule.to);
      expect(DRAFT_TRANSITIONS).toContain(rule.transition);
    }
  });

  it('leaves every state reachable from the initial one', () => {
    const reached = new Set<DraftStatus>([INITIAL_DRAFT_STATUS]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const rule of DRAFT_TRANSITION_RULES) {
        if (reached.has(rule.from) && !reached.has(rule.to)) {
          reached.add(rule.to);
          grew = true;
        }
      }
    }
    expect([...reached].sort()).toEqual([...DRAFT_STATUSES].sort());
  });

  it('is frozen', () => {
    expect(Object.isFrozen(DRAFT_TRANSITION_RULES)).toBe(true);
  });
});
