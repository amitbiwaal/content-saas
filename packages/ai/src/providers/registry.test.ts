/**
 * The provider registry.
 *
 * Two properties carry this file. A duplicate id must be refused, because the
 * winner would otherwise be decided by composition order and the loser is
 * unreachable code that looks live. And the registry must be shut after
 * startup, because a set of vendors that can change at any moment is one where
 * "the provider disappeared" has no fixed evidence.
 */
import { describe, expect, it } from 'vitest';

import type { AICapability, AIRequest, AIResponse } from '@contentos/contracts';

import type { ModelProvider } from './provider.js';
import {
  assertRegisterable,
  createProviderRegistry,
  PROVIDER_REGISTRY_ERROR_CODES,
  ProviderRegistryError,
  type ProviderRegistry,
} from './registry.js';

function provider(over: Partial<ModelProvider> = {}): ModelProvider {
  return {
    providerId: 'acme',
    displayName: 'Acme Models',
    capabilities: ['text', 'chat'],
    health: () =>
      Promise.resolve({
        status: 'healthy' as const,
        reportedAt: '2026-07-30T12:00:00.000Z',
        detail: null,
      }),
    execute: (_request: AIRequest): Promise<AIResponse> =>
      Promise.reject(new Error('not implemented in this fixture')),
    ...over,
  };
}

function loaded(...providers: ModelProvider[]): ProviderRegistry {
  const registry = createProviderRegistry();
  for (const p of providers) registry.register(p);
  return registry;
}

describe('registration', () => {
  it('registers and returns a provider', () => {
    const registry = loaded(provider());
    expect(registry.get('acme').displayName).toBe('Acme Models');
    expect(registry.has('acme')).toBe(true);
  });

  it('keeps registration order', () => {
    const registry = loaded(
      provider({ providerId: 'first' }),
      provider({ providerId: 'second' }),
      provider({ providerId: 'third' }),
    );
    expect(registry.listIds()).toEqual(['first', 'second', 'third']);
  });

  // A second registration would silently shadow the first, and which one wins
  // would depend on the order a composition root happened to use.
  it('refuses a duplicate provider id', () => {
    const registry = loaded(provider());
    expect(() => {
      registry.register(provider({ displayName: 'A different adapter' }));
    }).toThrow(ProviderRegistryError);
  });

  it('reports a duplicate as DuplicateProvider and names the id', () => {
    const registry = loaded(provider());
    try {
      registry.register(provider());
      expect.unreachable('must refuse');
    } catch (error) {
      expect((error as ProviderRegistryError).code).toBe('DuplicateProvider');
      expect((error as ProviderRegistryError).message).toContain('acme');
    }
  });

  it('leaves the first registration intact after a rejected duplicate', () => {
    const registry = loaded(provider());
    expect(() => {
      registry.register(provider({ displayName: 'Impostor' }));
    }).toThrow();
    expect(registry.get('acme').displayName).toBe('Acme Models');
    expect(registry.list()).toHaveLength(1);
  });

  it('allows a different id for the same vendor family', () => {
    const registry = loaded(
      provider({ providerId: 'azure-openai' }),
      provider({ providerId: 'openai' }),
    );
    expect(registry.listIds()).toEqual(['azure-openai', 'openai']);
  });
});

describe('the shape a provider must have to be registerable', () => {
  it('refuses an id that is not lowercase dot- or dash-separated', () => {
    for (const providerId of ['Acme', 'acme provider', 'acme_provider', '1acme', '', 'acme.']) {
      expect(() => {
        assertRegisterable(provider({ providerId }));
      }, providerId).toThrow(/must be lowercase/);
    }
  });

  it('accepts the ids adapters will actually use', () => {
    for (const providerId of [
      'openai',
      'anthropic',
      'openrouter',
      'azure-openai',
      'google.vertex',
    ]) {
      expect(() => {
        assertRegisterable(provider({ providerId }));
      }, providerId).not.toThrow();
    }
  });

  // An operator reading a provider list would see a blank row.
  it('refuses a blank display name', () => {
    expect(() => {
      assertRegisterable(provider({ displayName: '   ' }));
    }).toThrow(/display name/);
  });

  // Registering it is indistinguishable from not registering it — except that
  // it looks done.
  it('refuses a provider that declares no capability', () => {
    expect(() => {
      assertRegisterable(provider({ capabilities: [] }));
    }).toThrow(/no capabilities/);
  });

  it('refuses a duplicated capability', () => {
    expect(() => {
      assertRegisterable(provider({ capabilities: ['text', 'text'] }));
    }).toThrow(/twice/);
  });

  it('reports every shape failure as InvalidProvider', () => {
    const registry = createProviderRegistry();
    try {
      registry.register(provider({ capabilities: [] }));
      expect.unreachable('must refuse');
    } catch (error) {
      expect((error as ProviderRegistryError).code).toBe('InvalidProvider');
    }
  });
});

