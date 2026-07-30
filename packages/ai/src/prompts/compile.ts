/**
 * The prompt compiler: template + variables + context → a compiled prompt.
 *
 * Spec: `08-ai-platform/prompt-engine.md`. Rendering is PURE and
 * DETERMINISTIC — "identical template version plus identical variables plus
 * identical context yields byte-identical output" (domain rule 9).
 *
 * That is not a nicety. `promptVersion` is one of the inputs from which a
 * producing engine composes `algorithmVersion` (ADR-021), and the whole promise
 * is that a prompt change bumps `algorithmVersion` and nothing else. If the
 * same version could render two ways, the anchor would point at two different
 * prompts and "why did quality change last Tuesday?" would stop being
 * answerable.
 *
 * Determinism is bought with three rules, all applied below:
 *   - every value has exactly ONE canonical string form (object keys sorted,
 *     lists joined with a fixed separator, numbers written one way);
 *   - message order is fixed, never derived from object iteration;
 *   - nothing reads a clock, a random source, or a locale.
 *
 * ── Variables are untrusted data ────────────────────────────────────────────
 * They are substituted into declared slots and never concatenated into
 * instruction text (domain rule 4). The structural defence is the strongest
 * one available: messages are objects with a role, so a value cannot open a new
 * message however it is written. On top of that, a value cannot forge the
 * data-block delimiters — see `neutralise` below.
 */

import type { AIMessage } from '@contentos/contracts';

import {
  promptVersionOf,
  PromptError,
  type PromptContext,
  type PromptInput,
  type PromptModelHints,
  type PromptTemplate,
  type VariableDeclaration,
} from './template.js';
import { MAX_CONTEXT_BLOCKS, MAX_PROMPT_CHARS, PLACEHOLDER } from './validation.js';

/**
 * The data-block delimiters.
 *
 * Retrieved web content arrives inside these. They are unusual on purpose:
 * ordinary prose does not contain them, so neutralising them costs nothing,
 * while a forged terminator would let retrieved content escape the block and
 * be read as instruction (`guardrails.md`).
 */
const BLOCK_OPEN = '<<<CONTEXT';
const BLOCK_CLOSE = 'CONTEXT>>>';

/** A forged delimiter is broken, not rejected: real evidence must still flow. */
function neutralise(text: string): string {
  return text.split(BLOCK_OPEN).join('<<​CONTEXT').split(BLOCK_CLOSE).join('CONTEXT​>>');
}

export interface CompiledPrompt {
  readonly templateId: string;
  readonly templateVersion: number;
  /** `'planning.outline@7'` — the reproducibility anchor. */
  readonly promptVersion: string;
  readonly taskType: string;
  /** system (with the developer part composed in), then user. Fixed order. */
  readonly messages: readonly AIMessage[];
  readonly hints: PromptModelHints;
  /**
   * The size that was actually measured, in characters.
   *
   * Not an estimated token count: that needs the target model's tokenizer,
   * which is not in this increment, and a chars/4 guess labelled `tokens`
   * would be spent as a budget by everything downstream.
   */
  readonly promptChars: number;
}

