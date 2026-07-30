/**
 * What a provider can do — the coarse capability vocabulary.
 *
 * Spec: `08-ai-platform/provider-adapters.md` §"Capability declaration".
 *
 * ── Why this is coarse, and what it is NOT ──────────────────────────────────
 * The spec's `ModelCapability` describes ONE MODEL in detail: context window,
 * tokenizer, structured-output support, cost per 1k tokens, typical latency.
 * That is the Router's input, and the Router is not in this increment.
 *
 * This is the other half — what KIND of work a provider does at all. It answers
 * "which providers can embed?", never "which model should run this?". The
 * distinction matters: the moment a capability carries a quality or a price,
 * discovery has become routing, and routing belongs to a component that can see
 * budget, health and policy together.
 *
 * Lowercase, as every other status vocabulary on this platform is. The
 * increment names them in capitals; the vocabulary is the same six.
 */

export const AI_CAPABILITIES = ['text', 'chat', 'image', 'embedding', 'vision', 'audio'] as const;

export type AICapability = (typeof AI_CAPABILITIES)[number];

export function isAICapability(value: unknown): value is AICapability {
  return typeof value === 'string' && (AI_CAPABILITIES as readonly string[]).includes(value);
}
