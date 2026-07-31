import { describe, expect, it } from 'vitest';

import { hmacSha256 } from '../crypto/primitives.js';
import {
  DEFAULT_CLOCK_SKEW_SECONDS,
  JWT_ALGORITHM,
  JWT_ENV_NAMES,
  JwtConfigError,
  jwtConfigFromEnv,
  MIN_JWT_SECRET_BYTES,
  verifyJwt,
  type JwtConfig,
} from './jwt.js';

const SECRET = 'a'.repeat(48); // gitleaks:allow — a test fixture, not a credential

const CONFIG: JwtConfig = {
  secret: SECRET,
  issuer: 'https://auth.contentos.test',
  audience: 'contentos-api',
};

const NOW = new Date('2026-07-31T12:00:00.000Z');
const now = (): Date => NOW;
const seconds = (date: Date): number => Math.floor(date.getTime() / 1000);

const encode = (value: unknown): string =>
  Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');

/** Mint a token the way the platform would. */
function sign(
  payload: Record<string, unknown>,
  options: { header?: Record<string, unknown>; secret?: string } = {},
): string {
  const header = options.header ?? { alg: JWT_ALGORITHM, typ: 'JWT' };
  const body = `${encode(header)}.${encode(payload)}`;
  const signature = hmacSha256(
    Buffer.from(options.secret ?? SECRET, 'utf8'),
    Buffer.from(body, 'utf8'),
  ).toString('base64url');
  return `${body}.${signature}`;
}

const validPayload = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  sub: 'user-1',
  iss: CONFIG.issuer,
  aud: CONFIG.audience,
  exp: seconds(NOW) + 3600,
  iat: seconds(NOW),
  ...overrides,
});

const verify = (token: string, config: JwtConfig = CONFIG) => verifyJwt(token, { config, now });

describe('a valid token', () => {
  it('authenticates and reports the subject it proves', () => {
    const result = verify(sign(validPayload({ sid: 'session-9', mfa: true })));

    expect(result).toEqual({
      outcome: 'authenticated',
      subject: {
        subjectId: 'user-1',
        kind: 'user',
        authenticatedAt: NOW,
        method: 'password',
        mfaSatisfied: true,
        sessionId: 'session-9',
      },
      organizationId: null,
      workspaceId: null,
    });
  });

  it('reports no session for a token that carries none', () => {
    const result = verify(sign(validPayload()));
    expect(result.outcome === 'authenticated' && result.subject.sessionId).toBeNull();
  });

  it('defaults MFA to unsatisfied rather than assuming it', () => {
    for (const mfa of [undefined, false, 'true', 1]) {
      const result = verify(sign(validPayload(mfa === undefined ? {} : { mfa })));
      expect(result.outcome === 'authenticated' && result.subject.mfaSatisfied).toBe(false);
    }
  });

  it('records how identity was proven when the token says', () => {
    const result = verify(sign(validPayload({ method: 'saml' })));
    expect(result.outcome === 'authenticated' && result.subject.method).toBe('saml');
  });

  it('ignores a method outside the vocabulary rather than recording it', () => {
    const result = verify(sign(validPayload({ method: 'vibes' })));
    expect(result.outcome === 'authenticated' && result.subject.method).toBe('password');
  });

  it('accepts an audience array, which the spec permits', () => {
    const result = verify(sign(validPayload({ aud: ['other-api', CONFIG.audience] })));
    expect(result.outcome).toBe('authenticated');
  });

  it('carries the scope a token restricts itself to', () => {
    const result = verify(sign(validPayload({ org: 'org-1', ws: 'ws-1' })));
    expect(result).toMatchObject({ organizationId: 'org-1', workspaceId: 'ws-1' });
  });
});

