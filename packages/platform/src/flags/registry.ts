/**
 * The feature flag registry — `04-platform/feature-flags.md`, Proposed ADR-023.
 *
 * SOURCE-CONTROLLED, like the settings and event registries. A flag whose
 * declaration can change at runtime is a declaration that cannot be validated,
 * and "flag lifecycle hygiene" is a stated responsibility: a flag nobody can
 * find in the code is a flag nobody retires.
 *
 * ── Flags are not settings ──────────────────────────────────────────────────
 * "Settings answer 'how should this behave?' and are changed by customers;
 *  flags answer 'is this capability on?' and are changed by us. A flag that a
 *  customer configures is a setting misfiled."
 *
 * The two are kept apart HERE — different registry, different vocabulary, own
 * owner and kind — while sharing the resolution machinery below them, because
 * the hierarchy and the cache are the same problem and solving it twice is how
 * two answers to "is it on?" come to disagree.
 *
 * ── A flag is never a security control ──────────────────────────────────────
 * "Hiding an endpoint behind a flag does not authorize it. Permission checks
 *  run regardless of flag state — a disabled flag that is the only thing
 *  preventing access is a vulnerability."
 *
 * Nothing in this module consults a permission, and nothing that consults a
 * permission may substitute a flag for it.
 */

import type { SettingDeclaration } from '../settings/registry.js';

/**
 * The three kinds, named apart so the flag set stays manageable.
 *
 * `feature-flags.md` §Purpose: a release flag is deleted after full rollout, an
 * operational flag is a permanent kill switch, and an entitlement flag is
 * derived from billing and never set by hand.
 */
export const FLAG_KINDS = ['release', 'operational', 'entitlement'] as const;

export type FlagKind = (typeof FLAG_KINDS)[number];

/**
 * The lowest layer permitted to override a flag.
 *
 * `platform` means no customer override at all — the right scope for a kill
 * switch, which is ours to throw and must not be reachable by the customer it
 * is protecting. `organization` suits an entitlement: plan-gated per account,
 * never per workspace. `release` flags are usually `workspace`, because
 * enabling one workspace first is what a release flag is for.
 */
export const FLAG_SCOPES = ['workspace', 'organization', 'platform'] as const;

export type FlagScope = (typeof FLAG_SCOPES)[number];

/** The layers an evaluation can come from, most specific first. */
export const FLAG_LAYERS = ['workspace', 'organization', 'platform', 'built-in'] as const;

export type FlagLayer = (typeof FLAG_LAYERS)[number];

export interface FeatureFlagDeclaration {
  readonly key: string;
  readonly description: string;
  /** The floor. Always present — evaluation is total. */
  readonly defaultValue: boolean;
  /** The lowest layer that may override it. */
  readonly scope: FlagScope;
  /** Who to ask. `feature-flags.md` names an owner per kind. */
  readonly owner: string;
  readonly kind: FlagKind;
}

export type FeatureFlagErrorCode =
  | 'UnknownFlag'
  | 'DuplicateFlag'
  | 'InvalidDeclaration'
  | 'RegistryMismatch';

export class FeatureFlagError extends Error {
  readonly code: FeatureFlagErrorCode;

  constructor(code: FeatureFlagErrorCode, message: string) {
    super(message);
    this.name = 'FeatureFlagError';
    this.code = code;
  }
}

/**
 * The namespace flag overrides occupy in a settings layer.
 *
 * Flags share `workspaces.settings` and `organizations.settings` with settings
 * rather than getting tables of their own — see the note in `resolver.ts`. The
 * prefix is what keeps the two key spaces from ever colliding, and it makes a
 * stored override self-describing to anyone reading the column.
 */
export const FLAG_KEY_PREFIX = 'flags.';

export const settingKeyFor = (flagKey: string): string => `${FLAG_KEY_PREFIX}${flagKey}`;

