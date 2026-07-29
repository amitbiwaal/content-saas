# `@contentos/observability`

**Specified by** [`14-operations/monitoring.md`](../../contentos-docs/14-operations/monitoring.md) and [`07-development-guide/logging-guide.md`](../../contentos-docs/07-development-guide/logging-guide.md).

## What this package owns

| Concern                                                            | Source of truth                 |
| ------------------------------------------------------------------ | ------------------------------- |
| Structured `Logger`, `LogRecord`, levels, child loggers            | `logging-guide.md`              |
| Three-layer redaction (`SecretValue`, allowlist, pattern backstop) | `logging-guide.md` §Redaction   |
| W3C trace context, spans, propagation                              | `monitoring.md` §3.2            |
| Counters, gauges, histograms, timers                               | `monitoring.md` §5.1            |
| `correlationId` and request-context propagation                    | `logging-guide.md` §Correlation |
| Liveness, readiness, deep health semantics                         | `monitoring.md` §9              |

## Rules that govern this package

**This is the only place instrumentation is configured.** Services import it rather than wiring OpenTelemetry individually — that is what makes the mandatory span attributes actually mandatory (`monitoring.md` §7).

**Abstractions only — no provider SDK.** Nothing here imports OpenTelemetry, Prometheus, or Sentry. "OpenTelemetry compatible" is satisfied on the wire by W3C Trace Context; an exporter binds at the process edge.

**`tenantId` is a log and span field, never a metric label.** Per-tenant cardinality would multiply every time series by the customer count. `MetricLabels` makes it a **compile error**, and `assertLabelsAllowed` is the runtime backstop.

**No interpolation.** `Logger` accepts a structured record and has no `log(level, message)` and no variadic form, so an interpolated string cannot be passed.

**`error` requires a `code`,** enforced by type — an error without a stable code cannot be aggregated or alerted on.

**Telemetry never blocks the application.** A throwing sink or exporter is swallowed and counted; log delivery failure never propagates.

**Readiness must not cascade.** `LocalDependencyCheck` and `RemoteDependencyCheck` are separate types, so a provider check cannot be registered as a readiness check — a readiness probe that calls a provider turns a provider outage into a full platform outage.

## Boundary

Core package. May import `contracts` and other core packages; never a feature package, a service, or an app. Contains no business logic, no database access, and no API layer — the health _endpoints_ belong to `services/api`.
