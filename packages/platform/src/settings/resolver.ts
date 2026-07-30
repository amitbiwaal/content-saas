/**
 * The Settings Resolver — `04-platform/settings.md`, Proposed ADR-024.
 *
 * "No service may implement precedence itself. A consumer reading
 *  `workspaces.settings` directly is a boundary violation."
 *
 * One question, answered the same way everywhere: what is the effective value
 * of setting X for this scope, right now — and which layer supplied it.
 *
 * ── The four layers, most specific first ────────────────────────────────────
 *   workspace     `workspaces.settings`      customer-authored, per workspace
 *   organization  `organizations.settings`   customer-authored, per account
 *   platform      supplied at composition    operator default, not stored
 *   built-in      the key declaration        the floor; always present
 *
 * A customer's explicit choice outranks an operator's default, and the built-in
 * is last because resolution must be total (rule 5).
 *
 * ── Provenance is not optional ──────────────────────────────────────────────
 * Every answer names the layer it came from. "Why is this article requiring
 * approval?" is unanswerable without it, and support becomes archaeology.
 *
 * ── Staleness is impossible, not merely unlikely ────────────────────────────
 * The cache stores the LAYERS and the version they were read at. Every resolve
 * first probes the current version — one indexed read of two integers — and
 * uses the cache only when it matches. An invalidation that never arrives
 * cannot serve a stale threshold, because nothing is trusted without checking
 * the version it was built from.
 *
 * That is deliberately not the cheapest possible cache. Settings "never fail
 * open to defaults, because defaults are usually more permissive than a
 * customer's configured policy", and the same reasoning applies to serving a
 * value that was correct a minute ago.
 */

import type { DomainEvent, EventPublisher, Transaction } from '@contentos/contracts';
import { secureId } from '@contentos/security';

import { settingsChanged, type SettingsResolutionEventContext } from './resolution-events.js';
import {
  SettingsError,
  type SettingLayer,
  type SettingsRegistry,
  type SettingValue,
} from './registry.js';

export interface SettingsResolutionExecutor extends Transaction {
  query<T>(sql: string, params?: readonly unknown[]): Promise<readonly T[]>;
}

/** What is being resolved for. An organization scope has no workspace layer. */
export type ResolutionScope =
  | { readonly type: 'workspace'; readonly workspaceId: string; readonly organizationId: string }
  | { readonly type: 'organization'; readonly organizationId: string };

export interface ResolvedSetting {
  readonly key: string;
  readonly value: SettingValue;
  /** Which layer supplied it. */
  readonly source: SettingLayer;
  /** The composite layer version this was resolved at. */
  readonly version: string;
}

/**
 * A reason a stored value was passed over.
 *
 * Reported rather than thrown: resolution is on every run start, and refusing
 * to answer because one layer holds a stale key would take the platform down
 * for a value nobody is reading (settings.md §"Failure handling").
 */
export interface SettingsAnomaly {
  readonly key: string;
  readonly layer: SettingLayer;
  readonly reason: 'unknown-key' | 'type-mismatch' | 'scope-violation';
  readonly detail: string;
}

export interface SettingsSnapshot {
  readonly scope: ResolutionScope;
  readonly version: string;
  /** Frozen. Two services holding this snapshot see the same values, always. */
  readonly values: Readonly<Record<string, SettingValue>>;
  readonly sources: Readonly<Record<string, SettingLayer>>;
  readonly anomalies: readonly SettingsAnomaly[];
  get(key: string): SettingValue;
  sourceOf(key: string): SettingLayer;
}

const PROBE_WORKSPACE_SQL = `
  SELECT w.version AS "workspaceVersion", o.version AS "organizationVersion"
    FROM workspaces w
    JOIN organizations o ON o.id = w.organization_id
   WHERE w.id = $1 AND w.deleted_at IS NULL`;

const LOAD_WORKSPACE_SQL = `
  SELECT w.settings AS "workspaceSettings", w.version AS "workspaceVersion",
         o.settings AS "organizationSettings", o.version AS "organizationVersion"
    FROM workspaces w
    JOIN organizations o ON o.id = w.organization_id
   WHERE w.id = $1 AND w.deleted_at IS NULL`;

