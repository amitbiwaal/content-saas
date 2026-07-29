/**
 * MFA framework — TOTP and recovery codes.
 *
 * FRAMEWORK ONLY: enrolment storage, challenge issuance, and the provider
 * binding live elsewhere. This module holds the pure, testable algorithms and
 * the policy decision.
 *
 * SMS IS NOT IMPLEMENTED AND NOT MODELLED. SIM-swap makes it a weaker factor
 * than the password it protects; `MfaFactorKind` has no `sms` member, so an
 * SMS factor is unrepresentable rather than merely discouraged.
 *
 * TOTP is RFC 6238 over the RFC 4226 HOTP construction, computed with
 * `node:crypto`'s HMAC. No cryptography is invented here.
 */

import {
  constantTimeEquals,
  hashSecret,
  hmacSha1,
  secureRandomInt,
  verifySecret,
} from '../crypto/primitives.js';

export type MfaFactorKind = 'totp' | 'recovery-code';

export interface MfaEnrolment {
  readonly kind: MfaFactorKind;
  readonly enrolledAt: Date;
}

export interface MfaState {
  readonly enrolled: boolean;
  readonly factors: readonly MfaEnrolment[];
}

// ── TOTP (RFC 6238) ──────────────────────────────────────────────────────────

export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** ±1 step tolerates clock skew without materially widening the window. */
export const TOTP_SKEW_STEPS = 1;

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * Total indexed access into a generator alphabet.
 *
 * `alphabet[i]` is `string | undefined` under `noUncheckedIndexedAccess`, and
 * `+=` on an undefined would silently append the literal text "undefined" to a
 * secret — producing a TOTP secret or recovery code that is wrong in a way no
 * test asserting only length or character class would catch.
 *
 * The index is in range by construction (`secureRandomInt(alphabet.length)`),
 * so the throw is unreachable. It exists so the impossible case is a loud
 * failure rather than a corrupted credential.
 */
function pickFrom(alphabet: string, index: number): string {
  const character = alphabet[index];
  if (character === undefined) {
    throw new Error(
      `Alphabet index ${String(index)} out of range for length ${String(alphabet.length)}.`,
    );
  }
  return character;
}

/** Base32 secret, per the otpauth convention every authenticator app expects. */
export function generateTotpSecret(bytes = 20): string {
  let out = '';
  for (let i = 0; i < Math.ceil((bytes * 8) / 5); i += 1) {
    out += pickFrom(BASE32, secureRandomInt(BASE32.length));
  }
  return out;
}

export function decodeBase32(secret: string): Buffer {
  const clean = secret.toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index === -1) throw new Error('Invalid base32 character in TOTP secret.');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  return Buffer.from(out);
}

/** HOTP (RFC 4226): dynamic truncation of HMAC-SHA1 over a big-endian counter. */
export function hotp(secret: Buffer, counter: number, digits = TOTP_DIGITS): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = hmacSha1(secret, message);

  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  const binary =
    (((digest[offset] ?? 0) & 0x7f) << 24) |
    (((digest[offset + 1] ?? 0) & 0xff) << 16) |
    (((digest[offset + 2] ?? 0) & 0xff) << 8) |
    ((digest[offset + 3] ?? 0) & 0xff);

  return (binary % 10 ** digits).toString().padStart(digits, '0');
}

export function totpAt(secretBase32: string, at: Date, digits = TOTP_DIGITS): string {
  const counter = Math.floor(at.getTime() / 1000 / TOTP_PERIOD_SECONDS);
  return hotp(decodeBase32(secretBase32), counter, digits);
}

/**
 * Verify a code within the skew window, in constant time.
 *
 * Every candidate step is evaluated even after a match, so verification time
 * does not reveal WHICH step matched — a signal that would leak the client's
 * clock offset.
 */
export function verifyTotp(
  secretBase32: string,
  code: string,
  at: Date,
  skewSteps = TOTP_SKEW_STEPS,
): boolean {
  const secret = decodeBase32(secretBase32);
  const current = Math.floor(at.getTime() / 1000 / TOTP_PERIOD_SECONDS);
  let matched = false;
  for (let step = -skewSteps; step <= skewSteps; step += 1) {
    if (constantTimeEquals(hotp(secret, current + step), code)) {
      matched = true;
    }
  }
  return matched;
}

/** `otpauth://` URI for enrolment. Contains the secret — never log it. */
export function totpEnrolmentUri(issuer: string, account: string, secret: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

// ── Recovery codes ───────────────────────────────────────────────────────────

export const RECOVERY_CODE_COUNT = 10;
const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I, O, 0, 1

/** Single-use codes, shown ONCE at generation and stored only as hashes. */
export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i += 1) {
    let code = '';
    for (let c = 0; c < 10; c += 1) {
      if (c === 5) code += '-';
      code += pickFrom(RECOVERY_ALPHABET, secureRandomInt(RECOVERY_ALPHABET.length));
    }
    codes.push(code);
  }
  return codes;
}

export function hashRecoveryCodes(codes: readonly string[]): Promise<string[]> {
  return Promise.all(codes.map((c) => hashSecret(normalizeRecoveryCode(c))));
}

function normalizeRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export interface RecoveryCodeResult {
  readonly accepted: boolean;
  /** Index of the consumed hash, so the caller can burn exactly that one. */
  readonly consumedIndex: number | null;
}

/**
 * Verify and identify which stored hash was consumed.
 *
 * Every hash is checked even after a match: returning early would make
 * verification time proportional to the matching index.
 */
export async function verifyRecoveryCode(
  code: string,
  storedHashes: readonly string[],
): Promise<RecoveryCodeResult> {
  const normalized = normalizeRecoveryCode(code);
  let consumedIndex: number | null = null;
  for (let i = 0; i < storedHashes.length; i += 1) {
    const hash = storedHashes[i];
    if (hash === undefined) continue;
    if (await verifySecret(normalized, hash)) {
      consumedIndex ??= i;
    }
  }
  return { accepted: consumedIndex !== null, consumedIndex };
}

// ── Policy ───────────────────────────────────────────────────────────────────

export type MfaRequirement = 'required' | 'optional';

export interface MfaPolicy {
  /** Organization-wide enforcement. */
  readonly enforced: boolean;
  /** Roles for which MFA is mandatory regardless of the org setting. */
  readonly requiredForRoles: readonly string[];
}

export interface MfaPolicyInput {
  readonly policy: MfaPolicy;
  readonly roles: readonly string[];
  readonly method: string;
}

/**
 * Deterministic. MFA is required when the organization enforces it, or when the
 * subject holds a role that mandates it.
 *
 * SSO methods are exempt because the identity provider performs the second
 * factor; requiring a second one here would double-prompt without adding
 * assurance.
 */
export function mfaRequirement(input: MfaPolicyInput): MfaRequirement {
  if (input.method === 'saml' || input.method === 'oidc') return 'optional';
  if (input.policy.enforced) return 'required';
  if (input.roles.some((r) => input.policy.requiredForRoles.includes(r))) return 'required';
  return 'optional';
}
