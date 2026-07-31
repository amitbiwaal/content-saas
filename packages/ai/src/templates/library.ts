/**
 * The template library — identity, versions, and the sealed registry.
 *
 * ── A naming deviation, stated rather than hidden ───────────────────────────
 * The increment names four types: `PromptTemplate`, `PromptVersion`,
 * `TemplateMetadata`, `TemplateCapability`. Three are used verbatim. The fourth
 * cannot be: `PromptTemplate` is already exported by the FROZEN S2.3 pipeline,
 * where it means precisely what this increment calls a `PromptVersion` — one
 * immutable, renderable artifact with parts, variables and hints.
 *
 * Shadowing it would give the platform two `PromptTemplate`s meaning different
 * things, in one barrel. So the identity-level aggregate is `LibraryTemplate`,
 * and `PromptVersion` WRAPS the frozen `PromptTemplate` rather than restating
 * it — which is also what "reuse the Prompt Pipeline" requires.
 *
 * ── Sealed, like every other registry here ──────────────────────────────────
 * Registration ends at startup. `prompt-engine.md` is unambiguous that an
 * active version is immutable and that "editing an active prompt would silently
 * change every historical call's provenance"; a registry that accepted a
 * template mid-process would do exactly that to the calls already in flight.
 *
 * ── One active version per id ───────────────────────────────────────────────
 * "Only one `active` version per template id at a time. Resolution without an
 * explicit version returns that one." Enforced at seal, not hoped for: two
 * active versions make `latest stable` a coin toss, and the coin lands
 * differently on each instance.
 */

import { AI_CAPABILITIES, isAICapability, type AICapability } from '@contentos/contracts';

import {
  promptVersionOf,
  type PromptTemplate,
  type PromptTemplateStatus,
} from '../prompts/template.js';
import { validatePromptTemplate } from '../prompts/validation.js';
import {
  compareSemanticVersions,
  formatSemanticVersion,
  isTemplateVisibility,
  parseSemanticVersion,
  type SemanticVersion,
  type TemplateCapability,
  type TemplateMetadata,
} from './metadata.js';

/**
 * One immutable version.
 *
 * `prompt` is the S2.3 artifact, unchanged — the same value `compilePrompt`,
 * the workflow runtime and the Gateway already consume. Everything else here is
 * what the library adds around it.
 */
export interface PromptVersion {
  /** The frozen render unit. Its `version` is the monotonic identity. */
  readonly prompt: PromptTemplate;
  readonly semanticVersion: SemanticVersion;
  readonly compatibility: TemplateCapability;
}

/** The identity level: one id, its metadata, and every version of it. */
export interface LibraryTemplate {
  readonly id: string;
  readonly metadata: TemplateMetadata;
  /** Ascending by monotonic version. Never empty. */
  readonly versions: readonly PromptVersion[];
}

/** What a caller registers. The library derives the rest. */
export interface TemplateDefinition {
  readonly id: string;
  readonly metadata: TemplateMetadata;
  readonly versions: readonly {
    readonly prompt: PromptTemplate;
    /** `'2.1.0'`. Parsed and rejected here if it is not one. */
    readonly semanticVersion: string;
    readonly compatibility: TemplateCapability;
  }[];
}

export const TEMPLATE_LIBRARY_ERROR_CODES = [
  'Sealed',
  'Empty',
  'DuplicateTemplate',
  'DuplicateVersion',
  'InvalidTemplate',
  'InvalidVersion',
  'InvalidMetadata',
  'InvalidCompatibility',
  'MismatchedId',
  'MultipleActiveVersions',
  'NonMonotonicVersions',
] as const;

export type TemplateLibraryErrorCode = (typeof TEMPLATE_LIBRARY_ERROR_CODES)[number];

export class TemplateLibraryError extends Error {
  readonly code: TemplateLibraryErrorCode;
  constructor(code: TemplateLibraryErrorCode, message: string) {
    super(message);
    this.name = 'TemplateLibraryError';
    this.code = code;
  }
}

export function isTemplateLibraryError(value: unknown): value is TemplateLibraryError {
  return value instanceof TemplateLibraryError;
}

export interface TemplateLibrary {
  register(definition: TemplateDefinition): void;
  /** Throws on an unknown id — see the note on `find`. */
  get(id: string): LibraryTemplate;
  /** Null for an unknown id, when absence is an answer rather than a fault. */
  find(id: string): LibraryTemplate | null;
  has(id: string): boolean;
  /** Registration order, frozen. */
  list(): readonly LibraryTemplate[];
  /** Every template with a version declaring this capability. */
  byCapability(capability: AICapability): readonly LibraryTemplate[];
  /** One version by its monotonic number. Null when there is none. */
  version(id: string, version: number): PromptVersion | null;
  /** The single `active` version, or null when none is. */
  latestStable(id: string): PromptVersion | null;
  seal(): void;
  readonly sealed: boolean;
}

