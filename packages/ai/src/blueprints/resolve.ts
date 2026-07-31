/**
 * Workflow resolution, and the one seam into the frozen runtime.
 *
 * ── Resolution mirrors the Template Library's, deliberately ────────────────
 * Same selectors, same precedence, same refusal-as-a-value. A platform where a
 * template resolves one way and a workflow another is a platform with two rules
 * to learn and one of them remembered wrong.
 *
 * ── Definitions PREPARE execution. They never perform it ───────────────────
 * `toRuntimeDefinition` produces the value the frozen S2.4 engine consumes and
 * stops. Nothing here starts a workflow, calls a provider, or chooses one — a
 * blueprint step names a TEMPLATE, and which model runs it is the Router's
 * decision, made per request.
 *
 * ── The runtime is linear, and this is where that is said out loud ─────────
 * S2.4's engine walks a fixed list: "no branching, no looping, single linear
 * workflow only". A blueprint may describe a graph, so only a LINEAR one can be
 * handed to it today. `toRuntimeDefinition` refuses anything else rather than
 * flattening it, because a flattened branch is a workflow that quietly does the
 * wrong thing on the path nobody tested.
 */

import type { AICapability } from '@contentos/contracts';

import type { ProviderRegistry } from '../providers/registry.js';
import type { TemplateLibrary } from '../templates/library.js';
import { parseSemanticVersion } from '../templates/metadata.js';
import { resolveTemplate, type VersionSelector } from '../templates/resolve.js';
import type { WorkflowDefinition, WorkflowStep } from '../workflow/definition.js';
import {
  describeWorkflowVersion,
  type ContentWorkflow,
  type WorkflowRegistry,
  type WorkflowVersion,
} from './registry.js';
import { outgoing, type WorkflowStepDefinition } from './steps.js';

export const WORKFLOW_RESOLUTION_CODES = [
  'UnknownWorkflow',
  'UnknownVersion',
  'AmbiguousVersion',
  'WorkflowDeprecated',
  'NoStableVersion',
  'NoCompatibleVersion',
  'WorkflowNotVisible',
  'CapabilityIncompatible',
] as const;

export type WorkflowResolutionCode = (typeof WORKFLOW_RESOLUTION_CODES)[number];

export function isWorkflowResolutionCode(value: unknown): value is WorkflowResolutionCode {
  return (
    typeof value === 'string' && (WORKFLOW_RESOLUTION_CODES as readonly string[]).includes(value)
  );
}

export interface ResolvedWorkflow {
  readonly workflow: ContentWorkflow;
  readonly version: WorkflowVersion;
  /** `'article.draft@3'` — the same anchor shape a prompt version uses. */
  readonly workflowVersion: string;
  readonly selector: VersionSelector['kind'];
}

export type WorkflowResolution =
  | { readonly outcome: 'resolved'; readonly resolved: ResolvedWorkflow }
  | {
      readonly outcome: 'refused';
      readonly code: WorkflowResolutionCode;
      /** For operators. Never returned to a caller. */
      readonly reason: string;
    };

export interface ResolveWorkflowOptions {
  readonly registry: WorkflowRegistry;
  readonly id: string;
  readonly selector: VersionSelector;
  /** The capability the caller needs. Checked against the version's. */
  readonly capability?: AICapability;
  readonly visibility?: 'public' | 'internal';
}

const refuse = (code: WorkflowResolutionCode, reason: string): WorkflowResolution =>
  Object.freeze({ outcome: 'refused' as const, code, reason });

