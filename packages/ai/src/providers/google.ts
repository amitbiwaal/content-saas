/**
 * The Google Gemini adapter.
 *
 * Spec: `08-ai-platform/provider-adapters.md`.
 *
 * ── Where this genuinely differs ────────────────────────────────────────────
 * Gemini takes `contents`, not `messages`; the assistant role is called
 * `model`; system instruction is a separate top-level field; and the
 * generation parameters live under `generationConfig` with different names.
 * Its finish reasons are also the widest of the three — six distinct ways of
 * saying "blocked" that all map to `content_filter`.
 *
 * Absorbing that is the point. A caller writes the same request it would send
 * to any other provider.
 */

import { GoogleGenerativeAI } from '@google/generative-ai';

import {
  ProviderError,
  type AIRequest,
  type AIResponse,
  type FinishReason,
  type TokenUsage,
  type Usage,
} from '@contentos/contracts';

import type { StreamChunk } from '../streaming/chunk.js';
import { UNPRICED_COST, type ProviderCredentials } from './config.js';
import { throughProvider } from './normalize.js';
import type { ProviderHealth } from './provider.js';
import type { StreamingModelProvider } from './streaming-provider.js';

export const GOOGLE_PROVIDER_ID = 'google';

export const GOOGLE_CAPABILITIES = ['text', 'chat', 'vision', 'embedding'] as const;

export interface GoogleContent {
  readonly role: 'user' | 'model';
  readonly parts: readonly { readonly text: string }[];
}

export interface GoogleRequestBody {
  readonly model: string;
  /** The system message, lifted out — Gemini calls it an instruction. */
  readonly systemInstruction?: string;
  readonly contents: readonly GoogleContent[];
  readonly generationConfig: {
    readonly temperature: number;
    readonly maxOutputTokens: number;
    readonly topP?: number;
    readonly stopSequences?: readonly string[];
  };
}

/** Canonical request → Gemini request. */
export function toGoogleRequest(request: AIRequest): GoogleRequestBody {
  const systemInstruction = request.messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n\n');

  const contents: GoogleContent[] = request.messages
    .filter((message) => message.role !== 'system')
    .map((message) => ({
      // Gemini's word for the assistant is 'model'.
      role: message.role === 'assistant' ? ('model' as const) : ('user' as const),
      parts: [{ text: message.content }],
    }));

  if (contents.length === 0) {
    throw new ProviderError(
      'Validation',
      GOOGLE_PROVIDER_ID,
      `[${GOOGLE_PROVIDER_ID}] the request carries only system messages. Gemini needs at least one content turn.`,
    );
  }

  return {
    model: request.model,
    ...(systemInstruction === '' ? {} : { systemInstruction }),
    contents,
    generationConfig: {
      temperature: request.params.temperature,
      maxOutputTokens: request.params.maxOutputTokens,
      ...(request.params.topP === undefined ? {} : { topP: request.params.topP }),
      ...(request.params.stopSequences === undefined
        ? {}
        : { stopSequences: [...request.params.stopSequences] }),
    },
  };
}

/**
 * Gemini finish reason → the fixed four.
 *
 * Six of its members mean "the model was stopped for a policy reason", and all
 * six map to `content_filter` — which is what makes `retry-strategy.md` Rule 2
 * apply to them: a safety stop is never retried automatically, whichever of the
 * six words the vendor used for it.
 */
export function toFinishReason(raw: string | null | undefined): FinishReason {
  switch (raw) {
    case 'STOP':
      return 'stop';
    case 'MAX_TOKENS':
      return 'length';
    case 'SAFETY':
    case 'RECITATION':
    case 'BLOCKLIST':
    case 'PROHIBITED_CONTENT':
    case 'SPII':
    case 'LANGUAGE':
      return 'content_filter';
    case 'MALFORMED_FUNCTION_CALL':
      return 'tool_call';
    default:
      // Covers OTHER and FINISH_REASON_UNSPECIFIED, which say only that the
      // model stopped for a reason the vendor did not name.
      throw new ProviderError(
        'MalformedResponse',
        GOOGLE_PROVIDER_ID,
        `[${GOOGLE_PROVIDER_ID}] finish reason '${String(raw)}' has no canonical equivalent. Reporting it as 'stop' would claim the model finished normally.`,
      );
  }
}

