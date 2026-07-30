/**
 * The job runner over REAL Redis Streams, fed by the REAL relay.
 *
 * `handlers.test.ts` proves the handler's logic against a fake service and
 * `tests/conformance/jobs.conformance.test.ts` proves the declarations and the
 * envelope. Neither touches a server, so neither can show that a `JobQueued`
 * written to the outbox actually reaches a runner.
 *
 * The path exercised is the whole one — outbox row → existing relay → real
 * stream → real consumer group → the real handler → the transition. What that
 * buys over the stubs is the two properties a server decides: that a
 * redelivered entry is handled once, and that a failed start stays PENDING
 * rather than being acked away. A queued job that nobody starts and nobody
 * reports is the failure this suite exists to rule out.
 *
 * Requires `REDIS_URL`; skips loudly without it and FAILS under `CI`, so the
 * gate cannot rot into a silent pass.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  JobError,
  JOB_RUNNER_GROUP,
  JOB_STREAM,
  type JobExecutor,
  type JobResult,
  type JobService,
} from '@contentos/ai';
import {
  createAggregateBarrier,
  createDispatcher,
  createIdempotencyGuard,
  createRedisClient,
  createRedisStreamsBus,
  createRelay,
  createRetryEngine,
  type EventBus,
  type GuardExecutor,
  type ManagedRedisClient,
  type OutboxRow,
} from '@contentos/events';

import { createConsumerWorker, type ConsumerSubscription } from '../cascade/consumer-worker.js';
import { createJobHandlers } from './handlers.js';

const REDIS_URL = process.env['REDIS_URL'];
const canRun = REDIS_URL !== undefined && REDIS_URL !== '';

if (!canRun) {
  console.warn('[job-worker.integration] SKIPPED — REDIS_URL is not set.');
}

describe('live Redis gate', () => {
  it('is satisfied whenever CI runs', () => {
    if (process.env['CI'] !== undefined && process.env['CI'] !== 'false') {
      expect(canRun, 'CI must provide REDIS_URL for the job runner suite').toBe(true);
    }
  });
});

const describeLive = canRun ? describe : describe.skip;

const ORG = '018f7a1e-0000-7000-8000-0000000000aa';
const WS = '018f7a1e-0000-7000-8000-0000000000bb';

function jobId(seq: number): string {
  return `018f7a1e-0000-7000-7003-${String(seq).padStart(12, '0')}`;
}

/** A JobQueued exactly as the service writes it to the outbox. */
function outboxRow(seq: number): OutboxRow {
  return {
    id: String(seq),
    event_id: `018f7a1e-0000-7000-8000-${String(seq).padStart(12, '0')}`,
    // ADR-017 — the workspace IS the tenant, which is what lets the handler
    // run the transition on the dispatcher's own handle.
    tenant_id: WS,
    organization_id: ORG,
    event_type: 'JobQueued',
    event_version: 1,
    aggregate_type: 'Job',
    aggregate_id: jobId(seq),
    correlation_id: '018f7a1e-0000-7000-8000-0000000000dd',
    causation_id: null,
    producer: 'ai.jobs',
    occurred_at: '2026-07-30T12:00:00.000Z',
    payload: {
      jobId: jobId(seq),
      jobType: 'article.generate',
      workspaceId: WS,
      organizationId: ORG,
    },
    publish_attempts: 0,
  };
}

interface Started {
  readonly jobId: string;
  readonly workspaceId: string;
  readonly causationId: string | null | undefined;
  readonly executor: unknown;
}

/** Records every start, so "exactly once" is countable rather than inferred. */
function recordingJobs(options: { fail?: () => Error } = {}): {
  jobs: JobService;
  started: Started[];
} {
  const started: Started[] = [];
  const jobs = {
    start(
      tx: JobExecutor,
      command: { workspaceId: string; jobId: string; causationId?: string | null },
    ) {
      started.push({
        jobId: command.jobId,
        workspaceId: command.workspaceId,
        causationId: command.causationId,
        executor: tx,
      });
      const failure = options.fail?.();
      if (failure !== undefined) return Promise.reject(failure);
      return Promise.resolve({ job: { id: command.jobId }, event: {} } as unknown as JobResult);
    },
  } as unknown as JobService;
  return { jobs, started };
}

