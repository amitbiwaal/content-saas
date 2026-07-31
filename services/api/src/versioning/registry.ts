/**
 * The version registry.
 *
 * Spec: `06-api/api-versioning.md`, which owns the process, and
 * `06-api/api-principles.md`, which owns the conventions. Between them the
 * rules this file enforces are:
 *
 *   - the version is in the PATH — `/v1/…` (api-reference rule 3)
 *   - unknown versions are REJECTED, never defaulted
 *   - a retired version returns 410, never a fallback to the current one
 *   - the migration window is at least SIX MONTHS
 *   - deprecation is announced in-band on every response
 *
 * ── Why unknown versions are rejected rather than defaulted ─────────────────
 * `16-security/api-security.md`: "Defaulting to the newest lets an attacker
 * probe for a version with weaker checks." A router that quietly served
 * `/v99/ai/execute` as v1 would also be applying v1's authorization semantics
 * to a client that asked for something else.
 *
 * ── Why sunset is 410 and not a redirect ────────────────────────────────────
 * "Silently routing a v1 call to v2 applies v2 semantics — INCLUDING
 * AUTHORIZATION SEMANTICS — to a client expecting v1." A 410 is the only
 * answer that cannot be mistaken for success.
 *
 * ── No runtime mutation ─────────────────────────────────────────────────────
 * The registry is built once and frozen. A version set that could change under
 * a running process would make two identical requests get different answers
 * about what the API even is, and the deprecation headers a client caches
 * would describe a schedule that had moved.
 */

/**
 * The lifecycle, in order.
 *
 * `supported` sits between `current` and `deprecated` deliberately: a version
 * can be fully live without being the one new integrations should target, and
 * collapsing the two would mean announcing a deprecation the moment a
 * successor ships — six months before anything is actually going away.
 */
export const API_VERSION_STATUSES = ['current', 'supported', 'deprecated', 'sunset'] as const;

export type ApiVersionStatus = (typeof API_VERSION_STATUSES)[number];

export function isApiVersionStatus(value: unknown): value is ApiVersionStatus {
  return typeof value === 'string' && (API_VERSION_STATUSES as readonly string[]).includes(value);
}

/** Statuses that still serve traffic. `sunset` is the only one that does not. */
export const SERVING_STATUSES: readonly ApiVersionStatus[] = Object.freeze([
  'current',
  'supported',
  'deprecated',
]);

export interface ApiVersion {
  /** The path segment, exactly: 'v1'. */
  readonly version: string;
  readonly status: ApiVersionStatus;
  /** ISO 8601. When this version first shipped. */
  readonly releasedAt: string;
  /** ISO 8601. Set once deprecation is announced. */
  readonly deprecatedAt?: string;
  /** ISO 8601. When it stops serving — at least six months after the above. */
  readonly sunsetAt?: string;
  /** Where a client goes to migrate. Carried in the `Link` header. */
  readonly migrationGuide?: string;
}

/** `api-versioning.md`: "The migration window is at least 6 months." */
export const MINIMUM_DEPRECATION_MONTHS = 6;

export interface VersionPolicy {
  readonly minimumDeprecationMonths: number;
}

export const DEFAULT_VERSION_POLICY: VersionPolicy = Object.freeze({
  minimumDeprecationMonths: MINIMUM_DEPRECATION_MONTHS,
});

export const VERSION_REGISTRY_ERROR_CODES = [
  'Empty',
  'DuplicateVersion',
  'InvalidVersion',
  'NoCurrentVersion',
  'MultipleCurrentVersions',
  'MissingDeprecationSchedule',
  'WindowTooShort',
] as const;

export type VersionRegistryErrorCode = (typeof VERSION_REGISTRY_ERROR_CODES)[number];

export class VersionRegistryError extends Error {
  readonly code: VersionRegistryErrorCode;
  constructor(code: VersionRegistryErrorCode, message: string) {
    super(message);
    this.name = 'VersionRegistryError';
    this.code = code;
  }
}

export interface VersionRegistry {
  /** The one version new integrations should target. */
  readonly current: ApiVersion;
  /** Every declared version, in registration order. */
  readonly versions: readonly ApiVersion[];
  readonly policy: VersionPolicy;
  find(version: string): ApiVersion | null;
  /** Those a client may still call. */
  serving(): readonly ApiVersion[];
}

const VERSION_SEGMENT = /^v[1-9][0-9]*$/;

