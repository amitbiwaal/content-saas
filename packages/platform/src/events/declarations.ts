/**
 * The Platform Layer's event registry declarations.
 *
 * Spec: `13-event-platform/event-registry.md` — source-controlled, loaded at
 * startup, never a runtime table.
 *
 * ── Why they live here and not in `packages/events` ─────────────────────────
 * Declaring an event type is a statement by the package that PRODUCES it, and
 * it belongs beside the builders that emit it — that is the only place it will
 * be kept in step. `packages/events` owns the engine that consumes these; the
 * shapes live in `contracts` because two feature packages may not import each
 * other.
 *
 * `PLATFORM_EMITTABLE_EVENT_TYPES` is derived from the SAME constants the
 * builders use, so composition can prove that every type this package can emit
 * is declared. That check is the one that would have caught Sprint 1 shipping
 * nineteen event types with no declarations at all.
 *
 * ── Consumers are declared with their handlers, not before ──────────────────
 * Composition refuses to start a consumer process where a declared group has
 * no handler, so a group is declared in the same increment that supplies its
 * handler. T3.1 declared none; T3.2 adds the two cascade groups below, and the
 * handlers for them land in `workers/host` at the same time.
 */

import type {
  ConsumerDeclaration,
  EventTypeDeclaration,
  RegistryContribution,
} from '@contentos/contracts';

import { CREDIT_EVENT_TYPES, CREDIT_PRODUCER } from '../credits/events.js';
import {
  MEMBERSHIP_PRODUCER,
  ORGANIZATION_MEMBERSHIP_EVENT_TYPES,
  WORKSPACE_MEMBERSHIP_EVENT_TYPES,
} from '../memberships/events.js';
import { ORGANIZATION_EVENT_TYPES, ORGANIZATION_PRODUCER } from '../organizations/events.js';
import { WORKSPACE_SETTINGS_UPDATED } from '../settings/events.js';
import { WORKSPACE_EVENT_TYPES, WORKSPACE_PRODUCER } from '../workspaces/events.js';

/** This package identifies itself in diagnostics and collision detection. */
export const PLATFORM_REGISTRY_SOURCE = '@contentos/platform';

/**
 * Streams.
 *
 * One per aggregate family rather than one per type: ordering is per
 * `aggregateId` (`event-apis.md` rule 4), so splitting a family across streams
 * buys nothing and multiplies consumer-group bookkeeping.
 */
export const ORGANIZATION_STREAM = 'organization';
export const WORKSPACE_STREAM = 'workspace';

/**
 * The credit account is its own family, not part of `organization`.
 *
 * It shares the organization as `aggregateId`, but a ledger at 10⁹ entries with
 * a `CreditConsumed` per AI call would set the consumer lag and retention of
 * every organization lifecycle event to whatever the highest-volume stream on
 * the platform can sustain (`04-platform/credits.md` §Performance).
 */
export const CREDIT_STREAM = 'credit';

/**
 * The two cascade consumer groups.
 *
 * ── Why suspension and reactivation share ONE group ─────────────────────────
 * They are the same aggregate's ordered lifecycle: both carry the organization
 * as `aggregateId`, and the aggregate barrier orders a group's deliveries per
 * aggregate. Split across two groups they would advance independently, and a
 * lagging suspension could be applied AFTER the reactivation that was meant to
 * undo it — leaving every workspace suspended with nothing left to reactivate
 * them. One group makes that unrepresentable.
 *
 * ── Why membership revocation is separate ───────────────────────────────────
 * Its aggregate is the membership, not the organization, so it shares no
 * ordering constraint with the lifecycle events. Keeping it apart also keeps
 * its lag and DLQ depth separately observable, and the two page for different
 * reasons: a stalled membership revocation is a stale-permission security
 * issue, a stalled suspension is a revenue-integrity one.
 */
export const ORGANIZATION_LIFECYCLE_CASCADE_GROUP = 'organization-lifecycle-cascade';
export const ORGANIZATION_MEMBERSHIP_CASCADE_GROUP = 'organization-membership-cascade';

/** The component hosting both groups — the single worker binary. */
const CASCADE_COMPONENT = 'workers.host.cascade';

function cascadeConsumer(consumerGroup: string): ConsumerDeclaration {
  return {
    consumerGroup,
    component: CASCADE_COMPONENT,
    versions: [1],
    // Both cascades page on a DLQ entry: an active workspace under a suspended
    // organization is a revenue-integrity failure, and a member who kept access
    // after revocation is a security one.
    criticality: 'critical',
    handlerIdempotencyKey: consumerGroup,
    onUnknownVersion: 'dead-letter',
  };
}

function declare(
  eventType: string,
  producer: string,
  stream: string,
  tenantScope: 'workspace' | 'organization',
  consumers: readonly ConsumerDeclaration[] = [],
): EventTypeDeclaration {
  return {
    eventType,
    version: 1,
    state: 'active',
    stream,
    producer,
    tenantScope,
    consumers,
  };
}

