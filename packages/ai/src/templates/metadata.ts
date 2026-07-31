/**
 * Template metadata, compatibility, and semantic versions.
 *
 * ── Where this sits ─────────────────────────────────────────────────────────
 * `08-ai-platform/prompt-engine.md` describes two tables, and the split is the
 * whole shape of this library:
 *
 *   prompt_templates          identity — id, owner, current active version
 *   prompt_template_versions  the immutable artifact — parts, variables, hints
 *
 * S2.3 built the SECOND one and called it `PromptTemplate`. That type is frozen
 * and is what `compilePrompt`, the workflow runtime and `promptVersion`
 * provenance all consume. This library adds the FIRST — the identity level the
 * increment calls a template, with the metadata, compatibility and version
 * catalogue that a library needs and a single render unit does not.
 *
 * The naming consequence is stated in `library.ts`.
 *
 * ── Two version numbers, answering two questions ────────────────────────────
 * `prompt-engine.md`: "version: number; monotonic; immutable once active", and
 * `promptVersion` — `'planning.outline@7'` — is the reproducibility anchor that
 * reaches `AIResponse`, the workflow's step results and, through ADR-021, every
 * producer's `algorithmVersion`. That integer is IDENTITY and it cannot change
 * shape without breaking the provenance of every historical call.
 *
 * The increment also asks for a semantic version. It is added ALONGSIDE, not
 * instead: semver answers "is this compatible with what I built against?",
 * which an opaque monotonic counter cannot. So the integer resolves and
 * records; the semver is what `latest-compatible` reasons over.
 */

import type { AICapability } from '@contentos/contracts';

export const TEMPLATE_VISIBILITIES = ['public', 'internal'] as const;

export type TemplateVisibility = (typeof TEMPLATE_VISIBILITIES)[number];

export function isTemplateVisibility(value: unknown): value is TemplateVisibility {
  return typeof value === 'string' && (TEMPLATE_VISIBILITIES as readonly string[]).includes(value);
}

export interface TemplateMetadata {
  /** For a human reading a catalogue. Never used to make a decision. */
  readonly title: string;
  readonly description: string;
  /** Who is accountable for this prompt. Mirrors the version's own `owner`. */
  readonly owner: string;
  /**
   * `internal` templates are platform machinery — refusing to resolve one for a
   * customer-facing caller is what stops an internal prompt becoming a
   * published contract by accident.
   */
  readonly visibility: TemplateVisibility;
  /** Free-form, for discovery. Lower-cased and de-duplicated on registration. */
  readonly tags: readonly string[];
}

/**
 * What a version can serve, and where.
 *
 * `null` means UNRESTRICTED, which is different from an empty list: an empty
 * list would mean "no provider may run this", and a template nothing can run is
 * one that fails at resolution rather than at registration. The distinction is
 * enforced, not documented.
 */
export interface TemplateCapability {
  readonly capability: AICapability;
  /** Provider ids this version is known good on. Null = any registered one. */
  readonly providers: readonly string[] | null;
  /** Models this version is known good on. Null = any the provider offers. */
  readonly models: readonly string[] | null;
}

// ── Semantic versions ────────────────────────────────────────────────────────

export interface SemanticVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

const SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

/**
 * Parse `major.minor.patch`. Null for anything else.
 *
 * Deliberately strict: no ranges, no pre-release, no build metadata, no `v`
 * prefix. A library that accepted `^2.1` would be making a resolution decision
 * from a string, and "reject ambiguous versions" is the increment's own rule.
 */
export function parseSemanticVersion(value: string): SemanticVersion | null {
  const match = SEMVER.exec(value);
  if (match === null) return null;
  return Object.freeze({
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  });
}

export function formatSemanticVersion(version: SemanticVersion): string {
  return `${String(version.major)}.${String(version.minor)}.${String(version.patch)}`;
}

/** Ordering: negative when `left` is older. Total, so a sort is stable. */
export function compareSemanticVersions(left: SemanticVersion, right: SemanticVersion): number {
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  return left.patch - right.patch;
}

/**
 * Compatibility, in the one sense this library uses it.
 *
 * Same major. A major bump is what a template author declares when a change
 * breaks callers — a removed variable, a changed output shape, a different
 * meaning — so staying inside a major is exactly "will what I built against
 * still work". Anything looser would upgrade a caller across a break, and "no
 * automatic upgrades" is the increment's rule.
 */
export function isSemanticallyCompatible(
  requested: SemanticVersion,
  candidate: SemanticVersion,
): boolean {
  return requested.major === candidate.major && compareSemanticVersions(candidate, requested) >= 0;
}