const PROBE_ORGANIZATION_SQL = `
  SELECT version AS "organizationVersion"
    FROM organizations WHERE id = $1 AND deleted_at IS NULL`;

const LOAD_ORGANIZATION_SQL = `
  SELECT settings AS "organizationSettings", version AS "organizationVersion"
    FROM organizations WHERE id = $1 AND deleted_at IS NULL`;

interface VersionRow {
  readonly workspaceVersion?: number | string | null;
  readonly organizationVersion: number | string;
}

interface LayerRow extends VersionRow {
  readonly workspaceSettings?: Readonly<Record<string, unknown>> | null;
  readonly organizationSettings: Readonly<Record<string, unknown>> | null;
}

interface CachedLayers {
  readonly version: string;
  readonly workspace: Readonly<Record<string, unknown>>;
  readonly organization: Readonly<Record<string, unknown>>;
}

const scopeKey = (scope: ResolutionScope): string =>
  scope.type === 'workspace'
    ? `workspace:${scope.workspaceId}`
    : `organization:${scope.organizationId}`;

/**
 * The composite version.
 *
 * Both layers, because a change to either changes the answer. A single number
 * could not distinguish "the organization moved" from "nothing moved", and the
 * organization layer is the one an admin edits for five hundred workspaces at
 * once.
 */
function versionOf(row: VersionRow): string {
  const org = `o${String(row.organizationVersion)}`;
  return row.workspaceVersion === undefined || row.workspaceVersion === null
    ? org
    : `w${String(row.workspaceVersion)}.${org}`;
}

const asObject = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** Deep-freeze, so a consumer cannot mutate a json setting other holders share. */
function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null) return value;
  for (const inner of Object.values(value as Record<string, unknown>)) deepFreeze(inner);
  return Object.freeze(value);
}

export interface SettingsResolverOptions {
  readonly registry: SettingsRegistry;
  readonly publisher: EventPublisher;
  /**
   * The per-deployment layer, below the customer's and above the built-in.
   * Supplied at composition; never read from the database, and never editable
   * at runtime — an operator default that can change under a running process
   * is indistinguishable from a bug.
   */
  readonly platformDefaults?: Readonly<Record<string, SettingValue>>;
  readonly now?: () => Date;
  readonly newEventId?: () => string;
}

export interface InvalidateCommand {
  readonly scope: ResolutionScope;
  /** Names only — settings values never travel on an event. */
  readonly changedKeys: readonly string[];
  readonly correlationId: string;
  readonly causationId?: string | null;
}

export interface SettingsResolver {
  resolve(
    tx: SettingsResolutionExecutor,
    scope: ResolutionScope,
    key: string,
  ): Promise<ResolvedSetting>;
  resolveMany(
    tx: SettingsResolutionExecutor,
    scope: ResolutionScope,
    keys: readonly string[],
  ): Promise<readonly ResolvedSetting[]>;
  /** Every declared key, frozen, at one version. */
  resolveSnapshot(
    tx: SettingsResolutionExecutor,
    scope: ResolutionScope,
  ): Promise<SettingsSnapshot>;
  /**
   * Drop the cached layers for a scope and announce it.
   *
   * The seam an editing workflow calls. It exists here rather than in a writer
   * because the cache is here: an invalidation that does not reach the cache is
   * the failure mode, so the two are one operation.
   */
  invalidate(
    tx: SettingsResolutionExecutor,
    command: InvalidateCommand,
  ): Promise<DomainEvent<unknown>>;
  /** Cache statistics, for the hit-ratio metric settings.md alerts on. */
  readonly stats: { hits: number; misses: number };
}

