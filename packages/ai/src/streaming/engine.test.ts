/**
 * The streaming engine.
 *
 * Two properties carry this file.
 *
 * Order is never recovered by sorting — out-of-order and repeated chunks are
 * REFUSED, so the sequence a stream accepted is the sequence it was sent. A
 * layer that quietly reordered would hide a provider fault and make two runs of
 * one request produce two texts.
 *
 * And a failed stream assembles NOTHING. `provider-adapters.md` is explicit:
 * "a truncated article section that looks complete is worse than a visible
 * failure".
 */
import { describe, expect, it } from 'vitest';

import type { AIRequest, Usage } from '@contentos/contracts';

import type { StreamChunk } from './chunk.js';
import {
  acceptChunk,
  assembleResponse,
  chunksAfter,
  cursorFromToken,
  cursorOf,
  eventsOf,
  failStream,
  openStream,
  parseResumeToken,
  resultOf,
  resumeTokenFor,
  startStream,
  type AIStream,
} from './engine.js';
import { StreamError } from './state.js';

const WS = '018f7a1e-0000-7000-8000-0000000000bb';
const ORG = '018f7a1e-0000-7000-8000-0000000000aa';
const CORRELATION = '018f7a1e-0000-7000-8000-0000000000dd';

const USAGE: Usage = {
  tokens: { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 },
  tokensEstimated: false,
  cost: { currency: 'USD', amount: '0.007500' },
  latencyMs: 910,
};

const request: AIRequest = {
  taskType: 'planning.outline',
  capability: 'chat',
  model: 'reference-model',
  messages: [{ role: 'user', content: 'Write an outline.' }],
  params: { temperature: 0.2, maxOutputTokens: 1024 },
  timeoutMs: 30_000,
  idempotencyKey: 'wf-1:outline',
  correlationId: CORRELATION,
  tenantId: WS,
  organizationId: ORG,
};

function chunk(over: Partial<StreamChunk> = {}): StreamChunk {
  return {
    sequence: 0,
    content: 'Hello',
    finishReason: null,
    usage: null,
    metadata: {},
    ...over,
  };
}

const final = (sequence: number, content = ''): StreamChunk =>
  chunk({ sequence, content, finishReason: 'stop', usage: USAGE });

const opened = (): AIStream =>
  openStream({ streamId: 'st-1', request, providerId: 'reference', model: 'reference-model-2026' });

const started = (): AIStream => startStream(opened());

/** A stream that received `n` content chunks and has not finished. */
function streaming(n: number): AIStream {
  let stream = started();
  for (let i = 0; i < n; i += 1) {
    stream = acceptChunk(stream, chunk({ sequence: i, content: `part${String(i)} ` }));
  }
  return stream;
}

const completed = (n = 3): AIStream => acceptChunk(streaming(n), final(n));

describe('opening a stream', () => {
  it('starts initialized, with nothing received', () => {
    const stream = opened();
    expect(stream.state).toMatchObject({
      status: 'initialized',
      chunks: [],
      finishReason: null,
      usage: null,
    });
  });

  // No streaming-specific request type: the canonical one, unwrapped.
  it('carries the canonical request unchanged', () => {
    expect(opened().request).toBe(request);
  });

  it('records which provider and model are streaming', () => {
    expect(opened()).toMatchObject({ providerId: 'reference', model: 'reference-model-2026' });
  });

  it('requires an id, a provider and a model', () => {
    for (const field of ['streamId', 'providerId', 'model'] as const) {
      expect(() =>
        openStream({
          streamId: 'st-1',
          request,
          providerId: 'reference',
          model: 'm',
          [field]: '  ',
        } as never),
      ).toThrow(StreamError);
    }
  });

  it('is frozen', () => {
    expect(Object.isFrozen(opened())).toBe(true);
    expect(Object.isFrozen(opened().state)).toBe(true);
  });
});

describe('the lifecycle advances one step at a time', () => {
  it('walks initialized → started → streaming → completed', () => {
    const a = opened();
    expect(a.state.status).toBe('initialized');
    const b = startStream(a);
    expect(b.state.status).toBe('started');
    const c = acceptChunk(b, chunk());
    expect(c.state.status).toBe('streaming');
    const d = acceptChunk(c, final(1));
    expect(d.state.status).toBe('completed');
  });

  it('refuses a chunk before the stream opened', () => {
    expect(() => acceptChunk(opened(), chunk())).toThrow(StreamError);
  });

  it('refuses to start twice', () => {
    expect(() => startStream(started())).toThrow(/only legal from/);
  });

  // A provider may refuse the request before a single token arrives.
  it('can fail before anything streamed', () => {
    expect(failStream(opened(), 'Authentication', 'credential rejected').state.status).toBe(
      'failed',
    );
    expect(failStream(started(), 'Unavailable', 'capacity').state.status).toBe('failed');
  });

  it('leaves the previous stream untouched', () => {
    const before = started();
    const after = acceptChunk(before, chunk());
    expect(before.state.chunks).toHaveLength(0);
    expect(after.state.chunks).toHaveLength(1);
  });
});

