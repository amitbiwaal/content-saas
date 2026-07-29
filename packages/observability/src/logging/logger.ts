/**
 * Logger — `07-development-guide/logging-guide.md` §"Implementation".
 *
 * There is no `log(level, message)` and no variadic form. The signature accepts
 * a structured record, so an interpolated string cannot be passed — the same
 * make-it-unrepresentable technique used for the transaction-bound publisher.
 */

import { scanForCredentials } from './redaction.js';
import {
  LOG_RECORD_FIELDS,
  UNBOUND_CORRELATION_ID,
  type LogBindings,
  type LogFields,
  type LogLevel,
  type LogRecord,
} from './log-record.js';

/**
 * `error` requires a `code`. An error logged without a stable code cannot be
 * aggregated or alerted on (`error-handling.md`). Enforced by TYPE.
 */
export interface Logger {
  error(fields: LogFields & { readonly code: string }): void;
  warn(fields: LogFields): void;
  info(fields: LogFields): void;
  debug(fields: LogFields): void;
  child(bindings: LogBindings): Logger;
}

/** Where serialized records go. Services write JSON to stdout and nothing else. */
export interface LogSink {
  write(line: string): void;
}

export const stdoutSink: LogSink = {
  write(line: string): void {
    process.stdout.write(`${line}\n`);
  },
};

export interface LoggerOptions {
  readonly service: string;
  readonly version: string;
  readonly sink?: LogSink;
  readonly clock?: () => Date;
  readonly minLevel?: LogLevel;
  /** Called with the number of credential-shaped values the backstop caught. */
  readonly onRedactionHit?: (hits: number) => void;
  /** Called when the sink throws. Telemetry must never block the application. */
  readonly onDeliveryFailure?: () => void;
}

const LEVEL_ORDER: Readonly<Record<LogLevel, number>> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

/**
 * Serialize with the allowlist — layer 2 of redaction.
 *
 * Only fields named in `LOG_RECORD_FIELDS` are projected; anything else a
 * caller attached is dropped rather than emitted.
 */
function project(record: LogRecord): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of LOG_RECORD_FIELDS) {
    const value = record[field];
    if (value !== undefined) {
      out[field] = value;
    }
  }
  return out;
}

class StructuredLogger implements Logger {
  readonly #options: Required<Pick<LoggerOptions, 'service' | 'version'>> & LoggerOptions;
  readonly #bindings: LogBindings;
  readonly #sink: LogSink;
  readonly #clock: () => Date;
  readonly #minLevel: LogLevel;

  constructor(options: LoggerOptions, bindings: LogBindings) {
    this.#options = options;
    this.#bindings = bindings;
    this.#sink = options.sink ?? stdoutSink;
    this.#clock = options.clock ?? ((): Date => new Date());
    this.#minLevel = options.minLevel ?? 'info';
  }

  error(fields: LogFields & { readonly code: string }): void {
    this.#emit('error', fields);
  }

  warn(fields: LogFields): void {
    this.#emit('warn', fields);
  }

  info(fields: LogFields): void {
    this.#emit('info', fields);
  }

  debug(fields: LogFields): void {
    this.#emit('debug', fields);
  }

  child(bindings: LogBindings): Logger {
    return new StructuredLogger(this.#options, { ...this.#bindings, ...bindings });
  }

  #emit(level: LogLevel, fields: LogFields): void {
    // `error` and `warn` are never sampled or suppressed by level config
    // (logging-guide.md rule 10).
    if (LEVEL_ORDER[level] > LEVEL_ORDER[this.#minLevel] && level !== 'error' && level !== 'warn') {
      return;
    }

    const merged = { ...this.#bindings, ...fields };
    const record: LogRecord = {
      ...merged,
      timestamp: this.#clock().toISOString(),
      level,
      event: fields.event,
      service: this.#options.service,
      version: this.#options.version,
      correlationId: merged.correlationId ?? UNBOUND_CORRELATION_ID,
    };

    let line: string;
    try {
      // SecretValue.toJSON() returns '[REDACTED]' here — layer 1.
      line = JSON.stringify(project(record));
    } catch {
      this.#options.onDeliveryFailure?.();
      return;
    }

    // Layer 3 — the backstop. Its firing is itself the alert.
    const scanned = scanForCredentials(line);
    if (scanned.hits > 0) {
      this.#options.onRedactionHit?.(scanned.hits);
    }

    try {
      this.#sink.write(scanned.value);
    } catch {
      // Log delivery failure never blocks the application (rule 14).
      this.#options.onDeliveryFailure?.();
    }
  }
}

export function createLogger(options: LoggerOptions): Logger {
  return new StructuredLogger(options, {});
}
