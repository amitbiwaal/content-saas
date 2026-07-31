/**
 * The ExecutionPlan — what routing decides, and the only thing it produces.
 *
 * Spec: `08-ai-platform/model-router.md`, ADR-008 — "the only component that
 * decides which model executes a request", and the division that matters most:
 * "The Router selects; the Gateway dispatches; the retry strategy decides when
 * to advance the chain. Three components, three decisions, no overlap."
 *
 * ── A plan is a decision, not an instruction to act ─────────────────────────
 * Nothing here executes. There is no provider call, no dispatch, no timer, and
 * no way to reach one: a plan carries identifiers and modes, and the component
 * that performs the work is the workflow runtime. A router that could execute
 * would be a router whose decisions cannot be inspected before they cost money.
 *
 * ── Frozen, because a plan is evidence ──────────────────────────────────────
 * `readonly` is a compile-time promise a cast erases. These are deep frozen, so
 * a downstream component that "just swaps the model" fails at runtime rather
 * than silently executing against something the decision never chose — and the
 * audit record and the actual call cannot disagree.
 *
 * ── Two fields the increment did not list, and why they are here ────────────
 * `policyVersion` — spec rule 4: "Every decision records `policyVersion`,
 * making any historical call reproducible", and it is one of the four inputs to
 * `algorithmVersion` under ADR-021. A plan without it is a decision nobody can
 * reproduce once the table changes.
 *
 * `reasons` — the spec's routing reason codes, which make "why did this cost
 * what it cost?" answerable from telemetry rather than by inference. Health is
 * the one non-deterministic input to routing, and a reason code is where that
 * gets recorded.
 *
 * Both are a few bytes and neither changes what routing DOES.
 */

import type { AICapability } from '@contentos/contracts';

/** How the result will be delivered. Decided by the caller, not by policy. */
export const EXECUTION_MODES = ['buffered', 'streaming'] as const;

export type ExecutionMode = (typeof EXECUTION_MODES)[number];

/**
 * What the chosen provider can do, as opposed to what was asked for.
 *
 * Kept alongside `executionMode` rather than collapsed into it because they
 * answer different questions: one is the caller's request, the other is the
 * target's capability. A plan where they conflict is refused rather than
 * represented — see `StreamingUnsupported` — so a valid plan always agrees with
 * itself, and a buffered plan still records that its provider COULD stream.
 */
export const STREAMING_MODES = ['native', 'unsupported'] as const;

export type StreamingMode = (typeof STREAMING_MODES)[number];

/**
 * Which policy produced the choice.
 *
 * Ordered from most specific to least, and evaluated in exactly this order —
 * the whole of "deterministic routing" is that this list has no ties.
 */
export const ROUTING_POLICIES = [
  'explicit',
  'workspace-default',
  'organization-default',
  'global-default',
  'capability',
] as const;

export type RoutingPolicyName = (typeof ROUTING_POLICIES)[number];

/**
 * Reason codes, from the registry `model-router.md` §Explainability defines.
 *
 * The spec's own names are used where the meaning matches, so a trace produced
 * here reads the same as the document describes. Codes it defines for features
 * this increment does not implement — budget filtering, tier escalation,
 * circuit state — are deliberately absent rather than stubbed.
 */
export const ROUTING_REASONS = [
  'routing.explicit_provider',
  'routing.workspace_default',
  'routing.organization_default',
  'routing.global_default',
  'routing.capability_selected',
  'routing.capability_filtered',
  'routing.health_filtered',
  'routing.health_degraded',
  'routing.model_alias_resolved',
  'routing.streaming_required',
  'routing.fallback_planned',
  'routing.no_fallback_available',
] as const;

export type RoutingReason = (typeof ROUTING_REASONS)[number];

export function isRoutingReason(value: unknown): value is RoutingReason {
  return typeof value === 'string' && (ROUTING_REASONS as readonly string[]).includes(value);
}

/**
 * One place the work could run.
 *
 * The primary and every fallback share this shape, so advancing a chain is
 * reading the next element rather than re-deriving anything — which is what
 * lets the retry framework advance without knowing how routing works.
 */
export interface RouteTarget {
  readonly providerId: string;
  /**
   * The VENDOR model string, already resolved. This is what an adapter sends.
   *
   * An alias never reaches here: `model-router.md` requires that resolution
   * happen once, and a downstream component that received `'fast'` would have
   * to resolve it again, against a table it does not have.
   */
  readonly model: string;
  /**
   * The platform's stable name for this model.
   *
   * Survives a vendor snapshot bump, which is what makes a provider upgrade a
   * catalogue edit rather than a break in every cost report and audit record
   * that referenced the old string.
   */
  readonly canonicalModel: string;
  readonly streamingMode: StreamingMode;
}

export interface ExecutionPlan extends RouteTarget {
  readonly capability: AICapability;
  readonly executionMode: ExecutionMode;
  /**
   * Ordered alternatives, most preferred first. MAY be empty.
   *
   * Prepared, never taken: "the Router supplies the chain, not the schedule"
   * (`retry-strategy.md` owns when it advances). Nothing in this package moves
   * along this list.
   */
  readonly fallbacks: readonly RouteTarget[];
  /** Which policy chose the primary. */
  readonly policy: RoutingPolicyName;
  /** The routing table version this decision came from. Spec rule 4. */
  readonly policyVersion: string;
  readonly reasons: readonly RoutingReason[];
}

export const ROUTING_REJECTION_CODES = [
  'UnknownProvider',
  'UnknownModel',
  'ModelNotOnProvider',
  'CapabilityUnavailable',
  'ProviderUnhealthy',
  'StreamingUnsupported',
  'NoRouteConfigured',
] as const;

export type RoutingRejectionCode = (typeof ROUTING_REJECTION_CODES)[number];

export function isRoutingRejectionCode(value: unknown): value is RoutingRejectionCode {
  return (
    typeof value === 'string' && (ROUTING_REJECTION_CODES as readonly string[]).includes(value)
  );
}

/**
 * The verdict.
 *
 * A refusal is a value, not an exception, for the same reason admission's is: a
 * caller that must catch to discover it will eventually forget, and a routing
 * failure that escapes as a 500 loses the reason it happened.
 */
export type RoutingResult =
  | { readonly outcome: 'routed'; readonly plan: ExecutionPlan }
  | {
      readonly outcome: 'refused';
      readonly code: RoutingRejectionCode;
      /** For operators. Never returned to a caller — see `ai/http.ts`. */
      readonly reason: string;
      readonly reasons: readonly RoutingReason[];
    };

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.getOwnPropertyNames(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

/** A plan, frozen through. See the file header for why that matters. */
export function freezePlan(plan: ExecutionPlan): ExecutionPlan {
  return deepFreeze(plan);
}