describe('what a token can never do', () => {
  it("refuses alg 'none', with or without a signature segment", () => {
    // The classic bypass, in both shapes it is attempted: an empty signature,
    // and a plausible-looking one that the verifier is invited to skip.
    const header = encode({ alg: 'none', typ: 'JWT' });
    const payload = encode(validPayload());

    expect(verify(`${header}.${payload}.`)).toEqual({ outcome: 'failed', reason: 'malformed' });
    expect(verify(`${header}.${payload}.anything`)).toEqual({
      outcome: 'failed',
      reason: 'invalid',
    });
  });

  it('refuses a token that names any other algorithm', () => {
    // Algorithm confusion: the header is compared to ours, never used to pick a
    // verifier, so a token cannot choose how it is checked.
    for (const alg of ['HS512', 'RS256', 'ES256', 'hs256', '']) {
      const token = sign(validPayload(), { header: { alg, typ: 'JWT' } });
      expect(verify(token), alg).toEqual({ outcome: 'failed', reason: 'invalid' });
    }
  });

  it('refuses a token signed with a different secret', () => {
    const token = sign(validPayload(), { secret: 'b'.repeat(48) }); // gitleaks:allow
    expect(verify(token)).toEqual({ outcome: 'failed', reason: 'invalid' });
  });

  it('refuses a token whose payload was edited after signing', () => {
    const original = sign(validPayload());
    const [header, , signature] = original.split('.');
    const tampered = `${header as string}.${encode(validPayload({ sub: 'admin' }))}.${signature as string}`;
    expect(verify(tampered)).toEqual({ outcome: 'failed', reason: 'invalid' });
  });

  it('grants nothing from a roles or permissions claim', () => {
    // The security property: a caller that could name its own roles would be
    // authorizing itself. The result carries neither, so there is nowhere for
    // such a claim to land.
    const result = verify(
      sign(validPayload({ roles: ['org_owner'], permissions: ['organization:delete'] })),
    );
    expect(result.outcome).toBe('authenticated');
    expect(JSON.stringify(result)).not.toContain('org_owner');
    expect(JSON.stringify(result)).not.toContain('organization:delete');
  });
});

describe('claim validation', () => {
  it('refuses a token from another issuer', () => {
    expect(verify(sign(validPayload({ iss: 'https://evil.test' })))).toEqual({
      outcome: 'failed',
      reason: 'invalid',
    });
  });

  it('refuses a token minted for another audience', () => {
    // A token for the admin API must not be replayable against this one.
    expect(verify(sign(validPayload({ aud: 'contentos-admin' })))).toEqual({
      outcome: 'failed',
      reason: 'invalid',
    });
    expect(verify(sign(validPayload({ aud: ['a', 'b'] })))).toEqual({
      outcome: 'failed',
      reason: 'invalid',
    });
  });

  it('refuses a token with no subject', () => {
    for (const sub of [undefined, '', '   ', 42, null]) {
      expect(verify(sign(validPayload(sub === undefined ? { sub: undefined } : { sub })))).toEqual({
        outcome: 'failed',
        reason: 'invalid',
      });
    }
  });

  it('refuses a token with no expiry rather than treating it as unlimited', () => {
    expect(verify(sign(validPayload({ exp: undefined })))).toEqual({
      outcome: 'failed',
      reason: 'invalid',
    });
    expect(verify(sign(validPayload({ exp: 'soon' })))).toEqual({
      outcome: 'failed',
      reason: 'invalid',
    });
  });

  it('reports an expired token as expired, not as invalid', () => {
    // A client can act on this one: refresh and retry. `invalid` would send it
    // to re-authenticate from scratch.
    expect(verify(sign(validPayload({ exp: seconds(NOW) - 3600 })))).toEqual({
      outcome: 'failed',
      reason: 'expired',
    });
  });

  it('tolerates clock drift on expiry, but only the stated amount', () => {
    const justInside = seconds(NOW) - DEFAULT_CLOCK_SKEW_SECONDS + 1;
    const justOutside = seconds(NOW) - DEFAULT_CLOCK_SKEW_SECONDS - 1;
    expect(verify(sign(validPayload({ exp: justInside }))).outcome).toBe('authenticated');
    expect(verify(sign(validPayload({ exp: justOutside })))).toEqual({
      outcome: 'failed',
      reason: 'expired',
    });
  });

  it('honours a configured skew of zero', () => {
    const strict = { ...CONFIG, clockSkewSeconds: 0 };
    expect(verify(sign(validPayload({ exp: seconds(NOW) - 1 })), strict)).toEqual({
      outcome: 'failed',
      reason: 'expired',
    });
  });

  it('refuses a token that is not yet valid, and says so', () => {
    expect(verify(sign(validPayload({ nbf: seconds(NOW) + 3600 })))).toEqual({
      outcome: 'failed',
      reason: 'not-yet-valid',
    });
  });

  it('accepts a not-before already passed, and refuses a malformed one', () => {
    expect(verify(sign(validPayload({ nbf: seconds(NOW) - 10 }))).outcome).toBe('authenticated');
    expect(verify(sign(validPayload({ nbf: 'later' })))).toEqual({
      outcome: 'failed',
      reason: 'invalid',
    });
  });
});

