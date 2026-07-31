import { describe, expect, it } from 'vitest';

import {
  API_KEY_ENV_NAMES,
  API_KEY_PREFIX,
  ApiKeyConfigError,
  apiKeyPepperFromEnv,
  hashApiKeySecret,
  MIN_API_KEY_PEPPER_BYTES,
  MIN_API_KEY_SECRET_CHARS,
  parseApiKey,
  verifyApiKey,
  type ApiKeyRecord,
} from './api-key.js';

const PEPPER = 'p'.repeat(40); // gitleaks:allow — a test fixture, not a credential
const SECRET = 's'.repeat(MIN_API_KEY_SECRET_CHARS); // gitleaks:allow
const KEY = `${API_KEY_PREFIX}_key-1_${SECRET}`; // gitleaks:allow

const NOW = new Date('2026-07-31T12:00:00.000Z');
const now = (): Date => NOW;

const record = (overrides: Partial<ApiKeyRecord> = {}): ApiKeyRecord => ({
  keyId: 'key-1',
  secretHash: hashApiKeySecret(SECRET, PEPPER),
  subjectId: 'service-1',
  organizationId: 'org-1',
  workspaceId: 'ws-1',
  status: 'active',
  expiresAt: null,
  ...overrides,
});

const verify = (presented: string, stored: ApiKeyRecord = record()) => {
  const parsed = parseApiKey(presented);
  if (parsed === null) throw new Error('expected the key to parse');
  return verifyApiKey(parsed, stored, { pepper: PEPPER, now });
};

describe('parsing a presented key', () => {
  it('splits the public id from the secret', () => {
    expect(parseApiKey(KEY)).toEqual({ keyId: 'key-1', secret: SECRET });
  });

  it('refuses anything not of this shape', () => {
    for (const presented of [
      '',
      'key-1',
      `${API_KEY_PREFIX}_key-1`,
      `${API_KEY_PREFIX}__${SECRET}`,
      `other_key-1_${SECRET}`,
      `${API_KEY_PREFIX}_key-1_${SECRET}_extra`,
    ]) {
      expect(parseApiKey(presented), presented).toBeNull();
    }
  });

  it('refuses a secret too short to have come from a CSPRNG', () => {
    expect(
      parseApiKey(`${API_KEY_PREFIX}_key-1_${'s'.repeat(MIN_API_KEY_SECRET_CHARS - 1)}`),
    ).toBeNull();
  });

  it("keeps the 'cos' prefix, so a leaked key is recognisable to a scanner", () => {
    expect(API_KEY_PREFIX).toBe('cos');
    expect(parseApiKey(KEY)).not.toBeNull();
  });
});

describe('hashing', () => {
  it('is deterministic, so the same secret verifies against its stored form', () => {
    expect(hashApiKeySecret(SECRET, PEPPER)).toBe(hashApiKeySecret(SECRET, PEPPER));
  });

  it('depends on the pepper, so a dumped table is useless without it', () => {
    expect(hashApiKeySecret(SECRET, PEPPER)).not.toBe(hashApiKeySecret(SECRET, 'q'.repeat(40)));
  });

  it('never contains the secret', () => {
    expect(hashApiKeySecret(SECRET, PEPPER)).not.toContain(SECRET);
  });
});

describe('a valid key', () => {
  it('authenticates as the subject the record names', () => {
    expect(verify(KEY)).toEqual({
      outcome: 'authenticated',
      subject: {
        subjectId: 'service-1',
        kind: 'api-key',
        authenticatedAt: NOW,
        method: 'api-key',
        mfaSatisfied: false,
        sessionId: null,
      },
      organizationId: 'org-1',
      workspaceId: 'ws-1',
    });
  });

  it('never satisfies MFA, so a key cannot answer a step-up challenge', () => {
    const result = verify(KEY);
    expect(result.outcome === 'authenticated' && result.subject.mfaSatisfied).toBe(false);
  });

  it('carries the organization binding, and a null workspace when unbound', () => {
    expect(verify(KEY, record({ workspaceId: null }))).toMatchObject({
      organizationId: 'org-1',
      workspaceId: null,
    });
  });
});

describe('what a key cannot do', () => {
  it('refuses a wrong secret', () => {
    const wrong = `${API_KEY_PREFIX}_key-1_${'x'.repeat(MIN_API_KEY_SECRET_CHARS)}`;
    expect(verify(wrong)).toEqual({ outcome: 'failed', reason: 'invalid' });
  });

  it('refuses a secret from another key presented under this id', () => {
    expect(verify(KEY, record({ secretHash: hashApiKeySecret('other', PEPPER) }))).toEqual({
      outcome: 'failed',
      reason: 'invalid',
    });
  });

  it('refuses a record whose id does not match what was presented', () => {
    expect(verify(KEY, record({ keyId: 'key-2' }))).toEqual({
      outcome: 'failed',
      reason: 'invalid',
    });
  });

  it('reports a revoked key as revoked', () => {
    expect(verify(KEY, record({ status: 'revoked' }))).toEqual({
      outcome: 'failed',
      reason: 'revoked',
    });
  });

  it('reports an expired key as expired, evaluated at use', () => {
    expect(verify(KEY, record({ expiresAt: new Date(NOW.getTime() - 1) }))).toEqual({
      outcome: 'failed',
      reason: 'expired',
    });
    // Expiry is inclusive: a key expiring exactly now is already gone.
    expect(verify(KEY, record({ expiresAt: NOW }))).toEqual({
      outcome: 'failed',
      reason: 'expired',
    });
    expect(verify(KEY, record({ expiresAt: new Date(NOW.getTime() + 1) })).outcome).toBe(
      'authenticated',
    );
  });

  it('checks the secret BEFORE status, so revocation is not an oracle', () => {
    // A wrong secret against a revoked key must answer exactly as a wrong
    // secret against an active one. Otherwise an attacker learns which key ids
    // exist and which are revoked without ever holding a secret.
    const wrong = `${API_KEY_PREFIX}_key-1_${'x'.repeat(MIN_API_KEY_SECRET_CHARS)}`;
    expect(verify(wrong, record({ status: 'revoked' }))).toEqual(
      verify(wrong, record({ status: 'active' })),
    );
    expect(verify(wrong, record({ expiresAt: new Date(0) }))).toEqual(
      verify(wrong, record({ expiresAt: null })),
    );
  });
});

describe('the pepper', () => {
  const env = (value: string | undefined): NodeJS.ProcessEnv => ({
    [API_KEY_ENV_NAMES.pepper]: value,
  });

  it('comes from the environment', () => {
    expect(apiKeyPepperFromEnv(env(PEPPER))).toBe(PEPPER);
  });

  it('throws rather than defaulting', () => {
    expect(() => apiKeyPepperFromEnv(env(undefined))).toThrow(ApiKeyConfigError);
    expect(() => apiKeyPepperFromEnv(env('   '))).toThrow(ApiKeyConfigError);
  });

  it('refuses a pepper short enough to guess', () => {
    expect(() => apiKeyPepperFromEnv(env('x'.repeat(MIN_API_KEY_PEPPER_BYTES - 1)))).toThrow(
      /at least 32 bytes/,
    );
  });

  it('names the variable, so an operator can fix it', () => {
    expect(() => apiKeyPepperFromEnv(env(undefined))).toThrow(/API_KEY_PEPPER/);
  });
});
