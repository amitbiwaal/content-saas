/**
 * Canonical contract validation.
 *
 * These types hold inside the monorepo. They do not hold for a request rebuilt
 * from a job payload, replayed from an event, or handed over an admin API —
 * and a malformed request that reaches a vendor costs a customer money before
 * anything notices. What is asserted here is that a bad request fails FREE.
 */
import { describe, expect, it } from 'vitest';

import type { AIRequest, AIResponse } from '@contentos/contracts';

import {
  assertCapabilityDeclared,
  validateAIRequest,
  validateAIResponse,
  type AIValidationResult,
} from './validation.js';

const WS = '018f7a1e-0000-7000-8000-0000000000bb';
const ORG = '018f7a1e-0000-7000-8000-0000000000aa';
const CORRELATION = '018f7a1e-0000-7000-8000-0000000000dd';

function request(over: Partial<AIRequest> = {}): AIRequest {
  return {
    taskType: 'planning.outline',
    capability: 'chat',
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'Draft an outline.' }],
    params: { temperature: 0.2, maxOutputTokens: 1024 },
    timeoutMs: 30_000,
    idempotencyKey: 'run-1:step-3',
    correlationId: CORRELATION,
    tenantId: WS,
    organizationId: ORG,
    ...over,
  };
}

function response(over: Partial<AIResponse> = {}): AIResponse {
  return {
    idempotencyKey: 'run-1:step-3',
    providerId: 'acme',
    model: 'gpt-4o-2026-05-01',
    content: 'An outline.',
    finishReason: 'stop',
    usage: {
      tokens: { promptTokens: 120, completionTokens: 380, totalTokens: 500 },
      tokensEstimated: false,
      cost: { currency: 'USD', amount: '0.004250' },
      latencyMs: 1840,
    },
    providerMetadata: { requestId: 'req_abc' },
    ...over,
  };
}

const fieldsOf = (result: AIValidationResult): string[] =>
  result.ok ? [] : result.issues.map((i) => i.field);

describe('a well-formed request passes', () => {
  it('accepts the canonical shape', () => {
    expect(validateAIRequest(request())).toEqual({ ok: true });
  });

  it('accepts every optional parameter, and none of them', () => {
    expect(
      validateAIRequest(
        request({
          params: {
            temperature: 0,
            maxOutputTokens: 1,
            topP: 1,
            seed: 7,
            stopSequences: ['\n\n'],
          },
        }),
      ).ok,
    ).toBe(true);
    expect(
      validateAIRequest(request({ params: { temperature: 1, maxOutputTokens: 4096 } })).ok,
    ).toBe(true);
  });

  it('accepts every declared capability', () => {
    for (const capability of ['text', 'chat', 'image', 'embedding', 'vision', 'audio'] as const) {
      expect(validateAIRequest(request({ capability })).ok, capability).toBe(true);
    }
  });
});

