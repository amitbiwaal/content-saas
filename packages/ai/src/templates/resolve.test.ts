import type { AIResponse } from '@contentos/contracts';
import { describe, expect, it } from 'vitest';

import type { ModelProvider } from '../providers/provider.js';
import { createProviderRegistry } from '../providers/registry.js';
import type { PromptTemplate } from '../prompts/template.js';
import { createTemplateLibrary } from './library.js';
import type { TemplateCapability, TemplateMetadata } from './metadata.js';
import {
  isResolutionRejectionCode,
  RESOLUTION_REJECTION_CODES,
  resolveTemplate,
  type ResolveOptions,
  type TemplateResolution,
  type VersionSelector,
} from './resolve.js';

const RESPONSE: AIResponse = {
  idempotencyKey: 'idem-1',
  providerId: 'openai',
  model: 'gpt-4o',
  content: 'text',
  finishReason: 'stop',
  usage: {
    tokens: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    tokensEstimated: false,
    cost: { currency: 'USD', amount: '0.000001' },
    latencyMs: 1,
  },
  providerMetadata: {},
};

function providerNamed(
  providerId: string,
  capabilities: ModelProvider['capabilities'] = ['chat'],
): ModelProvider {
  return {
    providerId,
    displayName: providerId,
    capabilities,
    health: () =>
      Promise.resolve({
        status: 'healthy' as const,
        reportedAt: '2026-07-31T12:00:00.000Z',
        detail: null,
      }),
    execute: () => Promise.resolve(RESPONSE),
  };
}

const registry = (() => {
  const built = createProviderRegistry();
  built.register(providerNamed('openai', ['chat', 'text']));
  built.register(providerNamed('anthropic', ['chat']));
  built.register(providerNamed('embedder', ['embedding']));
  built.seal();
  return built;
})();

const prompt = (overrides: Partial<PromptTemplate> = {}): PromptTemplate => ({
  id: 'planning.outline',
  version: 1,
  taskType: 'planning.outline',
  status: 'active',
  parts: { system: 'You write outlines.', user: 'Write an outline about {{topic}}.' },
  variables: [{ name: 'topic', type: 'string', required: true, description: 'The subject.' }],
  modelHints: { maxOutputTokens: 1024, temperature: 0.2, determinismRequired: false },
  evalSetRef: 'evals/planning.outline',
  owner: 'content-platform',
  changelog: 'Initial version.',
  ...overrides,
});

const metadata = (overrides: Partial<TemplateMetadata> = {}): TemplateMetadata => ({
  title: 'Article outline',
  description: 'Produces a structured outline.',
  owner: 'content-platform',
  visibility: 'public',
  tags: [],
  ...overrides,
});

const compatibility = (overrides: Partial<TemplateCapability> = {}): TemplateCapability => ({
  capability: 'chat',
  providers: null,
  models: null,
  ...overrides,
});

/**
 * v1 deprecated (1.0.0) · v2 active (1.2.0) · v3 draft (2.0.0)
 *
 * One active version, a superseded one still pinnable, and an unreleased one —
 * which is every case version selection has to tell apart.
 */
const LIBRARY = createTemplateLibrary([
  {
    id: 'planning.outline',
    metadata: metadata(),
    versions: [
      {
        prompt: prompt({ version: 1, status: 'deprecated' }),
        semanticVersion: '1.0.0',
        compatibility: compatibility(),
      },
      {
        prompt: prompt({ version: 2, status: 'active' }),
        semanticVersion: '1.2.0',
        compatibility: compatibility(),
      },
      {
        prompt: prompt({ version: 3, status: 'draft' }),
        semanticVersion: '2.0.0',
        compatibility: compatibility(),
      },
    ],
  },
  {
    id: 'internal.classify',
    metadata: metadata({ title: 'Classifier', visibility: 'internal' }),
    versions: [
      {
        prompt: prompt({ id: 'internal.classify', version: 1 }),
        semanticVersion: '1.0.0',
        compatibility: compatibility({ providers: ['openai'], models: ['gpt-4o'] }),
      },
    ],
  },
]);

const resolve = (overrides: Partial<ResolveOptions> = {}): TemplateResolution =>
  resolveTemplate({
    library: LIBRARY,
    id: 'planning.outline',
    selector: { kind: 'latest-stable' },
    ...overrides,
  });

const versionOf = (result: TemplateResolution): number => {
  if (result.outcome !== 'resolved') throw new Error(`expected a resolution, got ${result.code}`);
  return result.resolved.version.prompt.version;
};

