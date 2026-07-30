/**
 * The streaming engine.
 *
 * ── Deterministic by construction ───────────────────────────────────────────
 * Every transition is a pure function from one stream to the next. Nothing
 * mutates, nothing reads a clock or a random source, and every returned value
 * is frozen. The same chunks therefore assemble into the same response, on
 * every machine, every time — which is the guarantee the increment asks for and
 * the one a streaming layer most easily loses, because arrival order and
 * timing are exactly what a network varies.
 *
 * Order is not recovered by sorting. Out-of-order and repeated chunks are
 * REFUSED, so the sequence a stream accepted is the sequence it was sent. A
 * layer that quietly reordered would hide a provider fault and make two runs of
 * one request produce two texts.
 *
 * ── Partial content is never returned as a complete response ────────────────
 * `provider-adapters.md` §Streaming is explicit: a mid-stream failure yields a
 * typed error, "because a truncated article section that looks complete is
 * worse than a visible failure". A failed stream therefore assembles NOTHING —
 * `resultOf` returns the failure and reports how many chunks were discarded, so
 * the loss is visible rather than silent.
 *
 * ── It reuses the canonical response ────────────────────────────────────────
 * There is no streaming-specific response type. A completed stream assembles
 * the same `AIResponse` a non-streamed call returns, which is what lets the
 * workflow runtime record it and the meter price it without knowing a stream
 * was involved.
 */

import type {
  AIRequest,
  AIResponse,
  FinishReason,
  ProviderErrorCode,
  Usage,
} from '@contentos/contracts';

import { freezeChunk, isFinalChunk, validateChunk, type StreamChunk } from './chunk.js';
import {
  assertTransitionAllowed,
  INITIAL_STREAM_STATUS,
  StreamError,
  type StreamStatus,
} from './state.js';

/**
 * Where a consumer has got to.
 *
 * The whole of the resume protocol: which stream, how far, and whether there is
 * any more to come. No transport, no encoding beyond a token a client can hand
 * back opaquely.
 */
export interface StreamCursor {
  readonly streamId: string;
  /** The highest sequence delivered, or null before anything was. */
  readonly lastSequence: number | null;
  readonly completed: boolean;
  /**
   * An opaque token carrying the two above.
   *
   * Derived, never generated: a random token would make two identical streams
   * resumable by different strings, and a client that cached one could not tell
   * whether it still referred to the same position.
   */
  readonly resumeToken: string;
}

export interface StreamState {
  readonly status: StreamStatus;
  readonly chunks: readonly StreamChunk[];
  /** The finish reason from the final chunk, once one has arrived. */
  readonly finishReason: FinishReason | null;
  /** The totals from the final chunk. Also set on a failure that reported them. */
  readonly usage: Usage | null;
  readonly failureCode: ProviderErrorCode | null;
  readonly failureReason: string | null;
}

export interface AIStream {
  readonly streamId: string;
  /** The canonical request being streamed. Unchanged and unwrapped. */
  readonly request: AIRequest;
  readonly providerId: string;
  /** The model that actually ran, which is not necessarily the one asked for. */
  readonly model: string;
  readonly state: StreamState;
}

export const STREAM_EVENT_KINDS = ['started', 'chunk', 'completed', 'failed'] as const;

export type StreamEventKind = (typeof STREAM_EVENT_KINDS)[number];

/**
 * The protocol, not the transport.
 *
 * What a transport would serialize, in the order it happened. Every event
 * carries the cursor as of that moment, so a client that drops the connection
 * resumes from the last event it actually saw rather than from a position the
 * server assumed it reached.
 */
export type StreamEvent =
  | { readonly kind: 'started'; readonly streamId: string; readonly cursor: StreamCursor }
  | {
      readonly kind: 'chunk';
      readonly streamId: string;
      readonly chunk: StreamChunk;
      readonly cursor: StreamCursor;
    }
  | {
      readonly kind: 'completed';
      readonly streamId: string;
      readonly finishReason: FinishReason;
      readonly cursor: StreamCursor;
    }
  | {
      readonly kind: 'failed';
      readonly streamId: string;
      readonly code: ProviderErrorCode;
      readonly reason: string;
      readonly cursor: StreamCursor;
    };

