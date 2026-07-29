/**
 * Event Platform structured logging.
 *
 * Spec: `13-event-platform/observability.md` §"Structured logging".
 *
 * STRUCTURED ONLY. No string interpolation, no free-text message carrying data:
 * a field that has been formatted into a sentence cannot be filtered, grouped,
 * or alerted on, which is the entire reason for logging structurally.
 *
 * PAYLOADS ARE NEVER LOGGED — not at debug, not on error, not for a DLQ entry.
 * That is enforced STRUCTURALLY here: `EventPlatformLogRecord` has no payload
 * field and the writers accept only identifiers, so there is no call that could
 * emit one. Logs reach a broader audience than the database and outlive it in
 * aggregation systems.
 *
 * `errorCode` IS A CLASSIFICATION, NEVER A RAW MESSAGE. Raw dependency errors
 * routinely embed connection strings and bearer tokens; the classification is
 * what an operator needs, and the sanitised message is retained on the DLQ
 * entry instead.
 *
 * WHY THIS RECORD IS NOT `@contentos/observability`'s `LogRecord`: that schema
 * is closed at twenty fields and its `project()` DROPS anything else, so
 * `eventType`, `eventVersion`, `aggregateId`, `causationId`, `group` and
 * `replayRunId` — all mandatory here — would vanish silently. The credential
 * backstop from that package is reused rather than reimplemented.
 */

import type { DomainEvent } from '@contentos/contracts';
import { type LogLevel, scanForCredentials } from '@contentos/observability';

export type EventLogComponent =
  | 'outbox'
  | 'relay'
  | 'dispatcher'
  | 'consumer'
  | 'retry'
  | 'dlq'
  | 'replay'
  | 'registry'
  | 'worker';

export type EventLogAction =
  | 'published'
  | 'claimed'
  | 'delivered'
  | 'suppressed'
  | 'retried'
  | 'dead-lettered'
  | 'quarantined'
  | 'skipped'
  | 'held'
  | 'replayed'
  | 'invariant-breach';

/** The documented record. Every field is an identifier or a classification. */
export interface EventPlatformLogRecord {
  readonly timestamp: string;
  readonly level: LogLevel;
  readonly component: EventLogComponent;
  readonly event: EventLogAction;
  readonly eventId: string;
  readonly eventType: string;
  readonly eventVersion: number;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly aggregateId: string;
  readonly tenantId: string;
  readonly group: string | null;
  readonly outcome: string;
  readonly durationMs: number | null;
  /** A classification, never a raw message. */
  readonly errorCode: string | null;
  readonly traceId: string;
  readonly spanId: string;
  /** Present only for a replayed delivery. */
  readonly replayRunId?: string;
  /** Which attempt this was, for retry diagnosis. */
  readonly attempt?: number;
}

export interface EventLogSink {
  write(record: EventPlatformLogRecord): void;
}

/** Newline-delimited JSON. One record per line, machine-parseable. */
export const jsonLineSink: EventLogSink = {
  write(record): void {
    process.stdout.write(`${JSON.stringify(record)}
`);
  },
};

export interface EventLogContext {
  readonly component: EventLogComponent;
  readonly event: EventLogAction;
  readonly outcome: string;
  readonly group?: string | null;
  readonly durationMs?: number | null;
  readonly errorCode?: string | null;
  readonly replayRunId?: string;
  readonly attempt?: number;
  readonly traceId?: string;
  readonly spanId?: string;
}

export interface EventLoggerOptions {
  readonly sink?: EventLogSink;
  readonly clock?: () => Date;
  readonly minLevel?: LogLevel;
  /** Called with the number of credential-shaped values the backstop caught. */
  readonly onRedactionHit?: (hits: number) => void;
  /** Telemetry must never block the platform, so a failing sink is reported. */
  readonly onDeliveryFailure?: (error: unknown) => void;
}

export interface EventLogger {
  debug(event: DomainEvent<unknown>, ctx: EventLogContext): void;
  info(event: DomainEvent<unknown>, ctx: EventLogContext): void;
  warn(event: DomainEvent<unknown>, ctx: EventLogContext): void;
  error(event: DomainEvent<unknown>, ctx: EventLogContext & { readonly errorCode: string }): void;
}

const LEVEL_ORDER: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

export function createEventLogger(options: EventLoggerOptions = {}): EventLogger {
  const sink = options.sink ?? jsonLineSink;
  const clock = options.clock ?? ((): Date => new Date());
  const minLevel = options.minLevel ?? 'info';

  function emit(level: LogLevel, event: DomainEvent<unknown>, ctx: EventLogContext): void {
    // `error` and `warn` are never suppressed by level configuration: an error
    // that a config change silenced is an error nobody ever learns about.
    if (LEVEL_ORDER[level] > LEVEL_ORDER[minLevel] && level !== 'error' && level !== 'warn') {
      return;
    }

    const record: EventPlatformLogRecord = {
      timestamp: clock().toISOString(),
      level,
      component: ctx.component,
      event: ctx.event,
      eventId: event.eventId,
      eventType: event.eventType,
      eventVersion: event.eventVersion,
      correlationId: event.correlationId,
      causationId: event.causationId,
      aggregateId: event.aggregateId,
      tenantId: event.tenantId,
      group: ctx.group ?? null,
      outcome: ctx.outcome,
      durationMs: ctx.durationMs ?? null,
      errorCode: ctx.errorCode ?? null,
      traceId: ctx.traceId ?? '',
      spanId: ctx.spanId ?? '',
      ...(ctx.replayRunId === undefined ? {} : { replayRunId: ctx.replayRunId }),
      ...(ctx.attempt === undefined ? {} : { attempt: ctx.attempt }),
    };

    // BACKSTOP, not the primary defence. The record carries only identifiers by
    // construction; this catches a classification string that a dependency
    // error smuggled a credential into.
    const scan = scanForCredentials(record.errorCode ?? '');
    if (scan.hits > 0) {
      options.onRedactionHit?.(scan.hits);
      deliver({ ...record, errorCode: scan.value });
      return;
    }

    deliver(record);
  }

  function deliver(record: EventPlatformLogRecord): void {
    try {
      sink.write(record);
    } catch (error) {
      options.onDeliveryFailure?.(error);
    }
  }

  return {
    debug(event, ctx): void {
      emit('debug', event, ctx);
    },
    info(event, ctx): void {
      emit('info', event, ctx);
    },
    warn(event, ctx): void {
      emit('warn', event, ctx);
    },
    error(event, ctx): void {
      emit('error', event, ctx);
    },
  };
}
