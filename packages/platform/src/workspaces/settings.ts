/**
 * Workspace settings — the STORAGE layer only.
 *
 * `04-platform/workspaces.md` §Non-responsibilities is explicit: this service
 * owns the `workspaces.settings` column as storage and does NOT decide how a
 * workspace value combines with an organization default or a project override.
 * That is `settings.md` and Proposed ADR-024. Splitting them is what stops every
 * service reimplementing precedence.
 *
 * So the defaults below are deliberately NEUTRAL — a stable shape with empty
 * values, not opinions. `null` and `{}` mean "this layer expresses nothing",
 * which is exactly what a newly created workspace should say: rule 11 puts the
 * source of truth for thresholds and routing in settings, and ADR-008/ADR-009
 * forbid engines hardcoding them, so inventing values here would be authoring
 * policy this domain does not own.
 */

/**
 * The six keys named on the `workspaces.settings` column in migration 0004:
 * `{ brandVoice, gateThresholds, routing, locale, approval, retention }`.
 */
export const WORKSPACE_SETTINGS_KEYS = [
  'brandVoice',
  'gateThresholds',
  'routing',
  'locale',
  'approval',
  'retention',
] as const;

export type WorkspaceSettingsKey = (typeof WORKSPACE_SETTINGS_KEYS)[number];

export interface WorkspaceSettings {
  /** Reference to a brand voice profile. Null until one is configured. */
  readonly brandVoice: string | null;
  /** Quality gate thresholds. The MEANING of a threshold is owned by `articles.md`. */
  readonly gateThresholds: Readonly<Record<string, number>>;
  /** Tier preferences only — never a model identifier (rule 14, ADR-013). */
  readonly routing: Readonly<Record<string, string>>;
  /** BCP-47 locale. Null means "inherit", not "English". */
  readonly locale: string | null;
  readonly approval: Readonly<Record<string, string>>;
  /** Requests must sit WITHIN the plan allowance; beyond it is rejected, never clamped (rule 13). */
  readonly retention: Readonly<Record<string, number>>;
}

export const DEFAULT_WORKSPACE_SETTINGS: WorkspaceSettings = {
  brandVoice: null,
  gateThresholds: {},
  routing: {},
  locale: null,
  approval: {},
  retention: {},
};

/**
 * The keys that differ between two settings layers.
 *
 * `workspace_settings_history.changed_keys` is `NOT NULL` with
 * `cardinality(changed_keys) > 0`, and `WorkspaceSettingsUpdated` carries
 * **keys only, never values** — settings can include competitively sensitive
 * configuration, and an event reaches more consumers than the row does.
 */
export function changedSettingsKeys(
  before: Partial<WorkspaceSettings>,
  after: Partial<WorkspaceSettings>,
): readonly WorkspaceSettingsKey[] {
  return WORKSPACE_SETTINGS_KEYS.filter(
    (key) => JSON.stringify(before[key] ?? null) !== JSON.stringify(after[key] ?? null),
  );
}
