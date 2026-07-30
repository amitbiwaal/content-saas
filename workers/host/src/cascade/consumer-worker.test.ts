/**
 * Consumer worker runtime.
 *
 * The worker's whole job is the loop, the acknowledgement decision and the
 * heartbeat, so that is what is tested. Cascade behaviour is not re-tested
 * here — it is already covered where it lives.
 */
import { describe, expect, it, vi } from 'vitest';

import type { DomainEvent, TenantContext } from '@contentos/contracts';
import type {
  DeadLetterQueue,
  DeadLetterRequest,
  DeliveredEvent,
  Dispatcher,
  DispatchOutcome,
  EventBus,
  GuardExecutor,
  NewDeadLetterEntry,
  RegisteredHandler,
} from '@contentos/events';

import {
  assertSubscriptionsMatchRegistry,
  createConsumerWorker,
  createQuarantine,
  createRetryHistory,
  SubscriptionValidationError,
  type ConsumerSubscription,
} from './consumer-worker.js';

const ORG = '018f7a1e-0000-7000-8000-0000000000aa';
const STREAM = 'organization';
const GROUP = 'organization-lifecycle-cascade';
const NOW = new Date('2026-07-30T12:00:00.000Z');

function event(over: Partial<DomainEvent<unknown>> = {}): DomainEvent<unknown> {
  return {
    eventId: '018f7a1e-0000-7000-8000-0000000000e1',
    eventType: 'OrganizationSuspended',
    eventVersion: 1,
    aggregateType: 'Organization',
    aggregateId: ORG,
    tenantId: ORG,
    organizationId: ORG,
    correlationId: '018f7a1e-0000-7000-8000-0000000000dd',
    causationId: null,
    producer: 'platform.organizations',
    occurredAt: NOW.toISOString(),
    payload: { organizationId: ORG },
    ...over,
  };
}

