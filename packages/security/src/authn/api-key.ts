/**
 * API key verification.
 *
 * ── The format carries its own lookup key ───────────────────────────────────
 *   cos_<keyId>_<secret>
 *
 * The `keyId` is public and indexed; the secret never is. Without a public id
 * the only way to find a record would be to hash the presented key and look
 * that up — which works, but forces the stored hash to be unsalted and rules
 * out ever changing the hashing scheme. Splitting them keeps the lookup O(1)
 * and the verification independent of it.
 *
 * The `cos_` prefix exists so a leaked key is RECOGNISABLE: secret scanners
 * match on prefixes, and a key that looks like any other random string is one
 * nobody can revoke until it is used.
 *
 * ── HMAC, not scrypt, and that is deliberate ────────────────────────────────
 * `hashSecret` stretches with scrypt because passwords are low-entropy and a
 * stolen hash must survive offline attack. An API key secret is 256 bits from
 * a CSPRNG: there is no dictionary to try, so stretching buys nothing — while
 * costing ~800 ms on EVERY authenticated request, which is a self-inflicted
 * denial of service. A keyed HMAC gives the one property that does matter: a
 * dumped table is useless without the pepper, which lives in the environment
 * rather than the database.
 */

import { constantTimeEquals, hmacSha256 } from '../crypto/primitives.js';
import type { AuthenticationFailure, AuthenticationResult } from './principal.js';

export const API_KEY_PREFIX = 'cos';

/** 256 bits, base64url — 43 characters. Shorter is refused, not stretched. */
export const MIN_API_KEY_SECRET_CHARS = 43;

export const API_KEY_STATUSES = ['active', 'revoked'] as const;

export type ApiKeyStatus = (typeof API_KEY_STATUSES)[number];

/**
 * A stored key.
 *
 * `secretHash` is the peppered HMAC of the secret half. The plaintext is shown
 * once at creation and never stored, which is what makes "we cannot recover
 * your key, only replace it" true rather than a policy.
 */
export interface ApiKeyRecord {
  readonly keyId: string;
  readonly secretHash: string;
  /** The identity this key acts as. */
  readonly subjectId: string;
  readonly organizationId: string;
  /** null = usable in any workspace of the organization the caller may reach. */
  readonly workspaceId: string | null;
  readonly status: ApiKeyStatus;
  /** null = no expiry. Evaluated at use, never by a sweep. */
  readonly expiresAt: Date | null;
}

export class ApiKeyConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiKeyConfigError';
  }
}

export const API_KEY_ENV_NAMES = { pepper: 'API_KEY_PEPPER' } as const;

export const MIN_API_KEY_PEPPER_BYTES = 32;

/**
 * The pepper, from the environment and only from the environment.
 *
 * Throws rather than defaulting, for the same reason the JWT secret does: a
 * built-in value is one anyone with this source can compute, and the deployment
 * that forgot to set it is exactly the one that would not notice.
 */
export function apiKeyPepperFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const pepper = env[API_KEY_ENV_NAMES.pepper];
  if (pepper === undefined || pepper.trim() === '') {
    throw new ApiKeyConfigError(
      `${API_KEY_ENV_NAMES.pepper} is required. Without it a dumped key table would be directly usable.`,
    );
  }
  if (Buffer.byteLength(pepper, 'utf8') < MIN_API_KEY_PEPPER_BYTES) {
    throw new ApiKeyConfigError(
      `${API_KEY_ENV_NAMES.pepper} must be at least ${String(MIN_API_KEY_PEPPER_BYTES)} bytes.`,
    );
  }
  return pepper;
}

export interface ParsedApiKey {
  readonly keyId: string;
  readonly secret: string;
}

/** Split a presented key. Null for anything not of this shape. */
export function parseApiKey(presented: string): ParsedApiKey | null {
  const parts = presented.split('_');
  const [prefix, keyId, secret] = parts;
  if (
    parts.length !== 3 ||
    prefix !== API_KEY_PREFIX ||
    keyId === undefined ||
    keyId === '' ||
    secret === undefined ||
    secret.length < MIN_API_KEY_SECRET_CHARS
  ) {
    return null;
  }
  return Object.freeze({ keyId, secret });
}

/** The stored form of a secret. The same function mints and verifies. */
export function hashApiKeySecret(secret: string, pepper: string): string {
  return hmacSha256(Buffer.from(pepper, 'utf8'), Buffer.from(secret, 'utf8')).toString('base64url');
}

const failed = (reason: AuthenticationFailure): AuthenticationResult =>
  Object.freeze({ outcome: 'failed' as const, reason });

export interface VerifyApiKeyOptions {
  readonly pepper: string;
  readonly now: () => Date;
}

/**
 * Verify a presented key against its record.
 *
 * The secret is checked BEFORE status and expiry. Reversing that would let an
 * attacker learn whether a key id exists, and whether it is revoked, without
 * ever holding the secret — a revoked key answering differently from an unknown
 * one is an oracle for guessing ids.
 */
export function verifyApiKey(
  parsed: ParsedApiKey,
  record: ApiKeyRecord,
  options: VerifyApiKeyOptions,
): AuthenticationResult {
  if (record.keyId !== parsed.keyId) return failed('invalid');
  if (!constantTimeEquals(hashApiKeySecret(parsed.secret, options.pepper), record.secretHash)) {
    return failed('invalid');
  }

  if (record.status === 'revoked') return failed('revoked');
  if (record.expiresAt !== null && options.now().getTime() >= record.expiresAt.getTime()) {
    return failed('expired');
  }

  return Object.freeze({
    outcome: 'authenticated' as const,
    subject: Object.freeze({
      subjectId: record.subjectId,
      kind: 'api-key' as const,
      authenticatedAt: options.now(),
      method: 'api-key' as const,
      // A key is a bearer credential with no second factor behind it. Claiming
      // otherwise would let a key satisfy a step-up challenge that exists
      // precisely to require a human.
      mfaSatisfied: false,
      sessionId: null,
    }),
    // The binding the key carries. Enforced as a restriction, never a grant.
    organizationId: record.organizationId,
    workspaceId: record.workspaceId,
  });
}
