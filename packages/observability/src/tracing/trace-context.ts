/**
 * Trace context — W3C Trace Context, which is what "OpenTelemetry compatible"
 * means on the wire.
 *
 * NO OpenTelemetry SDK is imported. This package defines the abstraction; an
 * adapter binds it to a real exporter at the process edge. That is what lets
 * the platform change trace backends without touching instrumented code
 * (`14-operations/monitoring.md` §7).
 */

import { randomBytes } from 'node:crypto';

/** 16 bytes, 32 lowercase hex. Never all zeroes. */
export type TraceId = string;
/** 8 bytes, 16 lowercase hex. Never all zeroes. */
export type SpanId = string;

export const INVALID_TRACE_ID = '0'.repeat(32);
export const INVALID_SPAN_ID = '0'.repeat(16);

export interface SpanContext {
  readonly traceId: TraceId;
  readonly spanId: SpanId;
  readonly parentSpanId: SpanId | null;
  /** W3C sampled flag. Head-based, decided once per trace. */
  readonly sampled: boolean;
}

export interface IdGenerator {
  traceId(): TraceId;
  spanId(): SpanId;
}

/** Injectable so tests are deterministic; crypto-backed by default. */
export const cryptoIdGenerator: IdGenerator = {
  traceId(): TraceId {
    return randomBytes(16).toString('hex');
  },
  spanId(): SpanId {
    return randomBytes(8).toString('hex');
  },
};

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

export function isValidTraceId(value: string): boolean {
  return /^[0-9a-f]{32}$/.test(value) && value !== INVALID_TRACE_ID;
}

export function isValidSpanId(value: string): boolean {
  return /^[0-9a-f]{16}$/.test(value) && value !== INVALID_SPAN_ID;
}

/**
 * Format a `traceparent` header — version 00.
 *
 *   00-<trace-id>-<parent-id>-<flags>
 */
export function formatTraceparent(context: SpanContext): string {
  const flags = context.sampled ? '01' : '00';
  return `00-${context.traceId}-${context.spanId}-${flags}`;
}

/**
 * Parse a `traceparent` header. Returns null on anything malformed — an
 * unparseable header starts a new trace rather than propagating a broken one.
 */
export function parseTraceparent(header: string | undefined | null): SpanContext | null {
  if (typeof header !== 'string') return null;
  const match = TRACEPARENT.exec(header.trim());
  if (match === null) return null;

  const [, traceId, spanId, flags] = match;
  if (traceId === undefined || spanId === undefined || flags === undefined) return null;
  if (!isValidTraceId(traceId) || !isValidSpanId(spanId)) return null;

  return {
    traceId,
    spanId,
    parentSpanId: null,
    sampled: (Number.parseInt(flags, 16) & 0x01) === 0x01,
  };
}
