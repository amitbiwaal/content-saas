/**
 * The relay worker driving a REAL Redis 7 server.
 *
 * `relay-worker.test.ts` proves the LIFECYCLE with stub dependencies. This
 * suite proves the composition: a worker whose cycles publish through the real
 * bus and whose recovery sweep really reclaims what a crashed consumer
 * abandoned. Lifecycle bugs and integration bugs are different bugs.
 *
 * Requires `REDIS_URL`; skips loudly without it and fails under `CI`, so the
 * gate cannot rot into a silent pass.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DomainEvent } from '@contentos/contracts';
import { createRedisClient, createRedisStreamsBus } from '@contentos/events';
import type { EventBus, ManagedRedisClient } from '@contentos/events';

import { createRelayWorker } from './relay-worker.js';

const REDIS_URL = process.env['REDIS_URL'];
const canRun = REDIS_URL !== undefined && REDIS_URL !== '';

if (!canRun) {
  console.warn('[relay-worker.integration] SKIPPED — REDIS_URL is not set.');
}

describe('live Redis gate', () => {
  it('is satisfied whenever CI runs', () => {
    if (process.env['CI'] !== undefined && process.env['CI'] !== 'false') {
      expect(canRun, 'CI must provide REDIS_URL for the live worker suite').toBe(true);
    }
  });
});

const describeLive = canRun ? describe : describe.skip;

function event(seq: number): DomainEvent<unknown> {
  return {
    eventId: `018f7a1e-0000-7000-8000-${String(seq).padStart(12, '0')}`,
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
    payload: { seq },
  };
}

describeLive('relay worker over real Redis', () => {
  let client: ManagedRedisClient;
  let bus: EventBus;
  const created: string[] = [];
  let counter = 0;

  function streamName(label: string): string {
    counter += 1;
    const name = `it:worker:${String(process.pid)}:${String(counter)}:${label}`;
    created.push(name);
    return name;
  }

  beforeAll(async () => {
    client = createRedisClient({ url: REDIS_URL ?? '', connectionName: 'worker-integration' });
    await client.waitUntilReady();
    bus = createRedisStreamsBus({ client });
  });

  afterAll(async () => {
    if (created.length > 0) await client.raw.del(...created);
    await bus.shutdown();
  });

  /**
   * A pending outbox standing in for the database table. The worker does not
   * know or care where rows come from — `drainOutbox` is the seam — so this
   * exercises the real publish path without needing PostgreSQL in this suite.
   */
  function outbox(events: DomainEvent<unknown>[], stream: string): () => Promise<number> {
    return async (): Promise<number> => {
      const batch = events.splice(0, 10);
      for (const e of batch) await bus.append(stream, e);
      return batch.length;
    };
  }

  it('drains a backlog into a real stream and then goes idle', async () => {
    const stream = streamName('drain');
    await bus.ensureGroup(stream, 'g');
    const pending = [event(1), event(2), event(3)];

    const worker = createRelayWorker({
      drainOutbox: outbox(pending, stream),
      recoverPending: () => Promise.resolve(0),
      hostedGroups: ['read-models'],
      idleIntervalMs: 5,
      busyIntervalMs: 1,
    });

    const running = worker.start();
    await new Promise((r) => setTimeout(r, 120));
    await worker.shutdown();
    await running;

    expect(pending).toHaveLength(0);
    expect(await bus.depth(stream)).toBe(3);

    const delivered = await bus.readGroup({ stream, group: 'g', consumer: 'c1', count: 10 });
    expect(delivered.map((d) => (d.event.payload as { seq: number }).seq)).toEqual([1, 2, 3]);
  });

  // Startup recovery and crash recovery are the same operation, and this is the
  // path that makes that true in production rather than only in the unit test.
  it('reclaims what a crashed consumer abandoned, on its first cycle', async () => {
    const stream = streamName('recover');
    await bus.ensureGroup(stream, 'g');
    await bus.append(stream, event(9));

    // A consumer reads and dies without acking.
    const read = await bus.readGroup({ stream, group: 'g', consumer: 'dead' });
    expect(read).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 60));

    let reclaimed = 0;
    const worker = createRelayWorker({
      drainOutbox: () => Promise.resolve(0),
      recoverPending: async () => {
        const claimed = await bus.claimStalled({
          stream,
          group: 'g',
          consumer: 'survivor',
          minIdleMs: 50,
        });
        for (const entry of claimed.events) {
          await bus.ack(stream, 'g', entry.entryId);
          reclaimed += 1;
        }
        return claimed.events.length;
      },
      hostedGroups: ['read-models'],
    });

    const outcome = await worker.runCycle();
    expect(outcome.recovered).toBe(1);
    expect(reclaimed).toBe(1);
    expect(await bus.pendingCount(stream, 'g')).toBe(0);
  });

  // A Redis failure must never kill the loop: the outbox row is still
  // unpublished, so the event is delayed, not lost.
  it('survives a bus failure and keeps polling', async () => {
    const stream = streamName('resilient');
    await bus.ensureGroup(stream, 'g');
    const errors: unknown[] = [];
    let calls = 0;

    const worker = createRelayWorker({
      drainOutbox: async () => {
        calls += 1;
        if (calls === 1) throw new Error('simulated bus failure');
        await bus.append(stream, event(calls));
        return 1;
      },
      recoverPending: () => Promise.resolve(0),
      hostedGroups: ['read-models'],
      idleIntervalMs: 5,
      busyIntervalMs: 1,
      onError: (e) => errors.push(e),
    });

    const running = worker.start();
    await new Promise((r) => setTimeout(r, 80));
    await worker.shutdown();
    await running;

    expect(errors).toHaveLength(1);
    expect(await bus.depth(stream)).toBeGreaterThan(0);
  });

  it('finishes an in-flight publish before shutdown resolves', async () => {
    const stream = streamName('graceful');
    await bus.ensureGroup(stream, 'g');
    let published = 0;

    const worker = createRelayWorker({
      drainOutbox: async () => {
        await bus.append(stream, event(published + 1));
        published += 1;
        return 1;
      },
      recoverPending: () => Promise.resolve(0),
      hostedGroups: ['read-models'],
      idleIntervalMs: 5,
      busyIntervalMs: 1,
    });

    const running = worker.start();
    await new Promise((r) => setTimeout(r, 40));
    await worker.shutdown();
    await running;

    // Whatever the worker counted as published is really on the stream: no
    // publish was abandoned half-done by the shutdown.
    expect(await bus.depth(stream)).toBe(published);
    expect(worker.health().inFlight).toBe(0);
    expect(worker.health().status).toBe('stopped');
  });
});
