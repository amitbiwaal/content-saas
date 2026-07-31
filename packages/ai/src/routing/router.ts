/**
 * The routing engine.
 *
 * Spec: `08-ai-platform/model-router.md`, ADR-008. It SELECTS; the Gateway
 * dispatches; the retry strategy decides when the chain advances. Nothing here
 * calls a provider, and there is no path from a plan to one — `execute` and
 * `stream` are never reached, imported, or reachable from this file.
 *
 * ── It discovers nothing and checks nothing twice ───────────────────────────
 * Which providers exist is the REGISTRY's answer (`providersWith`), which
 * models exist is the CATALOGUE's, and whether a provider is well is its own
 * (`health()`). This file asks those three questions in an order and combines
 * the answers. A second copy of "who can do chat?" would be a second thing to
 * keep in step with the registry, and the two would disagree first under
 * exactly the conditions that make routing matter.
 *
 * ── The filters, in order, and why that order ───────────────────────────────
 *   1 policy      cheapest — a table lookup, no I/O
 *   2 model       a map lookup; refuses an unknown name before anything else
 *   3 capability  local, from declared data
 *   4 streaming   local, from the provider's own type
 *   5 health      the ONLY I/O, and therefore last
 *
 * Health runs last so that a request refused for a reason nothing can change —
 * an unknown model, an unsupported capability — is refused without touching a
 * provider at all. Reversing it would make a typo cost a round trip per
 * candidate.
 *
 * ── Determinism, and the one exception ──────────────────────────────────────
 * Every step is a pure function of its inputs except health, which is the
 * platform's live state. `model-router.md`: "Given identical inputs, policy
 * version, and health state, routing is deterministic. Health state is the only
 * non-deterministic input, and it is recorded in the decision's reason codes."
 * That is exactly what happens: candidates are kept in registration order, ties
 * are impossible, and `routing.health_filtered` / `routing.health_degraded`
 * record when health changed the answer.
 */

import type { AICapability, AIRequest } from '@contentos/contracts';
import type { Principal } from '@contentos/security';

import type { AdmissionOrganization, AdmissionWorkspace } from '../gateway/ports.js';
import type { ModelProvider, ProviderHealthStatus } from '../providers/provider.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { isStreamingProvider } from '../providers/streaming-provider.js';
import type { ModelCatalogue, ModelEntry } from './catalogue.js';
import {
  freezePlan,
  type ExecutionMode,
  type ExecutionPlan,
  type RouteTarget,
  type RoutingPolicyName,
  type RoutingReason,
  type RoutingRejectionCode,
  type RoutingResult,
  type StreamingMode,
} from './plan.js';
import type { ProviderPreference, RoutingTable } from './policy.js';

/**
 * A defect, not a refusal.
 *
 * Thrown only for inputs a caller assembled incorrectly — a principal that does
 * not belong to the workspace it was handed with. A routing REFUSAL is a value
 * (`RoutingResult`); this is for the case where the question itself is
 * malformed and answering it would plan work in the wrong tenant.
 */
export class RoutingInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoutingInputError';
  }
}

export interface RoutingInput {
  /** The canonical request. Never modified — routing reads and returns a plan. */
  readonly request: AIRequest;
  /**
   * Who is asking.
   *
   * Routing does not branch on identity — there are no per-user policies, and
   * `model-router.md` keeps the Router away from anything but requirements and
   * metadata. What it IS used for is the one thing an identity can honestly
   * settle here: that the tenancy in the plan is the tenancy of the caller.
   */
  readonly principal: Principal;
  readonly organization: AdmissionOrganization;
  readonly workspace: AdmissionWorkspace;
  /** What the caller asked for. Decided by the endpoint, not by policy. */
  readonly executionMode: ExecutionMode;
  /**
   * A provider the REQUEST named, where it named one.
   *
   * Separate from `AIRequest`, which carries no provider — the canonical
   * request is deliberately provider-free, and the Gateway's edge shape is what
   * holds the caller's choice. Passing it here keeps `AIRequest` frozen.
   */
  readonly requestedProviderId?: string | null;
}

export interface RouterOptions {
  readonly providers: ProviderRegistry;
  readonly catalogue: ModelCatalogue;
  readonly table: RoutingTable;
}

export interface Router {
  route(input: RoutingInput): Promise<RoutingResult>;
}

