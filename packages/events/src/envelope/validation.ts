/**
 * Envelope validation.
 *
 * Spec: `13-event-platform/event-apis.md` §"The canonical event envelope" —
 * that document is canonical, and the envelope is FROZEN. Adding a field is an
 * ADR, not a patch.
 *
 * Validation runs INSIDE `publish`, before commit. An unregistered type or a
 * schema violation throws, and the producer's state change rolls back with it —
 * so an invalid event can never reach the outbox
 * (`13-event-platform/event-registry.md`).
 */

import { ENVELOPE_FIELDS, type DomainEvent } from '@contentos/contracts';

export interface ValidationIssue {
  readonly field: string;
  readonly code: string;
  readonly detail: string;
}

export type ValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly issues: readonly ValidationIssue[] };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** PascalCase, past tense by convention: 'ArticlePublished'. */
const EVENT_TYPE = /^[A-Z][A-Za-z0-9]*$/;
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Payload rules — `event-apis.md` §"Payload rules".
 *
 * Enforced at validation, not by convention. Events fan out to notification
 * channels and webhook subscribers with weaker controls than the source table,
 * so a credential or a draft body in a payload is a disclosure that outlives
 * the request that produced it.
 */
const CREDENTIAL_KEYS =
  /^(password|passwd|secret|token|api_?key|access_?token|refresh_?token|authorization|cookie|session_?id|private_?key|credential)s?$/i;

/** Content-shaped fields: the payload would duplicate the source of truth and go stale. */
const CONTENT_KEYS =
  /^(body|content|draft|text|html|markdown|prompt|completion|excerpt|transcript|blob|base64|image_?data)$/i;

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Unbounded arrays break stream limits and produce publish-side poison rows. */
export const MAX_PAYLOAD_ARRAY_LENGTH = 1000;
export const MAX_PAYLOAD_DEPTH = 10;
/** A payload is a notification, not a document. */
export const MAX_PAYLOAD_BYTES = 64 * 1024;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate the eleven envelope fields plus the payload.
 *
 * Returns every issue rather than the first, so a producer fixing a malformed
 * event sees the whole picture in one cycle.
 */
export function validateEnvelope(event: DomainEvent<unknown>): ValidationResult {
  const issues: ValidationIssue[] = [];
  const add = (field: string, code: string, detail: string): void => {
    issues.push({ field, code, detail });
  };

  // Every field is required. `causationId` is nullable but always PRESENT
  // (event-apis.md D-4) — the optional-vs-null ambiguity is removed.
  for (const field of ENVELOPE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(event, field)) {
      add(field, 'MISSING_FIELD', `'${field}' is required on every envelope.`);
    }
  }

  if (!UUID.test(event.eventId)) {
    add('eventId', 'NOT_UUID', 'eventId must be a UUIDv7.');
  }
  if (!EVENT_TYPE.test(event.eventType)) {
    add(
      'eventType',
      'BAD_FORMAT',
      'eventType must be PascalCase past tense, e.g. ArticlePublished.',
    );
  }
  if (!Number.isInteger(event.eventVersion) || event.eventVersion < 1) {
    add('eventVersion', 'BAD_VERSION', 'eventVersion must be an integer >= 1.');
  }
  if (typeof event.aggregateType !== 'string' || event.aggregateType.length === 0) {
    add('aggregateType', 'EMPTY', 'aggregateType is required.');
  }
  // The ONLY ordering/partition key.
  if (!UUID.test(event.aggregateId)) {
    add('aggregateId', 'NOT_UUID', 'aggregateId must be a UUID; it is the sole partition key.');
  }
  if (!UUID.test(event.tenantId)) {
    add(
      'tenantId',
      'NOT_UUID',
      'tenantId must be a UUID; it reconstructs RLS context at every consumer.',
    );
  }
  if (!UUID.test(event.organizationId)) {
    add('organizationId', 'NOT_UUID', 'organizationId must be a UUID (ADR-017).');
  }
  if (!UUID.test(event.correlationId)) {
    add(
      'correlationId',
      'NOT_UUID',
      'correlationId must be a UUID; it is the primary incident query.',
    );
  }
  if (event.causationId !== null && !UUID.test(event.causationId)) {
    add('causationId', 'NOT_UUID_OR_NULL', 'causationId must be a UUID or null for a root event.');
  }
  if (typeof event.producer !== 'string' || event.producer.length === 0) {
    add('producer', 'EMPTY', 'producer is required for DLQ attribution.');
  }
  // ISO 8601 string, not Date: it must round-trip byte-identically through the
  // outbox, the bus, the DLQ, and replay (event-apis.md D-5).
  if (typeof event.occurredAt !== 'string' || !ISO_8601.test(event.occurredAt)) {
    add(
      'occurredAt',
      'NOT_ISO8601',
      'occurredAt must be an ISO 8601 UTC string from the injected Clock.',
    );
  }

  issues.push(...validatePayload(event.payload));

  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}