describe('chunk ordering is enforced, never repaired', () => {
  it('accepts contiguous chunks from zero', () => {
    expect(streaming(4).state.chunks.map((c) => c.sequence)).toEqual([0, 1, 2, 3]);
  });

  // Accepting it again would repeat its content in the assembled response.
  it('refuses a duplicate sequence', () => {
    const stream = streaming(3);
    expect(() => acceptChunk(stream, chunk({ sequence: 1 }))).toThrow(StreamError);
  });

  it('reports a duplicate as DuplicateChunk', () => {
    try {
      acceptChunk(streaming(3), chunk({ sequence: 0 }));
      expect.unreachable('must refuse');
    } catch (error) {
      expect((error as StreamError).code).toBe('DuplicateChunk');
    }
  });

  // Filling a gap later would put the text in the wrong order; assembling
  // around it would silently drop what never arrived.
  it('refuses a gap', () => {
    try {
      acceptChunk(streaming(2), chunk({ sequence: 3 }));
      expect.unreachable('must refuse');
    } catch (error) {
      expect((error as StreamError).code).toBe('MissingSequence');
    }
  });

  it('refuses a chunk from much further ahead', () => {
    try {
      acceptChunk(streaming(2), chunk({ sequence: 99 }));
      expect.unreachable('must refuse');
    } catch (error) {
      expect((error as StreamError).code).toBe('OutOfOrderChunk');
    }
  });

  it('says plainly that chunks are never reordered', () => {
    expect(() => acceptChunk(streaming(2), chunk({ sequence: 5 }))).toThrow(/never reordered/);
  });

  it('refuses a malformed chunk', () => {
    for (const bad of [
      chunk({ sequence: -1 }),
      chunk({ sequence: 1.5 }),
      chunk({ content: 42 as never }),
      chunk({ metadata: null as never }),
      chunk({ finishReason: 'done' as never }),
    ]) {
      expect(() => acceptChunk(started(), bad), JSON.stringify(bad.sequence)).toThrow(StreamError);
    }
  });

  // A stream that ends without usage cannot be metered.
  it('refuses a final chunk with no usage', () => {
    expect(() =>
      acceptChunk(started(), chunk({ sequence: 0, finishReason: 'stop', usage: null })),
    ).toThrow(/cannot be metered/);
  });

  // Totals on an intermediate chunk would describe a stream that has not ended.
  it('refuses usage on a non-final chunk', () => {
    expect(() => acceptChunk(started(), chunk({ sequence: 0, usage: USAGE }))).toThrow(StreamError);
  });

  it('freezes every accepted chunk', () => {
    const stream = streaming(2);
    for (const c of stream.state.chunks) expect(Object.isFrozen(c)).toBe(true);
    expect(Object.isFrozen(stream.state.chunks)).toBe(true);
  });

  // A caller mutating what it handed over must not change what was accepted.
  it("copies the chunk rather than storing the caller's object", () => {
    const supplied = chunk();
    const stream = acceptChunk(started(), supplied);
    expect(stream.state.chunks[0]).not.toBe(supplied);
    expect(stream.state.chunks[0]?.content).toBe('Hello');
  });
});

describe('the final chunk ends the stream', () => {
  it('completes on a chunk carrying a finish reason', () => {
    const stream = completed(2);
    expect(stream.state.status).toBe('completed');
    expect(stream.state.finishReason).toBe('stop');
    expect(stream.state.usage).toEqual(USAGE);
  });

  it('accepts a final chunk that carries no text', () => {
    expect(completed(2).state.chunks[2]?.content).toBe('');
  });

  it('accepts a stream whose only chunk is the final one', () => {
    const stream = acceptChunk(started(), final(0, 'All of it.'));
    expect(stream.state.status).toBe('completed');
    expect(assembleResponse(stream).content).toBe('All of it.');
  });

  it('refuses a chunk after completion', () => {
    expect(() => acceptChunk(completed(), chunk({ sequence: 4 }))).toThrow(/no outgoing/);
  });

  it('refuses to fail a completed stream', () => {
    expect(() => failStream(completed(), 'Timeout', 'too late')).toThrow(StreamError);
  });
});

