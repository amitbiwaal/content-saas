/**
 * The composed registry against the REAL event platform.
 *
 * This is the increment's headline check: every event type the platform can
 * emit is not merely declared somewhere, but is accepted by the real registry,
 * survives the real transactional outbox publisher, and reaches the real
 * dispatcher with a tenant scope the handler agrees with.
 *
 * Sprint 1 shipped nineteen event types with no declarations at all, and every
 * gate stayed green. The specific reason it stayed green is that no test ever
 * joined a producing package to a composed registry — so that is what this file
 * does, from both composition roots.
 */

import { describe, expect, it } from 'vitest';

import type { DomainEvent, TenantContext } from '@contentos/contracts';
import {
  composeEventRegistry,
  createAggregateBarrier,
  createDispatcher,
  createIdempotencyGuard,
  createOutboxPublisher,
  createRetryEngine,
  RegistryValidationError,
  type GuardExecutor,
  TENANT_SCOPE_MISMATCH,
  type DeadLetterRequest,
  type RegisteredHandler,
} from '@contentos/events';
import { createApiEventRegistry } from '@contentos/api';
import {
  PLATFORM_EMITTABLE_EVENT_TYPES,
  PLATFORM_EVENT_DECLARATIONS,
  PLATFORM_REGISTRY_CONTRIBUTION,
} from '@contentos/platform';
import { createWorkerEventRegistry } from '@contentos/worker-host';

const ORG = '018f7a1e-0000-7000-8000-0000000000aa';
const WS = '018f7a1e-0000-7000-8000-0000000000c1';
const EVENT_ID = '018f7a1e-0000-7000-8000-0000000000ee';
const CORRELATION = '018f7a1e-0000-7000-8000-0000000000dd';

const composed = composeEventRegistry({ contributions: [PLATFORM_REGISTRY_CONTRIBUTION] });

function event(eventType: string, tenantId: string): DomainEvent<Record<string, unknown>> {
  return {
    eventId: EVENT_ID,
    eventType,
    eventVersion: 1,
    aggregateType: 'Thing',
    aggregateId: '018f7a1e-0000-7000-8000-0000000000c9',
    tenantId,
    organizationId: ORG,
    correlationId: CORRELATION,
    causationId: null,
    producer: 'platform',
    occurredAt: '2026-07-30T12:00:00.000Z',
    payload: { thingId: '018f7a1e-0000-7000-8000-0000000000c9' },
  };
}

/**
 * A transaction whose `processed_events` insert behaves like the real unique
 * constraint — a row back the first time, nothing on a redelivery. Returning
 * nothing unconditionally would make the guard call every event a duplicate.
 */
function transaction<T>(work: (tx: GuardExecutor) => Promise<T>): Promise<T> {
  const claimed = new Set<string>();
  const tx = {
    query<R>(sql: string, params?: readonly unknown[]): Promise<readonly R[]> {
      if (sql.includes('INSERT INTO processed_events')) {
        const k = `${String(params?.[2])}::${String(params?.[3])}`;
        if (claimed.has(k)) return Promise.resolve([] as unknown as R[]);
        claimed.add(k);
        return Promise.resolve([{ event_id: params?.[3] }] as unknown as R[]);
      }
      return Promise.resolve([] as unknown as R[]);
    },
  } as GuardExecutor;
  return work(tx);
}

function outboxTx(): { query: (q: string, p?: readonly unknown[]) => Promise<never[]> } {
  return { query: (): Promise<never[]> => Promise.resolve([]) };
}

describe('both composition roots build a valid registry', () => {
  it('the API root composes and registers every platform type', () => {
    const { registry, declarations } = createApiEventRegistry();
    expect(declarations).toHaveLength(PLATFORM_EMITTABLE_EVENT_TYPES.length);
    for (const eventType of PLATFORM_EMITTABLE_EVENT_TYPES) {
      expect(registry.isRegistered(eventType, 1), eventType).toBe(true);
    }
  });

  it('the worker root composes and registers every platform type', () => {
    const { registry } = createWorkerEventRegistry();
    for (const eventType of PLATFORM_EMITTABLE_EVENT_TYPES) {
      expect(registry.isRegistered(eventType, 1), eventType).toBe(true);
    }
  });

  // Two roots that disagreed would publish on one path and not the other.
  it('the two roots agree on the declaration set', () => {
    const api = createApiEventRegistry()
      .declarations.map((d) => d.eventType)
      .sort();
    const worker = createWorkerEventRegistry()
      .declarations.map((d) => d.eventType)
      .sort();
    expect(api).toEqual(worker);
  });
});

