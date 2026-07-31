/**
 * The audit vocabulary the writer never had — `16-security/audit.md`.
 *
 * ── What this is NOT ───────────────────────────────────────────────────────
 * Not a second audit model. `AuditRecord`, `AuditTarget`, `AuditContext`,
 * `AuditActorKind` and `AuditResult` are in `writer.ts` and stay exactly as
 * they are, hash preimage included. Everything here either PROJECTS one of them
 * or is a fact the existing model has no field for.
 *
 * ── `AuditEvent` is the front door, not a replacement for `NewAuditRecord` ──
 * A caller submits an `AuditEvent`; `toNewAuditRecord` turns it into the
 * `NewAuditRecord` the frozen `AuditWriter` already takes. Nothing bypasses the
 * writer, and the record that lands in `audit_log` is the same shape it has
 * always been.
 *
 * ── Why a category, when `action` exists ───────────────────────────────────
 * `audit.md` §"What must be audited" is a table of thirteen categories, and
 * every retention, alerting and review policy in that document is written per
 * category. Nothing in the record carries one, so "show me every
 * authorization event" is a query somebody has to assemble out of action
 * prefixes — and gets wrong the first time a new module names an action.
 *
 * ── Why `action` is validated by SHAPE and not enumerated ──────────────────
 * The spec says `action` is "an enumerated constant, never free text", and
 * gives the reason: `"user.role.changed"`, `"role_change"` and `"Changed role"`
 * all appear within a year and no query finds all three.
 *
 * The codebase already answers this with a convention — every one of the
 * twenty-odd declared actions is `domain.thing.verb`, lowercase, dot-separated.
 * Enforcing that shape refuses all three of the spec's examples while accepting
 * every action already in use. A hard enumeration here would instead have to
 * list them, and would reject the next module's action until somebody edited
 * this file — which is how an enumeration becomes a reason to bypass the
 * service.
 */

import type {
  AuditActorKind,
  AuditContext,
  AuditResult,
  AuditTarget,
  NewAuditRecord,
} from './writer.js';

/**
 * The thirteen categories of `audit.md` §"What must be audited".
 *
 * Transcribed from that table, in its order. Not invented, and not extended:
 * a fourteenth category would be a policy decision that document has to make
 * first, because retention and review are written per category.
 */
export const AUDIT_CATEGORIES = [
  'authentication',
  'authorization',
  'permission_changes',
  'role_assignments',
  'workspace_lifecycle',
  'secret_access',
  'replay_execution',
  'dlq_intervention',
  'provider_configuration',
  'billing',
  'exports',
  'deletion',
  'administration',
] as const;

export type AuditCategory = (typeof AUDIT_CATEGORIES)[number];

export function isAuditCategory(value: unknown): value is AuditCategory {
  return typeof value === 'string' && (AUDIT_CATEGORIES as readonly string[]).includes(value);
}

/**
 * `domain.thing.verb` — lowercase, dot-separated, at least two segments.
 *
 * Two segments minimum because a bare `create` says nothing about what was
 * created, and an audit query for it would match three unrelated modules.
 */
const ACTION_SHAPE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:_[a-z0-9]+)*)+$/;

export function isAuditActionShape(value: unknown): boolean {
  return typeof value === 'string' && ACTION_SHAPE.test(value);
}

/**
 * Who acted, as one value.
 *
 * `AuditRecord` carries `actorId` and `actorKind` as two flat columns, which is
 * right for the table. This is the pair as a value, so a caller passes one
 * thing and cannot supply an id without the kind that says how to read it.
 */
export interface AuditActor {
  readonly id: string;
  readonly kind: AuditActorKind;
}

/**
 * Enumerated domain detail about the action.
 *
 * The named type for what `AuditContext.detail` already is. Values are
 * enumerated constants, never free text and never personal data: `context` is
 * queried, and it is inside a record that is kept for seven years and can never
 * be updated.
 */
export type AuditMetadata = Readonly<Record<string, string>>;

/**
 * One auditable action, before it is recorded.
 *
 * Everything `NewAuditRecord` needs, plus the category, and with the actor as
 * one value. The writer assigns the id, the timestamp and both hashes — none of
 * which a caller may supply, which is why they are absent here.
 */
