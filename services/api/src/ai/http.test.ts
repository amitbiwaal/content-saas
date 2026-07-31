import { describe, expect, it } from 'vitest';

import {
  API_ERROR_MESSAGES,
  errorFor,
  isStreamResponse,
  ok,
  requestIdOf,
  type ApiRequest,
  type ErrorBody,
} from './http.js';

const request = (overrides: Partial<ApiRequest> = {}): ApiRequest => ({
  method: 'POST',
  path: '/v1/ai/execute',
  params: {},
  query: {},
  headers: {},
  body: {},
  ...overrides,
});

describe('the canonical error envelope', () => {
  it('carries code, message and requestId, and nothing else', () => {
    const response = errorFor(403, 'forbidden', 'req-1');
    const body = response.body as ErrorBody;

    expect(Object.keys(body)).toEqual(['error']);
    expect(Object.keys(body.error)).toEqual(['code', 'message', 'requestId']);
    expect(body.error).toMatchObject({
      code: 'forbidden',
      message: API_ERROR_MESSAGES.forbidden,
      requestId: 'req-1',
    });
  });

  it('derives the message from the code, so no caller can supply one', () => {
    for (const [code, message] of Object.entries(API_ERROR_MESSAGES)) {
      const body = errorFor(400, code as keyof typeof API_ERROR_MESSAGES, 'req').body as ErrorBody;
      expect(body.error.message).toBe(message);
    }
  });

  it("omits 'details' entirely when there are no field errors", () => {
    const body = errorFor(400, 'invalid_request', 'req', []).body as ErrorBody;
    expect('details' in body.error).toBe(false);
  });

  it('carries field paths and codes in details, and never a value', () => {
    const body = errorFor(400, 'invalid_request', 'req', [
      { path: 'body.workspaceId', code: 'NOT_A_UUID' },
    ]).body as ErrorBody;

    expect(body.error.details).toEqual([{ path: 'body.workspaceId', code: 'NOT_A_UUID' }]);
    expect(Object.keys(body.error.details?.[0] ?? {})).toEqual(['path', 'code']);
  });

  it('freezes what it returns, so a later stage cannot edit a sent response', () => {
    const response = errorFor(404, 'not_found', 'req');
    expect(Object.isFrozen(response)).toBe(true);
    expect(Object.isFrozen(response.body)).toBe(true);
    expect(Object.isFrozen((response.body as ErrorBody).error)).toBe(true);
  });

  it('merges extra headers without losing the content type', () => {
    const response = errorFor(429, 'rate_limited', 'req', undefined, { 'retry-after': '30' });
    expect(response.headers).toEqual({ 'content-type': 'application/json', 'retry-after': '30' });
  });
});

describe('success responses', () => {
  it('returns 200 with a JSON content type', () => {
    expect(ok({ a: 1 })).toMatchObject({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: { a: 1 },
    });
  });

  it('distinguishes a streamed response from a buffered one', () => {
    expect(isStreamResponse(ok({}))).toBe(false);
    expect(
      isStreamResponse({
        status: 200,
        headers: {},
        lines: { async *[Symbol.asyncIterator]() {} },
      }),
    ).toBe(true);
  });
});

describe('the request id', () => {
  it('prefers the edge header', () => {
    expect(requestIdOf(request({ headers: { 'x-request-id': 'edge-1' } }))).toBe('edge-1');
  });

  it('falls back to the correlation header', () => {
    expect(requestIdOf(request({ headers: { 'x-correlation-id': 'corr-1' } }))).toBe('corr-1');
  });

  it("falls back to the body's correlation id", () => {
    expect(requestIdOf(request({ body: { correlationId: 'corr-2' } }))).toBe('corr-2');
  });

  it('trims, so a header with whitespace does not become a different id', () => {
    expect(requestIdOf(request({ headers: { 'x-request-id': '  edge-1  ' } }))).toBe('edge-1');
  });

  it("reports 'unknown' rather than inventing one", () => {
    // Generating an id here would be non-deterministic and would not match
    // anything in the logs, which is worse than admitting there is none.
    expect(requestIdOf(request({ body: null }))).toBe('unknown');
    expect(requestIdOf(request({ headers: { 'x-request-id': '   ' }, body: {} }))).toBe('unknown');
  });
});
