/**
 * The Feature Flag Resolver — `04-platform/feature-flags.md`.
 *
 * Evaluation only. No admin surface, no rollout, no experimentation.
 *
 * ── It has no cache of its own, deliberately ────────────────────────────────
 * Flag overrides live in the SAME `workspaces.settings` / `organizations.settings`
 * layers the Settings Resolver already reads, under the `flags.` namespace, and
 * this module delegates the layer walk to it. That buys three things outright:
 * the version-aware cache, the staleness guarantee, and the provenance — none
 * of them reimplemented, so none of them able to disagree with the settings
 * answer for the same scope at the same version.
 *
 * A second cache over the same two columns would need its own invalidation, its
 * own version probe, and its own staleness bug.
 *
 * ── DEVIATION, RECORDED: no `flags` / `flag_rules` tables ───────────────────
 * `feature-flags.md` §"Database impact" specifies `flags`, `flag_rules` and
 * `flag_exposures` as global reference data. Those tables exist to hold what an
 * admin UI writes — rules, priorities, percentage rollouts, exposure samples —
 * and every one of those is out of scope here. Creating them now would add the
 * platform's first ADR-025 reference-data tables with nothing able to write
 * them, and a registry in the database is a set of declarations editable out
 * from under a running process.
 *
 * So: built-in defaults and the platform layer are source-controlled; the two
 * customer layers are the settings layers. That is exactly the hierarchy this
 * increment specifies, and it introduces no storage the increment cannot fill.
 *
 * ── Scope is enforced in two places, and has to be ──────────────────────────
 * The settings resolver returns only the layer that WON, so a rejection here
 * cannot fall back to a layer it already passed over. The projection therefore
 * carries the workspace-versus-organization half — which `SettingScope` can
 * express — and this module carries the `platform`-only half, which it cannot.
 *
 * Nothing legitimate is skipped by the split: a platform-scoped flag has no
 * lawful customer layer, so rejecting the organization layer here can only ever
 * discard a value that should not have been there.
 *
 * ── A flag is never a security control ──────────────────────────────────────
 * Nothing here consults a permission, and no caller may substitute an
 * evaluation for one.
 */

import type { DomainEvent, EventPublisher } from '@contentos/contracts';
import { secureId } from '@contentos/security';

import type {
  ResolutionScope,
  SettingsResolutionExecutor,
  SettingsResolver,
} from '../settings/resolver.js';
import { featureFlagChanged, type FeatureFlagEventContext } from './events.js';
import {
  FeatureFlagError,
  FLAG_KEY_PREFIX,
  settingKeyFor,
  type FeatureFlagRegistry,
  type FlagLayer,
} from './registry.js';

export interface FlagEvaluation {
  readonly key: string;
  readonly enabled: boolean;
  /** Which layer decided it. */
  readonly source: FlagLayer;
  /** The composite settings-layer version it was evaluated at. */
  readonly version: string;
}

/**
 * A stored override that was passed over, and why.
 *
 * Reported rather than thrown: evaluation is on a request path, and refusing to
 * answer because one layer holds a stale override would take a capability down
 * for a value nobody is reading.
 */
export interface FlagAnomaly {
  readonly key: string;
  readonly layer: FlagLayer;
  readonly reason: 'scope-violation' | 'type-mismatch' | 'unknown-flag';
  readonly detail: string;
}

export interface FlagSnapshot {
  readonly scope: ResolutionScope;
  readonly version: string;
  /** Frozen. Two holders evaluate identically, always. */
  readonly flags: Readonly<Record<string, boolean>>;
  readonly sources: Readonly<Record<string, FlagLayer>>;
  readonly anomalies: readonly FlagAnomaly[];
  isEnabled(key: string): boolean;
  sourceOf(key: string): FlagLayer;
}

export interface FeatureFlagResolverOptions {
  readonly flags: FeatureFlagRegistry;
  /**
   * The resolver that owns the layers and the cache. Its registry MUST declare
   * this flag registry's projections — asserted at construction.
   */
  readonly settings: SettingsResolver;
  /**
   * The settings registry `settings` was built over. Taken so the wiring can be
   * checked at startup rather than failing on the first evaluation of whichever
   * flag was forgotten.
   */
  readonly settingsRegistry: { has(key: string): boolean };
  readonly publisher: EventPublisher;
  /**
   * The per-deployment layer, below the customer's and above the built-in.
   * Owned here rather than passed to the settings resolver because a
   * platform-scoped flag must be settable at this layer and nowhere above it,
   * and the settings scope vocabulary cannot express that.
   */
  readonly platformDefaults?: Readonly<Record<string, boolean>>;
  readonly now?: () => Date;
  readonly newEventId?: () => string;
}

export interface FlagChangeCommand {
  readonly scope: ResolutionScope;
  /** Names only — a flag set is a roadmap and a probe map. */
  readonly changedFlags: readonly string[];
  readonly correlationId: string;
  readonly causationId?: string | null;
}