interface GoogleUsageMetadata {
  readonly promptTokenCount?: number;
  readonly candidatesTokenCount?: number;
  readonly totalTokenCount?: number;
  readonly cachedContentTokenCount?: number;
}

function toTokenUsage(raw: GoogleUsageMetadata | null | undefined): TokenUsage {
  const promptTokens = raw?.promptTokenCount ?? 0;
  const completionTokens = raw?.candidatesTokenCount ?? 0;
  return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens };
}

interface GoogleCandidate {
  readonly content?: { readonly parts?: readonly { readonly text?: string }[] };
  readonly finishReason?: string | null;
}

export interface GoogleResponse {
  readonly candidates?: readonly GoogleCandidate[];
  readonly usageMetadata?: GoogleUsageMetadata | null;
  readonly modelVersion?: string;
  readonly responseId?: string;
}

/** The text of a candidate: its parts, in order. */
function textOf(candidate: GoogleCandidate | undefined): string {
  return (candidate?.content?.parts ?? []).map((part) => part.text ?? '').join('');
}

interface MapResponseOptions {
  readonly request: AIRequest;
  readonly latencyMs: number;
  readonly estimated?: boolean;
}

/** Gemini response → the canonical response. */
export function fromGoogleResponse(
  response: GoogleResponse,
  options: MapResponseOptions,
): AIResponse {
  const candidate = response.candidates?.[0];
  if (candidate === undefined) {
    // Gemini returns no candidate when the PROMPT itself was blocked, which is
    // a refusal rather than an empty answer.
    throw new ProviderError(
      'ContentFiltered',
      GOOGLE_PROVIDER_ID,
      `[${GOOGLE_PROVIDER_ID}] the response carried no candidates, which is how Gemini reports a prompt it declined to answer.`,
    );
  }

  const usage: Usage = {
    tokens: toTokenUsage(response.usageMetadata),
    tokensEstimated: options.estimated ?? false,
    cost: UNPRICED_COST,
    latencyMs: options.latencyMs,
  };

  return {
    idempotencyKey: options.request.idempotencyKey,
    providerId: GOOGLE_PROVIDER_ID,
    model: response.modelVersion ?? options.request.model,
    content: textOf(candidate),
    finishReason: toFinishReason(candidate.finishReason),
    usage,
    providerMetadata: {
      ...(response.responseId === undefined ? {} : { requestId: response.responseId }),
      ...(response.usageMetadata?.cachedContentTokenCount === undefined
        ? {}
        : { cachedContentTokenCount: response.usageMetadata.cachedContentTokenCount }),
    },
  };
}

/**
 * One Gemini stream frame → one canonical chunk.
 *
 * Gemini repeats `usageMetadata` on every frame with running totals, and only
 * the frame carrying a finish reason is final — so the totals are taken from
 * that one rather than from the first frame that happened to have them.
 */
