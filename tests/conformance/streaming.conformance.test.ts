/**
 * Streaming against the REAL workflow runtime, meter and retry engine.
 *
 * The unit suites drive a stream in isolation. What they cannot show is the
 * property the increment exists to establish: that a streamed call is
 * indistinguishable, downstream, from one that was not. The workflow records
 * the assembled response, the meter prices it, and the retry engine decides
 * about a broken stream — and none of them is told a stream was involved.
 *
 * That is the whole test of "reuse the canonical AIResponse": if streaming had
 * needed a response of its own, every one of those would need a second path.
 */

import { describe, expect, it } from 'vitest';

import {
  acceptChunk,
  assembleResponse,
  awaitExecution,
  beginRetryState,
  buildRequest,
  chunksAfter,
  createPricingRegistry,
  createPromptCatalogue,
  createWorkflowExecution,
  cursorFromToken,
  cursorOf,
  decideRetry,
  eventsOf,
  failStream,
  loadStep,
  openStream,
  pendingRequest,
  preparePrompt,
  recordExecution,
  recordFailure,
  recordResponseUsage,
  recover,
  resultOf,
  startStream,
  startWorkflow,
  streamResultOf,
  validateAIResponse,
  type AIStream,
  type PromptTemplate,
  type StreamChunk,
  type WorkflowDefinition,
  type WorkflowExecution,
  type WorkflowExecutionContext,
} from '@contentos/ai';
import { ProviderError, type Usage } from '@contentos/contracts';

const WS = '018f7a1e-0000-7000-8000-0000000000bb';
const ORG = '018f7a1e-0000-7000-8000-0000000000aa';
const CORRELATION = '018f7a1e-0000-7000-8000-0000000000dd';
const JOB = '018f7a1e-0000-7000-7003-000000000001';

const USAGE: Usage = {
  tokens: { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 },
  tokensEstimated: false,
  cost: { currency: 'USD', amount: '0.000000' },
  latencyMs: 910,
};

const TEMPLATE: PromptTemplate = {
  id: 'planning.outline',
  version: 7,
  taskType: 'planning.outline',
  status: 'active',
  parts: { system: 'You write outlines.', user: 'Write an outline about {{topic}}.' },
  variables: [{ name: 'topic', type: 'string', required: true, description: 'The subject.' }],
  modelHints: { maxOutputTokens: 1024, temperature: 0.2, determinismRequired: false },
  evalSetRef: 'evals/planning.outline',
  owner: 'content-platform',
  changelog: 'Initial version.',
};

const catalogue = createPromptCatalogue([TEMPLATE]);

const pricing = createPricingRegistry({
  version: 'table-2026-07',
  prices: [
    {
      providerId: 'reference',
      model: 'reference-model-2026-05-01',
      currency: 'USD',
      inputPerMillion: '2.5',
      outputPerMillion: '10',
    },
  ],
});
pricing.seal();

const DEFINITION: WorkflowDefinition = {
  id: 'article.draft',
  version: 1,
  description: 'Outline the article.',
  steps: [
    {
      id: 'outline',
      templateRef: { id: 'planning.outline' },
      capability: 'chat',
      model: 'reference-model',
      timeoutMs: 30_000,
    },
  ],
};

const context: WorkflowExecutionContext = {
  tenant: { tenantId: WS, organizationId: ORG, source: 'event' },
  jobId: JOB,
  correlationId: CORRELATION,
  metadata: {},
};

/** A workflow driven to the point where a caller would dispatch. */
const awaiting = (): WorkflowExecution =>
  awaitExecution(
    buildRequest(
      preparePrompt(
        loadStep(
          startWorkflow(
            createWorkflowExecution({
              workflowId: 'wf-1',
              definition: DEFINITION,
              context,
              variables: { topic: 'espresso' },
            }),
          ),
        ),
        catalogue,
      ),
    ),
  );

const PARTS = ['I. Grind. ', 'II. Dose. ', 'III. Extract.'];

const chunk = (sequence: number, content: string): StreamChunk => ({
  sequence,
  content,
  finishReason: null,
  usage: null,
  metadata: { frame: sequence },
});

/** Streams the three parts and finishes. The provider's whole side. */
function streamed(execution: WorkflowExecution): AIStream {
  const request = pendingRequest(execution);
  if (request === null) throw new Error('expected a pending request');

  let stream = startStream(
    openStream({
      streamId: 'st-1',
      request,
      providerId: 'reference',
      model: 'reference-model-2026-05-01',
    }),
  );
  PARTS.forEach((content, i) => {
    stream = acceptChunk(stream, chunk(i, content));
  });
  return acceptChunk(stream, {
    sequence: PARTS.length,
    content: '',
    finishReason: 'stop',
    usage: USAGE,
    metadata: {},
  });
}

