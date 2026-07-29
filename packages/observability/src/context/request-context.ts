/**
 * Request context and correlation.
 *
 * `correlationId` "groups everything caused by one request" and is the pivot
 * the whole platform is built around: logs, traces, and audit records share it,
 * which is what makes a single query reconstruct an incident across all three
 * (`07-development-guide/logging-guide.md` §"Correlation across boundaries").
 *
 * Propagation uses `AsyncLocalStorage` so the context follows async work
 * without being threaded through every signature and dropped on one.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

import type { SpanContext } from '../tracing/trace-context.js';

export interface RequestContext {
  /** Groups everything caused by one request. Crosses the async boundary in the event envelope. */
  readonly correlationId: string;
  /** Workspace — ADR-017. Carried on logs and traces, never as a metric label. */
  readonly tenantId?: string;
  readonly organizationId?: string;
  readonly actorId?: string;
  readonly requestId?: string;
  readonly span?: SpanContext;
  /**
   * Where the context came from. Mirrors `TenantContext.source` in
   * `@contentos/contracts` so a context reconstructed from an event is
   * distinguishable from a request-derived one in audit and diagnostics.
   */
  readonly source: 'request' | 'event' | 'job';
}

const storage = new AsyncLocalStorage<RequestContext>();

export function newCorrelationId(): string {
  return randomUUID();
}

/** Run `fn` with `context` bound for the whole async subtree. */
export function runWithContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

/** The active context, or undefined outside any scope. */
export function currentContext(): RequestContext | undefined {
  return storage.getStore();
}

/**
 * Derive a child context, preserving `correlationId`.
 *
 * The correlation id is deliberately NOT overridable: a child that could
 * replace it would silently break the chain that an incident query depends on.
 */
export function withContext(
  overrides: Omit<Partial<RequestContext>, 'correlationId'>,
): RequestContext {
  const current = currentContext();
  const base: RequestContext = current ?? {
    correlationId: newCorrelationId(),
    source: 'job',
  };
  return { ...base, ...overrides, correlationId: base.correlationId };
}

/** The bindings a logger should carry for this context. */
export function contextBindings(context: RequestContext): Record<string, string> {
  const out: Record<string, string> = { correlationId: context.correlationId };
  if (context.tenantId !== undefined) out['tenantId'] = context.tenantId;
  if (context.organizationId !== undefined) out['organizationId'] = context.organizationId;
  if (context.actorId !== undefined) out['actorId'] = context.actorId;
  if (context.requestId !== undefined) out['requestId'] = context.requestId;
  if (context.span !== undefined) {
    out['traceId'] = context.span.traceId;
    out['spanId'] = context.span.spanId;
  }
  return out;
}
