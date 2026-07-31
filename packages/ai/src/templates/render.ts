/**
 * Canonical rendering.
 *
 * ── It delegates. That is the whole design ──────────────────────────────────
 * Variable binding, type checking, unknown-variable rejection, placeholder
 * substitution and message assembly all live in `compilePrompt` (S2.3), which
 * is frozen, pure and already the thing the workflow runtime and the Gateway
 * consume. A second renderer here would be a second definition of what a
 * prompt IS — and the two would diverge first on the case that matters, which
 * is the one nobody wrote a test for.
 *
 * So this file adds exactly what the library knows and the compiler does not:
 * which template entry produced the prompt, its semantic version, and what it
 * declares itself compatible with.
 *
 * ── The render order is the compiler's, and it is fixed ─────────────────────
 * `compile.ts` assembles `system` (with the developer part composed in) and
 * then `user`, in that order, and says why: the platform's role vocabulary is
 * `system | user | assistant` and is frozen, so a developer part is
 * platform-level invariant text that belongs with the role and the
 * constraints — not a fourth role invented at this layer.
 *
 * `RENDER_ORDER` states that as data so a conformance test can hold the
 * compiler to it rather than a comment describing it.
 *
 * ── Pure ───────────────────────────────────────────────────────────────────
 * No clock, no random source, no I/O, nothing provider-specific. The same
 * version and the same variables produce a byte-identical `CanonicalPrompt`,
 * which is `prompt-engine.md` domain rule 9 and the reason a historical call
 * can be reproduced at all.
 */

import type { AICapability, AIMessage } from '@contentos/contracts';

import { compilePrompt } from '../prompts/compile.js';
import type { PromptContext, PromptModelHints } from '../prompts/template.js';
import { formatSemanticVersion, type TemplateCapability } from './metadata.js';
import type { ResolvedTemplate } from './resolve.js';

/**
 * The parts, in the order the compiler composes them.
 *
 * `developer` sits between `system` and `user` because it is composed INTO the
 * system message after the system text and before the user message is built.
 */
export const RENDER_ORDER = ['system', 'developer', 'user'] as const;

export type RenderPart = (typeof RENDER_ORDER)[number];

export interface CanonicalPrompt {
  readonly templateId: string;
  /** The monotonic identity. */
  readonly templateVersion: number;
  /** `'2.1.0'`. Descriptive; the integer above is what resolves. */
  readonly semanticVersion: string;
  /** `'planning.outline@7'` — the reproducibility anchor. */
  readonly promptVersion: string;
  readonly taskType: string;
  readonly capability: AICapability;
  /**
   * The messages, exactly as the frozen compiler produced them.
   *
   * Not re-derived here. A caller that needs the prompt sends these.
   */
  readonly messages: readonly AIMessage[];
  /**
   * Which parts the template declared, in render order.
   *
   * Reported rather than re-rendered: the developer part is composed into the
   * system message by the compiler, so a separate `developer` string here would
   * be a second substitution of the same text and a second chance to disagree.
   */
  readonly parts: readonly RenderPart[];
  /** The template's hints, for the Router. Not applied to any request here. */
  readonly hints: PromptModelHints;
  readonly promptChars: number;
  readonly compatibility: TemplateCapability;
}

export interface RenderOptions {
  readonly resolved: ResolvedTemplate;
  /** UNTRUSTED. Substituted into declared slots, never concatenated. */
  readonly variables: Readonly<Record<string, unknown>>;
  /**
   * The workspace (ADR-017) and the correlation id.
   *
   * Required rather than defaulted because the frozen `PromptInput` declares
   * them. The compiler carries them and does not read them, so a blank would
   * render identically — which is exactly why fabricating one here would be
   * invisible until something downstream needed the real value.
   */
  readonly tenantId: string;
  readonly correlationId: string;
  /** Retrieved evidence, where the template declares a slot for it. */
  readonly context?: PromptContext;
}

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
 * Render a resolved template.
 *
 * Throws `PromptError` — the pipeline's own — for a missing variable, an
 * unknown one, a type mismatch or an oversized prompt. Not re-wrapped: a caller
 * catching two error types for one failure is a caller that will catch one of
 * them, and the pipeline's messages already explain what to fix.
 */
export function renderCanonicalPrompt(options: RenderOptions): CanonicalPrompt {
  const { resolved, variables, context } = options;
  const { version, template } = resolved;

  const compiled = compilePrompt({
    template: version.prompt,
    input: {
      templateRef: { id: template.id, version: version.prompt.version },
      variables,
      tenantId: options.tenantId,
      correlationId: options.correlationId,
    },
    ...(context === undefined ? {} : { context }),
  });

  const parts: RenderPart[] = ['system'];
  if (version.prompt.parts.developer !== undefined) parts.push('developer');
  parts.push('user');

  return deepFreeze({
    templateId: compiled.templateId,
    templateVersion: compiled.templateVersion,
    semanticVersion: formatSemanticVersion(version.semanticVersion),
    promptVersion: compiled.promptVersion,
    taskType: compiled.taskType,
    capability: version.compatibility.capability,
    messages: compiled.messages,
    parts: Object.freeze(parts),
    hints: compiled.hints,
    promptChars: compiled.promptChars,
    compatibility: version.compatibility,
  });
}