describe('assembly is deterministic', () => {
  it('concatenates the chunks in the order they were accepted', () => {
    expect(assembleResponse(completed(3)).content).toBe('part0 part1 part2 ');
  });

  it('produces an identical response from identical chunks, every time', () => {
    const first = JSON.stringify(assembleResponse(completed(4)));
    for (let i = 0; i < 25; i += 1) {
      expect(JSON.stringify(assembleResponse(completed(4)))).toBe(first);
    }
  });

  // No streaming-specific response type — this is the same shape a
  // non-streamed call returns.
  it('assembles the canonical AIResponse', () => {
    const response = assembleResponse(completed(2));
    expect(response).toMatchObject({
      idempotencyKey: 'wf-1:outline',
      providerId: 'reference',
      model: 'reference-model-2026',
      finishReason: 'stop',
      usage: USAGE,
    });
    expect(response.providerMetadata).toEqual({});
  });

  it("echoes the request's idempotency key, so a retry is recognisable", () => {
    expect(assembleResponse(completed()).idempotencyKey).toBe(request.idempotencyKey);
  });

  it('reports the model that actually streamed, not the one asked for', () => {
    expect(assembleResponse(completed()).model).toBe('reference-model-2026');
    expect(request.model).toBe('reference-model');
  });

  it('freezes the response', () => {
    const response = assembleResponse(completed());
    expect(Object.isFrozen(response)).toBe(true);
    expect(() => {
      (response as { content: string }).content = 'tampered';
    }).toThrow();
  });

  it('assembles an empty string when every chunk was empty', () => {
    let stream = started();
    stream = acceptChunk(stream, chunk({ sequence: 0, content: '' }));
    stream = acceptChunk(stream, final(1));
    expect(assembleResponse(stream).content).toBe('');
  });
});

describe('partial content is never returned as a complete response', () => {
  const broken = (): AIStream =>
    failStream(streaming(3), 'Unavailable', 'the connection dropped mid-stream');

  // The rule the spec states outright.
  it('refuses to assemble a failed stream', () => {
    expect(() => assembleResponse(broken())).toThrow(StreamError);
  });

  it('refuses to assemble a stream still in flight', () => {
    for (const stream of [opened(), started(), streaming(2)]) {
      expect(() => assembleResponse(stream), stream.state.status).toThrow(/never returned/);
    }
  });

  it('returns a failure result carrying no response at all', () => {
    const result = resultOf(broken());
    expect(result.status).toBe('failed');
    expect(result).not.toHaveProperty('response');
  });

  // Discarding partial output is a visible decision, not a silent one.
  it('reports how many chunks were discarded', () => {
    const result = resultOf(broken());
    expect(result.status === 'failed' && result.discardedChunks).toBe(3);
  });

  it('carries the typed code and the reason', () => {
    const result = resultOf(broken());
    expect(result.status === 'failed' && result.code).toBe('Unavailable');
    expect(result.status === 'failed' && result.reason).toContain('mid-stream');
  });

  // A cancelled or broken stream still consumed tokens; metering what was
  // actually used is the difference between a bill and a favour.
  it('reports partial usage where the provider gave it', () => {
    const cancelled = failStream(streaming(2), 'Timeout', 'client cancelled', USAGE);
    const result = resultOf(cancelled);
    expect(result.status === 'failed' && result.usage).toEqual(USAGE);
  });

  it('reports no usage where none was given', () => {
    const result = resultOf(broken());
    expect(result.status === 'failed' && result.usage).toBeNull();
  });

  it('requires a failure to say why', () => {
    expect(() => failStream(streaming(1), 'Internal', '  ')).toThrow(/must say why/);
  });

  it('has no result while the stream is still going', () => {
    for (const stream of [opened(), started(), streaming(1)]) {
      expect(() => resultOf(stream), stream.state.status).toThrow(/no result yet/);
    }
  });
});

