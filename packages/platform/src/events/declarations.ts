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
 * Every entry below declares `consumers: []`. Sprint 1's consumers are the two
 * cascades, and they arrive in T3.2 WITH their handlers — because composition
 * refuses to start a consumer process where a declared group has no handler.
 * Declaring a group early would break startup until the handler caught up,
 * which is the wrong order to fail in.
 */

import type { EventTypeDeclaration, RegistryContribution } from '@contentos/contracts';

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

function declare(
  eventType: string,
  producer: string,
  stream: string,
  tenantScope: 'workspace' | 'organization',
): EventTypeDeclaration {
  return {
    eventType,
    version: 1,
    state: 'active',
    stream,
    producer,
    tenantScope,
    consumers: [],
  };
}

/**
 * Organization-scoped: the aggregate is the organization, so `tenantId` is the
 * organization id (ADR-029). A consumer of these must NOT reconstruct workspace
 * tenant context from them.
 */
const ORGANIZATION_DECLARATIONS: readonly EventTypeDeclaration[] = ORGANIZATION_EVENT_TYPES.map(
  (eventType) => declare(eventType, ORGANIZATION_PRODUCER, ORGANIZATION_STREAM, 'organization'),
);

/** Organization-scoped for the same reason: the membership belongs to the organization. */
const ORGANIZATION_MEMBERSHIP_DECLARATIONS: readonly EventTypeDeclaration[] =
  ORGANIZATION_MEMBERSHIP_EVENT_TYPES.map((eventType) =>
    declare(eventType, MEMBERSHIP_PRODUCER, ORGANIZATION_STREAM, 'organization'),
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

export const PLATFORM_EVENT_DECLARATIONS: readonly EventTypeDeclaration[] = [
  ...ORGANIZATION_DECLARATIONS,
  ...ORGANIZATION_MEMBERSHIP_DECLARATIONS,
  ...WORKSPACE_DECLARATIONS,
  ...WORKSPACE_MEMBERSHIP_DECLARATIONS,
  ...SETTINGS_DECLARATIONS,
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
];

/** What a composition root includes to register this package's event types. */
export const PLATFORM_REGISTRY_CONTRIBUTION: RegistryContribution = {
  source: PLATFORM_REGISTRY_SOURCE,
  declarations: PLATFORM_EVENT_DECLARATIONS,
  emits: PLATFORM_EMITTABLE_EVENT_TYPES,
};