function selectVersion(
  workflow: ContentWorkflow,
  selector: VersionSelector,
): { version: WorkflowVersion } | WorkflowResolution {
  if (selector.kind === 'explicit') {
    const found = workflow.versions.find((entry) => entry.version === selector.version);
    return found === undefined
      ? refuse(
          'UnknownVersion',
          `Workflow '${workflow.id}' has no version ${String(selector.version)}.`,
        )
      : // A pin is honoured even when deprecated: reproducing a historical run
        // is exactly what pinning is for.
        { version: found };
  }

  if (selector.kind === 'latest-stable') {
    const active = workflow.versions.filter((entry) => entry.status === 'active');
    return active.length === 0
      ? refuse(
          'NoStableVersion',
          `Workflow '${workflow.id}' has no active version; a draft is not something to run and a deprecated one must be pinned deliberately.`,
        )
      : // The registry refuses more than one active version, so this cannot be
        // ambiguous by the time it is read.
        { version: active[0] as WorkflowVersion };
  }

  const requested = parseSemanticVersion(selector.compatibleWith);
  if (requested === null) {
    return refuse(
      'AmbiguousVersion',
      `'${selector.compatibleWith}' is not a semantic version; ranges and prefixes are refused because they make resolution a guess.`,
    );
  }

  const candidates = workflow.versions.filter(
    (entry) =>
      entry.status !== 'draft' &&
      entry.semanticVersion.major === requested.major &&
      (entry.semanticVersion.minor > requested.minor ||
        (entry.semanticVersion.minor === requested.minor &&
          entry.semanticVersion.patch >= requested.patch)),
  );

  return candidates.length === 0
    ? refuse(
        'NoCompatibleVersion',
        `Workflow '${workflow.id}' has no version at or above ${selector.compatibleWith} within major ${String(requested.major)}. Crossing a major would move the caller across a declared break.`,
      )
    : { version: candidates[candidates.length - 1] as WorkflowVersion };
}

/** Resolve a workflow to one version. Deterministic and pure. */
export function resolveWorkflow(options: ResolveWorkflowOptions): WorkflowResolution {
  const { registry, id, selector } = options;

  const workflow = registry.find(id);
  if (workflow === null) return refuse('UnknownWorkflow', `No workflow '${id}'.`);

  if (options.visibility === 'public' && workflow.metadata.visibility === 'internal') {
    return refuse(
      'WorkflowNotVisible',
      `Workflow '${id}' is internal; resolving it for a public caller would make platform machinery a published contract.`,
    );
  }

  const selected = selectVersion(workflow, selector);
  if ('outcome' in selected) return selected;
  const { version } = selected;

  if (version.status === 'deprecated' && selector.kind !== 'explicit') {
    return refuse(
      'WorkflowDeprecated',
      `${describeWorkflowVersion(id, version)} is deprecated; pin it explicitly to reproduce a historical run.`,
    );
  }

  if (options.capability !== undefined && version.capability.capability !== options.capability) {
    return refuse(
      'CapabilityIncompatible',
      `${describeWorkflowVersion(id, version)} delivers '${version.capability.capability}', not '${options.capability}'.`,
    );
  }

  return Object.freeze({
    outcome: 'resolved' as const,
    resolved: Object.freeze({
      workflow,
      version,
      workflowVersion: `${id}@${String(version.version)}`,
      selector: selector.kind,
    }),
  });
}

// ── The seam into the frozen runtime ─────────────────────────────────────────

export const RUNTIME_COMPILATION_CODES = [
  'NotLinear',
  'UnresolvedTemplate',
  'UnsupportedStepKind',
] as const;

export type RuntimeCompilationCode = (typeof RUNTIME_COMPILATION_CODES)[number];

export class RuntimeCompilationError extends Error {
  readonly code: RuntimeCompilationCode;
  constructor(code: RuntimeCompilationCode, message: string) {
    super(message);
    this.name = 'RuntimeCompilationError';
    this.code = code;
  }
}

/**
 * Is this blueprint a straight line?
 *
 * Every step has at most one outgoing edge, no step is a branch or a merge, and
 * following `next` from the entry visits every step exactly once.
 */
