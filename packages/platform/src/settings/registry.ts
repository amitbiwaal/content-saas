/**
 * The settings key registry — `04-platform/settings.md` §"Implementation notes".
 *
 * "The registry is the contract. Adding a setting means adding a registry entry
 *  with type, scope, default, range, and overridability — then using it.
 *  Reversing that order produces settings nobody can discover."
 *
 * SOURCE-CONTROLLED, not a table. The same decision the event registry took in
 * T3.1: a registry that can be edited at runtime is a set of validation rules
 * that can be edited out from under a running process, and a setting whose
 * declared type changes mid-flight is worse than no declaration at all.
 *
 * ── Resolution is total ─────────────────────────────────────────────────────
 * Every entry carries a built-in default, so every declared key resolves to a
 * value at every scope (rule 5). There is no "unset" answer for a caller to
 * handle, and therefore no code path where a consumer invents its own fallback
 * — which is how three services end up with three different thresholds.
 *
 * ── Scope is the lowest layer that may SET a key ────────────────────────────
 * Retention, data residency and SSO enforcement are organization-only (rule 2):
 * a workspace admin must not be able to extend their own retention past what
 * the organization bought. That is a security control, so it is declared here
 * rather than checked at each call site.
 */

/** The five value types a setting may declare. */
export const SETTING_TYPES = ['string', 'integer', 'boolean', 'decimal', 'json'] as const;

export type SettingType = (typeof SETTING_TYPES)[number];

/**
 * The layers, most specific first. Also the resolution order.
 *
 * `platform` is a per-deployment override of the built-in, supplied at
 * composition. It is NOT customer-authored and NOT stored in the database:
 * it exists so an operator can change a platform-wide default without editing
 * the key declaration, and it sits below the customer's layers because a
 * customer's explicit choice must always win over an operator's default.
 */
export const SETTING_LAYERS = ['workspace', 'organization', 'platform', 'built-in'] as const;

export type SettingLayer = (typeof SETTING_LAYERS)[number];

/** The lowest layer permitted to set a key. */
export type SettingScope = 'workspace' | 'organization';

/**
 * A `decimal` is carried as a STRING for the same reason a credit amount is:
 * a threshold read back as `0.8500000000000001` is a different threshold, and
 * a gate verdict has to be explainable in terms of the value in force.
 */
export type SettingValue = string | number | boolean | Readonly<Record<string, unknown>>;

export interface SettingDeclaration {
  readonly key: string;
  readonly type: SettingType;
  /** The lowest layer that may set it. `organization` means workspace may not. */
  readonly scope: SettingScope;
  /** The floor. Always present — resolution is total. */
  readonly defaultValue: SettingValue;
  /** Why the setting exists, for the registry catalogue. */
  readonly description: string;
}

export type SettingsResolutionErrorCode =
  | 'UnknownKey'
  | 'DuplicateKey'
  | 'InvalidType'
  | 'InvalidDeclaration'
  | 'ScopeViolation';

export class SettingsError extends Error {
  readonly code: SettingsResolutionErrorCode;

  constructor(code: SettingsResolutionErrorCode, message: string) {
    super(message);
    this.name = 'SettingsError';
    this.code = code;
  }
}

/**
 * The built-in platform settings.
 *
 * Every one is named by a specification — none is invented here. A setting
 * without a documented meaning is a setting no consumer can correctly use.
 */
export const BUILT_IN_SETTINGS: readonly SettingDeclaration[] = [
  {
    key: 'content.reading_grade_min',
    type: 'integer',
    scope: 'workspace',
    defaultValue: 8,
    description: 'Lowest acceptable reading grade. settings.md §Purpose ("reading grade 8-10").',
  },
  {
    key: 'content.reading_grade_max',
    type: 'integer',
    scope: 'workspace',
    defaultValue: 10,
    description: 'Highest acceptable reading grade.',
  },
  {
    key: 'content.locale',
    type: 'string',
    scope: 'workspace',
    // A concrete default rather than null: "absence is not zero" (rule 4), and
    // resolution must be total, so the floor cannot itself mean "inherit".
    defaultValue: 'en-US',
    description: 'BCP-47 locale for generated content. workspaces.md rule 11.',
  },
  {
    key: 'review.approval_required',
    type: 'boolean',
    scope: 'workspace',
    defaultValue: false,
    description: 'Whether an article requires human approval before publication.',
  },
  {
    key: 'review.gate_threshold',
    type: 'decimal',
    scope: 'workspace',
    defaultValue: '0.850000',
    description: 'Minimum quality gate score. The MEANING of the score is the Review engine’s.',
  },
  {
    key: 'routing.tier_preferences',
    type: 'json',
    scope: 'workspace',
    defaultValue: {},
    description: 'Model TIER preferences only, never a model identifier (rule 14, ADR-013).',
  },
  {
    key: 'workflow.approval_timeout_hours',
    type: 'integer',
    scope: 'workspace',
    defaultValue: 48,
    description: 'Hours before an unanswered approval escalates. workflow.md.',
  },
  // ── Organization-only. Rule 2, and a security control. ────────────────────
  {
    key: 'retention.days',
    type: 'integer',
    scope: 'organization',
    defaultValue: 365,
    description:
      'Retention ceiling. Organization-only so a workspace admin cannot extend their own.',
  },
  {
    key: 'security.sso_required',
    type: 'boolean',
    scope: 'organization',
    defaultValue: false,
    description: 'Whether SSO is enforced. Organization-only: it is a compliance decision.',
  },
  {
    key: 'security.data_residency',
    type: 'string',
    scope: 'organization',
    defaultValue: 'eu',
    description: 'Where customer data may reside. Organization-only.',
  },
];

