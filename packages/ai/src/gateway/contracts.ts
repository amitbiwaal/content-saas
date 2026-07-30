/**
 * The Gateway's contracts.
 *
 * Spec: `08-ai-platform/ai-gateway.md` — "the single, governed egress from
 * every caller to model intelligence" (ADR-008), and the design posture that
 * matters most: "the Gateway is an ORCHESTRATOR of the pipeline, not a
 * participant in it. It owns sequencing and enforcement; every decision it
 * appears to make is delegated to a component that owns it."
 *
 * ── GatewayRequest is the edge shape, and it never travels ──────────────────
 * It is what arrives: a template to render, the variables to render it with,
 * and who is asking. It is normalized into the canonical `AIRequest` and then
 * discarded. Nothing downstream sees it, which is the property that stops a
 * second execution request existing — everything past admission consumes the
 * one `AIRequest` the provider abstraction froze.
 */

import type { AICapability, AIParameters, AIRequest, TenantContext } from '@contentos/contracts';

import type { PromptTemplateRef } from '../prompts/template.js';

/**
 * What arrives at the edge.
 *
 * Deliberately NOT an `AIRequest`: a caller supplies a template reference and
 * variables, not messages. A caller that could supply messages would be
 * supplying a prompt that exists outside the registry, which is the thing the
 * prompt pipeline exists to prevent.
 */
export interface GatewayRequest {
  /** dot.case, opaque to this platform: 'planning.outline'. */
  readonly taskType: string;
  readonly capability: AICapability;
  /** The provider expected to serve it. Checked against the registry. */
  readonly providerId: string;
  readonly model: string;
  readonly templateRef: PromptTemplateRef;
  /** UNTRUSTED. Rendered into declared slots by the prompt pipeline. */
  readonly variables: Readonly<Record<string, unknown>>;
  readonly organizationId: string;
  /** The workspace, which IS the tenant (ADR-017). */
  readonly workspaceId: string;
  /**
   * Who is asking, where a human is.
   *
   * Null for platform-initiated work — a scheduled refresh has no membership
   * to check, and requiring one would make background work impossible rather
   * than more secure.
   */
  readonly actorId: string | null;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  /** Sampling. Omitted, the template's model hints are adopted. */
  readonly params?: AIParameters;
  readonly timeoutMs?: number;
  /**
   * A feature flag this request depends on, where it depends on one.
   *
   * Named by the caller rather than derived: inventing a key convention here
   * would mean the Gateway checking flags that no registry declares, which
   * evaluates to the built-in default and reads as a check that happened.
   */
  readonly featureFlag?: string;
}

/**
 * Everything admission RESOLVED, as opposed to everything it was told.
 *
 * The distinction is the point: the request carries ids, and the context
 * carries the records those ids turned out to name. A stage that read the
 * request where it should have read the context would be trusting the caller
 * about its own tenancy.
 */
export interface GatewayContext {
  /** The existing tenant context — the same type every handler receives. */
  readonly tenant: TenantContext;
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly actorId: string | null;
  readonly correlationId: string;
  readonly idempotencyKey: string;
}

export const ADMISSION_STAGES = [
  'validate',
  'resolve-organization',
  'resolve-tenant',
  'resolve-workspace',
  'validate-capability',
  'validate-provider',
  'validate-prompt',
  'authorize',
  'prepare-workflow',
] as const;

export type AdmissionStage = (typeof ADMISSION_STAGES)[number];

export const REJECTION_CODES = [
  'MalformedRequest',
  'RequestTooLarge',
  'UnknownOrganization',
  'OrganizationNotAdmitting',
  'UnknownWorkspace',
  'WorkspaceNotAdmitting',
  'TenantMismatch',
  'MembershipRequired',
  'UnknownProvider',
  'CapabilityUnavailable',
  'UnknownPrompt',
  'FeatureDisabled',
  'PreparationFailed',
] as const;

export type RejectionCode = (typeof REJECTION_CODES)[number];

export function isRejectionCode(value: unknown): value is RejectionCode {
  return typeof value === 'string' && (REJECTION_CODES as readonly string[]).includes(value);
}

/**
 * The verdict.
 *
 * A rejection names the STAGE as well as the code, because "which of the ten
 * checks refused this?" is the first question asked and the one a bare code
 * cannot answer.
 */
export type GatewayDecision =
  | { readonly outcome: 'admit' }
  | {
      readonly outcome: 'reject';
      readonly code: RejectionCode;
      readonly stage: AdmissionStage;
      readonly reason: string;
    };

/**
 * What admission produced when it admitted.
 *
 * `request` is the canonical `AIRequest` — the whole point of normalization.
 * `execution` is the workflow the runtime prepared, already at the point where
 * a dispatcher would send it.
 */
export interface AdmissionResult {
  readonly context: GatewayContext;
  /** The one execution request this platform has. Nothing else is passed on. */
  readonly request: AIRequest;
  /** `'planning.outline@7'` — resolves to the exact prompt, permanently. */
  readonly promptVersion: string;
  readonly providerId: string;
  readonly capability: AICapability;
  /** The workflow id the runtime was given. Half of every idempotency key. */
  readonly workflowId: string;
}

/** What a caller gets back. Admission never throws for a refusal. */
export type GatewayResponse =
  | {
      readonly admitted: true;
      readonly decision: GatewayDecision;
      readonly result: AdmissionResult;
    }
  | { readonly admitted: false; readonly decision: GatewayDecision };

/**
 * Bound on what a caller may send.
 *
 * The prompt pipeline bounds the COMPILED prompt; this bounds what arrives, so
 * a caller cannot spend a render on a payload that was never going to fit.
 */
export const MAX_VARIABLES_BYTES = 256 * 1024;