/**
 * The built-in flags.
 *
 * Every one names a capability that exists in the codebase or a documented
 * deferral. A flag for something nothing checks is a flag that will never be
 * retired, which is the hygiene problem `feature-flags.md` warns about.
 */
export const BUILT_IN_FLAGS: readonly FeatureFlagDeclaration[] = [
  // ── Operational. Ours to throw, never a customer's. ───────────────────────
  {
    key: 'credits.enforce_authorization',
    description:
      'Require a valid hold before any provider call. Off means metering is incomplete; the kill switch of last resort during a Credits incident.',
    defaultValue: true,
    scope: 'platform',
    owner: 'platform.credits',
    kind: 'operational',
  },
  {
    key: 'events.replay_enabled',
    description:
      'Permit operator-initiated replay (ADR-028). Off during an incident to stop a replay competing with live delivery.',
    defaultValue: true,
    scope: 'platform',
    owner: 'platform.events',
    kind: 'operational',
  },
  {
    key: 'events.dead_letter_auto_retry',
    description:
      'Automatically re-deliver quarantined events (ADR-027). Off by default: a DLQ entry usually wants a human first.',
    defaultValue: false,
    scope: 'platform',
    owner: 'platform.events',
    kind: 'operational',
  },
  // ── Release. Enabled for one workspace, then expanded. ────────────────────
  {
    key: 'knowledge.vector_search',
    description:
      'Vector retrieval over evidence. Off until OQ-11 fixes the embedding dimension and migration 0019 lands.',
    defaultValue: false,
    scope: 'workspace',
    owner: 'knowledge',
    kind: 'release',
  },
  {
    key: 'publishing.wordpress_connector',
    description:
      'Publish to WordPress. Rolled out per workspace because a connector fault is tenant-visible.',
    defaultValue: false,
    scope: 'workspace',
    owner: 'integrations',
    kind: 'release',
  },
  // ── Entitlement. Projected from billing, never authored here. ─────────────
  {
    key: 'entitlements.sso',
    description:
      'SSO available on this plan. Projected from billing.md; organization-scoped because a plan is bought per account.',
    defaultValue: false,
    scope: 'organization',
    owner: 'platform.billing',
    kind: 'entitlement',
  },
  {
    key: 'entitlements.audit_export',
    description: 'Audit log export available on this plan. Projected from billing.md.',
    defaultValue: false,
    scope: 'organization',
    owner: 'platform.billing',
    kind: 'entitlement',
  },
];

export interface FeatureFlagRegistry {
  readonly declarations: readonly FeatureFlagDeclaration[];
  readonly keys: readonly string[];
  has(key: string): boolean;
  /** Throws `UnknownFlag` rather than returning undefined. */
  require(key: string): FeatureFlagDeclaration;
  find(key: string): FeatureFlagDeclaration | undefined;
  /** True when `layer` may override `key`. */
  permits(key: string, layer: FlagLayer): boolean;
  /** The projections a settings registry must declare for these flags. */
  settingDeclarations(): readonly SettingDeclaration[];
}

/**
 * Build a registry, refusing a declaration set that cannot be trusted.
 *
 * "Duplicate keys fail startup" — checked here rather than at first
 * evaluation, because which default and scope apply would otherwise be decided
 * by declaration order, and a kill switch resolving to the wrong default is not
 * something to discover during an incident.
 */