describe('lookup', () => {
  // An undefined flowing onward surfaces later as a failure that names nothing.
  it('throws on an unknown id rather than returning undefined', () => {
    const registry = loaded(provider());
    expect(() => registry.get('nobody')).toThrow(ProviderRegistryError);
  });

  it('names what IS registered, so the typo is visible', () => {
    const registry = loaded(provider({ providerId: 'openai' }));
    try {
      registry.get('opena');
      expect.unreachable('must throw');
    } catch (error) {
      expect((error as ProviderRegistryError).code).toBe('UnknownProvider');
      expect((error as ProviderRegistryError).message).toContain('openai');
    }
  });

  it('says so plainly when nothing is registered', () => {
    expect(() => createProviderRegistry().get('openai')).toThrow(/\(none\)/);
  });

  it('reports absence without throwing, for callers that can cope', () => {
    expect(loaded(provider()).has('nobody')).toBe(false);
  });
});

describe('capability discovery', () => {
  const registry = loaded(
    provider({ providerId: 'text-only', capabilities: ['text'] }),
    provider({ providerId: 'multimodal', capabilities: ['text', 'chat', 'vision', 'image'] }),
    provider({ providerId: 'embedder', capabilities: ['embedding'] }),
  );

  it('reports what one provider declares', () => {
    expect(registry.capabilitiesOf('embedder')).toEqual(['embedding']);
  });

  it('finds every provider with a capability', () => {
    expect(registry.providersWith('text').map((p) => p.providerId)).toEqual([
      'text-only',
      'multimodal',
    ]);
  });

  it('finds the one provider with a rare capability', () => {
    expect(registry.providersWith('vision').map((p) => p.providerId)).toEqual(['multimodal']);
  });

  it('returns nothing for a capability nobody declares', () => {
    expect(registry.providersWith('audio')).toEqual([]);
  });

  // Discovery, not routing: it ranks nothing. Two providers that both declare a
  // capability come back in registration order, and choosing between them
  // belongs to a component that can see budget, health and policy.
  it('ranks nothing, returning registration order', () => {
    const ids = registry.providersWith('text').map((p) => p.providerId);
    expect(ids).toEqual([...ids]);
    expect(ids[0]).toBe('text-only');
  });

  it('throws for the capabilities of a provider that does not exist', () => {
    expect(() => registry.capabilitiesOf('ghost')).toThrow(/UnknownProvider|No provider/);
  });
});

describe('immutability after startup', () => {
  it('is open before sealing', () => {
    const registry = createProviderRegistry();
    expect(registry.sealed).toBe(false);
    expect(() => {
      registry.register(provider());
    }).not.toThrow();
  });

  it('reports itself sealed', () => {
    const registry = loaded(provider());
    registry.seal();
    expect(registry.sealed).toBe(true);
  });

  it('refuses a registration after sealing', () => {
    const registry = loaded(provider());
    registry.seal();
    expect(() => {
      registry.register(provider({ providerId: 'late' }));
    }).toThrow(ProviderRegistryError);
  });

  it('refuses an unregistration after sealing', () => {
    const registry = loaded(provider());
    registry.seal();
    expect(() => {
      registry.unregister('acme');
    }).toThrow(/sealed/);
  });

  it('reports a write after sealing as RegistrySealed', () => {
    const registry = loaded(provider());
    registry.seal();
    try {
      registry.register(provider({ providerId: 'late' }));
      expect.unreachable('must refuse');
    } catch (error) {
      expect((error as ProviderRegistryError).code).toBe('RegistrySealed');
    }
  });

  it('still reads after sealing — that is the point of sealing', () => {
    const registry = loaded(provider());
    registry.seal();
    expect(registry.get('acme').providerId).toBe('acme');
    expect(registry.list()).toHaveLength(1);
    expect(registry.providersWith('chat')).toHaveLength(1);
  });

  // A caller that mutated the returned array would be editing the registry
  // through a value it was merely shown.
  it('hands out a frozen list', () => {
    const registry = loaded(provider());
    const list = registry.list();
    expect(Object.isFrozen(list)).toBe(true);
    expect(() => (list as ModelProvider[]).push(provider({ providerId: 'sneak' }))).toThrow();
    expect(registry.list()).toHaveLength(1);
  });

  it('freezes the id list and every capability query too', () => {
    const registry = loaded(provider());
    expect(Object.isFrozen(registry.listIds())).toBe(true);
    expect(Object.isFrozen(registry.providersWith('text'))).toBe(true);
  });

  // Defensive sealing must be possible; a root that seals twice made no mistake.
  it('seals idempotently', () => {
    const registry = loaded(provider());
    registry.seal();
    expect(() => {
      registry.seal();
    }).not.toThrow();
    expect(registry.sealed).toBe(true);
  });
});

