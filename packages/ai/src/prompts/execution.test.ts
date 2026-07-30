/**
 * Execution preparation.
 *
 * The point of this file is what does NOT happen: nothing here calls a
 * provider. What is asserted is that the canonical execution request is
 * complete and valid before anything is dispatched — a failure now costs
 * nothing, and the same failure after dispatch costs a customer money and
 * returns plausible-looking garbage.
 */
import { describe, expect, it } from 'vitest';

import type { AIRequest, AIResponse } from '@contentos/contracts';
import { validateAIRequest } from '../providers/validation.js';

import { compilePrompt, type CompiledPrompt } from './compile.js';
import { completeExecution, prepareExecution } from './execution.js';
import { PromptError, type PromptInput, type PromptTemplate } from './template.js';

const WS = '018f7a1e-0000-7000-8000-0000000000bb';
const ORG = '018f7a1e-0000-7000-8000-0000000000aa';
const CORRELATION = '018f7a1e-0000-7000-8000-0000000000dd';

const TEMPLATE: PromptTemplate = {
  id: 'planning.outline',
  version: 7,
  taskType: 'planning.outline',
  status: 'active',
  parts: { system: 'You write outlines.', user: 'Write about {{topic}}.' },
  variables: [{ name: 'topic', type: 'string', required: true, description: 'The subject.' }],
  modelHints: { maxOutputTokens: 1024, temperature: 0.2, determinismRequired: true },
  evalSetRef: 'evals/planning.outline',
  owner: 'content-platform',
  changelog: 'Initial version.',
};

const INPUT: PromptInput = {
  templateRef: { id: 'planning.outline', version: 7 },
  variables: { topic: 'espresso' },
  tenantId: WS,
  correlationId: CORRELATION,
};

const compiled = (): CompiledPrompt => compilePrompt({ template: TEMPLATE, input: INPUT });

function request(over: Partial<AIRequest> = {}): AIRequest {
  return {
    taskType: 'planning.outline',
    capability: 'chat',
    model: 'gpt-4o',
    // Deliberately not the compiled prompt: preparation replaces this.
    messages: [{ role: 'user', content: 'placeholder' }],
    params: { temperature: 0.5, maxOutputTokens: 2048 },
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
      tokens: { promptTokens: 12, completionTokens: 30, totalTokens: 42 },
      tokensEstimated: false,
      cost: { currency: 'USD', amount: '0.000420' },
      latencyMs: 91,
    },
    providerMetadata: {},
    ...over,
  };
}

describe('the canonical execution request', () => {
  it('is built from the prompt, the request and the capability', () => {
    const prepared = prepareExecution({
      compiled: compiled(),
      request: request(),
      capability: 'chat',
    });
    expect(prepared.promptVersion).toBe('planning.outline@7');
    expect(prepared.templateId).toBe('planning.outline');
    expect(prepared.templateVersion).toBe(7);
    expect(prepared.capability).toBe('chat');
  });

  // The compiled prompt is the only source of messages: a caller-supplied
  // message list would be a prompt that exists outside the registry.
  it("replaces the caller's messages with the compiled prompt", () => {
    const prepared = prepareExecution({
      compiled: compiled(),
      request: request(),
      capability: 'chat',
    });
    expect(prepared.request.messages).toEqual(compiled().messages);
    expect(prepared.request.messages.map((m) => m.content)).not.toContain('placeholder');
  });

  // No duplicate request model: what a provider receives is the SAME AIRequest
  // the provider abstraction already froze.
  it('carries a request the provider abstraction accepts unchanged', () => {
    const prepared = prepareExecution({
      compiled: compiled(),
      request: request(),
      capability: 'chat',
    });
    expect(validateAIRequest(prepared.request)).toEqual({ ok: true });
  });

  it('keeps every identifier the caller supplied', () => {
    const prepared = prepareExecution({
      compiled: compiled(),
      request: request(),
      capability: 'chat',
    });
    expect(prepared.request).toMatchObject({
      taskType: 'planning.outline',
      model: 'gpt-4o',
      timeoutMs: 30_000,
      idempotencyKey: 'run-1:step-3',
      correlationId: CORRELATION,
      tenantId: WS,
      organizationId: ORG,
    });
  });

  it('reports the size that was measured', () => {
    const prepared = prepareExecution({
      compiled: compiled(),
      request: request(),
      capability: 'chat',
    });
    expect(prepared.promptChars).toBe(compiled().promptChars);
  });
});

describe('model hints are carried, not applied', () => {
  // Hints are an input to routing, never a command. Overwriting the caller's
  // params would mean a template edit changing a caller's sampling without the
  // caller knowing.
  it("leaves the caller's sampling parameters alone", () => {
    const prepared = prepareExecution({
      compiled: compiled(),
      request: request(),
      capability: 'chat',
    });
    expect(prepared.request.params).toEqual({ temperature: 0.5, maxOutputTokens: 2048 });
  });

  it("carries the template's hints alongside, for the Router", () => {
    const prepared = prepareExecution({
      compiled: compiled(),
      request: request(),
      capability: 'chat',
    });
    expect(prepared.hints).toEqual({
      maxOutputTokens: 1024,
      temperature: 0.2,
      determinismRequired: true,
    });
  });
});