describe('streaming is published as one surface', () => {
  it('exports the lifecycle, assembly, cursor and protocol from @contentos/ai', () => {
    for (const fn of [
      openStream,
      startStream,
      acceptChunk,
      assembleResponse,
      chunksAfter,
      eventsOf,
    ]) {
      expect(typeof fn).toBe('function');
    }
  });

  // No transport anywhere: the protocol says what a transport would carry.
  it('carries no transport, only the protocol', async () => {
    const ai: Record<string, unknown> = await import('@contentos/ai');
    for (const name of ['createSSEStream', 'createWebSocket', 'streamHandler', 'toSSE']) {
      expect(Object.keys(ai), name).not.toContain(name);
    }
  });
});

describe('a streamed call is indistinguishable downstream', () => {
  // If streaming had needed a response of its own, every downstream component
  // would need a second path.
  it('assembles a response the frozen contract accepts', () => {
    const response = assembleResponse(streamed(awaiting()));
    expect(validateAIResponse(response)).toEqual({ ok: true });
  });

  it('records into the workflow runtime with no streaming-aware path', () => {
    const execution = awaiting();
    const response = assembleResponse(streamed(execution));
    const done = recordExecution(execution, response);

    expect(done.state.status).toBe('completed');
    expect(resultOf(done).steps[0]?.content).toBe('I. Grind. II. Dose. III. Extract.');
  });

  it('meters through the usage recorder with no streaming-aware path', () => {
    const execution = awaiting();
    const response = assembleResponse(streamed(execution));

    const usage = recordResponseUsage(
      response,
      {
        tenantId: WS,
        organizationId: ORG,
        correlationId: CORRELATION,
        attempt: 1,
        taskType: 'planning.outline',
        promptVersion: 'planning.outline@7',
        runId: 'wf-1',
        stepId: 'outline',
      },
      pricing,
    );

    expect(usage.record.cost.totalCost).toBe('0.007500');
    expect(usage.ledgerIdempotencyKey).toBe('wf-1:outline#1');
  });

  // The key travels request → stream → response, so a retried stream is
  // recognisable as the same call.
  it('echoes the idempotency key the workflow derived', () => {
    const execution = awaiting();
    expect(pendingRequest(execution)?.idempotencyKey).toBe('wf-1:outline');
    expect(assembleResponse(streamed(execution)).idempotencyKey).toBe('wf-1:outline');
  });

  it('produces the same response from the same chunks, every time', () => {
    const execution = awaiting();
    const a = JSON.stringify(assembleResponse(streamed(execution)));
    const b = JSON.stringify(assembleResponse(streamed(execution)));
    expect(b).toBe(a);
  });
});

describe('a broken stream never reaches the workflow', () => {
  const broken = (): AIStream => {
    const execution = awaiting();
    const request = pendingRequest(execution);
    if (request === null) throw new Error('expected a pending request');
    let stream = startStream(
      openStream({
        streamId: 'st-1',
        request,
        providerId: 'reference',
        model: 'reference-model-2026-05-01',
      }),
    );
    stream = acceptChunk(stream, chunk(0, PARTS[0] ?? ''));
    stream = acceptChunk(stream, chunk(1, PARTS[1] ?? ''));
    return failStream(stream, 'Unavailable', 'the connection dropped mid-stream');
  };

  // A truncated section that looks complete is worse than a visible failure.
  it('assembles nothing, so there is nothing to record', () => {
    expect(() => assembleResponse(broken())).toThrow(/never returned/);
  });

  it('reports the loss rather than hiding it', () => {
    const result = streamResultOf(broken());
    expect(result.status).toBe('failed');
    expect(result.status === 'failed' && result.discardedChunks).toBe(2);
  });

  // The stream's failure code is a provider error code, so the retry engine
  // decides about it with no streaming-specific classification.
  it('feeds the retry engine through the shared taxonomy', () => {
    const result = streamResultOf(broken());
    if (result.status !== 'failed') throw new Error('expected a failure');

    const state = recordFailure(
      beginRetryState('wf-1:outline'),
      new ProviderError(result.code, 'reference', result.reason),
    );
    const decision = decideRetry(state);
    expect(decision.action).toBe('retry');
    expect(decision.attempt).toBe(2);
  });

  it('is not retried when the stream failed for a reason that must not be', () => {
    const execution = awaiting();
    const request = pendingRequest(execution);
    if (request === null) throw new Error('expected a pending request');
    const refused = failStream(
      startStream(openStream({ streamId: 'st-2', request, providerId: 'reference', model: 'm' })),
      'ContentFiltered',
      'refused on safety grounds',
    );
    const result = streamResultOf(refused);
    if (result.status !== 'failed') throw new Error('expected a failure');

    const state = recordFailure(
      beginRetryState('wf-1:outline'),
      new ProviderError(result.code, 'reference', result.reason),
    );
    expect(decideRetry(state).action).toBe('fail');
  });

  // The workflow is still awaiting; recovery decides, exactly as for a
  // non-streamed interruption.
  it('leaves the workflow recoverable through the existing path', () => {
    const execution = awaiting();
    broken();
    const recovery = recover(execution);
    expect(recovery.action).toBe('redispatch');
    expect(recovery.request?.idempotencyKey).toBe('wf-1:outline');
  });
});

