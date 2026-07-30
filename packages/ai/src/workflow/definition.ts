/**
 * Workflow contracts — the definition and its steps.
 *
 * ── What this is NOT ────────────────────────────────────────────────────────
 * `05-content-platform/orchestration.md` describes the CONTENT run control
 * plane: thirteen stages, a durable Temporal workflow, credit holds, human
 * waits, compensation. This is not that, and does not anticipate it. This is
 * the small linear runtime that carries ONE job through a sequence of prompt
 * executions — the layer between the job lifecycle and the prompt pipeline,
 * both of which live in this package.
 *
 * When the content orchestrator arrives it will drive jobs; it will not
 * replace this, and this will not grow into it.
 *
 * ── The rule that keeps orchestration honest ────────────────────────────────
 * Borrowed verbatim from that spec, because it applies here exactly: "if a code
 * path here would need to UNDERSTAND an artifact — read a score, inspect a
 * draft, evaluate coverage — it is business logic in the wrong place."
 *
 * Nothing in this runtime reads a prompt's text or a response's meaning. It
 * carries them and it sequences them. Every decision it makes is a function of
 * the definition and the position in it, never of what a model said.
 */

import type { AICapability, AIParameters } from '@contentos/contracts';

import type { PromptTemplateRef } from '../prompts/template.js';

/**
 * One step: a prompt to render and a model to render it against.
 *
 * A step names the template rather than carrying one — templates are versioned
 * data in the catalogue, and a workflow holding prompt text would be a prompt
 * that exists outside the registry.
 */
export interface WorkflowStep {
  /** Unique within the definition. Appears in the idempotency key. */
  readonly id: string;
  readonly templateRef: PromptTemplateRef;
  readonly capability: AICapability;
  /** The model this step asks for. Resolved to a vendor string by an adapter. */
  readonly model: string;
  readonly timeoutMs: number;
  /**
   * Sampling, stated by the workflow.
   *
   * Omitted, the compiled prompt's model hints are adopted. That is a choice
   * the WORKFLOW makes, deliberately and visibly — `prepareExecution` still
   * never applies hints on its own, because there the caller has already
   * stated params and overwriting them would be silent.
   */
  readonly params?: AIParameters;
  /**
   * Where this step's output goes for the steps after it.
   *
   * The whole of the data flow, and deliberately the whole of it: a name, and
   * the response content bound to it. No expressions, no transforms, no
   * conditions. A later step's template must declare the variable, or its own
   * validation rejects the render.
   */
  readonly bindOutputTo?: string;
}

export interface WorkflowDefinition {
  /** dot.case, stable forever: 'article.draft'. */
  readonly id: string;
  readonly version: number;
  readonly description: string;
  /** Executed in order, each exactly once. */
  readonly steps: readonly WorkflowStep[];
}

export interface WorkflowIssue {
  readonly field: string;
  readonly code: string;
  readonly detail: string;
}

export type WorkflowValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly issues: readonly WorkflowIssue[] };

const DOT_CASE = /^[a-z][a-z0-9]*(\.[a-z0-9]+)+$/;
const STEP_ID = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const VARIABLE_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

/** A definition nobody could finish is one nobody should start. */
export const MAX_WORKFLOW_STEPS = 50;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reject an invalid definition — every issue at once.
 *
 * Reads an untrusted value behind the declared type, for the same reason the
 * prompt validator does: a definition rebuilt from a payload is exactly how a
 * malformed one arrives, and checking a value the compiler already promised is
 * correct asserts nothing.
 */
