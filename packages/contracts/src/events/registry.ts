/**
 * Event registry declarations — the source-controlled description of every
 * event type the platform may publish.
 *
 * Spec: `13-event-platform/event-registry.md`. The registry "is
 * SOURCE-CONTROLLED and loaded at startup. It is not a runtime table: an event
 * type that can be added at runtime is one that can be added without review,
 * and the payload rules exist precisely to be reviewed."
 *
 * ── Why these types live in `contracts` ─────────────────────────────────────
 * A declaration is made by the PRODUCING package, next to the builders that
 * emit the type — that is the only place it will reliably be maintained. But
 * `packages/platform` and `packages/events` are both feature-tier and may not
 * import each other (`07-development-guide/project-structure.md` rule 4), so
 * the shape has to live below both. `contracts` already owns `DomainEvent` and
 * `EventPublisher` for exactly this reason.
 *
 * `packages/events` owns the ENGINE that consumes these — validation,
 * versioning, transformation — and re-exports the types so existing importers
 * are unaffected.
 */

/**
 * Which isolation scope an event's `tenantId` refers to — ADR-029.
 *
 * `tenantId` is the isolation scope OF THE AGGREGATE: the workspace for a
 * workspace-owned aggregate, the organization for an organization-owned one.
 * Both are "the tightest scope that owns the row", and the envelope cannot
 * distinguish them because it is frozen and carries one UUID either way.
 *
 * DECLARING IT IS THEREFORE MANDATORY AND IS NEVER INFERRED. The hazard this
 * closes is specific and silent: `13-event-platform/consumer-groups.md` shows
 * consumers reconstructing context with `TenantContext.fromEvent(event)`. Do
 * that with an organization-scoped event and `app.tenant_id` becomes an
 * organization id — every workspace-owned table then matches ZERO rows, and
 * nothing throws.
 */
export type EventTenantScope = 'workspace' | 'organization';

export const EVENT_TENANT_SCOPES: readonly EventTenantScope[] = ['workspace', 'organization'];

export function isEventTenantScope(value: unknown): value is EventTenantScope {
  return typeof value === 'string' && (EVENT_TENANT_SCOPES as readonly string[]).includes(value);
}

export type Criticality = 'standard' | 'critical';
export type UnknownVersionPolicy = 'transform' | 'dead-letter';
export type VersionState = 'active' | 'deprecated' | 'retired';

export interface ConsumerDeclaration {
  readonly consumerGroup: string;
  readonly component: string;
  /** The GROUP's set — more than one element only during a migration window. */
  readonly versions: readonly number[];
  readonly criticality: Criticality;
  readonly handlerIdempotencyKey: string;
  readonly onUnknownVersion: UnknownVersionPolicy;
}

export interface EventTypeDeclaration {
  readonly eventType: string;
  readonly version: number;
  readonly state: VersionState;
  /** Redis stream this type is appended to. */
  readonly stream: string;
  /**
   * The component that publishes it, matching the envelope's `producer`.
   *
   * Declared so that two packages claiming the same event type is a startup
   * failure rather than whichever one loaded last.
   */
  readonly producer: string;
  /** ADR-029. Mandatory; never inferred. */
  readonly tenantScope: EventTenantScope;
  readonly consumers: readonly ConsumerDeclaration[];
  /** Transform from this version to version + 1. Absent on the newest version. */
  readonly upcast?: (payload: unknown) => unknown;
}

/**
 * One package's contribution to the process registry.
 *
 * `emits` is the set of event types the package's builders can actually
 * produce. Validation asserts it is a subset of `declarations`, which is the
 * check that catches the failure this increment exists to fix: a builder that
 * ships without a declaration and cannot publish.
 */
export interface RegistryContribution {
  /** The contributing package, used in diagnostics and duplicate detection. */
  readonly source: string;
  readonly declarations: readonly EventTypeDeclaration[];
  readonly emits: readonly string[];
}
