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
export const REDACTED = '[REDACTED]';

interface CredentialPattern {
  readonly pattern: RegExp;
  /**
   * Builds the replacement from the captured groups.
   *
   * Returning `null` DECLINES the match: the text is left exactly as it was and
   * no hit is counted. That is what makes the scan idempotent — see the URI
   * entry below.
   *
   * Omitted means "replace the whole match", which is right for an opaque
   * token: there is no part of a bearer token worth keeping.
   */
  readonly redact?: (groups: readonly string[]) => string | null;
}

/**
 * Credentials embedded in a connection URI.
 *
 * `scheme://user:password@host` is credential-shaped BY CONSTRUCTION — RFC 3986
 * §3.2.1 deprecates the form precisely because it leaks secrets — so any scheme
 * is matched rather than an enumerated list of the ten drivers in use today.
 * An enumerated list is the failure mode this module's own header warns about:
 * it misses the first scheme nobody thought of, and a `mssql://` or `ldap://`
 * URI leaks exactly as readily as a `postgres://` one.
 *
 * ONLY THE PASSWORD IS REPLACED. Scheme, user, host, port and path survive,
 * because "which database did this fail against, as which user" is the whole
 * diagnostic value of the message — and a wholesale `[REDACTED]` would destroy
 * it to hide one field.
 *
 * The user is `*` rather than `+` because `rediss://:token@host` — password
 * only, no username — is the CANONICAL Redis URI, not a malformed one. Requiring
 * a username there leaks the password of the one driver most likely to omit it.
 *
 * A host:port is not a credential: the trailing `@` is what distinguishes
 * `redis://:pw@host` from `redis://localhost:6379`, and excluding `/` and
 * whitespace from both fields stops the match running past the authority into a
 * path or the next word.
 */
const URI_CREDENTIALS = /([a-z][a-z0-9+.-]*):\/\/([^:@/\s]*):([^@/\s]+)@/gi;

const CREDENTIAL_PATTERNS: readonly CredentialPattern[] = [
  { pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}/i },
  { pattern: /\bBasic\s+[A-Za-z0-9+/=]{16,}/i },
  { pattern: /\bsk-[A-Za-z0-9]{16,}/ },
  { pattern: /\bghp_[A-Za-z0-9]{20,}/ },
  { pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ }, // JWT
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { pattern: /[?&](X-Amz-Signature|Signature|token|sig)=[A-Za-z0-9%._-]{8,}/i }, // presigned URLs
  {
    pattern: URI_CREDENTIALS,
    redact: (groups): string | null => {
      const [scheme, user, password] = groups;
      if (scheme === undefined || user === undefined || password === undefined) return null;
      // Already redacted — by a previous scan, or by an earlier pattern that
      // matched the password itself (a JWT or `sk-` key used as one). Declining
      // keeps re-scanning a sanitised message from inflating a counter that is
      // PAGED ON at any non-zero value.
      if (password === REDACTED) return null;
      return `${scheme}://${user}:${REDACTED}@`;
    },
  },
];

export interface ScanResult {
  readonly value: string;
  readonly hits: number;
}

/** Scan and redact. Returns the hit count so the caller can emit the metric. */
export function scanForCredentials(value: string): ScanResult {
  let out = value;
  let hits = 0;

  for (const { pattern, redact } of CREDENTIAL_PATTERNS) {
    const global = new RegExp(
      pattern.source,
      pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`,
    );

    out = out.replace(global, (match: string, ...rest: unknown[]): string => {
      // `replace` passes (match, ...captureGroups, offset, wholeString). The
      // last two are dropped by position rather than by type: the whole string
      // is itself a string, so filtering on `typeof` would smuggle it in as a
      // capture group.
      const groups = rest.slice(0, Math.max(0, rest.length - 2)) as readonly string[];
      const replacement = redact === undefined ? REDACTED : redact(groups);
      if (replacement === null) return match;
      hits += 1;
      return replacement;
    });
  }

  return { value: out, hits };
}
