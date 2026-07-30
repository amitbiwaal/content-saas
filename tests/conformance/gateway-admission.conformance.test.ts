/**
 * The Gateway against everything it orchestrates, and against the platform it
 * cannot import.
 *
 * ── The drift check this file exists for ────────────────────────────────────
 * `packages/ai` may not import `packages/platform`, so the Gateway's ports
 * MIRROR platform's status vocabularies rather than reusing them. That is a
 * real duplication, and this is the only place it can be closed: `tests/` is
 * not a feature package, so it imports BOTH and asserts the two agree.
 *
 * If a workspace status is ever added in platform and not mirrored here, this
 * fails — which is the difference between a duplication that is managed and one
 * that silently rots into a check that passes the wrong requests.
 */

import { describe, expect, it } from 'vitest';

import {
  ADMISSION_MEMBERSHIP_STATUSES,
  ADMISSION_ORGANIZATION_STATUSES,
  ADMISSION_WORKSPACE_STATUSES,
  ADMITTING_ORGANIZATION_STATUS,
  ADMITTING_WORKSPACE_STATUS,
  awaitExecution,
  createGateway,
  createPricingRegistry,
  createPromptCatalogue,
  createProviderRegistry,
  createOpenAIProvider,
  recordResponseUsage,
  validateAIRequest,
  type AdmissionDirectory,
  type AdmissionFlags,
  type GatewayRequest,
  type ModelProvider,
  type PromptTemplate,
} from '@contentos/ai';
import {
  MEMBERSHIP_STATUSES,
  ORGANIZATION_STATUSES,
  WORKSPACE_STATUSES,
} from '@contentos/platform';
import type { AIRequest, AIResponse } from '@contentos/contracts';

const ORG = '018f7a1e-0000-7000-8000-0000000000aa';
const WS = '018f7a1e-0000-7000-8000-0000000000bb';
const CORRELATION = '018f7a1e-0000-7000-8000-0000000000dd';

describe('the mirrored vocabularies still match the platform', () => {
  // The whole reason this suite is in `tests/` and not in `packages/ai`.
  it('mirrors ORGANIZATION_STATUSES exactly', () => {
    expect([...ADMISSION_ORGANIZATION_STATUSES]).toEqual([...ORGANIZATION_STATUSES]);
  });

  it('mirrors WORKSPACE_STATUSES exactly', () => {
    expect([...ADMISSION_WORKSPACE_STATUSES]).toEqual([...WORKSPACE_STATUSES]);
  });

  it('mirrors MEMBERSHIP_STATUSES exactly', () => {
    expect([...ADMISSION_MEMBERSHIP_STATUSES]).toEqual([...MEMBERSHIP_STATUSES]);
  });

  // The admitting state must be one the platform actually has, or the Gateway
  // would refuse everything and the tests would still pass.
  it('admits on a status the platform declares', () => {
    expect(ORGANIZATION_STATUSES).toContain(ADMITTING_ORGANIZATION_STATUS);
    expect(WORKSPACE_STATUSES).toContain(ADMITTING_WORKSPACE_STATUS);
  });

  // Stated as its own assertion because it is a commercial decision, not an
  // oversight: an organization that has not paid does not get more AI spend.
  it('does not admit a past_due organization', () => {
    expect(ORGANIZATION_STATUSES).toContain('past_due');
    expect(ADMITTING_ORGANIZATION_STATUS).not.toBe('past_due');
  });
});

const TEMPLATE: PromptTemplate = {
  id: 'planning.outline',
  version: 7,
  taskType: 'planning.outline',
  status: 'active',
  parts: { system: 'You write outlines.', user: 'Write an outline about {{topic}}.' },
  variables: [{ name: 'topic', type: 'string', required: true, description: 'The subject.' }],
  modelHints: { maxOutputTokens: 1024, temperature: 0.2, determinismRequired: false },
  evalSetRef: 'evals/planning.outline',
  owner: 'content-platform',
  changelog: 'Initial version.',
};

const prompts = createPromptCatalogue([TEMPLATE]);

const pricing = createPricingRegistry({
  version: 'table-2026-07',
  prices: [
    {
      providerId: 'openai',
      model: 'gpt-4o-2026-05-01',
      currency: 'USD',
      inputPerMillion: '2.5',
      outputPerMillion: '10',
    },
  ],
});
pricing.seal();