describe('a malformed request is refused', () => {
  it('names a missing field', () => {
    const { taskType: _dropped, ...rest } = request();
    expect(fieldsOf(validateAIRequest(rest as AIRequest))).toContain('taskType');
  });

  it('requires dot.case for the task type', () => {
    for (const taskType of ['planning', 'Planning.Outline', 'planning outline', '']) {
      expect(fieldsOf(validateAIRequest(request({ taskType }))), taskType).toContain('taskType');
    }
  });

  it('refuses a capability nothing declares', () => {
    expect(fieldsOf(validateAIRequest(request({ capability: 'telepathy' as never })))).toContain(
      'capability',
    );
  });

  it('refuses a request that names no model', () => {
    expect(fieldsOf(validateAIRequest(request({ model: '  ' })))).toContain('model');
  });

  // A request with no messages has nothing to send, and a vendor would charge
  // for discovering that.
  it('refuses an empty message list', () => {
    expect(fieldsOf(validateAIRequest(request({ messages: [] })))).toContain('messages');
  });

  it('refuses a role that is not ours', () => {
    const messages = [{ role: 'tool' as never, content: 'x' }];
    expect(fieldsOf(validateAIRequest(request({ messages })))).toContain('messages[0].role');
  });

  it('refuses empty message content, naming which message', () => {
    const messages = [
      { role: 'user' as const, content: 'fine' },
      { role: 'user' as const, content: '' },
    ];
    expect(fieldsOf(validateAIRequest(request({ messages })))).toContain('messages[1].content');
  });

  // Defaults belong to the caller. Left unstated they become whatever the
  // vendor's default is this month, and two runs stop being comparable.
  it('requires the generation parameters', () => {
    expect(fieldsOf(validateAIRequest(request({ params: undefined as never })))).toContain(
      'params',
    );
  });

  it('refuses parameters outside their range', () => {
    const cases: [Partial<AIRequest['params']>, string][] = [
      [{ temperature: -1 }, 'params.temperature'],
      [{ temperature: Number.NaN }, 'params.temperature'],
      [{ maxOutputTokens: 0 }, 'params.maxOutputTokens'],
      [{ maxOutputTokens: 1.5 }, 'params.maxOutputTokens'],
      [{ topP: 0 }, 'params.topP'],
      [{ topP: 1.1 }, 'params.topP'],
      [{ seed: 1.5 }, 'params.seed'],
    ];
    for (const [params, field] of cases) {
      const merged = { temperature: 0.2, maxOutputTokens: 100, ...params };
      expect(fieldsOf(validateAIRequest(request({ params: merged }))), field).toContain(field);
    }
  });

  // A request with no deadline can hold a worker open for as long as a vendor
  // is willing to stall.
  it('requires a timeout', () => {
    for (const timeoutMs of [0, -1, 1.5, Number.NaN]) {
      expect(fieldsOf(validateAIRequest(request({ timeoutMs }))), String(timeoutMs)).toContain(
        'timeoutMs',
      );
    }
  });

  it('requires an idempotency key, so a retry cannot become a second charge', () => {
    expect(fieldsOf(validateAIRequest(request({ idempotencyKey: '   ' })))).toContain(
      'idempotencyKey',
    );
  });

  it('requires the three identifiers to be UUIDs', () => {
    expect(fieldsOf(validateAIRequest(request({ correlationId: 'nope' })))).toContain(
      'correlationId',
    );
    expect(fieldsOf(validateAIRequest(request({ tenantId: 'nope' })))).toContain('tenantId');
    expect(fieldsOf(validateAIRequest(request({ organizationId: 'nope' })))).toContain(
      'organizationId',
    );
  });

  // A caller fixing a malformed request should see the whole picture in one
  // cycle rather than one field per round trip.
  it('reports every issue, not the first', () => {
    const result = validateAIRequest(
      request({ taskType: 'nope', model: '', tenantId: 'x', messages: [] }),
    );
    expect(fieldsOf(result)).toEqual(
      expect.arrayContaining(['taskType', 'model', 'tenantId', 'messages']),
    );
  });

  it('carries a code and a detail on every issue', () => {
    const result = validateAIRequest(request({ model: '' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    for (const issue of result.issues) {
      expect(issue.code).not.toBe('');
      expect(issue.detail.length).toBeGreaterThan(10);
    }
  });
});

describe('a well-formed response passes', () => {
  it('accepts the canonical shape', () => {
    expect(validateAIResponse(response())).toEqual({ ok: true });
  });

  it('accepts every finish reason in the fixed set', () => {
    for (const finishReason of ['stop', 'length', 'content_filter', 'tool_call'] as const) {
      expect(validateAIResponse(response({ finishReason })).ok, finishReason).toBe(true);
    }
  });

  it('accepts an empty completion and empty metadata', () => {
    expect(validateAIResponse(response({ content: '', providerMetadata: {} })).ok).toBe(true);
  });
});

describe('a malformed response is refused', () => {
  it('refuses a finish reason outside the fixed set', () => {
    expect(fieldsOf(validateAIResponse(response({ finishReason: 'timeout' as never })))).toContain(
      'finishReason',
    );
  });

  it('refuses non-string content', () => {
    expect(
      fieldsOf(validateAIResponse(response({ content: { parsed: true } as never }))),
    ).toContain('content');
  });

  it('requires the response to say which provider ran it', () => {
    expect(fieldsOf(validateAIResponse(response({ providerId: '' })))).toContain('providerId');
  });

  it('requires the response to name the model that actually ran', () => {
    expect(fieldsOf(validateAIResponse(response({ model: '' })))).toContain('model');
  });

  it('requires metadata to be an object, empty if the vendor said nothing', () => {
    expect(fieldsOf(validateAIResponse(response({ providerMetadata: null as never })))).toContain(
      'providerMetadata',
    );
  });
});

describe('usage — an unmetered call is an unbilled one', () => {
  it('requires usage at all', () => {
    expect(fieldsOf(validateAIResponse(response({ usage: undefined as never })))).toContain(
      'usage',
    );
  });

  it('requires every token count', () => {
    const usage = {
      ...response().usage,
      tokens: { promptTokens: 1, completionTokens: 1 } as never,
    };
    expect(fieldsOf(validateAIResponse(response({ usage })))).toContain('usage.tokens.totalTokens');
  });

  it('refuses a negative or fractional count', () => {
    for (const tokens of [
      { promptTokens: -1, completionTokens: 1, totalTokens: 0 },
      { promptTokens: 1.5, completionTokens: 1, totalTokens: 2.5 },
    ]) {
      const usage = { ...response().usage, tokens };
      expect(fieldsOf(validateAIResponse(response({ usage })))).toContain(
        'usage.tokens.promptTokens',
      );
    }
  });

  // Two numbers that do not add up mean one of them is wrong, and metering
  // reads the total.
  it('refuses counts that do not add up', () => {
    const usage = {
      ...response().usage,
      tokens: { promptTokens: 100, completionTokens: 100, totalTokens: 999 },
    };
    const result = validateAIResponse(response({ usage }));
    expect(fieldsOf(result)).toContain('usage.tokens.totalTokens');
    if (result.ok) return;
    expect(result.issues.find((i) => i.code === 'INCONSISTENT')?.detail).toContain('200');
  });

  // An unmarked estimate is silent under-metering: the customer is billed for
  // less than they used and nothing reports a discrepancy.
  it('requires the estimate flag to be stated', () => {
    const usage = { ...response().usage, tokensEstimated: undefined as never };
    expect(fieldsOf(validateAIResponse(response({ usage })))).toContain('usage.tokensEstimated');
  });

  it('accepts an estimate that says it is one', () => {
    const usage = { ...response().usage, tokensEstimated: true };
    expect(validateAIResponse(response({ usage })).ok).toBe(true);
  });

  it('bounds the latency it will believe', () => {
    for (const latencyMs of [-1, 1.5, 25 * 60 * 60 * 1000]) {
      const usage = { ...response().usage, latencyMs };
      expect(fieldsOf(validateAIResponse(response({ usage }))), String(latencyMs)).toContain(
        'usage.latencyMs',
      );
    }
  });
});

describe('cost is a decimal string, never a float', () => {
  it("accepts the ledger's own format", () => {
    for (const amount of ['0', '0.000001', '1.5', '12345.678901', '999999']) {
      const usage = { ...response().usage, cost: { currency: 'USD', amount } };
      expect(validateAIResponse(response({ usage })).ok, amount).toBe(true);
    }
  });

  // A float here would put a rounding error directly into the charge path.
  it('refuses a number', () => {
    const usage = { ...response().usage, cost: { currency: 'USD', amount: 0.00425 as never } };
    expect(fieldsOf(validateAIResponse(response({ usage })))).toContain('usage.cost.amount');
  });

  it('refuses more precision than the ledger stores', () => {
    const usage = { ...response().usage, cost: { currency: 'USD', amount: '0.0000001' } };
    expect(fieldsOf(validateAIResponse(response({ usage })))).toContain('usage.cost.amount');
  });

  it('refuses a negative, an exponent, a sign or a leading zero', () => {
    for (const amount of ['-1', '1e-6', '+1', '01.5', '.5', '1.']) {
      const usage = { ...response().usage, cost: { currency: 'USD', amount } };
      expect(fieldsOf(validateAIResponse(response({ usage }))), amount).toContain(
        'usage.cost.amount',
      );
    }
  });

  it('requires an ISO 4217 currency', () => {
    for (const currency of ['usd', 'DOLLARS', '', 'US']) {
      const usage = { ...response().usage, cost: { currency, amount: '1.0' } };
      expect(fieldsOf(validateAIResponse(response({ usage }))), currency).toContain(
        'usage.cost.currency',
      );
    }
  });

  it('accepts a second currency, so adding one is not a migration', () => {
    const usage = { ...response().usage, cost: { currency: 'EUR', amount: '1.0' } };
    expect(validateAIResponse(response({ usage })).ok).toBe(true);
  });
});

describe('the capability check that runs before a provider is contacted', () => {
  it('passes when the provider declares it', () => {
    expect(() => {
      assertCapabilityDeclared('acme', ['text', 'chat'], 'chat');
    }).not.toThrow();
  });

  // Finding this out from a vendor's error costs a round trip and sometimes a
  // charge.
  it('refuses a capability the provider never declared', () => {
    expect(() => {
      assertCapabilityDeclared('acme', ['text'], 'embedding');
    }).toThrow(/does not declare 'embedding'/);
  });

  it('names what the provider does declare', () => {
    expect(() => {
      assertCapabilityDeclared('acme', ['text', 'chat'], 'vision');
    }).toThrow(/text, chat/);
  });

  it('says so plainly when the provider declares nothing', () => {
    expect(() => {
      assertCapabilityDeclared('acme', [], 'text');
    }).toThrow(/\(nothing\)/);
  });
});
