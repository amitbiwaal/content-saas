/**
 * Template validation and placeholder syntax.
 *
 * Spec: `08-ai-platform/prompt-engine.md` §Inputs — "Any failure returns a
 * typed error BEFORE dispatch — a malformed prompt must never reach a provider,
 * because it costs money and produces plausible-looking garbage."
 *
 * ── Why this reads an `unknown`, not a `PromptTemplate` ─────────────────────
 * The type holds inside the monorepo. It does not hold for a template rebuilt
 * from a job payload, loaded from a store, or handed over an admin API — and
 * those are exactly the paths a malformed template arrives by. Checking a value
 * the compiler has already promised is correct would assert nothing.
 *
 * ── The placeholder syntax, and why it is double-braced ─────────────────────
 * `{{name}}`. Single braces are unusable here: prompts routinely contain JSON,
 * both as an example of the output wanted and as data, and `{"a": 1}` would
 * parse as a placeholder called `"a": 1`. A template author would then have to
 * escape ordinary content, and the escape would be forgotten.
 *
 * A lone `{` or `}` is literal. Whitespace inside the braces is allowed and
 * ignored, so `{{ topic }}` and `{{topic}}` are the same slot — otherwise the
 * difference between them is an invisible bug.
 *
 * Every issue is reported rather than the first, so an author fixing a template
 * sees the whole picture in one cycle.
 */

import {
  PROMPT_TEMPLATE_STATUSES,
  PROMPT_VARIABLE_TYPES,
  type PromptTemplate,
} from './template.js';

export interface PromptIssue {
  readonly field: string;
  readonly code: string;
  readonly detail: string;
}

export type PromptValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly issues: readonly PromptIssue[] };

/** A well-formed slot: `{{name}}`, with optional inner whitespace. */
export const PLACEHOLDER = /\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g;

/**
 * Anything that OPENS like a placeholder.
 *
 * Matched separately from the well-formed pattern so that `{{1bad}}` and
 * `{{name` are reported as malformed rather than silently surviving as
 * literal text — a slot that looks like a slot and is not one renders the
 * braces to the model, which is a defect a reader would never spot in output.
 */
