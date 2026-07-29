import { describe, expect, it } from 'vitest';

import type { DomainEvent } from '@contentos/contracts';

import { createEventSerializer } from '../serializer/serializer.js';
import {
  BackPressureError,
  BusShutdownError,
  createRedisStreamsBus,
  isTransientRedisError,
  type RedisStreamsClient,
} from './redis-streams.js';

const serializer = createEventSerializer();

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

/** Redis replies as nested arrays, which is what the adapter must narrow. */
function entryReply(id: string, ev: DomainEvent<unknown>): unknown {
  const flat: string[] = [];
  for (const [k, v] of Object.entries(serializer.toStreamFields(ev))) flat.push(k, v);
  return [id, flat];
}

interface Calls {
  xadd: unknown[][];
  xack: unknown[][];
  xgroup: unknown[][];
  xreadgroup: unknown[][];
  xautoclaim: unknown[][];
  xtrim: unknown[][];
  quit: number;
}

function client(over: Partial<RedisStreamsClient> = {}): RedisStreamsClient & { calls: Calls } {
  const calls: Calls = {
    xadd: [],
    xack: [],
    xgroup: [],
    xreadgroup: [],
    xautoclaim: [],
    xtrim: [],
    quit: 0,
  };
  const base: RedisStreamsClient = {
    xadd: (...args) => {
      calls.xadd.push(args);
      return Promise.resolve('1-0');
    },
    xgroup: (...args) => {
      calls.xgroup.push(args);
      return Promise.resolve('OK');
    },
    xreadgroup: (...args) => {
      calls.xreadgroup.push(args);
      return Promise.resolve([]);
    },
    xack: (...args) => {
      calls.xack.push(args);
      return Promise.resolve(1);
    },
    xautoclaim: (...args) => {
      calls.xautoclaim.push(args);
      return Promise.resolve(['0-0', []]);
    },
    xlen: () => Promise.resolve(0),
    xtrim: (...args) => {
      calls.xtrim.push(args);
      return Promise.resolve(0);
    },
    xpending: () => Promise.resolve([0]),
    quit: () => {
      calls.quit += 1;
      return Promise.resolve('OK');
    },
  };
  return Object.assign(base, over, { calls });
}

const noSleep = (): Promise<void> => Promise.resolve();

describe('append', () => {
  it('XADDs with a server-assigned id, preserving append order', async () => {
    const c = client();
    const id = await createRedisStreamsBus({ client: c }).append('article', event());
    expect(id).toBe('1-0');
    expect(c.calls.xadd[0]?.[0]).toBe('article');
    expect(c.calls.xadd[0]?.[1]).toBe('*');
  });

  it('encodes the envelope through the serializer', async () => {
    const c = client();
    await createRedisStreamsBus({ client: c }).append('article', event());
    const flat = c.calls.xadd[0]?.slice(2) as string[];
    expect(flat).toContain('eventId');
    expect(flat).toContain('018f7a1e-0000-7000-8000-000000000001');
  });

  // A malformed event must never reach the wire.
  it('refuses to append an invalid envelope', async () => {
    const c = client();
    await expect(
      createRedisStreamsBus({ client: c }).append('article', event({ tenantId: 'nope' })),
    ).rejects.toThrow(/tenantId/);
    expect(c.calls.xadd).toHaveLength(0);
  });

  it('fails when XADD returns no id', async () => {
    const c = client({ xadd: () => Promise.resolve(null) });
    await expect(createRedisStreamsBus({ client: c }).append('article', event())).rejects.toThrow(
      /returned no id/,
    );
  });
});

