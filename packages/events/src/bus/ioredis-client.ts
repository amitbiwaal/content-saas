/**
 * The real Redis client binding — ADR-020.
 *
 * `redis-streams.ts` declares `RedisStreamsClient` as a PORT so the adapter is
 * unit-testable without a server. This file is the one place that constructs
 * the concrete driver, which keeps `ioredis` behind a single import and leaves
 * the bus swappable (`event-bus.md`: "Redis is transport").
 *
 * Nothing above this file may import `ioredis` directly — the ESLint boundary
 * rule enforces that, because a raw client is also a way to reach unprefixed
 * keys that are shared state across tenants.
 */

// The NAMED export, not the default: `ioredis` is CommonJS (`export =`), and
// its default binding is the module namespace under ESM interop.
import { Redis, type RedisOptions } from 'ioredis';

import type { RedisStreamsClient } from './redis-streams.js';

export interface RedisConnectionOptions {
  /** `redis://` or `rediss://`. */
  readonly url: string;
  /** Distinguishes connections in `CLIENT LIST` when a stall needs diagnosing. */
  readonly connectionName?: string;
  readonly onError?: (error: Error) => void;
}

/**
 * Connection defaults, and why they are not ioredis's.
 *
 * `maxRetriesPerRequest: 1` — THE ADAPTER OWNS RETRY. `withRetry` in
 * `redis-streams.ts` already bounds transient attempts and reports each one, so
 * leaving ioredis's default of 20 in place would multiply the two policies
 * together and turn a bounded 3-attempt publish into a minutes-long hang that
 * no metric explains.
 *
 * `enableOfflineQueue: false` — a command issued while disconnected must FAIL
 * rather than queue silently. A queued XADD looks accepted to the relay, which
 * would mark the outbox row published for an event the bus never received.
 * Failing fast keeps the row unpublished, which is the recoverable state.
 */
export const REDIS_CLIENT_DEFAULTS: Readonly<RedisOptions> = Object.freeze({
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
  enableReadyCheck: true,
  // Bounded, jittered backoff. Reconnecting is desirable; reconnecting in a
  // tight loop against a server that is down is a denial of service we inflict
  // on ourselves.
  retryStrategy: (times: number): number => Math.min(times * 200, 5_000),
});

/**
 * `ioredis` types its stream commands through a large overload set that a
 * variadic port cannot satisfy structurally. The port is the narrower contract
 * — a fixed list of commands returning `unknown`, parsed by the adapter — so
 * the driver is adapted to it here, in one place, rather than loosening the
 * port for every caller.
 */
type StreamArg = string | number;
interface VariadicCommands {
  xadd: (...args: StreamArg[]) => Promise<unknown>;
  xgroup: (...args: StreamArg[]) => Promise<unknown>;
  xreadgroup: (...args: StreamArg[]) => Promise<unknown>;
  xack: (...args: StreamArg[]) => Promise<unknown>;
  xautoclaim: (...args: StreamArg[]) => Promise<unknown>;
  xlen: (...args: StreamArg[]) => Promise<unknown>;
  xtrim: (...args: StreamArg[]) => Promise<unknown>;
  xpending: (...args: StreamArg[]) => Promise<unknown>;
}

export interface ManagedRedisClient extends RedisStreamsClient {
  /** Escape hatch for operational commands; not for event traffic. */
  readonly raw: Redis;
  /**
   * Resolves once the connection is usable.
   *
   * REQUIRED BEFORE THE FIRST COMMAND, because `enableOfflineQueue: false`
   * means a command issued while connecting FAILS rather than waiting. That is
   * the correct trade for event traffic — a silently queued XADD would let the
   * relay mark an outbox row published for an event Redis never saw — but it
   * makes "wait for ready" the caller's job, and a worker's readiness probe
   * should not pass before this resolves.
   */
  waitUntilReady(timeoutMs?: number): Promise<void>;
}

export const DEFAULT_READY_TIMEOUT_MS = 10_000;

export function createRedisClient(options: RedisConnectionOptions): ManagedRedisClient {
  const client = new Redis(options.url, {
    ...REDIS_CLIENT_DEFAULTS,
    ...(options.connectionName === undefined ? {} : { connectionName: options.connectionName }),
  });

  // An unhandled 'error' event on an ioredis client crashes the process. A
  // worker must survive a Redis blip: the outbox is still truth, so a
  // disconnect costs latency, not events.
  client.on('error', (error: Error) => {
    options.onError?.(error);
  });

  const commands = client as unknown as VariadicCommands;

  return {
    raw: client,

    waitUntilReady(timeoutMs = DEFAULT_READY_TIMEOUT_MS): Promise<void> {
      if (client.status === 'ready') return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error(`Redis was not ready within ${String(timeoutMs)}ms.`));
        }, timeoutMs);

        function cleanup(): void {
          clearTimeout(timer);
          client.off('ready', onReady);
          client.off('end', onEnd);
        }
        function onReady(): void {
          cleanup();
          resolve();
        }
        // 'end' means ioredis has stopped retrying. Waiting past that would
        // hang until the timeout for a connection that is never coming back.
        function onEnd(): void {
          cleanup();
          reject(new Error('Redis connection ended before becoming ready.'));
        }

        client.once('ready', onReady);
        client.once('end', onEnd);
      });
    },

    xadd: (stream, id, ...fieldValues) =>
      commands.xadd(stream, id, ...fieldValues) as Promise<string | null>,
    xgroup: (...args) => commands.xgroup(...args),
    xreadgroup: (...args) => commands.xreadgroup(...args),
    xack: (stream, group, ...ids) => commands.xack(stream, group, ...ids) as Promise<number>,
    xautoclaim: (...args) => commands.xautoclaim(...args),
    xlen: (stream) => commands.xlen(stream) as Promise<number>,
    xtrim: (...args) => commands.xtrim(...args) as Promise<number>,
    xpending: (...args) => commands.xpending(...args),
    quit: () => client.quit(),
  };
}
