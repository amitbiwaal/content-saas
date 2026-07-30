/**
 * The `ModelProvider` port.
 *
 * Spec: `08-ai-platform/provider-adapters.md` §"The port". This file is the
 * PORT; concrete adapters implement it in this directory, which is the only
 * place model provider SDKs may be imported (ADR-019, enforced by lint).
 *
 * ── An adapter translates and reports. It never decides ─────────────────────
 * No adapter retries on its own schedule, substitutes a model, caches, or
 * interprets content. Those are platform decisions made by components that can
 * see budget, health and policy together. The port is shaped so that an adapter
 * doing any of them would have nowhere to put the result.
 *
 * ── Deviations from the spec, and why ───────────────────────────────────────
 * The spec's port is `complete` · `stream` · `embed?` · `capabilities()` ·
 * `health()` · `countTokens`. This increment defines `execute` alone.
 *
 *   - `stream` — streaming is out of scope. A half-defined streaming method is
 *     worse than none: callers would code against semantics nothing enforces.
 *   - `embed` — reachable through `execute` with `capability: 'embedding'`.
 *     Where the spec has one method per shape, this increment has one method
 *     and a declared capability, which is what "no provider-specific request
 *     types" requires.
 *   - `countTokens` — token counting belongs with the tokenizer work in
 *     `cost-management.md`; nothing here prices anything.
 *   - `capabilities()` is a DECLARED array here, not an async probe. The
 *     registry publishes capabilities at startup, and an async probe would make
 *     `list()` an I/O operation and startup dependent on every vendor being
 *     reachable. Verified discovery arrives with `ProviderCapabilityChanged`,
 *     which is not in this increment.
 */

import type { AICapability, AIRequest, AIResponse } from '@contentos/contracts';

/**
 * Provider-REPORTED status. Nothing polls, and nothing here runs in the
 * background — a monitor that probed on a timer would be a second source of
 * truth about a vendor's health, disagreeing with the calls actually failing.
 */
export const PROVIDER_HEALTH_STATUSES = ['healthy', 'degraded', 'offline'] as const;

export type ProviderHealthStatus = (typeof PROVIDER_HEALTH_STATUSES)[number];

export function isProviderHealthStatus(value: unknown): value is ProviderHealthStatus {
  return (
    typeof value === 'string' && (PROVIDER_HEALTH_STATUSES as readonly string[]).includes(value)
  );
}

export interface ProviderHealth {
  readonly status: ProviderHealthStatus;
  /** ISO 8601 UTC. When the PROVIDER last established this, not when asked. */
  readonly reportedAt: string;
  /** Why, when it is not healthy. Null when there is nothing to say. */
  readonly detail: string | null;
}

/**
 * Every provider, behind one interface.
 *
 * Nothing above the Gateway can tell which vendor executed a request — and
 * nothing needs to. That is the property the port delivers, and it is why
 * `providerId` is documented as visible only within this layer.
 */
export interface ModelProvider {
  /** Stable, lowercase, dot-separated: 'openai', 'anthropic', 'openrouter'. */
  readonly providerId: string;
  /** For operators, in an admin list. Never used to make a decision. */
  readonly displayName: string;
  /**
   * What this provider can do at all.
   *
   * Declared, not assumed: a mis-declaration produces a request that cannot
   * succeed, so the registry rejects a provider that declares nothing and the
   * caller's capability is checked against this before `execute` is reached.
   */
  readonly capabilities: readonly AICapability[];

  /** Provider-reported. Called on demand, never on a timer. */
  health(): Promise<ProviderHealth>;

  /**
   * Run one request.
   *
   * Takes the canonical `AIRequest` and returns the canonical `AIResponse` —
   * there is no provider-shaped request type anywhere in this platform.
   *
   * On failure this rejects with a `ProviderError` carrying a code from the
   * fixed taxonomy. A raw vendor error escaping is a defect; `normalizeError`
   * in this directory is what an adapter uses so that it cannot happen.
   */
  execute(request: AIRequest): Promise<AIResponse>;
}

/** True when the provider declares every capability asked of it. */
export function supportsCapability(provider: ModelProvider, capability: AICapability): boolean {
  return provider.capabilities.includes(capability);
}
