/**
 * The streaming half of the provider port.
 *
 * ── Why this is an extension and not an edit ────────────────────────────────
 * `ModelProvider` is frozen. Adding `stream()` to it would break every
 * implementation that does not stream and would redesign an increment this one
 * is told not to touch. So streaming is declared as a SEPARATE capability a
 * provider may also satisfy: an adapter implements both, a caller that only
 * needs `execute` still sees a plain `ModelProvider`, and a provider that
 * cannot stream is still a provider.
 *
 * The registry stores `ModelProvider`. `isStreamingProvider` is how a caller
 * that wants to stream finds out whether it can.
 */

import type { AIRequest } from '@contentos/contracts';

import type { StreamChunk } from '../streaming/chunk.js';
import type { ModelProvider } from './provider.js';

export interface StreamingModelProvider extends ModelProvider {
  /**
   * Yield canonical chunks, in sequence, ending with one that carries a finish
   * reason and the usage.
   *
   * An SDK's own stream object never escapes: what comes out is the platform's
   * `StreamChunk` and nothing else, which is what lets S2.7 accept the chunks
   * without knowing which vendor produced them.
   */
  stream(request: AIRequest): AsyncIterable<StreamChunk>;
}

export function isStreamingProvider(provider: ModelProvider): provider is StreamingModelProvider {
  return typeof (provider as Partial<StreamingModelProvider>).stream === 'function';
}
