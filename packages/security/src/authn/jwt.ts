/**
 * Bearer JWT verification.
 *
 * ── The algorithm is chosen by US, never by the token ───────────────────────
 * The header's `alg` is read only to CHECK it against an allowlist, never to
 * select a verifier. Letting a token pick its own algorithm is the oldest JWT
 * vulnerability there is: `alg: "none"` skips verification, and `alg: "HS256"`
 * on an RS256 deployment lets an attacker sign with the public key as the HMAC
 * secret. Both are unrepresentable here because the verifier is fixed before
 * the token is parsed and the header is only ever compared to it.
 *
 * ── HS256 only, deliberately ────────────────────────────────────────────────
 * These are FIRST-PARTY tokens: this platform mints them and this platform
 * verifies them, so there is no second party who needs a public key. OIDC, SSO
 * and federated issuers are out of scope for this increment, and they are what
 * asymmetric signing is for. Adding RS256 now would mean shipping key
 * distribution, rotation and JWKS fetching that nothing yet uses — and a JWKS
 * fetch is an outbound network call from the authentication path.
 *
 * ── Nothing is trusted from the payload except identity ─────────────────────
 * `sub` establishes who. `org` and `ws`, where present, RESTRICT where that
 * identity may act — they never grant. Roles and permissions in a payload are
 * ignored entirely: a caller that could name its own roles would be
 * authorizing itself. See `principal.ts`.
 */

import { constantTimeEquals, hmacSha256 } from '../crypto/primitives.js';
import { isAuthMethod, type AuthMethod } from './subject.js';
import type { AuthenticationFailure, AuthenticationResult } from './principal.js';

/** The only algorithm this verifier implements. See the file header. */
export const JWT_ALGORITHM = 'HS256';

/**
 * Tolerance for clock drift between the minting host and this one.
 *
 * Sixty seconds, applied to `exp` and `nbf` alike. Zero would make a token
 * mint-and-immediately-use fail on a host a second behind; a generous window
 * would extend the life of every revoked token by that much.
 */
export const DEFAULT_CLOCK_SKEW_SECONDS = 60;

export interface JwtConfig {
  /** From the environment. Never a literal, never a default. */
  readonly secret: string;
  readonly issuer: string;
  readonly audience: string;
  readonly clockSkewSeconds?: number;
}

/** The claims this platform reads. Anything else in a payload is ignored. */
export interface JwtClaims {
  readonly sub: string;
  readonly iss: string;
  readonly aud: string;
  readonly exp: number;
  readonly nbf?: number;
  readonly iat?: number;
  readonly jti?: string;
  /** Scope RESTRICTION, never a grant. */
  readonly org?: string;
  readonly ws?: string;
  /** Whether the session behind this token satisfied MFA. */
  readonly mfa?: boolean;
  readonly sid?: string;
  /** How identity was originally proven, for audit. Not an authority claim. */
  readonly method?: AuthMethod;
}

/**
 * How a token's holder originally proved identity, when the token does not say.
 *
 * `password` rather than a `jwt` member, because `AuthMethod` records the PROOF
 * and a bearer token is a carrier, not a proof — the login behind it is. Adding
 * a `jwt` member would let an audit trail record "authenticated by holding a
 * token", which answers nothing.
 */
export const DEFAULT_JWT_METHOD: AuthMethod = 'password';

export class JwtConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JwtConfigError';
  }
}

/** The environment variables this reads. Named once so tests and ops agree. */
export const JWT_ENV_NAMES = {
  secret: 'JWT_SECRET',
  issuer: 'JWT_ISSUER',
  audience: 'JWT_AUDIENCE',
} as const;

/**
 * Minimum secret length.
 *
 * HS256 keys shorter than the hash they feed add no security and are the usual
 * shape of a placeholder that reached production.
 */
export const MIN_JWT_SECRET_BYTES = 32;

/**
 * Configuration from the environment, and only from the environment.
 *
 * Throws rather than defaulting. A verifier that fell back to a built-in secret
 * would accept tokens anyone holding this source could mint, and it would do so
 * silently on exactly the deployment that forgot to set the variable.
 */
export function jwtConfigFromEnv(env: NodeJS.ProcessEnv = process.env): JwtConfig {
  const secret = env[JWT_ENV_NAMES.secret];
  const issuer = env[JWT_ENV_NAMES.issuer];
  const audience = env[JWT_ENV_NAMES.audience];

  for (const [name, value] of [
    [JWT_ENV_NAMES.secret, secret],
    [JWT_ENV_NAMES.issuer, issuer],
    [JWT_ENV_NAMES.audience, audience],
  ] as const) {
    if (value === undefined || value.trim() === '') {
      throw new JwtConfigError(
        `${name} is required. Token verification has no default: a built-in secret would accept tokens anyone with this source could mint.`,
      );
    }
  }

  if (Buffer.byteLength(secret as string, 'utf8') < MIN_JWT_SECRET_BYTES) {
    throw new JwtConfigError(
      `${JWT_ENV_NAMES.secret} must be at least ${String(MIN_JWT_SECRET_BYTES)} bytes; a shorter HS256 key adds no security over the hash it feeds.`,
    );
  }

  return Object.freeze({
    secret: secret as string,
    issuer: (issuer as string).trim(),
    audience: (audience as string).trim(),
  });
}