function assertMetadata(id: string, metadata: TemplateMetadata): TemplateMetadata {
  for (const [field, value] of [
    ['title', metadata.title],
    ['description', metadata.description],
    ['owner', metadata.owner],
  ] as const) {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new TemplateLibraryError('InvalidMetadata', `Template '${id}' needs a ${field}.`);
    }
  }
  if (!isTemplateVisibility(metadata.visibility)) {
    throw new TemplateLibraryError(
      'InvalidMetadata',
      `Template '${id}' has visibility '${String(metadata.visibility)}', which is not one of public, internal.`,
    );
  }

  // Lower-cased and de-duplicated so a tag search is a set membership test
  // rather than a case-insensitive scan that two callers implement differently.
  const tags = [...new Set(metadata.tags.map((tag) => tag.trim().toLowerCase()))].filter(
    (tag) => tag !== '',
  );
  return Object.freeze({ ...metadata, tags: Object.freeze(tags.sort()) });
}

function assertCompatibility(where: string, compatibility: TemplateCapability): TemplateCapability {
  // Read behind the declared type: a definition assembled from configuration is
  // exactly how a capability outside the fixed set arrives.
  if (!isAICapability((compatibility as { capability: unknown }).capability)) {
    throw new TemplateLibraryError(
      'InvalidCompatibility',
      `${where} declares capability '${String(compatibility.capability)}', which is not one of ${AI_CAPABILITIES.join(', ')}.`,
    );
  }
  for (const [field, list] of [
    ['providers', compatibility.providers],
    ['models', compatibility.models],
  ] as const) {
    if (list === null) continue;
    if (list.length === 0) {
      // An empty list means nothing may run it, which is a template that fails
      // at resolution rather than at registration. `null` is how "any" is said.
      throw new TemplateLibraryError(
        'InvalidCompatibility',
        `${where} declares an empty ${field} list; use null for "any", because an empty list means nothing can ever run this.`,
      );
    }
    if (list.some((entry) => entry.trim() === '')) {
      throw new TemplateLibraryError(
        'InvalidCompatibility',
        `${where} has an empty ${field} entry.`,
      );
    }
  }
  return Object.freeze({
    ...compatibility,
    providers:
      compatibility.providers === null ? null : Object.freeze([...compatibility.providers]),
    models: compatibility.models === null ? null : Object.freeze([...compatibility.models]),
  });
}

function buildVersion(id: string, entry: TemplateDefinition['versions'][number]): PromptVersion {
  const { prompt } = entry;

  if (prompt.id !== id) {
    throw new TemplateLibraryError(
      'MismatchedId',
      `Template '${id}' holds a version whose prompt is '${prompt.id}'; a pinned reference would resolve to the wrong artifact.`,
    );
  }

  // The pipeline's OWN validator, not a second opinion. A library that
  // re-checked template shape would eventually disagree with the compiler that
  // has to render it.
  const validation = validatePromptTemplate(prompt);
  if (!validation.ok) {
    throw new TemplateLibraryError(
      'InvalidTemplate',
      `${promptVersionOf(prompt)} is not renderable: ${validation.issues
        .map((issue) => `${issue.field} ${issue.code}`)
        .join(', ')}.`,
    );
  }

  const semanticVersion = parseSemanticVersion(entry.semanticVersion);
  if (semanticVersion === null) {
    throw new TemplateLibraryError(
      'InvalidVersion',
      `${promptVersionOf(prompt)} has semantic version '${entry.semanticVersion}'; the form is major.minor.patch, with no range, prefix or pre-release.`,
    );
  }

  return Object.freeze({
    prompt: Object.freeze(prompt),
    semanticVersion,
    compatibility: assertCompatibility(promptVersionOf(prompt), entry.compatibility),
  });
}

const ACTIVE: PromptTemplateStatus = 'active';

