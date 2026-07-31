/**
 * The pagination cursor.
 *
 * ── Keyset, not offset ─────────────────────────────────────────────────────
 * A cursor names a POSITION — the (createdAt, runId) of the last run on the
 * page just read — and the next page is everything strictly after it. An offset
 * names a COUNT, and a count is wrong the moment a run is written: page two of
 * an offset scan silently repeats a row when something lands above it, and
 * silently skips one when something is removed. History is a log that grows at
 * the top, so offsets would be wrong almost always.
 *
 * ── The order it pages through is total ────────────────────────────────────
 * `runId` is the tiebreak, so two runs created in the same millisecond still
 * have exactly one order and a cursor addresses exactly one position.
 *
 * ── A cursor belongs to ITS query ──────────────────────────────────────────
 * It carries a fingerprint of the filter and order that produced it. Reusing a
 * cursor against a different filter is refused, because the position it names
 * means nothing in another sequence — the page would be arbitrary, and it would
 * look correct.
 *
 * The fingerprint is an INTEGRITY check, not a security control. It is not
 * secret, not signed, and forging one grants nothing: the filter is always the
 * one the caller passed on this request, tenancy included, and a forged cursor
 * can only move the reader within a result set it was already entitled to. Use
 * it to catch a mistake, never to authorise anything.
 *
 * ── Opaque on the way out, validated on the way in ─────────────────────────
 * Callers receive a string and must not read it. Everything that comes back is
 * treated as untrusted input: wrong version, wrong shape, wrong fingerprint and
 * unparseable are four distinct refusals, and none of them guesses.
 */

/**
 * The version of the cursor FORMAT.
 *
 * Separate from the record schema version, and deliberately so: a cursor lives
 * for seconds and a record for years, and tying them together would invalidate
 * every open page whenever a stored field changed.
 */
export const CURSOR_VERSION = 1;

export interface RunHistoryCursor {
  readonly version: number;
  /** The run clock of the last run on the page just read. */
  readonly createdAt: string;
  /** Its id — the tiebreak that makes the position exact. */
  readonly runId: string;
  /** Of the filter and order that produced it. See the file header. */
  readonly fingerprint: string;
}

export const CURSOR_ERROR_CODES = ['InvalidCursor', 'IncompatibleCursor'] as const;

export type CursorErrorCode = (typeof CURSOR_ERROR_CODES)[number];

export type CursorDecoding =
  | { readonly outcome: 'decoded'; readonly cursor: RunHistoryCursor }
  | {
      readonly outcome: 'refused';
      readonly code: CursorErrorCode;
      /** For operators. Never handed back to a caller verbatim. */
      readonly reason: string;
    };

/**
 * ASCII Unit Separator, written as an escape so it is visible in source.
 *
 * A byte that cannot appear in an ISO timestamp, a hex fingerprint or a
 * decimal version, so the payload splits into exactly four parts however odd a
 * run id turns out to be. The whole payload is base64url-encoded on the way
 * out, so a non-printable separator costs nothing.
 */
const SEPARATOR = '';
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

/**
 * FNV-1a, 32 bits.
 *
 * Chosen because it is deterministic, dependency-free and short. NOT chosen for
 * collision resistance — see the header: this detects a caller reusing a cursor
 * across queries, and nothing here depends on it being hard to forge.
 */
export function fingerprint(canonical: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export function createCursor(input: {
  readonly createdAt: string;
  readonly runId: string;
  readonly canonical: string;
}): RunHistoryCursor {
  return Object.freeze({
    version: CURSOR_VERSION,
    createdAt: input.createdAt,
    runId: input.runId,
    fingerprint: fingerprint(input.canonical),
  });
}

/** Opaque, URL-safe, and stable for one (position, query) pair. */
export function encodeCursor(cursor: RunHistoryCursor): string {
  const payload = [String(cursor.version), cursor.createdAt, cursor.runId, cursor.fingerprint].join(
    SEPARATOR,
  );
  return Buffer.from(payload, 'utf8').toString('base64url');
}

const refuse = (code: CursorErrorCode, reason: string): CursorDecoding =>
  Object.freeze({ outcome: 'refused' as const, code, reason });

/**
 * Read a cursor a caller handed back.
 *
 * `canonical` is the query it arrived with. A cursor that does not belong to it
 * is refused rather than applied to a sequence it never described.
 */
export function decodeCursor(value: string, canonical: string): CursorDecoding {
  let payload: string;
  try {
    payload = Buffer.from(value, 'base64url').toString('utf8');
  } catch {
    return refuse('InvalidCursor', 'The cursor is not decodable.');
  }

  const parts = payload.split(SEPARATOR);
  if (parts.length !== 4) {
    return refuse('InvalidCursor', `The cursor has ${String(parts.length)} parts; it must have 4.`);
  }

  const [rawVersion, createdAt, runId, carried] = parts as [string, string, string, string];

  const version = Number(rawVersion);
  if (!Number.isInteger(version) || rawVersion.trim() === '') {
    return refuse('InvalidCursor', `'${rawVersion}' is not a cursor version.`);
  }
  if (version !== CURSOR_VERSION) {
    // Its own refusal, distinct from corruption: a cursor from another build is
    // well-formed and simply describes a sequence this one does not produce.
    return refuse(
      'IncompatibleCursor',
      `The cursor is format version ${String(version)}; this build issues ${String(CURSOR_VERSION)}. Start the listing again.`,
    );
  }

  if (!ISO.test(createdAt)) {
    return refuse('InvalidCursor', `'${createdAt}' is not an ISO timestamp.`);
  }
  if (runId.trim() === '') {
    return refuse('InvalidCursor', 'The cursor names no run.');
  }
  if (carried !== fingerprint(canonical)) {
    return refuse(
      'IncompatibleCursor',
      'The cursor was issued for a different filter or order. The position it names does not exist in this sequence.',
    );
  }

  return Object.freeze({
    outcome: 'decoded' as const,
    cursor: Object.freeze({ version, createdAt, runId, fingerprint: carried }),
  });
}