describeLive('the job runner over real Redis', () => {
  let client: ManagedRedisClient;
  let bus: EventBus;
  let stream: string;
  let group: string;
  const streams: string[] = [];
  let counter = 0;

  beforeAll(async () => {
    client = createRedisClient({ url: REDIS_URL ?? '', connectionName: 'jobs-integration' });
    await client.waitUntilReady();
    bus = createRedisStreamsBus({ client });
  });

  afterAll(async () => {
    if (streams.length > 0) await client.raw.del(...streams);
    await bus.shutdown();
  });

  /** Unique per test so offsets and pending entries never bleed between them. */
  async function freshStream(): Promise<void> {
    counter += 1;
    stream = `${JOB_STREAM}-s21-${String(process.pid)}-${String(counter)}`;
    group = `${JOB_RUNNER_GROUP}-${String(counter)}`;
    streams.push(stream);
    await bus.ensureGroup(stream, group);
  }

  /**
   * The real consumer worker, on the real dispatcher.
   *
   * `processed_events` is modelled in memory because the point of THIS suite is
   * Redis; the PostgreSQL side of the same guard is proven by the runtime gate.
   */
  function worker(jobs: JobService, intoGroup = group) {
    const claimed = new Set<string>();
    const subscriptions: ConsumerSubscription[] = [
      {
        stream,
        group: intoGroup,
        // The REAL handlers, re-pointed at this test's unique group.
        handlers: createJobHandlers({ jobs }).map((h) => ({ ...h, group: intoGroup })),
      },
    ];

    return createConsumerWorker({
      bus,
      dispatcher: createDispatcher({
        barrier: createAggregateBarrier(),
        guard: createIdempotencyGuard(),
        retry: createRetryEngine({
          policy: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 2, jitter: 0 },
        }),
        transaction: <T>(work: (tx: GuardExecutor) => Promise<T>): Promise<T> =>
          work({
            query<R>(sql: string, p?: readonly unknown[]): Promise<readonly R[]> {
              if (sql.includes('INSERT INTO processed_events')) {
                const k = `${String(p?.[2])}::${String(p?.[3])}`;
                if (claimed.has(k)) return Promise.resolve([] as unknown as R[]);
                claimed.add(k);
                return Promise.resolve([{ event_id: p?.[3] }] as unknown as R[]);
              }
              return Promise.resolve([] as unknown as R[]);
            },
          } as GuardExecutor),
        quarantine: (): Promise<void> => Promise.resolve(),
        tenantScopeOf: () => 'workspace',
      }),
      subscriptions,
      consumerName: 'job-runner-integration',
      blockMs: 50,
      sleep: () => Promise.resolve(),
    });
  }

  /** The existing relay, publishing outbox rows into the real stream. */
  function relayFor(rows: OutboxRow[]) {
    let drained = false;
    return createRelay({
      transaction: <T>(work: (tx: GuardExecutor) => Promise<T>): Promise<T> =>
        work({
          query<R>(sql: string): Promise<readonly R[]> {
            if (sql.includes('FROM outbox_events') && !drained) {
              drained = true;
              return Promise.resolve(rows as unknown as R[]);
            }
            return Promise.resolve([] as unknown as R[]);
          },
        } as GuardExecutor),
      append: async (event) => {
        await bus.append(stream, event);
        return { ok: true };
      },
      quarantine: (): Promise<void> => Promise.resolve(),
    });
  }

  it('starts a job whose JobQueued travelled the whole path', async () => {
    await freshStream();
    const { jobs, started } = recordingJobs();

    await relayFor([outboxRow(1)]).drainOnce();
    await worker(jobs).runCycle();

    expect(started).toHaveLength(1);
    expect(started[0]?.jobId).toBe(jobId(1));
    expect(started[0]?.workspaceId).toBe(WS);
  });

  // The envelope survived the outbox row, the relay's encoding, a real stream
  // and the decode — `jobId` is the one field the runner cannot do without.
  it('carries the job identity across the wire intact', async () => {
    await freshStream();
    await relayFor([outboxRow(2)]).drainOnce();

    const entries = await bus.readGroup({ stream, group, consumer: 'inspector' });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.event.payload).toEqual({
      jobId: jobId(2),
      jobType: 'article.generate',
      workspaceId: WS,
      organizationId: ORG,
    });
    expect(entries[0]?.event.tenantId).toBe(WS);
    expect(entries[0]?.event.eventType).toBe('JobQueued');
  });

  it('ties the start to the queueing that caused it', async () => {
    await freshStream();
    const { jobs, started } = recordingJobs();

    const row = outboxRow(3);
    await relayFor([row]).drainOnce();
    await worker(jobs).runCycle();

    expect(started[0]?.causationId).toBe(row.event_id);
  });

  it('starts each of several queued jobs exactly once', async () => {
    await freshStream();
    const { jobs, started } = recordingJobs();

    await relayFor([outboxRow(4), outboxRow(5), outboxRow(6)]).drainOnce();
    await worker(jobs).runCycle();

    expect(started.map((s) => s.jobId)).toEqual([jobId(4), jobId(5), jobId(6)]);
    expect(await bus.pendingCount(stream, group)).toBe(0);
  });

  // THE property this suite exists for. At-least-once delivery is the bus's
  // contract; starting a job twice would be the platform's bug.
  it('starts a job once even when the same JobQueued is delivered twice', async () => {
    await freshStream();
    const { jobs, started } = recordingJobs();
    const runner = worker(jobs);

    const row = outboxRow(7);
    // Two entries, one event id — a relay retry after a failed ack.
    await relayFor([row]).drainOnce();
    await bus.append(stream, {
      eventId: row.event_id,
      eventType: 'JobQueued',
      eventVersion: 1,
      aggregateType: 'Job',
      aggregateId: row.aggregate_id,
      tenantId: WS,
      organizationId: ORG,
      correlationId: row.correlation_id,
      causationId: null,
      producer: 'ai.jobs',
      occurredAt: row.occurred_at,
      payload: row.payload,
    });

    await runner.runCycle();

    expect(started).toHaveLength(1);
    expect(await bus.pendingCount(stream, group)).toBe(0);
  });

  // A start that failed transiently must be retried, and the only thing that
  // makes that possible is the entry staying pending for XAUTOCLAIM.
  it('leaves a failed start pending on the real stream', async () => {
    await freshStream();
    const { jobs } = recordingJobs({ fail: () => new Error('connection reset') });

    await relayFor([outboxRow(8)]).drainOnce();
    await worker(jobs).runCycle();

    expect(await bus.pendingCount(stream, group)).toBe(1);
  });

  // A job someone else already claimed is the bus behaving correctly, so the
  // entry is acked rather than redelivered forever.
  it('acks an event for a job another runner already claimed', async () => {
    await freshStream();
    const { jobs, started } = recordingJobs({
      fail: () => new JobError('IllegalTransition', 'was running'),
    });

    await relayFor([outboxRow(9)]).drainOnce();
    await worker(jobs).runCycle();

    expect(started).toHaveLength(1);
    expect(await bus.pendingCount(stream, group)).toBe(0);
  });

  // The four other job types travel the same stream and no group reads them:
  // they are emitted for consumers that do not exist yet, and must not stall
  // the runner's group behind them.
  it('acks the four job events it does not handle', async () => {
    await freshStream();
    const { jobs, started } = recordingJobs();

    for (const eventType of ['JobStarted', 'JobCompleted', 'JobFailed', 'JobCancelled']) {
      await bus.append(stream, {
        eventId: `018f7a1e-0000-7000-8000-0000000000${eventType.length.toString(16).padStart(2, '0')}`,
        eventType,
        eventVersion: 1,
        aggregateType: 'Job',
        aggregateId: jobId(10),
        tenantId: WS,
        organizationId: ORG,
        correlationId: '018f7a1e-0000-7000-8000-0000000000dd',
        causationId: null,
        producer: 'ai.jobs',
        occurredAt: '2026-07-30T12:00:00.000Z',
        payload: { jobId: jobId(10), jobType: 'article.generate', workspaceId: WS },
      });
    }

    await worker(jobs).runCycle();

    expect(started).toHaveLength(0);
    expect(await bus.pendingCount(stream, group)).toBe(0);
  });

  // Replay: history re-read from the start of the stream by a new group, which
  // is how a rebuild catches up. Created at '0' with the raw client on purpose
  // — `ensureGroup` starts at '$' so that a restart never reprocesses history,
  // which makes replay an explicit act rather than an accident.
  it('replays the stream from the beginning into a fresh group', async () => {
    await freshStream();
    await relayFor([outboxRow(11), outboxRow(12)]).drainOnce();
    // The runner's own group consumed them; replay must not depend on that.
    await worker(recordingJobs().jobs).runCycle();

    const replayGroup = `${group}-replay`;
    await client.raw.xgroup('CREATE', stream, replayGroup, '0');

    const { jobs, started } = recordingJobs();
    await worker(jobs, replayGroup).runCycle();

    expect(started.map((s) => s.jobId)).toEqual([jobId(11), jobId(12)]);
  });
});
