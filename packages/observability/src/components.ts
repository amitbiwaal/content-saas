/**
 * What the system observes, named once.
 *
 * ── Why a vocabulary and not free text ─────────────────────────────────────
 * `HealthMonitor` already takes dependency checks with a `name: string`, and
 * `LogRecord` already carries a `service`. Both work. What neither has is an
 * agreed set of names, so nothing stops the API service reporting Redis as
 * `'redis'` while the worker reports it as `'cache'` — two rows a dashboard
 * cannot join, and an alert that fires for one deployment and never for the
 * other.
 *
 * This is that set. It is the only thing this module adds: the checks, the
 * reports and the logger are unchanged.
 *
 * ── It names DEPENDENCIES, not modules ─────────────────────────────────────
 * The five the increment lists are the things outside the process that can be
 * down. `billing` is not here and neither is `content`: a domain module cannot
 * be unreachable, it can only be wrong, and putting one in a health report
 * would invite a check that ran business logic to decide.
 *
 * ── Nothing here reaches anything ──────────────────────────────────────────
 * These are strings. No client, no driver, no connection, no probe. Which
 * component a check talks to, and how, belongs to whoever composes the check —
 * `14-operations/monitoring.md` §9 already says a health check is read-only and
 * never repairs or reconnects, and a module that held a client could do both.
 */

/**
 * The external dependencies a deployment can be unhealthy because of.
 *
 * Ordered as an operator triages them: the store first, then the things that
 * move work, then the vendors.
 */
export const OBSERVED_COMPONENTS = [
  /** PostgreSQL. `ready` fails without it; nothing degrades gracefully. */
  'database',
  /** Cache and limiter state. A miss is slow, not wrong — usually `degraded`. */
  'redis',
  /** The work queue and its consumers. */
  'queue',
  /**
   * Model vendors, as a class rather than one entry each.
   *
   * `08-ai-platform/rate-limiting.md` treats provider health as reported by the
   * calls actually failing; a per-vendor component here would invite a probe on
   * a timer, which is a second source of truth about a vendor's health.
   */
  'ai_providers',
  /** The payment provider. Out of scope for `ready`: a provider outage must
   * never suspend a paying customer, so it is a `deep` concern. */
  'payment_provider',
] as const;

export type ObservedComponent = (typeof OBSERVED_COMPONENTS)[number];

export function isObservedComponent(value: unknown): value is ObservedComponent {
  return typeof value === 'string' && (OBSERVED_COMPONENTS as readonly string[]).includes(value);
}

/**
 * Whether a component's health belongs in `ready` or only in `deep`.
 *
 * `monitoring.md` §9: readiness covers what the process needs to serve a
 * request at all, and must not cascade. A remote vendor being slow is not a
 * reason to take a healthy pod out of rotation — which is exactly what
 * returning `unhealthy` from `ready` would do.
 */
export const READINESS_COMPONENTS: readonly ObservedComponent[] = Object.freeze([
  'database',
  'redis',
  'queue',
]);

export function isReadinessComponent(component: ObservedComponent): boolean {
  return READINESS_COMPONENTS.includes(component);
}