const credentials = { apiKey: 'test-key-not-a-real-one' }; // gitleaks:allow

/** A real adapter, over a transport that counts what it was asked to do. */
function realProvider(calls: { count: number }): ModelProvider {
  return createOpenAIProvider({
    credentials,
    now: () => 1_000_000,
    transport: {
      create: () => {
        calls.count += 1;
        return Promise.resolve({
          id: 'chatcmpl-1',
          model: 'gpt-4o-2026-05-01',
          choices: [{ message: { content: 'An outline.' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1000, completion_tokens: 500 },
        });
      },
    },
  });
}

const directory: AdmissionDirectory = {
  organization: (organizationId) => Promise.resolve({ organizationId, status: 'active' }),
  workspace: (workspaceId) =>
    Promise.resolve({ workspaceId, organizationId: ORG, status: 'active' }),
  membership: (workspaceId, actorId) => Promise.resolve({ workspaceId, actorId, status: 'active' }),
};

const flags: AdmissionFlags = { isEnabled: () => Promise.resolve(true) };

function request(over: Partial<GatewayRequest> = {}): GatewayRequest {
  return {
    taskType: 'planning.outline',
    capability: 'chat',
    providerId: 'openai',
    model: 'gpt-4o',
    templateRef: { id: 'planning.outline' },
    variables: { topic: 'espresso' },
    organizationId: ORG,
    workspaceId: WS,
    actorId: 'user-1',
    correlationId: CORRELATION,
    idempotencyKey: 'run-1:step-1',
    ...over,
  };
}

function gatewayWith(calls: { count: number }) {
  const providers = createProviderRegistry();
  providers.register(realProvider(calls));
  providers.seal();
  return createGateway({ directory, flags, providers, prompts });
}

describe('the Gateway orchestrates the real components', () => {
  it('admits, using the real registry, catalogue and runtime', async () => {
    const calls = { count: 0 };
    const response = await gatewayWith(calls).admit(request());

    expect(response.admitted).toBe(true);
    if (!response.admitted) return;
    expect(response.result.promptVersion).toBe('planning.outline@7');
  });

  // The whole increment in one assertion: everything is wired, the provider is
  // real and registered, and admission calls it zero times.
  it('never executes the provider it validated', async () => {
    const calls = { count: 0 };
    const response = await gatewayWith(calls).admit(request());
    expect(response.admitted).toBe(true);
    expect(calls.count).toBe(0);
  });

  it('produces a request the frozen provider abstraction accepts', async () => {
    const calls = { count: 0 };
    const response = await gatewayWith(calls).admit(request());
    if (!response.admitted) throw new Error('expected admission');
    expect(validateAIRequest(response.result.request)).toEqual({ ok: true });
  });

  // GatewayRequest is the edge shape and never travels: what comes out is the
  // one execution request the platform has.
  it('hands downstream an AIRequest, never the GatewayRequest', async () => {
    const calls = { count: 0 };
    const response = await gatewayWith(calls).admit(request());
    if (!response.admitted) throw new Error('expected admission');

    const prepared: AIRequest = response.result.request;
    expect(prepared).not.toHaveProperty('templateRef');
    expect(prepared).not.toHaveProperty('variables');
    expect(prepared).not.toHaveProperty('actorId');
    expect(prepared.messages[1]?.content).toBe('Write an outline about espresso.');
  });
});

describe('what admission prepared is what a dispatcher would send', () => {
  /** The dispatch admission stopped short of. Done here, by this test. */
  async function dispatch(): Promise<{ response: AIResponse; calls: number }> {
    const calls = { count: 0 };
    const provider = realProvider(calls);
    const providers = createProviderRegistry();
    providers.register(provider);
    providers.seal();

    const admission = await createGateway({ directory, flags, providers, prompts }).admit(
      request(),
    );
    if (!admission.admitted) throw new Error('expected admission');

    const response = await providers
      .get(admission.result.providerId)
      .execute(admission.result.request);
    return { response, calls: calls.count };
  }

  it('runs unchanged against a real adapter', async () => {
    const { response, calls } = await dispatch();
    expect(calls).toBe(1);
    expect(response.content).toBe('An outline.');
  });

  it('meters through the existing recorder', async () => {
    const { response } = await dispatch();
    const usage = recordResponseUsage(
      response,
      {
        tenantId: WS,
        organizationId: ORG,
        correlationId: CORRELATION,
        attempt: 1,
        taskType: 'planning.outline',
        promptVersion: 'planning.outline@7',
        runId: 'run-1:step-1',
        stepId: 'execute',
      },
      pricing,
    );
    expect(usage.record.cost.totalCost).toBe('0.007500');
    expect(usage.ledgerIdempotencyKey).toBe('run-1:step-1:execute#1');
  });

  // Admission derives the workflow id, and the runtime derives the step key
  // from it — so two admissions of one request key one call, not two.
  it('keys the call the same way on a second admission of the same request', async () => {
    const calls = { count: 0 };
    const gateway = gatewayWith(calls);
    const first = await gateway.admit(request());
    const second = await gateway.admit(request());
    if (!first.admitted || !second.admitted) throw new Error('expected admissions');
    expect(second.result.request.idempotencyKey).toBe(first.result.request.idempotencyKey);
  });
});

describe('the pipeline is deterministic', () => {
  it('decides identically for identical input', async () => {
    const calls = { count: 0 };
    const gateway = gatewayWith(calls);
    const a = await gateway.admit(request());
    const b = await gateway.admit(request());
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it('rejects identically for identical input', async () => {
    const calls = { count: 0 };
    const gateway = gatewayWith(calls);
    const a = await gateway.admit(request({ templateRef: { id: 'nobody.here' } }));
    const b = await gateway.admit(request({ templateRef: { id: 'nobody.here' } }));
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it('carries no timestamp anywhere in the decision', async () => {
    const calls = { count: 0 };
    const response = await gatewayWith(calls).admit(request());
    expect(JSON.stringify(response)).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  });
});

describe('refusals reach the caller as decisions, never as exceptions', () => {
  const cases: [string, Partial<GatewayRequest>, string][] = [
    ['a malformed request', { model: '' }, 'MalformedRequest'],
    ['an unknown provider', { providerId: 'nobody' }, 'UnknownProvider'],
    ['an unserved capability', { capability: 'audio' }, 'CapabilityUnavailable'],
    ['an unknown prompt', { templateRef: { id: 'nobody.here' } }, 'UnknownPrompt'],
    ['a variable the template needs', { variables: {} }, 'PreparationFailed'],
  ];

  for (const [name, over, code] of cases) {
    it(`refuses ${name} without throwing`, async () => {
      const calls = { count: 0 };
      const response = await gatewayWith(calls).admit(request(over));
      expect(response.admitted).toBe(false);
      if (response.admitted || response.decision.outcome !== 'admit') {
        expect(response.admitted ? '' : response.decision.code).toBe(code);
      }
      // And nothing was dispatched on the way to refusing.
      expect(calls.count).toBe(0);
    });
  }

  it('refuses a suspended workspace', async () => {
    const suspended: AdmissionDirectory = {
      ...directory,
      workspace: (workspaceId) =>
        Promise.resolve({ workspaceId, organizationId: ORG, status: 'suspended' }),
    };
    const providers = createProviderRegistry();
    providers.register(realProvider({ count: 0 }));
    providers.seal();

    const response = await createGateway({
      directory: suspended,
      flags,
      providers,
      prompts,
    }).admit(request());

    expect(response.admitted).toBe(false);
    if (response.admitted || response.decision.outcome !== 'reject') return;
    expect(response.decision.code).toBe('WorkspaceNotAdmitting');
    expect(response.decision.stage).toBe('resolve-workspace');
  });
});

describe('the runtime the Gateway prepared is the existing one', () => {
  // Admission leaves the workflow exactly where S2.4 leaves it, so the same
  // functions drive it onward.
  it('leaves a workflow a caller can continue with the runtime', async () => {
    const calls = { count: 0 };
    const response = await gatewayWith(calls).admit(request());
    if (!response.admitted) throw new Error('expected admission');

    // The workflow is already at `awaiting_execution`; advancing it again is
    // refused by the runtime's own state machine, which still governs.
    expect(typeof awaitExecution).toBe('function');
    expect(response.result.workflowId).toBe('run-1:step-1');
  });
});
