/**
 * The stream lifecycle.
 *
 * The load-bearing assertion is the negative one: every move not in the table
 * is refused, and a finished stream has no moves at all. A second ending would
 * record two outcomes for one response.
 */
import { describe, expect, it } from 'vitest';

import {
  assertTransitionAllowed,
  canTransition,
  INITIAL_STREAM_STATUS,
  isStreamError,
  isStreamStatus,
  isStreamTransition,
  isTerminalStreamStatus,
  STREAM_STATUSES,
  STREAM_TRANSITION_ORIGINS,
  STREAM_TRANSITIONS,
  StreamError,
  TERMINAL_STREAM_STATUSES,
  transitionsFrom,
} from './state.js';

/** The five, written out independently of the module. */
const CANONICAL = ['initialized', 'started', 'streaming', 'completed', 'failed'];

describe('the state vocabulary', () => {
  it('is exactly the five the increment draws', () => {
    expect([...STREAM_STATUSES]).toEqual(CANONICAL);
  });

  it('recognises them and nothing else', () => {
    for (const status of CANONICAL) expect(isStreamStatus(status), status).toBe(true);
    for (const other of ['INITIALIZED', 'open', 'closed', '', null, 7]) {
      expect(isStreamStatus(other), String(other)).toBe(false);
    }
  });

  it('starts every stream initialized', () => {
    expect(INITIAL_STREAM_STATUS).toBe('initialized');
  });

  it('names two terminal states', () => {
    expect([...TERMINAL_STREAM_STATUSES].sort()).toEqual(['completed', 'failed']);
    for (const status of ['initialized', 'started', 'streaming'] as const) {
      expect(isTerminalStreamStatus(status), status).toBe(false);
    }
  });

  it('names the four transitions', () => {
    expect([...STREAM_TRANSITIONS]).toEqual(['start', 'accept', 'complete', 'fail']);
    for (const t of STREAM_TRANSITIONS) expect(isStreamTransition(t)).toBe(true);
    expect(isStreamTransition('cancel')).toBe(false);
  });
});

describe('the legal line', () => {
  it('opens with start, from initialized only', () => {
    expect(canTransition('initialized', 'start')).toBe(true);
    for (const from of ['started', 'streaming', 'completed', 'failed'] as const) {
      expect(canTransition(from, 'start'), from).toBe(false);
    }
  });

  // The first chunk moves started → streaming and every later one stays there:
  // one move, two legal origins.
  it('accepts a chunk from started and from streaming', () => {
    expect(canTransition('started', 'accept')).toBe(true);
    expect(canTransition('streaming', 'accept')).toBe(true);
  });

  it('never accepts a chunk before the stream opened', () => {
    expect(canTransition('initialized', 'accept')).toBe(false);
  });

  it('completes only from streaming', () => {
    expect(canTransition('streaming', 'complete')).toBe(true);
    for (const from of ['initialized', 'started', 'completed', 'failed'] as const) {
      expect(canTransition(from, 'complete'), from).toBe(false);
    }
  });

  // A provider may refuse the request before a single token arrives.
  it('fails from anywhere that has not finished', () => {
    for (const from of ['initialized', 'started', 'streaming'] as const) {
      expect(canTransition(from, 'fail'), from).toBe(true);
      expect(transitionsFrom(from), from).toContain('fail');
    }
  });

  it('names the origins of every transition in one place', () => {
    expect(STREAM_TRANSITION_ORIGINS.start).toEqual(['initialized']);
    expect(STREAM_TRANSITION_ORIGINS.accept).toEqual(['started', 'streaming']);
    expect(STREAM_TRANSITION_ORIGINS.complete).toEqual(['streaming']);
    expect(STREAM_TRANSITION_ORIGINS.fail).toEqual(['initialized', 'started', 'streaming']);
  });
});

describe('every illegal move is refused', () => {
  // The exhaustive negative: all twenty status × transition pairs, minus the
  // ones the table allows.
  for (const from of STREAM_STATUSES) {
    for (const transition of STREAM_TRANSITIONS) {
      if (STREAM_TRANSITION_ORIGINS[transition].includes(from)) continue;
      it(`refuses ${transition} from ${from}`, () => {
        expect(canTransition(from, transition)).toBe(false);
        expect(() => {
          assertTransitionAllowed(from, transition);
        }).toThrow(StreamError);
      });
    }
  }

  it('reports the code as IllegalTransition', () => {
    try {
      assertTransitionAllowed('initialized', 'complete');
      expect.unreachable('must refuse');
    } catch (error) {
      expect(isStreamError(error)).toBe(true);
      expect((error as StreamError).code).toBe('IllegalTransition');
    }
  });

  // A caller asking for an illegal move usually holds a stale view.
  it('names what would have been legal instead', () => {
    try {
      assertTransitionAllowed('initialized', 'accept');
      expect.unreachable('must refuse');
    } catch (error) {
      const message = (error as StreamError).message;
      expect(message).toContain("from 'initialized'");
      expect(message).toContain("'started' or 'streaming'");
      expect(message).toContain('start, fail');
    }
  });
});

describe('a finished stream is protected', () => {
  // A second ending would record two outcomes for one response.
  it('has no outgoing transitions at all', () => {
    for (const from of TERMINAL_STREAM_STATUSES) {
      for (const transition of STREAM_TRANSITIONS) {
        expect(canTransition(from, transition), `${from}:${transition}`).toBe(false);
      }
      expect(transitionsFrom(from), from).toEqual([]);
    }
  });

  it('says plainly why', () => {
    for (const from of TERMINAL_STREAM_STATUSES) {
      expect(() => {
        assertTransitionAllowed(from, 'accept');
      }, from).toThrow(/no outgoing transitions/);
    }
  });

  it('refuses a late chunk on a completed stream', () => {
    expect(() => {
      assertTransitionAllowed('completed', 'accept');
    }).toThrow(StreamError);
  });

  it('refuses to fail a stream that already completed', () => {
    expect(canTransition('completed', 'fail')).toBe(false);
  });
});
