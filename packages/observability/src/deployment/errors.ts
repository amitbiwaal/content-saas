/**
 * The deployment error taxonomy — one per module, as everywhere else here.
 *
 * `SecurityError`, `BackupError`, `AuditValidationError`, `HoldError` and
 * `LedgerError` each belong to one module and carry a typed code. This follows
 * that convention.
 *
 * ── The message names the problem, never the machine ───────────────────────
 * Nothing constructed here carries a hostname, a cluster, a registry URL, a
 * digest secret or a path. A deployment report is read during an incident by
 * people who are not all on the platform team, and an operational tool that
 * leaked infrastructure detail in its own errors would be a disclosure.
 */

export type DeploymentErrorCode =
  /** An identifier that is not the shape its kind requires. */
  | 'InvalidDeploymentId'
  /** An environment outside the four `deployment.md` §3.1 defines. */
  | 'InvalidEnvironment'
  /** A version that is not semantic, or an artifact pinned to a tag. */
  | 'InvalidReleaseVersion'
  /** A strategy this build does not know. */
  | 'UnsupportedStrategy'
  /** A rollback that cannot be performed from the state it claims. */
  | 'IncompatibleRollback'
  /** A runbook with no steps, or steps nobody can follow. */
  | 'MalformedRunbook'
  /** A release claiming to have been cut after now. */
  | 'FutureReleaseTimestamp'
  /** The same deployment id, twice. */
  | 'DuplicateDeployment'
  /** A readiness report whose own fields disagree. */
  | 'InconsistentReadiness'
  /** A window that does not describe an interval, or is in the past. */
  | 'InvalidMaintenanceWindow'
  /** A deploy order that would ship the API before the workers. */
  | 'InvalidDeployOrder'
  /** A required field that was absent or empty. */
  | 'MissingField';

export class DeploymentError extends Error {
  readonly code: DeploymentErrorCode;
  readonly field: string;

  constructor(code: DeploymentErrorCode, field: string, message: string) {
    super(message);
    this.name = 'DeploymentError';
    this.code = code;
    this.field = field;
  }
}

/**
 * Deep freezing, once for the module.
 *
 * Every exported value goes through it. A release record that came back mutable
 * could have its digest edited after verification passed — and the digest is
 * the only thing that says which code is actually running.
 */
export function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.getOwnPropertyNames(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

export function assertInstant(value: unknown, field: string, code: DeploymentErrorCode): string {
  if (typeof value !== 'string' || !ISO_INSTANT.test(value)) {
    throw new DeploymentError(
      code,
      field,
      `'${field}' must be a UTC ISO-8601 instant. A local-time string names a different moment depending on where it is read, and a deploy marker an hour out is one nobody can line up against an incident.`,
    );
  }
  if (Number.isNaN(Date.parse(value))) {
    throw new DeploymentError(code, field, `'${field}' is not a real instant.`);
  }
  return value;
}

export function assertPresent(value: unknown, field: string, why: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new DeploymentError('MissingField', field, `'${field}' is required: ${why}`);
  }
  return value;
}

/**
 * An identifier this module accepts.
 *
 * Lowercase, dot/hyphen/underscore separated, bounded. These appear in deploy
 * markers, dashboards and metric labels; free text would put a hostname or a
 * cluster name into all three.
 */
const IDENTIFIER_SHAPE = /^[a-z0-9][a-z0-9]*(?:[._-][a-z0-9]+)*$/;

export const MAX_IDENTIFIER_LENGTH = 128;

export function assertIdentifier(value: unknown, field: string): string {
  assertPresent(value, field, 'an unidentified record cannot be correlated with a deploy marker.');

  const id = value as string;
  if (id.length > MAX_IDENTIFIER_LENGTH || !IDENTIFIER_SHAPE.test(id)) {
    throw new DeploymentError(
      'InvalidDeploymentId',
      field,
      `'${field}' must be a lowercase dot-, hyphen- or underscore-separated identifier of at most ${String(MAX_IDENTIFIER_LENGTH)} characters. Identifiers appear on dashboards and in metric labels, so a hostname or a URL here becomes disclosure there.`,
    );
  }
  return id;
}

export const MAX_TEXT_LENGTH = 512;

export function assertText(value: unknown, field: string, why: string): string {
  assertPresent(value, field, why);
  const text = value as string;
  if (text.length > MAX_TEXT_LENGTH) {
    throw new DeploymentError(
      'MalformedRunbook',
      field,
      `'${field}' is longer than ${String(MAX_TEXT_LENGTH)} characters. A field that wide eventually holds a stack trace or a connection string.`,
    );
  }
  return text;
}
