/**
 * The Credits Service against the REAL event platform.
 *
 * Four things a unit test inside a package cannot check, because
 * `packages/platform` and `workers/host` may not reach into `packages/events`
 * the way a composition root does:
 *
 *   - the five new envelopes survive the frozen validator;
 *   - a registry built from the platform's own contribution accepts them, and
 *     adding them collided with nothing Sprint 1 declared;
 *   - the credits worker COMPOSES — its two groups have handlers, agree on
 *     tenant scope, and read the streams their events are actually on;
 *   - they replay intact, which for a financial event means the amount comes
 *     back to the sixth decimal.
 */

import { describe, expect, it } from 'vitest';

import { createEventRegistry, createEventSerializer, validateEnvelope } from '@contentos/events';
import {
  CREDIT_ACCOUNT_AGGREGATE,
  CREDIT_HOLD_EVENT_TYPES,
  CREDIT_PRODUCER,
  CREDIT_STREAM,
  CREDIT_THRESHOLD_EVENT_TYPES,
  CREDITS_ORGANIZATION_RELEASE_GROUP,
  CREDITS_WORKSPACE_RELEASE_GROUP,
  creditHeld,
  creditReleased,
  creditSettled,
  creditsExhausted,
  creditsLow,
  ORGANIZATION_STREAM,
  PLATFORM_EVENT_DECLARATIONS,
  WORKSPACE_STREAM,
  type CreditsExecutor,
  type CreditsService,
} from '@contentos/platform';
import { createCreditsHandlers, creditsSubscriptions } from '@contentos/worker-host';
import type { DomainEvent } from '@contentos/contracts';

const ORG = '018f7a1e-0000-7000-8000-0000000000aa';
const WS = '018f7a1e-0000-7000-8000-0000000000bb';
const HOLD = '018f7a1e-0000-7000-7001-000000000001';
const EVENT_ID = '018f7a1e-0000-7000-8000-0000000000ee';
const CORRELATION = '018f7a1e-0000-7000-8000-0000000000dd';

const ctx = {
  eventId: EVENT_ID,
  correlationId: CORRELATION,
  causationId: null,
  occurredAt: '2026-07-30T12:00:00.000Z',
};

const holdBase = {
  holdId: HOLD,
  organizationId: ORG,
  workspaceId: WS,
  runId: 'run-0001',
  amount: '20.000000',
} as const;

const thresholdBase = {
  organizationId: ORG,
  balance: '5.000000',
  threshold: '10.000000',
  previousState: 'ok',
} as const;

const EVENTS: readonly DomainEvent<unknown>[] = [
  creditHeld(ctx, { ...holdBase, expiresAt: '2026-07-31T12:00:00.000Z' }),
  creditSettled(ctx, { ...holdBase, consumed: '7.500000', released: '12.500000' }),
  creditReleased(ctx, { ...holdBase, consumed: '0.000000', cause: 'failed' }),
  creditsLow(ctx, thresholdBase),
  creditsExhausted(ctx, { ...thresholdBase, balance: '0.000000', previousState: 'low' }),
];

describe('the new envelopes satisfy the frozen contract', () => {
  for (const event of EVENTS) {
    it(`${event.eventType} validates`, () => {
      const result = validateEnvelope(event);
      expect(result.ok, JSON.stringify(result)).toBe(true);
    });
  }

  it('builds one envelope per newly declared type', () => {
    expect(EVENTS.map((e) => e.eventType).sort()).toEqual(
      [...CREDIT_HOLD_EVENT_TYPES, ...CREDIT_THRESHOLD_EVENT_TYPES].sort(),
    );
  });

  it('shares the credit account aggregate with the ledger events', () => {
    for (const event of EVENTS) {
      expect(event, event.eventType).toMatchObject({
        aggregateType: CREDIT_ACCOUNT_AGGREGATE,
        aggregateId: ORG,
        tenantId: ORG,
        producer: CREDIT_PRODUCER,
      });
    }
  });

  // The reason for one aggregate: a hold and the entries it produces must stay
  // ordered against each other for a read model to rebuild a coherent balance.
  it('orders holds and ledger entries under one key', () => {
    expect(new Set(EVENTS.map((e) => e.aggregateId)).size).toBe(1);
  });
});

