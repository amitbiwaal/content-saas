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
import { FEATURE_FLAG_EVENT_TYPES, FEATURE_FLAG_PRODUCER } from '../flags/events.js';
import { CREDIT_HOLD_EVENT_TYPES, CREDIT_THRESHOLD_EVENT_TYPES } from '../credits/hold-events.js';
import {
  MEMBERSHIP_PRODUCER,
  ORGANIZATION_MEMBERSHIP_EVENT_TYPES,
  WORKSPACE_MEMBERSHIP_EVENT_TYPES,
} from '../memberships/events.js';
import { ORGANIZATION_EVENT_TYPES, ORGANIZATION_PRODUCER } from '../organizations/events.js';
import { WORKSPACE_SETTINGS_UPDATED } from '../settings/events.js';
import { SETTINGS_EVENT_TYPES, SETTINGS_PRODUCER } from '../settings/resolution-events.js';
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
 * The settings tree is its own family too.
 *
 * Low volume and organization-aggregated, but kept off the `organization`
 * stream because its consumers are different: a settings change matters to
 * every engine holding a resolved policy, and none of them cares about
 * organization lifecycle. Sharing a stream would make each read past the
 * other's traffic.
 */
export const SETTINGS_STREAM = 'settings';

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

/**
 * The two credit hold-release groups.
 *
 * Separate from the cascade groups, and separate from each other, because they
 * read DIFFERENT STREAMS: an organization suspension arrives on `organization`
 * and a workspace suspension on `workspace`. One group cannot read both, and
 * merging them would mean one of the two events never being delivered — a group
 * that starts cleanly, heartbeats healthily and silently leaves credits
 * reserved against a suspended customer.
 *
 * Separate from the cascade groups because their failure means something
 * different: a stalled cascade leaves stale permissions, a stalled hold release
 * leaves a suspended customer's balance reserved against runs that will never
 * happen.
 */
export const CREDITS_ORGANIZATION_RELEASE_GROUP = 'credits-organization-hold-release';
export const CREDITS_WORKSPACE_RELEASE_GROUP = 'credits-workspace-hold-release';

/**
 * The two notification groups.
 *
 * Two because they read different streams — the credit thresholds are on
 * `credit`, the settings and flag changes on `settings` — and a consumer group
 * reads one stream. Separate from every other group because their failure means
 * something different again: nobody was told.
 */
export const NOTIFICATIONS_BILLING_GROUP = 'notifications-billing';
export const NOTIFICATIONS_PLATFORM_GROUP = 'notifications-platform';

/** The component hosting both cascade groups — the single worker binary. */
const CASCADE_COMPONENT = 'workers.host.cascade';
/** The credits groups, hosted by the same binary but separately observable. */
const CREDITS_COMPONENT = 'workers.host.credits';
/** The notification groups, separately observable from the rest. */
const NOTIFICATIONS_COMPONENT = 'workers.host.notifications';

function consumer(consumerGroup: string, component: string): ConsumerDeclaration {
  return {
    consumerGroup,
    component,
    versions: [1],
    // Every one of these pages on a DLQ entry: an active workspace under a
    // suspended organization is a revenue-integrity failure, a member who kept
    // access after revocation is a security one, and a hold left open against a
    // suspended customer is money reserved for work that will never run.
    criticality: 'critical',
    handlerIdempotencyKey: consumerGroup,
    onUnknownVersion: 'dead-letter',
  };
}

const cascadeConsumer = (group: string): ConsumerDeclaration => consumer(group, CASCADE_COMPONENT);
const creditsConsumer = (group: string): ConsumerDeclaration => consumer(group, CREDITS_COMPONENT);
const notificationsConsumer = (group: string): ConsumerDeclaration =>
  consumer(group, NOTIFICATIONS_COMPONENT);

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

/**
 * Which groups consume a given type.
 *
 * `OrganizationSuspended` now has two, and they are deliberately independent:
 * the workspace cascade and the hold release neither depend on nor block each
 * other, so one failing must not stop the other. Separate groups is what makes
 * that true — a shared group would retry both when either failed.
 */