export type StreamResult =
  | { readonly status: 'completed'; readonly response: AIResponse; readonly cursor: StreamCursor }
  | {
      readonly status: 'failed';
      readonly code: ProviderErrorCode;
      readonly reason: string;
      /** Reported honestly where the provider gave partial totals. */
      readonly usage: Usage | null;
      /**
       * How much content was thrown away.
       *
       * Counted and surfaced so that discarding partial output is a visible
       * decision rather than a silent one.
       */
      readonly discardedChunks: number;
      readonly cursor: StreamCursor;
    };

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.getOwnPropertyNames(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

const next = (stream: AIStream, state: Partial<StreamState>): AIStream =>
  deepFreeze({ ...stream, state: { ...stream.state, ...state } });

/** `stream:<id>@<sequence|start>` — derived, so identical positions agree. */
export function resumeTokenFor(streamId: string, lastSequence: number | null): string {
  return `stream:${streamId}@${lastSequence === null ? 'start' : String(lastSequence)}`;
}

/** Read a token back. Returns null for anything this did not produce. */
export function parseResumeToken(
  token: string,
): { streamId: string; lastSequence: number | null } | null {
  const match = /^stream:(.+)@(start|\d+)$/.exec(token);
  const streamId = match?.[1];
  const position = match?.[2];
  if (streamId === undefined || position === undefined) return null;
  return { streamId, lastSequence: position === 'start' ? null : Number(position) };
}

export function cursorOf(stream: AIStream): StreamCursor {
  const last = stream.state.chunks[stream.state.chunks.length - 1];
  const lastSequence = last?.sequence ?? null;
  return Object.freeze({
    streamId: stream.streamId,
    lastSequence,
    completed: stream.state.status === 'completed',
    resumeToken: resumeTokenFor(stream.streamId, lastSequence),
  });
}

export interface OpenStreamOptions {
  readonly streamId: string;
  readonly request: AIRequest;
  readonly providerId: string;
  readonly model: string;
}

/** A stream that has been declared and not yet opened against the provider. */
export function openStream(options: OpenStreamOptions): AIStream {
  for (const [field, value] of [
    ['streamId', options.streamId],
    ['providerId', options.providerId],
    ['model', options.model],
  ] as const) {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new StreamError('InvalidStream', `A stream needs a ${field}.`);
    }
  }

  return deepFreeze({
    streamId: options.streamId,
    request: options.request,
    providerId: options.providerId,
    model: options.model,
    state: {
      status: INITIAL_STREAM_STATUS,
      chunks: [],
      finishReason: null,
      usage: null,
      failureCode: null,
      failureReason: null,
    },
  });
}

/** The provider accepted the request and opened a stream. No tokens yet. */
export function startStream(stream: AIStream): AIStream {
  assertTransitionAllowed(stream.state.status, 'start');
  return next(stream, { status: 'started' });
}

/**
 * Accept one chunk.
 *
 * Refuses a repeat, a gap and anything out of order — the three ways a stream
 * silently becomes a different text.
 */
export function acceptChunk(stream: AIStream, chunk: StreamChunk): AIStream {
  assertTransitionAllowed(stream.state.status, 'accept');

  const validation = validateChunk(chunk);
  if (!validation.ok) {
    // The details, not just the codes: the validator already explains WHY each
    // rule exists, and a caller reading `usage MISSING_USAGE` has to go and
    // find that explanation instead of being handed it.
    throw new StreamError(
      'InvalidChunk',
      `Chunk rejected on stream '${stream.streamId}': ${validation.issues
        .map((i) => `${i.field} — ${i.detail}`)
        .join(' ')}`,
    );
  }

  const expected = stream.state.chunks.length;
  if (chunk.sequence < expected) {
    // Already have this one. Accepting it again would duplicate its text.
    throw new StreamError(
      'DuplicateChunk',
      `Chunk ${String(chunk.sequence)} was already accepted on stream '${stream.streamId}'; re-accepting it would repeat its content in the assembled response.`,
    );
  }
  if (chunk.sequence > expected) {
    // A gap. Filling it later would put the text in the wrong order, and
    // assembling around it would silently drop what never arrived.
    throw new StreamError(
      chunk.sequence === expected + 1 ? 'MissingSequence' : 'OutOfOrderChunk',
      `Chunk ${String(chunk.sequence)} arrived while ${String(expected)} was expected on stream '${stream.streamId}'. Chunks are never reordered or back-filled: the sequence accepted is the sequence sent.`,
    );
  }

  const chunks = [...stream.state.chunks, freezeChunk({ ...chunk })];

  // The final chunk ends the stream. There is no separate completion, so a
  // response cannot be assembled before its last token arrived.
  return isFinalChunk(chunk)
    ? next(stream, {
        status: 'completed',
        chunks,
        finishReason: chunk.finishReason,
        usage: chunk.usage,
      })
    : next(stream, { status: 'streaming', chunks });
}

/**
 * End the stream in failure.
 *
 * `usage` is optional and honest when supplied: a cancelled or broken stream
 * still consumed tokens, and metering what was actually used is the difference
 * between an accurate bill and a favour nobody asked for.
 */
export function failStream(
  stream: AIStream,
  code: ProviderErrorCode,
  reason: string,
  usage?: Usage,
): AIStream {
  assertTransitionAllowed(stream.state.status, 'fail');
  if (reason.trim() === '') {
    throw new StreamError(
      'InvalidStream',
      'A failed stream must say why; a failure nobody can read is one nobody can act on.',
    );
  }
  return next(stream, {
    status: 'failed',
    failureCode: code,
    failureReason: reason,
    ...(usage === undefined ? {} : { usage }),
  });
}

/**
 * Assemble the canonical response.
 *
 * Concatenation in accepted order, which IS sequence order because nothing out
 * of order was ever accepted. No sorting, no gap-filling, no trimming — the
 * text is exactly what the chunks carried.
 */