export interface FeatureFlagResolver {
  isEnabled(tx: SettingsResolutionExecutor, scope: ResolutionScope, key: string): Promise<boolean>;
  evaluate(
    tx: SettingsResolutionExecutor,
    scope: ResolutionScope,
    key: string,
  ): Promise<FlagEvaluation>;
  evaluateMany(
    tx: SettingsResolutionExecutor,
    scope: ResolutionScope,
    keys: readonly string[],
  ): Promise<readonly FlagEvaluation[]>;
  /** Every declared flag, frozen, at one version. */
  evaluateSnapshot(tx: SettingsResolutionExecutor, scope: ResolutionScope): Promise<FlagSnapshot>;
  /** Drop the cached layers for a scope and announce it. */
  announceChange(
    tx: SettingsResolutionExecutor,
    command: FlagChangeCommand,
  ): Promise<DomainEvent<unknown>>;
}

/** Deep-freeze, so one holder cannot alter what another is evaluating. */
function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null) return value;
  for (const inner of Object.values(value as Record<string, unknown>)) deepFreeze(inner);
  return Object.freeze(value);
}

export function createFeatureFlagResolver(
  options: FeatureFlagResolverOptions,
): FeatureFlagResolver {
  const { flags, settings, publisher } = options;
  const now = options.now ?? ((): Date => new Date());
  const newEventId = options.newEventId ?? secureId;

  // The wiring check. A settings registry built without these projections would
  // resolve nothing and every flag would silently sit at its built-in default —
  // including a kill switch someone believes they have thrown.
  for (const key of flags.keys) {
    if (!options.settingsRegistry.has(settingKeyFor(key))) {
      throw new FeatureFlagError(
        'RegistryMismatch',
        `Flag '${key}' is declared but '${settingKeyFor(key)}' is not in the settings registry the resolver was built over. Compose it with the flag registry's settingDeclarations(), or every override for this flag is invisible.`,
      );
    }
  }

  // Validated once, here, so a malformed operator default fails the deploy
  // rather than the first request that reads it.
  const platform: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(options.platformDefaults ?? {})) {
    flags.require(key);
    if (typeof value !== 'boolean') {
      throw new FeatureFlagError(
        'InvalidDeclaration',
        `Platform default for flag '${key}' is not a boolean.`,
      );
    }
    platform[key] = value;
  }
  deepFreeze(platform);

  /**
   * Turn a settings resolution into a flag evaluation.
   *
   * The settings answer supplies the two customer layers. Everything below them
   * is decided here: a layer the flag's scope forbids is passed over, and the
   * platform default takes precedence over the built-in.
   */
  function decide(
    key: string,
    resolved: { value: unknown; source: string },
    anomalies: FlagAnomaly[],
  ): { enabled: boolean; source: FlagLayer } {
    const declaration = flags.require(key);
    const customer = resolved.source === 'workspace' || resolved.source === 'organization';

    if (customer) {
      const layer = resolved.source as FlagLayer;
      if (flags.permits(key, layer)) {
        return { enabled: resolved.value === true, source: layer };
      }
      // Only reachable for a platform-scoped flag: the projection already
      // refused the workspace layer for the other two scopes. Falling through
      // is the safe direction — a kill switch a customer cannot reach is the
      // point of a platform-scoped flag.
      anomalies.push({
        key,
        layer,
        reason: 'scope-violation',
        detail: `'${key}' is ${declaration.scope}-scoped; the ${layer} layer may not override it, so its value was ignored.`,
      });
    }

    if (Object.hasOwn(platform, key)) {
      return { enabled: platform[key] === true, source: 'platform' };
    }
    return { enabled: declaration.defaultValue, source: 'built-in' };
  }

  async function evaluateAll(
    tx: SettingsResolutionExecutor,
    scope: ResolutionScope,
    keys: readonly string[],
  ): Promise<{
    evaluations: FlagEvaluation[];
    anomalies: FlagAnomaly[];
    version: string;
  }> {
    // Validate BEFORE touching the database: an unknown flag is a programming
    // error and should not cost a query to discover.
    for (const key of keys) flags.require(key);

    const resolved = await settings.resolveMany(
      tx,
      scope,
      keys.map((key) => settingKeyFor(key)),
    );

    const anomalies: FlagAnomaly[] = [];
    const evaluations = keys.map((key, index) => {
      const entry = resolved[index];
      if (entry === undefined) {
        throw new FeatureFlagError(
          'UnknownFlag',
          `Resolution produced no answer for flag '${key}'.`,
        );
      }
      const { enabled, source } = decide(key, entry, anomalies);
      return { key, enabled, source, version: entry.version };
    });

    // Every key in a batch shares one settings resolution, so one version.
    const version = evaluations[0]?.version ?? (await versionFor(tx, scope));
    return { evaluations, anomalies, version };
  }

  /** Only reached for an empty key set, where there is no entry to read it from. */
  async function versionFor(
    tx: SettingsResolutionExecutor,
    scope: ResolutionScope,
  ): Promise<string> {
    const probe = await settings.resolveMany(tx, scope, []);
    return probe[0]?.version ?? (await settings.resolveSnapshot(tx, scope)).version;
  }

  return {
    async evaluate(tx, scope, key) {
      const { evaluations } = await evaluateAll(tx, scope, [key]);
      const only = evaluations[0];
      if (only === undefined) {
        throw new FeatureFlagError('UnknownFlag', `Evaluation produced no answer for '${key}'.`);
      }
      return only;
    },

    async isEnabled(tx, scope, key) {
      const { evaluations } = await evaluateAll(tx, scope, [key]);
      return evaluations[0]?.enabled ?? false;
    },

    async evaluateMany(tx, scope, keys) {
      const { evaluations } = await evaluateAll(tx, scope, keys);
      return evaluations;
    },

    async evaluateSnapshot(tx, scope) {
      // The SNAPSHOT path goes through `resolveSnapshot`, not `resolveMany`,
      // because only that one reports anomalies — and half of them are the
      // settings resolver's to report now that the projection carries part of
      // the scope rule. Reading just this module's half would show a clean
      // snapshot for a workspace override that was silently discarded.
      const resolved = await settings.resolveSnapshot(tx, scope);
      const anomalies: FlagAnomaly[] = [];

      for (const anomaly of resolved.anomalies) {
        if (!anomaly.key.startsWith(FLAG_KEY_PREFIX)) continue;
        const key = anomaly.key.slice(FLAG_KEY_PREFIX.length);
        const declaration = flags.find(key);
        anomalies.push({
          key,
          layer: anomaly.layer,
          reason: anomaly.reason === 'unknown-key' ? 'unknown-flag' : anomaly.reason,
          // Re-worded, not forwarded. The settings resolver knows the PROJECTED
          // scope, so a platform-scoped flag reads there as "organization-only"
          // — accurate about the projection and wrong about the flag. Someone
          // asking why their override was ignored would be told the wrong rule.
          detail:
            declaration !== undefined && anomaly.reason === 'scope-violation'
              ? `'${key}' is ${declaration.scope}-scoped; the ${anomaly.layer} layer may not override it, so its value was ignored.`
              : anomaly.detail,
        });
      }

      const values: Record<string, boolean> = {};
      const sources: Record<string, FlagLayer> = {};
      for (const key of flags.keys) {
        const settingKey = settingKeyFor(key);
        const { enabled, source } = decide(
          key,
          {
            value: resolved.values[settingKey],
            source: resolved.sources[settingKey] ?? 'built-in',
          },
          anomalies,
        );
        values[key] = enabled;
        sources[key] = source;
      }
      const version = resolved.version;

      // Frozen whole: a snapshot two services share must be the same object all
      // the way down, or "evaluate identically" is a promise about the first
      // level only.
      return deepFreeze({
        scope,
        version,
        flags: values,
        sources,
        anomalies: [...anomalies],
        isEnabled(key: string): boolean {
          const value = values[key];
          if (value === undefined) {
            throw new FeatureFlagError(
              'UnknownFlag',
              `'${key}' is not in this snapshot; it was taken over the declared flag set.`,
            );
          }
          return value;
        },
        sourceOf(key: string): FlagLayer {
          const source = sources[key];
          if (source === undefined) {
            throw new FeatureFlagError('UnknownFlag', `'${key}' is not in this snapshot.`);
          }
          return source;
        },
      });
    },

    async announceChange(tx, command) {
      for (const key of command.changedFlags) flags.require(key);

      // Invalidate through the resolver that owns the cache. Publishing our own
      // event while leaving its cache populated would announce a change nothing
      // acted on.
      const invalidation = await settings.invalidate(tx, {
        scope: command.scope,
        changedKeys: command.changedFlags.map((key) => settingKeyFor(key)),
        correlationId: command.correlationId,
        ...(command.causationId === undefined ? {} : { causationId: command.causationId }),
      });

      const ctx: FeatureFlagEventContext = {
        eventId: newEventId(),
        correlationId: command.correlationId,
        // Caused by the settings invalidation this change went through, so the
        // two are linked rather than appearing as unrelated events.
        causationId: invalidation.eventId,
        occurredAt: now().toISOString(),
      };
      const event = featureFlagChanged(ctx, {
        scopeType: command.scope.type,
        scopeId:
          command.scope.type === 'workspace'
            ? command.scope.workspaceId
            : command.scope.organizationId,
        organizationId: command.scope.organizationId,
        changedFlags: [...command.changedFlags],
        version: (invalidation.payload as { version: string }).version,
      });
      await publisher.publish(tx, event);
      return event;
    },
  };
}
