/**
 * Blueprint validation — the graph, and the references it makes.
 *
 * ── Every check here describes a workflow that would fail LATER ─────────────
 * A duplicate step id makes an edge ambiguous. A cycle makes the workflow never
 * finish. A dangling transition makes it stop somewhere no one wrote. An orphan
 * step is work someone believed was happening. A missing template makes it fail
 * on the step that costs money.
 *
 * All five are knowable at registration, which is when a blueprint is cheap to
 * fix. Discovering them at execution means discovering them once per customer.
 *
 * ── Templates are resolved through the LIBRARY ─────────────────────────────
 * Not by looking for an id. `resolveTemplate` is what decides whether a
 * reference is good — it applies version selection, deprecation, visibility and
 * capability compatibility, and a second opinion here would accept blueprints
 * the runtime later refuses.
 *
 * ── Every issue is reported, not the first ─────────────────────────────────
 * A blueprint with four mistakes should be fixed in one pass. Failing on the
 * first makes that four cycles of edit-and-rerun.
 */

import type { AICapability } from '@contentos/contracts';

import type { ProviderRegistry } from '../providers/registry.js';
import type { TemplateLibrary } from '../templates/library.js';
import { resolveTemplate } from '../templates/resolve.js';
import { binds, isWorkflowStepKind, outgoing, type WorkflowStepDefinition } from './steps.js';

export interface BlueprintIssue {
  /** `'steps[2].next'` — where in the blueprint. */
  readonly field: string;
  readonly code: string;
  readonly detail: string;
}

export type BlueprintValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly issues: readonly BlueprintIssue[] };

/** The same bound the frozen runtime applies. Not a second, looser number. */
export { MAX_WORKFLOW_STEPS } from '../workflow/definition.js';

const STEP_ID = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const BINDING_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

export interface ValidateBlueprintOptions {
  readonly steps: readonly WorkflowStepDefinition[];
  readonly entryStepId: string;
  readonly capability: AICapability;
  /** Resolved so a missing or incompatible template is caught here. */
  readonly library?: TemplateLibrary;
  readonly providers?: ProviderRegistry;
}

/**
 * Depth-first cycle detection over the outgoing edges.
 *
 * Returns the first cycle found, as the path that closes it — an id list is
 * what someone needs to fix it, and "there is a cycle" is not.
 */
function findCycle(
  steps: ReadonlyMap<string, WorkflowStepDefinition>,
  entry: string,
): readonly string[] | null {
  const visiting = new Set<string>();
  const done = new Set<string>();
  const path: string[] = [];

  function walk(id: string): readonly string[] | null {
    const step = steps.get(id);
    if (step === undefined || done.has(id)) return null;
    if (visiting.has(id)) return Object.freeze([...path.slice(path.indexOf(id)), id]);

    visiting.add(id);
    path.push(id);
    for (const next of outgoing(step)) {
      const cycle = walk(next);
      if (cycle !== null) return cycle;
    }
    path.pop();
    visiting.delete(id);
    done.add(id);
    return null;
  }

  return walk(entry);
}

/** Every step reachable from the entry, following the same edges. */
function reachable(
  steps: ReadonlyMap<string, WorkflowStepDefinition>,
  entry: string,
): ReadonlySet<string> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    if (seen.has(id)) continue;
    const step = steps.get(id);
    if (step === undefined) continue;
    seen.add(id);
    queue.push(...outgoing(step));
  }
  return seen;
}

