/**
 * The admission pipeline.
 *
 * What is asserted here is mostly refusal: ten checks, each rejecting for its
 * own reason and naming its own stage. The order matters as much as the checks
 * — a malformed request must be refused before a database is touched, and
 * everything must be refused before a provider is contacted, which never
 * happens here at all.
 */
import { describe, expect, it } from 'vitest';

import { validateAIRequest } from '../providers/validation.js';
import { createProviderRegistry, type ProviderRegistry } from '../providers/registry.js';
import type { ModelProvider } from '../providers/provider.js';
import { createPromptCatalogue, type PromptCatalogue } from '../prompts/resolver.js';
import type { PromptTemplate } from '../prompts/template.js';
import { createGateway, type Gateway } from './admission.js';
import { ADMISSION_STAGES, REJECTION_CODES, type GatewayRequest } from './contracts.js';
import type {
  AdmissionDirectory,
  AdmissionFlags,
  AdmissionOrganizationStatus,
  AdmissionWorkspaceStatus,
} from './ports.js';

const ORG = '018f7a1e-0000-7000-8000-0000000000aa';
const WS = '018f7a1e-0000-7000-8000-0000000000bb';
const OTHER_ORG = '018f7a1e-0000-7000-8000-0000000000cc';
const CORRELATION = '018f7a1e-0000-7000-8000-0000000000dd';
const ACTOR = 'user-1';

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

const prompts: PromptCatalogue = createPromptCatalogue([TEMPLATE]);

function provider(over: Partial<ModelProvider> = {}): ModelProvider {
  return {
    providerId: 'reference',
    displayName: 'Reference Provider',
    capabilities: ['text', 'chat'],
    health: () =>
      Promise.resolve({
        status: 'healthy' as const,
        reportedAt: '2026-07-31T00:00:00.000Z',
        detail: null,
      }),
    execute: () => Promise.reject(new Error('admission must never execute')),
    ...over,
  };
}

function registry(...providers: ModelProvider[]): ProviderRegistry {
  const built = createProviderRegistry();
  for (const p of providers.length > 0 ? providers : [provider()]) built.register(p);
  built.seal();
  return built;
}

interface DirectoryOptions {
  readonly organizationStatus?: AdmissionOrganizationStatus | null;
  readonly workspaceStatus?: AdmissionWorkspaceStatus | null;
  readonly workspaceOrganizationId?: string;
  readonly membershipStatus?: 'invited' | 'active' | 'revoked' | null;
}

function directory(options: DirectoryOptions = {}): AdmissionDirectory {
  return {
    organization: (organizationId) =>
      Promise.resolve(
        options.organizationStatus === null
          ? null
          : { organizationId, status: options.organizationStatus ?? 'active' },
      ),
    workspace: (workspaceId) =>
      Promise.resolve(
        options.workspaceStatus === null
          ? null
          : {
              workspaceId,
              organizationId: options.workspaceOrganizationId ?? ORG,
              status: options.workspaceStatus ?? 'active',
            },
      ),
    membership: (workspaceId, actorId) =>
      Promise.resolve(
        options.membershipStatus === null
          ? null
          : { workspaceId, actorId, status: options.membershipStatus ?? 'active' },
      ),
  };
}

const flags = (enabled = true): AdmissionFlags => ({ isEnabled: () => Promise.resolve(enabled) });

function gateway(over: Partial<Parameters<typeof createGateway>[0]> = {}): Gateway {
  return createGateway({
    directory: directory(),
    flags: flags(),
    providers: registry(),
    prompts,
    ...over,
  });
}

function request(over: Partial<GatewayRequest> = {}): GatewayRequest {
  return {
    taskType: 'planning.outline',
    capability: 'chat',
    providerId: 'reference',
    model: 'reference-model',
    templateRef: { id: 'planning.outline' },
    variables: { topic: 'espresso' },
    organizationId: ORG,
    workspaceId: WS,
    actorId: ACTOR,
    correlationId: CORRELATION,
    idempotencyKey: 'run-1:step-1',
    ...over,
  };
}

/** The rejection code, or 'admitted'. */
async function codeOf(g: Gateway, r: GatewayRequest): Promise<string> {
  const response = await g.admit(r);
  if (response.admitted) return 'admitted';
  return response.decision.outcome === 'reject' ? response.decision.code : 'admitted';
}

describe('the vocabulary', () => {
  it('names the ten stages in the order they run', () => {
    expect([...ADMISSION_STAGES]).toEqual([
      'validate',
      'resolve-organization',
      'resolve-tenant',
      'resolve-workspace',
      'validate-capability',
      'validate-provider',
      'validate-prompt',
      'authorize',
      'prepare-workflow',
    ]);
  });

  it('names a code for every way admission can refuse', () => {
    expect(REJECTION_CODES.length).toBeGreaterThan(0);
    expect(new Set(REJECTION_CODES).size).toBe(REJECTION_CODES.length);
  });
});