/** Payload carries business identifiers and immutable event data. Nothing else. */
export function validatePayload(payload: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (!isPlainObject(payload)) {
    return [{ field: 'payload', code: 'NOT_OBJECT', detail: 'payload must be a plain object.' }];
  }

  let serialized: string;
  try {
    serialized = JSON.stringify(payload);
  } catch {
    return [
      { field: 'payload', code: 'NOT_SERIALIZABLE', detail: 'payload must be JSON-serializable.' },
    ];
  }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_PAYLOAD_BYTES) {
    issues.push({
      field: 'payload',
      code: 'TOO_LARGE',
      detail: `payload exceeds ${String(MAX_PAYLOAD_BYTES)} bytes. Events are notifications; reference large data by id.`,
    });
  }

  const walk = (node: unknown, path: string, depth: number): void => {
    if (depth > MAX_PAYLOAD_DEPTH) {
      issues.push({
        field: path,
        code: 'TOO_DEEP',
        detail: `payload nesting exceeds ${String(MAX_PAYLOAD_DEPTH)}.`,
      });
      return;
    }

    if (Array.isArray(node)) {
      if (node.length > MAX_PAYLOAD_ARRAY_LENGTH) {
        issues.push({
          field: path,
          code: 'ARRAY_TOO_LONG',
          detail: `arrays are capped at ${String(MAX_PAYLOAD_ARRAY_LENGTH)}; an uncapped array is an amplification vector.`,
        });
      }
      node.forEach((item, i) => {
        walk(item, `${path}[${String(i)}]`, depth + 1);
      });
      return;
    }

    if (isPlainObject(node)) {
      for (const [key, value] of Object.entries(node)) {
        const childPath = path === 'payload' ? `payload.${key}` : `${path}.${key}`;
        if (CREDENTIAL_KEYS.test(key)) {
          issues.push({
            field: childPath,
            code: 'CREDENTIAL_FIELD',
            detail:
              'payloads never carry credentials; events reach consumers with weaker controls than the source table.',
          });
        }
        if (CONTENT_KEYS.test(key)) {
          issues.push({
            field: childPath,
            code: 'CONTENT_FIELD',
            detail:
              'payloads never carry content; it would duplicate the source of truth and go stale.',
          });
        }
        if (typeof value === 'string' && EMAIL.test(value)) {
          issues.push({
            field: childPath,
            code: 'EMAIL_VALUE',
            detail: 'payloads carry opaque identifiers, not personal data.',
          });
        }
        walk(value, childPath, depth + 1);
      }
      return;
    }

    if (node !== null && !['string', 'number', 'boolean'].includes(typeof node)) {
      issues.push({
        field: path,
        code: 'UNSUPPORTED_TYPE',
        detail: 'payload values must be scalars, objects, or arrays.',
      });
    }
  };

  walk(payload, 'payload', 0);
  return issues;
}

/** Thrown inside `publish`, before commit, so the producer's transaction rolls back. */
export class EnvelopeValidationError extends Error {
  readonly code = 'SchemaViolation';
  readonly issues: readonly ValidationIssue[];

  constructor(issues: readonly ValidationIssue[]) {
    super(`Envelope validation failed: ${issues.map((i) => `${i.field} ${i.code}`).join('; ')}`);
    this.name = 'EnvelopeValidationError';
    this.issues = issues;
  }
}

export function assertValidEnvelope(event: DomainEvent<unknown>): void {
  const result = validateEnvelope(event);
  if (!result.ok) {
    throw new EnvelopeValidationError(result.issues);
  }
}
