/**
 * Draft validation — is this draft one that could become a run?
 *
 * ── Everything checked here is knowable while somebody is still editing ────
 * A workflow that does not resolve, a template reference that has moved, a
 * required input nobody filled in, an input no template declares. All four are
 * cheap to fix at a keyboard and expensive to discover at execution, where the
 * first two steps have already been paid for.
 *
 * ── Value CONFORMANCE is deliberately not checked here ─────────────────────
 * Whether `topic` is a string of the right length is `compilePrompt`'s
 * question, and it answers it on every run whatever produced the request. A
 * second copy of those rules in this module could disagree with the frozen one,
 * and a draft that validated and then failed to run would be worse than no
 * check at all. `compileDraft` runs the real compiler instead — see there.
 *
 * ── Every issue is reported, not the first ─────────────────────────────────
 * A draft with four problems should be fixable in one pass. The same
 * `{ field, code, detail }` shape every validator in the platform uses.
 */

import type { ResolvedWorkflow } from '../blueprints/resolve.js';
import { resolveWorkflow } from '../blueprints/resolve.js';
import type { WorkflowRegistry } from '../blueprints/registry.js';
import { binds, type WorkflowStepDefinition } from '../blueprints/steps.js';
import type { PromptTemplate, VariableDeclaration } from '../prompts/template.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { TemplateLibrary } from '../templates/library.js';
import { resolveTemplate } from '../templates/resolve.js';
import type { StoredRecordIssue } from '../runs/stored.js';
import type { StoredPromptReference } from '../runs/stored.js';
import { latestRevision, type ContentDraft } from './draft.js';
import { DRAFT_TRANSITION_RULES, isDraftStatus, type DraftStatus } from './status.js';

export interface DraftValidationOptions {
  readonly draft: ContentDraft;
  readonly workflows: WorkflowRegistry;
  readonly templates: TemplateLibrary;
  readonly providers?: ProviderRegistry;
}

export type DraftValidation =
  | {
      readonly ok: true;
      /** The workflow, already resolved. Callers reuse it rather than re-resolving. */
      readonly resolved: ResolvedWorkflow;
      /** Every prompt step's template, in step order. */
      readonly templates: readonly PromptTemplate[];
    }
  | { readonly ok: false; readonly issues: readonly StoredRecordIssue[] };

/** What a draft's inputs must satisfy: one declaration, and which step wants it. */
export interface RequiredInput {
  readonly name: string;
  readonly declaration: VariableDeclaration;
  readonly stepId: string;
}

class Issues {
  readonly list: StoredRecordIssue[] = [];
  add(field: string, code: string, detail: string): void {
    this.list.push({ field, code, detail });
  }
}

const promptSteps = (
  resolved: ResolvedWorkflow,
): readonly Extract<WorkflowStepDefinition, { kind: 'prompt' }>[] =>
  resolved.version.steps.filter(
    (step): step is Extract<WorkflowStepDefinition, { kind: 'prompt' }> => step.kind === 'prompt',
  );

/**
 * Which inputs a person actually has to supply.
 *
 * Every variable the workflow's templates declare, MINUS the ones a previous
 * step binds from its own output. Asking somebody to type the outline that step
 * one is about to generate would be asking for the thing the workflow exists to
 * produce.
 */
export function requiredInputsFor(
  resolved: ResolvedWorkflow,
  library: TemplateLibrary,
): readonly RequiredInput[] {
  const bound = new Set<string>();
  for (const step of resolved.version.steps) {
    const name = binds(step);
    if (name !== null) bound.add(name);
  }

  const inputs: RequiredInput[] = [];
  const seen = new Set<string>();

  for (const step of promptSteps(resolved)) {
    const resolution = resolveTemplate({
      library,
      id: step.templateRef.id,
      selector: step.templateRef.selector,
      capability: resolved.version.capability.capability,
    });
    if (resolution.outcome === 'refused') continue;

    for (const declaration of resolution.resolved.version.prompt.variables) {
      if (bound.has(declaration.name) || seen.has(declaration.name)) continue;
      seen.add(declaration.name);
      inputs.push({ name: declaration.name, declaration, stepId: step.id });
    }
  }

  return Object.freeze(inputs);
}

/** Every variable name the workflow's templates know about, bound ones included. */
function declaredNames(resolved: ResolvedWorkflow, library: TemplateLibrary): ReadonlySet<string> {
  const names = new Set<string>();
  for (const step of promptSteps(resolved)) {
    const resolution = resolveTemplate({
      library,
      id: step.templateRef.id,
      selector: step.templateRef.selector,
      capability: resolved.version.capability.capability,
    });
    if (resolution.outcome === 'refused') continue;
    for (const declaration of resolution.resolved.version.prompt.variables) {
      names.add(declaration.name);
    }
  }
  return names;
}

/** The revision chain: 1..n, ascending, with every status change a legal one. */
function checkRevisions(draft: ContentDraft, issues: Issues): void {
  if (draft.revisions.length === 0) {
    issues.add('revisions', 'EMPTY', 'A draft has at least one revision; it is what it is.');
    return;
  }

  let previous: DraftStatus | null = null;
  draft.revisions.forEach((revision, index) => {
    const where = `revisions[${String(index)}]`;

    if (revision.revision !== index + 1) {
      // A gap or a repeat means a revision was rewritten or dropped, and the
      // history is no longer the history.
      issues.add(
        `${where}.revision`,
        'OUT_OF_SEQUENCE',
        `Revision ${String(revision.revision)} is at position ${String(index + 1)}; revisions are 1-based, ascending and gapless.`,
      );
    }
    if (!isDraftStatus(revision.status)) {
      issues.add(
        `${where}.status`,
        'UNKNOWN_STATUS',
        `'${String(revision.status)}' is not a draft status.`,
      );
      return;
    }
    if (revision.note.trim() === '') {
      issues.add(
        `${where}.note`,
        'MISSING',
        'A revision says why it exists; a change nobody can explain is one nobody can undo.',
      );
    }

    if (previous !== null && !movesLegally(previous, revision.status)) {
      issues.add(
        `${where}.status`,
        'ILLEGAL_TRANSITION',
        `A draft cannot move from '${previous}' to '${revision.status}'.`,
      );
    }

    previous = revision.status;
  });
}

