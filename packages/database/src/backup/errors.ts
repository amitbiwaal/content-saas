/**
 * The backup error taxonomy — one per module, as everywhere else here.
 *
 * `SecurityError`, `AuditValidationError`, `HoldError`, `BillingError` and
 * `LedgerError` each belong to one module and carry a typed code. This follows
 * that convention: a caller catching a malformed manifest should not have to
 * know that a manifest and an authorization denial share an error class.
 *
 * ── The message names the problem, never the machine ───────────────────────
 * Nothing constructed here carries a hostname, a bucket, a connection string, a
 * key or a path. A restore report is read during an incident by people who are
 * not all on the platform team, and an operational tool that leaked
 * infrastructure detail in its own errors would be a disclosure.
 */

export type BackupErrorCode =
  /** An identifier that is not the shape its kind requires. */
  | 'InvalidBackupId'
  /** A recovery point outside the retention window, or not an instant. */
  | 'InvalidRecoveryPoint'
  /** A schema version this build does not understand. */
  | 'InvalidBackupVersion'
  /** A format outside the ones declared. */
  | 'UnsupportedFormat'
  /** A restore plan that cannot be satisfied by the backup it names. */
  | 'IncompatibleRestorePlan'
  /** A backup claiming to have been taken after now. */
  | 'FutureBackupTimestamp'
  /** A manifest whose own fields disagree, or that is missing a store. */
  | 'MalformedManifest'
  /** The same snapshot id, twice in one manifest. */
  | 'DuplicateSnapshot'
  /** Metadata that contradicts the snapshot it describes. */
  | 'InconsistentMetadata'
  /** A store this build does not classify. */
  | 'UnknownStore'
  /** A required field that was absent or empty. */
  | 'MissingField';

export class BackupError extends Error {
  readonly code: BackupErrorCode;
  readonly field: string;

  constructor(code: BackupErrorCode, field: string, message: string) {
    super(message);
    this.name = 'BackupError';
    this.code = code;
    this.field = field;
  }
}

/**
 * Deep freezing, once for the module.
 *
 * Every exported value goes through it. A manifest that came back mutable
 * could have a checksum edited after verification passed, which is precisely
 * the tampering the checksum exists to detect.
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

/** A UTC ISO-8601 instant. Local time names a different moment per reader. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

export function assertInstant(value: unknown, field: string, code: BackupErrorCode): string {
  if (typeof value !== 'string' || !ISO_INSTANT.test(value)) {
    throw new BackupError(
      code,
      field,
      `'${field}' must be a UTC ISO-8601 instant. A local-time string names a different moment depending on where it is read, and a recovery point an hour out is an hour of lost writes.`,
    );
  }
  if (Number.isNaN(Date.parse(value))) {
    throw new BackupError(code, field, `'${field}' is not a real instant.`);
  }
  return value;
}

export function assertPresent(value: unknown, field: string, why: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new BackupError('MissingField', field, `'${field}' is required: ${why}`);
  }
  return value;
}

/**
 * An identifier this module accepts.
 *
 * Lowercase, dot/hyphen/underscore separated, bounded. These appear in restore
 * reports and in metric labels; free text here would put a bucket name, a
 * hostname or worse into both.
 */
const IDENTIFIER_SHAPE = /^[a-z0-9][a-z0-9]*(?:[._-][a-z0-9]+)*$/;

export const MAX_IDENTIFIER_LENGTH = 128;

export function assertIdentifier(value: unknown, field: string): string {
  assertPresent(value, field, 'an unidentified record cannot be selected for a restore.');

  const id = value as string;
  if (id.length > MAX_IDENTIFIER_LENGTH || !IDENTIFIER_SHAPE.test(id)) {
    throw new BackupError(
      'InvalidBackupId',
      field,
      `'${field}' must be a lowercase dot-, hyphen- or underscore-separated identifier of at most ${String(MAX_IDENTIFIER_LENGTH)} characters. Identifiers appear in reports and metric labels, so a path or a hostname here becomes disclosure there.`,
    );
  }
  return id;
}

/**
 * A SHA-256 checksum, as sixty-four lowercase hex characters.
 *
 * The same shape the audit chain uses, and checked for the same reason: a
 * checksum nobody validated the shape of is one that silently compares unequal
 * to everything, so verification never passes and nobody knows why.
 */
const CHECKSUM_SHAPE = /^[0-9a-f]{64}$/;

export function assertChecksum(value: unknown, field: string): string {
  if (typeof value !== 'string' || !CHECKSUM_SHAPE.test(value)) {
    throw new BackupError(
      'MalformedManifest',
      field,
      `'${field}' must be a SHA-256 digest as 64 lowercase hex characters.`,
    );
  }
  return value;
}