describe('a real registry accepts them', () => {
  const registry = createEventRegistry([...PLATFORM_EVENT_DECLARATIONS]);

  for (const event of EVENTS) {
    it(`registers and validates ${event.eventType}`, () => {
      expect(registry.isRegistered(event.eventType, 1)).toBe(true);
      const result = registry.validate(event);
      expect(result.ok, JSON.stringify(result)).toBe(true);
    });
  }

  it('routes the whole credit family to one stream', () => {
    for (const eventType of [...CREDIT_HOLD_EVENT_TYPES, ...CREDIT_THRESHOLD_EVENT_TYPES]) {
      expect(registry.streamFor(eventType), eventType).toBe(CREDIT_STREAM);
    }
  });

  it('builds without a collision against everything already declared', () => {
    expect(() => createEventRegistry([...PLATFORM_EVENT_DECLARATIONS])).not.toThrow();
  });
});

describe('the consumer groups are declared where their events are', () => {
  const byType = new Map(PLATFORM_EVENT_DECLARATIONS.map((d) => [d.eventType, d]));

  const groupsOf = (eventType: string): string[] =>
    (byType.get(eventType)?.consumers ?? []).map((c) => c.consumerGroup);

  it('subscribes the credits group to OrganizationSuspended', () => {
    expect(groupsOf('OrganizationSuspended')).toContain(CREDITS_ORGANIZATION_RELEASE_GROUP);
  });

  it('subscribes the other to WorkspaceSuspended', () => {
    expect(groupsOf('WorkspaceSuspended')).toEqual([CREDITS_WORKSPACE_RELEASE_GROUP]);
  });

  // The cascade already consumes OrganizationSuspended. The two are independent
  // — one failing must not retry or block the other — which separate groups is
  // what makes true.
  it('leaves the existing cascade group in place alongside it', () => {
    expect(groupsOf('OrganizationSuspended')).toContain('organization-lifecycle-cascade');
    expect(groupsOf('OrganizationSuspended')).toHaveLength(2);
  });

  it('keeps the two credits groups on different components from the cascade', () => {
    const credits = (byType.get('WorkspaceSuspended')?.consumers ?? [])[0];
    expect(credits?.component).toBe('workers.host.credits');
    expect(credits?.criticality).toBe('critical');
    expect(credits?.onUnknownVersion).toBe('dead-letter');
  });
});

describe('the credits worker composes', () => {
  const handlers = createCreditsHandlers({
    credits: {} as CreditsService,
    runner: { withOrganization: (_id, work) => work({} as CreditsExecutor) },
  });

  // A group reads ONE stream. Merging these would mean one of the two events
  // never being delivered — a worker that starts cleanly and silently leaves
  // half the holds open.
  it('splits the two groups across the streams their events are on', () => {
    const subscriptions = creditsSubscriptions(handlers);
    const byGroup = new Map(subscriptions.map((s) => [s.group, s.stream]));

    expect(byGroup.get(CREDITS_ORGANIZATION_RELEASE_GROUP)).toBe(ORGANIZATION_STREAM);
    expect(byGroup.get(CREDITS_WORKSPACE_RELEASE_GROUP)).toBe(WORKSPACE_STREAM);
    expect(subscriptions).toHaveLength(2);
  });

  it('gives every subscription a handler', () => {
    for (const subscription of creditsSubscriptions(handlers)) {
      expect(subscription.handlers.length, subscription.group).toBeGreaterThan(0);
    }
  });

  it('agrees with the registry about each handler tenant scope', () => {
    const byType = new Map(PLATFORM_EVENT_DECLARATIONS.map((d) => [d.eventType, d]));
    for (const handler of handlers) {
      expect(handler.tenantScope, handler.eventType).toBe(
        byType.get(handler.eventType)?.tenantScope,
      );
    }
  });
});

describe('replay compatibility', () => {
  const serializer = createEventSerializer();

  for (const event of EVENTS) {
    it(`${event.eventType} survives serialize → deserialize`, () => {
      expect(serializer.deserialize(serializer.serialize(event))).toEqual(event);
    });

    it(`${event.eventType} survives the Redis Streams field encoding`, () => {
      expect(serializer.fromStreamFields(serializer.toStreamFields(event))).toEqual(event);
    });
  }

  // A balance rebuilt by replay must equal the ledger to the last decimal, or
  // reconciliation reports a discrepancy nobody can explain.
  it('preserves amounts a double would round', () => {
    const event = creditSettled(ctx, {
      ...holdBase,
      amount: '99999999999999.999999',
      consumed: '0.100000',
      released: '99999999999999.899999',
    });
    const restored = serializer.deserialize(serializer.serialize(event));
    const payload = restored.payload as { amount: string; consumed: string; released: string };

    expect(payload.amount).toBe('99999999999999.999999');
    expect(payload.consumed).toBe('0.100000');
    expect(payload.released).toBe('99999999999999.899999');
    expect(String(Number(payload.amount))).not.toBe(payload.amount);
  });
});
