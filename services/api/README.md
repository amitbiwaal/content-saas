# `services/api`

**Specified by** [`16-security/api-security.md`](../../contentos-docs/16-security/api-security.md) and [`14-operations/monitoring.md`](../../contentos-docs/14-operations/monitoring.md) §9.

The **only** inbound network surface. Adding a second would multiply the authentication, rate limiting, and validation pipeline that is specified once here.

## What this service owns

Platform middleware and health probes. **No business endpoints, no feature APIs, no provider SDKs, no business logic.**

## The pipeline order is a security property, not a style choice

```
request-id → logging → metrics → size-limit → rate-limit-pre-auth →
authentication → rate-limit-post-auth → csrf → validation → idempotency →
tenant-resolution → authorization → handler → output-filter → security-headers
```

Three placements are load-bearing:

**Size limits precede everything** — a 500 MB body must be rejected before it is buffered, parsed, or authenticated. A pipeline that authenticates first has already read the payload into memory.

**Rate limiting appears twice** — pre-auth by IP protects the authentication endpoints themselves (credential stuffing happens without valid credentials); post-auth by subject and tenant catches a compromised account. Either alone leaves a gap.

**Authorization is last, immediately before the handler** — it needs the _resolved resource_ to determine the tenant. Placing it earlier would force it to trust a client-supplied tenant.

`assertPipelineOrder()` runs at boot and fails the process on a reordering, naming the violated invariant and its reason.

## Other rules

**Short-circuiting is what makes the order a control** rather than a description. The runner stops at the first rejection and records which stages ran, so the ordering is asserted by test rather than by reading the source.

**`.strict()` is mandatory on every request schema.** Rejecting unknown keys makes mass-assignment structurally impossible — a client sending `tenantId`, `role`, or `credits` gets an error rather than silence.

**CSRF applies to cookie-authenticated mutations only.** A bearer request cannot be forged cross-site, so applying CSRF there would be ceremony that trains people to disable it.

**Never expose a stack trace, SQL error, provider internal, or secret.** An unrecognised failure becomes an opaque 500 carrying only the correlation id.

**All health logic lives in `@contentos/observability`.** This service maps reports to HTTP and nothing else. `degraded` is deliberately _ready_ — reduced capability is not inability to serve.

## Status

Framework-agnostic by construction. **ADR-003 selects NestJS**, and the NestJS binding is a thin adapter over these stages; it lands once dependencies are installable. That seam is why the controls are testable without booting an HTTP server.