export function assembleResponse(stream: AIStream): AIResponse {
  if (stream.state.status !== 'completed') {
    throw new StreamError(
      'StreamNotComplete',
      `Stream '${stream.streamId}' is '${stream.state.status}'. Partial streamed content is never returned as a complete response: a truncated section that looks finished is worse than a visible failure.`,
    );
  }

  const { finishReason, usage } = stream.state;
  if (finishReason === null || usage === null) {
    throw new StreamError(
      'StreamNotComplete',
      `Stream '${stream.streamId}' completed without a finish reason or usage; the response it would assemble could not be metered or explained.`,
    );
  }

  return deepFreeze({
    idempotencyKey: stream.request.idempotencyKey,
    providerId: stream.providerId,
    model: stream.model,
    content: stream.state.chunks.map((chunk) => chunk.content).join(''),
    finishReason,
    usage,
    // Vendor frame detail is per-chunk and stays there. Merging it would
    // invent a document-level fact out of fragments.
    providerMetadata: {},
  });
}

/**
 * The terminal outcome.
 *
 * A failed stream returns a failure and no response — see the note at the top
 * of the file.
 */
export function resultOf(stream: AIStream): StreamResult {
  const cursor = cursorOf(stream);

  if (stream.state.status === 'completed') {
    return Object.freeze({
      status: 'completed' as const,
      response: assembleResponse(stream),
      cursor,
    });
  }

  if (stream.state.status === 'failed') {
    return Object.freeze({
      status: 'failed' as const,
      code: stream.state.failureCode ?? 'Internal',
      reason: stream.state.failureReason ?? 'The stream failed without a stated reason.',
      usage: stream.state.usage,
      discardedChunks: stream.state.chunks.length,
      cursor,
    });
  }

  throw new StreamError(
    'StreamNotComplete',
    `Stream '${stream.streamId}' is '${stream.state.status}' and has no result yet; a partial result would read as a complete one.`,
  );
}

/**
 * The events a transport would have emitted, in order.
 *
 * Rebuilt from the state rather than recorded as they happened, so a replay and
 * a live run produce the same sequence — which is what makes a resumed client
 * indistinguishable from one that never disconnected.
 */
export function eventsOf(stream: AIStream): readonly StreamEvent[] {
  const events: StreamEvent[] = [];
  if (stream.state.status === 'initialized') return Object.freeze(events);

  events.push({
    kind: 'started',
    streamId: stream.streamId,
    cursor: Object.freeze({
      streamId: stream.streamId,
      lastSequence: null,
      completed: false,
      resumeToken: resumeTokenFor(stream.streamId, null),
    }),
  });

  for (const chunk of stream.state.chunks) {
    const completed = isFinalChunk(chunk) && stream.state.status === 'completed';
    events.push({
      kind: 'chunk',
      streamId: stream.streamId,
      chunk,
      cursor: Object.freeze({
        streamId: stream.streamId,
        lastSequence: chunk.sequence,
        completed,
        resumeToken: resumeTokenFor(stream.streamId, chunk.sequence),
      }),
    });
  }

  if (stream.state.status === 'completed' && stream.state.finishReason !== null) {
    events.push({
      kind: 'completed',
      streamId: stream.streamId,
      finishReason: stream.state.finishReason,
      cursor: cursorOf(stream),
    });
  }
  if (stream.state.status === 'failed') {
    events.push({
      kind: 'failed',
      streamId: stream.streamId,
      code: stream.state.failureCode ?? 'Internal',
      reason: stream.state.failureReason ?? 'The stream failed without a stated reason.',
      cursor: cursorOf(stream),
    });
  }

  return deepFreeze(events);
}

/**
 * What a client resuming from a cursor has not seen.
 *
 * The protocol half of resumption and the whole of this increment's part in it:
 * which chunks remain. Delivering them is a transport's.
 */
export function chunksAfter(stream: AIStream, cursor: StreamCursor): readonly StreamChunk[] {
  if (cursor.streamId !== stream.streamId) {
    throw new StreamError(
      'UnknownCursor',
      `Cursor is for stream '${cursor.streamId}', not '${stream.streamId}'. Resuming one stream from another's position would deliver someone else's content.`,
    );
  }
  if (cursor.lastSequence === null) return stream.state.chunks;

  // A cursor ahead of the stream came from a different run of it, and the
  // chunks it claims to have seen are not the ones this stream produced.
  if (cursor.lastSequence >= stream.state.chunks.length) {
    throw new StreamError(
      'UnknownCursor',
      `Cursor is at ${String(cursor.lastSequence)} but stream '${stream.streamId}' has produced ${String(stream.state.chunks.length)} chunks; a cursor ahead of its stream cannot be resumed from.`,
    );
  }

  return Object.freeze(stream.state.chunks.slice(cursor.lastSequence + 1));
}

/** Resume from an opaque token. Null when the token is not one of ours. */
export function cursorFromToken(token: string): StreamCursor | null {
  const parsed = parseResumeToken(token);
  if (parsed === null) return null;
  return Object.freeze({
    streamId: parsed.streamId,
    lastSequence: parsed.lastSequence,
    // Unknowable from a token alone; the stream is the authority on it.
    completed: false,
    resumeToken: token,
  });
}