function handler(over: Partial<RegisteredHandler> = {}): RegisteredHandler {
  return {
    eventType: 'OrganizationSuspended',
    version: 1,
    group: GROUP,
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

interface FakeBus {
  readonly bus: EventBus;
  readonly acked: string[];
  queue(...delivered: DeliveredEvent[]): void;
  failNextRead(error: Error): void;
}

function fakeBus(): FakeBus {
  const batches: DeliveredEvent[][] = [];
  const acked: string[] = [];
  let readError: Error | null = null;

  const bus = {
    readGroup: (): Promise<readonly DeliveredEvent[]> => {
      if (readError !== null) {
        const e = readError;
        readError = null;
        return Promise.reject(e);
      }
      return Promise.resolve(batches.shift() ?? []);
    },
    ack: (_s: string, _g: string, entryId: string): Promise<number> => {
      acked.push(entryId);
      return Promise.resolve(1);
    },
  } as unknown as EventBus;

  return {
    bus,
    acked,
    queue: (...delivered) => batches.push(delivered),
    failNextRead: (error) => {
      readError = error;
    },
  };
}

function delivered(over: Partial<DeliveredEvent> = {}): DeliveredEvent {
  return {
    entryId: '1-0',
    event: event(),
    deliveryCount: 1,
    stream: STREAM,
    ...over,
  };
}

function fakeDispatcher(outcomes: DispatchOutcome[]): Dispatcher & { calls: number } {
  let calls = 0;
  const d = {
    dispatch: (): Promise<DispatchOutcome> => {
      const outcome = outcomes[calls] ?? outcomes.at(-1);
      calls += 1;
      return Promise.resolve(outcome ?? { kind: 'handled', eventId: 'x', group: GROUP });
    },
  };
  return Object.defineProperty(d, 'calls', { get: () => calls }) as Dispatcher & {
    calls: number;
  };
}

function subscription(handlers: readonly RegisteredHandler[] = [handler()]): ConsumerSubscription {
  return { stream: STREAM, group: GROUP, handlers };
}

function workerWith(bus: EventBus, dispatcher: Dispatcher) {
  return createConsumerWorker({
    bus,
    dispatcher,
    subscriptions: [subscription()],
    consumerName: 'worker-1',
    now: () => NOW,
    sleep: () => Promise.resolve(),
  });
}

describe('the acknowledgement decision', () => {
  const ACKED: readonly (readonly [string, DispatchOutcome])[] = [
    ['handled', { kind: 'handled', eventId: 'e', group: GROUP }],
    ['suppressed-duplicate', { kind: 'suppressed-duplicate', eventId: 'e', group: GROUP }],
    ['dead-lettered', { kind: 'dead-lettered', eventId: 'e', group: GROUP, code: 'X' }],
  ];

  for (const [label, outcome] of ACKED) {
    it(`acks a ${label} event — it is finished`, async () => {
      const bus = fakeBus();
      bus.queue(delivered());
      await workerWith(bus.bus, fakeDispatcher([outcome])).runCycle();
      expect(bus.acked).toEqual(['1-0']);
    });
  }

  // Acking a retryable event is how events are lost, and nothing downstream
  // would notice.
  const PENDING: readonly (readonly [string, DispatchOutcome])[] = [
    ['retry', { kind: 'retry', eventId: 'e', group: GROUP, delayMs: 10 }],
    ['held', { kind: 'held', eventId: 'e', group: GROUP }],
  ];

  for (const [label, outcome] of PENDING) {
    it(`leaves a ${label} event PENDING — that is the redelivery mechanism`, async () => {
      const bus = fakeBus();
      bus.queue(delivered());
      await workerWith(bus.bus, fakeDispatcher([outcome])).runCycle();
      expect(bus.acked).toEqual([]);
    });
  }

  // A stream carries every type of its aggregate family, so a group sees types
  // it has no handler for. Leaving them pending grows the backlog forever.
  it('acks and ignores an event the group has no handler for', async () => {
    const bus = fakeBus();
    bus.queue(delivered({ event: event({ eventType: 'OrganizationCreated' }) }));
    const dispatcher = fakeDispatcher([{ kind: 'handled', eventId: 'e', group: GROUP }]);

    const worker = workerWith(bus.bus, dispatcher);
    await worker.runCycle();

    expect(bus.acked).toEqual(['1-0']);
    expect(dispatcher.calls).toBe(0);
    expect(worker.health().groups[0]?.ignored).toBe(1);
  });
});

describe('heartbeat', () => {
  it('starts null and is stamped once a group completes a read', async () => {
    const bus = fakeBus();
    const worker = workerWith(bus.bus, fakeDispatcher([]));
    expect(worker.health().groups[0]?.lastHeartbeatAt).toBeNull();

    await worker.runCycle();
    expect(worker.health().groups[0]?.lastHeartbeatAt).toEqual(NOW);
  });

  // A group blocked on an empty stream is healthy; one that cannot read is not.
  it('is stamped on an empty read', async () => {
    const bus = fakeBus();
    const worker = workerWith(bus.bus, fakeDispatcher([]));
    await worker.runCycle();
    expect(worker.health().groups[0]?.lastHeartbeatAt).toEqual(NOW);
  });

  it('is NOT stamped when the read itself fails', async () => {
    const bus = fakeBus();
    bus.failNextRead(new Error('redis down'));
    const errors: unknown[] = [];
    const worker = createConsumerWorker({
      bus: bus.bus,
      dispatcher: fakeDispatcher([]),
      subscriptions: [subscription()],
      consumerName: 'worker-1',
      now: () => NOW,
      sleep: () => Promise.resolve(),
      onError: (e) => errors.push(e),
    });

    await worker.runCycle();
    expect(worker.health().groups[0]?.lastHeartbeatAt).toBeNull();
    expect(errors).toHaveLength(1);
  });

  it('reports one entry per hosted group, and counts outcomes', async () => {
    const bus = fakeBus();
    bus.queue(delivered(), delivered({ entryId: '2-0' }));
    const worker = workerWith(
      bus.bus,
      fakeDispatcher([{ kind: 'handled', eventId: 'e', group: GROUP }]),
    );
    await worker.runCycle();

    const health = worker.health();
    expect(health.groups).toHaveLength(1);
    expect(health.groups[0]).toMatchObject({ group: GROUP, stream: STREAM, handled: 2 });
    expect(health.cyclesCompleted).toBe(1);
  });
});

describe('the loop', () => {
  // One group's failure must not stop the others.
  it('continues past a failing group', async () => {
    const bus = fakeBus();
    bus.failNextRead(new Error('redis down'));
    const errors: unknown[] = [];
    const worker = createConsumerWorker({
      bus: bus.bus,
      dispatcher: fakeDispatcher([]),
      subscriptions: [subscription()],
      consumerName: 'worker-1',
      sleep: () => Promise.resolve(),
      onError: (e) => errors.push(e),
    });

    await expect(worker.runCycle()).resolves.toBe(0);
    expect(errors).toHaveLength(1);
    await expect(worker.runCycle()).resolves.toBe(0);
  });

  it('stops cleanly and reports its status', async () => {
    const bus = fakeBus();
    const worker = workerWith(bus.bus, fakeDispatcher([]));
    const started = worker.start();
    expect(worker.health().status).toBe('ready');

    await worker.shutdown();
    await started;
    expect(worker.health().status).toBe('stopped');
  });

  // A second SIGTERM must not cut the first drain short.
  it('is idempotent on shutdown', async () => {
    const bus = fakeBus();
    const worker = workerWith(bus.bus, fakeDispatcher([]));
    const started = worker.start();
    await Promise.all([worker.shutdown(), worker.shutdown()]);
    await started;
    expect(worker.health().status).toBe('stopped');
  });
});

describe('subscription validation', () => {
  function composed(declarations: Parameters<typeof assertSubscriptionsMatchRegistry>[0]) {
    return declarations;
  }

  function registryStub(over: {
    isRegistered?: boolean;
    stream?: string;
    groups?: string[];
    declarations?: {
      eventType: string;
      consumers: { consumerGroup: string; versions: number[] }[];
    }[];
  }) {
    return composed({
      registry: {
        isRegistered: () => over.isRegistered ?? true,
        streamFor: () => over.stream ?? STREAM,
        consumersOf: () => (over.groups ?? [GROUP]).map((g) => ({ consumerGroup: g })),
      },
      declarations: over.declarations ?? [],
    } as unknown as Parameters<typeof assertSubscriptionsMatchRegistry>[0]);
  }

  it('accepts a subscription that agrees with the registry', () => {
    expect(() => {
      assertSubscriptionsMatchRegistry(registryStub({}), [subscription()]);
    }).not.toThrow();
  });

  // A group on the wrong stream starts cleanly, heartbeats healthily, and
  // receives nothing forever.
  it('rejects a group reading the wrong stream', () => {
    let caught: unknown;
    try {
      assertSubscriptionsMatchRegistry(registryStub({ stream: 'workspace' }), [subscription()]);
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SubscriptionValidationError);
    expect((caught as SubscriptionValidationError).issues[0]).toContain('would receive nothing');
  });

  it('rejects a handler for a type the registry does not declare', () => {
    expect(() => {
      assertSubscriptionsMatchRegistry(registryStub({ isRegistered: false }), [subscription()]);
    }).toThrow(/does not declare/);
  });

  it('rejects a group that is not a declared consumer of the type it handles', () => {
    expect(() => {
      assertSubscriptionsMatchRegistry(registryStub({ groups: ['someone-else'] }), [
        subscription(),
      ]);
    }).toThrow(/not declared as one of its consumers/);
  });

  it('rejects a subscription with no handlers at all', () => {
    expect(() => {
      assertSubscriptionsMatchRegistry(registryStub({}), [
        { stream: STREAM, group: GROUP, handlers: [] },
      ]);
    }).toThrow(/subscribes to no event type/);
  });

  // Subscribing to a group and handling only some of its types means the rest
  // are read, found unhandled, and acked away — silently discarded.
  it('rejects a hosted group missing a handler for one of its declared types', () => {
    const registry = registryStub({
      declarations: [
        {
          eventType: 'OrganizationSuspended',
          consumers: [{ consumerGroup: GROUP, versions: [1] }],
        },
        {
          eventType: 'OrganizationReactivated',
          consumers: [{ consumerGroup: GROUP, versions: [1] }],
        },
      ],
    });
    expect(() => {
      assertSubscriptionsMatchRegistry(registry, [subscription([handler()])]);
    }).toThrow(/OrganizationReactivated@1 but registers no handler/);
  });
});

describe('dead-letter wiring', () => {
  function quarantineHarness() {
    const entries: NewDeadLetterEntry[] = [];
    const history = createRetryHistory();
    const deadLetters = {
      quarantine: (_tx: GuardExecutor, entry: NewDeadLetterEntry): Promise<string | null> => {
        entries.push(entry);
        return Promise.resolve('dlq-1');
      },
    } as unknown as DeadLetterQueue;

    const quarantine = createQuarantine({
      deadLetters,
      transaction: <T>(work: (tx: GuardExecutor) => Promise<T>): Promise<T> =>
        work({} as GuardExecutor),
      history,
    });
    return { entries, history, quarantine };
  }

  function request(over: Partial<DeadLetterRequest> = {}): DeadLetterRequest {
    return {
      event: event(),
      consumerGroup: GROUP,
      failureCode: 'CascadeIncomplete',
      failureMessage: 'two workspaces unprocessed',
      reason: 'attempts-exhausted',
      ...over,
    };
  }

  it('writes a durable entry carrying the whole envelope', async () => {
    const h = quarantineHarness();
    await h.quarantine(request());

    expect(h.entries).toHaveLength(1);
    const entry = h.entries[0];
    expect(entry).toMatchObject({
      source: 'delivery',
      consumerGroup: GROUP,
      failureCode: 'CascadeIncomplete',
      reason: 'attempts-exhausted',
    });
    // Event id, correlation id, causation id and producer all travel on the
    // envelope, so the entry is self-contained.
    expect(entry?.event.eventId).toBe('018f7a1e-0000-7000-8000-0000000000e1');
    expect(entry?.event.correlationId).toBe('018f7a1e-0000-7000-8000-0000000000dd');
    expect(entry?.event.producer).toBe('platform.organizations');
  });

  it('attaches the retry history the dispatcher does not know about', async () => {
    const h = quarantineHarness();
    h.history.recordAttempt(event().eventId, GROUP, 'transient', NOW);
    h.history.recordAttempt(event().eventId, GROUP, 'transient', NOW);

    await h.quarantine(request());
    expect(h.entries[0]?.retryHistory).toEqual([
      { attempt: 1, at: NOW.toISOString(), code: 'transient' },
      { attempt: 2, at: NOW.toISOString(), code: 'transient' },
    ]);
  });

  // A replayed event starts a fresh history rather than inheriting the one
  // that put it in the queue.
  it('drains the history so a replay does not inherit it', async () => {
    const h = quarantineHarness();
    h.history.recordAttempt(event().eventId, GROUP, 'transient', NOW);

    await h.quarantine(request());
    await h.quarantine(request());
    expect(h.entries[0]?.retryHistory).toHaveLength(1);
    expect(h.entries[1]?.retryHistory).toEqual([]);
  });

  it('keeps histories separate per group', () => {
    const history = createRetryHistory();
    history.recordAttempt('e1', 'group-a', 'transient', NOW);
    expect(history.drain('e1', 'group-b')).toEqual([]);
    expect(history.drain('e1', 'group-a')).toHaveLength(1);
  });

  it('reports the quarantine to the caller', async () => {
    const seen: DeadLetterRequest[] = [];
    const quarantine = createQuarantine({
      deadLetters: {
        quarantine: (): Promise<string | null> => Promise.resolve('dlq-1'),
      } as unknown as DeadLetterQueue,
      transaction: <T>(work: (tx: GuardExecutor) => Promise<T>): Promise<T> =>
        work({} as GuardExecutor),
      history: createRetryHistory(),
      onQuarantined: (r) => seen.push(r),
    });

    await quarantine(request());
    expect(seen).toHaveLength(1);
  });

  it('writes the entry inside the supplied transaction', async () => {
    const transaction = vi.fn(
      <T>(work: (tx: GuardExecutor) => Promise<T>): Promise<T> => work({} as GuardExecutor),
    );
    const quarantine = createQuarantine({
      deadLetters: {
        quarantine: (): Promise<string | null> => Promise.resolve('dlq-1'),
      } as unknown as DeadLetterQueue,
      transaction,
      history: createRetryHistory(),
    });

    await quarantine(request());
    expect(transaction).toHaveBeenCalledTimes(1);
  });
});