describe('a well-formed request is admitted', () => {
  it('admits', async () => {
    const response = await gateway().admit(request());
    expect(response.admitted).toBe(true);
    expect(response.decision.outcome).toBe('admit');
  });

  // The whole point of normalization: what comes out is the one execution
  // request this platform has.
  it('normalizes into the canonical AIRequest', async () => {
    const response = await gateway().admit(request());
    if (!response.admitted) throw new Error('expected admission');
    expect(validateAIRequest(response.result.request)).toEqual({ ok: true });
    expect(response.result.request.messages[1]?.content).toBe('Write an outline about espresso.');
  });

  it('carries the resolved tenancy, not the ids it was told', async () => {
    const response = await gateway().admit(request());
    if (!response.admitted) throw new Error('expected admission');
    expect(response.result.context.tenant).toEqual({
      tenantId: WS,
      organizationId: ORG,
      source: 'request',
    });
  });

  it('records which prompt version was resolved', async () => {
    const response = await gateway().admit(request());
    if (!response.admitted) throw new Error('expected admission');
    expect(response.result.promptVersion).toBe('planning.outline@7');
  });

  it("carries the caller's identifiers through to the request", async () => {
    const response = await gateway().admit(request());
    if (!response.admitted) throw new Error('expected admission');
    expect(response.result.request).toMatchObject({
      tenantId: WS,
      organizationId: ORG,
      correlationId: CORRELATION,
      taskType: 'planning.outline',
      capability: 'chat',
      model: 'reference-model',
    });
  });

  // Derived, so two admissions of one request produce one workflow.
  it('derives the workflow id from the idempotency key', async () => {
    const response = await gateway().admit(request());
    if (!response.admitted) throw new Error('expected admission');
    expect(response.result.workflowId).toBe('run-1:step-1');
    expect(response.result.request.idempotencyKey).toBe('run-1:step-1:execute');
  });

  it('adopts the template hints when the caller states no parameters', async () => {
    const response = await gateway().admit(request());
    if (!response.admitted) throw new Error('expected admission');
    expect(response.result.request.params).toEqual({ temperature: 0.2, maxOutputTokens: 1024 });
  });

  it("uses the caller's parameters when stated", async () => {
    const response = await gateway().admit(
      request({ params: { temperature: 0.9, maxOutputTokens: 4096 } }),
    );
    if (!response.admitted) throw new Error('expected admission');
    expect(response.result.request.params).toEqual({ temperature: 0.9, maxOutputTokens: 4096 });
  });

  it('admits platform-initiated work with no actor', async () => {
    expect(await codeOf(gateway(), request({ actorId: null }))).toBe('admitted');
  });

  // Deterministic: the same request against the same components decides the
  // same way, and produces the same request.
  it('produces an identical admission every time', async () => {
    const g = gateway();
    const first = await g.admit(request());
    const second = await g.admit(request());
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });
});

describe('stage 1 — a malformed request is refused before anything is asked', () => {
  it('refuses a bad task type, capability, provider or model', async () => {
    for (const over of [
      { taskType: 'planning' },
      { capability: '' as never },
      { providerId: '  ' },
      { model: '' },
    ]) {
      expect(await codeOf(gateway(), request(over)), JSON.stringify(over)).toBe('MalformedRequest');
    }
  });

  it('refuses a missing template reference', async () => {
    expect(await codeOf(gateway(), request({ templateRef: undefined as never }))).toBe(
      'MalformedRequest',
    );
  });

  it('refuses identifiers that are not UUIDs', async () => {
    for (const field of ['organizationId', 'workspaceId', 'correlationId'] as const) {
      expect(await codeOf(gateway(), request({ [field]: 'nope' })), field).toBe('MalformedRequest');
    }
  });

  it('refuses a missing idempotency key', async () => {
    expect(await codeOf(gateway(), request({ idempotencyKey: '   ' }))).toBe('MalformedRequest');
  });

  // The optional-versus-null ambiguity is what makes an unauthenticated
  // request look like a platform-initiated one.
  it('requires actorId to be present, even when it is null', async () => {
    const { actorId: _dropped, ...rest } = request();
    expect(await codeOf(gateway(), rest as GatewayRequest)).toBe('MalformedRequest');
  });

  it('reports every problem at once', async () => {
    const response = await gateway().admit(request({ taskType: 'x', model: '' }));
    if (response.admitted || response.decision.outcome !== 'reject')
      throw new Error('expected a rejection');
    expect(response.decision.reason).toContain('taskType');
    expect(response.decision.reason).toContain('model');
  });

  // A caller cannot spend a render on a payload that was never going to fit.
  it('refuses a payload over the bound', async () => {
    const variables = { topic: 'x'.repeat(300_000) };
    expect(await codeOf(gateway(), request({ variables }))).toBe('RequestTooLarge');
  });

  it('refuses a payload that cannot be serialized at all', async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(await codeOf(gateway(), request({ variables: cyclic }))).toBe('RequestTooLarge');
  });

  // Nothing is asked before the shape is checked.
  it('asks the directory nothing when the request is malformed', async () => {
    let asked = 0;
    const counting: AdmissionDirectory = {
      organization: (id) => {
        asked += 1;
        return Promise.resolve({ organizationId: id, status: 'active' });
      },
      workspace: (id) => {
        asked += 1;
        return Promise.resolve({ workspaceId: id, organizationId: ORG, status: 'active' });
      },
      membership: () => Promise.resolve(null),
    };
    await gateway({ directory: counting }).admit(request({ model: '' }));
    expect(asked).toBe(0);
  });
});

