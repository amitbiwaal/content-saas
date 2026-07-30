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

describe('consumers arrive with their handlers', () => {
  // Composition refuses to start a consumer process where a declared group has
  // no handler, so declaring a group before its handler exists would break
  // startup until the handler caught up. T3.2 adds both together.
  it('declares no consumer groups yet', () => {
    for (const declaration of PLATFORM_EVENT_DECLARATIONS) {
      expect(declaration.consumers, declaration.eventType).toEqual([]);
    }
  });
});
