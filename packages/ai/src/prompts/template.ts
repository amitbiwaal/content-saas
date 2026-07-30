/**
 * The prompt contracts.
 *
 * Spec: `08-ai-platform/prompt-engine.md` §"Template anatomy" and §Inputs.
 *
 * ── Why these live in `packages/ai` and not in `packages/contracts` ─────────
 * `01-system-architecture/04-context-map.md` names exactly one published
 * interface for the AI Capability — `AIRequest`/`AIResponse`, the Open Host
 * Service. `PromptTemplate` appears in the same document as the capability's
 * UBIQUITOUS LANGUAGE, which is its internal vocabulary, not its contract with
 * other contexts. An engine supplies a `templateRef` and variables through the
 * Gateway; it never holds a template. So these stay here, and the boundary a
 * caller crosses stays the one already published.
 *
 * ── Prompts are data, not code ──────────────────────────────────────────────
 * A template is a versioned artifact with an owner, a changelog, and an
 * evaluation set — like a migration or an ADR. Nothing here is compiled into an
 * engine, and no prompt string exists outside a template.
 */

/**
 * Declared variable types (prompt-engine.md §"Template anatomy").
 *
 * A closed set because every one of them has a canonical string form, and
 * determinism depends on there being exactly one way to write each value.
 */
export const PROMPT_VARIABLE_TYPES = [
  'string',
  'number',
  'boolean',
  'enum',
  'string[]',
  'object',
] as const;

export type PromptVariableType = (typeof PROMPT_VARIABLE_TYPES)[number];

export function isPromptVariableType(value: unknown): value is PromptVariableType {
  return typeof value === 'string' && (PROMPT_VARIABLE_TYPES as readonly string[]).includes(value);
}

export interface VariableDeclaration {
  /** The placeholder name: `{{name}}` in the template's parts. */
  readonly name: string;
  readonly type: PromptVariableType;
  readonly required: boolean;
  /** Strings and string lists only — a bound on what a caller may inject. */
  readonly maxLength?: number;
  /** Required when `type` is 'enum', meaningless otherwise. */
  readonly enumValues?: readonly string[];
  /** What it is for. A declaration nobody can read is one nobody can satisfy. */
  readonly description: string;
}

/**
 * The version lifecycle's states.
 *
 * The states are declared; the WORKFLOW that moves between them — promotion,
 * rollback, the evaluation gate — is `prompt versioning`, which this increment
 * does not implement. What is honoured here is resolution: a `templateRef` with
 * no version resolves to the single `active` one.
 */
export const PROMPT_TEMPLATE_STATUSES = ['draft', 'evaluated', 'active', 'deprecated'] as const;

export type PromptTemplateStatus = (typeof PROMPT_TEMPLATE_STATUSES)[number];

/**
 * Model hints — an INPUT to routing, never a command (`model-router.md`).
 *
 * `preferredTier` from the spec is deliberately absent: tiers are the Router's
 * vocabulary and the Router is not in this increment. A tier nothing reads
 * would be a field callers set believing it did something.
 */
export interface PromptModelHints {
  readonly maxOutputTokens: number;
  readonly temperature: number;
  readonly seed?: number;
  /**
   * The template asserts that this task must reproduce exactly. Carried for
   * the Router; nothing here enforces it, because enforcing it means choosing
   * a model that supports a seed.
   */
  readonly determinismRequired: boolean;
}

export interface PromptParts {
  /** Role, constraints, output expectations. */
  readonly system: string;
  /** Platform-level invariants. Optional; composed into the system message. */
  readonly developer?: string;
  /** The task, carrying the variable slots. */
  readonly user: string;
}

/**
 * Where a `PromptContext` is injected.
 *
 * `framing` has one legal value and is written out anyway: the data-block
 * framing is the single most important structural defence in the pipeline
 * (`guardrails.md`), and a template declaring its framing explicitly is one
 * that cannot acquire a second, weaker option by omission.
 */
export interface PromptContextSlot {
  readonly position: 'before_user' | 'after_user';
  readonly framing: 'data_block';
}

export interface PromptTemplate {
  /** dot.case, stable FOREVER: renaming breaks every pinned reference. */
  readonly id: string;
  /** Monotonic. Immutable once active — fixes ship as a new version. */
  readonly version: number;
  /** Links to routing policy. Opaque here (`prompt-engine.md`). */
  readonly taskType: string;
  readonly status: PromptTemplateStatus;
  readonly parts: PromptParts;
  readonly contextSlot?: PromptContextSlot;
  readonly variables: readonly VariableDeclaration[];
  readonly modelHints: PromptModelHints;
  /**
   * Mandatory on every template (prompt-engine.md domain rule 3).
   *
   * The harness that honours it is out of scope; its PRESENCE is enforced here
   * anyway, because that is what stops the catalogue accumulating prompts
   * nobody can safely change — which is the whole reason the spec makes it
   * mandatory rather than optional.
   */
  readonly evalSetRef: string;
  readonly owner: string;
  readonly changelog: string;
}

export interface PromptTemplateRef {
  readonly id: string;
  /** Omitted resolves to the single `active` version. */
  readonly version?: number;
}

/**
 * What a caller supplies to render.
 *
 * The spec's `RenderRequest`, minus `overlayPermitted`: per-tenant overlays are
 * disabled by default and belong with the settings-driven prompt work, so an
 * overlay flag nothing applies would be a permission that grants nothing.
 */
export interface PromptInput {
  readonly templateRef: PromptTemplateRef;
  /**
   * UNTRUSTED DATA (prompt-engine.md domain rule 4). Substituted into declared
   * slots, never concatenated into instruction text.
   */
  readonly variables: Readonly<Record<string, unknown>>;
  /** Workspace — ADR-017. */
  readonly tenantId: string;
  readonly correlationId: string;
}

/** One piece of retrieved evidence, carried by reference to where it came from. */
export interface PromptContextBlock {
  /** Where this came from. A reference, never the source of truth. */
  readonly ref: string;
  readonly content: string;
}

/**
 * The evidence injected into the template's context slot.
 *
 * A reduced `ContextPackage`: the Context Builder that produces one is not in
 * this increment, so this carries only what the injection needs. Retrieved web
 * content arrives through here, which is why it is always framed as data and
 * never as instruction.
 */
export interface PromptContext {
  readonly blocks: readonly PromptContextBlock[];
}

export const PROMPT_ERROR_CODES = [
  'TemplateNotFound',
  'TemplateVersionNotFound',
  'AmbiguousTemplate',
  'InvalidTemplate',
  'VariableValidationFailed',
  'UndeclaredVariable',
  'PromptTooLarge',
  'ContextSlotUndeclared',
  'CapabilityMismatch',
  'MalformedExecutionRequest',
] as const;

export type PromptErrorCode = (typeof PROMPT_ERROR_CODES)[number];

/**
 * A prompt that could not be produced.
 *
 * There is NO fallback prompt, ever (prompt-engine.md domain rule). A missing
 * or broken template fails the request, because substituting a generic prompt
 * produces output that looks valid and is traceable to no version at all.
 */
export class PromptError extends Error {
  readonly code: PromptErrorCode;

  constructor(code: PromptErrorCode, message: string) {
    super(message);
    this.name = 'PromptError';
    this.code = code;
  }
}

export function isPromptError(value: unknown): value is PromptError {
  return value instanceof PromptError;
}

/** `'planning.outline@7'` — the reproducibility anchor. */
export function promptVersionOf(template: PromptTemplate): string {
  return `${template.id}@${String(template.version)}`;
}