export interface SettingsRegistry {
  /** Every declaration, in declaration order. */
  readonly declarations: readonly SettingDeclaration[];
  readonly keys: readonly string[];
  has(key: string): boolean;
  /** Throws `UnknownKey` rather than returning undefined — see `require`. */
  require(key: string): SettingDeclaration;
  find(key: string): SettingDeclaration | undefined;
  /** True when `layer` is permitted to set `key`. */
  permits(key: string, layer: SettingLayer): boolean;
  /** Narrow an unknown value to the declared type, or reject it. */
  coerce(key: string, value: unknown): SettingValue;
  /** Does `value` satisfy the declared type? */
  accepts(key: string, value: unknown): boolean;
}

/** `integer` is exact; a float dressed as one is a different value. */
function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

/**
 * A decimal string, as the ledger writes one.
 *
 * Numbers are refused outright rather than converted: accepting `0.85` and
 * storing `'0.85'` looks harmless until the value has been through a JSON
 * round-trip that a `decimal` exists to avoid.
 */
const DECIMAL_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d{1,6})?$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function matchesType(type: SettingType, value: unknown): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'integer':
      return isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'decimal':
      return typeof value === 'string' && DECIMAL_PATTERN.test(value);
    case 'json':
      return isPlainObject(value);
  }
}

/**
 * Build a registry, refusing a declaration set that cannot be trusted.
 *
 * Checked at construction rather than at first use: a duplicate key or a
 * default that violates its own declared type is a deployment error, and the
 * process should refuse to start rather than resolve one of the two entries and
 * leave which one to chance.
 */
export function createSettingsRegistry(
  declarations: readonly SettingDeclaration[] = BUILT_IN_SETTINGS,
): SettingsRegistry {
  const byKey = new Map<string, SettingDeclaration>();

  for (const declaration of declarations) {
    if (byKey.has(declaration.key)) {
      throw new SettingsError(
        'DuplicateKey',
        `Setting '${declaration.key}' is declared twice; which type and scope apply would be decided by declaration order.`,
      );
    }
    if (!(SETTING_TYPES as readonly string[]).includes(declaration.type)) {
      throw new SettingsError(
        'InvalidDeclaration',
        `Setting '${declaration.key}' declares unknown type '${declaration.type}'.`,
      );
    }
    if (!matchesType(declaration.type, declaration.defaultValue)) {
      throw new SettingsError(
        'InvalidDeclaration',
        `Setting '${declaration.key}' has a default that is not a valid ${declaration.type}. The default is the floor of every resolution, so an invalid one is returned to every caller.`,
      );
    }
    if (declaration.description.trim() === '') {
      throw new SettingsError(
        'InvalidDeclaration',
        `Setting '${declaration.key}' has no description; a setting nobody can discover is a setting nobody uses correctly.`,
      );
    }
    byKey.set(declaration.key, declaration);
  }

  const require_ = (key: string): SettingDeclaration => {
    const declaration = byKey.get(key);
    if (declaration === undefined) {
      throw new SettingsError(
        'UnknownKey',
        `'${key}' is not a declared setting. Add a registry entry with its type, scope and default before reading it.`,
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
      // `platform` and `built-in` may always express a value; the scope rule
      // constrains the CUSTOMER-authored layers, which is what rule 2 is about.
      if (layer === 'platform' || layer === 'built-in') return true;
      if (declaration.scope === 'organization') return layer === 'organization';
      return true;
    },
    accepts: (key, value) => matchesType(require_(key).type, value),
    coerce(key, value) {
      const declaration = require_(key);
      if (!matchesType(declaration.type, value)) {
        throw new SettingsError(
          'InvalidType',
          `Setting '${key}' is declared ${declaration.type}; got ${describe(value)}.`,
        );
      }
      return value as SettingValue;
    },
  };
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return typeof value;
}