describe('every declared type is publishable through the real outbox', () => {
  it('accepts all nineteen through the real publisher and registry', async () => {
    const publisher = createOutboxPublisher({ registry: composed.registry });

    for (const declaration of PLATFORM_EVENT_DECLARATIONS) {
      const tenantId = declaration.tenantScope === 'organization' ? ORG : WS;
      await expect(
        publisher.publish(outboxTx() as never, event(declaration.eventType, tenantId)),
      ).resolves.toBeUndefined();
    }
  });

  // Validation runs inside publish, before commit — an undeclared type rolls
  // the producer's transaction back rather than reaching the outbox.
  it('refuses a type nothing declares', async () => {
    const publisher = createOutboxPublisher({ registry: composed.registry });
    await expect(
      publisher.publish(outboxTx() as never, event('NeverDeclared', WS)),
    ).rejects.toMatchObject({ code: 'UnknownEventType' });
  });

  it('resolves every type to its declared stream', () => {
    for (const declaration of PLATFORM_EVENT_DECLARATIONS) {
      expect(composed.registry.streamFor(declaration.eventType), declaration.eventType).toBe(
        declaration.stream,
      );
    }
  });
});

describe('startup fails rather than warning', () => {
  it('refuses a contribution that emits an undeclared type', () => {
    expect(() =>
      composeEventRegistry({
        contributions: [
          {
            source: '@contentos/platform',
            declarations: PLATFORM_EVENT_DECLARATIONS,
            emits: [...PLATFORM_EMITTABLE_EVENT_TYPES, 'ForgottenEvent'],
          },
        ],
      }),
    ).toThrow(RegistryValidationError);
  });

  it('refuses a second package claiming a platform event type', () => {
    expect(() =>
      composeEventRegistry({
        contributions: [
          PLATFORM_REGISTRY_CONTRIBUTION,
          {
            source: '@contentos/impostor',
            declarations: [
              {
                eventType: 'OrganizationCreated',
                version: 2,
                state: 'active',
                stream: 'organization',
                producer: 'somebody-else',
                tenantScope: 'organization',
                consumers: [],
              },
            ],
            emits: [],
          },
        ],
      }),
    ).toThrow(/DUPLICATE_PRODUCER|exactly one producer/);
  });
});

describe('the dispatcher enforces tenant scope — ADR-029', () => {
  function dispatcherHarness(): {
    dispatcher: ReturnType<typeof createDispatcher>;
    quarantined: DeadLetterRequest[];
  } {
    const quarantined: DeadLetterRequest[] = [];
    const dispatcher = createDispatcher({
      barrier: createAggregateBarrier(),
      guard: createIdempotencyGuard(),
      retry: createRetryEngine(),
      transaction: transaction,
      quarantine: (r): Promise<void> => {
        quarantined.push(r);
        return Promise.resolve();
      },
      // Wired from the composed registry — the whole point of declaring scope.
      tenantScopeOf: composed.tenantScopeOf,
    });
    return { dispatcher, quarantined };
  }

  function handler(over: Partial<RegisteredHandler> = {}): RegisteredHandler {
    return {
      eventType: 'OrganizationSuspended',
      version: 1,
      group: 'cascade',
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

  it('delivers an event whose scope the handler accepts', async () => {
    const h = dispatcherHarness();
    const outcome = await h.dispatcher.dispatch(
      event('OrganizationSuspended', ORG),
      handler(),
      1,
      new AbortController().signal,
    );
    expect(outcome.kind).toBe('handled');
    expect(h.quarantined).toHaveLength(0);
  });

  // The silent failure this closes: a workspace-scoped handler given an
  // organization-scoped event sets app.tenant_id to an organization id and
  // reads zero rows without erroring.
  it('dead-letters an organization-scoped event handed to a workspace handler', async () => {
    const h = dispatcherHarness();
    const outcome = await h.dispatcher.dispatch(
      event('OrganizationSuspended', ORG),
      handler({ tenantScope: 'workspace' }),
      1,
      new AbortController().signal,
    );

    expect(outcome).toMatchObject({ kind: 'dead-lettered', code: TENANT_SCOPE_MISMATCH });
    expect(h.quarantined).toHaveLength(1);
    expect(h.quarantined[0]?.reason).toBe('terminal-classification');
    expect(h.quarantined[0]?.failureMessage).toContain('organization');
  });

  it('dead-letters a workspace-scoped event handed to an organization handler', async () => {
    const h = dispatcherHarness();
    const outcome = await h.dispatcher.dispatch(
      event('WorkspaceSuspended', WS),
      handler({ eventType: 'WorkspaceSuspended', tenantScope: 'organization' }),
      1,
      new AbortController().signal,
    );
    expect(outcome).toMatchObject({ kind: 'dead-lettered', code: TENANT_SCOPE_MISMATCH });
  });

  // Existing callers pass no resolver and must behave exactly as before.
  it('is inert when no scope resolver is supplied', async () => {
    const quarantined: DeadLetterRequest[] = [];
    const dispatcher = createDispatcher({
      barrier: createAggregateBarrier(),
      guard: createIdempotencyGuard(),
      retry: createRetryEngine(),
      transaction: transaction,
      quarantine: (r): Promise<void> => {
        quarantined.push(r);
        return Promise.resolve();
      },
    });

    const outcome = await dispatcher.dispatch(
      event('OrganizationSuspended', ORG),
      handler({ tenantScope: 'workspace' }),
      1,
      new AbortController().signal,
    );
    expect(outcome.kind).toBe('handled');
    expect(quarantined).toHaveLength(0);
  });
});
