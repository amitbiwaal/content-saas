/**
 * The Anthropic adapter.
 *
 * Spec: `08-ai-platform/provider-adapters.md`.
 *
 * ── Where this genuinely differs from OpenAI ────────────────────────────────
 * Anthropic does not take a system message in the message list. It takes a
 * top-level `system` parameter, and the list must contain only user and
 * assistant turns. So the mapping SPLITS the canonical messages: system parts
 * are lifted out and joined, everything else stays.
 *
 * That is exactly the kind of difference the port exists to absorb. A caller
 * writes one message list and never learns that one vendor treats the first
 * element specially.
 */

import Anthropic from '@anthropic-ai/sdk';

import {
  ProviderError,
  type AIRequest,
  type AIResponse,
  type FinishReason,
  type TokenUsage,
  type Usage,
} from '@contentos/contracts';

import type { StreamChunk } from '../streaming/chunk.js';
import { SDK_MAX_RETRIES, UNPRICED_COST, type ProviderCredentials } from './config.js';
import { throughProvider } from './normalize.js';
import type { ProviderHealth } from './provider.js';
import type { StreamingModelProvider } from './streaming-provider.js';

export const ANTHROPIC_PROVIDER_ID = 'anthropic';

/** No embeddings: Anthropic does not offer them, and declaring one would route work that cannot succeed. */
export const ANTHROPIC_CAPABILITIES = ['text', 'chat', 'vision'] as const;

export interface AnthropicRequestBody {
  readonly model: string;
  /** Lifted out of the message list — see the note at the top of the file. */
  readonly system?: string;
  readonly messages: readonly { readonly role: 'user' | 'assistant'; readonly content: string }[];
  readonly max_tokens: number;
  readonly temperature: number;
  readonly top_p?: number;
  readonly stop_sequences?: readonly string[];
}

/** Canonical request → Anthropic request, with the system parts lifted out. */
export function toAnthropicRequest(request: AIRequest): AnthropicRequestBody {
  const system = request.messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n\n');

  const messages = request.messages
    .filter((message) => message.role !== 'system')
    .map((message) => ({ role: message.role as 'user' | 'assistant', content: message.content }));

  if (messages.length === 0) {
    // Anthropic requires at least one turn; a system-only request would be
    // rejected by the vendor with a message that names its own field names.
    throw new ProviderError(
      'Validation',
      ANTHROPIC_PROVIDER_ID,
      `[${ANTHROPIC_PROVIDER_ID}] the request carries only system messages. Anthropic needs at least one user turn, and sending none would fail at the vendor with an error naming fields this platform does not have.`,
    );
  }

  return {
    model: request.model,
    ...(system === '' ? {} : { system }),
    messages,
    // Required by Anthropic, unlike OpenAI where it is optional.
    max_tokens: request.params.maxOutputTokens,
    temperature: request.params.temperature,
    ...(request.params.topP === undefined ? {} : { top_p: request.params.topP }),
    ...(request.params.stopSequences === undefined
      ? {}
      : { stop_sequences: [...request.params.stopSequences] }),
  };
}

/**
 * Anthropic stop reason → the fixed four.
 *
 * `refusal` maps to `content_filter`: it is the vendor declining on safety
 * grounds, which is the case `retry-strategy.md` Rule 2 forbids retrying
 * automatically. Mapping it anywhere else would let it be retried.
 */
export function toFinishReason(raw: string | null | undefined): FinishReason {
  switch (raw) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'max_tokens':
      return 'length';
    case 'refusal':
      return 'content_filter';
    case 'tool_use':
    case 'pause_turn':
      return 'tool_call';
    default:
      throw new ProviderError(
        'MalformedResponse',
        ANTHROPIC_PROVIDER_ID,
        `[${ANTHROPIC_PROVIDER_ID}] stop reason '${String(raw)}' has no canonical equivalent. Reporting it as 'stop' would claim the model finished normally.`,
      );
  }
}

interface AnthropicUsage {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly cache_read_input_tokens?: number;
}

function toTokenUsage(raw: AnthropicUsage | null | undefined): TokenUsage {
  const promptTokens = raw?.input_tokens ?? 0;
  const completionTokens = raw?.output_tokens ?? 0;
  return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens };
}

export interface AnthropicMessage {
  readonly id?: string;
  readonly model?: string;
  /** A list of blocks; the text ones are concatenated in order. */
  readonly content?: readonly { readonly type?: string; readonly text?: string }[];
  readonly stop_reason?: string | null;
  readonly usage?: AnthropicUsage | null;
}

interface MapResponseOptions {
  readonly request: AIRequest;
  readonly latencyMs: number;
  readonly estimated?: boolean;
}

/** Anthropic message → the canonical response. */
export function fromAnthropicMessage(
  message: AnthropicMessage,
  options: MapResponseOptions,
): AIResponse {
  // Text blocks only, in order. A tool-use block carries no prose and
  // stringifying it would put JSON into an article.
  const content = (message.content ?? [])
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text ?? '')
    .join('');

  const usage: Usage = {
    tokens: toTokenUsage(message.usage),
    tokensEstimated: options.estimated ?? false,
    cost: UNPRICED_COST,
    latencyMs: options.latencyMs,
  };

  return {
    idempotencyKey: options.request.idempotencyKey,
    providerId: ANTHROPIC_PROVIDER_ID,
    model: message.model ?? options.request.model,
    content,
    finishReason: toFinishReason(message.stop_reason),
    usage,
    providerMetadata: {
      ...(message.id === undefined ? {} : { requestId: message.id }),
      ...(message.usage?.cache_read_input_tokens === undefined
        ? {}
        : { cacheReadInputTokens: message.usage.cache_read_input_tokens }),
    },
  };
}

