/**
 * Cryptographic primitives.
 *
 * NEVER INVENT CRYPTOGRAPHY. Everything here delegates to `node:crypto`:
 * scrypt (RFC 7914) for secret hashing, HMAC-SHA1 for RFC 6238 TOTP,
 * `timingSafeEqual` for comparison, and the CSPRNG for all randomness.
 *
 * Spec: `16-security/secrets-management.md`, `16-security/encryption.md`.
 */

import {
  createHmac,
  randomBytes,
  randomInt,
  randomUUID,
  scrypt as scryptCb,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

// ── Secure random ────────────────────────────────────────────────────────────

/** UUID v4 from the CSPRNG. Identifiers that must not be guessable. */
export function secureId(): string {
  return randomUUID();
}

/**
 * Session ids are 256-bit random and opaque (`authentication.md` §Session).
 * base64url so the value is URL-safe without further encoding.
 */
export function secureToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Uniform random integer in [0, maxExclusive). Rejection-sampled by node. */
export function secureRandomInt(maxExclusive: number): number {
  return randomInt(maxExclusive);
}

// ── Constant-time comparison ─────────────────────────────────────────────────

/**
 * Compare two secrets without leaking their contents through timing.
 *
 * Length is compared first and returns early — that is unavoidable, since
 * `timingSafeEqual` throws on length mismatch, and the length of a token is not
 * the secret. The *contents* comparison is constant-time.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

// ── Secret hashing ───────────────────────────────────────────────────────────

/**
 * scrypt parameters. N=2^15 with r=8, p=1 is a deliberate interactive-login
 * cost. `maxmem` is raised because node's 32 MB default rejects N=2^15.
 */
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

/**
 * Hash a secret for storage. Format: `scrypt$N$r$p$salt$hash`, all base64url.
 *
 * The parameters are stored WITH the hash so they can be raised later without
 * invalidating existing hashes — a hash that does not record its own cost
 * cannot be upgraded.
 */
export async function hashSecret(secret: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const derived = await scrypt(secret, salt, KEY_LENGTH, SCRYPT);
  return [
    'scrypt',
    String(SCRYPT.N),
    String(SCRYPT.r),
    String(SCRYPT.p),
    salt.toString('base64url'),
    derived.toString('base64url'),
  ].join('$');
}

/** Verify a secret against a stored hash. Returns false on any malformation. */
export async function verifySecret(secret: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const [, nRaw, rRaw, pRaw, saltRaw, hashRaw] = parts;
  if (nRaw === undefined || rRaw === undefined || pRaw === undefined) return false;
  if (saltRaw === undefined || hashRaw === undefined) return false;

  const N = Number.parseInt(nRaw, 10);
  const r = Number.parseInt(rRaw, 10);
  const p = Number.parseInt(pRaw, 10);
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;

  const salt = Buffer.from(saltRaw, 'base64url');
  const expected = Buffer.from(hashRaw, 'base64url');
  if (salt.length === 0 || expected.length === 0) return false;

  let derived: Buffer;
  try {
    derived = await scrypt(secret, salt, expected.length, {
      N,
      r,
      p,
      maxmem: SCRYPT.maxmem,
    });
  } catch {
    return false;
  }
  return timingSafeEqual(derived, expected);
}

/**
 * True when a stored hash was produced with weaker parameters than current
 * policy, so the caller can re-hash on next successful login.
 */
export function needsRehash(stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return true;
  return Number.parseInt(parts[1] ?? '0', 10) < SCRYPT.N;
}

// ── HMAC ─────────────────────────────────────────────────────────────────────

/** HMAC-SHA1 over a counter — the RFC 4226/6238 primitive. */
export function hmacSha1(key: Buffer, message: Buffer): Buffer {
  return createHmac('sha1', key).update(message).digest();
}

/** HMAC-SHA256, for tamper-evidence chains and non-OTP uses. */
export function hmacSha256(key: Buffer, message: Buffer): Buffer {
  return createHmac('sha256', key).update(message).digest();
}
