/**
 * The OpenAI adapter.
 *
 * Spec: `08-ai-platform/provider-adapters.md`. This file is the only place in
 * the platform that knows OpenAI exists, and the SDK import is legal only in
 * this directory (ADR-019, enforced by lint).
 *
 * ── An adapter translates and reports. It never decides ─────────────────────
 * No retries on its own schedule — the client is built with retries DISABLED,
 * because S2.6 owns whether and when, and an SDK retrying underneath it would
 * multiply the attempts, the spend and the rate-limit pressure invisibly. No
 * model substitution, no caching, no interpretation of content.
 *
 * ── The mapping is separate from the call ───────────────────────────────────
 * Every function that translates is pure and exported. That is where the bugs
 * live — a finish reason mapped to the wrong member changes what the platform
 * believes happened — and pure functions are the half that can be tested
 * exhaustively without a vendor, a key or a network.
 */

import OpenAI from 'openai';

import {
  ProviderError,
  type AIMessage,
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

export const OPENAI_PROVIDER_ID = 'openai';

/** What this adapter can be asked for. Declared, never assumed. */
export const OPENAI_CAPABILITIES = ['text', 'chat', 'vision', 'embedding'] as const;

/** The vendor's message shape. Ours maps onto it one-for-one. */
export interface OpenAIRequestBody {
  readonly model: string;
  readonly messages: readonly { readonly role: string; readonly content: string }[];
  readonly temperature: number;
  readonly max_completion_tokens: number;
  readonly top_p?: number;
  readonly seed?: number;
  readonly stop?: readonly string[];
}

/**
 * Canonical request → OpenAI request.
 *
 * The roles line up exactly, which is why this mapping is short. Anthropic and
 * Google are where the shape genuinely differs.
 */
export function toOpenAIRequest(request: AIRequest): OpenAIRequestBody {
  return {
    model: request.model,
    messages: request.messages.map((message: AIMessage) => ({
      role: message.role,
      content: message.content,
    })),
    temperature: request.params.temperature,
    // `max_completion_tokens`, not the deprecated `max_tokens`: the newer
    // models reject the old name outright.
    max_completion_tokens: request.params.maxOutputTokens,
    ...(request.params.topP === undefined ? {} : { top_p: request.params.topP }),
    ...(request.params.seed === undefined ? {} : { seed: request.params.seed }),
    ...(request.params.stopSequences === undefined
      ? {}
      : { stop: [...request.params.stopSequences] }),
  };
}

/**
 * OpenAI finish reason → the fixed four.
 *
 * An unmappable reason raises `MalformedResponse` rather than defaulting to
 * `stop`. Defaulting would report a clean completion for a response that ended
 * some other way, and "the model finished normally" is exactly the claim
 * nothing downstream should have to doubt.
 */
export function toFinishReason(raw: string | null | undefined): FinishReason {
  switch (raw) {
    case 'stop':
      return 'stop';
    case 'length':
      return 'length';
    case 'content_filter':
      return 'content_filter';
    case 'tool_calls':
    case 'function_call':
      return 'tool_call';
    default:
      throw new ProviderError(
        'MalformedResponse',
        OPENAI_PROVIDER_ID,
        `[${OPENAI_PROVIDER_ID}] finish reason '${String(raw)}' has no canonical equivalent. Reporting it as 'stop' would claim the model finished normally.`,
      );
  }
}

/** OpenAI usage → canonical `TokenUsage`. Always populated. */
function toTokenUsage(raw: OpenAIUsage | null | undefined): TokenUsage {
  const promptTokens = raw?.prompt_tokens ?? 0;
  const completionTokens = raw?.completion_tokens ?? 0;
  return {
    promptTokens,
    completionTokens,
    // Recomputed rather than trusted: a vendor total that disagrees with its
    // own parts would fail the meter's consistency check, and the parts are
    // what the price table is applied to.
    totalTokens: promptTokens + completionTokens,
  };
}

interface OpenAIUsage {
  readonly prompt_tokens?: number;
  readonly completion_tokens?: number;
  readonly total_tokens?: number;
}

export interface OpenAICompletion {
  readonly model?: string;
  readonly choices?: readonly {
    readonly message?: { readonly content?: string | null };
    readonly finish_reason?: string | null;
  }[];
  readonly usage?: OpenAIUsage | null;
  readonly id?: string;
  readonly system_fingerprint?: string;
}

interface MapResponseOptions {
  readonly request: AIRequest;
  readonly latencyMs: number;
  /** True when the counts were computed locally rather than reported. */
  readonly estimated?: boolean;
}

/** OpenAI completion → the canonical response. */
export function fromOpenAICompletion(
  completion: OpenAICompletion,
  options: MapResponseOptions,
): AIResponse {
  const choice = completion.choices?.[0];
  if (choice === undefined) {
    throw new ProviderError(
      'MalformedResponse',
      OPENAI_PROVIDER_ID,
      `[${OPENAI_PROVIDER_ID}] the completion carried no choices; there is no content to return.`,
    );
  }

  const usage: Usage = {
    tokens: toTokenUsage(completion.usage),
    tokensEstimated: options.estimated ?? false,
    cost: UNPRICED_COST,
    latencyMs: options.latencyMs,
  };

  return {
    idempotencyKey: options.request.idempotencyKey,
    providerId: OPENAI_PROVIDER_ID,
    // The model that ACTUALLY ran. A vendor may resolve an alias to a dated
    // snapshot, and pricing the alias would hide which one it was.
    model: completion.model ?? options.request.model,
    content: choice.message?.content ?? '',
    finishReason: toFinishReason(choice.finish_reason),
    usage,
    // Opaque, retained for diagnostics, never interpreted.
    providerMetadata: {
      ...(completion.id === undefined ? {} : { requestId: completion.id }),
      ...(completion.system_fingerprint === undefined
        ? {}
        : { systemFingerprint: completion.system_fingerprint }),
    },
  };
}

export interface OpenAIStreamFrame {
  readonly model?: string;
  readonly choices?: readonly {
    readonly delta?: { readonly content?: string | null };
    readonly finish_reason?: string | null;
  }[];
  readonly usage?: OpenAIUsage | null;
}

/**
 * One vendor frame → one canonical chunk.
 *
 * The sequence is supplied by the caller rather than read from the frame:
 * OpenAI does not number its frames, and a chunk whose position depended on
 * arrival would make the assembled text depend on the network.
 */
export function toStreamChunk(
  frame: OpenAIStreamFrame,
  sequence: number,
  latencyMs: number,
): StreamChunk {
  const choice = frame.choices?.[0];
  const rawFinish = choice?.finish_reason ?? null;
  const final = rawFinish !== null;

  return {
    sequence,
    content: choice?.delta?.content ?? '',
    finishReason: final ? toFinishReason(rawFinish) : null,
    usage: final
      ? {
          tokens: toTokenUsage(frame.usage),
          tokensEstimated: frame.usage === null || frame.usage === undefined,
          cost: UNPRICED_COST,
          latencyMs,
        }
      : null,
    metadata: {},
  };
}

/**
 * The minimum of the SDK this adapter uses.
 *
 * Declared as an interface so a test can supply a stub without a key, a
 * network or a vendor. Production passes the real client, which satisfies it.
 */
export interface OpenAITransport {
  create(body: OpenAIRequestBody & { stream?: boolean }): Promise<unknown>;
}

export interface OpenAIAdapterOptions {
  readonly credentials: ProviderCredentials;
  /** Overrides the id, for an OpenAI-compatible endpoint under another name. */
  readonly providerId?: string;
  readonly displayName?: string;
  readonly capabilities?: readonly (typeof OPENAI_CAPABILITIES)[number][];
  /** Injected so a test never depends on wall-clock time. */
  readonly now?: () => number;
  /** Test seam. Production omits it and the real SDK client is built. */
  readonly transport?: OpenAITransport;
}

function buildClient(credentials: ProviderCredentials): OpenAI {
  return new OpenAI({
    apiKey: credentials.apiKey,
    ...(credentials.baseUrl === undefined ? {} : { baseURL: credentials.baseUrl }),
    ...(credentials.timeoutMs === undefined ? {} : { timeout: credentials.timeoutMs }),
    // See the note in `config.ts`: the platform owns retries.
    maxRetries: SDK_MAX_RETRIES,
  });
}

/**
 * Build the adapter.
 *
 * Every call is wrapped in `throughProvider`, which is S2.2's normalization —
 * so a raw SDK error cannot leave this file whatever the vendor throws.
 */
export function createOpenAIProvider(options: OpenAIAdapterOptions): StreamingModelProvider {
  const providerId = options.providerId ?? OPENAI_PROVIDER_ID;
  const now = options.now ?? ((): number => Date.now());

  const transport: OpenAITransport =
    options.transport ??
    (() => {
      const client = buildClient(options.credentials);
      return {
        create: (body) =>
          client.chat.completions.create(
            body as unknown as Parameters<typeof client.chat.completions.create>[0],
          ) as Promise<unknown>,
      };
    })();

  const provider: StreamingModelProvider = {
    providerId,
    displayName: options.displayName ?? 'OpenAI',
    capabilities: options.capabilities ?? [...OPENAI_CAPABILITIES],

    // Provider-REPORTED, and reported without a probe: a health call that
    // itself contacted the vendor would bill for asking.
    health: (): Promise<ProviderHealth> =>
      Promise.resolve({
        status: 'healthy',
        reportedAt: new Date(now()).toISOString(),
        detail: null,
      }),

    execute: (request: AIRequest): Promise<AIResponse> =>
      throughProvider(providerId, async () => {
        const startedAt = now();
        const completion = (await transport.create(toOpenAIRequest(request))) as OpenAICompletion;
        return {
          ...fromOpenAICompletion(completion, {
            request,
            latencyMs: now() - startedAt,
          }),
          providerId,
        };
      }),

    async *stream(request: AIRequest): AsyncIterable<StreamChunk> {
      const startedAt = now();
      const frames = (await throughProvider(providerId, () =>
        transport.create({ ...toOpenAIRequest(request), stream: true }),
      )) as AsyncIterable<OpenAIStreamFrame>;

      let sequence = 0;
      try {
        for await (const frame of frames) {
          yield toStreamChunk(frame, sequence, now() - startedAt);
          sequence += 1;
        }
      } catch (error: unknown) {
        // A mid-stream vendor failure is a typed error like any other. The
        // partial content is the caller's to discard — S2.7 refuses to
        // assemble it.
        throw error instanceof ProviderError
          ? error
          : new ProviderError(
              'Unavailable',
              providerId,
              `[${providerId}] the stream failed after ${String(sequence)} chunks: ${error instanceof Error ? error.message : String(error)}`,
              { cause: error },
            );
      }
    },
  };

  return provider;
}

export const OPENROUTER_PROVIDER_ID = 'openrouter';
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

/**
 * OpenRouter, which speaks OpenAI's protocol.
 *
 * A base URL and an id, not a fourth adapter: a second copy of the same
 * mapping would be a second place for a finish-reason bug to live, and the
 * only thing that actually differs is where the request goes.
 */
export function createOpenRouterProvider(
  options: Omit<OpenAIAdapterOptions, 'providerId' | 'displayName'>,
): StreamingModelProvider {
  return createOpenAIProvider({
    ...options,
    providerId: OPENROUTER_PROVIDER_ID,
    displayName: 'OpenRouter',
    credentials: {
      ...options.credentials,
      baseUrl: options.credentials.baseUrl ?? OPENROUTER_BASE_URL,
    },
  });
}