export function createFeatureFlagRegistry(
  declarations: readonly FeatureFlagDeclaration[] = BUILT_IN_FLAGS,
): FeatureFlagRegistry {
  const byKey = new Map<string, FeatureFlagDeclaration>();

  for (const declaration of declarations) {
    if (byKey.has(declaration.key)) {
      throw new FeatureFlagError(
        'DuplicateFlag',
        `Flag '${declaration.key}' is declared twice; which default and scope apply would be decided by declaration order.`,
      );
    }
    if (declaration.key.trim() === '') {
      throw new FeatureFlagError('InvalidDeclaration', 'A flag must have a key.');
    }
    // The prefix is added on projection; a key carrying it already would
    // resolve as `flags.flags.x` and silently never match a stored override.
    if (declaration.key.startsWith(FLAG_KEY_PREFIX)) {
      throw new FeatureFlagError(
        'InvalidDeclaration',
        `Flag '${declaration.key}' must not include the '${FLAG_KEY_PREFIX}' prefix; it is added when the key is projected into a settings layer.`,
      );
    }
    if (typeof declaration.defaultValue !== 'boolean') {
      throw new FeatureFlagError(
        'InvalidDeclaration',
        `Flag '${declaration.key}' has a non-boolean default. A flag answers "is this capability on?" and has no third answer.`,
      );
    }
    if (!(FLAG_SCOPES as readonly string[]).includes(declaration.scope)) {
      throw new FeatureFlagError(
        'InvalidDeclaration',
        `Flag '${declaration.key}' declares unknown scope '${declaration.scope}'.`,
      );
    }
    if (!(FLAG_KINDS as readonly string[]).includes(declaration.kind)) {
      throw new FeatureFlagError(
        'InvalidDeclaration',
        `Flag '${declaration.key}' declares unknown kind '${declaration.kind}'.`,
      );
    }
    if (declaration.description.trim() === '') {
      throw new FeatureFlagError(
        'InvalidDeclaration',
        `Flag '${declaration.key}' has no description; a flag nobody can explain is a flag nobody retires.`,
      );
    }
    if (declaration.owner.trim() === '') {
      throw new FeatureFlagError(
        'InvalidDeclaration',
        `Flag '${declaration.key}' has no owner; "who turned this off?" needs an answer before the incident, not during it.`,
      );
    }
    byKey.set(declaration.key, declaration);
  }

  const require_ = (key: string): FeatureFlagDeclaration => {
    const declaration = byKey.get(key);
    if (declaration === undefined) {
      throw new FeatureFlagError(
        'UnknownFlag',
        `'${key}' is not a declared feature flag. Add a registry entry with its default, scope and owner before evaluating it.`,
      );
    }
    return declaration;
  };

  return {
    declarations: [...declarations],
    keys: [...byKey.keys()],
    has: (key) => byKey.has(key),
    require: require_,
    find: (key) => byKey.get(key),
    permits(key, layer) {
      const declaration = require_(key);
      // `platform` and `built-in` are ours, and every flag may express a value
      // there. The scope constrains the CUSTOMER-visible layers.
      if (layer === 'platform' || layer === 'built-in') return true;
      if (declaration.scope === 'platform') return false;
      if (declaration.scope === 'organization') return layer === 'organization';
      return true;
    },
    /**
     * Projected as `boolean` settings, carrying as much of the scope as
     * `SettingScope` can express.
     *
     * ── Why scope is expressed in BOTH places ─────────────────────────────
     * The settings resolver returns only the layer that WON. If the projection
     * were permissive, an organization-scoped flag with both a (forbidden)
     * workspace override and a (legitimate) organization one would come back as
     * the workspace value — and rejecting it afterwards would skip straight past
     * the organization value to the built-in, silently discarding the override
     * that should have applied.
     *
     * So the projection carries the workspace-versus-organization half, which
     * `SettingScope` has words for, and the flag resolver carries the
     * `platform`-only half, which it does not. A platform-scoped flag maps to
     * `organization` here and is refused that layer there; nothing legitimate is
     * skipped, because a platform-scoped flag has no lawful customer layer at
     * all.
     */
    settingDeclarations(): readonly SettingDeclaration[] {
      return [...byKey.values()].map((flag) => ({
        key: settingKeyFor(flag.key),
        type: 'boolean' as const,
        scope: flag.scope === 'workspace' ? ('workspace' as const) : ('organization' as const),
        defaultValue: flag.defaultValue,
        description: `[flag:${flag.kind}, owner:${flag.owner}] ${flag.description}`,
      }));
    },
  };
}
