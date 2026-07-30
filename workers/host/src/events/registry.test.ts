/**
 * The worker composition root.
 *
 * The difference from the API root is the one that matters: here a declared
 * consumer group MUST have a handler, because an unhandled group accumulates
 * events against an offset nobody advances.
 */
import { describe, expect, it } from 'vitest';

import type { DomainEvent, TenantContext } from '@contentos/contracts';
import type { GuardExecutor, RegisteredHandler } from '@contentos/events';
import { PLATFORM_EMITTABLE_EVENT_TYPES } from '@contentos/platform';

import { createWorkerEventRegistry, WORKER_REGISTRY_CONTRIBUTIONS } from './registry.js';

function handler(over: Partial<RegisteredHandler> = {}): RegisteredHandler {
  return {
    eventType: 'OrganizationCreated',
    version: 1,
    group: 'test-group',
    tenantScope: 'organization',
    handle: (
      _e: DomainEvent<unknown>,
      _c: TenantContext,
      _t: GuardExecutor,
      _s: AbortSignal,
    ): Promise<void> => Promise.resolve(),
    ...over,
  };
}

describe('the worker event registry', () => {
  // The relay registers no handlers and must still start.
  it('composes with no handlers — the relay-only deployment', () => {
    expect(() => createWorkerEventRegistry()).not.toThrow();
    expect(createWorkerEventRegistry().declarations).toHaveLength(
      PLATFORM_EMITTABLE_EVENT_TYPES.length,
    );
  });

  it('registers every platform event type', () => {
    const { registry } = createWorkerEventRegistry();
    for (const eventType of PLATFORM_EMITTABLE_EVENT_TYPES) {
      expect(registry.isRegistered(eventType, 1), eventType).toBe(true);
    }
  });

  it('accepts a handler that matches a declaration and its scope', () => {
    expect(() => createWorkerEventRegistry([handler()])).not.toThrow();
  });

  // ADR-029, caught at startup rather than as a silent zero-row read.
  it('refuses a handler whose tenant scope disagrees with the declaration', () => {
    expect(() =>
      createWorkerEventRegistry([
        handler({ eventType: 'OrganizationCreated', tenantScope: 'workspace' }),
      ]),
    ).toThrow(/HANDLER_SCOPE_MISMATCH|scope/i);
  });

  it('refuses a handler for an event type nothing declares', () => {
    expect(() => createWorkerEventRegistry([handler({ eventType: 'NeverDeclared' })])).toThrow(
      /HANDLER_WITHOUT_DECLARATION|not declared/i,
    );
  });

  it('accepts a workspace-scoped handler for a workspace-scoped type', () => {
    expect(() =>
      createWorkerEventRegistry([
        handler({ eventType: 'WorkspaceSuspended', tenantScope: 'workspace' }),
      ]),
    ).not.toThrow();
  });

  it('names its contributions in one place', () => {
    expect(WORKER_REGISTRY_CONTRIBUTIONS.map((c) => c.source)).toEqual(['@contentos/platform']);
  });
});