interface Candidate {
  readonly provider: ModelProvider;
  readonly entry: ModelEntry;
  readonly streamingMode: StreamingMode;
}

interface Ranked extends Candidate {
  readonly health: ProviderHealthStatus;
}

const refuse = (
  code: RoutingRejectionCode,
  reason: string,
  reasons: readonly RoutingReason[],
): RoutingResult =>
  Object.freeze({
    outcome: 'refused' as const,
    code,
    reason,
    reasons: Object.freeze([...reasons]),
  });

const targetOf = (candidate: Candidate): RouteTarget =>
  Object.freeze({
    providerId: candidate.provider.providerId,
    model: candidate.entry.providerModel,
    canonicalModel: candidate.entry.canonical,
    streamingMode: candidate.streamingMode,
  });

/**
 * Which policy applies, in precedence order. First match wins and there are no
 * ties — see `policy.ts`.
 */
function selectPolicy(
  input: RoutingInput,
  table: RoutingTable,
): { policy: RoutingPolicyName; preference: ProviderPreference | null; reason: RoutingReason } {
  const explicit = input.requestedProviderId;
  if (typeof explicit === 'string' && explicit.trim() !== '') {
    return {
      policy: 'explicit',
      preference: { providerId: explicit.trim() },
      reason: 'routing.explicit_provider',
    };
  }

  const workspace = table.forWorkspace(input.workspace.workspaceId);
  if (workspace !== null) {
    return {
      policy: 'workspace-default',
      preference: workspace,
      reason: 'routing.workspace_default',
    };
  }

  const organization = table.forOrganization(input.organization.organizationId);
  if (organization !== null) {
    return {
      policy: 'organization-default',
      preference: organization,
      reason: 'routing.organization_default',
    };
  }

  if (table.global !== null) {
    return { policy: 'global-default', preference: table.global, reason: 'routing.global_default' };
  }

  return { policy: 'capability', preference: null, reason: 'routing.capability_selected' };
}

/** Provider-reported health, with a thrown answer read as offline. */
async function healthOf(provider: ModelProvider): Promise<ProviderHealthStatus> {
  try {
    return (await provider.health()).status;
  } catch {
    // A provider that cannot say how it is, is not one to send work to. The
    // discovery endpoint already reads a thrown health call the same way.
    return 'offline';
  }
}