export function validateBlueprint(options: ValidateBlueprintOptions): BlueprintValidationResult {
  const issues: BlueprintIssue[] = [];
  const add = (field: string, code: string, detail: string): void => {
    issues.push({ field, code, detail });
  };

  const { steps, entryStepId } = options;

  if (steps.length === 0) {
    add('steps', 'EMPTY', 'A workflow with no steps produces nothing.');
    return { ok: false, issues: Object.freeze(issues) };
  }

  // ── Step identity ────────────────────────────────────────────────────────
  const byId = new Map<string, WorkflowStepDefinition>();
  steps.forEach((step, index) => {
    const where = `steps[${String(index)}]`;

    if (!isWorkflowStepKind((step as { kind: unknown }).kind)) {
      add(`${where}.kind`, 'UNKNOWN_KIND', `'${String(step.kind)}' is not a step kind.`);
      return;
    }
    if (typeof step.id !== 'string' || !STEP_ID.test(step.id)) {
      add(
        `${where}.id`,
        'BAD_FORMAT',
        `'${String(step.id)}' must be kebab-case, e.g. 'draft-section'.`,
      );
      return;
    }
    if (byId.has(step.id)) {
      // Every edge naming it would be ambiguous, and which one ran would
      // depend on how the list happened to be ordered.
      add(`${where}.id`, 'DUPLICATE', `Step id '${step.id}' appears more than once.`);
      return;
    }
    byId.set(step.id, step);

    const bound = binds(step);
    if (bound !== null && !BINDING_NAME.test(bound)) {
      add(`${where}.bindOutputTo`, 'BAD_FORMAT', `'${bound}' is not a usable binding name.`);
    }
  });

  if (!byId.has(entryStepId)) {
    add(
      'entryStepId',
      'UNKNOWN_STEP',
      `The entry step '${entryStepId}' is not one of the declared steps.`,
    );
    // Without an entry there is no graph to walk; the remaining checks would
    // all report the same absence in different words.
    return { ok: false, issues: Object.freeze(issues) };
  }

  // ── Transitions ──────────────────────────────────────────────────────────
  for (const step of byId.values()) {
    for (const target of outgoing(step)) {
      if (!byId.has(target)) {
        add(
          `steps.${step.id}`,
          'UNKNOWN_TRANSITION',
          `'${step.id}' transitions to '${target}', which is not a declared step.`,
        );
      }
    }

    if (step.kind === 'merge') {
      if (step.sources.length < 2) {
        add(
          `steps.${step.id}.sources`,
          'TOO_FEW_SOURCES',
          `A merge joins at least two steps; '${step.id}' names ${String(step.sources.length)}.`,
        );
      }
      for (const source of step.sources) {
        if (!byId.has(source)) {
          add(
            `steps.${step.id}.sources`,
            'UNKNOWN_STEP',
            `'${step.id}' merges '${source}', which is not a declared step.`,
          );
        }
      }
    }

    if (step.kind === 'branch') {
      if (step.cases.length === 0) {
        add(
          `steps.${step.id}.cases`,
          'NO_CASES',
          `A branch with no cases always takes its default; use a plain transition instead.`,
        );
      }
      const seen = new Set<string>();
      for (const entry of step.cases) {
        if (seen.has(entry.when)) {
          // Which one matched would depend on evaluation order.
          add(
            `steps.${step.id}.cases`,
            'DUPLICATE_CASE',
            `Case '${entry.when}' appears twice on '${step.id}'.`,
          );
        }
        seen.add(entry.when);
      }
    }
  }

  // ── Cycles ───────────────────────────────────────────────────────────────
  const cycle = findCycle(byId, entryStepId);
  if (cycle !== null) {
    add(
      'steps',
      'CYCLE',
      `The graph cycles: ${cycle.join(' → ')}. A workflow that returns to a step it has run never finishes.`,
    );
  }

  // ── Orphans ──────────────────────────────────────────────────────────────
  const live = reachable(byId, entryStepId);
  for (const step of byId.values()) {
    if (!live.has(step.id)) {
      add(
        `steps.${step.id}`,
        'ORPHAN',
        `'${step.id}' is unreachable from '${entryStepId}'; it is work someone believes is happening.`,
      );
    }
  }

  // ── Template references ──────────────────────────────────────────────────
  if (options.library !== undefined) {
    for (const step of byId.values()) {
      if (step.kind !== 'prompt') continue;

      const resolution = resolveTemplate({
        library: options.library,
        id: step.templateRef.id,
        selector: step.templateRef.selector,
        capability: options.capability,
        ...(options.providers === undefined ? {} : { providers: options.providers }),
      });

      if (resolution.outcome === 'refused') {
        // The library's own code and reason, not a paraphrase — it already
        // explains what to fix, and restating it would let the two drift.
        add(`steps.${step.id}.templateRef`, resolution.code, resolution.reason);
      }
    }
  }

  return issues.length === 0 ? { ok: true } : { ok: false, issues: Object.freeze(issues) };
}