const CONSUMERS_BY_TYPE: Readonly<Record<string, readonly ConsumerDeclaration[]>> = {
  OrganizationSuspended: [
    cascadeConsumer(ORGANIZATION_LIFECYCLE_CASCADE_GROUP),
    creditsConsumer(CREDITS_ORGANIZATION_RELEASE_GROUP),
  ],
  OrganizationReactivated: [cascadeConsumer(ORGANIZATION_LIFECYCLE_CASCADE_GROUP)],
  OrgMembershipRevoked: [cascadeConsumer(ORGANIZATION_MEMBERSHIP_CASCADE_GROUP)],
  WorkspaceSuspended: [creditsConsumer(CREDITS_WORKSPACE_RELEASE_GROUP)],
  // T3.8 — notification records only. Adding a consumer to a type does not
  // touch the service that PRODUCES it: Credits, Settings and Feature Flags are
  // unchanged, and none of them knows a notification exists.
  CreditsLow: [notificationsConsumer(NOTIFICATIONS_BILLING_GROUP)],
  CreditsExhausted: [notificationsConsumer(NOTIFICATIONS_BILLING_GROUP)],
  SettingsChanged: [notificationsConsumer(NOTIFICATIONS_PLATFORM_GROUP)],
  FeatureFlagChanged: [notificationsConsumer(NOTIFICATIONS_PLATFORM_GROUP)],
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
      CONSUMERS_BY_TYPE[eventType],
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
      CONSUMERS_BY_TYPE[eventType],
    ),
  );

/** Workspace-scoped: `workspaces.id` IS `tenant_id` (ADR-017). */
const WORKSPACE_DECLARATIONS: readonly EventTypeDeclaration[] = WORKSPACE_EVENT_TYPES.map(
  (eventType) =>
    declare(
      eventType,
      WORKSPACE_PRODUCER,
      WORKSPACE_STREAM,
      'workspace',
      CONSUMERS_BY_TYPE[eventType],
    ),
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
const CREDIT_DECLARATIONS: readonly EventTypeDeclaration[] = [
  ...CREDIT_EVENT_TYPES,
  // T3.4 left these undeclared because nothing could emit them. The hold
  // protocol and the balance engine exist as of T3.5, so they are declared with
  // the service that emits them.
  ...CREDIT_HOLD_EVENT_TYPES,
  ...CREDIT_THRESHOLD_EVENT_TYPES,
].map((eventType) =>
  declare(eventType, CREDIT_PRODUCER, CREDIT_STREAM, 'organization', CONSUMERS_BY_TYPE[eventType]),
);

/**
 * Organization-scoped: the settings tree belongs to the organization (ADR-029),
 * so an organization-layer change and a workspace-layer change beneath it stay
 * ordered against each other. `scopeId` in the payload names the workspace for
 * attribution; a consumer must not rebuild workspace tenant context from it.
 *
 * T3.8 subscribes the platform notification group. The Settings Resolver is
 * unchanged by that: a consumer is declared against the TYPE, and the service
 * that emits it does not know a consumer exists.
 */
const SETTINGS_RESOLUTION_DECLARATIONS: readonly EventTypeDeclaration[] = SETTINGS_EVENT_TYPES.map(
  (eventType) =>
    declare(
      eventType,
      SETTINGS_PRODUCER,
      SETTINGS_STREAM,
      'organization',
      CONSUMERS_BY_TYPE[eventType],
    ),
);

/**
 * On the SETTINGS stream, not one of its own.
 *
 * A flag override and a setting live in the same JSONB column and advance the
 * same version, so a consumer that cares about one cares about the other. A
 * separate stream would make each read past the other's traffic to find the
 * invalidation it needed.
 *
 * T3.8 subscribes the platform notification group here too, for the same
 * reason: one group reads one stream, and both types are on this one.
 */
const FEATURE_FLAG_DECLARATIONS: readonly EventTypeDeclaration[] = FEATURE_FLAG_EVENT_TYPES.map(
  (eventType) =>
    declare(
      eventType,
      FEATURE_FLAG_PRODUCER,
      SETTINGS_STREAM,
      'organization',
      CONSUMERS_BY_TYPE[eventType],
    ),
);

export const PLATFORM_EVENT_DECLARATIONS: readonly EventTypeDeclaration[] = [
  ...ORGANIZATION_DECLARATIONS,
  ...ORGANIZATION_MEMBERSHIP_DECLARATIONS,
  ...WORKSPACE_DECLARATIONS,
  ...WORKSPACE_MEMBERSHIP_DECLARATIONS,
  ...SETTINGS_DECLARATIONS,
  ...CREDIT_DECLARATIONS,
  ...SETTINGS_RESOLUTION_DECLARATIONS,
  ...FEATURE_FLAG_DECLARATIONS,
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
  ...CREDIT_HOLD_EVENT_TYPES,
  ...CREDIT_THRESHOLD_EVENT_TYPES,
  ...SETTINGS_EVENT_TYPES,
  ...FEATURE_FLAG_EVENT_TYPES,
];

/** What a composition root includes to register this package's event types. */
export const PLATFORM_REGISTRY_CONTRIBUTION: RegistryContribution = {
  source: PLATFORM_REGISTRY_SOURCE,
  declarations: PLATFORM_EVENT_DECLARATIONS,
  emits: PLATFORM_EMITTABLE_EVENT_TYPES,
};