export function createSettingsResolver(options: SettingsResolverOptions): SettingsResolver {
  const { registry, publisher } = options;
  const now = options.now ?? ((): Date => new Date());
  const newEventId = options.newEventId ?? secureId;

  // Platform defaults are validated ONCE, here, so a malformed operator default
  // fails the deploy rather than the first request that reads it.
  const platform: Record<string, SettingValue> = {};
  for (const [key, value] of Object.entries(options.platformDefaults ?? {})) {
    platform[key] = registry.coerce(key, value);
  }
  deepFreeze(platform);

  const cache = new Map<string, CachedLayers>();
  const stats = { hits: 0, misses: 0 };

  async function currentVersion(
    tx: SettingsResolutionExecutor,
    scope: ResolutionScope,
  ): Promise<string> {
    const rows =
      scope.type === 'workspace'
        ? await tx.query<VersionRow>(PROBE_WORKSPACE_SQL, [scope.workspaceId])
        : await tx.query<VersionRow>(PROBE_ORGANIZATION_SQL, [scope.organizationId]);
    const row = rows[0];
    if (row === undefined) {
      throw new SettingsError(
        'UnknownKey',
        `No settings layers exist for ${scopeKey(scope)}; the scope does not exist or is deleted.`,
      );
    }
    return versionOf(row);
  }

  async function layersFor(
    tx: SettingsResolutionExecutor,
    scope: ResolutionScope,
  ): Promise<CachedLayers> {
    const key = scopeKey(scope);
    const live = await currentVersion(tx, scope);
    const cached = cache.get(key);

    if (cached !== undefined && cached.version === live) {
      stats.hits += 1;
      return cached;
    }

    stats.misses += 1;
    const rows =
      scope.type === 'workspace'
        ? await tx.query<LayerRow>(LOAD_WORKSPACE_SQL, [scope.workspaceId])
        : await tx.query<LayerRow>(LOAD_ORGANIZATION_SQL, [scope.organizationId]);
    const row = rows[0];
    if (row === undefined) {
      throw new SettingsError(
        'UnknownKey',
        `Settings layers for ${scopeKey(scope)} vanished between the version probe and the read.`,
      );
    }

    const loaded: CachedLayers = {
      // The version the LAYERS were read at, not the probe's: if a write landed
      // in between, this records what was actually loaded, and the next probe
      // sees the mismatch and reloads.
      version: versionOf(row),
      workspace: deepFreeze(asObject(row.workspaceSettings)),
      organization: deepFreeze(asObject(row.organizationSettings)),
    };
    cache.set(key, loaded);
    return loaded;
  }

  /**
   * Walk the layers, most specific first, taking the first value that is both
   * permitted at that layer and of the declared type.
   *
   * A value that fails either test is SKIPPED, not fatal: resolution falls
   * through to the next layer, which is the safe direction. Skipping a
   * workspace value for an organization-only key lands on the organization's,
   * which is precisely the constraint rule 2 exists to enforce.
   */
  function resolveKey(
    key: string,
    layers: CachedLayers,
    scope: ResolutionScope,
    anomalies: SettingsAnomaly[],
  ): { value: SettingValue; source: SettingLayer } {
    const declaration = registry.require(key);

    const candidates: [SettingLayer, Readonly<Record<string, unknown>>][] =
      scope.type === 'workspace'
        ? [
            ['workspace', layers.workspace],
            ['organization', layers.organization],
            ['platform', platform],
          ]
        : [
            ['organization', layers.organization],
            ['platform', platform],
          ];

    for (const [layer, source] of candidates) {
      if (!Object.hasOwn(source, key)) continue;
      const value = source[key];

      if (!registry.permits(key, layer)) {
        anomalies.push({
          key,
          layer,
          reason: 'scope-violation',
          detail: `'${key}' is ${declaration.scope}-only; the ${layer} layer may not set it, so its value was ignored.`,
        });
        continue;
      }
      if (!registry.accepts(key, value)) {
        // "Registry and stored layer disagree on type: registry wins; the
        // stored value is ignored and reported."
        anomalies.push({
          key,
          layer,
          reason: 'type-mismatch',
          detail: `'${key}' is declared ${declaration.type}; the ${layer} layer holds something else, so its value was ignored.`,
        });
        continue;
      }
      return { value: value as SettingValue, source: layer };
    }

    return { value: declaration.defaultValue, source: 'built-in' };
  }

  /** Stored keys nobody declared. Ignored, reported — usually a removed key. */
  function reportUnknown(layers: CachedLayers, anomalies: SettingsAnomaly[]): void {
    const seen = new Set<string>();
    for (const [layer, source] of [
      ['workspace', layers.workspace],
      ['organization', layers.organization],
    ] as [SettingLayer, Readonly<Record<string, unknown>>][]) {
      for (const key of Object.keys(source)) {
        if (registry.has(key) || seen.has(`${layer}:${key}`)) continue;
        seen.add(`${layer}:${key}`);
        anomalies.push({
          key,
          layer,
          reason: 'unknown-key',
          detail: `'${key}' is stored in the ${layer} layer but is not declared; usually a key removed in an earlier release.`,
        });
      }
    }
  }

  async function resolveAll(
    tx: SettingsResolutionExecutor,
    scope: ResolutionScope,
    keys: readonly string[],
  ): Promise<{ resolved: ResolvedSetting[]; anomalies: SettingsAnomaly[]; version: string }> {
    // Validate BEFORE touching the database: an unknown key is a programming
    // error and should not cost a query to discover.
    for (const key of keys) registry.require(key);

    const layers = await layersFor(tx, scope);
    const anomalies: SettingsAnomaly[] = [];
    const resolved = keys.map((key) => {
      const { value, source } = resolveKey(key, layers, scope, anomalies);
      return { key, value, source, version: layers.version };
    });
    return { resolved, anomalies, version: layers.version };
  }

  return {
    async resolve(tx, scope, key) {
      const { resolved } = await resolveAll(tx, scope, [key]);
      const only = resolved[0];
      if (only === undefined) {
        throw new SettingsError('UnknownKey', `Resolution produced no answer for '${key}'.`);
      }
      return only;
    },

    async resolveMany(tx, scope, keys) {
      const { resolved } = await resolveAll(tx, scope, keys);
      return resolved;
    },

    async resolveSnapshot(tx, scope) {
      const { resolved, anomalies, version } = await resolveAll(tx, scope, registry.keys);
      const layers = await layersFor(tx, scope);
      reportUnknown(layers, anomalies);

      const values: Record<string, SettingValue> = {};
      const sources: Record<string, SettingLayer> = {};
      for (const entry of resolved) {
        values[entry.key] = entry.value;
        sources[entry.key] = entry.source;
      }
      deepFreeze(values);
      deepFreeze(sources);

      // Frozen whole: a snapshot two services share must be the same object all
      // the way down, or "identical settings" is a promise about the first
      // level only. A mid-run change cannot alter behaviour because there is
      // nothing here that can be altered.
      return deepFreeze({
        scope,
        version,
        values,
        sources,
        anomalies: Object.freeze([...anomalies]),
        get(key: string): SettingValue {
          const value = values[key];
          if (value === undefined) {
            throw new SettingsError(
              'UnknownKey',
              `'${key}' is not in this snapshot; it was taken over the declared key set.`,
            );
          }
          return value;
        },
        sourceOf(key: string): SettingLayer {
          const source = sources[key];
          if (source === undefined) {
            throw new SettingsError('UnknownKey', `'${key}' is not in this snapshot.`);
          }
          return source;
        },
      });
    },

    async invalidate(tx, command) {
      for (const key of command.changedKeys) registry.require(key);
      cache.delete(scopeKey(command.scope));

      const version = await currentVersion(tx, command.scope);
      const ctx: SettingsResolutionEventContext = {
        eventId: newEventId(),
        correlationId: command.correlationId,
        causationId: command.causationId ?? null,
        occurredAt: now().toISOString(),
      };
      const event = settingsChanged(ctx, {
        scopeType: command.scope.type,
        scopeId:
          command.scope.type === 'workspace'
            ? command.scope.workspaceId
            : command.scope.organizationId,
        organizationId: command.scope.organizationId,
        changedKeys: [...command.changedKeys],
        version,
      });
      await publisher.publish(tx, event);
      return event;
    },

    stats,
  };
}