export function createTemplateLibrary(
  definitions: readonly TemplateDefinition[] = [],
): TemplateLibrary {
  const ordered: LibraryTemplate[] = [];
  const byId = new Map<string, LibraryTemplate>();
  let sealed = false;

  const library: TemplateLibrary = {
    register(definition: TemplateDefinition): void {
      if (sealed) {
        throw new TemplateLibraryError(
          'Sealed',
          `The library is sealed; '${definition.id}' cannot be added. An active prompt that changed mid-process would alter the provenance of calls already in flight.`,
        );
      }
      if (byId.has(definition.id)) {
        throw new TemplateLibraryError(
          'DuplicateTemplate',
          `Template '${definition.id}' is registered twice; which one won would depend on registration order.`,
        );
      }
      if (definition.versions.length === 0) {
        throw new TemplateLibraryError(
          'Empty',
          `Template '${definition.id}' declares no versions, so nothing could ever resolve to it.`,
        );
      }

      const versions = definition.versions.map((entry) => buildVersion(definition.id, entry));

      const numbers = new Set<number>();
      let previous = 0;
      for (const version of versions) {
        const number = version.prompt.version;
        if (numbers.has(number)) {
          throw new TemplateLibraryError(
            'DuplicateVersion',
            `Template '${definition.id}' declares version ${String(number)} twice.`,
          );
        }
        if (number <= previous) {
          // Monotonic, as `prompt-engine.md` requires. Out of order, "the
          // latest" would depend on how the list happened to be written.
          throw new TemplateLibraryError(
            'NonMonotonicVersions',
            `Template '${definition.id}' lists version ${String(number)} after ${String(previous)}; versions are monotonic and must be declared ascending.`,
          );
        }
        numbers.add(number);
        previous = number;
      }

      const active = versions.filter((version) => version.prompt.status === ACTIVE);
      if (active.length > 1) {
        throw new TemplateLibraryError(
          'MultipleActiveVersions',
          `Template '${definition.id}' has ${String(active.length)} active versions; only one may be active, or "latest stable" is a coin toss that lands differently on each instance.`,
        );
      }

      const entry: LibraryTemplate = Object.freeze({
        id: definition.id,
        metadata: assertMetadata(definition.id, definition.metadata),
        versions: Object.freeze(versions),
      });
      ordered.push(entry);
      byId.set(entry.id, entry);
    },

    get(id: string): LibraryTemplate {
      const found = byId.get(id);
      if (found === undefined) {
        // Throws rather than returning null: `prompt-engine.md` is explicit
        // that "there is no fallback prompt, ever", and a null that a caller
        // forgot to check is how a fallback gets invented.
        throw new TemplateLibraryError('InvalidTemplate', `No template '${id}'.`);
      }
      return found;
    },

    find: (id: string): LibraryTemplate | null => byId.get(id) ?? null,
    has: (id: string): boolean => byId.has(id),
    list: (): readonly LibraryTemplate[] => Object.freeze([...ordered]),

    byCapability: (capability: AICapability): readonly LibraryTemplate[] =>
      Object.freeze(
        ordered.filter((template) =>
          template.versions.some((version) => version.compatibility.capability === capability),
        ),
      ),

    version: (id: string, version: number): PromptVersion | null =>
      byId.get(id)?.versions.find((entry) => entry.prompt.version === version) ?? null,

    latestStable: (id: string): PromptVersion | null =>
      byId.get(id)?.versions.find((entry) => entry.prompt.status === ACTIVE) ?? null,

    seal(): void {
      if (sealed) return;
      if (ordered.length === 0) {
        throw new TemplateLibraryError(
          'Empty',
          'An empty library can supply no prompts. Seal one with templates, or do not build one.',
        );
      }
      sealed = true;
    },

    get sealed(): boolean {
      return sealed;
    },
  };

  for (const definition of definitions) library.register(definition);
  return library;
}

/** `'planning.outline@7'` — the reproducibility anchor, from the frozen helper. */
export function promptVersionStringOf(version: PromptVersion): string {
  return promptVersionOf(version.prompt);
}

/** The newest version of a template, by monotonic number. */
export function newestVersion(template: LibraryTemplate): PromptVersion {
  return template.versions[template.versions.length - 1] as PromptVersion;
}

/** Versions sorted by semantic version, oldest first. Total order, so stable. */
export function bySemanticVersion(versions: readonly PromptVersion[]): readonly PromptVersion[] {
  return Object.freeze(
    [...versions].sort((left, right) => {
      const semantic = compareSemanticVersions(left.semanticVersion, right.semanticVersion);
      // Two versions may share a semver — a patch republished under a new
      // monotonic number. The monotonic number breaks the tie, because it is
      // the identity and it is unique by construction.
      return semantic !== 0 ? semantic : left.prompt.version - right.prompt.version;
    }),
  );
}

/** For an error message. Never parsed. */
export function describeVersion(version: PromptVersion): string {
  return `${promptVersionOf(version.prompt)} (${formatSemanticVersion(version.semanticVersion)}, ${version.prompt.status})`;
}
