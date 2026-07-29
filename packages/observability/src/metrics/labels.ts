/**
 * Metric label discipline — `14-operations/monitoring.md` §3 principle 3 and
 * `07-development-guide/logging-guide.md` rule 4.
 *
 *   "Traces and logs carry tenant_id; metrics do not."
 *   "tenantId is a log field, never a metric label."
 *
 * Per-tenant cardinality would multiply every time series by the customer
 * count, and the metrics store would cost more than the platform.
 *
 * This module makes that a COMPILE ERROR rather than a review rule.
 */

/**
 * Identifiers that must never become a metric dimension. Both casings are
 * listed because the platform writes camelCase in code and snake_case on the
 * wire.
 */
export const FORBIDDEN_METRIC_LABELS = [
  'tenantId',
  'tenant_id',
  'organizationId',
  'organization_id',
  'workspaceId',
  'workspace_id',
  'userId',
  'user_id',
  'actorId',
  'actor_id',
  'correlationId',
  'correlation_id',
  'requestId',
  'request_id',
  'articleId',
  'article_id',
  'runId',
  'run_id',
  'email',
  'url',
  'path',
] as const;

export type ForbiddenMetricLabel = (typeof FORBIDDEN_METRIC_LABELS)[number];

/**
 * Metric labels, with unbounded-cardinality identifiers made unrepresentable.
 *
 *   counter.inc({ outcome: 'success' })      // fine
 *   counter.inc({ tenant_id: 'ws-1' })       // TYPE ERROR
 *
 * `?: never` is what produces the error: the key may be present only if its
 * value is `never`, which nothing satisfies.
 */
export type MetricLabels = { readonly [key: string]: string } & {
  readonly [K in ForbiddenMetricLabel]?: never;
};

const FORBIDDEN = new Set<string>(FORBIDDEN_METRIC_LABELS);

/**
 * Runtime guard — defence in depth for labels built dynamically, where the type
 * cannot see the keys.
 */
export function assertLabelsAllowed(labels: Readonly<Record<string, string>>): void {
  for (const key of Object.keys(labels)) {
    if (FORBIDDEN.has(key)) {
      throw new Error(
        `Forbidden metric label '${key}'. Tenant and request identifiers are carried on logs and traces, never as metric labels — 14-operations/monitoring.md §3.`,
      );
    }
  }
}

/** Stable key for a label set, so the same labels always address the same series. */
export function labelKey(labels: Readonly<Record<string, string>>): string {
  const keys = Object.keys(labels).sort();
  return keys.map((k) => `${k}=${labels[k] ?? ''}`).join(',');
}
