/**
 * Template resolution.
 *
 *   template id → version selection → PromptVersion → compatibility → resolved
 *
 * ── Compatibility is asked, never re-derived ────────────────────────────────
 * Whether a provider exists and what it can do is the REGISTRY's answer
 * (`providers.has`, `provider.capabilities`) — the same source routing and
 * admission use. A second table of "who can do chat?" here would be a third
 * opinion in the platform, and three opinions disagree sooner than two.
 *
 * What this file owns is the TEMPLATE's side: the version's declared
 * `compatibility`, which says where this prompt is known good. That is a
 * property of the prompt and exists nowhere else.
 *
 * ── There is no fallback, ever ──────────────────────────────────────────────
 * `prompt-engine.md`: "A missing or broken template fails the request.
 * Substituting a generic prompt would produce output that looks valid and is
 * untraceable to any version." Every path below either resolves the version
 * that was asked for, or refuses with a reason. Nothing degrades.
 *
 * ── No automatic upgrades ───────────────────────────────────────────────────
 * `latest-compatible` stays inside the requested MAJOR. Crossing one would move
 * a caller across a declared break — which is precisely what a major bump is
 * for — and it would do it silently, on a deploy nobody associated with the
 * change.
 */

import type { AICapability } from '@contentos/contracts';

import type { ProviderRegistry } from '../providers/registry.js';
import { supportsCapability } from '../providers/provider.js';
import {
  bySemanticVersion,
  describeVersion,
  type LibraryTemplate,
  type PromptVersion,
  type TemplateLibrary,
} from './library.js';
import { parseSemanticVersion, type TemplateVisibility } from './metadata.js';

/**
 * How to choose a version.
 *
 * A discriminated union rather than an options bag: "explicit or latest" as two
 * optional fields makes "both supplied" representable, and "reject ambiguous
 * versions" then becomes a runtime check instead of an impossibility.
 */
export type VersionSelector =
  | { readonly kind: 'explicit'; readonly version: number }
  | { readonly kind: 'latest-stable' }
  | {
      readonly kind: 'latest-compatible';
      /** `'2.1.0'` — the version the caller built against. Never widened past its major. */
      readonly compatibleWith: string;
    };

export const RESOLUTION_REJECTION_CODES = [
  'UnknownTemplate',
  'UnknownVersion',
  'AmbiguousVersion',
  'TemplateDeprecated',
  'NoStableVersion',
  'NoCompatibleVersion',
  'TemplateNotVisible',
  'CapabilityIncompatible',
  'ProviderIncompatible',
  'ModelIncompatible',
  'UnknownProvider',
] as const;

export type ResolutionRejectionCode = (typeof RESOLUTION_REJECTION_CODES)[number];

export function isResolutionRejectionCode(value: unknown): value is ResolutionRejectionCode {
  return (
    typeof value === 'string' && (RESOLUTION_REJECTION_CODES as readonly string[]).includes(value)
  );
}

export interface ResolvedTemplate {
  readonly template: LibraryTemplate;
  readonly version: PromptVersion;
  /** `'planning.outline@7'` — the frozen reproducibility anchor. */
  readonly promptVersion: string;
  /** Which selector produced it, for a trace. */
  readonly selector: VersionSelector['kind'];
}

export type TemplateResolution =
  | { readonly outcome: 'resolved'; readonly resolved: ResolvedTemplate }
  | {
      readonly outcome: 'refused';
      readonly code: ResolutionRejectionCode;
      /** For operators. Never returned to a caller. */
      readonly reason: string;
    };

export interface ResolveOptions {
  readonly library: TemplateLibrary;
  readonly id: string;
  readonly selector: VersionSelector;
  /**
   * The registry, for provider and model compatibility.
   *
   * Optional because a caller resolving a template for inspection has no
   * provider in mind; supplying `providerId` without it is refused rather than
   * silently unchecked.
   */
  readonly providers?: ProviderRegistry;
  /** The capability the work needs. Checked against the version's declaration. */
  readonly capability?: AICapability;
  readonly providerId?: string;
  readonly model?: string;
  /**
   * What the CALLER may see. An `internal` template resolved for a `public`
   * caller would become a published contract by accident.
   */
  readonly visibility?: TemplateVisibility;
}

const refuse = (code: ResolutionRejectionCode, reason: string): TemplateResolution =>
  Object.freeze({ outcome: 'refused' as const, code, reason });