describe('stages 2 to 4 — tenancy', () => {
  it('refuses an organization nobody has', async () => {
    expect(
      await codeOf(gateway({ directory: directory({ organizationStatus: null }) }), request()),
    ).toBe('UnknownOrganization');
  });

  // AI spend is the dominant variable cost; serving an unpaid account is a
  // write-off rather than an error.
  it('refuses every organization state but active, including past_due', async () => {
    for (const status of ['past_due', 'suspended', 'pending_closure', 'closed'] as const) {
      expect(
        await codeOf(gateway({ directory: directory({ organizationStatus: status }) }), request()),
        status,
      ).toBe('OrganizationNotAdmitting');
    }
  });

  it('refuses a workspace nobody has', async () => {
    expect(
      await codeOf(gateway({ directory: directory({ workspaceStatus: null }) }), request()),
    ).toBe('UnknownWorkspace');
  });

  it('refuses a suspended workspace', async () => {
    expect(
      await codeOf(gateway({ directory: directory({ workspaceStatus: 'suspended' }) }), request()),
    ).toBe('WorkspaceNotAdmitting');
  });

  it('refuses every workspace state but active', async () => {
    for (const status of ['suspended', 'archived', 'pending_deletion'] as const) {
      expect(
        await codeOf(gateway({ directory: directory({ workspaceStatus: status }) }), request()),
        status,
      ).toBe('WorkspaceNotAdmitting');
    }
  });

  // The check that stops an id swap reading another customer's settings and
  // spending their budget.
  it('refuses a workspace belonging to another organization', async () => {
    expect(
      await codeOf(
        gateway({ directory: directory({ workspaceOrganizationId: OTHER_ORG }) }),
        request(),
      ),
    ).toBe('TenantMismatch');
  });

  it('names the stage that refused', async () => {
    const response = await gateway({
      directory: directory({ workspaceStatus: 'suspended' }),
    }).admit(request());
    if (response.admitted || response.decision.outcome !== 'reject')
      throw new Error('expected a rejection');
    expect(response.decision.stage).toBe('resolve-workspace');
  });
});

describe('stages 5 and 6 — capability and provider', () => {
  it('refuses a capability nothing registered can serve', async () => {
    expect(await codeOf(gateway(), request({ capability: 'audio' }))).toBe('CapabilityUnavailable');
  });

  it('refuses a provider that is not registered', async () => {
    expect(await codeOf(gateway(), request({ providerId: 'nobody' }))).toBe('UnknownProvider');
  });

  // Something can do it, but not the one that was asked for.
  it('refuses a provider that does not declare the capability', async () => {
    const registered = registry(
      provider({ providerId: 'reference', capabilities: ['chat'] }),
      provider({ providerId: 'embedder', capabilities: ['embedding'] }),
    );
    const response = await gateway({ providers: registered }).admit(
      request({ providerId: 'embedder', capability: 'chat' }),
    );
    if (response.admitted || response.decision.outcome !== 'reject')
      throw new Error('expected a rejection');
    expect(response.decision.code).toBe('CapabilityUnavailable');
    expect(response.decision.stage).toBe('validate-provider');
    expect(response.decision.reason).toContain('embedding');
  });
});