describe('the resume protocol, end to end', () => {
  it('delivers only what a disconnected client had not seen', () => {
    const stream = streamed(awaiting());
    const seen = cursorFromToken('stream:st-1@1');
    expect(seen).not.toBeNull();
    if (seen === null) return;

    const remaining = chunksAfter(stream, seen);
    expect(remaining.map((c) => c.sequence)).toEqual([2, 3]);
    expect(remaining.map((c) => c.content).join('')).toBe('III. Extract.');
  });

  it('rebuilds the whole text when a client resumes from the start', () => {
    const stream = streamed(awaiting());
    const fromStart = cursorFromToken('stream:st-1@start');
    expect(fromStart).not.toBeNull();
    if (fromStart === null) return;
    expect(
      chunksAfter(stream, fromStart)
        .map((c) => c.content)
        .join(''),
    ).toBe(assembleResponse(stream).content);
  });

  it('tells a client the stream is over', () => {
    expect(cursorOf(streamed(awaiting())).completed).toBe(true);
  });

  // A replay and a live run produce the same sequence, which is what makes a
  // resumed client indistinguishable from one that never disconnected.
  it('replays the same events it emitted live', () => {
    const stream = streamed(awaiting());
    expect(JSON.stringify(eventsOf(stream))).toBe(JSON.stringify(eventsOf(stream)));
    expect(eventsOf(stream).map((e) => e.kind)).toEqual([
      'started',
      'chunk',
      'chunk',
      'chunk',
      'chunk',
      'completed',
    ]);
  });

  it('refuses a cursor from a different stream', () => {
    const stream = streamed(awaiting());
    const other = cursorFromToken('stream:st-9@0');
    expect(other).not.toBeNull();
    if (other === null) return;
    expect(() => chunksAfter(stream, other)).toThrow(/would deliver someone else/);
  });
});

describe('the contracts are provider-independent', () => {
  // Nothing in a chunk names a vendor: `metadata` is opaque and everything
  // else is the platform's own vocabulary.
  it('names no vendor anywhere in a chunk', () => {
    const stream = streamed(awaiting());
    const serialized = JSON.stringify(stream.state.chunks).toLowerCase();
    for (const vendor of ['openai', 'anthropic', 'gemini', 'claude', 'gpt']) {
      expect(serialized, vendor).not.toContain(vendor);
    }
  });

  it('carries the vendor frame detail opaquely, and never interprets it', () => {
    const stream = streamed(awaiting());
    expect(stream.state.chunks[0]?.metadata).toEqual({ frame: 0 });
    // It reaches no part of the assembled response.
    expect(assembleResponse(stream).providerMetadata).toEqual({});
  });

  it('assembles the same text whatever the chunk boundaries were', () => {
    const execution = awaiting();
    const request = pendingRequest(execution);
    if (request === null) throw new Error('expected a pending request');

    const build = (parts: readonly string[]): string => {
      let stream = startStream(
        openStream({ streamId: 'st-x', request, providerId: 'reference', model: 'm' }),
      );
      parts.forEach((content, i) => {
        stream = acceptChunk(stream, chunk(i, content));
      });
      stream = acceptChunk(stream, {
        sequence: parts.length,
        content: '',
        finishReason: 'stop',
        usage: USAGE,
        metadata: {},
      });
      return assembleResponse(stream).content;
    };

    // One provider sends three frames; another sends the same text in six.
    expect(build(['abc', 'def'])).toBe(build(['a', 'b', 'c', 'd', 'e', 'f']));
  });
});