function decodeSegment(segment: string): unknown {
  // `base64url` is strict enough to reject a segment that is not one, but a
  // decoded segment that is not JSON still throws — both are 'malformed'.
  const json = Buffer.from(segment, 'base64url').toString('utf8');
  return JSON.parse(json);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const failed = (reason: AuthenticationFailure): AuthenticationResult =>
  Object.freeze({ outcome: 'failed' as const, reason });

/**
 * Audience match.
 *
 * `aud` may be a string or an array — the JWT spec allows both, and a verifier
 * that handled only the string form would reject a legitimate multi-audience
 * token, which tends to be discovered in production.
 */
function audienceMatches(claim: unknown, expected: string): boolean {
  if (typeof claim === 'string') return claim === expected;
  if (Array.isArray(claim)) return claim.some((entry) => entry === expected);
  return false;
}

export interface VerifyJwtOptions {
  readonly config: JwtConfig;
  /** Injected. A verifier that read the clock itself could not be tested. */
  readonly now: () => Date;
}

/**
 * Verify a token and return the identity it proves.
 *
 * Order matters: structure, then ALGORITHM, then signature, then claims.
 * Checking a claim before the signature would be reading attacker-controlled
 * data as though it meant something.
 */
export function verifyJwt(token: string, options: VerifyJwtOptions): AuthenticationResult {
  const { config } = options;
  const skewMs = (config.clockSkewSeconds ?? DEFAULT_CLOCK_SKEW_SECONDS) * 1000;

  const parts = token.split('.');
  const [encodedHeader, encodedPayload, signature] = parts;
  if (
    parts.length !== 3 ||
    encodedHeader === undefined ||
    encodedPayload === undefined ||
    signature === undefined ||
    signature === ''
  ) {
    return failed('malformed');
  }

  let header: unknown;
  let payload: unknown;
  try {
    header = decodeSegment(encodedHeader);
    payload = decodeSegment(encodedPayload);
  } catch {
    return failed('malformed');
  }
  if (!isRecord(header) || !isRecord(payload)) return failed('malformed');

  // ALGORITHM FIRST. `none` and every algorithm we do not implement are refused
  // before a single byte of the payload is believed.
  if (header['alg'] !== JWT_ALGORITHM) return failed('invalid');

  const expected = hmacSha256(
    Buffer.from(config.secret, 'utf8'),
    Buffer.from(`${encodedHeader}.${encodedPayload}`, 'utf8'),
  ).toString('base64url');
  if (!constantTimeEquals(signature, expected)) return failed('invalid');

  // ── Only now is the payload trustworthy ──────────────────────────────────
  const sub = payload['sub'];
  if (typeof sub !== 'string' || sub.trim() === '') return failed('invalid');
  if (payload['iss'] !== config.issuer) return failed('invalid');
  if (!audienceMatches(payload['aud'], config.audience)) return failed('invalid');

  const nowMs = options.now().getTime();

  const exp = payload['exp'];
  // A token without an expiry never expires, which is a permanent credential
  // issued by accident. Absent is refused, not treated as unlimited.
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return failed('invalid');
  if (nowMs >= exp * 1000 + skewMs) return failed('expired');

  const nbf = payload['nbf'];
  if (nbf !== undefined) {
    if (typeof nbf !== 'number' || !Number.isFinite(nbf)) return failed('invalid');
    if (nowMs < nbf * 1000 - skewMs) return failed('not-yet-valid');
  }

  const sid = payload['sid'];
  const org = payload['org'];
  const ws = payload['ws'];
  const method = payload['method'];

  return Object.freeze({
    outcome: 'authenticated' as const,
    subject: Object.freeze({
      subjectId: sub,
      kind: 'user' as const,
      authenticatedAt: new Date(nowMs),
      method: isAuthMethod(method) ? method : DEFAULT_JWT_METHOD,
      mfaSatisfied: payload['mfa'] === true,
      sessionId: typeof sid === 'string' && sid !== '' ? sid : null,
    }),
    // Restrictions the token itself carries. Checked against the resolved
    // workspace by the middleware; they never widen anything.
    organizationId: typeof org === 'string' && org !== '' ? org : null,
    workspaceId: typeof ws === 'string' && ws !== '' ? ws : null,
  });
}
