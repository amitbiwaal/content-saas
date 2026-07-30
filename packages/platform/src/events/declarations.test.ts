/**
 * The Platform Layer's declarations.
 *
 * The load-bearing assertion is coverage: every event type this package can
 * emit must be declared, derived from the builders' own constants rather than
 * a list written twice. Sprint 1 shipped nineteen event types with no
 * declarations at all, and nothing failed — this is the test that would have.
 */
import { describe, expect, it } from 'vitest';

import {
  MEMBERSHIP_PRODUCER,
  ORGANIZATION_MEMBERSHIP_EVENT_TYPES,
  WORKSPACE_MEMBERSHIP_EVENT_TYPES,
} from '../memberships/events.js';
import { ORGANIZATION_EVENT_TYPES, ORGANIZATION_PRODUCER } from '../organizations/events.js';
import { WORKSPACE_SETTINGS_UPDATED } from '../settings/events.js';
import { WORKSPACE_EVENT_TYPES, WORKSPACE_PRODUCER } from '../workspaces/events.js';
import {
  ORGANIZATION_LIFECYCLE_CASCADE_GROUP,
  ORGANIZATION_MEMBERSHIP_CASCADE_GROUP,
  ORGANIZATION_STREAM,
  PLATFORM_EMITTABLE_EVENT_TYPES,
  PLATFORM_EVENT_DECLARATIONS,
  PLATFORM_REGISTRY_CONTRIBUTION,
  WORKSPACE_STREAM,
} from './declarations.js';

const byType = new Map(PLATFORM_EVENT_DECLARATIONS.map((d) => [d.eventType, d]));

describe('coverage — every emittable type is declared', () => {
  it('declares every event type the package can emit', () => {
    for (const eventType of PLATFORM_EMITTABLE_EVENT_TYPES) {
      expect(byType.has(eventType), eventType).toBe(true);
    }
  });

  it('declares nothing it cannot emit', () => {
    for (const declaration of PLATFORM_EVENT_DECLARATIONS) {
      expect(PLATFORM_EMITTABLE_EVENT_TYPES, declaration.eventType).toContain(
        declaration.eventType,
      );
    }
  });

  it('covers all nineteen Sprint 1 event types', () => {
    expect(PLATFORM_EVENT_DECLARATIONS).toHaveLength(19);
    expect(PLATFORM_EMITTABLE_EVENT_TYPES).toHaveLength(19);
    expect(new Set(PLATFORM_EMITTABLE_EVENT_TYPES).size).toBe(19);
  });

  it('exposes a contribution a composition root can register directly', () => {
    expect(PLATFORM_REGISTRY_CONTRIBUTION.declarations).toBe(PLATFORM_EVENT_DECLARATIONS);
    expect(PLATFORM_REGISTRY_CONTRIBUTION.emits).toBe(PLATFORM_EMITTABLE_EVENT_TYPES);
    expect(PLATFORM_REGISTRY_CONTRIBUTION.source).toBe('@contentos/platform');
  });
});

describe('tenant scope — ADR-029, declared per type', () => {
  // The organization is the aggregate, so tenantId is the organization id. A
  // consumer must not reconstruct workspace context from these.
  it('scopes organization and org-membership events to the organization', () => {
    for (const eventType of [...ORGANIZATION_EVENT_TYPES, ...ORGANIZATION_MEMBERSHIP_EVENT_TYPES]) {
      expect(byType.get(eventType)?.tenantScope, eventType).toBe('organization');
    }
  });

  // workspaces.id IS tenant_id (ADR-017).
  it('scopes workspace, workspace-membership and settings events to the workspace', () => {
    for (const eventType of [
      ...WORKSPACE_EVENT_TYPES,
      ...WORKSPACE_MEMBERSHIP_EVENT_TYPES,
      WORKSPACE_SETTINGS_UPDATED,
    ]) {
      expect(byType.get(eventType)?.tenantScope, eventType).toBe('workspace');
    }
  });

  it('leaves no declaration without a scope', () => {
    for (const declaration of PLATFORM_EVENT_DECLARATIONS) {
      expect(['workspace', 'organization'], declaration.eventType).toContain(
        declaration.tenantScope,
      );
    }
  });
});

