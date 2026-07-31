/**
 * The dispatcher a composition root supplies.
 *
 * Not a controller and not business logic: it is the wiring between an
 * `AdmissionResult` and the provider the registry already holds, written once
 * here so that six controllers do not each know how to find a provider.
 *
 * ── It decides nothing ──────────────────────────────────────────────────────
 * No routing, no fallback, no retry, no substitution. The provider it uses is
 * the one admission validated, by the id the caller sent. When the Router
 * (`08-ai-platform/model-router.md`) exists, choosing a provider becomes its
 * job and this file loses its `get` call; nothing else about it changes.
 *
 * ── Streaming is framed here, not invented here ─────────────────────────────
 * The chunk protocol is S2.7's and is reused exactly: `openStream`,
 * `startStream`, `acceptChunk`, and the same refusal of duplicate, missing and
 * out-of-order chunks. What this adds is only the walk — pulling from the
 * adapter's iterable and emitting an event per accepted chunk. The events it
 * emits are required by test to be identical to `eventsOf` over the finished
 * stream, so a live consumer and a replaying one see the same sequence.
 */

import { ProviderError, type AIResponse } from '@contentos/contracts';
import {
  acceptChunk,
  cursorOf,
  isFinalChunk,
  isStreamingProvider,
  openStream,
  resumeTokenFor,
  startStream,
  type AdmissionResult,
  type AIStream,
  type ProviderRegistry,
  type StreamCursor,
  type StreamEvent,
} from '@contentos/ai';

import type { AiDispatcher } from './ports.js';

export interface DispatcherOptions {
  readonly providers: ProviderRegistry;
}

/**
 * The stream's identity.
 *
 * The idempotency key, derived rather than generated: two dispatches of one
 * admitted request address the same stream, so a client that reconnects with a
 * resume token minted by the first is talking about the second's chunks too.
 * A random id would make the token unusable across a reconnect, which is the
 * one case resumption exists for.
 */
function streamIdFor(admitted: AdmissionResult): string {
  return admitted.request.idempotencyKey;
}

export function createProviderDispatcher(options: DispatcherOptions): AiDispatcher {
  const { providers } = options;

  return {
    async execute(admitted: AdmissionResult): Promise<AIResponse> {
      // `get` throws on an unknown id; admission already refused those, so
      // reaching that throw would mean the registry changed under a request.
      return providers.get(admitted.providerId).execute(admitted.request);
    },

    async *stream(
      admitted: AdmissionResult,
      resume: StreamCursor | null,
    ): AsyncIterable<StreamEvent> {
      const provider = providers.get(admitted.providerId);
      if (!isStreamingProvider(provider)) {
        // A typed refusal rather than a silent fall back to a buffered call:
        // a client that asked to stream and received one response at the end
        // has had its latency budget spent without being told.
        throw new ProviderError(
          'Unavailable',
          provider.providerId,
          'This provider does not stream.',
        );
      }

      const streamId = streamIdFor(admitted);
      const after = resume === null ? null : resume.lastSequence;
      let stream: AIStream = startStream(
        openStream({
          streamId,
          request: admitted.request,
          providerId: provider.providerId,
          model: admitted.request.model,
        }),
      );

      // A resuming client has already rendered the opening event. Re-sending it
      // would look like a second stream beginning.
      if (after === null) {
        yield {
          kind: 'started',
          streamId,
          cursor: Object.freeze({
            streamId,
            lastSequence: null,
            completed: false,
            resumeToken: resumeTokenFor(streamId, null),
          }),
        };
      }

      for await (const chunk of provider.stream(admitted.request)) {
        // Every chunk is accepted by the engine, including ones this consumer
        // will not be sent: skipping the accept would leave the stream's state
        // one short and turn the NEXT chunk into a gap.
        stream = acceptChunk(stream, chunk);
        const cursor = cursorOf(stream);

        if (after === null || chunk.sequence > after) {
          yield { kind: 'chunk', streamId, chunk, cursor };
        }

        if (isFinalChunk(chunk) && chunk.finishReason !== null) {
          yield { kind: 'completed', streamId, finishReason: chunk.finishReason, cursor };
          return;
        }
      }

      // The adapter's iterable ended without a final chunk. The engine would
      // refuse to assemble this, and saying so is better than returning the
      // text that did arrive as though it were whole.
      throw new ProviderError(
        'MalformedResponse',
        provider.providerId,
        'The provider stream ended without a final chunk.',
      );
    },
  };
}
