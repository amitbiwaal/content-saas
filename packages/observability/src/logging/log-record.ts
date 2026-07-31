/**
 * The log record — `07-development-guide/logging-guide.md` §"The log record".
 *
 * This is the EMITTED shape and the wire contract. Services write this JSON to
 * stdout and nothing else.
 */

/**
 * `fatal` does not exist. A process that cannot continue logs at `error` and
 * exits non-zero; a separate level implies a distinction nothing acts on
 * (logging-guide.md rule 9).
 */
export const LOG_LEVELS = ['error', 'warn', 'info', 'debug'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/**
 * Is this a severity this build knows?
 *
 * The `Logger` port has a method per level, so a caller writing code cannot
 * pass a bad one. A caller reading `LOG_LEVEL` out of the environment can, and
 * a process that started at a level nobody declared would log the wrong amount
 * for as long as it ran.
 */
export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && (LOG_LEVELS as readonly string[]).includes(value);
}

export const OUTCOMES = ['success', 'failure', 'denied', 'suppressed'] as const;

export type Outcome = (typeof OUTCOMES)[number];

export function isOutcome(value: unknown): value is Outcome {
  return typeof value === 'string' && (OUTCOMES as readonly string[]).includes(value);
}

export interface LogRecord {
  // — always present —
  /** ISO 8601 UTC. */
  readonly timestamp: string;
  readonly level: LogLevel;
  /** dot.namespaced, e.g. 'outbox.relay.claimed'. The primary aggregation key. */
  readonly event: string;
  readonly service: string;
  /** Build identity. */
  readonly version: string;
  /** Mandatory on every record — the pivot the whole platform is built around. */
  readonly correlationId: string;

  // — present when known —
  readonly tenantId?: string;
  readonly organizationId?: string;
  readonly actorId?: string;
  readonly requestId?: string;
  readonly eventId?: string;
  readonly objectId?: string;
  readonly operationId?: string;
  readonly auditId?: string;

  // — outcome —
  readonly outcome?: Outcome;
  readonly durationMs?: number;
  /** Stable error code. */
  readonly code?: string;
  /** Sanitised — never raw provider or database output. */
  readonly detail?: string;

  readonly traceId?: string;
  readonly spanId?: string;
}

/**
 * ALLOWLIST — layer 2 of redaction. Anything not listed here does not appear in
 * the output, regardless of what a caller passes.
 *
 * A blocklist fails on the first field nobody thought of; an allowlist means a
 * new field is invisible until deliberately included, which is the safe
 * direction for the default (logging-guide.md §Redaction).
 */
export const LOG_RECORD_FIELDS = [
  'timestamp',
  'level',
  'event',
  'service',
  'version',
  'correlationId',
  'tenantId',
  'organizationId',
  'actorId',
  'requestId',
  'eventId',
  'objectId',
  'operationId',
  'auditId',
  'outcome',
  'durationMs',
  'code',
  'detail',
  'traceId',
  'spanId',
] as const satisfies readonly (keyof LogRecord)[];

export type LogRecordField = (typeof LOG_RECORD_FIELDS)[number];

/**
 * What a CALL SITE supplies.
 *
 * `timestamp`, `level`, `service`, and `version` are injected by the logger.
 * `correlationId` is optional here because `child()` binds it once per scope —
 * "so correlationId and tenantId are attached automatically rather than passed
 * to every call and forgotten on one" (logging-guide.md §Implementation).
 *
 * It remains mandatory on the emitted record; see `UNBOUND_CORRELATION_ID`.
 */
export type LogFields = Omit<
  LogRecord,
  'timestamp' | 'level' | 'service' | 'version' | 'correlationId'
> & {
  readonly correlationId?: string;
};

/** Bindings a child logger attaches to every record in its scope. */
export type LogBindings = Partial<Omit<LogRecord, 'timestamp' | 'level' | 'event'>>;

/**
 * Emitted when no `correlationId` is bound or supplied.
 *
 * The record is still emitted — "log delivery never blocks the application"
 * (rule 14) — but the sentinel makes the defect visible and countable rather
 * than silently producing an unattributable line.
 */
export const UNBOUND_CORRELATION_ID = 'unbound';