/** Months between two instants, floored — the unit the window is stated in. */
function monthsBetween(from: Date, to: Date): number {
  const years = to.getUTCFullYear() - from.getUTCFullYear();
  const months = years * 12 + (to.getUTCMonth() - from.getUTCMonth());
  return to.getUTCDate() < from.getUTCDate() ? months - 1 : months;
}

function parseInstant(field: string, version: string, value: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new VersionRegistryError(
      'InvalidVersion',
      `Version '${version}' has an unparseable ${field}: '${value}'.`,
    );
  }
  return parsed;
}

function assertVersionValid(entry: ApiVersion, policy: VersionPolicy): void {
  if (!VERSION_SEGMENT.test(entry.version)) {
    throw new VersionRegistryError(
      'InvalidVersion',
      `'${entry.version}' is not a version segment; the path form is 'v1', 'v2', and so on.`,
    );
  }
  if (!isApiVersionStatus(entry.status)) {
    throw new VersionRegistryError(
      'InvalidVersion',
      `Version '${entry.version}' has status '${String(entry.status)}', which is not one of ${API_VERSION_STATUSES.join(', ')}.`,
    );
  }
  parseInstant('releasedAt', entry.version, entry.releasedAt);

  if (entry.status === 'current' || entry.status === 'supported') return;

  // A deprecated or sunset version must carry the whole schedule. Announcing a
  // deprecation without a sunset date gives a client nothing to plan against,
  // and the header would advertise a window with no end.
  if (
    entry.deprecatedAt === undefined ||
    entry.sunsetAt === undefined ||
    entry.migrationGuide === undefined
  ) {
    throw new VersionRegistryError(
      'MissingDeprecationSchedule',
      `Version '${entry.version}' is '${entry.status}' but does not carry deprecatedAt, sunsetAt and a migrationGuide; a deprecation announced without a date and a destination is one nobody can act on.`,
    );
  }

  const deprecated = parseInstant('deprecatedAt', entry.version, entry.deprecatedAt);
  const sunset = parseInstant('sunsetAt', entry.version, entry.sunsetAt);
  const window = monthsBetween(deprecated, sunset);
  if (window < policy.minimumDeprecationMonths) {
    throw new VersionRegistryError(
      'WindowTooShort',
      `Version '${entry.version}' allows ${String(window)} months to migrate; the minimum is ${String(policy.minimumDeprecationMonths)}.`,
    );
  }
}

export interface VersionRegistryOptions {
  readonly versions: readonly ApiVersion[];
  readonly policy?: VersionPolicy;
}

/**
 * Build the registry. Validated once, frozen, and never edited afterwards.
 */
export function createVersionRegistry(options: VersionRegistryOptions): VersionRegistry {
  const policy = Object.freeze({ ...(options.policy ?? DEFAULT_VERSION_POLICY) });

  if (options.versions.length === 0) {
    throw new VersionRegistryError(
      'Empty',
      'An API with no declared versions can serve nothing; every path carries one.',
    );
  }

  const seen = new Set<string>();
  const versions: ApiVersion[] = [];
  for (const entry of options.versions) {
    assertVersionValid(entry, policy);
    if (seen.has(entry.version)) {
      throw new VersionRegistryError(
        'DuplicateVersion',
        `Version '${entry.version}' is declared twice; which entry applied would depend on registration order.`,
      );
    }
    seen.add(entry.version);
    versions.push(Object.freeze({ ...entry }));
  }

  const current = versions.filter((entry) => entry.status === 'current');
  if (current.length === 0) {
    throw new VersionRegistryError(
      'NoCurrentVersion',
      'Exactly one version must be current; it is what new integrations are told to target.',
    );
  }
  if (current.length > 1) {
    throw new VersionRegistryError(
      'MultipleCurrentVersions',
      `Versions ${current.map((entry) => entry.version).join(', ')} are all current; there can only be one.`,
    );
  }

  const frozen = Object.freeze(versions);
  const byVersion = new Map(frozen.map((entry) => [entry.version, entry]));

  return Object.freeze({
    current: current[0] as ApiVersion,
    versions: frozen,
    policy,
    find: (version: string): ApiVersion | null => byVersion.get(version) ?? null,
    serving: (): readonly ApiVersion[] =>
      Object.freeze(frozen.filter((entry) => SERVING_STATUSES.includes(entry.status))),
  });
}
