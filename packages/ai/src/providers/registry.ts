/**
 * The provider registry.
 *
 * Spec: `08-ai-platform/provider-adapters.md` §APIs —
 * `ProviderRegistry.resolve(...)`, and §"Adapter registration and lifecycle".
 *
 * ── This is not a second event registry ─────────────────────────────────────
 * It maps provider ids to adapters; the event registry maps event types to
 * declarations. What they share is a DISCIPLINE, applied here rather than
 * duplicated: assembled once at the process edge, refuses duplicates, verified
 * at startup, and immutable afterwards. Nothing in `packages/events` is
 * reimplemented — this package cannot import it, and would not need to.
 *
 * ── Immutable after startup ─────────────────────────────────────────────────
 * `register` and `unregister` exist for composition; `seal()` ends it. After
 * sealing, both throw. The alternative — a registry that accepts a provider at
 * any moment — means the set of reachable vendors depends on when you looked,
 * and an incident where "the provider disappeared" has no fixed evidence.
 *
 * `unregister` before sealing is what makes a composition root able to build a
 * variant (a test double replacing a live adapter) without a second registry.
 */

import type { AICapability } from '@contentos/contracts';

import type { ModelProvider } from './provider.js';

export const PROVIDER_REGISTRY_ERROR_CODES = [
  'DuplicateProvider',
  'UnknownProvider',
  'RegistrySealed',
  'InvalidProvider',
] as const;

export type ProviderRegistryErrorCode = (typeof PROVIDER_REGISTRY_ERROR_CODES)[number];

export class ProviderRegistryError extends Error {
  readonly code: ProviderRegistryErrorCode;

  constructor(code: ProviderRegistryErrorCode, message: string) {
    super(message);
    this.name = 'ProviderRegistryError';
    this.code = code;
  }
}

/** Lowercase, dot- or dash-separated. Matches the id an operator would type. */
const PROVIDER_ID = /^[a-z][a-z0-9]*([.-][a-z0-9]+)*$/;

/**
 * What a provider must satisfy to be registerable.
 *
 * Checked at REGISTRATION, not at seal, so the error names the call that made
 * the mistake rather than a composition root that merely finished.
 */
export function assertRegisterable(provider: ModelProvider): void {
  if (!PROVIDER_ID.test(provider.providerId)) {
    throw new ProviderRegistryError(
      'InvalidProvider',
      `Provider id '${provider.providerId}' must be lowercase alphanumeric, dot- or dash-separated: 'openai', 'azure-openai'.`,
    );
  }
  if (provider.displayName.trim() === '') {
    throw new ProviderRegistryError(
      'InvalidProvider',
      `Provider '${provider.providerId}' has no display name; an operator reading a provider list would see a blank row.`,
    );
  }
  // A provider that declares nothing can never be discovered, so registering it
  // is indistinguishable from not registering it — except that it looks done.
  if (provider.capabilities.length === 0) {
    throw new ProviderRegistryError(
      'InvalidProvider',
      `Provider '${provider.providerId}' declares no capabilities, so nothing could ever route to it.`,
    );
  }
  const seen = new Set<AICapability>();
  for (const capability of provider.capabilities) {
    if (seen.has(capability)) {
      throw new ProviderRegistryError(
        'InvalidProvider',
        `Provider '${provider.providerId}' declares '${capability}' twice.`,
      );
    }
    seen.add(capability);
  }
}

export interface ProviderRegistry {
  /** Throws once sealed, and on a duplicate id. */
  register(provider: ModelProvider): void;
  /** Throws once sealed, and on an id that was never registered. */
  unregister(providerId: string): void;
  /** Throws on an unknown id — see the note on the implementation. */
  get(providerId: string): ModelProvider;
  has(providerId: string): boolean;
  /** Registration order, frozen. */
  list(): readonly ModelProvider[];
  listIds(): readonly string[];
  capabilitiesOf(providerId: string): readonly AICapability[];
  /**
   * Every provider declaring this capability, in registration order.
   *
   * DISCOVERY, not routing: it ranks nothing and chooses nothing. Which of
   * these should run a given request depends on budget, health, latency and
   * policy together, and belongs to `model-router.md`.
   */
  providersWith(capability: AICapability): readonly ModelProvider[];
  /** Ends registration and runs the startup checks. Idempotent. */
  seal(): void;
  readonly sealed: boolean;
}

