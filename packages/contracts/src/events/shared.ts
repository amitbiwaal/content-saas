/**
 * Shared types declared canonically in `13-event-platform/event-apis.md`
 * §"Shared types — declared here" (drift item D-8: ten types were referenced
 * across Phase 8 and declared nowhere).
 *
 * These live in `contracts` because every layer needs them and `contracts` has
 * zero dependencies (`07-development-guide/project-structure.md` rule 3).
 */

/** OPAQUE — transport-specific, never persisted by a consumer (event-apis.md rule 10). */
export type BusEntryId = string;

/** Opaque stream position for replay-from cursors. */
export type BusPosition = string;

/** Opaque lease handle for (group, aggregateId). */
export type BarrierToken = string;

/**
 * The ORM transaction handle. Drizzle's transaction type (ADR-022).
 * Passed by reference; never constructed by the Event Platform.
 *
 * Declared structurally here so that `contracts` acquires no dependency on
 * `packages/database` — one such dependency would pull Drizzle into the
 * browser bundle (`project-structure.md` rule 3).
 *
 * ADR-022 is still Proposed. The working assumption is recorded in
 * `01-system-architecture/99-open-questions.md`.
 */
export interface Transaction {
  readonly __brand: 'Transaction';
}

/**
 * Tenant context. `source` is readonly and discriminated so context
 * reconstructed from an event is distinguishable from request-derived context
 * in audit and diagnostics. Consumers always receive `'event'`.
 *
 * `16-security/tenant-isolation.md` — TenantContext is immutable, and tenant is
 * never inferred from a request payload.
 */
export interface TenantContext {
  readonly tenantId: string;
  readonly organizationId: string;
  readonly source: 'event' | 'request';
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

export interface JobContext {
  readonly jobName: string;
  readonly windowStartedAt: Date;
  readonly attempt: number;
}

export interface WorkerHealth {
  readonly status: 'starting' | 'ready' | 'draining' | 'unhealthy';
  readonly hostedGroups: readonly string[];
  readonly inFlight: number;
  readonly lastHeartbeatAt: Date;
}

export type ReplayAttemptOutcome =
  | { readonly outcome: 'delivered' }
  | { readonly outcome: 'suppressed-duplicate' }
  | { readonly outcome: 'failed'; readonly code: string; readonly message: string };
