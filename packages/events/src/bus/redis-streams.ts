/**
 * Redis Streams event bus — ADR-020.
 *
 * Spec: `13-event-platform/event-bus.md`, `consumer-groups.md`.
 *
 * "Redis is transport; PostgreSQL is truth." This adapter moves already-durable
 * events; it is never the record of whether one exists. Losing a stream entry
 * is recoverable — the outbox row is still unpublished, and the relay re-sends.
 *
 * `EventBus` IS THE SWAP POINT. `entryId` is OPAQUE and never persisted by a
 * consumer, so replacing Redis Streams with Kafka at scale touches this file
 * and nothing else.
 */

import type { DomainEvent } from '@contentos/contracts';

import { createEventSerializer, type EventSerializer } from '../serializer/serializer.js';

/** Opaque, transport-specific. A consumer must never store or interpret it. */
export type BusEntryId = string;

export interface DeliveredEvent {
  readonly entryId: BusEntryId;
  readonly event: DomainEvent<unknown>;
  readonly deliveryCount: number;
  readonly stream: string;
}

/**
 * The subset of a Redis client this adapter uses.
 *
 * Declared as a port rather than importing `ioredis` directly, so the adapter
 * is unit-testable without a server and the driver stays replaceable. The
 * concrete client is constructed at the process edge.
 */
export interface RedisStreamsClient {
  xadd(stream: string, id: string, ...fieldValues: string[]): Promise<string | null>;
  xgroup(...args: string[]): Promise<unknown>;
  xreadgroup(...args: (string | number)[]): Promise<unknown>;
  xack(stream: string, group: string, ...ids: string[]): Promise<number>;
  xautoclaim(...args: (string | number)[]): Promise<unknown>;
  xlen(stream: string): Promise<number>;
  xtrim(...args: (string | number)[]): Promise<number>;
  xpending(...args: (string | number)[]): Promise<unknown>;
  quit(): Promise<unknown>;
}

export interface ReadGroupOptions {
  readonly stream: string;
  readonly group: string;
  readonly consumer: string;
  readonly count?: number;
  readonly blockMs?: number;
}

export interface ClaimOptions {
  readonly stream: string;
  readonly group: string;
  readonly consumer: string;
  /** Entries idle longer than this are considered abandoned. */
  readonly minIdleMs: number;
  readonly count?: number;
}

export interface ClaimResult {
  readonly events: readonly DeliveredEvent[];
  /** Cursor for the next XAUTOCLAIM sweep. '0-0' means the scan wrapped. */
  readonly cursor: string;
}

export interface EventBus {
  append(stream: string, event: DomainEvent<unknown>): Promise<BusEntryId>;
  ensureGroup(stream: string, group: string): Promise<void>;
  readGroup(options: ReadGroupOptions): Promise<readonly DeliveredEvent[]>;
  ack(stream: string, group: string, entryId: BusEntryId): Promise<number>;
  /** Recovers entries a dead consumer left pending. */
  claimStalled(options: ClaimOptions, cursor?: string): Promise<ClaimResult>;
  pendingCount(stream: string, group: string): Promise<number>;
  depth(stream: string): Promise<number>;
  trim(stream: string, maxLength: number): Promise<number>;
  shutdown(): Promise<void>;
}

/** Redis errors worth another attempt: the server is unreachable, not wrong. */
const TRANSIENT_PATTERNS = [
  /ECONNRESET/i,
  /ECONNREFUSED/i,
  /ETIMEDOUT/i,
  /EPIPE/i,
  /Connection is closed/i,
  /Stream isn't writeable/i,
  /LOADING/i,
  /READONLY/i,
  /CLUSTERDOWN/i,
  /max number of clients/i,
];

export function isTransientRedisError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return TRANSIENT_PATTERNS.some((p) => p.test(message));
}

export class BusShutdownError extends Error {
  readonly code = 'BusShuttingDown';
  constructor() {
    super('The event bus is shutting down and accepted no further work.');
    this.name = 'BusShutdownError';
  }
}

export interface RedisStreamsBusOptions {
  readonly client: RedisStreamsClient;
  readonly serializer?: EventSerializer;
  /** Attempts for a transient failure, including the first. */
  readonly maxAttempts?: number;
  readonly baseDelayMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  /**
   * Back-pressure: refuse to append when the stream is longer than this.
   * Unbounded growth would consume the memory Redis needs to serve reads, so
   * the producer is told to slow down rather than the whole bus degrading.
   */
  readonly maxStreamLength?: number;
  readonly onTransientRetry?: (attempt: number, message: string) => void;
  readonly onBackPressure?: (stream: string, depth: number) => void;
}

export const DEFAULT_MAX_ATTEMPTS = 3;
export const DEFAULT_BASE_DELAY_MS = 50;

/** Raised when the stream is over its high-water mark. Transient by nature. */
export class BackPressureError extends Error {
  readonly code = 'BusBackPressure';
  constructor(stream: string, depth: number) {
    super(`Stream '${stream}' is at depth ${String(depth)} and is refusing writes.`);
    this.name = 'BackPressureError';
  }
}

/** Redis returns stream replies as deeply nested arrays; these narrow them safely. */
function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function fieldsToRecord(flat: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const entries = asArray(flat);
  for (let i = 0; i + 1 < entries.length; i += 2) {
    out[String(entries[i])] = String(entries[i + 1]);
  }
  return out;
}