describe('the resume cursor', () => {
  it('is at the start before anything arrived', () => {
    const cursor = cursorOf(started());
    expect(cursor).toMatchObject({ streamId: 'st-1', lastSequence: null, completed: false });
    expect(cursor.resumeToken).toBe('stream:st-1@start');
  });

  it('advances with each chunk', () => {
    expect(cursorOf(streaming(3)).lastSequence).toBe(2);
    expect(cursorOf(streaming(3)).resumeToken).toBe('stream:st-1@2');
  });

  it('reports completion, which is what tells a client to stop', () => {
    expect(cursorOf(completed(2)).completed).toBe(true);
    expect(cursorOf(streaming(2)).completed).toBe(false);
  });

  // Derived, never generated: a random token would make two identical streams
  // resumable by different strings.
  it('derives the same token for the same position', () => {
    expect(resumeTokenFor('st-1', 4)).toBe(resumeTokenFor('st-1', 4));
    expect(cursorOf(streaming(3)).resumeToken).toBe(cursorOf(streaming(3)).resumeToken);
  });

  it('round-trips through its token', () => {
    expect(parseResumeToken('stream:st-1@7')).toEqual({ streamId: 'st-1', lastSequence: 7 });
    expect(parseResumeToken('stream:st-1@start')).toEqual({
      streamId: 'st-1',
      lastSequence: null,
    });
  });

  it('returns null for a token it did not produce', () => {
    for (const token of ['', 'nonsense', 'stream:st-1', 'stream:st-1@x']) {
      expect(parseResumeToken(token), token).toBeNull();
      expect(cursorFromToken(token), token).toBeNull();
    }
  });

  it('rebuilds a cursor from a token', () => {
    expect(cursorFromToken('stream:st-1@2')).toMatchObject({
      streamId: 'st-1',
      lastSequence: 2,
    });
  });

  it('is frozen', () => {
    expect(Object.isFrozen(cursorOf(streaming(2)))).toBe(true);
  });
});

describe('resuming delivers what a client has not seen', () => {
  it('gives everything to a client at the start', () => {
    const stream = streaming(3);
    expect(chunksAfter(stream, cursorOf(started()))).toHaveLength(3);
  });

  it('gives only what came after the cursor', () => {
    const stream = streaming(4);
    const cursor = cursorOf(streaming(2));
    expect(chunksAfter(stream, cursor).map((c) => c.sequence)).toEqual([2, 3]);
  });

  it('gives nothing to a client that is up to date', () => {
    const stream = streaming(3);
    expect(chunksAfter(stream, cursorOf(stream))).toEqual([]);
  });

  it('includes the final chunk when resuming a completed stream', () => {
    const stream = completed(2);
    expect(chunksAfter(stream, cursorOf(streaming(1))).map((c) => c.sequence)).toEqual([1, 2]);
  });

  // Resuming one stream from another's position would deliver someone else's
  // content.
  it('refuses a cursor for a different stream', () => {
    const other = { ...cursorOf(streaming(1)), streamId: 'st-9' };
    expect(() => chunksAfter(streaming(3), other)).toThrow(/not 'st-1'/);
  });

  it('refuses a cursor ahead of the stream', () => {
    const ahead = { ...cursorOf(streaming(1)), lastSequence: 99 };
    try {
      chunksAfter(streaming(3), ahead);
      expect.unreachable('must refuse');
    } catch (error) {
      expect((error as StreamError).code).toBe('UnknownCursor');
    }
  });

  it('gives the same answer every time', () => {
    const stream = streaming(4);
    const cursor = cursorOf(streaming(1));
    expect(chunksAfter(stream, cursor)).toEqual(chunksAfter(stream, cursor));
  });
});

describe('the event protocol', () => {
  it('emits nothing before the stream opens', () => {
    expect(eventsOf(opened())).toEqual([]);
  });

  it('emits started, then one per chunk, then completed', () => {
    expect(eventsOf(completed(2)).map((e) => e.kind)).toEqual([
      'started',
      'chunk',
      'chunk',
      'chunk',
      'completed',
    ]);
  });

  it('emits started, chunks, then failed', () => {
    const broken = failStream(streaming(2), 'Timeout', 'dropped');
    expect(eventsOf(broken).map((e) => e.kind)).toEqual(['started', 'chunk', 'chunk', 'failed']);
  });

  // A client that drops resumes from the last event it actually saw rather
  // than from a position the server assumed it reached.
  it('carries the cursor as of each event', () => {
    const events = eventsOf(completed(2));
    const cursors = events.map((e) => e.cursor.lastSequence);
    expect(cursors).toEqual([null, 0, 1, 2, 2]);
  });

  // Rebuilt from state, so a replay and a live run produce the same sequence.
  it('produces the same events every time', () => {
    expect(JSON.stringify(eventsOf(completed(3)))).toBe(JSON.stringify(eventsOf(completed(3))));
  });

  it('carries the typed code on a failure event', () => {
    const events = eventsOf(failStream(streaming(1), 'ContentFiltered', 'refused'));
    const last = events[events.length - 1];
    expect(last?.kind === 'failed' && last.code).toBe('ContentFiltered');
  });

  it('is frozen', () => {
    expect(Object.isFrozen(eventsOf(completed(1)))).toBe(true);
  });
});
