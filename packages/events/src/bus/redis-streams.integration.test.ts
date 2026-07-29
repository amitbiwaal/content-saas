/**
 * Redis Streams bus against a REAL Redis 7 server.
 *
 * The suite in `redis-streams.test.ts` exercises the adapter's LOGIC against a
 * stub client. It cannot tell whether the commands it builds are ones Redis
 * accepts, nor whether the replies it narrows are the shapes Redis returns.
 * XAUTOCLAIM's reply shape in particular changed between Redis 6.2 and 7, and
 * no stub would ever have caught that. The two suites are not substitutes.
 *
 * Requires `REDIS_URL`. Without it the suite SKIPS loudly, and — because a
 * silently-skipped test reads exactly like a passing one — it FAILS outright
 * when `CI` is set, so the gate can never rot unnoticed.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DomainEvent } from '@contentos/contracts';

import { createRedisClient, type ManagedRedisClient } from './ioredis-client.js';
import { BackPressureError, createRedisStreamsBus, type EventBus } from './redis-streams.js';

const REDIS_URL = process.env['REDIS_URL'];
const canRun = REDIS_URL !== undefined && REDIS_URL !== '';

if (!canRun) {
  console.warn(
    '[redis-streams.integration] SKIPPED — REDIS_URL is not set. The CI runtime job ' +
      'provides a redis:7-alpine service container and sets it.',
  );
}

// The gate itself is under test. If CI ever stops providing Redis, this fails
// rather than quietly reducing the suite to nothing.
describe('live Redis gate', () => {
  it('is satisfied whenever CI runs', () => {
    if (process.env['CI'] !== undefined && process.env['CI'] !== 'false') {
      expect(canRun, 'CI must provide REDIS_URL for the live Redis suite').toBe(true);
    }
  });
});

const describeLive = canRun ? describe : describe.skip;

function event(over: Partial<DomainEvent<unknown>> = {}): DomainEvent<unknown> {
  return {
    eventId: '018f7a1e-0000-7000-8000-000000000001',
    eventType: 'ArticlePublished',
    eventVersion: 1,
    aggregateType: 'Article',
    aggregateId: '018f7a1e-0000-7000-8000-0000000000c1',
    tenantId: '018f7a1e-0000-7000-8000-0000000000bb',
    organizationId: '018f7a1e-0000-7000-8000-0000000000aa',
    correlationId: '018f7a1e-0000-7000-8000-0000000000dd',
    causationId: null,
    producer: 'content-platform',
    occurredAt: '2026-07-29T10:00:00.000Z',
    payload: { articleId: 'a1' },
    ...over,
  };
}

describeLive('Redis Streams bus against Redis 7', () => {
  let client: ManagedRedisClient;
  let bus: EventBus;
  const created: string[] = [];
  let counter = 0;

  /** A fresh stream per test: shared state between tests is a flake generator. */
  function streamName(label: string): string {
    counter += 1;
    const name = `it:${String(process.pid)}:${String(counter)}:${label}`;
    created.push(name);
    return name;
  }

  beforeAll(async () => {
    client = createRedisClient({ url: REDIS_URL ?? '', connectionName: 'events-integration' });
    // `enableOfflineQueue: false` makes an early command fail rather than
    // queue, so the connection must be ready before the first one.
    await client.waitUntilReady();
    bus = createRedisStreamsBus({ client });
  });

  afterAll(async () => {
    if (created.length > 0) await client.raw.del(...created);
    await bus.shutdown();
  });

  it('round-trips an event through a real stream byte-identically', async () => {
    const stream = streamName('roundtrip');
    const group = 'g';
    await bus.ensureGroup(stream, group);

    const sent = event({ payload: { articleId: 'a1', nested: { depth: 2 } } });
    const entryId = await bus.append(stream, sent);
    expect(entryId).toMatch(/^\d+-\d+$/);

    const got = await bus.readGroup({ stream, group, consumer: 'c1' });
    expect(got).toHaveLength(1);
    // The whole envelope, field for field — this is the contract the outbox,
    // the DLQ, and replay all depend on.
    expect(got[0]?.event).toEqual(sent);
  });

  // Redis stores strings only, so a root event's null causationId is written as
  // '' and must come back as null — not as an empty string that later reads as
  // a real causation edge.
  it('preserves a null causationId across the wire', async () => {
    const stream = streamName('null-causation');
    await bus.ensureGroup(stream, 'g');
    await bus.append(stream, event({ causationId: null }));
    const got = await bus.readGroup({ stream, group: 'g', consumer: 'c1' });
    expect(got[0]?.event.causationId).toBeNull();
  });

  it('preserves a non-null causationId', async () => {
    const stream = streamName('causation');
    await bus.ensureGroup(stream, 'g');
    const id = '018f7a1e-0000-7000-8000-0000000000ee';
    await bus.append(stream, event({ causationId: id }));
    const got = await bus.readGroup({ stream, group: 'g', consumer: 'c1' });
    expect(got[0]?.event.causationId).toBe(id);
  });

  // BUSYGROUP on the second call is the normal case on every restart.
  it('creates a consumer group idempotently', async () => {
    const stream = streamName('idempotent-group');
    await bus.ensureGroup(stream, 'g');
    await expect(bus.ensureGroup(stream, 'g')).resolves.toBeUndefined();
  });

  it('preserves append order within a stream', async () => {
    const stream = streamName('ordering');
    await bus.ensureGroup(stream, 'g');
    for (let i = 0; i < 5; i += 1) {
      await bus.append(stream, event({ payload: { seq: i } }));
    }
    const got = await bus.readGroup({ stream, group: 'g', consumer: 'c1', count: 10 });
    expect(got.map((d) => (d.event.payload as { seq: number }).seq)).toEqual([0, 1, 2, 3, 4]);
  });

  it('delivers an entry to only one consumer in a group', async () => {
    const stream = streamName('exclusive');
    await bus.ensureGroup(stream, 'g');
    await bus.append(stream, event());

    const first = await bus.readGroup({ stream, group: 'g', consumer: 'c1' });
    const second = await bus.readGroup({ stream, group: 'g', consumer: 'c2' });
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
  });

  it('leaves an unacked entry pending and clears it on ack', async () => {
    const stream = streamName('pending');
    await bus.ensureGroup(stream, 'g');
    await bus.append(stream, event());

    const got = await bus.readGroup({ stream, group: 'g', consumer: 'c1' });
    expect(await bus.pendingCount(stream, 'g')).toBe(1);

    const acked = await bus.ack(stream, 'g', got[0]?.entryId ?? '');
    expect(acked).toBe(1);
    expect(await bus.pendingCount(stream, 'g')).toBe(0);
  });

  // THE CRASH CASE. A consumer that read but never acked leaves entries pending
  // forever; without XAUTOCLAIM that is silent event loss.
  it('reclaims entries a dead consumer never acked', async () => {
    const stream = streamName('autoclaim');
    await bus.ensureGroup(stream, 'g');
    await bus.append(stream, event({ payload: { orphan: true } }));

    // 'dead' reads and then, in effect, dies.
    const read = await bus.readGroup({ stream, group: 'g', consumer: 'dead' });
    expect(read).toHaveLength(1);

    await new Promise((r) => setTimeout(r, 60));
    const claimed = await bus.claimStalled({
      stream,
      group: 'g',
      consumer: 'survivor',
      minIdleMs: 50,
    });

    expect(claimed.events).toHaveLength(1);
    expect(claimed.events[0]?.event.payload).toEqual({ orphan: true });
    // A claimed entry has been delivered at least twice by definition.
    expect(claimed.events[0]?.deliveryCount).toBe(2);
    expect(claimed.cursor).toMatch(/^\d+-\d+$/);
  });

  it('does not reclaim entries that are still within their idle window', async () => {
    const stream = streamName('too-fresh');
    await bus.ensureGroup(stream, 'g');
    await bus.append(stream, event());
    await bus.readGroup({ stream, group: 'g', consumer: 'busy' });

    const claimed = await bus.claimStalled({
      stream,
      group: 'g',
      consumer: 'thief',
      minIdleMs: 60_000,
    });
    expect(claimed.events).toHaveLength(0);
  });

  it('reports real stream depth', async () => {
    const stream = streamName('depth');
    await bus.ensureGroup(stream, 'g');
    await bus.append(stream, event());
    await bus.append(stream, event());
    expect(await bus.depth(stream)).toBe(2);
  });

  it('refuses to append over the back-pressure high-water mark', async () => {
    const stream = streamName('backpressure');
    await bus.ensureGroup(stream, 'g');
    const pressured = createRedisStreamsBus({ client, maxStreamLength: 1 });
    await pressured.append(stream, event());
    await pressured.append(stream, event());
    // Depth is now 2, over the mark of 1.
    await expect(pressured.append(stream, event())).rejects.toBeInstanceOf(BackPressureError);
  });

  it('trims a stream', async () => {
    const stream = streamName('trim');
    await bus.ensureGroup(stream, 'g');
    // Enough entries to span several stream nodes. MAXLEN ~ trims whole nodes,
    // so a handful of entries would be left untouched and the assertion would
    // pass without the trim having done anything.
    for (let i = 0; i < 250; i += 1) await bus.append(stream, event({ payload: { i } }));
    expect(await bus.depth(stream)).toBe(250);

    const removed = await bus.trim(stream, 2);
    expect(removed).toBeGreaterThan(0);
    // Approximate by design: exact trimming is O(n) and blocks the server, so
    // the contract is "meaningfully reduced", not "exactly two".
    expect(await bus.depth(stream)).toBeLessThan(250);
  });

  it('returns no events when reading a stream with nothing new', async () => {
    const stream = streamName('empty');
    await bus.ensureGroup(stream, 'g');
    expect(await bus.readGroup({ stream, group: 'g', consumer: 'c1' })).toHaveLength(0);
  });

  // A malformed entry must fail at the boundary rather than becoming an event
  // with a garbage identifier.
  it('rejects a stream entry that is not a valid envelope', async () => {
    const stream = streamName('malformed');
    await bus.ensureGroup(stream, 'g');
    await client.raw.xadd(stream, '*', 'payload', '{"a":1}', 'eventId', 'x');

    await expect(bus.readGroup({ stream, group: 'g', consumer: 'c1' })).rejects.toThrow(
      /missing required field/i,
    );
  });
});