export function createRedisStreamsBus(options: RedisStreamsBusOptions): EventBus {
  const client = options.client;
  const serializer = options.serializer ?? createEventSerializer();
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const baseDelay = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const sleep =
    options.sleep ?? ((ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)));
  let closing = false;

  /**
   * Retry only TRANSIENT failures, and only a bounded number of times.
   *
   * A wrong command is deterministic — retrying it burns time to reach the same
   * error. An unreachable server is worth another attempt, because the relay's
   * alternative is to leave the row unpublished and try again later anyway.
   */
  async function withRetry<T>(operation: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (closing) throw new BusShutdownError();
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        if (!isTransientRedisError(error)) throw error;
        options.onTransientRetry?.(attempt, error instanceof Error ? error.message : String(error));
        if (attempt === maxAttempts) break;
        await sleep(baseDelay * 2 ** (attempt - 1));
      }
    }
    throw lastError;
  }

  function toDelivered(stream: string, entry: unknown): DeliveredEvent | null {
    const pair = asArray(entry);
    const entryId = pair[0];
    if (typeof entryId !== 'string') return null;
    const fields = fieldsToRecord(pair[1]);
    return {
      entryId,
      event: serializer.fromStreamFields(fields),
      // Redis does not report delivery count on XREADGROUP; it is authoritative
      // only via XPENDING, so 1 is the honest value for a fresh read.
      deliveryCount: 1,
      stream,
    };
  }

  return {
    async append(stream, event): Promise<BusEntryId> {
      if (closing) throw new BusShutdownError();

      if (options.maxStreamLength !== undefined) {
        const depth = await withRetry(() => client.xlen(stream));
        if (depth > options.maxStreamLength) {
          options.onBackPressure?.(stream, depth);
          throw new BackPressureError(stream, depth);
        }
      }

      // The serializer validates before encoding, so a malformed event never
      // reaches the wire.
      const fields = serializer.toStreamFields(event);
      const flat: string[] = [];
      for (const [k, v] of Object.entries(fields)) flat.push(k, v);

      // '*' lets Redis assign a monotonically increasing id, which is what
      // preserves per-stream append order.
      const id = await withRetry(() => client.xadd(stream, '*', ...flat));
      if (id === null) {
        throw new Error(`XADD to '${stream}' returned no id.`);
      }
      return id;
    },

    /**
     * Creating the group is idempotent. BUSYGROUP means it already exists,
     * which is the normal case on every start after the first.
     */
    async ensureGroup(stream, group): Promise<void> {
      try {
        await withRetry(() => client.xgroup('CREATE', stream, group, '$', 'MKSTREAM'));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/BUSYGROUP/i.test(message)) throw error;
      }
    },

    async readGroup(opts): Promise<readonly DeliveredEvent[]> {
      if (closing) return [];
      const args: (string | number)[] = [
        'GROUP',
        opts.group,
        opts.consumer,
        'COUNT',
        opts.count ?? 10,
      ];
      if (opts.blockMs !== undefined) args.push('BLOCK', opts.blockMs);
      // '>' delivers only entries never handed to this group before.
      args.push('STREAMS', opts.stream, '>');

      const reply = await withRetry(() => client.xreadgroup(...args));
      const streams = asArray(reply);
      const delivered: DeliveredEvent[] = [];
      for (const streamReply of streams) {
        const parts = asArray(streamReply);
        const name = String(parts[0]);
        for (const entry of asArray(parts[1])) {
          const event = toDelivered(name, entry);
          if (event !== null) delivered.push(event);
        }
      }
      return delivered;
    },

    /**
     * Acknowledge only AFTER the handler's transaction committed. Acking first
     * would drop the event on a crash — the entry would be gone from the
     * pending list with no effect recorded.
     */
    ack(stream, group, entryId): Promise<number> {
      return withRetry(() => client.xack(stream, group, entryId));
    },

    /**
     * XAUTOCLAIM recovers entries a consumer read but never acked — the crash
     * case. Without it a dead worker's in-flight events stay pending forever,
     * which is silent event loss by another name.
     */
    async claimStalled(opts, cursor = '0-0'): Promise<ClaimResult> {
      const reply = await withRetry(() =>
        client.xautoclaim(
          opts.stream,
          opts.group,
          opts.consumer,
          opts.minIdleMs,
          cursor,
          'COUNT',
          opts.count ?? 10,
        ),
      );
      const parts = asArray(reply);
      const nextCursor = typeof parts[0] === 'string' ? parts[0] : '0-0';
      const events: DeliveredEvent[] = [];
      for (const entry of asArray(parts[1])) {
        const event = toDelivered(opts.stream, entry);
        // A claimed entry has been delivered at least twice by definition.
        if (event !== null) events.push({ ...event, deliveryCount: 2 });
      }
      return { events, cursor: nextCursor };
    },

    async pendingCount(stream, group): Promise<number> {
      const reply = await withRetry(() => client.xpending(stream, group));
      const count = asArray(reply)[0];
      return typeof count === 'number' ? count : 0;
    },

    depth(stream): Promise<number> {
      return withRetry(() => client.xlen(stream));
    },

    /** Approximate trimming: exact trimming is O(n) and blocks the server. */
    trim(stream, maxLength): Promise<number> {
      return withRetry(() => client.xtrim(stream, 'MAXLEN', '~', maxLength));
    },

    /**
     * Graceful shutdown. New work is refused immediately so nothing is accepted
     * that cannot be completed, then the connection closes. In-flight
     * operations are left to finish — cancelling them mid-flight is what
     * produces the ambiguous "did it append?" state.
     */
    async shutdown(): Promise<void> {
      if (closing) return;
      closing = true;
      await client.quit();
    },
  };
}
