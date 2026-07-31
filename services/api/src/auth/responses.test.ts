import { AUTHENTICATION_FAILURES, AUTHORIZATION_DENIALS } from '@contentos/security';
import { describe, expect, it } from 'vitest';

import { API_ERROR_MESSAGES, type ErrorBody } from '../ai/http.js';
import { forbiddenResponse, unauthenticatedResponse, WWW_AUTHENTICATE } from './responses.js';

describe('a 401', () => {
  it('is returned for every way authentication can fail', () => {
    for (const reason of AUTHENTICATION_FAILURES) {
      expect(unauthenticatedResponse(reason, 'req-1').status, reason).toBe(401);
    }
  });

  it('carries the canonical envelope with a message derived from the code', () => {
    const body = unauthenticatedResponse('expired', 'req-1').body as ErrorBody;
    expect(body).toEqual({
      error: {
        code: 'unauthenticated',
        message: API_ERROR_MESSAGES.unauthenticated,
        requestId: 'req-1',
      },
    });
  });

  it('carries a challenge, which RFC 7235 requires on every 401', () => {
    const response = unauthenticatedResponse('missing', 'req-1');
    expect(response.headers['www-authenticate']).toBe(WWW_AUTHENTICATE);
    expect(WWW_AUTHENTICATE).toContain('Bearer');
    expect(WWW_AUTHENTICATE).toContain('ApiKey');
  });

  it('says the same thing however the credential failed', () => {
    // A caller learns that the credential did not work and nothing about which
    // check refused it — the finer answer is an oracle for guessing.
    const bodies = AUTHENTICATION_FAILURES.map((reason) =>
      JSON.stringify(unauthenticatedResponse(reason, 'req-1').body),
    );
    expect(new Set(bodies).size).toBe(1);
  });
});

describe('a 403', () => {
  it('is returned for every way authorization can deny', () => {
    for (const reason of AUTHORIZATION_DENIALS) {
      expect(forbiddenResponse(reason, 'req-1').status, reason).toBe(403);
    }
  });

  it('carries the canonical envelope', () => {
    const body = forbiddenResponse('membership-required', 'req-1').body as ErrorBody;
    expect(body).toEqual({
      error: {
        code: 'forbidden',
        message: API_ERROR_MESSAGES.forbidden,
        requestId: 'req-1',
      },
    });
  });

  it('carries no challenge, because re-authenticating would not help', () => {
    expect(forbiddenResponse('insufficient-permission', 'req-1').headers).not.toHaveProperty(
      'www-authenticate',
    );
  });

  it('never names the reason, the tenant, or whether anything exists', () => {
    for (const reason of AUTHORIZATION_DENIALS) {
      const serialized = JSON.stringify(forbiddenResponse(reason, 'req-1').body);
      expect(serialized, reason).not.toContain(reason);
      expect(serialized, reason).not.toContain('workspace');
      expect(serialized, reason).not.toContain('organization');
    }
  });
});

describe('the two are distinguishable, and only in the way that helps', () => {
  it('differs in status and code, so a client knows what to do next', () => {
    const unauthenticated = unauthenticatedResponse('invalid', 'req-1');
    const forbidden = forbiddenResponse('insufficient-permission', 'req-1');

    expect(unauthenticated.status).toBe(401);
    expect(forbidden.status).toBe(403);
    expect((unauthenticated.body as ErrorBody).error.code).toBe('unauthenticated');
    expect((forbidden.body as ErrorBody).error.code).toBe('forbidden');
  });

  it('carries no details array on either, because there is no field to blame', () => {
    expect((unauthenticatedResponse('missing', 'r').body as ErrorBody).error).not.toHaveProperty(
      'details',
    );
    expect(
      (forbiddenResponse('subject-suspended', 'r').body as ErrorBody).error,
    ).not.toHaveProperty('details');
  });
});