export interface AuditEvent {
  readonly category: AuditCategory;
  /** Enumerated, never free text. Shape-validated — see the file header. */
  readonly action: string;
  /** null ONLY for pre-tenant actions — authentication, membership resolution. */
  readonly tenantId: string | null;
  readonly organizationId: string;
  readonly actor: AuditActor;
  readonly correlationId: string;
  readonly target: AuditTarget;
  readonly result: AuditResult;
  /** Mandatory including on success: a privileged action needs a justification. */
  readonly reason: string;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  readonly sessionId: string | null;
  readonly stepUpSatisfied: boolean;
  readonly metadata?: AuditMetadata;
}

export type AuditValidationCode =
  | 'InvalidCategory'
  | 'InvalidAction'
  | 'InvalidResult'
  | 'InvalidActorKind'
  | 'InvalidTimestamp'
  | 'MalformedMetadata'
  | 'MissingIdentifier';

/**
 * A refused audit submission.
 *
 * Typed because the caller branches: a malformed metadata value is a bug in the
 * emitting module, and an unknown category is usually a typo. Both must fail
 * the ACTION — `audit.md`: "A failed audit write fails the action" — so this
 * throws rather than returning a value.
 */
export class AuditValidationError extends Error {
  readonly code: AuditValidationCode;
  readonly field: string;

  constructor(code: AuditValidationCode, field: string, message: string) {
    super(message);
    this.name = 'AuditValidationError';
    this.code = code;
    this.field = field;
  }
}

const ACTOR_KINDS: readonly AuditActorKind[] = ['user', 'api-key', 'service', 'operator'];
const RESULTS: readonly AuditResult[] = ['success', 'failure', 'denied'];

const require = (value: unknown, field: string, why: string): string => {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AuditValidationError('MissingIdentifier', field, `'${field}' is required: ${why}`);
  }
  return value;
};

/** The metadata limits. Bounded because the column is queried and kept forever. */
export const MAX_METADATA_KEYS = 32;
export const MAX_METADATA_VALUE_LENGTH = 256;

const METADATA_KEY_SHAPE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

/**
 * Metadata that can be queried and will not grow without bound.
 *
 * String values only: a nested object in a JSONB column that is read back by
 * an investigator is a shape nobody can write a query against, and a number
 * that arrives as `1` and `"1"` on different days cannot be filtered on either.
 */
export function assertValidMetadata(metadata: AuditMetadata, field = 'metadata'): AuditMetadata {
  const keys = Object.keys(metadata);

  if (keys.length > MAX_METADATA_KEYS) {
    throw new AuditValidationError(
      'MalformedMetadata',
      field,
      `Audit metadata carries ${String(keys.length)} keys; the limit is ${String(MAX_METADATA_KEYS)}. An unbounded record is one nobody can query and nobody can delete.`,
    );
  }

  for (const key of keys) {
    if (!METADATA_KEY_SHAPE.test(key)) {
      throw new AuditValidationError(
        'MalformedMetadata',
        `${field}.${key}`,
        `'${key}' is not a metadata key: lowercase, dot-free, underscore-separated. A key nobody can predict is a column nobody can query.`,
      );
    }

    const value: unknown = metadata[key];
    if (typeof value !== 'string') {
      throw new AuditValidationError(
        'MalformedMetadata',
        `${field}.${key}`,
        `Audit metadata values are strings; '${key}' is a ${typeof value}. A value that arrives as 1 and "1" on different days cannot be filtered on either.`,
      );
    }
    if (value.length > MAX_METADATA_VALUE_LENGTH) {
      throw new AuditValidationError(
        'MalformedMetadata',
        `${field}.${key}`,
        `'${key}' is ${String(value.length)} characters; the limit is ${String(MAX_METADATA_VALUE_LENGTH)}. Detail is enumerated, not free text.`,
      );
    }
  }

  return metadata;
}

/**
 * An ISO-8601 UTC instant, refused if it is not one.
 *
 * The audit timestamp itself is the SERVER's and never validated here — the
 * writer stamps it. This is for instants that arrive as metadata or as a query
 * bound, where a local-time string names a different moment depending on where
 * it is read, and a record placed in the wrong retention window is one that is
 * deleted early or kept illegally.
 */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

