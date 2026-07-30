/**
 * The provider error taxonomy — FROZEN.
 *
 * Spec: `08-ai-platform/provider-adapters.md` §"Error taxonomy". Every provider
 * failure maps to exactly one of these, and the mapping is the adapter's
 * responsibility. **A raw provider error escaping an adapter is a defect** —
 * it means a caller is branching on a vendor's error shape, which is the
 * dependency this port exists to remove.
 *
 * ── Naming ──────────────────────────────────────────────────────────────────
 * The spec prefixes every member with `Provider` (`ProviderRateLimited`). The
 * type is already `ProviderError`, so the prefix is dropped here and nothing
 * else changes. The mapping is exact:
 *
 *   Authentication    ← ProviderAuthFailed
 *   RateLimit         ← ProviderRateLimited
 *   Unavailable       ← ProviderUnavailable
 *   Timeout           ← ProviderTimeout
 *   Validation        ← ProviderBadRequest
 *   ContentFiltered   ← ProviderContentFiltered
 *   ContextTooLarge   ← ProviderContextTooLarge
 *   ModelUnavailable  ← ProviderModelUnavailable
 *   MalformedResponse ← ProviderMalformedResponse
 *   Internal          — added: see below
 *
 * `Internal` is not in the spec's table and is required anyway. Normalization
 * must be TOTAL: if some failure has no code, an adapter has to either invent
 * one or rethrow the vendor's error, and rethrowing is the exact defect the
 * taxonomy forbids. `Internal` is where "we do not recognise this" goes, and
 * its rate is a signal that the mapping needs another case.
 */

export const PROVIDER_ERROR_CODES = [
  'Authentication',
  'RateLimit',
  'Unavailable',
  'Timeout',
  'Validation',
  'ContentFiltered',
  'ContextTooLarge',
  'ModelUnavailable',
  'MalformedResponse',
  'Internal',
] as const;

export type ProviderErrorCode = (typeof PROVIDER_ERROR_CODES)[number];

export function isProviderErrorCode(value: unknown): value is ProviderErrorCode {
  return typeof value === 'string' && (PROVIDER_ERROR_CODES as readonly string[]).includes(value);
}

/**
 * Which failures another attempt could plausibly survive
 * (provider-adapters.md §"Error taxonomy", the Retryable column).
 *
 * A CLASSIFICATION, not a policy. Nothing here retries anything: how many
 * attempts, how long to wait, and when to give up belong to
 * `retry-strategy.md`, which is not in this increment. This is the fact a
 * retry engine will read; it is not the engine.
 *
 * `Validation` is deliberately absent — a malformed request is our defect, and
 * sending it again, to anyone, wastes money and hides the bug.
 */
export const RETRYABLE_PROVIDER_ERROR_CODES: readonly ProviderErrorCode[] = [
  'RateLimit',
  'Unavailable',
  'Timeout',
  'MalformedResponse',
];

export function isRetryableProviderErrorCode(code: ProviderErrorCode): boolean {
  return RETRYABLE_PROVIDER_ERROR_CODES.includes(code);
}

export interface ProviderErrorOptions {
  /** The vendor's own error, retained for diagnostics. Never re-thrown. */
  readonly cause?: unknown;
  /**
   * From the provider's `Retry-After`, where it gave one.
   *
   * Reported, never enforced here — an adapter reports limits, it does not
   * apply platform policy (provider-adapters.md §Non-responsibilities).
   */
  readonly retryAfterMs?: number;
}

/**
 * The one error type that crosses the provider boundary.
 *
 * A class rather than a discriminated union because callers catch it, and
 * `instanceof` requires exactly one definition — which is also why it lives in
 * `@contentos/contracts` beside the request and response it accompanies.
 */
export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly providerId: string;
  readonly retryable: boolean;
  readonly retryAfterMs: number | null;

  constructor(
    code: ProviderErrorCode,
    providerId: string,
    message: string,
    options: ProviderErrorOptions = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ProviderError';
    this.code = code;
    this.providerId = providerId;
    this.retryable = isRetryableProviderErrorCode(code);
    this.retryAfterMs = options.retryAfterMs ?? null;
  }
}

export function isProviderError(value: unknown): value is ProviderError {
  return value instanceof ProviderError;
}
