/**
 * The job runner handler.
 *
 * Two properties carry this file: the transition runs on the DISPATCHER'S
 * transaction — which is what makes a redelivery unable to start a job twice —
 * and a job someone else already claimed is treated as success rather than
 * dead-lettered.
 */
import { describe, expect, it } from 'vitest';

import {
  JobError,
  type JobExecutor,
  type JobResult,
  type JobService,
  JOB_RUNNER_GROUP,
} from '@contentos/ai';
import type { DomainEvent } from '@contentos/contracts';
import type { GuardExecutor } from '@contentos/events';

import { createJobHandlers, JobStartFailedError } from './handlers.js';

const ORG = '018f7a1e-0000-7000-8000-0000000000aa';
const WS = '018f7a1e-0000-7000-8000-0000000000bb';
const JOB = '018f7a1e-0000-7000-7003-000000000001';
const EVENT_ID = '018f7a1e-0000-7000-8000-0000000000ee';
const CORRELATION = '018f7a1e-0000-7000-8000-0000000000dd';

interface Recorded {
  readonly commands: { workspaceId: string; jobId: string; causationId?: string | null }[];
  readonly executors: unknown[];
}

function harness(options: { fail?: Error } = {}) {
  const recorded: Recorded = { commands: [], executors: [] };

  const jobs = {
    start(tx: JobExecutor, command: { workspaceId: string; jobId: string }) {
      recorded.executors.push(tx);
      recorded.commands.push(command);
      if (options.fail !== undefined) return Promise.reject(options.fail);
      return Promise.resolve({ job: { id: JOB }, event: {} } as unknown as JobResult);
    },
  } as unknown as JobService;

  return { handlers: createJobHandlers({ jobs }), recorded };
}

function event(payload: Record<string, unknown>, over: Partial<DomainEvent<unknown>> = {}) {
  return {
    eventId: EVENT_ID,
    eventType: 'JobQueued',
    eventVersion: 1,
    aggregateType: 'Job',
    aggregateId: JOB,
    tenantId: WS,
    organizationId: ORG,
    correlationId: CORRELATION,
    causationId: null,
    producer: 'ai.jobs',
    occurredAt: '2026-07-30T12:00:00.000Z',
    payload,
    ...over,
  } as DomainEvent<unknown>;
}

const GUARD_TX = { query: () => Promise.resolve([]) } as unknown as GuardExecutor;

async function run(
  handlers: ReturnType<typeof harness>['handlers'],
  e: DomainEvent<unknown>,
  tx: GuardExecutor = GUARD_TX,
): Promise<void> {
  const handler = handlers[0];
  expect(handler).toBeDefined();
  if (handler === undefined) return;
  await handler.handle(
    e,
    { tenantId: e.tenantId, organizationId: e.organizationId, source: 'event' },
    tx,
    new AbortController().signal,
  );
}

describe('the handler subscribes to JobQueued alone', () => {
  it('registers one handler, for JobQueued', () => {
    const { handlers } = harness();
    expect(handlers.map((h) => h.eventType)).toEqual(['JobQueued']);
    expect(handlers[0]?.group).toBe(JOB_RUNNER_GROUP);
    expect(handlers[0]?.version).toBe(1);
  });

  // Composition refuses a handler whose scope disagrees with the declaration,
  // and it is the workspace scope that lets the transition use this handle.
  it('declares the workspace scope the event carries', () => {
    const { handlers } = harness();
    expect(handlers[0]?.tenantScope).toBe('workspace');
  });
});

describe('it moves the job to running', () => {
  it('starts the job named in the payload', async () => {
    const { handlers, recorded } = harness();
    await run(handlers, event({ jobId: JOB, workspaceId: WS }));

    expect(recorded.commands).toHaveLength(1);
    expect(recorded.commands[0]).toMatchObject({ workspaceId: WS, jobId: JOB });
  });

  it('ties the start to the queueing that caused it', async () => {
    const { handlers, recorded } = harness();
    await run(handlers, event({ jobId: JOB, workspaceId: WS }));
    expect(recorded.commands[0]?.causationId).toBe(EVENT_ID);
  });

  it('falls back to the envelope tenant when the payload omits the workspace', async () => {
    const { handlers, recorded } = harness();
    await run(handlers, event({ jobId: JOB }));
    expect(recorded.commands[0]?.workspaceId).toBe(WS);
  });

  // The state change, the JobStarted outbox row and the processed_events marker
  // commit together, so a redelivery cannot start a job twice.
  it('uses the handle it was given, opening no connection of its own', async () => {
    const { handlers, recorded } = harness();
    const tx = { query: () => Promise.resolve([]) } as unknown as GuardExecutor;
    await run(handlers, event({ jobId: JOB, workspaceId: WS }), tx);
    expect(recorded.executors).toEqual([tx]);
  });

  // A malformed payload is a contract violation, not a transient fault.
  it('dead-letters an event with no job id', async () => {
    const { handlers } = harness();
    await expect(run(handlers, event({ workspaceId: WS }))).rejects.toMatchObject({
      code: 'SchemaViolation',
    });
  });
});

describe('a job someone else already claimed is not a failure', () => {
  // The service's predicate refused the second start. A redelivered JobQueued
  // is the bus behaving correctly.
  it('treats an illegal transition as success', async () => {
    const { handlers } = harness({
      fail: new JobError('IllegalTransition', 'was running by a concurrent caller'),
    });
    await expect(run(handlers, event({ jobId: JOB, workspaceId: WS }))).resolves.toBeUndefined();
  });

  it('still fails on any other JobError', async () => {
    const { handlers } = harness({ fail: new JobError('JobNotFound', 'gone') });
    await expect(run(handlers, event({ jobId: JOB, workspaceId: WS }))).rejects.toThrow(
      JobStartFailedError,
    );
  });
});

describe('a failed start retries rather than dead-letters', () => {
  // A queued job nobody started is work a customer asked for and never got.
  it('wraps the cause in a transient failure', async () => {
    const { handlers } = harness({ fail: new Error('connection reset') });
    await expect(run(handlers, event({ jobId: JOB, workspaceId: WS }))).rejects.toThrow(
      JobStartFailedError,
    );
  });

  it('names the job and the underlying cause', async () => {
    const { handlers } = harness({ fail: new Error('connection reset') });
    try {
      await run(handlers, event({ jobId: JOB, workspaceId: WS }));
      expect.unreachable('must fail');
    } catch (error) {
      const e = error as JobStartFailedError;
      expect(e.code).toBe('JobStartFailed');
      expect(e.message).toContain(JOB);
      expect(e.message).toContain('connection reset');
    }
  });

  // Not one of the terminal codes, so the retry engine classifies it transient.
  it('uses a code that is not terminal', async () => {
    const { handlers } = harness({ fail: new Error('boom') });
    try {
      await run(handlers, event({ jobId: JOB, workspaceId: WS }));
      expect.unreachable('must fail');
    } catch (error) {
      expect((error as JobStartFailedError).code).toBe('JobStartFailed');
      expect(['SchemaViolation', 'UnknownEventType']).not.toContain(
        (error as JobStartFailedError).code,
      );
    }
  });
});