describe('transient failure handling', () => {
  it('classifies connection failures as transient', () => {
    for (const m of ['ECONNRESET', 'Connection is closed', 'LOADING Redis', 'CLUSTERDOWN']) {
      expect(isTransientRedisError(new Error(m))).toBe(true);
    }
  });

  // A wrong command is deterministic; retrying reaches the same error.
  it('classifies a command error as NOT transient', () => {
    expect(isTransientRedisError(new Error('ERR wrong number of arguments'))).toBe(false);
  });

  it('retries a transient failure and succeeds', async () => {
    let attempts = 0;
    const c = client({
      xadd: () => {
        attempts += 1;
        if (attempts < 3) return Promise.reject(new Error('ECONNRESET'));
        return Promise.resolve('9-0');
      },
    });
    const bus = createRedisStreamsBus({ client: c, sleep: noSleep });
    expect(await bus.append('article', event())).toBe('9-0');
    expect(attempts).toBe(3);
  });

  it('does NOT retry a non-transient failure', async () => {
    let attempts = 0;
    const c = client({
      xadd: () => {
        attempts += 1;
        return Promise.reject(new Error('ERR bad command'));
      },
    });
    await expect(
      createRedisStreamsBus({ client: c, sleep: noSleep }).append('article', event()),
    ).rejects.toThrow(/bad command/);
    expect(attempts).toBe(1);
  });

  it('gives up after maxAttempts and surfaces the failure', async () => {
    let attempts = 0;
    const c = client({
      xadd: () => {
        attempts += 1;
        return Promise.reject(new Error('ETIMEDOUT'));
      },
    });
    await expect(
      createRedisStreamsBus({ client: c, sleep: noSleep, maxAttempts: 4 }).append('a', event()),
    ).rejects.toThrow(/ETIMEDOUT/);
    expect(attempts).toBe(4);
  });
});

describe('consumer groups', () => {
  it('creates the group with MKSTREAM', async () => {
    const c = client();
    await createRedisStreamsBus({ client: c }).ensureGroup('article', 'read-models');
    expect(c.calls.xgroup[0]).toEqual(['CREATE', 'article', 'read-models', '$', 'MKSTREAM']);
  });

  // The normal case on every start after the first.
  it('tolerates BUSYGROUP', async () => {
    const c = client({ xgroup: () => Promise.reject(new Error('BUSYGROUP already exists')) });
    await expect(
      createRedisStreamsBus({ client: c }).ensureGroup('article', 'g'),
    ).resolves.toBeUndefined();
  });

  it('surfaces a non-BUSYGROUP failure', async () => {
    const c = client({ xgroup: () => Promise.reject(new Error('ERR no such key')) });
    await expect(createRedisStreamsBus({ client: c }).ensureGroup('a', 'g')).rejects.toThrow(
      /no such key/,
    );
  });

  it('reads only never-delivered entries with >', async () => {
    const c = client();
    await createRedisStreamsBus({ client: c }).readGroup({
      stream: 'article',
      group: 'read-models',
      consumer: 'w1',
      count: 5,
    });
    expect(c.calls.xreadgroup[0]).toEqual([
      'GROUP',
      'read-models',
      'w1',
      'COUNT',
      5,
      'STREAMS',
      'article',
      '>',
    ]);
  });

  it('decodes delivered entries back into envelopes', async () => {
    const original = event();
    const c = client({
      xreadgroup: () => Promise.resolve([['article', [entryReply('5-0', original)]]]),
    });
    const delivered = await createRedisStreamsBus({ client: c }).readGroup({
      stream: 'article',
      group: 'g',
      consumer: 'w1',
    });
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.entryId).toBe('5-0');
    expect(delivered[0]?.event).toEqual(original);
  });

  it('returns nothing when the stream is empty', async () => {
    const delivered = await createRedisStreamsBus({ client: client() }).readGroup({
      stream: 'a',
      group: 'g',
      consumer: 'w1',
    });
    expect(delivered).toEqual([]);
  });

  it('passes BLOCK when requested', async () => {
    const c = client();
    await createRedisStreamsBus({ client: c }).readGroup({
      stream: 'a',
      group: 'g',
      consumer: 'w1',
      blockMs: 2000,
    });
    expect(c.calls.xreadgroup[0]).toContain('BLOCK');
  });
});

describe('acknowledgement', () => {
  it('XACKs a single entry', async () => {
    const c = client();
    await createRedisStreamsBus({ client: c }).ack('article', 'g', '5-0');
    expect(c.calls.xack[0]).toEqual(['article', 'g', '5-0']);
  });
});