/**
 * Is there a transition from one status to the other?
 *
 * Read straight off the machine's own table rather than restated. WHICH
 * transition was taken is not recorded on a revision — only that the move was
 * one the lifecycle allows.
 */
function movesLegally(from: DraftStatus, to: DraftStatus): boolean {
  return from === to || DRAFT_TRANSITION_RULES.some((rule) => rule.from === from && rule.to === to);
}

const sameReference = (left: StoredPromptReference, right: StoredPromptReference): boolean =>
  left.templateId === right.templateId &&
  left.templateVersion === right.templateVersion &&
  left.promptVersion === right.promptVersion;

export function validateDraft(options: DraftValidationOptions): DraftValidation {
  const { draft, workflows, templates } = options;
  const issues = new Issues();

  checkRevisions(draft, issues);

  // ── The workflow, at the version this draft pinned ───────────────────────
  const resolution = resolveWorkflow({
    registry: workflows,
    id: draft.workflowId,
    // Explicit, always. A draft that resolved `latest-stable` at compile time
    // would run a different workflow from the one it was written against.
    selector: { kind: 'explicit', version: draft.workflowVersion },
    capability: draft.capability,
  });

  if (resolution.outcome === 'refused') {
    issues.add('workflowId', resolution.code, resolution.reason);
    return { ok: false, issues: Object.freeze(issues.list) };
  }

  const { resolved } = resolution;

  if (draft.workflowRef !== resolved.workflowVersion) {
    issues.add(
      'workflowRef',
      'IMMUTABLE_REFERENCE',
      `This draft records '${draft.workflowRef}'; the registry resolves '${resolved.workflowVersion}'. A pinned reference does not move.`,
    );
  }

  // ── Every prompt step's template ─────────────────────────────────────────
  const resolvedTemplates: PromptTemplate[] = [];
  const found: StoredPromptReference[] = [];

  for (const step of promptSteps(resolved)) {
    const templateResolution = resolveTemplate({
      library: templates,
      id: step.templateRef.id,
      selector: step.templateRef.selector,
      capability: resolved.version.capability.capability,
      ...(options.providers === undefined ? {} : { providers: options.providers }),
    });

    if (templateResolution.outcome === 'refused') {
      // The library's own code and reason — it already explains what to fix,
      // and restating it would let the two drift.
      issues.add(
        `steps.${step.id}.templateRef`,
        templateResolution.code,
        templateResolution.reason,
      );
      continue;
    }

    const prompt = templateResolution.resolved.version.prompt;
    resolvedTemplates.push(prompt);
    found.push({
      templateId: prompt.id,
      templateVersion: prompt.version,
      promptVersion: templateResolution.resolved.promptVersion,
    });
  }

  // ── The pinned references still resolve the same way ─────────────────────
  if (issues.list.length === 0 || found.length === draft.templateReferences.length) {
    draft.templateReferences.forEach((pinned, index) => {
      const current = found[index];
      if (current === undefined) return;
      if (!sameReference(pinned, current)) {
        // A template was promoted since this draft was written. Refusing is what
        // makes the pin mean something: the frozen orchestrator resolves
        // templates itself, so an un-refused drift would run a prompt the
        // author never saw.
        issues.add(
          `templateReferences[${String(index)}]`,
          'TEMPLATE_DRIFT',
          `This draft pinned '${pinned.promptVersion}'; the library now resolves '${current.promptVersion}'. Re-pin the draft to accept the newer prompt.`,
        );
      }
    });
    if (found.length !== draft.templateReferences.length) {
      issues.add(
        'templateReferences',
        'TEMPLATE_DRIFT',
        `This draft pinned ${String(draft.templateReferences.length)} template(s); the workflow now has ${String(found.length)}.`,
      );
    }
  }

  // ── The inputs ───────────────────────────────────────────────────────────
  const { inputs } = latestRevision(draft);
  const declared = declaredNames(resolved, templates);

  for (const required of requiredInputsFor(resolved, templates)) {
    if (!required.declaration.required) continue;
    const value = inputs[required.name];
    if (
      !Object.prototype.hasOwnProperty.call(inputs, required.name) ||
      value === undefined ||
      value === null
    ) {
      issues.add(
        `inputs.${required.name}`,
        'MISSING_INPUT',
        `'${required.name}' is required by step '${required.stepId}': ${required.declaration.description}`,
      );
    }
  }

  for (const name of Object.keys(inputs)) {
    if (!declared.has(name)) {
      // The runtime refuses a variable no template declared. Catching it here
      // is the same rule, applied where it is cheap.
      issues.add(
        `inputs.${name}`,
        'UNKNOWN_INPUT',
        `No template in ${resolved.workflowVersion} declares '${name}'. Supplying a value nothing uses is a caller bug that would otherwise surface as unexplained quality loss.`,
      );
    }
  }

  return issues.list.length === 0
    ? { ok: true, resolved, templates: Object.freeze(resolvedTemplates) }
    : { ok: false, issues: Object.freeze(issues.list) };
}