describe('unregistration, before the door closes', () => {
  // What lets a composition root swap a live adapter for a double without
  // building a second registry.
  it('removes a provider', () => {
    const registry = loaded(provider(), provider({ providerId: 'other' }));
    registry.unregister('acme');
    expect(registry.has('acme')).toBe(false);
    expect(registry.listIds()).toEqual(['other']);
  });

  it('frees the id for a replacement', () => {
    const registry = loaded(provider());
    registry.unregister('acme');
    expect(() => {
      registry.register(provider({ displayName: 'Acme, doubled' }));
    }).not.toThrow();
    expect(registry.get('acme').displayName).toBe('Acme, doubled');
  });

  it('refuses to remove what was never there', () => {
    const registry = loaded(provider());
    try {
      registry.unregister('ghost');
      expect.unreachable('must refuse');
    } catch (error) {
      expect((error as ProviderRegistryError).code).toBe('UnknownProvider');
    }
  });
});

describe('startup verification', () => {
  it('seals an empty registry — this increment ships no adapters', () => {
    const registry = createProviderRegistry();
    expect(() => {
      registry.seal();
    }).not.toThrow();
    expect(registry.list()).toEqual([]);
  });

  // `capabilities` is readonly to the type system only. A provider handed a
  // shared array can have its declaration change between being registered and
  // the process starting, and re-checking is what makes the declaration true
  // AT STARTUP rather than true once.
  it('catches a declaration that changed after registration', () => {
    const mutable: AICapability[] = ['text'];
    const registry = loaded(provider({ capabilities: mutable }));
    mutable.length = 0;

    expect(() => {
      registry.seal();
    }).toThrow(/no capabilities/);
    expect(registry.sealed).toBe(false);
  });

  it('catches a provider that changed its own id', () => {
    const drifting = { ...provider(), providerId: 'acme' };
    const registry = loaded(drifting as ModelProvider);
    (drifting as { providerId: string }).providerId = 'someone-else';

    expect(() => {
      registry.seal();
    }).toThrow(/disagrees about who it is/);
  });

  // A root wrong in two places should learn both in one cycle.
  it('reports every startup issue, not the first', () => {
    const a: AICapability[] = ['text'];
    const b: AICapability[] = ['chat'];
    const registry = loaded(
      provider({ providerId: 'one', capabilities: a }),
      provider({ providerId: 'two', capabilities: b }),
    );
    a.length = 0;
    b.length = 0;

    try {
      registry.seal();
      expect.unreachable('must refuse');
    } catch (error) {
      const message = (error as ProviderRegistryError).message;
      expect(message).toContain("'one'");
      expect(message).toContain("'two'");
    }
  });

  it('leaves the registry open when verification fails, so it can be fixed', () => {
    const mutable: AICapability[] = ['text'];
    const registry = loaded(provider({ capabilities: mutable }));
    mutable.length = 0;

    expect(() => {
      registry.seal();
    }).toThrow();
    expect(registry.sealed).toBe(false);
    expect(() => {
      registry.unregister('acme');
    }).not.toThrow();
    expect(() => {
      registry.seal();
    }).not.toThrow();
  });

  it('names its error codes in one place', () => {
    expect([...PROVIDER_REGISTRY_ERROR_CODES].sort()).toEqual([
      'DuplicateProvider',
      'InvalidProvider',
      'RegistrySealed',
      'UnknownProvider',
    ]);
  });
});