/** Deep-frozen so a compiled prompt cannot be edited after it is produced. */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.getOwnPropertyNames(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

/**
 * ONE canonical string form per value.
 *
 * `JSON.stringify` follows insertion order, so two objects that are equal can
 * serialize differently — which is exactly the way determinism is lost without
 * anyone noticing.
 */
function canonicalJson(value: unknown): string {
  // `JSON.stringify(undefined)` returns undefined, not a string — its type says
  // otherwise. Written out because an undefined inside an array must render as
  // `null`, which is what JSON.stringify itself does there.
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

function canonicalise(declaration: VariableDeclaration, value: unknown): string {
  switch (declaration.type) {
    case 'string':
    case 'enum':
      return value as string;
    case 'number':
      return String(value);
    case 'boolean':
      return value === true ? 'true' : 'false';
    // One item per line rather than a comma list: an item containing a comma
    // would otherwise be indistinguishable from two items.
    case 'string[]':
      return (value as readonly string[]).join('\n');
    case 'object':
      return canonicalJson(value);
  }
}

function typeMatches(declaration: VariableDeclaration, value: unknown): boolean {
  switch (declaration.type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'enum':
      return typeof value === 'string' && (declaration.enumValues ?? []).includes(value);
    case 'string[]':
      return Array.isArray(value) && value.every((v) => typeof v === 'string');
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
}

/**
 * Bind supplied values to declarations.
 *
 * Every failure is collected and reported together: a caller whose request is
 * wrong in three ways should learn all three, not discover them one deploy at
 * a time.
 */
function bind(
  template: PromptTemplate,
  variables: Readonly<Record<string, unknown>>,
): ReadonlyMap<string, string> {
  const bound = new Map<string, string>();
  const problems: string[] = [];
  const declared = new Map(template.variables.map((v) => [v.name, v]));

  for (const declaration of template.variables) {
    const supplied = Object.prototype.hasOwnProperty.call(variables, declaration.name);
    const value = variables[declaration.name];

    if (!supplied || value === undefined || value === null) {
      if (declaration.required) {
        problems.push(`'${declaration.name}' is required and was not supplied`);
      } else {
        // An optional slot with no value renders empty, not as its own name.
        bound.set(declaration.name, '');
      }
      continue;
    }

    if (!typeMatches(declaration, value)) {
      problems.push(
        `'${declaration.name}' must be a ${declaration.type}${
          declaration.type === 'enum' ? ` (${(declaration.enumValues ?? []).join(' | ')})` : ''
        }, got ${Array.isArray(value) ? 'array' : typeof value}`,
      );
      continue;
    }

    const rendered = canonicalise(declaration, value);
    if (declaration.maxLength !== undefined && rendered.length > declaration.maxLength) {
      problems.push(
        `'${declaration.name}' is ${String(rendered.length)} characters, over its declared bound of ${String(declaration.maxLength)}`,
      );
      continue;
    }

    bound.set(declaration.name, neutralise(rendered));
  }

  // Silent extra variables hide caller bugs: the caller believes the value
  // reached the model, and the quality loss is never attributed.
  const undeclared = Object.keys(variables).filter((name) => !declared.has(name));
  if (undeclared.length > 0) {
    throw new PromptError(
      'UndeclaredVariable',
      `${promptVersionOf(template)} does not declare ${undeclared.map((n) => `'${n}'`).join(', ')}. Supplying a variable the template never uses is a caller bug that would otherwise surface as unexplained quality loss.`,
    );
  }

  if (problems.length > 0) {
    throw new PromptError(
      'VariableValidationFailed',
      `${promptVersionOf(template)} cannot be rendered: ${problems.join('; ')}.`,
    );
  }

  return bound;
}

/** Substitute bound values into every declared slot. */
function substitute(text: string, bound: ReadonlyMap<string, string>): string {
  return text.replace(PLACEHOLDER, (whole, name: string) => bound.get(name) ?? whole);
}

/** Retrieved evidence, framed as data. Never as instruction. */
function renderContext(context: PromptContext): string {
  const blocks = context.blocks.map(
    (block) =>
      `${BLOCK_OPEN} ref=${JSON.stringify(block.ref)}\n${neutralise(block.content)}\n${BLOCK_CLOSE}`,
  );
  return blocks.join('\n');
}

export interface CompileOptions {
  readonly template: PromptTemplate;
  readonly input: PromptInput;
  readonly context?: PromptContext;
}

/**
 * Compile a prompt. Pure: same input, byte-identical output.
 *
 * Validation of the TEMPLATE itself belongs to `validatePromptTemplate` and is
 * expected to have run — this rejects what only becomes knowable once the
 * caller's values are in hand.
 */
export function compilePrompt(options: CompileOptions): CompiledPrompt {
  const { template, input, context } = options;

  if (context !== undefined) {
    if (template.contextSlot === undefined) {
      throw new PromptError(
        'ContextSlotUndeclared',
        `${promptVersionOf(template)} declares no context slot, so evidence supplied with it has nowhere to go that is not instruction text.`,
      );
    }
    if (context.blocks.length > MAX_CONTEXT_BLOCKS) {
      throw new PromptError(
        'PromptTooLarge',
        `${String(context.blocks.length)} context blocks exceeds the ${String(MAX_CONTEXT_BLOCKS)} bound.`,
      );
    }
  }

  const bound = bind(template, input.variables);

  const system = substitute(template.parts.system, bound);
  // Composed into the system message rather than emitted as a fourth role:
  // the platform's role vocabulary is `system | user | assistant` and is
  // frozen, and a developer part is platform-level invariant text that belongs
  // with the role and the constraints.
  const developer =
    template.parts.developer === undefined ? '' : substitute(template.parts.developer, bound);
  const user = substitute(template.parts.user, bound);

  const contextText =
    context === undefined || context.blocks.length === 0 ? '' : renderContext(context);
  const body =
    contextText === ''
      ? user
      : template.contextSlot?.position === 'before_user'
        ? `${contextText}\n\n${user}`
        : `${user}\n\n${contextText}`;

  const messages: AIMessage[] = [
    { role: 'system', content: developer === '' ? system : `${system}\n\n${developer}` },
    { role: 'user', content: body },
  ];

  const promptChars = messages.reduce((total, message) => total + message.content.length, 0);
  if (promptChars > MAX_PROMPT_CHARS) {
    throw new PromptError(
      'PromptTooLarge',
      `The compiled prompt is ${String(promptChars)} characters, over the ${String(MAX_PROMPT_CHARS)} bound. The Context Builder re-trims or the Gateway re-routes; this never truncates silently.`,
    );
  }

  return deepFreeze<CompiledPrompt>({
    templateId: template.id,
    templateVersion: template.version,
    promptVersion: promptVersionOf(template),
    taskType: template.taskType,
    messages,
    hints: { ...template.modelHints },
    promptChars,
  });
}
