/**
 * The security-posture error taxonomy — one per module, as everywhere else.
 *
 * `AuthorizationError`, `AuditValidationError`, `HoldError`, `BillingError` and
 * `LedgerError` each belong to one module and carry a typed code. This follows
 * that convention rather than extending one of them: a caller catching a
 * malformed finding should not have to know that a finding and an authorization
 * denial share an error class, and `DenyReason` gaining `InvalidSeverity` would
 * make the authorization taxonomy describe things authorization knows nothing
 * about.
 *
 * ── The message is for an operator, never for a caller ─────────────────────
 * Nothing constructed here carries a stack trace, a secret, a credential or an
 * internal path. A security tool that leaked implementation detail in its own
 * error messages would be the disclosure it exists to find.
 */

export type SecurityErrorCode =
  /** A severity outside the four `threat-model.md` defines. */
  | 'InvalidSeverity'
  /** A category outside the five the document groups its threats under. */
  | 'InvalidCategory'
  /** An identifier that is not the shape its kind requires. */
  | 'MalformedIdentifier'
  /** A threat id nobody declared. */
  | 'UnknownThreat'
  /** A policy that does not describe a control. */
  | 'InvalidPolicy'
  /** A recommendation with no action in it. */
  | 'InvalidRecommendation'
  /** The same finding, twice in one assessment. */
  | 'DuplicateFinding'
  /** A rule no policy declares. */
  | 'UnknownRule'
  /** Not a UTC ISO-8601 instant. */
  | 'InvalidTimestamp'
  /** An assessment that claims to have happened after now. */
  | 'FutureAssessment'
  /** A required field that was absent or empty. */
  | 'MissingField'
  /** An assessment whose own fields disagree. */
  | 'InconsistentAssessment';

export class SecurityError extends Error {
  readonly code: SecurityErrorCode;
  readonly field: string;

  constructor(code: SecurityErrorCode, field: string, message: string) {
    super(message);
    this.name = 'SecurityError';
    this.code = code;
    this.field = field;
  }
}

/**
 * Deep freezing, once for the module.
 *
 * Every exported value goes through this. A policy or a finding that came back
 * mutable could be downgraded in place by whatever was handed it, and a
 * severity edited after the fact is the one an auditor asks about.
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

export function assertInstant(value: unknown, field: string): string {
  if (typeof value !== 'string' || !ISO_INSTANT.test(value)) {
    throw new SecurityError(
      'InvalidTimestamp',
      field,
      `'${field}' must be a UTC ISO-8601 instant. A local-time string names a different moment depending on where it is read, and a finding dated wrong is one nobody can correlate with an incident.`,
    );
  }
  if (Number.isNaN(Date.parse(value))) {
    throw new SecurityError('InvalidTimestamp', field, `'${field}' is not a real instant.`);
  }
  return value;
}

export function assertPresent(value: unknown, field: string, why: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new SecurityError('MissingField', field, `'${field}' is required: ${why}`);
  }
  return value;
}

/**
 * An identifier this module accepts.
 *
 * Lowercase, dot- or hyphen-separated, bounded. The shape matters because these
 * appear in reports an auditor reads and in metric labels: an identifier
 * carrying a path, a token or free text would put implementation detail — or
 * worse — somewhere it is kept and shown.
 */
const IDENTIFIER_SHAPE = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;

export const MAX_IDENTIFIER_LENGTH = 128;

export function assertIdentifier(value: unknown, field: string): string {
  assertPresent(value, field, 'an unidentified record cannot be deduplicated or referenced.');

  const id = value as string;
  if (id.length > MAX_IDENTIFIER_LENGTH || !IDENTIFIER_SHAPE.test(id)) {
    throw new SecurityError(
      'MalformedIdentifier',
      field,
      `'${field}' must be a lowercase dot- or hyphen-separated identifier of at most ${String(MAX_IDENTIFIER_LENGTH)} characters. Identifiers appear in reports and in metric labels, so free text here becomes disclosure there.`,
    );
  }
  return id;
}