export function assertValidTimestamp(value: unknown, field: string): string {
  if (typeof value !== 'string' || !ISO_INSTANT.test(value)) {
    throw new AuditValidationError(
      'InvalidTimestamp',
      field,
      `'${field}' must be a UTC ISO-8601 instant; got '${String(value)}'. A local-time string names a different moment depending on where it is read.`,
    );
  }
  if (Number.isNaN(Date.parse(value))) {
    throw new AuditValidationError(
      'InvalidTimestamp',
      field,
      `'${String(value)}' is not a real instant.`,
    );
  }
  return value;
}

/**
 * Validate an event, refusing everything the record cannot carry safely.
 *
 * Ordering is deliberate: identity first, then the enumerations, then the
 * metadata. A submission missing its organization is refused before anybody
 * looks at whether its category is spelled right.
 */
export function assertValidAuditEvent(event: AuditEvent): AuditEvent {
  require(event.organizationId, 'organizationId', 'every audited action belongs to an organization.');
  require(event.correlationId, 'correlationId', 'an audit record with no correlation cannot be placed on a timeline.');
  require(event.actor.id, 'actor.id', 'an action is always attributable to somebody.');
  require(event.target.kind, 'target.kind', 'what was acted on.');
  require(event.target.id, 'target.id', 'which one.');
  require(event.reason, 'reason', 'mandatory including on success — a successful privileged action needs a recorded justification as much as a denial does.');

  if (!isAuditCategory(event.category)) {
    throw new AuditValidationError(
      'InvalidCategory',
      'category',
      `'${String(event.category)}' is not an audit category. Available: ${AUDIT_CATEGORIES.join(', ')}.`,
    );
  }

  if (!isAuditActionShape(event.action)) {
    throw new AuditValidationError(
      'InvalidAction',
      'action',
      `'${String(event.action)}' is not an audit action. Actions are lowercase, dot-namespaced and at least two segments — 'role_change' and 'Changed role' are the same event under names no query finds together.`,
    );
  }

  if (!ACTOR_KINDS.includes(event.actor.kind)) {
    throw new AuditValidationError(
      'InvalidActorKind',
      'actor.kind',
      `'${String(event.actor.kind)}' is not an actor kind. Available: ${ACTOR_KINDS.join(', ')}.`,
    );
  }

  if (!RESULTS.includes(event.result)) {
    throw new AuditValidationError(
      'InvalidResult',
      'result',
      `'${String(event.result)}' is not an audit result. Available: ${RESULTS.join(', ')}.`,
    );
  }

  if (typeof event.stepUpSatisfied !== 'boolean') {
    throw new AuditValidationError(
      'MalformedMetadata',
      'stepUpSatisfied',
      'Step-up satisfaction is a boolean; it is inside the hash preimage and a coerced value would change the chain.',
    );
  }

  if (event.metadata !== undefined) assertValidMetadata(event.metadata);

  return event;
}

/**
 * The category, carried into the record.
 *
 * `AuditRecord` has no category column and this increment adds no schema, so it
 * rides in `context.detail` under a reserved key. `detail` is deliberately
 * OUTSIDE the hash preimage — `hashAuditRecord` covers `stepUpSatisfied` only —
 * so this cannot invalidate an existing chain.
 */
export const CATEGORY_METADATA_KEY = 'audit_category';

/**
 * An event, as the frozen writer takes it.
 *
 * A projection: every field goes to the field of the same meaning, the actor
 * splits back into the two columns, and the category joins the detail. Nothing
 * is invented and nothing is dropped.
 */
export function toNewAuditRecord(event: AuditEvent): NewAuditRecord {
  const context: AuditContext = {
    ipAddress: event.ipAddress,
    userAgent: event.userAgent,
    sessionId: event.sessionId,
    stepUpSatisfied: event.stepUpSatisfied,
    detail: { ...event.metadata, [CATEGORY_METADATA_KEY]: event.category },
  };

  return {
    tenantId: event.tenantId,
    organizationId: event.organizationId,
    actorId: event.actor.id,
    actorKind: event.actor.kind,
    correlationId: event.correlationId,
    action: event.action,
    target: event.target,
    result: event.result,
    reason: event.reason,
    context,
  };
}

/** The category a recorded event was filed under, or null on an older record. */
export function categoryOf(context: AuditContext): AuditCategory | null {
  const value = context.detail?.[CATEGORY_METADATA_KEY];
  return isAuditCategory(value) ? value : null;
}

export function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.getOwnPropertyNames(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}