export function toStreamChunk(
  frame: GoogleResponse,
  sequence: number,
  latencyMs: number,
): StreamChunk {
  const candidate = frame.candidates?.[0];
  const rawFinish = candidate?.finishReason ?? null;
  const final = rawFinish !== null;

  return {
    sequence,
    content: textOf(candidate),
    finishReason: final ? toFinishReason(rawFinish) : null,
    usage: final
      ? {
          tokens: toTokenUsage(frame.usageMetadata),
          tokensEstimated: frame.usageMetadata === null || frame.usageMetadata === undefined,
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
 * An interface rather than the client type: Gemini's SDK offers no custom
 * `fetch`, so this is the seam that lets the adapter be tested without a key,
 * a network or a vendor. Production supplies the real client.
 */
export interface GoogleTransport {
  generate(body: GoogleRequestBody): Promise<GoogleResponse>;
  generateStream(body: GoogleRequestBody): Promise<AsyncIterable<GoogleResponse>>;
}

export interface GoogleAdapterOptions {
  readonly credentials: ProviderCredentials;
  readonly displayName?: string;
  readonly capabilities?: readonly (typeof GOOGLE_CAPABILITIES)[number][];
  readonly now?: () => number;
  /** Test seam. Production omits it and the real SDK client is built. */
  readonly transport?: GoogleTransport;
}

function sdkTransport(credentials: ProviderCredentials): GoogleTransport {
  const client = new GoogleGenerativeAI(credentials.apiKey);
  const requestOptions = {
    ...(credentials.baseUrl === undefined ? {} : { baseUrl: credentials.baseUrl }),
    ...(credentials.timeoutMs === undefined ? {} : { timeout: credentials.timeoutMs }),
  };

  // The SDK's request type wants mutable arrays; ours are readonly by design.
  // Copied at the boundary rather than loosening the contract inwards.
  const mutableConfig = (
    config: GoogleRequestBody['generationConfig'],
  ): Record<string, unknown> => ({
    temperature: config.temperature,
    maxOutputTokens: config.maxOutputTokens,
    ...(config.topP === undefined ? {} : { topP: config.topP }),
    ...(config.stopSequences === undefined ? {} : { stopSequences: [...config.stopSequences] }),
  });

  const modelFor = (body: GoogleRequestBody) =>
    client.getGenerativeModel(
      {
        model: body.model,
        ...(body.systemInstruction === undefined
          ? {}
          : { systemInstruction: body.systemInstruction }),
      },
      requestOptions,
    );

  return {
    generate: async (body) => {
      const result = await modelFor(body).generateContent({
        contents: body.contents as never,
        generationConfig: mutableConfig(body.generationConfig) as never,
      });
      return result.response as unknown as GoogleResponse;
    },
    generateStream: async (body) => {
      const result = await modelFor(body).generateContentStream({
        contents: body.contents as never,
        generationConfig: mutableConfig(body.generationConfig) as never,
      });
      return result.stream as unknown as AsyncIterable<GoogleResponse>;
    },
  };
}

export function createGoogleProvider(options: GoogleAdapterOptions): StreamingModelProvider {
  const now = options.now ?? ((): number => Date.now());
  const transport = options.transport ?? sdkTransport(options.credentials);

  return {
    providerId: GOOGLE_PROVIDER_ID,
    displayName: options.displayName ?? 'Google Gemini',
    capabilities: options.capabilities ?? [...GOOGLE_CAPABILITIES],

    health: (): Promise<ProviderHealth> =>
      Promise.resolve({
        status: 'healthy',
        reportedAt: new Date(now()).toISOString(),
        detail: null,
      }),

    execute: (request: AIRequest): Promise<AIResponse> =>
      throughProvider(GOOGLE_PROVIDER_ID, async () => {
        const startedAt = now();
        const response = await transport.generate(toGoogleRequest(request));
        return fromGoogleResponse(response, { request, latencyMs: now() - startedAt });
      }),

    async *stream(request: AIRequest): AsyncIterable<StreamChunk> {
      const startedAt = now();
      const frames = await throughProvider(GOOGLE_PROVIDER_ID, () =>
        transport.generateStream(toGoogleRequest(request)),
      );

      let sequence = 0;
      try {
        for await (const frame of frames) {
          yield toStreamChunk(frame, sequence, now() - startedAt);
          sequence += 1;
        }
      } catch (error: unknown) {
        throw error instanceof ProviderError
          ? error
          : new ProviderError(
              'Unavailable',
              GOOGLE_PROVIDER_ID,
              `[${GOOGLE_PROVIDER_ID}] the stream failed after ${String(sequence)} chunks: ${error instanceof Error ? error.message : String(error)}`,
              { cause: error },
            );
      }
    },
  };
}