describe('stage 7 — the prompt', () => {
  it('refuses a template nobody declares', async () => {
    expect(await codeOf(gateway(), request({ templateRef: { id: 'nobody.here' } }))).toBe(
      'UnknownPrompt',
    );
  });

  it('refuses a version that does not exist', async () => {
    expect(
      await codeOf(gateway(), request({ templateRef: { id: 'planning.outline', version: 99 } })),
    ).toBe('UnknownPrompt');
  });

  it('admits a pinned version that does', async () => {
    expect(
      await codeOf(gateway(), request({ templateRef: { id: 'planning.outline', version: 7 } })),
    ).toBe('admitted');
  });
});

describe('stage 8 — authorization', () => {
  it('refuses an actor with no membership', async () => {
    expect(
      await codeOf(gateway({ directory: directory({ membershipStatus: null }) }), request()),
    ).toBe('MembershipRequired');
  });

  it('refuses a membership that is not active', async () => {
    for (const status of ['invited', 'revoked'] as const) {
      expect(
        await codeOf(gateway({ directory: directory({ membershipStatus: status }) }), request()),
        status,
      ).toBe('MembershipRequired');
    }
  });

  // A scheduled refresh has no membership to check, and requiring one would
  // make background work impossible rather than more secure.
  it('checks no membership when there is no actor', async () => {
    let asked = 0;
    const counting: AdmissionDirectory = {
      ...directory(),
      membership: (workspaceId, actorId) => {
        asked += 1;
        return Promise.resolve({ workspaceId, actorId, status: 'active' });
      },
    };
    await gateway({ directory: counting }).admit(request({ actorId: null }));
    expect(asked).toBe(0);
  });

  it('refuses a request whose feature flag is off', async () => {
    expect(
      await codeOf(gateway({ flags: flags(false) }), request({ featureFlag: 'ai.outlines' })),
    ).toBe('FeatureDisabled');
  });

  it('admits when the flag is on', async () => {
    expect(
      await codeOf(gateway({ flags: flags(true) }), request({ featureFlag: 'ai.outlines' })),
    ).toBe('admitted');
  });

  // Inventing a key convention would mean checking flags no registry declares,
  // which evaluates to a default and reads as a check that happened.
  it('checks no flag when the request names none', async () => {
    let asked = 0;
    const counting: AdmissionFlags = {
      isEnabled: () => {
        asked += 1;
        return Promise.resolve(false);
      },
    };
    expect(await codeOf(gateway({ flags: counting }), request())).toBe('admitted');
    expect(asked).toBe(0);
  });
});

describe('stage 9 — preparation', () => {
  // A prompt that resolves but cannot render is a caller defect, and the
  // pipeline's refusal is more useful than an exception escaping the Gateway.
  it('refuses a request missing a variable the template requires', async () => {
    const response = await gateway().admit(request({ variables: {} }));
    if (response.admitted || response.decision.outcome !== 'reject')
      throw new Error('expected a rejection');
    expect(response.decision.code).toBe('PreparationFailed');
    expect(response.decision.stage).toBe('prepare-workflow');
    expect(response.decision.reason).toContain('required');
  });

  it('refuses a variable the template never declared', async () => {
    expect(await codeOf(gateway(), request({ variables: { topic: 'x', extra: 1 } }))).toBe(
      'PreparationFailed',
    );
  });

  it('does not throw for a caller defect', async () => {
    await expect(gateway().admit(request({ variables: {} }))).resolves.toBeDefined();
  });
});

describe('admission never executes', () => {
  // The whole increment in one assertion: the provider is registered and
  // reachable, and nothing calls it.
  it('never calls a provider', async () => {
    let calls = 0;
    const counting = provider({
      execute: () => {
        calls += 1;
        return Promise.reject(new Error('must not be called'));
      },
    });
    const response = await gateway({ providers: registry(counting) }).admit(request());
    expect(response.admitted).toBe(true);
    expect(calls).toBe(0);
  });

  it('hands back a request that is ready to send, and does not send it', async () => {
    const response = await gateway().admit(request());
    if (!response.admitted) throw new Error('expected admission');
    expect(response.result.request.messages).toHaveLength(2);
    expect(response.result).not.toHaveProperty('response');
  });
});

describe('the response is immutable', () => {
  it('freezes an admission and its decision', async () => {
    const response = await gateway().admit(request());
    expect(Object.isFrozen(response)).toBe(true);
    expect(Object.isFrozen(response.decision)).toBe(true);
    if (!response.admitted) return;
    expect(Object.isFrozen(response.result)).toBe(true);
    expect(Object.isFrozen(response.result.context)).toBe(true);
  });

  it('freezes a rejection', async () => {
    const response = await gateway().admit(request({ model: '' }));
    expect(Object.isFrozen(response)).toBe(true);
    expect(() => {
      (response.decision as { outcome: string }).outcome = 'admit';
    }).toThrow();
  });
});