describe('pending recovery — XAUTOCLAIM', () => {
  // Without this a dead worker's in-flight events stay pending forever.
  it('claims entries idle beyond the threshold', async () => {
    const c = client();
    await createRedisStreamsBus({ client: c }).claimStalled({
      stream: 'article',
      group: 'g',
      consumer: 'w2',
      minIdleMs: 30_000,
      count: 7,
    });
    expect(c.calls.xautoclaim[0]).toEqual(['article', 'g', 'w2', 30_000, '0-0', 'COUNT', 7]);
  });

  it('returns the claimed events and the next cursor', async () => {
    const original = event();
    const c = client({
      xautoclaim: () => Promise.resolve(['7-0', [entryReply('6-0', original)]]),
    });
    const result = await createRedisStreamsBus({ client: c }).claimStalled({
      stream: 'article',
      group: 'g',
      consumer: 'w2',
      minIdleMs: 1000,
    });
    expect(result.cursor).toBe('7-0');
    expect(result.events[0]?.event).toEqual(original);
  });

  // A claimed entry has been delivered at least twice by definition.
  it('marks a claimed entry as redelivered', async () => {
    const c = client({
      xautoclaim: () => Promise.resolve(['0-0', [entryReply('6-0', event())]]),
    });
    const result = await createRedisStreamsBus({ client: c }).claimStalled({
      stream: 'a',
      group: 'g',
      consumer: 'w2',
      minIdleMs: 1000,
    });
    expect(result.events[0]?.deliveryCount).toBe(2);
  });

  it('resumes from a supplied cursor', async () => {
    const c = client();
    await createRedisStreamsBus({ client: c }).claimStalled(
      { stream: 'a', group: 'g', consumer: 'w2', minIdleMs: 1000 },
      '42-1',
    );
    expect(c.calls.xautoclaim[0]?.[4]).toBe('42-1');
  });
});

describe('back-pressure', () => {
  // Unbounded growth consumes the memory Redis needs to serve reads.
  it('refuses to append past the high-water mark', async () => {
    const c = client({ xlen: () => Promise.resolve(5000) });
    const bus = createRedisStreamsBus({ client: c, maxStreamLength: 1000 });
    await expect(bus.append('article', event())).rejects.toThrow(BackPressureError);
    expect(c.calls.xadd).toHaveLength(0);
  });

  it('reports back-pressure so a producer can slow down', async () => {
    let seen: number | null = null;
    const c = client({ xlen: () => Promise.resolve(5000) });
    const bus = createRedisStreamsBus({
      client: c,
      maxStreamLength: 1000,
      onBackPressure: (_s, depth) => (seen = depth),
    });
    await expect(bus.append('a', event())).rejects.toThrow();
    expect(seen).toBe(5000);
  });

  it('appends normally below the mark', async () => {
    const c = client({ xlen: () => Promise.resolve(10) });
    const bus = createRedisStreamsBus({ client: c, maxStreamLength: 1000 });
    await expect(bus.append('a', event())).resolves.toBe('1-0');
  });

  it('trims approximately, since exact trimming blocks the server', async () => {
    const c = client();
    await createRedisStreamsBus({ client: c }).trim('article', 10_000);
    expect(c.calls.xtrim[0]).toEqual(['article', 'MAXLEN', '~', 10_000]);
  });
});

describe('graceful shutdown', () => {
  it('closes the connection', async () => {
    const c = client();
    await createRedisStreamsBus({ client: c }).shutdown();
    expect(c.calls.quit).toBe(1);
  });

  // Nothing is accepted that cannot be completed.
  it('refuses new appends once shutting down', async () => {
    const bus = createRedisStreamsBus({ client: client() });
    await bus.shutdown();
    await expect(bus.append('a', event())).rejects.toThrow(BusShutdownError);
  });

  it('stops delivering reads once shutting down', async () => {
    const bus = createRedisStreamsBus({ client: client() });
    await bus.shutdown();
    expect(await bus.readGroup({ stream: 'a', group: 'g', consumer: 'w1' })).toEqual([]);
  });

  it('is idempotent', async () => {
    const c = client();
    const bus = createRedisStreamsBus({ client: c });
    await bus.shutdown();
    await bus.shutdown();
    expect(c.calls.quit).toBe(1);
  });
});