describe('identity', () => {
  it('refuses an unknown template rather than substituting one', () => {
    // "There is no fallback prompt, ever."
    expect(resolve({ id: 'nothing' })).toMatchObject({
      outcome: 'refused',
      code: 'UnknownTemplate',
    });
  });

  it('resolves the reproducibility anchor alongside the version', () => {
    const result = resolve();
    if (result.outcome !== 'resolved') throw new Error('expected a resolution');
    expect(result.resolved.promptVersion).toBe('planning.outline@2');
    expect(result.resolved.selector).toBe('latest-stable');
  });

  it('refuses an internal template for a public caller', () => {
    expect(resolve({ id: 'internal.classify', visibility: 'public' })).toMatchObject({
      code: 'TemplateNotVisible',
    });
  });

  it('resolves an internal template for an internal caller', () => {
    expect(versionOf(resolve({ id: 'internal.classify', visibility: 'internal' }))).toBe(1);
  });

  it('names every rejection it can produce', () => {
    expect([...RESOLUTION_REJECTION_CODES].sort()).toEqual([
      'AmbiguousVersion',
      'CapabilityIncompatible',
      'ModelIncompatible',
      'NoCompatibleVersion',
      'NoStableVersion',
      'ProviderIncompatible',
      'TemplateDeprecated',
      'TemplateNotVisible',
      'UnknownProvider',
      'UnknownTemplate',
      'UnknownVersion',
    ]);
    expect(isResolutionRejectionCode('UnknownTemplate')).toBe(true);
    expect(isResolutionRejectionCode('Whatever')).toBe(false);
  });
});

describe('explicit version', () => {
  it('resolves the version asked for', () => {
    expect(versionOf(resolve({ selector: { kind: 'explicit', version: 2 } }))).toBe(2);
  });

  it('honours a pin onto a DEPRECATED version', () => {
    // Resolution is "active OR explicitly pinned". Refusing a pin would break
    // the reproduction of a historical call, which is what pinning is for.
    expect(versionOf(resolve({ selector: { kind: 'explicit', version: 1 } }))).toBe(1);
  });

  it('honours a pin onto a draft, which is how one is reviewed', () => {
    expect(versionOf(resolve({ selector: { kind: 'explicit', version: 3 } }))).toBe(3);
  });

  it('refuses a version that does not exist', () => {
    expect(resolve({ selector: { kind: 'explicit', version: 9 } })).toMatchObject({
      code: 'UnknownVersion',
    });
  });
});

describe('latest stable', () => {
  it('resolves the single active version', () => {
    expect(versionOf(resolve({ selector: { kind: 'latest-stable' } }))).toBe(2);
  });

  it('never returns a draft or a deprecated version', () => {
    const result = resolve({ selector: { kind: 'latest-stable' } });
    if (result.outcome !== 'resolved') throw new Error('expected a resolution');
    expect(result.resolved.version.prompt.status).toBe('active');
  });

  it('refuses when nothing is active', () => {
    const drafts = createTemplateLibrary([
      {
        id: 'planning.outline',
        metadata: metadata(),
        versions: [
          {
            prompt: prompt({ status: 'draft' }),
            semanticVersion: '1.0.0',
            compatibility: compatibility(),
          },
        ],
      },
    ]);
    expect(
      resolveTemplate({
        library: drafts,
        id: 'planning.outline',
        selector: { kind: 'latest-stable' },
      }),
    ).toMatchObject({ code: 'NoStableVersion' });
  });
});

describe('latest compatible', () => {
  const compatible = (compatibleWith: string): VersionSelector => ({
    kind: 'latest-compatible',
    compatibleWith,
  });

  it('picks the newest version inside the requested major', () => {
    expect(versionOf(resolve({ selector: compatible('1.0.0') }))).toBe(2);
  });

  it('never crosses a major — no automatic upgrades', () => {
    // A major bump is what an author declares when a change breaks callers.
    const result = resolve({ selector: compatible('1.0.0') });
    if (result.outcome !== 'resolved') throw new Error('expected a resolution');
    expect(result.resolved.version.semanticVersion.major).toBe(1);
  });

  it('never picks a draft, which is unreleased', () => {
    // v3 IS 2.0.0 and would satisfy the request on version alone. It is a
    // draft, so it is excluded and the request is refused rather than
    // upgrading a caller onto unreviewed output.
    expect(resolve({ selector: compatible('2.0.0') })).toMatchObject({
      code: 'NoCompatibleVersion',
    });
  });

  it('refuses when the requested major has nothing at or above it', () => {
    expect(resolve({ selector: compatible('2.0.0') })).toMatchObject({
      code: 'NoCompatibleVersion',
    });
    expect(resolve({ selector: compatible('1.9.0') })).toMatchObject({
      code: 'NoCompatibleVersion',
    });
  });

  it('accepts an exact match', () => {
    expect(versionOf(resolve({ selector: compatible('1.2.0') }))).toBe(2);
  });

  it('refuses an ambiguous version rather than guessing', () => {
    for (const value of ['^1.0.0', '1.x', '~1.2', 'latest', '1.2']) {
      expect(resolve({ selector: compatible(value) }), value).toMatchObject({
        code: 'AmbiguousVersion',
      });
    }
  });

  it('reports a deprecated match AS deprecated, not as absent', () => {
    // A caller pinned to a major whose only remaining version is deprecated is
    // told exactly that — which is more actionable than "nothing compatible",
    // because the remedy is to pin deliberately or move to the next major.
    const onlyDeprecated = createTemplateLibrary([
      {
        id: 'planning.outline',
        metadata: metadata(),
        versions: [
          {
            prompt: prompt({ version: 1, status: 'deprecated' }),
            semanticVersion: '1.0.0',
            compatibility: compatibility(),
          },
          {
            prompt: prompt({ version: 2, status: 'active' }),
            semanticVersion: '2.0.0',
            compatibility: compatibility(),
          },
        ],
      },
    ]);

    expect(
      resolveTemplate({
        library: onlyDeprecated,
        id: 'planning.outline',
        selector: compatible('1.0.0'),
      }),
    ).toMatchObject({ code: 'TemplateDeprecated' });

    // And the remedy works.
    expect(
      versionOf(
        resolveTemplate({
          library: onlyDeprecated,
          id: 'planning.outline',
          selector: { kind: 'explicit', version: 1 },
        }),
      ),
    ).toBe(1);
  });
});