const PLACEHOLDER_OPENING = /\{\{/g;

/** dot.case, stable forever: 'planning.outline'. */
const DOT_CASE = /^[a-z][a-z0-9]*(\.[a-z0-9]+)+$/;
const VARIABLE_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

/**
 * Structural bounds.
 *
 * CHARACTERS, deliberately, not tokens. A token count needs the target model's
 * tokenizer, which belongs with cost management and is not in this increment —
 * and a chars/4 guess presented as `estimatedTokens` would be treated as a
 * budget by everything downstream. This is the bound that can be enforced
 * honestly today: it stops a runaway template or an unbounded variable, and
 * the real window check arrives with the tokenizer.
 */
export const MAX_TEMPLATE_CHARS = 32_000;
export const MAX_PROMPT_CHARS = 128_000;
export const MAX_CONTEXT_BLOCKS = 100;

type Add = (field: string, code: string, detail: string) => void;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/** Every well-formed placeholder name in a string, in order of appearance. */
export function placeholdersIn(text: string): readonly string[] {
  const names: string[] = [];
  for (const match of text.matchAll(PLACEHOLDER)) {
    const name = match[1];
    if (name !== undefined) names.push(name);
  }
  return names;
}

/** Openings that no well-formed placeholder accounts for. */
function malformedCount(text: string): number {
  return [...text.matchAll(PLACEHOLDER_OPENING)].length - [...text.matchAll(PLACEHOLDER)].length;
}

/** Declared names, in order, for the placeholder cross-check. */
function validateDeclarations(variables: unknown, add: Add): readonly string[] {
  if (!Array.isArray(variables)) {
    add('variables', 'NOT_ARRAY', 'variables must be an array, empty if the template takes none.');
    return [];
  }

  const declared: string[] = [];
  const seen = new Set<string>();

  variables.forEach((entry: unknown, i) => {
    const at = `variables[${String(i)}]`;
    if (!isRecord(entry)) {
      add(at, 'NOT_OBJECT', 'Each variable declaration must be an object.');
      return;
    }

    const name = entry['name'];
    if (typeof name !== 'string' || !VARIABLE_NAME.test(name)) {
      add(
        `${at}.name`,
        'BAD_NAME',
        `'${String(name)}' is not a usable placeholder name; it must start with a letter and contain only letters, digits and underscores.`,
      );
      return;
    }
    // Two declarations of one name means the second silently wins, and which
    // constraint applies depends on declaration order.
    if (seen.has(name)) {
      add(
        `${at}.name`,
        'DUPLICATE_VARIABLE',
        `'${name}' is declared more than once; the constraints that apply would depend on declaration order.`,
      );
      return;
    }
    seen.add(name);
    declared.push(name);

    const type = entry['type'];
    const knownType =
      typeof type === 'string' && (PROMPT_VARIABLE_TYPES as readonly string[]).includes(type);
    if (!knownType) {
      add(`${at}.type`, 'BAD_TYPE', `'${String(type)}' is not a declared type.`);
    }
    if (typeof entry['required'] !== 'boolean') {
      add(`${at}.required`, 'BAD_VALUE', 'required must be stated as a boolean.');
    }
    if (!nonEmptyString(entry['description'])) {
      add(
        `${at}.description`,
        'EMPTY',
        `'${name}' has no description; a declaration nobody can read is one nobody can satisfy.`,
      );
    }

    const enumValues = entry['enumValues'];
    if (type === 'enum') {
      if (!Array.isArray(enumValues) || enumValues.length === 0) {
        add(`${at}.enumValues`, 'MISSING', `enum variable '${name}' lists no values.`);
      }
    } else if (enumValues !== undefined) {
      add(
        `${at}.enumValues`,
        'NOT_APPLICABLE',
        `'${name}' is a ${String(type)}, so enumValues would never be checked.`,
      );
    }

    const maxLength = entry['maxLength'];
    if (maxLength !== undefined) {
      if (!Number.isInteger(maxLength) || (maxLength as number) < 1) {
        add(`${at}.maxLength`, 'BAD_VALUE', 'maxLength must be an integer >= 1.');
      }
      if (knownType && type !== 'string' && type !== 'string[]') {
        add(
          `${at}.maxLength`,
          'NOT_APPLICABLE',
          `maxLength bounds text; '${name}' is a ${String(type)}.`,
        );
      }
    }
  });

  return declared;
}

function validatePlaceholders(
  parts: Record<string, unknown>,
  declared: readonly string[],
  add: Add,
): void {
  const declaredSet = new Set(declared);
  const used = new Set<string>();

  for (const field of ['system', 'developer', 'user'] as const) {
    const text = parts[field];
    if (text === undefined) continue;
    if (typeof text !== 'string') {
      add(`parts.${field}`, 'NOT_STRING', `parts.${field} must be a string.`);
      continue;
    }

    const malformed = malformedCount(text);
    if (malformed > 0) {
      add(
        `parts.${field}`,
        'MALFORMED_PLACEHOLDER',
        `${String(malformed)} opening '{{' in parts.${field} does not form a placeholder. An unclosed or badly-named slot renders its braces to the model.`,
      );
    }

    for (const name of placeholdersIn(text)) {
      used.add(name);
      // Undeclared placeholders are rejected, not left blank: a slot with no
      // declaration can never be filled, so the model sees a hole in the
      // instruction and answers around it.
      if (!declaredSet.has(name)) {
        add(
          `parts.${field}`,
          'UNKNOWN_PLACEHOLDER',
          `'{{${name}}}' in parts.${field} is not a declared variable, so nothing could ever fill it.`,
        );
      }
    }
  }

  // The other direction. A caller forced to supply a value that appears
  // nowhere is one whose data silently fails to reach the model.
  for (const name of declaredSet) {
    if (!used.has(name)) {
      add(
        'variables',
        'UNUSED_VARIABLE',
        `'${name}' is declared but appears in no part, so a caller supplying it would change nothing.`,
      );
    }
  }
}

function validateParts(parts: unknown, declared: readonly string[], add: Add): void {
  if (!isRecord(parts)) {
    add('parts', 'MISSING', 'A template with no parts renders nothing.');
    return;
  }

  if (!nonEmptyString(parts['system'])) {
    add('parts.system', 'EMPTY', 'The system part carries the role and constraints.');
  }
  if (!nonEmptyString(parts['user'])) {
    add('parts.user', 'EMPTY', 'The user part carries the task.');
  }
  const developer = parts['developer'];
  if (developer !== undefined && !nonEmptyString(developer)) {
    add('parts.developer', 'EMPTY', 'An empty developer part is a field, not an invariant.');
  }

  validatePlaceholders(parts, declared, add);

  const size = (['system', 'developer', 'user'] as const).reduce((total, field) => {
    const text = parts[field];
    return total + (typeof text === 'string' ? text.length : 0);
  }, 0);
  if (size > MAX_TEMPLATE_CHARS) {
    add(
      'parts',
      'TEMPLATE_TOO_LARGE',
      `The template is ${String(size)} characters, over the ${String(MAX_TEMPLATE_CHARS)} bound.`,
    );
  }
}

function validateContextSlot(slot: unknown, add: Add): void {
  if (slot === undefined) return;
  if (!isRecord(slot)) {
    add('contextSlot', 'NOT_OBJECT', 'contextSlot must be an object when declared.');
    return;
  }
  const position = slot['position'];
  if (position !== 'before_user' && position !== 'after_user') {
    add('contextSlot.position', 'BAD_VALUE', 'position must be before_user or after_user.');
  }
  // Retrieved web content arrives through this slot. There is one framing.
  if (slot['framing'] !== 'data_block') {
    add(
      'contextSlot.framing',
      'BAD_FRAMING',
      'The context slot is always a data block; instruction framing would make retrieved content executable.',
    );
  }
}

function validateHints(hints: unknown, add: Add): void {
  if (!isRecord(hints)) {
    add('modelHints', 'MISSING', 'modelHints are required; unstated sampling is a vendor default.');
    return;
  }
  const temperature = hints['temperature'];
  if (typeof temperature !== 'number' || !Number.isFinite(temperature) || temperature < 0) {
    add('modelHints.temperature', 'BAD_VALUE', 'temperature must be a finite number >= 0.');
  }
  const maxOutputTokens = hints['maxOutputTokens'];
  if (!Number.isInteger(maxOutputTokens) || (maxOutputTokens as number) < 1) {
    add('modelHints.maxOutputTokens', 'BAD_VALUE', 'maxOutputTokens must be an integer >= 1.');
  }
  if (typeof hints['determinismRequired'] !== 'boolean') {
    add('modelHints.determinismRequired', 'BAD_VALUE', 'determinismRequired must be stated.');
  }
  const seed = hints['seed'];
  if (seed !== undefined && !Number.isInteger(seed)) {
    add('modelHints.seed', 'BAD_VALUE', 'seed, when given, must be an integer.');
  }
}

/** Reject an invalid template — every issue at once. */
export function validatePromptTemplate(template: PromptTemplate): PromptValidationResult {
  const issues: PromptIssue[] = [];
  const add: Add = (field, code, detail) => {
    issues.push({ field, code, detail });
  };

  // The declared type is a convenience for callers; what actually arrives may
  // have come from anywhere. See the note at the top of the file.
  const raw = template as unknown as Record<string, unknown>;

  const id = raw['id'];
  if (typeof id !== 'string' || !DOT_CASE.test(id)) {
    add('id', 'BAD_FORMAT', `'${String(id)}' must be dot.case, e.g. 'planning.outline'.`);
  }
  const version = raw['version'];
  if (!Number.isInteger(version) || (version as number) < 1) {
    add('version', 'BAD_VERSION', 'version must be an integer >= 1.');
  }
  const taskType = raw['taskType'];
  if (typeof taskType !== 'string' || !DOT_CASE.test(taskType)) {
    add('taskType', 'BAD_FORMAT', 'taskType must be dot.case.');
  }
  const status = raw['status'];
  if (
    typeof status !== 'string' ||
    !(PROMPT_TEMPLATE_STATUSES as readonly string[]).includes(status)
  ) {
    add('status', 'BAD_STATUS', `'${String(status)}' is not a lifecycle state.`);
  }

  const declared = validateDeclarations(raw['variables'], add);
  validateParts(raw['parts'], declared, add);
  validateContextSlot(raw['contextSlot'], add);
  validateHints(raw['modelHints'], add);

  // Mandatory by domain rule 3: it is what stops the catalogue accumulating
  // prompts nobody can safely change.
  if (!nonEmptyString(raw['evalSetRef'])) {
    add(
      'evalSetRef',
      'EMPTY',
      'Every template names an evaluation set; without one it can never be promoted or safely edited.',
    );
  }
  if (!nonEmptyString(raw['owner'])) {
    add('owner', 'EMPTY', 'A template with no owner is one nobody maintains.');
  }
  if (!nonEmptyString(raw['changelog'])) {
    add('changelog', 'EMPTY', 'A version with no changelog cannot be diffed against its cause.');
  }

  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}
