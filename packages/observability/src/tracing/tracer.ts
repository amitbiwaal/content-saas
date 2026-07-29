/**
 * Tracer — the abstraction services instrument against.
 *
 * Mandatory span attributes are specified in `14-operations/monitoring.md` §3.2.
 * Declaring them in the type is what makes them "actually mandatory" (§7):
 * `packages/observability` is the only place instrumentation is configured, so
 * a required attribute enforced here is enforced everywhere.
 */

import {
  cryptoIdGenerator,
  formatTraceparent,
  parseTraceparent,
  type IdGenerator,
  type SpanContext,
} from './trace-context.js';

/** Scalars only — no content, no payloads, no prompts. */
export type AttributeValue = string | number | boolean;

/**
 * Attributes required on every span (monitoring.md §3.2).
 *
 * `tenantId` IS carried on spans — unlike metrics. "tenant_id in telemetry is
 * an identifier, not content — safe to log, essential for isolation forensics"
 * (monitoring.md §11).
 */
export interface RequiredSpanAttributes {
  readonly tenantId: string;
  readonly correlationId: string;
}

/** Present where applicable (monitoring.md §3.2). */
export interface OptionalSpanAttributes {
  readonly workflowId?: string;
  readonly articleId?: string;
  readonly engine?: string;
  readonly stage?: string;
}

export type SpanAttributes = RequiredSpanAttributes &
  OptionalSpanAttributes &
  Readonly<Record<string, AttributeValue | undefined>>;

export type SpanStatus = 'unset' | 'ok' | 'error';

export interface Span {
  readonly context: SpanContext;
  readonly name: string;
  setAttribute(key: string, value: AttributeValue): void;
  setStatus(status: SpanStatus, code?: string): void;
  /** Ends the span. Idempotent — a double end is ignored, never an error. */
  end(): void;
}

export interface FinishedSpan {
  readonly name: string;
  readonly context: SpanContext;
  readonly attributes: Readonly<Record<string, AttributeValue>>;
  readonly status: SpanStatus;
  readonly code?: string;
  readonly startedAtMs: number;
  readonly endedAtMs: number;
  readonly durationMs: number;
}

export interface SpanExporter {
  export(span: FinishedSpan): void;
}

export interface Tracer {
  /** Start a root span, or continue an inbound trace when `parent` is given. */
  startSpan(name: string, attributes: SpanAttributes, parent?: SpanContext | null): Span;
  /**
   * Start a span LINKED to an upstream trace rather than extending it.
   *
   * Consumers start a new trace and link, because "a single request can cause
   * hundreds of downstream events over hours; one continuous trace would be
   * unreadable and would hold the originating span open"
   * (`logging-guide.md` §"Correlation across boundaries").
   */
  startLinkedSpan(name: string, attributes: SpanAttributes, linkedTraceId: string): Span;
  /** Extract inbound W3C trace context. */
  extract(traceparent: string | undefined | null): SpanContext | null;
  /** Format outbound W3C trace context. */
  inject(context: SpanContext): string;
}

export interface TracerOptions {
  readonly exporter?: SpanExporter;
  readonly ids?: IdGenerator;
  readonly now?: () => number;
  /** Head-based sampling decision, made once per trace. */
  readonly sampler?: (name: string, attributes: SpanAttributes) => boolean;
  readonly onExportFailure?: () => void;
}

class BasicSpan implements Span {
  readonly context: SpanContext;
  readonly name: string;
  readonly #attributes: Record<string, AttributeValue> = {};
  readonly #startedAtMs: number;
  readonly #now: () => number;
  readonly #exporter: SpanExporter | undefined;
  readonly #onExportFailure: (() => void) | undefined;
  #status: SpanStatus = 'unset';
  #code: string | undefined;
  #ended = false;

  constructor(
    name: string,
    context: SpanContext,
    attributes: SpanAttributes,
    now: () => number,
    exporter: SpanExporter | undefined,
    onExportFailure: (() => void) | undefined,
  ) {
    this.name = name;
    this.context = context;
    this.#now = now;
    this.#startedAtMs = now();
    this.#exporter = exporter;
    this.#onExportFailure = onExportFailure;
    for (const [key, value] of Object.entries(attributes)) {
      if (value !== undefined) this.#attributes[key] = value;
    }
  }

  setAttribute(key: string, value: AttributeValue): void {
    if (this.#ended) return;
    this.#attributes[key] = value;
  }

  setStatus(status: SpanStatus, code?: string): void {
    if (this.#ended) return;
    this.#status = status;
    if (code !== undefined) this.#code = code;
  }

  end(): void {
    if (this.#ended) return;
    this.#ended = true;
    const endedAtMs = this.#now();
    const finished: FinishedSpan = {
      name: this.name,
      context: this.context,
      attributes: { ...this.#attributes },
      status: this.#status,
      ...(this.#code === undefined ? {} : { code: this.#code }),
      startedAtMs: this.#startedAtMs,
      endedAtMs,
      durationMs: endedAtMs - this.#startedAtMs,
    };
    try {
      this.#exporter?.export(finished);
    } catch {
      // The application never blocks on telemetry (monitoring.md §10).
      this.#onExportFailure?.();
    }
  }
}

export function createTracer(options: TracerOptions = {}): Tracer {
  const ids = options.ids ?? cryptoIdGenerator;
  const now = options.now ?? ((): number => Date.now());
  const sample = options.sampler ?? ((): boolean => true);

  function begin(
    name: string,
    attributes: SpanAttributes,
    traceId: string,
    parentSpanId: string | null,
    sampled: boolean,
  ): Span {
    const context: SpanContext = {
      traceId,
      spanId: ids.spanId(),
      parentSpanId,
      sampled,
    };
    return new BasicSpan(name, context, attributes, now, options.exporter, options.onExportFailure);
  }

  return {
    startSpan(name, attributes, parent = null): Span {
      if (parent) {
        // Sampling is head-based and decided once per trace — inherit it.
        return begin(name, attributes, parent.traceId, parent.spanId, parent.sampled);
      }
      return begin(name, attributes, ids.traceId(), null, sample(name, attributes));
    },

    startLinkedSpan(name, attributes, linkedTraceId): Span {
      const span = begin(name, attributes, ids.traceId(), null, sample(name, attributes));
      span.setAttribute('link.trace_id', linkedTraceId);
      return span;
    },

    extract(traceparent): SpanContext | null {
      return parseTraceparent(traceparent);
    },

    inject(context): string {
      return formatTraceparent(context);
    },
  };
}
