/**
 * The canonical chunk.
 *
 * Spec: `08-ai-platform/provider-adapters.md` §Streaming — an adapter
 * "normalizes each chunk to a ProviderChunk" and the "final chunk carries
 * usage — metered on completion". Every provider's stream is translated into
 * this shape; nothing above the adapter layer ever sees a vendor's frame.
 *
 * ── Sequences are 0-based and gapless ───────────────────────────────────────
 * The first chunk is 0. A cursor that has seen nothing carries `null` rather
 * than a number, because the alternative — 0 meaning both "the first chunk" and
 * "no chunks" — is the ambiguity that makes a resume restart or skip depending
 * on which reading the caller had.
 */

import type { FinishReason, Usage } from '@contentos/contracts';

export interface StreamChunk {
  /** 0-based, contiguous. Gaps and repeats are refused, not reordered. */
  readonly sequence: number;
  /** The text this chunk carries. May be empty on a final chunk. */
  readonly content: string;
  /**
   * Set on the FINAL chunk and null on every other.
   *
   * It is what ends the stream: there is no out-of-band completion, so a
   * response cannot be assembled before its last token arrived.
   */
  readonly finishReason: FinishReason | null;
  /**
   * Usage, on the final chunk.
   *
   * Not in the increment's field list and required anyway: the canonical
   * `AIResponse` cannot be built without it, and the increment requires
   * assembly to produce one. The spec puts it here — "final chunk carries
   * usage" — rather than on a separate completion call, so the numbers arrive
   * with the thing they describe.
   */
  readonly usage: Usage | null;
  /** Vendor frame detail. Opaque, never interpreted. */
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface ChunkIssue {
  readonly field: string;
  readonly code: string;
  readonly detail: string;
}

export type ChunkValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly issues: readonly ChunkIssue[] };

const FINISH_REASONS: readonly string[] = ['stop', 'length', 'content_filter', 'tool_call'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Check a chunk's shape. Reads an untrusted value behind the declared type,
 * for the same reason the other validators do: a chunk rebuilt from a frame is
 * exactly how a malformed one arrives.
 *
 * Every issue is reported rather than the first.
 */
export function validateChunk(chunk: StreamChunk): ChunkValidationResult {
  const issues: ChunkIssue[] = [];
  const add = (field: string, code: string, detail: string): void => {
    issues.push({ field, code, detail });
  };
  const raw = chunk as unknown as Record<string, unknown>;

  const sequence = raw['sequence'];
  if (!Number.isInteger(sequence) || (sequence as number) < 0) {
    add(
      'sequence',
      'BAD_SEQUENCE',
      `sequence must be a non-negative integer, got ${String(sequence)}; without it a chunk cannot be placed and the assembled text would depend on arrival order.`,
    );
  }

  if (typeof raw['content'] !== 'string') {
    add('content', 'NOT_STRING', 'content must be a string, empty if the chunk carries none.');
  }

  const finishReason = raw['finishReason'];
  if (finishReason !== null && !FINISH_REASONS.includes(finishReason as string)) {
    add(
      'finishReason',
      'BAD_FINISH_REASON',
      `${JSON.stringify(finishReason)} is outside the fixed set; every vendor reason maps to one of ${FINISH_REASONS.join(', ')}, and null on a non-final chunk.`,
    );
  }

  const usage = raw['usage'];
  if (usage !== null && !isRecord(usage)) {
    add('usage', 'BAD_USAGE', 'usage is the metered totals on the final chunk, or null.');
  }
  // A stream that ends without usage cannot be metered, and an unmetered call
  // is an unbilled one.
  if (finishReason !== null && FINISH_REASONS.includes(finishReason as string) && usage === null) {
    add(
      'usage',
      'MISSING_USAGE',
      'The final chunk carries the usage for the whole stream; without it the call cannot be metered.',
    );
  }
  // Usage describes the stream, not a fragment of it.
  if (finishReason === null && usage !== null) {
    add(
      'usage',
      'PREMATURE_USAGE',
      'Only the final chunk carries usage; totals on an intermediate chunk would describe a stream that has not finished.',
    );
  }

  if (!isRecord(raw['metadata'])) {
    add('metadata', 'NOT_OBJECT', 'metadata must be an object, empty if the vendor said nothing.');
  }

  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}

/** True when this chunk ends the stream. */
export function isFinalChunk(chunk: StreamChunk): boolean {
  return chunk.finishReason !== null;
}

/** A chunk, frozen, so what was accepted cannot be edited afterwards. */
export function freezeChunk(chunk: StreamChunk): StreamChunk {
  Object.freeze(chunk.metadata);
  if (chunk.usage !== null) {
    Object.freeze(chunk.usage);
    Object.freeze(chunk.usage.tokens);
    Object.freeze(chunk.usage.cost);
  }
  return Object.freeze(chunk);
}