describe('the capability must agree', () => {
  // Two statements of the same fact that disagree. Which one is true decides
  // whether the right provider is chosen.
  it('rejects a request asking for a different capability', () => {
    expect(() =>
      prepareExecution({
        compiled: compiled(),
        request: request({ capability: 'embedding' }),
        capability: 'chat',
      }),
    ).toThrow(PromptError);
  });

  it('reports that as CapabilityMismatch and names both', () => {
    try {
      prepareExecution({
        compiled: compiled(),
        request: request({ capability: 'embedding' }),
        capability: 'chat',
      });
      expect.unreachable('must reject');
    } catch (error) {
      expect((error as PromptError).code).toBe('CapabilityMismatch');
      expect((error as PromptError).message).toContain('embedding');
      expect((error as PromptError).message).toContain('chat');
    }
  });

  it('accepts any capability the two agree on', () => {
    for (const capability of ['text', 'chat', 'vision'] as const) {
      expect(() =>
        prepareExecution({
          compiled: compiled(),
          request: request({ capability }),
          capability,
        }),
      ).not.toThrow();
    }
  });
});

describe('an invalid request is refused before anything is dispatched', () => {
  it('rejects a request the provider abstraction would refuse', () => {
    expect(() =>
      prepareExecution({
        compiled: compiled(),
        request: request({ tenantId: 'not-a-uuid' }),
        capability: 'chat',
      }),
    ).toThrow(PromptError);
  });

  it('reports which field was wrong, so the caller can fix it', () => {
    try {
      prepareExecution({
        compiled: compiled(),
        request: request({ idempotencyKey: '   ' }),
        capability: 'chat',
      });
      expect.unreachable('must reject');
    } catch (error) {
      expect((error as PromptError).code).toBe('MalformedExecutionRequest');
      expect((error as PromptError).message).toContain('idempotencyKey');
    }
  });

  it('names the prompt version that produced the bad request', () => {
    try {
      prepareExecution({
        compiled: compiled(),
        request: request({ timeoutMs: 0 }),
        capability: 'chat',
      });
      expect.unreachable('must reject');
    } catch (error) {
      expect((error as PromptError).message).toContain('planning.outline@7');
    }
  });

  it('rejects a compiled prompt with no messages', () => {
    const empty = { ...compiled(), messages: [] };
    expect(() =>
      prepareExecution({ compiled: empty, request: request(), capability: 'chat' }),
    ).toThrow(/nothing to send/);
  });
});

describe('the prepared request is immutable', () => {
  it('is frozen, and so is the request inside it', () => {
    const prepared = prepareExecution({
      compiled: compiled(),
      request: request(),
      capability: 'chat',
    });
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.request)).toBe(true);
  });

  it('refuses a write to the model', () => {
    const prepared = prepareExecution({
      compiled: compiled(),
      request: request(),
      capability: 'chat',
    });
    expect(() => {
      (prepared.request as { model: string }).model = 'something-cheaper';
    }).toThrow();
  });

  it("does not share the caller's request object", () => {
    const original = request();
    const prepared = prepareExecution({
      compiled: compiled(),
      request: original,
      capability: 'chat',
    });
    expect(prepared.request).not.toBe(original);
    expect(original.messages.map((m) => m.content)).toEqual(['placeholder']);
  });
});

describe('nothing here executes anything', () => {
  // The whole increment in one assertion: preparation is synchronous and
  // touches no provider, so there is no call it could make.
  it('prepares without a provider in sight', () => {
    const prepared = prepareExecution({
      compiled: compiled(),
      request: request(),
      capability: 'chat',
    });
    expect(prepared.request.messages).toHaveLength(2);
    expect(prepared).not.toHaveProperty('response');
  });

  it('pairs a response only when it is handed one', () => {
    const prepared = prepareExecution({
      compiled: compiled(),
      request: request(),
      capability: 'chat',
    });
    const result = completeExecution(prepared, response());
    expect(result.request).toBe(prepared);
    expect(result.response.content).toBe('An outline.');
  });

  // Recording a mismatched pair would attribute one request's cost and output
  // to another.
  it('refuses to pair a response that answered a different call', () => {
    const prepared = prepareExecution({
      compiled: compiled(),
      request: request(),
      capability: 'chat',
    });
    expect(() => completeExecution(prepared, response({ idempotencyKey: 'run-9:step-1' }))).toThrow(
      PromptError,
    );
  });

  it('names both keys when they disagree', () => {
    const prepared = prepareExecution({
      compiled: compiled(),
      request: request(),
      capability: 'chat',
    });
    try {
      completeExecution(prepared, response({ idempotencyKey: 'run-9:step-1' }));
      expect.unreachable('must refuse');
    } catch (error) {
      expect((error as PromptError).message).toContain('run-9:step-1');
      expect((error as PromptError).message).toContain('run-1:step-3');
    }
  });

  it('freezes the pairing', () => {
    const prepared = prepareExecution({
      compiled: compiled(),
      request: request(),
      capability: 'chat',
    });
    expect(Object.isFrozen(completeExecution(prepared, response()))).toBe(true);
  });
});