export function validateWorkflowDefinition(
  definition: WorkflowDefinition,
): WorkflowValidationResult {
  const issues: WorkflowIssue[] = [];
  const add = (field: string, code: string, detail: string): void => {
    issues.push({ field, code, detail });
  };

  const raw = definition as unknown as Record<string, unknown>;

  const id = raw['id'];
  if (typeof id !== 'string' || !DOT_CASE.test(id)) {
    add('id', 'BAD_FORMAT', `'${String(id)}' must be dot.case, e.g. 'article.draft'.`);
  }
  const version = raw['version'];
  if (!Number.isInteger(version) || (version as number) < 1) {
    add('version', 'BAD_VERSION', 'version must be an integer >= 1.');
  }
  const description = raw['description'];
  if (typeof description !== 'string' || description.trim() === '') {
    add('description', 'EMPTY', 'A definition with no description is one nobody can review.');
  }

  const steps = raw['steps'];
  if (!Array.isArray(steps)) {
    add('steps', 'NOT_ARRAY', 'steps must be an array.');
    return { ok: false, issues };
  }
  // A workflow with no steps completes without doing anything, which is a
  // definition that looks like work and is not.
  if (steps.length === 0) {
    add('steps', 'EMPTY', 'A workflow with no steps would complete without executing anything.');
  }
  if (steps.length > MAX_WORKFLOW_STEPS) {
    add(
      'steps',
      'TOO_MANY_STEPS',
      `${String(steps.length)} steps exceeds the ${String(MAX_WORKFLOW_STEPS)} bound.`,
    );
  }

  const seen = new Set<string>();
  const bound = new Set<string>();

  steps.forEach((entry: unknown, i) => {
    const at = `steps[${String(i)}]`;
    if (!isRecord(entry)) {
      add(at, 'NOT_OBJECT', 'Each step must be an object.');
      return;
    }

    const stepId = entry['id'];
    if (typeof stepId !== 'string' || !STEP_ID.test(stepId)) {
      add(`${at}.id`, 'BAD_ID', `'${String(stepId)}' must be lowercase kebab-case.`);
    } else if (seen.has(stepId)) {
      // Step ids form the idempotency key. Two steps sharing one would make a
      // retry of the second look like a retry of the first.
      add(
        `${at}.id`,
        'DUPLICATE_STEP',
        `'${stepId}' appears twice; step ids form the idempotency key, so two steps sharing one would be indistinguishable on retry.`,
      );
    } else {
      seen.add(stepId);
    }

    const templateRef = entry['templateRef'];
    if (!isRecord(templateRef) || typeof templateRef['id'] !== 'string') {
      add(`${at}.templateRef`, 'MISSING', 'A step names the template it renders.');
    } else if (
      templateRef['version'] !== undefined &&
      (!Number.isInteger(templateRef['version']) || (templateRef['version'] as number) < 1)
    ) {
      add(`${at}.templateRef.version`, 'BAD_VERSION', 'A pinned version is an integer >= 1.');
    }

    if (typeof entry['capability'] !== 'string') {
      add(`${at}.capability`, 'MISSING', 'A step states the capability it needs.');
    }
    const model = entry['model'];
    if (typeof model !== 'string' || model.trim() === '') {
      add(`${at}.model`, 'EMPTY', 'A step names the model it asks for.');
    }
    const timeoutMs = entry['timeoutMs'];
    if (!Number.isInteger(timeoutMs) || (timeoutMs as number) < 1) {
      add(`${at}.timeoutMs`, 'BAD_VALUE', 'timeoutMs must be an integer >= 1.');
    }

    const params = entry['params'];
    if (params !== undefined) {
      if (!isRecord(params)) {
        add(`${at}.params`, 'NOT_OBJECT', 'params, when stated, must be an object.');
      } else {
        const temperature = params['temperature'];
        if (typeof temperature !== 'number' || !Number.isFinite(temperature) || temperature < 0) {
          add(`${at}.params.temperature`, 'BAD_VALUE', 'temperature must be a finite number >= 0.');
        }
        const maxOutputTokens = params['maxOutputTokens'];
        if (!Number.isInteger(maxOutputTokens) || (maxOutputTokens as number) < 1) {
          add(`${at}.params.maxOutputTokens`, 'BAD_VALUE', 'maxOutputTokens must be >= 1.');
        }
      }
    }

    const bindOutputTo = entry['bindOutputTo'];
    if (bindOutputTo !== undefined) {
      if (typeof bindOutputTo !== 'string' || !VARIABLE_NAME.test(bindOutputTo)) {
        add(
          `${at}.bindOutputTo`,
          'BAD_NAME',
          `${JSON.stringify(bindOutputTo)} is not a usable variable name.`,
        );
      } else if (bound.has(bindOutputTo)) {
        // The second write would win and the first step's output would vanish
        // between one step and the next, with nothing reporting it.
        add(
          `${at}.bindOutputTo`,
          'DUPLICATE_BINDING',
          `'${bindOutputTo}' is already bound by an earlier step; the second would overwrite the first.`,
        );
      } else if (i === steps.length - 1) {
        add(
          `${at}.bindOutputTo`,
          'UNREACHABLE_BINDING',
          `'${bindOutputTo}' is bound by the last step, so nothing could ever read it.`,
        );
      } else {
        bound.add(bindOutputTo);
      }
    }
  });

  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}