/** Version selection. Everything here is a pure function of the library. */
function selectVersion(
  template: LibraryTemplate,
  selector: VersionSelector,
): { version: PromptVersion } | TemplateResolution {
  if (selector.kind === 'explicit') {
    const found = template.versions.find((entry) => entry.prompt.version === selector.version);
    if (found === undefined) {
      return refuse(
        'UnknownVersion',
        `Template '${template.id}' has no version ${String(selector.version)}.`,
      );
    }
    // A pin is honoured even when the version is deprecated — `prompt-engine.md`
    // resolves "active OR explicitly pinned". Refusing a pin would break the
    // reproduction of a historical call, which is what pinning is for.
    return { version: found };
  }

  if (selector.kind === 'latest-stable') {
    const active = template.versions.filter((entry) => entry.prompt.status === 'active');
    if (active.length === 0) {
      return refuse(
        'NoStableVersion',
        `Template '${template.id}' has no active version; a draft is not something to run and a deprecated one must be pinned deliberately.`,
      );
    }
    // The library refuses more than one active version at registration, so
    // this cannot be ambiguous by the time it is read.
    return { version: active[0] as PromptVersion };
  }

  const requested = parseSemanticVersion(selector.compatibleWith);
  if (requested === null) {
    return refuse(
      'AmbiguousVersion',
      `'${selector.compatibleWith}' is not a semantic version; ranges and prefixes are refused because they make resolution a guess.`,
    );
  }

  // Inside the requested major, at or above it, and never a draft: a draft is
  // unreleased and picking one would upgrade a caller onto unreviewed output.
  const candidates = bySemanticVersion(
    template.versions.filter(
      (entry) =>
        entry.prompt.status !== 'draft' &&
        entry.semanticVersion.major === requested.major &&
        (entry.semanticVersion.minor > requested.minor ||
          (entry.semanticVersion.minor === requested.minor &&
            entry.semanticVersion.patch >= requested.patch)),
    ),
  );

  if (candidates.length === 0) {
    return refuse(
      'NoCompatibleVersion',
      `Template '${template.id}' has no version at or above ${selector.compatibleWith} within major ${String(requested.major)}. Crossing a major would move the caller across a declared break.`,
    );
  }
  return { version: candidates[candidates.length - 1] as PromptVersion };
}

/**
 * Resolve a template to one version, checked against where it may run.
 *
 * Order: identity, visibility, version, then compatibility. Compatibility runs
 * last because it is the only step that consults the registry, and a request
 * refused for a reason nothing can change — an unknown id, an unknown version —
 * should be refused without asking anything else.
 */
export function resolveTemplate(options: ResolveOptions): TemplateResolution {
  const { library, id, selector } = options;

  const template = library.find(id);
  if (template === null) {
    // No fallback prompt, ever.
    return refuse('UnknownTemplate', `No template '${id}'.`);
  }

  if (options.visibility === 'public' && template.metadata.visibility === 'internal') {
    return refuse(
      'TemplateNotVisible',
      `Template '${id}' is internal; resolving it for a public caller would make platform machinery a published contract.`,
    );
  }

  const selected = selectVersion(template, selector);
  if ('outcome' in selected) return selected;
  const { version } = selected;

  if (version.prompt.status === 'deprecated' && selector.kind !== 'explicit') {
    return refuse(
      'TemplateDeprecated',
      `${describeVersion(version)} is deprecated; pin it explicitly to reproduce a historical call.`,
    );
  }

  // ── Compatibility ────────────────────────────────────────────────────────
  const { compatibility } = version;

  if (options.capability !== undefined && compatibility.capability !== options.capability) {
    return refuse(
      'CapabilityIncompatible',
      `${describeVersion(version)} declares '${compatibility.capability}', not '${options.capability}'.`,
    );
  }

  if (options.providerId !== undefined) {
    if (options.providers === undefined) {
      // Refused rather than skipped: a compatibility check that silently did
      // not run reads exactly like one that passed.
      return refuse(
        'UnknownProvider',
        `Provider '${options.providerId}' cannot be checked without a registry.`,
      );
    }
    if (!options.providers.has(options.providerId)) {
      return refuse('UnknownProvider', `Provider '${options.providerId}' is not registered.`);
    }
    if (compatibility.providers !== null && !compatibility.providers.includes(options.providerId)) {
      return refuse(
        'ProviderIncompatible',
        `${describeVersion(version)} is not declared compatible with '${options.providerId}'.`,
      );
    }

    // The REGISTRY's answer about the provider, not a second table here.
    const provider = options.providers.get(options.providerId);
    if (!supportsCapability(provider, compatibility.capability)) {
      return refuse(
        'CapabilityIncompatible',
        `Provider '${options.providerId}' does not declare '${compatibility.capability}'.`,
      );
    }
  }

  if (
    options.model !== undefined &&
    compatibility.models !== null &&
    !compatibility.models.includes(options.model)
  ) {
    return refuse(
      'ModelIncompatible',
      `${describeVersion(version)} is not declared compatible with model '${options.model}'.`,
    );
  }

  return Object.freeze({
    outcome: 'resolved' as const,
    resolved: Object.freeze({
      template,
      version,
      promptVersion: `${template.id}@${String(version.prompt.version)}`,
      selector: selector.kind,
    }),
  });
}
