/**
 * Content workflow blueprints — the step vocabulary and the metadata.
 *
 * ── A naming deviation, stated rather than hidden ───────────────────────────
 * The increment names `WorkflowDefinition` and `WorkflowStep`. Both are already
 * exported by the FROZEN S2.4 runtime, where they mean something narrower: a
 * LINEAR list of prompt steps, each carrying a model and a timeout, that the
 * engine walks one at a time. This increment describes a GRAPH — branch, merge,
 * cycle detection — which that runtime deliberately does not execute.
 *
 * Two `WorkflowDefinition`s meaning different things in one barrel would be
 * worse than a different word, so the aggregate is `ContentWorkflow`, one
 * immutable version is a `WorkflowVersion`, and a step is a
 * `WorkflowStepDefinition`. The same choice S4.1 made for `LibraryTemplate`,
 * for the same reason, and recorded in conformance.
 *
 * ── Steps name templates. They never name providers ────────────────────────
 * The frozen `WorkflowStep` carries `model: string`. A blueprint step does not,
 * and that absence is the point: which provider and which model run a step is
 * the Router's decision (S3.5), made per request from live health and policy.
 * A blueprint that pinned a model would be making that decision months early,
 * in a file nobody re-reads when a vendor deprecates a snapshot.
 *
 * ── Why five kinds and not one with a `type` field ──────────────────────────
 * A discriminated union. `branch` needs cases, `merge` needs sources, `prompt`
 * needs a template — as one shape with everything optional, a merge with no
 * sources and a branch with no cases are both representable, and validation
 * becomes a list of rules instead of a type.
 */

import type { AICapability } from '@contentos/contracts';

import type { ExecutionMode } from '../routing/plan.js';
import type { TemplateMetadata } from '../templates/metadata.js';
import type { VersionSelector } from '../templates/resolve.js';

/**
 * The same five descriptive fields a template carries.
 *
 * An ALIAS rather than a second interface: they are the same concept — who owns
 * this, what is it for, who may see it — and two declarations would drift the
 * moment one gained a field. The validation messages differ; the shape cannot.
 */
export type WorkflowMetadata = TemplateMetadata;

/**
 * What a workflow version produces, and where it may run.
 *
 * Mirrors `TemplateCapability` in intent but is a distinct type: a workflow's
 * capability is the capability of the WORK, while a template's is a property of
 * one prompt. A workflow whose steps span capabilities declares the one it
 * delivers.
 */
export interface WorkflowCapability {
  readonly capability: AICapability;
  /** How the result is delivered. Reuses the routing vocabulary. */
  readonly executionMode: ExecutionMode;
}

export const WORKFLOW_STEP_KINDS = ['prompt', 'transform', 'validate', 'branch', 'merge'] as const;

export type WorkflowStepKind = (typeof WORKFLOW_STEP_KINDS)[number];

export function isWorkflowStepKind(value: unknown): value is WorkflowStepKind {
  return typeof value === 'string' && (WORKFLOW_STEP_KINDS as readonly string[]).includes(value);
}

interface StepBase {
  /** Unique within a version. Appears in every edge and in the runtime's key. */
  readonly id: string;
  /** For a human reading a blueprint. Never used to make a decision. */
  readonly description: string;
}

/**
 * Render a template and keep its output.
 *
 * `templateRef` carries a SELECTOR, not a resolved version: a blueprint that
 * pinned an integer would need editing every time a prompt shipped, and
 * `latest-stable` is what a blueprint usually means.
 */
export interface PromptStepDefinition extends StepBase {
  readonly kind: 'prompt';
  readonly templateRef: { readonly id: string; readonly selector: VersionSelector };
  /** Where this step's output goes for the steps after it. */
  readonly bindOutputTo: string;
  /** The next step, or null to end the workflow here. */
  readonly next: string | null;
}

/**
 * A named pure transformation over bound values.
 *
 * The transform itself is a REFERENCE. A blueprint that carried code would be
 * a blueprint that has to be reviewed as code, which is the property that makes
 * prompts data in the first place.
 */
export interface TransformStepDefinition extends StepBase {
  readonly kind: 'transform';
  readonly transform: string;
  readonly inputs: readonly string[];
  readonly bindOutputTo: string;
  readonly next: string | null;
}

/** A named check over a bound value. Also a reference, for the same reason. */
export interface ValidateStepDefinition extends StepBase {
  readonly kind: 'validate';
  readonly validator: string;
  /** The bound value it inspects. */
  readonly subject: string;
  readonly next: string | null;
  /** Where a failed check goes. Null ends the workflow as failed. */
  readonly onFailure: string | null;
}

/**
 * A fork.
 *
 * `otherwise` is REQUIRED and may be null, rather than optional: a branch whose
 * cases do not match and which forgot a default would otherwise fall off the
 * end of the graph silently. Writing `null` is a decision; omitting the field
 * is an oversight, and the type refuses to let them look alike.
 */
export interface BranchStepDefinition extends StepBase {
  readonly kind: 'branch';
  /** The bound value the cases are matched against. */
  readonly on: string;
  readonly cases: readonly { readonly when: string; readonly next: string }[];
  readonly otherwise: string | null;
}

/** A join. `sources` are the steps whose output it combines. */
export interface MergeStepDefinition extends StepBase {
  readonly kind: 'merge';
  readonly sources: readonly string[];
  readonly bindOutputTo: string;
  readonly next: string | null;
}

export type WorkflowStepDefinition =
  | PromptStepDefinition
  | TransformStepDefinition
  | ValidateStepDefinition
  | BranchStepDefinition
  | MergeStepDefinition;

/**
 * Every step this one can hand control to.
 *
 * One function, so reachability, cycle detection and transition validity all
 * read the same edges. Three walks of a graph that each decided for themselves
 * what an edge was would disagree on `onFailure` first.
 */
export function outgoing(step: WorkflowStepDefinition): readonly string[] {
  switch (step.kind) {
    case 'branch':
      return Object.freeze([
        ...step.cases.map((entry) => entry.next),
        ...(step.otherwise === null ? [] : [step.otherwise]),
      ]);
    case 'validate':
      return Object.freeze([
        ...(step.next === null ? [] : [step.next]),
        ...(step.onFailure === null ? [] : [step.onFailure]),
      ]);
    case 'prompt':
    case 'transform':
    case 'merge':
      return Object.freeze(step.next === null ? [] : [step.next]);
  }
}

/** The names a step binds into scope for the steps after it. */
export function binds(step: WorkflowStepDefinition): string | null {
  switch (step.kind) {
    case 'prompt':
    case 'transform':
    case 'merge':
      return step.bindOutputTo;
    case 'validate':
    case 'branch':
      return null;
  }
}