/**
 * Anthropic's stream is a sequence of typed EVENTS, not deltas of one shape.
 *
 * `content_block_delta` carries text; `message_delta` carries the stop reason
 * and the output tokens; the rest are structural. Only the first two produce a
 * canonical chunk, which is why this returns null for the others rather than
 * emitting an empty one — an empty chunk would take a sequence number and make
 * the numbering depend on vendor framing.
 */
export interface AnthropicStreamEvent {
  readonly type?: string;
  readonly delta?: {
    readonly type?: string;
    readonly text?: string;
    readonly stop_reason?: string | null;
  };
  readonly usage?: AnthropicUsage | null;
  readonly message?: AnthropicMessage;
}

export function toStreamChunk(
  event: AnthropicStreamEvent,
  sequence: number,
  latencyMs: number,
  promptTokens: number,
): StreamChunk | null {
  if (event.type === 'content_block_delta' && typeof event.delta?.text === 'string') {
    return {
      sequence,
      content: event.delta.text,
      finishReason: null,
      usage: null,
      metadata: {},
    };
  }

  if (event.type === 'message_delta' && event.delta?.stop_reason !== undefined) {
    const completionTokens = event.usage?.output_tokens ?? 0;
    return {
      sequence,
      content: '',
      finishReason: toFinishReason(event.delta.stop_reason),
      usage: {
        tokens: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
        tokensEstimated: event.usage === null || event.usage === undefined,
        cost: UNPRICED_COST,
        latencyMs,
      },
      metadata: {},
    };
  }

  return null;
}

/** Prompt tokens arrive on `message_start`, long before the final event. */
function promptTokensFrom(event: AnthropicStreamEvent): number | null {
  return event.type === 'message_start' ? (event.message?.usage?.input_tokens ?? null) : null;
}

export interface AnthropicTransport {
  create(body: AnthropicRequestBody & { stream?: boolean }): Promise<unknown>;
}

export interface AnthropicAdapterOptions {
  readonly credentials: ProviderCredentials;
  readonly displayName?: string;
  readonly capabilities?: readonly (typeof ANTHROPIC_CAPABILITIES)[number][];
  readonly now?: () => number;
  /** Test seam. Production omits it and the real SDK client is built. */
  readonly transport?: AnthropicTransport;
}

export function createAnthropicProvider(options: AnthropicAdapterOptions): StreamingModelProvider {
  const now = options.now ?? ((): number => Date.now());

  const transport: AnthropicTransport =
    options.transport ??
    (() => {
      const client = new Anthropic({
        apiKey: options.credentials.apiKey,
        ...(options.credentials.baseUrl === undefined
          ? {}
          : { baseURL: options.credentials.baseUrl }),
        ...(options.credentials.timeoutMs === undefined
          ? {}
          : { timeout: options.credentials.timeoutMs }),
        maxRetries: SDK_MAX_RETRIES,
      });
      return {
        create: (body) =>
          client.messages.create(
            body as unknown as Parameters<typeof client.messages.create>[0],
          ) as Promise<unknown>,
      };
    })();

  return {
    providerId: ANTHROPIC_PROVIDER_ID,
    displayName: options.displayName ?? 'Anthropic',
    capabilities: options.capabilities ?? [...ANTHROPIC_CAPABILITIES],

    health: (): Promise<ProviderHealth> =>
      Promise.resolve({
        status: 'healthy',
        reportedAt: new Date(now()).toISOString(),
        detail: null,
      }),

    execute: (request: AIRequest): Promise<AIResponse> =>
      throughProvider(ANTHROPIC_PROVIDER_ID, async () => {
        const startedAt = now();
        const message = (await transport.create(toAnthropicRequest(request))) as AnthropicMessage;
        return fromAnthropicMessage(message, { request, latencyMs: now() - startedAt });
      }),

    async *stream(request: AIRequest): AsyncIterable<StreamChunk> {
      const startedAt = now();
      const events = (await throughProvider(ANTHROPIC_PROVIDER_ID, () =>
        transport.create({ ...toAnthropicRequest(request), stream: true }),
      )) as AsyncIterable<AnthropicStreamEvent>;

      let sequence = 0;
      let promptTokens = 0;
      try {
        for await (const event of events) {
          const seen = promptTokensFrom(event);
          if (seen !== null) promptTokens = seen;

          const chunk = toStreamChunk(event, sequence, now() - startedAt, promptTokens);
          if (chunk === null) continue;
          yield chunk;
          sequence += 1;
        }
      } catch (error: unknown) {
        throw error instanceof ProviderError
          ? error
          : new ProviderError(
              'Unavailable',
              ANTHROPIC_PROVIDER_ID,
              `[${ANTHROPIC_PROVIDER_ID}] the stream failed after ${String(sequence)} chunks: ${error instanceof Error ? error.message : String(error)}`,
              { cause: error },
            );
      }
    },
  };
}
