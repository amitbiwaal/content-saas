/**
 * The AI contracts — the vocabulary, the guards, and the one error type.
 *
 * These are the AI Capability's Open Host Service: one published interface
 * serving every context. What is asserted here is mostly that it has not
 * DRIFTED — a capability quietly added, a finish reason quietly renamed, or a
 * retryable classification quietly changed are all silent changes to what every
 * engine and every adapter agreed to.
 */
import { describe, expect, it } from 'vitest';

import { AI_CAPABILITIES, isAICapability } from './capability.js';
import {
  isProviderError,
  isProviderErrorCode,
  isRetryableProviderErrorCode,
  PROVIDER_ERROR_CODES,
  ProviderError,
  RETRYABLE_PROVIDER_ERROR_CODES,
} from './errors.js';
import { AI_REQUEST_FIELDS, AI_ROLES } from './request.js';
import { AI_RESPONSE_FIELDS, FINISH_REASONS, isFinishReason } from './response.js';

describe('the capability vocabulary', () => {
  // Written out independently of the module, so a change to either side shows.
  it('is exactly the six the increment names', () => {
    expect([...AI_CAPABILITIES]).toEqual(['text', 'chat', 'image', 'embedding', 'vision', 'audio']);
  });

  it('recognises them and nothing else', () => {
    for (const capability of AI_CAPABILITIES)
      expect(isAICapability(capability), capability).toBe(true);
    for (const other of ['TEXT', 'completion', 'video', '', null, 7, undefined]) {
      expect(isAICapability(other), String(other)).toBe(false);
    }
  });

  // Lowercase, as every other status vocabulary on this platform is. The
  // increment writes them in capitals; the vocabulary is the same six.
  it('is lowercase throughout', () => {
    for (const capability of AI_CAPABILITIES) {
      expect(capability, capability).toBe(capability.toLowerCase());
    }
  });
});

describe('the message roles', () => {
  it("are the platform's three, not a vendor's set", () => {
    expect([...AI_ROLES]).toEqual(['system', 'user', 'assistant']);
  });
});

describe('the finish reasons', () => {
  // Fixed by `provider-adapters.md`: every vendor reason maps to one of these.
  it('are the fixed set', () => {
    expect([...FINISH_REASONS]).toEqual(['stop', 'length', 'content_filter', 'tool_call']);
  });

  it('recognises them and nothing else', () => {
    for (const reason of FINISH_REASONS) expect(isFinishReason(reason), reason).toBe(true);
    for (const other of ['timeout', 'error', 'STOP', '', null]) {
      expect(isFinishReason(other), String(other)).toBe(false);
    }
  });
});

describe('the frozen field lists', () => {
  // The same discipline ENVELOPE_FIELDS applies: a field added without
  // updating this is a contract change nothing announced.
  it('names every request field', () => {
    expect([...AI_REQUEST_FIELDS]).toEqual([
      'taskType',
      'capability',
      'model',
      'messages',
      'params',
      'timeoutMs',
      'idempotencyKey',
      'correlationId',
      'tenantId',
      'organizationId',
    ]);
  });

  it('names every response field', () => {
    expect([...AI_RESPONSE_FIELDS]).toEqual([
      'idempotencyKey',
      'providerId',
      'model',
      'content',
      'finishReason',
      'usage',
      'providerMetadata',
    ]);
  });

  it('lists each field once', () => {
    expect(new Set(AI_REQUEST_FIELDS).size).toBe(AI_REQUEST_FIELDS.length);
    expect(new Set(AI_RESPONSE_FIELDS).size).toBe(AI_RESPONSE_FIELDS.length);
  });
});

describe('the error taxonomy', () => {
  it('is the ten codes', () => {
    expect([...PROVIDER_ERROR_CODES].sort()).toEqual([
      'Authentication',
      'ContentFiltered',
      'ContextTooLarge',
      'Internal',
      'MalformedResponse',
      'ModelUnavailable',
      'RateLimit',
      'Timeout',
      'Unavailable',
      'Validation',
    ]);
  });

  it('recognises a code and nothing else', () => {
    for (const code of PROVIDER_ERROR_CODES) expect(isProviderErrorCode(code), code).toBe(true);
    for (const other of ['ProviderRateLimited', 'rate_limit', '', null]) {
      expect(isProviderErrorCode(other), String(other)).toBe(false);
    }
  });

  it('marks the four another attempt could survive', () => {
    expect([...RETRYABLE_PROVIDER_ERROR_CODES].sort()).toEqual([
      'MalformedResponse',
      'RateLimit',
      'Timeout',
      'Unavailable',
    ]);
  });

  // Retrying our own malformed request, to anyone, wastes money and hides the
  // bug.
  it('does not mark our own defect retryable', () => {
    expect(isRetryableProviderErrorCode('Validation')).toBe(false);
    expect(isRetryableProviderErrorCode('Authentication')).toBe(false);
  });

  it('draws every retryable code from the taxonomy', () => {
    for (const code of RETRYABLE_PROVIDER_ERROR_CODES) {
      expect(PROVIDER_ERROR_CODES, code).toContain(code);
    }
  });
});

describe('ProviderError', () => {
  it('carries the code, the provider and the message', () => {
    const error = new ProviderError('RateLimit', 'openai', 'slow down');
    expect(error.code).toBe('RateLimit');
    expect(error.providerId).toBe('openai');
    expect(error.message).toBe('slow down');
    expect(error.name).toBe('ProviderError');
  });

  it('is an Error, so it survives a throw and a stack trace', () => {
    expect(new ProviderError('Timeout', 'x', 'y')).toBeInstanceOf(Error);
    expect(new ProviderError('Timeout', 'x', 'y').stack).toBeDefined();
  });

  // Callers catch it, so `instanceof` has to work across every package.
  it('is recognisable by its guard', () => {
    expect(isProviderError(new ProviderError('Internal', 'x', 'y'))).toBe(true);
    for (const other of [new Error('plain'), { code: 'Timeout' }, null, 'Timeout']) {
      expect(isProviderError(other)).toBe(false);
    }
  });

  it('derives retryability from the taxonomy rather than the caller', () => {
    expect(new ProviderError('Unavailable', 'x', 'y').retryable).toBe(true);
    expect(new ProviderError('ContentFiltered', 'x', 'y').retryable).toBe(false);
  });

  it('keeps the vendor error as its cause', () => {
    const cause = new Error('vendor detail');
    expect(new ProviderError('Internal', 'x', 'y', { cause }).cause).toBe(cause);
  });

  it('reports no wait when the provider gave none', () => {
    expect(new ProviderError('RateLimit', 'x', 'y').retryAfterMs).toBeNull();
  });

  it('carries a wait when the provider gave one', () => {
    expect(new ProviderError('RateLimit', 'x', 'y', { retryAfterMs: 30_000 }).retryAfterMs).toBe(
      30_000,
    );
  });
});