describe('producers and streams', () => {
  it('attributes each type to the producer that actually emits it', () => {
    for (const eventType of ORGANIZATION_EVENT_TYPES) {
      expect(byType.get(eventType)?.producer, eventType).toBe(ORGANIZATION_PRODUCER);
    }
    for (const eventType of [...WORKSPACE_EVENT_TYPES, WORKSPACE_SETTINGS_UPDATED]) {
      expect(byType.get(eventType)?.producer, eventType).toBe(WORKSPACE_PRODUCER);
    }
    for (const eventType of [
      ...ORGANIZATION_MEMBERSHIP_EVENT_TYPES,
      ...WORKSPACE_MEMBERSHIP_EVENT_TYPES,
    ]) {
      expect(byType.get(eventType)?.producer, eventType).toBe(MEMBERSHIP_PRODUCER);
    }
  });

  // Ordering is per aggregateId, so splitting a family across streams buys
  // nothing and multiplies consumer-group bookkeeping.
  it('routes each family to one stream', () => {
    for (const eventType of [...ORGANIZATION_EVENT_TYPES, ...ORGANIZATION_MEMBERSHIP_EVENT_TYPES]) {
      expect(byType.get(eventType)?.stream, eventType).toBe(ORGANIZATION_STREAM);
    }
    for (const eventType of [
      ...WORKSPACE_EVENT_TYPES,
      ...WORKSPACE_MEMBERSHIP_EVENT_TYPES,
      WORKSPACE_SETTINGS_UPDATED,
    ]) {
      expect(byType.get(eventType)?.stream, eventType).toBe(WORKSPACE_STREAM);
    }
  });

  it('declares every type at version 1 and active', () => {
    for (const declaration of PLATFORM_EVENT_DECLARATIONS) {
      expect(declaration.version, declaration.eventType).toBe(1);
      expect(declaration.state, declaration.eventType).toBe('active');
    }
  });
});

describe('cascade consumer groups', () => {
  const groupsOf = (eventType: string): string[] =>
    (byType.get(eventType)?.consumers ?? []).map((c) => c.consumerGroup);

  // Suspension and reactivation are the same aggregate's ordered lifecycle:
  // split across two groups, a lagging suspension could be applied AFTER the
  // reactivation meant to undo it.
  it('puts suspension and reactivation in ONE group', () => {
    expect(groupsOf('OrganizationSuspended')).toEqual([ORGANIZATION_LIFECYCLE_CASCADE_GROUP]);
    expect(groupsOf('OrganizationReactivated')).toEqual([ORGANIZATION_LIFECYCLE_CASCADE_GROUP]);
  });

  // A different aggregate, so no shared ordering constraint — and its lag and
  // DLQ page for a different reason.
  it('gives membership revocation its own group', () => {
    expect(groupsOf('OrgMembershipRevoked')).toEqual([ORGANIZATION_MEMBERSHIP_CASCADE_GROUP]);
  });

  it('declares consumers on exactly those three types and no others', () => {
    const consumed = PLATFORM_EVENT_DECLARATIONS.filter((d) => d.consumers.length > 0).map(
      (d) => d.eventType,
    );
    expect([...consumed].sort()).toEqual([
      'OrgMembershipRevoked',
      'OrganizationReactivated',
      'OrganizationSuspended',
    ]);
  });

  it('marks both cascades critical — each pages for its own reason', () => {
    for (const declaration of PLATFORM_EVENT_DECLARATIONS) {
      for (const consumer of declaration.consumers) {
        expect(consumer.criticality, declaration.eventType).toBe('critical');
        expect(consumer.versions, declaration.eventType).toEqual([1]);
        expect(consumer.onUnknownVersion, declaration.eventType).toBe('dead-letter');
      }
    }
  });

  // A group name is platform-wide; two components sharing one would share a
  // Redis offset and each see a fraction of the stream.
  it('gives every group exactly one component', () => {
    const components = new Map<string, Set<string>>();
    for (const declaration of PLATFORM_EVENT_DECLARATIONS) {
      for (const consumer of declaration.consumers) {
        const set = components.get(consumer.consumerGroup) ?? new Set<string>();
        set.add(consumer.component);
        components.set(consumer.consumerGroup, set);
      }
    }
    for (const [group, set] of components) {
      expect([...set], group).toHaveLength(1);
    }
  });
});
