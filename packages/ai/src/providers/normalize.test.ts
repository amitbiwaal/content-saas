/**
 * Failure normalization.
 *
 * The load-bearing property is TOTALITY: whatever comes out of a vendor SDK,
 * a `ProviderError` comes out of here. If some failure had no code, an adapter
 * would have to choose between inventing one and rethrowing the vendor's
 * error — and a raw provider error escaping is the defect the taxonomy exists
 * to prevent.
 */
import { describe, expect, it } from 'vitest';

import { ProviderError, PROVIDER_ERROR_CODES, type ProviderErrorCode } from '@contentos/contracts';

import { normalizeProviderError, throughProvider } from './normalize.js';

const NOW = () => Date.parse('2026-07-30T12:00:00.000Z');

const codeOf = (cause: unknown): ProviderErrorCode =>
  normalizeProviderError('acme', cause, NOW).code;

describe('HTTP status maps to the taxonomy', () => {
  const CASES: [number, ProviderErrorCode][] = [
    [401, 'Authentication'],
    [403, 'Authentication'],
    [429, 'RateLimit'],
    [408, 'Timeout'],
    [504, 'Timeout'],
    [404, 'ModelUnavailable'],
    [413, 'ContextTooLarge'],
    [400, 'Validation'],
    [422, 'Validation'],
    [500, 'Unavailable'],
    [502, 'Unavailable'],
    [503, 'Unavailable'],
  ];

  for (const [status, code] of CASES) {
    it(`${String(status)} → ${code}`, () => {
      expect(codeOf({ status, message: 'x' })).toBe(code);
    });
  }

  it('reads the status from statusCode too, as several SDKs report it', () => {
    expect(codeOf({ statusCode: 429, message: 'slow down' })).toBe('RateLimit');
  });

  it('reads a status nested under error, as several SDKs wrap it', () => {
    expect(codeOf({ error: { status: 401, message: 'bad key' } })).toBe('Authentication');
  });

  it('reads a status given as a string', () => {
    expect(codeOf({ status: '503' })).toBe('Unavailable');
  });

  // A model that is gone is not our defect: a newer or larger-window model
  // could serve the same request, and calling it Validation would hide a
  // retired model behind "you sent something wrong".
  it('treats 404 as a missing model rather than a bad request', () => {
    expect(codeOf({ status: 404, message: 'model not found' })).toBe('ModelUnavailable');
  });
});

describe('a failure with no status is read from what it says', () => {
  const CASES: [string, ProviderErrorCode][] = [
    ['The operation was aborted', 'Timeout'],
    ['ETIMEDOUT', 'Timeout'],
    ['Rate limit reached for gpt-4o', 'RateLimit'],
    ['You exceeded your current quota', 'RateLimit'],
    ['Incorrect API key provided', 'Authentication'],
    ['permission denied', 'Authentication'],
    ['The response was blocked by our content filter', 'ContentFiltered'],
    ["This model's maximum context length is 8192 tokens", 'ContextTooLarge'],
    ['Unknown model: gpt-9', 'ModelUnavailable'],
    ['ECONNREFUSED', 'Unavailable'],
    ['socket hang up', 'Unavailable'],
    ['The engine is currently overloaded', 'Unavailable'],
    ['Unexpected token < in JSON at position 0', 'MalformedResponse'],
    ['Invalid request: messages must not be empty', 'Validation'],
  ];

  for (const [message, code] of CASES) {
    it(`"${message}" → ${code}`, () => {
      expect(codeOf({ message })).toBe(code);
    });
  }

  it('reads the error name, which is where AbortError lives', () => {
    expect(codeOf({ name: 'AbortError', message: 'aborted' })).toBe('Timeout');
  });

  it('reads a vendor code field', () => {
    expect(codeOf({ code: 'rate_limit_exceeded' })).toBe('RateLimit');
  });

  it('reads a code nested under error, as OpenAI-shaped payloads do', () => {
    expect(codeOf({ error: { type: 'invalid_request_error', message: 'bad' } })).toBe('Validation');
  });

  it('prefers the status when both are present', () => {
    // The message says rate limit; the status says the credential is wrong.
    // A status is a fact and a message is prose.
    expect(codeOf({ status: 401, message: 'rate limit exceeded' })).toBe('Authentication');
  });
});