describe('malformed input', () => {
  it('refuses anything that is not three segments', () => {
    for (const token of ['', 'a', 'a.b', 'a.b.c.d', 'a.b.']) {
      expect(verify(token), token).toEqual({ outcome: 'failed', reason: 'malformed' });
    }
  });

  it('refuses a segment that is not JSON', () => {
    const token = `${Buffer.from('not json', 'utf8').toString('base64url')}.${encode(validPayload())}.sig`;
    expect(verify(token)).toEqual({ outcome: 'failed', reason: 'malformed' });
  });

  it('refuses a payload that is not an object', () => {
    expect(verify(sign([] as unknown as Record<string, unknown>))).toEqual({
      outcome: 'failed',
      reason: 'malformed',
    });
    expect(verify(sign('text' as unknown as Record<string, unknown>))).toEqual({
      outcome: 'failed',
      reason: 'malformed',
    });
  });
});

describe('configuration', () => {
  const env = (overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => ({
    [JWT_ENV_NAMES.secret]: SECRET,
    [JWT_ENV_NAMES.issuer]: CONFIG.issuer,
    [JWT_ENV_NAMES.audience]: CONFIG.audience,
    ...overrides,
  });

  it('reads secret, issuer and audience from the environment', () => {
    expect(jwtConfigFromEnv(env())).toEqual({
      secret: SECRET,
      issuer: CONFIG.issuer,
      audience: CONFIG.audience,
    });
  });

  it('throws rather than defaulting any of them', () => {
    // A built-in secret would accept tokens anyone with this source could mint,
    // silently, on exactly the deployment that forgot to set it.
    for (const name of Object.values(JWT_ENV_NAMES)) {
      expect(() => jwtConfigFromEnv(env({ [name]: undefined })), name).toThrow(JwtConfigError);
      expect(() => jwtConfigFromEnv(env({ [name]: '  ' })), name).toThrow(JwtConfigError);
    }
  });

  it('refuses a secret shorter than the hash it feeds', () => {
    expect(() =>
      jwtConfigFromEnv(env({ [JWT_ENV_NAMES.secret]: 'x'.repeat(MIN_JWT_SECRET_BYTES - 1) })),
    ).toThrow(/at least 32 bytes/);
  });

  it('names the variable in the error, so an operator can fix it', () => {
    expect(() => jwtConfigFromEnv(env({ [JWT_ENV_NAMES.issuer]: undefined }))).toThrow(
      /JWT_ISSUER/,
    );
  });

  it('trims the issuer and audience, so trailing whitespace is not a mismatch', () => {
    const config = jwtConfigFromEnv(
      env({ [JWT_ENV_NAMES.issuer]: ` ${CONFIG.issuer} `, [JWT_ENV_NAMES.audience]: ' x ' }),
    );
    expect(config).toMatchObject({ issuer: CONFIG.issuer, audience: 'x' });
  });
});