export function createProviderRegistry(): ProviderRegistry {
  const providers = new Map<string, ModelProvider>();
  let sealed = false;

  const refuseIfSealed = (action: string): void => {
    if (sealed) {
      throw new ProviderRegistryError(
        'RegistrySealed',
        `Cannot ${action} after startup: the provider registry is sealed. The set of reachable providers is fixed when the process starts, so that which vendors exist does not depend on when you looked.`,
      );
    }
  };

  return {
    register(provider): void {
      refuseIfSealed(`register '${provider.providerId}'`);
      assertRegisterable(provider);
      // Two adapters answering to one id means the one that wins is decided by
      // composition order, and the loser is unreachable code that looks live.
      if (providers.has(provider.providerId)) {
        throw new ProviderRegistryError(
          'DuplicateProvider',
          `Provider '${provider.providerId}' is already registered. Ids are unique: a second registration would silently shadow the first.`,
        );
      }
      providers.set(provider.providerId, provider);
    },

    unregister(providerId): void {
      refuseIfSealed(`unregister '${providerId}'`);
      if (!providers.delete(providerId)) {
        throw new ProviderRegistryError(
          'UnknownProvider',
          `Provider '${providerId}' is not registered, so there is nothing to remove. Registered: ${[...providers.keys()].join(', ') || '(none)'}.`,
        );
      }
    },

    // Throws rather than returning undefined. A caller that asked for a
    // provider by id has already decided it needs one, and an undefined
    // flowing onward surfaces later as a failure that names nothing.
    get(providerId): ModelProvider {
      const provider = providers.get(providerId);
      if (provider === undefined) {
        throw new ProviderRegistryError(
          'UnknownProvider',
          `No provider '${providerId}' is registered. Registered: ${[...providers.keys()].join(', ') || '(none)'}.`,
        );
      }
      return provider;
    },

    has(providerId): boolean {
      return providers.has(providerId);
    },

    list(): readonly ModelProvider[] {
      return Object.freeze([...providers.values()]);
    },

    listIds(): readonly string[] {
      return Object.freeze([...providers.keys()]);
    },

    capabilitiesOf(providerId): readonly AICapability[] {
      return this.get(providerId).capabilities;
    },

    providersWith(capability): readonly ModelProvider[] {
      return Object.freeze(
        [...providers.values()].filter((p) => p.capabilities.includes(capability)),
      );
    },

    /**
     * Startup verification, then the door closes.
     *
     * Every provider is re-checked against the same rules registration applied.
     * That is not redundant: `capabilities` is `readonly` to the type system
     * only, and a provider handed a shared array can have its declaration
     * change between being registered and the process starting. Re-checking
     * here is what makes the declaration true AT STARTUP rather than true once.
     *
     * Every issue is reported, not the first, so a composition root that is
     * wrong in two places learns both in one cycle.
     *
     * An EMPTY registry seals successfully and that is correct for now — this
     * increment ships no adapters, and refusing to start a process because no
     * vendor is configured would be a rule about deployment, not about the
     * registry.
     */
    seal(): void {
      // Idempotent: a composition root that seals twice has made no mistake,
      // and throwing would make defensive sealing impossible.
      if (sealed) return;

      const issues: string[] = [];
      for (const [id, provider] of providers) {
        if (provider.providerId !== id) {
          issues.push(
            `registered as '${id}' but now reports '${provider.providerId}'; lookups by the registered id would return a provider that disagrees about who it is`,
          );
        }
        try {
          assertRegisterable(provider);
        } catch (error) {
          issues.push(error instanceof Error ? error.message : String(error));
        }
      }

      if (issues.length > 0) {
        throw new ProviderRegistryError(
          'InvalidProvider',
          `The provider registry cannot be sealed:\n  - ${issues.join('\n  - ')}`,
        );
      }

      sealed = true;
    },

    get sealed(): boolean {
      return sealed;
    },
  };
}