export function createRouter(options: RouterOptions): Router {
  const { providers, catalogue, table } = options;

  return {
    async route(input: RoutingInput): Promise<RoutingResult> {
      // The one thing the principal settles. A mismatch means the caller
      // assembled the input wrong, and planning would place work in a tenant
      // the identity does not belong to.
      if (
        input.principal.workspaceId !== input.workspace.workspaceId ||
        input.principal.organizationId !== input.organization.organizationId
      ) {
        throw new RoutingInputError(
          'The principal does not belong to the workspace and organization it was routed with; a plan built from these would name the wrong tenant.',
        );
      }

      const reasons: RoutingReason[] = [];
      const capability: AICapability = input.request.capability;
      const streaming = input.executionMode === 'streaming';

      // ── 1 · Policy ───────────────────────────────────────────────────────
      const { policy, preference, reason } = selectPolicy(input, table);
      reasons.push(reason);

      const requestedModel = preference?.model ?? input.request.model;

      // ── 2 · Model ────────────────────────────────────────────────────────
      const known = catalogue.candidates(requestedModel);
      if (known.length === 0) {
        return refuse(
          'UnknownModel',
          `No catalogue entry answers to '${requestedModel}'.`,
          reasons,
        );
      }
      if (known.some((entry) => entry.canonical !== requestedModel)) {
        // An alias or a vendor string was resolved. Recorded because the name
        // in a trace will not match the name the caller sent.
        reasons.push('routing.model_alias_resolved');
      }

      // A DEFAULT prefers; an EXPLICIT pin restricts. That distinction is the
      // difference between the two: a default that refused rather than falling
      // back would not be a default, it would be a pin an operator set on a
      // caller's behalf. A caller's own choice is honoured absolutely, because
      // moving off it would send their data to a vendor they did not pick.
      let entries: readonly ModelEntry[] = known;
      if (preference !== null) {
        if (!providers.has(preference.providerId)) {
          // A broken table is not papered over. Falling through would serve the
          // request from somewhere nobody configured and hide the mistake.
          return refuse(
            'UnknownProvider',
            `Policy '${policy}' names provider '${preference.providerId}', which is not registered.`,
            reasons,
          );
        }

        const preferred = catalogue.lookup(preference.providerId, requestedModel);
        if (policy === 'explicit') {
          if (preferred === null) {
            return refuse(
              'ModelNotOnProvider',
              `Provider '${preference.providerId}' has no model '${requestedModel}'.`,
              reasons,
            );
          }
          entries = [preferred];
        } else if (preferred !== null) {
          // Hoisted, not isolated: the preference decides who goes FIRST.
          entries = [preferred, ...known.filter((candidate) => candidate !== preferred)];
        }
      }

      // ── 3 · Capability ───────────────────────────────────────────────────
      // Both halves are asked, because they answer different questions: the
      // provider declares what it offers at all, the entry what THIS model can
      // do. A provider that serves chat and embeddings does not do both from
      // every model.
      const capable: Candidate[] = [];
      let capabilityFiltered = false;
      for (const entry of entries) {
        if (!providers.has(entry.providerId)) continue;
        const provider = providers.get(entry.providerId);
        if (
          !provider.capabilities.includes(capability) ||
          !entry.capabilities.includes(capability)
        ) {
          capabilityFiltered = true;
          continue;
        }
        capable.push({
          provider,
          entry,
          streamingMode: isStreamingProvider(provider) ? 'native' : 'unsupported',
        });
      }
      if (capabilityFiltered) reasons.push('routing.capability_filtered');
      if (capable.length === 0) {
        return refuse(
          'CapabilityUnavailable',
          `No provider offering '${requestedModel}' declares capability '${capability}'.`,
          reasons,
        );
      }

      // ── 4 · Streaming ────────────────────────────────────────────────────
      let usable = capable;
      if (streaming) {
        reasons.push('routing.streaming_required');
        usable = capable.filter((candidate) => candidate.streamingMode === 'native');
        if (usable.length === 0) {
          // Never silently downgraded to a buffered call: a client that asked
          // to stream and received one response at the end has had its latency
          // budget spent without being told.
          return refuse(
            'StreamingUnsupported',
            `No provider offering '${requestedModel}' can stream.`,
            reasons,
          );
        }
      }

      // ── 5 · Health — the only I/O, and therefore last ────────────────────
      const ranked: Ranked[] = await Promise.all(
        usable.map(async (candidate) => ({
          ...candidate,
          health: await healthOf(candidate.provider),
        })),
      );

      const live = ranked.filter((candidate) => candidate.health !== 'offline');
      if (live.length < ranked.length) reasons.push('routing.health_filtered');
      if (live.length === 0) {
        return refuse(
          'ProviderUnhealthy',
          `Every provider offering '${requestedModel}' reports offline.`,
          reasons,
        );
      }

      // Healthy before degraded, and otherwise registration order. A stable
      // demotion, not a load balancer: a degraded provider is working but
      // impaired, and refusing it outright would take the platform down for a
      // partial vendor incident.
      const order = live
        .map((candidate, index) => ({ candidate, index }))
        .sort((left, right) => {
          const rank = (health: ProviderHealthStatus): number => (health === 'healthy' ? 0 : 1);
          const byHealth = rank(left.candidate.health) - rank(right.candidate.health);
          return byHealth !== 0 ? byHealth : left.index - right.index;
        })
        .map(({ candidate }) => candidate);

      if (order.some((candidate) => candidate.health === 'degraded')) {
        reasons.push('routing.health_degraded');
      }

      // ── 6 · The plan ─────────────────────────────────────────────────────
      const primary = order[0] as Ranked;

      // An EXPLICIT pin gets no cross-provider fallback. Falling off a provider
      // the caller named would send their data somewhere they did not choose —
      // the data-residency concern `model-router.md` §Security raises, and the
      // one place this increment can honour rule 6 without contradicting it.
      const fallbacks =
        policy === 'explicit' ? [] : order.slice(1).map((candidate) => targetOf(candidate));
      reasons.push(
        fallbacks.length > 0 ? 'routing.fallback_planned' : 'routing.no_fallback_available',
      );

      const plan: ExecutionPlan = {
        ...targetOf(primary),
        capability,
        executionMode: input.executionMode,
        fallbacks: Object.freeze(fallbacks),
        policy,
        policyVersion: table.version,
        reasons: Object.freeze([...reasons]),
      };

      return Object.freeze({ outcome: 'routed' as const, plan: freezePlan(plan) });
    },
  };
}