export function isLinear(version: WorkflowVersion): boolean {
  const byId = new Map(version.steps.map((step) => [step.id, step]));
  const seen = new Set<string>();
  let current: string | null = version.entryStepId;

  while (current !== null) {
    const step: WorkflowStepDefinition | undefined = byId.get(current);
    if (step === undefined || seen.has(current)) return false;
    if (step.kind === 'branch' || step.kind === 'merge') return false;
    seen.add(current);

    const next = outgoing(step);
    if (next.length > 1) return false;
    current = next[0] ?? null;
  }

  return seen.size === version.steps.length;
}

export interface RuntimeCompilationOptions {
  readonly resolved: ResolvedWorkflow;
  readonly library: TemplateLibrary;
  /** Every step's timeout. Supplied per run, not baked into a blueprint. */
  readonly timeoutMs: number;
  /**
   * The model each step runs on.
   *
   * Supplied by the CALLER, because a blueprint never names one — the Router
   * decides that per request from live health and policy. Passing it in here is
   * what keeps the blueprint free of it.
   */
  readonly model: string;
  readonly providers?: ProviderRegistry;
}

/**
 * Produce the value the frozen S2.4 engine consumes.
 *
 * Throws rather than returning a refusal: this is not a caller's mistake to
 * recover from — a non-linear blueprint reaching here means something upstream
 * chose to run a graph on an engine that walks a list, and continuing would be
 * worse than stopping.
 */
export function toRuntimeDefinition(options: RuntimeCompilationOptions): WorkflowDefinition {
  const { resolved, library } = options;
  const { workflow, version } = resolved;

  if (!isLinear(version)) {
    throw new RuntimeCompilationError(
      'NotLinear',
      `${describeWorkflowVersion(workflow.id, version)} is a graph; the workflow runtime executes a single linear sequence. A flattened branch is a workflow that quietly does the wrong thing on the path nobody tested.`,
    );
  }

  const byId = new Map(version.steps.map((step) => [step.id, step]));
  const steps: WorkflowStep[] = [];
  let current: string | null = version.entryStepId;

  while (current !== null) {
    const step: WorkflowStepDefinition | undefined = byId.get(current);
    if (step === undefined) break;

    if (step.kind !== 'prompt') {
      // Transform and validate steps have no runtime today. Refused rather
      // than dropped: silently omitting a validation step would produce a run
      // that looks complete and skipped its checks.
      throw new RuntimeCompilationError(
        'UnsupportedStepKind',
        `Step '${step.id}' is a '${step.kind}'; the workflow runtime executes prompt steps only, and dropping the others would produce a run that looks complete and did less.`,
      );
    }

    // Resolved through the LIBRARY, so the runtime receives a pinned integer
    // rather than a selector it has no way to evaluate.
    const resolution = resolveTemplate({
      library,
      id: step.templateRef.id,
      selector: step.templateRef.selector,
      capability: version.capability.capability,
      ...(options.providers === undefined ? {} : { providers: options.providers }),
    });
    if (resolution.outcome === 'refused') {
      throw new RuntimeCompilationError(
        'UnresolvedTemplate',
        `Step '${step.id}' references a template that does not resolve: ${resolution.reason}`,
      );
    }

    const next = outgoing(step)[0] ?? null;

    steps.push(
      Object.freeze({
        id: step.id,
        templateRef: {
          id: resolution.resolved.template.id,
          version: resolution.resolved.version.prompt.version,
        },
        capability: version.capability.capability,
        model: options.model,
        timeoutMs: options.timeoutMs,
        // The TERMINAL step binds nothing. The frozen validator refuses a
        // binding on the last step — "nothing could ever read it" — and it is
        // right: a final step's output is the run's RESULT, not a variable for
        // a later step. The blueprint still declares one, because a blueprint
        // does not know which step will be last once a branch is involved.
        ...(next === null ? {} : { bindOutputTo: step.bindOutputTo }),
      }),
    );

    current = next;
  }

  return Object.freeze({
    id: workflow.id,
    version: version.version,
    description: workflow.metadata.description,
    steps: Object.freeze(steps),
  });
}
