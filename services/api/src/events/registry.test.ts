/**
 * The API composition root.
 *
 * `services/api` is producer-only, so the property under test is that it
 * validates the whole declaration set while requiring no handlers.
 */
import { describe, expect, it } from 'vitest';

import { AI_EMITTABLE_EVENT_TYPES } from '@contentos/ai';
import { PLATFORM_EMITTABLE_EVENT_TYPES } from '@contentos/platform';

import { API_REGISTRY_CONTRIBUTIONS, createApiEventRegistry } from './registry.js';

describe('the API event registry', () => {
  it('composes without throwing', () => {
    expect(() => createApiEventRegistry()).not.toThrow();
  });

  it('registers every event type the platform can publish', () => {
    const { registry } = createApiEventRegistry();
    for (const eventType of PLATFORM_EMITTABLE_EVENT_TYPES) {
      expect(registry.isRegistered(eventType, 1), eventType).toBe(true);
    }
  });

  // The API queues jobs, so it must be able to publish JobQueued — a type it
  // could not validate is one the outbox refuses at the boundary.
  it('registers every event type the AI package can publish', () => {
    const { registry } = createApiEventRegistry();
    for (const eventType of AI_EMITTABLE_EVENT_TYPES) {
      expect(registry.isRegistered(eventType, 1), eventType).toBe(true);
    }
  });

  it('registers nothing else', () => {
    const { declarations } = createApiEventRegistry();
    expect(declarations).toHaveLength(
      PLATFORM_EMITTABLE_EVENT_TYPES.length + AI_EMITTABLE_EVENT_TYPES.length,
    );
  });

  it('resolves the declared tenant scope of a type', () => {
    const composed = createApiEventRegistry();
    expect(composed.tenantScopeOf('OrganizationCreated', 1)).toBe('organization');
    expect(composed.tenantScopeOf('WorkspaceCreated', 1)).toBe('workspace');
  });

  // Producer-only: it publishes but runs no consumers. Requiring handlers here
  // would make every new worker-side group break the API's startup.
  it('requires no handlers', () => {
    const { registry } = createApiEventRegistry();
    expect(registry.consumersOf('OrganizationCreated')).toEqual([]);
  });

  it('names its contributions in one place', () => {
    expect(API_REGISTRY_CONTRIBUTIONS.map((c) => c.source)).toEqual([
      '@contentos/platform',
      '@contentos/ai',
    ]);
  });

  // Two registries in one process could disagree, and the disagreement would
  // only show as an event that publishes on one path and not another.
  it('builds an equivalent registry on every call', () => {
    const a = createApiEventRegistry();
    const b = createApiEventRegistry();
    expect(a.declarations.map((d) => d.eventType)).toEqual(b.declarations.map((d) => d.eventType));
  });
});