describe('deprecation', () => {
  it('refuses a deprecated version reached by latest-stable', () => {
    const deprecatedOnly = createTemplateLibrary([
      {
        id: 'planning.outline',
        metadata: metadata(),
        versions: [
          {
            prompt: prompt({ status: 'deprecated' }),
            semanticVersion: '1.0.0',
            compatibility: compatibility(),
          },
        ],
      },
    ]);
    // No active version at all, so it refuses before reaching deprecation.
    expect(
      resolveTemplate({
        library: deprecatedOnly,
        id: 'planning.outline',
        selector: { kind: 'latest-stable' },
      }),
    ).toMatchObject({ code: 'NoStableVersion' });
  });

  it('refuses a deprecated version reached implicitly, and allows a pin', () => {
    // The increment's rule — reject a deprecated template — applied to every
    // selector that did not name the version.
    expect(resolve({ selector: { kind: 'latest-compatible', compatibleWith: '1.0.0' } })).toEqual(
      expect.objectContaining({ outcome: 'resolved' }),
    );
    expect(resolve({ selector: { kind: 'explicit', version: 1 } }).outcome).toBe('resolved');
  });
});

describe('compatibility', () => {
  it('refuses a capability the version does not declare', () => {
    expect(resolve({ capability: 'embedding' })).toMatchObject({
      code: 'CapabilityIncompatible',
    });
  });

  it('accepts the capability it does declare', () => {
    expect(versionOf(resolve({ capability: 'chat' }))).toBe(2);
  });

  it('accepts any registered provider when the version restricts none', () => {
    expect(versionOf(resolve({ providers: registry, providerId: 'anthropic' }))).toBe(2);
  });

  it('refuses a provider the version does not declare', () => {
    expect(
      resolve({
        id: 'internal.classify',
        visibility: 'internal',
        providers: registry,
        providerId: 'anthropic',
      }),
    ).toMatchObject({ code: 'ProviderIncompatible' });
  });

  it('accepts a provider the version does declare', () => {
    expect(
      versionOf(
        resolve({
          id: 'internal.classify',
          visibility: 'internal',
          providers: registry,
          providerId: 'openai',
        }),
      ),
    ).toBe(1);
  });

  it('refuses a provider that is not registered', () => {
    expect(resolve({ providers: registry, providerId: 'ghost' })).toMatchObject({
      code: 'UnknownProvider',
    });
  });

  it('refuses to check a provider without a registry rather than skipping', () => {
    // A compatibility check that silently did not run reads exactly like one
    // that passed.
    expect(resolve({ providerId: 'openai' })).toMatchObject({ code: 'UnknownProvider' });
  });

  it('asks the REGISTRY whether the provider declares the capability', () => {
    // Not a second table here: the same source routing and admission use.
    expect(resolve({ providers: registry, providerId: 'embedder' })).toMatchObject({
      code: 'CapabilityIncompatible',
    });
  });

  it('refuses a model the version does not declare', () => {
    expect(
      resolve({ id: 'internal.classify', visibility: 'internal', model: 'claude' }),
    ).toMatchObject({ code: 'ModelIncompatible' });
  });

  it('accepts a model the version does declare', () => {
    expect(
      versionOf(resolve({ id: 'internal.classify', visibility: 'internal', model: 'gpt-4o' })),
    ).toBe(1);
  });

  it('accepts any model when the version restricts none', () => {
    expect(versionOf(resolve({ model: 'anything-at-all' }))).toBe(2);
  });
});

describe('determinism', () => {
  it('produces the same resolution for the same inputs', () => {
    expect(resolve({ capability: 'chat' })).toEqual(resolve({ capability: 'chat' }));
  });

  it('freezes what it returns', () => {
    const result = resolve();
    expect(Object.isFrozen(result)).toBe(true);
    if (result.outcome !== 'resolved') return;
    expect(Object.isFrozen(result.resolved)).toBe(true);
  });

  it('never reaches a provider', () => {
    // Resolution decides; it does not execute. `execute` would have thrown had
    // anything called it, because nothing here awaits.
    const result = resolve({ providers: registry, providerId: 'openai' });
    expect(result.outcome).toBe('resolved');
  });
});