describe('it is total — nothing escapes unclassified', () => {
  const ODDITIES: unknown[] = [
    undefined,
    null,
    '',
    'a bare string',
    0,
    42,
    true,
    [],
    [1, 2, 3],
    {},
    { status: 999 },
    { status: 'not-a-status' },
    { message: 42 },
    { message: null },
    new Error(''),
    new Error('something went wrong'),
    Symbol('odd'),
    () => 'a function',
    new Map(),
  ];

  for (const [i, cause] of ODDITIES.entries()) {
    it(`classifies oddity #${String(i)} without throwing`, () => {
      const error = normalizeProviderError('acme', cause, NOW);
      expect(error).toBeInstanceOf(ProviderError);
      expect(PROVIDER_ERROR_CODES).toContain(error.code);
    });
  }

  it('falls back to Internal, which is named rather than silent', () => {
    expect(codeOf({ message: 'something nobody has seen before' })).toBe('Internal');
    expect(codeOf(undefined)).toBe('Internal');
  });

  it('always names the provider', () => {
    expect(normalizeProviderError('openai', undefined, NOW).providerId).toBe('openai');
    expect(normalizeProviderError('openai', undefined, NOW).message).toContain('[openai]');
  });

  it('keeps the vendor error as the cause, for diagnostics', () => {
    const raw = new Error('vendor detail');
    expect(normalizeProviderError('acme', raw, NOW).cause).toBe(raw);
  });

  it('says so plainly when the failure carried no message', () => {
    expect(normalizeProviderError('acme', {}, NOW).message).toContain('without a message');
  });
});

describe('an already-classified error passes through', () => {
  // Re-classifying would let a specific code decay into a general one as the
  // error moves up the stack.
  it('returns the same instance', () => {
    const original = new ProviderError('ContentFiltered', 'acme', 'refused');
    expect(normalizeProviderError('acme', original, NOW)).toBe(original);
  });

  it('does not relabel it under a different provider id', () => {
    const original = new ProviderError('RateLimit', 'openai', 'slow down');
    expect(normalizeProviderError('anthropic', original, NOW).providerId).toBe('openai');
  });
});

describe('Retry-After is reported, never enforced', () => {
  it('reads a seconds value', () => {
    const error = normalizeProviderError(
      'acme',
      { status: 429, headers: { 'retry-after': '30' } },
      NOW,
    );
    expect(error.retryAfterMs).toBe(30_000);
  });

  it('reads a numeric header', () => {
    const error = normalizeProviderError(
      'acme',
      { status: 429, headers: { 'retry-after': 2 } },
      NOW,
    );
    expect(error.retryAfterMs).toBe(2000);
  });

  it('reads an HTTP date, relative to the clock it was given', () => {
    const error = normalizeProviderError(
      'acme',
      { status: 429, headers: { 'retry-after': 'Thu, 30 Jul 2026 12:00:45 GMT' } },
      NOW,
    );
    expect(error.retryAfterMs).toBe(45_000);
  });

  it('never reports a negative wait for a date already past', () => {
    const error = normalizeProviderError(
      'acme',
      { status: 429, headers: { 'retry-after': 'Thu, 30 Jul 2026 11:00:00 GMT' } },
      NOW,
    );
    expect(error.retryAfterMs).toBe(0);
  });

  it('is null when the provider gave none', () => {
    expect(normalizeProviderError('acme', { status: 429 }, NOW).retryAfterMs).toBeNull();
  });

  it('is null for an unparseable header rather than a guess', () => {
    const error = normalizeProviderError(
      'acme',
      { status: 429, headers: { 'retry-after': 'soon' } },
      NOW,
    );
    expect(error.retryAfterMs).toBeNull();
  });
});

describe('retryability is a classification, not a policy', () => {
  it('marks the four failures another attempt could survive', () => {
    for (const code of ['RateLimit', 'Unavailable', 'Timeout', 'MalformedResponse'] as const) {
      expect(new ProviderError(code, 'acme', 'x').retryable, code).toBe(true);
    }
  });

  // Sending our own malformed request again, to anyone, wastes money and hides
  // the bug.
  it('marks a Validation failure as ours, not theirs', () => {
    expect(new ProviderError('Validation', 'acme', 'x').retryable).toBe(false);
  });

  it('marks the rest unretryable', () => {
    for (const code of [
      'Authentication',
      'ContentFiltered',
      'ContextTooLarge',
      'ModelUnavailable',
      'Internal',
    ] as const) {
      expect(new ProviderError(code, 'acme', 'x').retryable, code).toBe(false);
    }
  });
});

describe('throughProvider is the wrapper an adapter uses', () => {
  it('returns the value when the call succeeds', async () => {
    await expect(throughProvider('acme', () => Promise.resolve('ok'))).resolves.toBe('ok');
  });

  // The defect becomes unrepresentable rather than something each adapter has
  // to remember to get right.
  it('turns a raw vendor rejection into a typed error', async () => {
    const raw = Object.assign(new Error('Rate limit reached'), { status: 429 });
    await expect(throughProvider('acme', () => Promise.reject(raw))).rejects.toBeInstanceOf(
      ProviderError,
    );
  });

  it('classifies what it caught', async () => {
    const raw = Object.assign(new Error('nope'), { status: 401 });
    try {
      await throughProvider('acme', () => Promise.reject(raw));
      expect.unreachable('must throw');
    } catch (error) {
      expect((error as ProviderError).code).toBe('Authentication');
    }
  });

  it('catches a synchronous throw too', async () => {
    await expect(
      throughProvider('acme', () => {
        throw new Error('ECONNREFUSED');
      }),
    ).rejects.toMatchObject({ code: 'Unavailable' });
  });
});
