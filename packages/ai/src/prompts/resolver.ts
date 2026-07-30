/**
 * The prompt resolver: a `templateRef` to an immutable template version, and
 * from there to a compiled prompt.
 *
 * Spec: `08-ai-platform/prompt-engine.md` §Workflow.
 *
 * ── The catalogue is source-controlled, not stored ──────────────────────────
 * The spec puts templates in `prompt_templates` / `prompt_template_versions`;
 * prompt STORAGE is out of this increment, so the catalogue is built once from
 * declared templates, exactly as the event, settings, flag and notification
 * registries are. That is not a stand-in for the tables — it is the same rule
 * those registries follow, and it means a template cannot appear at runtime
 * without a commit.
 *
 * ── There is no fallback prompt, ever ───────────────────────────────────────
 * An unknown id or an unresolvable version fails the request. Substituting a
 * generic prompt would produce output that looks valid and is traceable to no
 * version at all.
 */

import {
  PromptError,
  type PromptContext,
  type PromptInput,
  type PromptTemplate,
  type PromptTemplateRef,
} from './template.js';
import { compilePrompt, type CompiledPrompt } from './compile.js';
import { validatePromptTemplate } from './validation.js';

export interface PromptCatalogue {
  /** Throws `TemplateNotFound` / `TemplateVersionNotFound` — never guesses. */
  resolve(ref: PromptTemplateRef): PromptTemplate;
  has(ref: PromptTemplateRef): boolean;
  /** Every version, in declaration order. Frozen. */
  list(): readonly PromptTemplate[];
  listIds(): readonly string[];
  versionsOf(id: string): readonly number[];
  /** Resolve, then compile. The whole path a caller takes. */
  render(input: PromptInput, context?: PromptContext): CompiledPrompt;
}

const key = (id: string, version: number): string => `${id}@${String(version)}`;

/**
 * Build the catalogue, rejecting anything malformed at construction.
 *
 * Every template is validated HERE rather than at render: a broken template
 * discovered on the first customer request is a broken template that shipped.
 * Every issue across every template is reported together, because a
 * composition root that is wrong in two places should learn both at once.
 */
export function createPromptCatalogue(templates: readonly PromptTemplate[]): PromptCatalogue {
  const byKey = new Map<string, PromptTemplate>();
  const active = new Map<string, PromptTemplate>();
  const versions = new Map<string, number[]>();
  const problems: string[] = [];

  for (const template of templates) {
    const result = validatePromptTemplate(template);
    if (!result.ok) {
      problems.push(
        `${String(template.id)}@${String(template.version)}: ${result.issues
          .map((i) => `${i.field} ${i.code}`)
          .join(', ')}`,
      );
      continue;
    }

    const k = key(template.id, template.version);
    if (byKey.has(k)) {
      problems.push(`${k} is declared more than once; a version is immutable and singular.`);
      continue;
    }
    byKey.set(k, template);

    const list = versions.get(template.id) ?? [];
    list.push(template.version);
    list.sort((a, b) => a - b);
    versions.set(template.id, list);

    // Only one active version per id at a time. Two would make an unversioned
    // ref ambiguous, and which one answered would depend on declaration order.
    if (template.status === 'active') {
      const existing = active.get(template.id);
      if (existing !== undefined) {
        problems.push(
          `${template.id} has two active versions (${String(existing.version)} and ${String(template.version)}); an unversioned reference could resolve to either.`,
        );
        continue;
      }
      active.set(template.id, template);
    }
  }

  if (problems.length > 0) {
    throw new PromptError(
      'InvalidTemplate',
      `The prompt catalogue cannot be built:\n  - ${problems.join('\n  - ')}`,
    );
  }

  const frozen = Object.freeze([...byKey.values()]);

  const catalogue: PromptCatalogue = {
    resolve(ref): PromptTemplate {
      if (ref.version === undefined) {
        const current = active.get(ref.id);
        if (current !== undefined) return current;
        // Distinguish "no such template" from "no active version": one is a
        // typo, the other is a template that exists but nothing may use yet.
        if (versions.has(ref.id)) {
          throw new PromptError(
            'TemplateVersionNotFound',
            `'${ref.id}' has no active version. Declared: ${(versions.get(ref.id) ?? []).join(', ')}. Pin a version explicitly or promote one.`,
          );
        }
        throw new PromptError(
          'TemplateNotFound',
          `No prompt template '${ref.id}'. Known: ${[...versions.keys()].join(', ') || '(none)'}.`,
        );
      }

      const found = byKey.get(key(ref.id, ref.version));
      if (found !== undefined) return found;
      if (versions.has(ref.id)) {
        throw new PromptError(
          'TemplateVersionNotFound',
          `'${ref.id}' has no version ${String(ref.version)}. Declared: ${(versions.get(ref.id) ?? []).join(', ')}.`,
        );
      }
      throw new PromptError(
        'TemplateNotFound',
        `No prompt template '${ref.id}'. Known: ${[...versions.keys()].join(', ') || '(none)'}.`,
      );
    },

    has(ref): boolean {
      return ref.version === undefined ? active.has(ref.id) : byKey.has(key(ref.id, ref.version));
    },

    list: () => frozen,
    listIds: () => Object.freeze([...versions.keys()]),
    versionsOf: (id) => Object.freeze([...(versions.get(id) ?? [])]),

    render(input, context): CompiledPrompt {
      const template = catalogue.resolve(input.templateRef);
      // A deprecated version still renders when pinned — workflows pin at run
      // start, and a promotion mid-run must not change what they are running.
      return context === undefined
        ? compilePrompt({ template, input })
        : compilePrompt({ template, input, context });
    },
  };

  return catalogue;
}
