/**
 * Failure normalization.
 *
 * Spec: `08-ai-platform/provider-adapters.md` §"Error taxonomy" —
 * "Every provider failure maps to exactly one, and the mapping is the adapter's
 * responsibility. A raw provider error escaping an adapter is a defect."
 *
 * This is what makes that achievable. An adapter wraps its call and hands
 * whatever came out to `normalizeProviderError`; the result is always a
 * `ProviderError` with a code from the fixed taxonomy.
 *
 * ── Total, by construction ──────────────────────────────────────────────────
 * This function never throws and never returns anything else. If it could fail
 * to classify, an adapter would have to choose between inventing a code and
 * rethrowing the vendor's error — and rethrowing is the defect. Unrecognised
 * failures become `Internal`, whose RATE is the signal that this mapping needs
 * another case. A silent fallback with no name would hide exactly that.
 *
 * ── What this does NOT do ───────────────────────────────────────────────────
 * It does not retry, wait, open a circuit, or advance to another provider. It
 * reads `Retry-After` and reports it; `retry-strategy.md` and
 * `rate-limiting.md` decide what to do with it.
 */

import { ProviderError, type ProviderErrorCode } from '@contentos/contracts';

/**
 * The shapes a vendor SDK failure actually arrives in.
 *
 * Every field is optional because this describes an unknown value, not a
 * contract — the whole point is that the vendor's shape is not ours.
 */
interface VendorFailure {
  readonly status?: unknown;
  readonly statusCode?: unknown;
  readonly code?: unknown;
  readonly name?: unknown;
  readonly message?: unknown;
  readonly headers?: unknown;
  readonly error?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

/** HTTP status, wherever the SDK decided to put it. */
function statusOf(failure: VendorFailure): number | null {
  for (const candidate of [failure.status, failure.statusCode]) {
    if (typeof candidate === 'number' && Number.isInteger(candidate)) return candidate;
    if (typeof candidate === 'string' && /^\d{3}$/.test(candidate)) return Number(candidate);
  }
  const nested = asRecord(failure.error);
  if (nested !== null) {
    const inner = nested['status'] ?? nested['statusCode'];
    if (typeof inner === 'number' && Number.isInteger(inner)) return inner;
  }
  return null;
}

function textOf(failure: VendorFailure): string {
  const parts: string[] = [];
  for (const candidate of [failure.name, failure.code, failure.message]) {
    if (typeof candidate === 'string') parts.push(candidate);
  }
  const nested = asRecord(failure.error);
  if (nested !== null) {
    for (const key of ['code', 'type', 'message']) {
      const value = nested[key];
      if (typeof value === 'string') parts.push(value);
    }
  }
  return parts.join(' ').toLowerCase();
}

/**
 * `Retry-After` in milliseconds.
 *
 * The header is seconds or an HTTP date. Reported, never enforced.
 */
function retryAfterMsOf(failure: VendorFailure, now: number): number | null {
  const headers = asRecord(failure.headers);
  const raw = headers?.['retry-after'] ?? headers?.['Retry-After'];
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) return Math.round(raw * 1000);
  if (typeof raw !== 'string') return null;

  if (/^\d+$/.test(raw)) return Number(raw) * 1000;

  const at = Date.parse(raw);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - now);
}

/** HTTP status → taxonomy. The statuses vendors actually return. */
function codeFromStatus(status: number): ProviderErrorCode | null {
  if (status === 401 || status === 403) return 'Authentication';
  if (status === 429) return 'RateLimit';
  if (status === 408 || status === 504) return 'Timeout';
  // A model that is gone is not a bad request — a larger-window or newer model
  // could serve it, and treating it as our defect would hide a retired model.
  if (status === 404) return 'ModelUnavailable';
  if (status === 413) return 'ContextTooLarge';
  if (status === 400 || status === 422) return 'Validation';
  if (status >= 500) return 'Unavailable';
  return null;
}

/** Message and error-name evidence, for failures that never had a status. */
function codeFromText(text: string): ProviderErrorCode | null {
  if (text === '') return null;
  // Order matters: a message can match more than one pattern, and the earlier
  // rows are the more specific reading.
  if (/aborted|abort_?error|timed?[ _-]?out|timeout|etimedout/.test(text)) return 'Timeout';
  if (/rate[ _-]?limit|too many requests|quota|429/.test(text)) return 'RateLimit';
  // `api[ _-]?key` bare, not `invalid api key`: vendors word this every way
  // there is — "Incorrect API key provided", "missing api_key", "API key not
  // valid" — and any of them means the credential, not the request.
  if (/unauthor|forbidden|api[ _-]?key|authentication|credential|permission denied/.test(text)) {
    return 'Authentication';
  }
  // `\brefus` and not `refus`: without the boundary, ECONNREFUSED reads as a
  // content refusal, and an unreachable vendor is reported as a safety block.
  if (/content[ _-]?filter|safety|policy violation|\brefus/.test(text)) return 'ContentFiltered';
  if (/context[ _-]?length|maximum context|too (many|long) tokens|prompt is too long/.test(text)) {
    return 'ContextTooLarge';
  }
  if (
    /model[ _-]?not[ _-]?found|unknown model|model.*(retired|deprecated|unavailable)/.test(text)
  ) {
    return 'ModelUnavailable';
  }
  if (
    /econnrefused|econnreset|enotfound|socket hang up|network|service unavailable|overloaded/.test(
      text,
    )
  ) {
    return 'Unavailable';
  }
  if (/unexpected token|json|unparse|malformed|invalid response/.test(text)) {
    return 'MalformedResponse';
  }
  if (/invalid[ _-]?request|bad request|validation/.test(text)) return 'Validation';
  return null;
}

/**
 * Map any failure to the taxonomy.
 *
 * A `ProviderError` passes through untouched — it has already been classified,
 * and re-classifying would let a specific code decay into a general one as it
 * moves up the stack.
 */
export function normalizeProviderError(
  providerId: string,
  cause: unknown,
  now: () => number = Date.now,
): ProviderError {
  if (cause instanceof ProviderError) return cause;

  const failure: VendorFailure = asRecord(cause) ?? {};
  const status = statusOf(failure);
  const text = textOf(failure);

  const code =
    (status === null ? null : codeFromStatus(status)) ??
    codeFromText(text) ??
    // Named rather than silent. `Internal` is "we do not recognise this", and
    // its rate is what tells us this mapping needs another case.
    'Internal';

  const message =
    typeof failure.message === 'string' && failure.message !== ''
      ? failure.message
      : typeof cause === 'string' && cause !== ''
        ? cause
        : 'The provider failed without a message.';

  const retryAfterMs = retryAfterMsOf(failure, now());

  return new ProviderError(
    code,
    providerId,
    `[${providerId}] ${message}`,
    retryAfterMs === null ? { cause } : { cause, retryAfterMs },
  );
}

/**
 * Run an adapter call so that only typed errors can come out.
 *
 * The one place an adapter needs to remember anything: wrap the vendor call in
 * this, and the "raw error escaped" defect becomes unrepresentable rather than
 * something each adapter has to get right.
 */
export async function throughProvider<T>(providerId: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error: unknown) {
    throw normalizeProviderError(providerId, error);
  }
}
