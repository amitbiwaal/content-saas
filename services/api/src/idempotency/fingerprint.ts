/**
 * The request fingerprint.
 *
 * ── What it answers ─────────────────────────────────────────────────────────
 * "Is this the same request as the one that used this key before?" A retry
 * after a network timeout must be recognised as the same; a client bug that
 * reuses a key for different work must be recognised as different. Everything
 * in the canonical form serves one of those two.
 *
 * ── What it deliberately excludes, and why ──────────────────────────────────
 * The request id, the correlation id and any timestamp CHANGE ON EVERY RETRY.
 * Including one would make every retry look like a different request, which
 * turns idempotency into a mechanism that never fires — the failure mode that
 * looks like it works, because the happy path is unaffected and only the
 * duplicate-charge case is broken.
 *
 * They cannot be excluded by filtering here, because after S3.3 they are not in
 * the body at all: the correlation id comes from the middleware and the request
 * id from the edge. The exclusion is therefore structural, and asserted.
 *
 * ── Why the principal is in it ──────────────────────────────────────────────
 * Two tenants may pick the same key — clients generate UUIDs, and a key is not
 * a secret. Without the principal, one tenant's retry could return another
 * tenant's stored response, which is a cross-tenant disclosure dressed as a
 * cache hit. The organization and workspace are in it for the same reason at
 * the next level down, and because `api-principles.md` scopes idempotency "per
 * tenant, per endpoint".
 *
 * ── Determinism ─────────────────────────────────────────────────────────────
 * Object keys are emitted in sorted order at every depth, so two structurally
 * equal bodies that a client serialized differently produce one fingerprint.
 * `JSON.stringify` alone would not: it preserves insertion order, and a client
 * rebuilding a request from a map can reorder it between attempts.
 */

import { createHash } from 'node:crypto';

import type { Principal } from '@contentos/security';

/**
 * Canonical JSON: sorted keys, no insignificant whitespace.
 *
 * Arrays keep their order — that is data, not presentation. `undefined` and
 * functions are dropped exactly as `JSON.stringify` drops them, so the
 * fingerprint describes what would actually be sent.
 */
export function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;

  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`);
    return `{${entries.join(',')}}`;
  }

  // NaN and Infinity are not JSON, and `JSON.stringify` renders them as `null`
  // anyway — done explicitly so the fingerprint does not depend on that.
  if (typeof value === 'number' && !Number.isFinite(value)) return 'null';
  // Everything a serializer would drop rather than emit.
  if (typeof value === 'undefined' || typeof value === 'function') return 'null';
  if (typeof value === 'symbol' || typeof value === 'bigint') return 'null';
  return JSON.stringify(value);
}

export interface FingerprintInput {
  readonly principal: Principal;
  /** The ROUTE, not the URL — '/v1/ai/jobs/:id' rather than '/v1/ai/jobs/7'. */
  readonly endpoint: string;
  readonly method: string;
  readonly body: unknown;
}

/**
 * A hex SHA-256 of the canonical form.
 *
 * Hashed rather than stored whole because the value becomes part of a Redis
 * record that is compared on every retry, and a request body can be a quarter
 * of a megabyte. Never returned to a caller — `08 · Canonical errors` forbids
 * exposing internal fingerprints, and a client has no use for one.
 */
export function fingerprintOf(input: FingerprintInput): string {
  const canonical = canonicalize({
    subject: input.principal.subjectId,
    organization: input.principal.organizationId,
    workspace: input.principal.workspaceId,
    method: input.method.toUpperCase(),
    endpoint: input.endpoint,
    body: input.body ?? null,
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/** Fields a fingerprint must never depend on. Asserted in conformance. */
export const FINGERPRINT_EXCLUDED_FIELDS: readonly string[] = Object.freeze([
  'requestId',
  'correlationId',
  'timestamp',
  'occurredAt',
]);