/** Which cascade group, if any, consumes a given organization-scoped type. */
const CASCADE_CONSUMERS: Readonly<Record<string, readonly ConsumerDeclaration[]>> = {
  OrganizationSuspended: [cascadeConsumer(ORGANIZATION_LIFECYCLE_CASCADE_GROUP)],
  OrganizationReactivated: [cascadeConsumer(ORGANIZATION_LIFECYCLE_CASCADE_GROUP)],
  OrgMembershipRevoked: [cascadeConsumer(ORGANIZATION_MEMBERSHIP_CASCADE_GROUP)],
};

/**
 * Organization-scoped: the aggregate is the organization, so `tenantId` is the
 * organization id (ADR-029). A consumer of these must NOT reconstruct workspace
 * tenant context from them.
 */
const ORGANIZATION_DECLARATIONS: readonly EventTypeDeclaration[] = ORGANIZATION_EVENT_TYPES.map(
  (eventType) =>
    declare(
      eventType,
      ORGANIZATION_PRODUCER,
      ORGANIZATION_STREAM,
      'organization',
      CASCADE_CONSUMERS[eventType],
    ),
);

/** Organization-scoped for the same reason: the membership belongs to the organization. */
const ORGANIZATION_MEMBERSHIP_DECLARATIONS: readonly EventTypeDeclaration[] =
  ORGANIZATION_MEMBERSHIP_EVENT_TYPES.map((eventType) =>
    declare(
      eventType,
      MEMBERSHIP_PRODUCER,
      ORGANIZATION_STREAM,
      'organization',
      CASCADE_CONSUMERS[eventType],
    ),
  );

/** Workspace-scoped: `workspaces.id` IS `tenant_id` (ADR-017). */
const WORKSPACE_DECLARATIONS: readonly EventTypeDeclaration[] = WORKSPACE_EVENT_TYPES.map(
  (eventType) => declare(eventType, WORKSPACE_PRODUCER, WORKSPACE_STREAM, 'workspace'),
);

const WORKSPACE_MEMBERSHIP_DECLARATIONS: readonly EventTypeDeclaration[] =
  WORKSPACE_MEMBERSHIP_EVENT_TYPES.map((eventType) =>
    declare(eventType, MEMBERSHIP_PRODUCER, WORKSPACE_STREAM, 'workspace'),
  );

const SETTINGS_DECLARATIONS: readonly EventTypeDeclaration[] = [
  declare(WORKSPACE_SETTINGS_UPDATED, WORKSPACE_PRODUCER, WORKSPACE_STREAM, 'workspace'),
];

/**
 * Organization-scoped: balance resolves per organization, so the credit account
 * is an organization-owned aggregate and `tenantId` is the organization id
 * (ADR-029). `CreditConsumed` names a workspace in its PAYLOAD for attribution
 * — a consumer must not mistake that for the tenant scope and rebuild workspace
 * context from it.
 *
 * No consumers yet: the balance read model and cost monitoring are the declared
 * consumers in `04-platform/credits.md`, and neither exists. Composition refuses
 * to start a group with no handler, so a group is declared in the increment that
 * supplies its handler.
 */
const CREDIT_DECLARATIONS: readonly EventTypeDeclaration[] = CREDIT_EVENT_TYPES.map((eventType) =>
  declare(eventType, CREDIT_PRODUCER, CREDIT_STREAM, 'organization'),
);

export const PLATFORM_EVENT_DECLARATIONS: readonly EventTypeDeclaration[] = [
  ...ORGANIZATION_DECLARATIONS,
  ...ORGANIZATION_MEMBERSHIP_DECLARATIONS,
  ...WORKSPACE_DECLARATIONS,
  ...WORKSPACE_MEMBERSHIP_DECLARATIONS,
  ...SETTINGS_DECLARATIONS,
  ...CREDIT_DECLARATIONS,
];

/**
 * Every event type this package's builders can produce.
 *
 * Derived from the builders' own constants rather than re-listed, so a new
 * event type cannot be added to a builder without appearing here — and
 * composition then fails until it is declared.
 */
export const PLATFORM_EMITTABLE_EVENT_TYPES: readonly string[] = [
  ...ORGANIZATION_EVENT_TYPES,
  ...ORGANIZATION_MEMBERSHIP_EVENT_TYPES,
  ...WORKSPACE_EVENT_TYPES,
  ...WORKSPACE_MEMBERSHIP_EVENT_TYPES,
  WORKSPACE_SETTINGS_UPDATED,
  ...CREDIT_EVENT_TYPES,
];

/** What a composition root includes to register this package's event types. */
export const PLATFORM_REGISTRY_CONTRIBUTION: RegistryContribution = {
  source: PLATFORM_REGISTRY_SOURCE,
  declarations: PLATFORM_EVENT_DECLARATIONS,
  emits: PLATFORM_EMITTABLE_EVENT_TYPES,
};
