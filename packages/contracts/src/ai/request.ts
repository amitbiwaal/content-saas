/**
 * `AIRequest` — the canonical request. FROZEN.
 *
 * Spec: `08-ai-platform/ai-gateway.md` §Inputs, and
 * `01-system-architecture/04-context-map.md`, which names `AIRequest`/
 * `AIResponse` the AI Capability's OPEN HOST SERVICE: "one published interface
 * serves every context; no context negotiates a bespoke AI integration."
 *
 * That is why these types live in `@contentos/contracts` rather than beside the
 * provider port. An engine in `packages/content` issues an `AIRequest`, and two
 * feature packages may not import each other — so a shape defined in
 * `packages/ai` would be one no engine could name.
 *
 * ── There is no provider-shaped request, by design ──────────────────────────
 * Every provider receives THIS. An adapter translates it to the vendor's shape
 * and back; a vendor introducing a novel concept is the adapter's problem to map
 * or to decline at capability-declaration time, never something that reshapes
 * the platform's interface (provider-adapters.md, domain rule 10: adding a
 * provider requires zero change to any component in `08-ai-platform/`).
 *
 * ── Fields the Gateway spec declares that are deliberately absent ───────────
 * `templateRef`, `variables`, `contextRefs`, `outputSchema`, `tierHint`,
 * `latencySla`, `budget`, `stream`, `attribution`.
 *
 * Each is owned by a component that does not exist yet — the Prompt Engine, the
 * Context Builder, response validation, the Router, cost management, streaming.
 * A field nothing populates and nothing honours is a promise the platform does
 * not keep: the Gateway spec requires `templateRef` to be RESOLVABLE at
 * admission, and there is nothing here that could resolve one. They arrive with
 * the components that own them.
 *
 * What remains is what the port genuinely needs, plus the identifiers every
 * caller already has.
 */

import type { AICapability } from './capability.js';

/**
 * The message roles the platform speaks. NOT a vendor's set — adapters map to
 * and from these.
 *
 * `tool` is absent: tool calling is not in this increment, and `FinishReason`
 * carries `tool_call` only because the spec's finish-reason set is fixed.
 */
export const AI_ROLES = ['system', 'user', 'assistant'] as const;

export type AIRole = (typeof AI_ROLES)[number];

export interface AIMessage {
  readonly role: AIRole;
  readonly content: string;
}

/**
 * Generation parameters.
 *
 * `temperature` and `maxOutputTokens` are required rather than optional: a
 * request that leaves them unstated inherits whatever the vendor's default
 * happens to be that month, which makes two runs of the same work
 * incomparable and a regression impossible to attribute.
 */
export interface AIParameters {
  readonly temperature: number;
  readonly maxOutputTokens: number;
  readonly topP?: number;
  /** Determinism where the provider supports it; declared per model. */
  readonly seed?: number;
  readonly stopSequences?: readonly string[];
}

export interface AIRequest {
  /**
   * Dot.case, and OPAQUE to this platform (`ai-gateway.md`): 'planning.outline'.
   * It is the caller's word for the work, carried for metering and diagnostics.
   */
  readonly taskType: string;
  /** Which kind of work this is — the provider must declare this capability. */
  readonly capability: AICapability;
  /**
   * The model asked for.
   *
   * A vendor model string is resolved INSIDE the adapter layer and never
   * appears above it (provider-adapters.md, domain rule 7). Until the Router
   * exists there is no `ModelHandle` to resolve from, so this carries the
   * caller's request directly and an adapter maps it.
   */
  readonly model: string;
  readonly messages: readonly AIMessage[];
  readonly params: AIParameters;
  /**
   * Supplied per request; adapters never extend it
   * (provider-adapters.md §Performance).
   */
  readonly timeoutMs: number;
  /**
   * Required on every request (`ai-gateway.md`). Passed through wherever the
   * provider supports it, so idempotency holds even if our record of an attempt
   * is lost mid-flight.
   */
  readonly idempotencyKey: string;
  /** Propagated from the originating request; the primary incident query. */
  readonly correlationId: string;
  /**
   * Workspace (ADR-017) and the commercial boundary.
   *
   * For admission, metering and audit — NOT for transmission. An adapter must
   * not send these to a vendor, and must not log the payload it transmits
   * (provider-adapters.md §Security).
   */
  readonly tenantId: string;
  readonly organizationId: string;
}

/**
 * The request field names, frozen. Used by validation and by the conformance
 * suite that asserts the contract has not drifted — the same discipline
 * `ENVELOPE_FIELDS` applies to the event envelope.
 */
export const AI_REQUEST_FIELDS = [
  'taskType',
  'capability',
  'model',
  'messages',
  'params',
  'timeoutMs',
  'idempotencyKey',
  'correlationId',
  'tenantId',
  'organizationId',
] as const;

export type AIRequestField = (typeof AI_REQUEST_FIELDS)[number];
