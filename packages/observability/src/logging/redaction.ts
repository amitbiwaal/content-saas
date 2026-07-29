/**
 * Redaction — `07-development-guide/logging-guide.md` §"Redaction".
 *
 * Three layers, because any one can be bypassed:
 *   1. TYPE       — `SecretValue.toString()` and `.toJSON()` return '[REDACTED]'
 *   2. SERIALIZER — allowlisted field projection
 *   3. PIPELINE   — pattern scan for credential shapes, as a backstop
 *
 * Redaction is by **allowlisted output, never by blocklisted input**. A
 * blocklist fails on the first field nobody thought of: a list containing
 * `password` and `apiKey` misses `apiToken` and `authorization` the day someone
 * adds them.
 */

/**
 * Layer 1 — the strongest and cheapest control.
 *
 * Template interpolation and `JSON.stringify` are how secrets actually reach
 * logs — not through anyone deciding to log one — and both call these methods
 * (`16-security/secrets-management.md`).
 */
export class SecretValue {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  /** The ONLY way to obtain the plaintext. Deliberately verbose. */
  revealForUseOnly(): string {
    return this.#value;
  }

  toString(): string {
    return '[REDACTED]';
  }

  toJSON(): string {
    return '[REDACTED]';
  }

  get [Symbol.toStringTag](): string {
    return 'SecretValue';
  }
}

/**
 * Layer 3 — credential-shaped patterns. This firing is itself the alert: it
 * means layers 1 and 2 did not catch something.
 *
 * `redaction_pattern_hits_total` should be zero, and is paged on
 * (logging-guide.md §Observability).
 */
const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}/i,
  /\bBasic\s+[A-Za-z0-9+/=]{16,}/i,
  /\bsk-[A-Za-z0-9]{16,}/,
  /\bghp_[A-Za-z0-9]{20,}/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, // JWT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /[?&](X-Amz-Signature|Signature|token|sig)=[A-Za-z0-9%._-]{8,}/i, // presigned URLs
];

export const REDACTED = '[REDACTED]';

export interface ScanResult {
  readonly value: string;
  readonly hits: number;
}

/** Scan and redact. Returns the hit count so the caller can emit the metric. */
export function scanForCredentials(value: string): ScanResult {
  let out = value;
  let hits = 0;
  for (const pattern of CREDENTIAL_PATTERNS) {
    out = out.replace(
      new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`),
      () => {
        hits += 1;
        return REDACTED;
      },
    );
  }
  return { value: out, hits };
}
