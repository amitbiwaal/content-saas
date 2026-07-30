/**
 * The stream lifecycle.
 *
 *   initialized → started → streaming → (completed | failed)
 *
 * and `failed` from anywhere that has not finished.
 *
 * ── Why `started` and `streaming` are separate ──────────────────────────────
 * They could be one. They are not, because the gap between them is a real and
 * diagnosable condition: the provider accepted the request and opened a stream,
 * and no token has arrived. A stream stuck in `started` is a provider that took
 * the work and went quiet; a stream stuck in `streaming` is one that is
 * producing slowly. Collapsing them makes those two indistinguishable at
 * exactly the moment someone is trying to tell them apart.
 *
 * ── Completion is driven by the final chunk ─────────────────────────────────
 * A stream ends when a chunk arrives carrying a finish reason. There is no
 * separate "now complete" instruction, because a stream that could be completed
 * out of band could be completed before its last token, and the response
 * assembled from it would be short in a way nothing reports.
 */

export const STREAM_STATUSES = [
  'initialized',
  'started',
  'streaming',
  'completed',
  'failed',
] as const;

export type StreamStatus = (typeof STREAM_STATUSES)[number];

export function isStreamStatus(value: unknown): value is StreamStatus {
  return typeof value === 'string' && (STREAM_STATUSES as readonly string[]).includes(value);
}

/** Nothing leaves these. A stream ends once. */
export const TERMINAL_STREAM_STATUSES: readonly StreamStatus[] = ['completed', 'failed'];

export function isTerminalStreamStatus(status: StreamStatus): boolean {
  return TERMINAL_STREAM_STATUSES.includes(status);
}

export const INITIAL_STREAM_STATUS: StreamStatus = 'initialized';

export const STREAM_TRANSITIONS = ['start', 'accept', 'complete', 'fail'] as const;

export type StreamTransition = (typeof STREAM_TRANSITIONS)[number];

export function isStreamTransition(value: unknown): value is StreamTransition {
  return typeof value === 'string' && (STREAM_TRANSITIONS as readonly string[]).includes(value);
}

/**
 * Which states each move is legal from.
 *
 * `accept` has two origins because the first chunk moves `started → streaming`
 * and every later one stays there — one move, two legal starting points, and
 * the target depends on the chunk rather than the transition.
 */
export const STREAM_TRANSITION_ORIGINS: Readonly<
  Record<StreamTransition, readonly StreamStatus[]>
> = Object.freeze({
  start: ['initialized'],
  accept: ['started', 'streaming'],
  complete: ['streaming'],
  // A stream can fail before it starts: the provider may refuse the request.
  fail: ['initialized', 'started', 'streaming'],
});

export const STREAM_ERROR_CODES = [
  'IllegalTransition',
  'DuplicateChunk',
  'OutOfOrderChunk',
  'MissingSequence',
  'InvalidChunk',
  'StreamNotComplete',
  'UnknownCursor',
  'InvalidStream',
] as const;

export type StreamErrorCode = (typeof STREAM_ERROR_CODES)[number];

export class StreamError extends Error {
  readonly code: StreamErrorCode;

  constructor(code: StreamErrorCode, message: string) {
    super(message);
    this.name = 'StreamError';
    this.code = code;
  }
}

export function isStreamError(value: unknown): value is StreamError {
  return value instanceof StreamError;
}

export function canTransition(from: StreamStatus, transition: StreamTransition): boolean {
  return STREAM_TRANSITION_ORIGINS[transition].includes(from);
}

/** Every move legal from a state, in declaration order. */
export function transitionsFrom(status: StreamStatus): readonly StreamTransition[] {
  return STREAM_TRANSITIONS.filter((transition) => canTransition(status, transition));
}

/**
 * Refuse an illegal move, naming what WOULD have been legal.
 *
 * A caller asking for one usually holds a stale view of the stream, so the
 * useful half of the message is what the stream is actually ready for.
 */
export function assertTransitionAllowed(from: StreamStatus, transition: StreamTransition): void {
  if (canTransition(from, transition)) return;

  if (isTerminalStreamStatus(from)) {
    throw new StreamError(
      'IllegalTransition',
      `Cannot ${transition} a stream that is already '${from}': a finished stream has no outgoing transitions, and a second ending would record two outcomes for one response.`,
    );
  }

  throw new StreamError(
    'IllegalTransition',
    `Cannot ${transition} from '${from}'; '${transition}' is only legal from ${STREAM_TRANSITION_ORIGINS[
      transition
    ]
      .map((s) => `'${s}'`)
      .join(' or ')}. From '${from}' the legal moves are: ${transitionsFrom(from).join(', ')}.`,
  );
}
