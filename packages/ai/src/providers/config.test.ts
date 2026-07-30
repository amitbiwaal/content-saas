/**
 * Provider credentials and endpoints.
 *
 * `provider-adapters.md` §Security: credentials never leave the adapter layer,
 * are never logged and never returned. And provider endpoints are fixed
 * CONFIGURATION, never caller-supplied — there is no path from an `AIRequest`
 * to this surface, which is what the SSRF posture rests on.
 */
import { describe, expect, it } from 'vitest';

import {
  credentialEnvNames,
  credentialsFromEnv,
  ProviderConfigError,
  SDK_MAX_RETRIES,
  UNPRICED_COST,
} from './config.js';

const names = credentialEnvNames('OPENAI');

describe('the environment it reads', () => {
  it('names the variables a deployment can be checked against', () => {
    expect(names).toEqual({
      apiKey: ['OPENAI_API_KEY'],
      baseUrl: 'OPENAI_BASE_URL',
      timeoutMs: 'OPENAI_TIMEOUT_MS',
    });
  });

  it('derives the names from the provider prefix', () => {
    expect(credentialEnvNames('ANTHROPIC').apiKey).toEqual(['ANTHROPIC_API_KEY']);
    expect(credentialEnvNames('GOOGLE').baseUrl).toBe('GOOGLE_BASE_URL');
  });
});

describe('reading credentials', () => {
  it('reads the key', () => {
    const credentials = credentialsFromEnv(names, { OPENAI_API_KEY: 'sk-value' }); // gitleaks:allow
    expect(credentials.apiKey).toBe('sk-value');
  });

  it('trims surrounding whitespace, which a copied secret usually has', () => {
    const credentials = credentialsFromEnv(names, { OPENAI_API_KEY: '  sk-value  ' }); // gitleaks:allow
    expect(credentials.apiKey).toBe('sk-value');
  });

  // An adapter built without a key would send an empty Authorization header
  // and fail as a 401, which reads like a revoked key rather than a missing
  // one — a materially harder thing to diagnose.
  it('refuses to build without one', () => {
    for (const env of [{}, { OPENAI_API_KEY: '' }, { OPENAI_API_KEY: '   ' }]) {
      expect(() => credentialsFromEnv(names, env), JSON.stringify(env)).toThrow(
        ProviderConfigError,
      );
    }
  });

  it('names the variable to set, and never a value', () => {
    try {
      credentialsFromEnv(names, {});
      expect.unreachable('must refuse');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('OPENAI_API_KEY');
      expect(message).toContain('reads like a revoked key');
    }
  });

  it('accepts several accepted names for one credential', () => {
    const either = { ...names, apiKey: ['GOOGLE_API_KEY', 'GEMINI_API_KEY'] };
    expect(credentialsFromEnv(either, { GEMINI_API_KEY: 'v' }).apiKey).toBe('v');
    expect(credentialsFromEnv(either, { GOOGLE_API_KEY: 'first' }).apiKey).toBe('first');
  });
});

describe('the endpoint is configuration, never caller-supplied', () => {
  it('reads a base URL when one is configured', () => {
    const credentials = credentialsFromEnv(names, {
      OPENAI_API_KEY: 'k', // gitleaks:allow
      OPENAI_BASE_URL: 'https://proxy.internal/v1',
    });
    expect(credentials.baseUrl).toBe('https://proxy.internal/v1');
  });

  it('omits it entirely when none is set, so the vendor default applies', () => {
    const credentials = credentialsFromEnv(names, { OPENAI_API_KEY: 'k' }); // gitleaks:allow
    expect(credentials).not.toHaveProperty('baseUrl');
  });

  it('treats a blank base URL as unset rather than as an empty host', () => {
    const credentials = credentialsFromEnv(names, {
      OPENAI_API_KEY: 'k', // gitleaks:allow
      OPENAI_BASE_URL: '   ',
    });
    expect(credentials).not.toHaveProperty('baseUrl');
  });
});

describe('the timeout', () => {
  it('reads a configured ceiling', () => {
    const credentials = credentialsFromEnv(names, {
      OPENAI_API_KEY: 'k', // gitleaks:allow
      OPENAI_TIMEOUT_MS: '45000',
    });
    expect(credentials.timeoutMs).toBe(45_000);
  });

  it('refuses a value that is not a positive integer of milliseconds', () => {
    for (const value of ['0', '-1', 'soon', '1.5']) {
      expect(
        () =>
          credentialsFromEnv(names, {
            OPENAI_API_KEY: 'k', // gitleaks:allow
            OPENAI_TIMEOUT_MS: value,
          }),
        value,
      ).toThrow(/positive integer/);
    }
  });
});

describe('the two constants every adapter shares', () => {
  // provider-adapters.md domain rule 3: an adapter never retries on its own
  // schedule. An SDK retrying underneath S2.6 would multiply the attempts, the
  // spend and the rate-limit pressure invisibly.
  it("disables every SDK's own retries", () => {
    expect(SDK_MAX_RETRIES).toBe(0);
  });

  // Adapters report usage; the meter prices it. The zero is not a claim that
  // the call was free.
  it("reports an unpriced cost in the ledger's own format", () => {
    expect(UNPRICED_COST).toEqual({ currency: 'USD', amount: '0.000000' });
    expect(Object.isFrozen(UNPRICED_COST)).toBe(true);
  });
});
