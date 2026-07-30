/**
 * The Job Service.
 *
 * The fake below enforces the one database rule the concurrency story rests on:
 * the `status = $3` predicate on every transition. A fake that updated
 * unconditionally would let two callers both start one job and this suite would
 * not notice.
 *
 * RLS isolation is NOT asserted here — it is a policy against a real server,
 * and CI step 5g asserts it against PostgreSQL 17.
 */
import { describe, expect, it } from 'vitest';

import type { DomainEvent, EventPublisher, Transaction } from '@contentos/contracts';
import type { AuditWriter, NewAuditRecord } from '@contentos/security';

import { JobError, type JobStatus } from './job.js';
import {
  createJobService,
  JOB_AUDIT_ACTIONS,
  MAX_JOB_PAGE,
  type CreateJobCommand,
  type JobExecutor,
  type JobService,
} from './service.js';

const ORG = '018f7a1e-0000-7000-8000-0000000000aa';
const WS = '018f7a1e-0000-7000-8000-0000000000bb';
const ACTOR = '018f7a1e-0000-7000-8000-000000000001';
const CORRELATION = '018f7a1e-0000-7000-8000-0000000000dd';
const NOW = new Date('2026-07-30T12:00:00.000Z');

interface Row {
  id: string;
  tenantId: string;
  workspaceId: string;
  organizationId: string;
  jobType: string;
  status: string;
  correlationId: string;
  causationId: string | null;
  payload: Record<string, unknown>;
  reason: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

interface Rig {
  readonly tx: JobExecutor;
  readonly jobs: JobService;
  readonly rows: Row[];
  readonly published: DomainEvent<unknown>[];
  readonly audits: NewAuditRecord[];
}

function rig(): Rig {
  const rows: Row[] = [];
  const published: DomainEvent<unknown>[] = [];
  const audits: NewAuditRecord[] = [];
  let seq = 0;

  const tx = {
    query<T>(sql: string, params?: readonly unknown[]): Promise<readonly T[]> {
      const p = [...(params ?? [])] as (string | number | null)[];
      const tenant = String(p[0] ?? '');

      if (sql.includes('INSERT INTO jobs')) {
        seq += 1;
        const row: Row = {
          id: `018f7a1e-0000-7000-7003-${String(seq).padStart(12, '0')}`,
          tenantId: tenant,
          workspaceId: tenant,
          organizationId: String(p[1]),
          jobType: String(p[2]),
          status: 'queued',
          correlationId: String(p[3]),
          causationId: (p[4] as string | null) ?? null,
          payload: JSON.parse(String(p[5])) as Record<string, unknown>,
          reason: null,
          createdAt: new Date(NOW.getTime() + seq * 1000).toISOString(),
          updatedAt: new Date(NOW.getTime() + seq * 1000).toISOString(),
          startedAt: null,
          completedAt: null,
        };
        rows.push(row);
        return Promise.resolve([row] as unknown as T[]);
      }

      if (sql.includes('UPDATE jobs')) {
        const [, id, expected, target, reason] = p as (string | null)[];
        // THE predicate. Without it two callers both start one job.
        const row = rows.find((r) => r.tenantId === tenant && r.id === id && r.status === expected);
        if (row === undefined) return Promise.resolve([]);
        row.status = String(target);
        row.reason = reason ?? null;
        row.updatedAt = NOW.toISOString();
        if (target === 'running') row.startedAt = NOW.toISOString();
        if (['completed', 'failed', 'cancelled'].includes(String(target))) {
          row.completedAt = NOW.toISOString();
        }
        return Promise.resolve([row] as unknown as T[]);
      }

      if (sql.includes('AND id = $2')) {
        return Promise.resolve(
          rows.filter((r) => r.tenantId === tenant && r.id === p[1]) as unknown as T[],
        );
      }

      if (sql.includes('ORDER BY created_at DESC')) {
        const [, status, jobType, cursorAt, cursorId, limit] = p as unknown as [
          string,
          string | null,
          string | null,
          string | null,
          string | null,
          number,
        ];
        const page = rows
          .filter((r) => r.tenantId === tenant)
          .filter((r) => status === null || r.status === status)
          .filter((r) => jobType === null || r.jobType === jobType)
          .filter(
            (r) =>
              cursorAt === null ||
              r.createdAt < cursorAt ||
              (r.createdAt === cursorAt && r.id < (cursorId ?? '')),
          )
          .sort((a, b) => (b.createdAt + b.id).localeCompare(a.createdAt + a.id))
          .slice(0, limit);
        return Promise.resolve(page as unknown as T[]);
      }

      throw new Error(`unexpected SQL: ${sql}`);
    },
  } as unknown as JobExecutor;

  const publisher: EventPublisher = {
    publish<T>(_tx: Transaction, event: DomainEvent<T>): Promise<void> {
      published.push(event as DomainEvent<unknown>);
      return Promise.resolve();
    },
  };
  const audit: AuditWriter = {
    record(_tx: Transaction, entry: NewAuditRecord): Promise<string> {
      audits.push(entry);
      return Promise.resolve('audit-id');
    },
  };

  let eventSeq = 0;
  return {
    tx,
    rows,
    published,
    audits,
    jobs: createJobService({
      publisher,
      audit,
      now: () => NOW,
      newEventId: () => `018f7a1e-0000-7000-9000-${String((eventSeq += 1)).padStart(12, '0')}`,
    }),
  };
}

function create(over: Partial<CreateJobCommand> = {}): CreateJobCommand {
  return {
    workspaceId: WS,
    organizationId: ORG,
    jobType: 'article.generate',
    correlationId: CORRELATION,
    ...over,
  };
}

const move = (jobId: string) => ({ workspaceId: WS, jobId, correlationId: CORRELATION });

describe('create queues a job', () => {
  it('persists it as queued, with neither timestamp set', async () => {
    const r = rig();
    const result = await r.jobs.create(r.tx, create());

    expect(result.job).toMatchObject({
      tenantId: WS,
      workspaceId: WS,
      organizationId: ORG,
      jobType: 'article.generate',
      status: 'queued',
      startedAt: null,
      completedAt: null,
      reason: null,
    });
  });

  it('publishes JobQueued', async () => {
    const r = rig();
    const result = await r.jobs.create(r.tx, create());
    expect(r.published.map((e) => e.eventType)).toEqual(['JobQueued']);
    expect(r.published[0]?.payload).toMatchObject({
      jobId: result.job.id,
      jobType: 'article.generate',
      workspaceId: WS,
      organizationId: ORG,
    });
  });

  it('carries the payload through', async () => {
    const r = rig();
    const result = await r.jobs.create(r.tx, create({ payload: { articleId: 'a-1', step: 2 } }));
    expect(result.job.payload).toEqual({ articleId: 'a-1', step: 2 });
  });

  it('records the causing event when there is one', async () => {
    const r = rig();
    const result = await r.jobs.create(r.tx, create({ causationId: 'e-1' }));
    expect(result.job.causationId).toBe('e-1');
    expect(r.published[0]?.causationId).toBe('e-1');
  });

  // A runner routes on it, and nothing else says what the work is.
  it('refuses a job with no type', async () => {
    const r = rig();
    await expect(r.jobs.create(r.tx, create({ jobType: '  ' }))).rejects.toThrow(JobError);
    expect(r.rows).toHaveLength(0);
  });
});

describe('the lifecycle, end to end', () => {
  async function queued(r: Rig) {
    const result = await r.jobs.create(r.tx, create());
    return result.job.id;
  }

  it('start moves queued to running and stamps started_at', async () => {
    const r = rig();
    const id = await queued(r);
    const result = await r.jobs.start(r.tx, move(id));

    expect(result.job.status).toBe('running');
    expect(result.job.startedAt).toBe(NOW.toISOString());
    expect(result.job.completedAt).toBeNull();
    expect(result.event.eventType).toBe('JobStarted');
  });

  it('complete moves running to completed and stamps completed_at', async () => {
    const r = rig();
    const id = await queued(r);
    await r.jobs.start(r.tx, move(id));
    const result = await r.jobs.complete(r.tx, move(id));

    expect(result.job.status).toBe('completed');
    expect(result.job.completedAt).toBe(NOW.toISOString());
    expect(result.job.reason).toBeNull();
    expect(result.event.eventType).toBe('JobCompleted');
  });

  it('fail moves running to failed, recording why', async () => {
    const r = rig();
    const id = await queued(r);
    await r.jobs.start(r.tx, move(id));
    const result = await r.jobs.fail(r.tx, { ...move(id), reason: 'provider timeout' });

    expect(result.job.status).toBe('failed');
    expect(result.job.reason).toBe('provider timeout');
    expect(result.job.completedAt).toBe(NOW.toISOString());
    expect(result.event.eventType).toBe('JobFailed');
  });

  it('cancel moves running to cancelled, recording why', async () => {
    const r = rig();
    const id = await queued(r);
    await r.jobs.start(r.tx, move(id));
    const result = await r.jobs.cancel(r.tx, {
      ...move(id),
      reason: 'operator stopped the run',
      actor: { id: ACTOR, kind: 'user' },
    });

    expect(result.job.status).toBe('cancelled');
    expect(result.job.reason).toBe('operator stopped the run');
    expect(result.event.eventType).toBe('JobCancelled');
  });

  it('publishes one event per transition, in order', async () => {
    const r = rig();
    const id = await queued(r);
    await r.jobs.start(r.tx, move(id));
    await r.jobs.complete(r.tx, move(id));
    expect(r.published.map((e) => e.eventType)).toEqual([
      'JobQueued',
      'JobStarted',
      'JobCompleted',
    ]);
  });

  // Envelope and registry validation run inside publish, before commit, so an
  // event the registry rejects must take the transition down with it.
  it('propagates a publish failure rather than swallowing it', async () => {
    const r = rig();
    const boom = new Error('registry rejected the envelope');
    const failing = createJobService({
      publisher: { publish: () => Promise.reject(boom) },
      audit: { record: () => Promise.resolve('a') },
      now: () => NOW,
    });
    await expect(failing.create(r.tx, create())).rejects.toThrow(boom);
  });
});

describe('illegal transitions are refused before any write', () => {
  const ILLEGAL: [string, (r: Rig, id: string) => Promise<unknown>][] = [
    ['complete a queued job', (r, id) => r.jobs.complete(r.tx, move(id))],
    ['fail a queued job', (r, id) => r.jobs.fail(r.tx, { ...move(id), reason: 'x' })],
    [
      'cancel a queued job',
      (r, id) =>
        r.jobs.cancel(r.tx, { ...move(id), reason: 'x', actor: { id: ACTOR, kind: 'user' } }),
    ],
  ];

  for (const [what, attempt] of ILLEGAL) {
    it(`refuses to ${what}`, async () => {
      const r = rig();
      const created = await r.jobs.create(r.tx, create());
      await expect(attempt(r, created.job.id)).rejects.toThrow(JobError);
      expect(r.rows[0]?.status).toBe('queued');
      // Nothing published beyond the original queueing.
      expect(r.published.map((e) => e.eventType)).toEqual(['JobQueued']);
    });
  }

  it('refuses to start a job twice', async () => {
    const r = rig();
    const created = await r.jobs.create(r.tx, create());
    await r.jobs.start(r.tx, move(created.job.id));
    await expect(r.jobs.start(r.tx, move(created.job.id))).rejects.toThrow(
      /only legal from 'queued'/,
    );
  });

  it('refuses every move out of a terminal state', async () => {
    const r = rig();
    const created = await r.jobs.create(r.tx, create());
    await r.jobs.start(r.tx, move(created.job.id));
    await r.jobs.complete(r.tx, move(created.job.id));

    for (const attempt of [
      () => r.jobs.start(r.tx, move(created.job.id)),
      () => r.jobs.complete(r.tx, move(created.job.id)),
      () => r.jobs.fail(r.tx, { ...move(created.job.id), reason: 'x' }),
    ]) {
      await expect(attempt()).rejects.toThrow(/no outgoing transitions/);
    }
  });

  it('refuses a fail with no reason, before reading the job', async () => {
    const r = rig();
    const created = await r.jobs.create(r.tx, create());
    await r.jobs.start(r.tx, move(created.job.id));
    await expect(r.jobs.fail(r.tx, { ...move(created.job.id), reason: '   ' })).rejects.toThrow(
      /without a reason/,
    );
    expect(r.rows[0]?.status).toBe('running');
  });

  it('refuses to move a job that does not exist', async () => {
    const r = rig();
    await expect(r.jobs.start(r.tx, move('018f7a1e-0000-7000-8000-00000000ffff'))).rejects.toThrow(
      /does not exist/,
    );
  });
});

describe('two callers racing produce one winner', () => {
  // The predicate is the guarantee: the state machine's check ran against a
  // read that was true when it was taken.
  it('starts a job once even when both callers passed the machine', async () => {
    const r = rig();
    const created = await r.jobs.create(r.tx, create());

    const results = await Promise.allSettled([
      r.jobs.start(r.tx, move(created.job.id)),
      r.jobs.start(r.tx, move(created.job.id)),
    ]);

    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((x) => x.status === 'rejected')).toHaveLength(1);
    expect(r.published.filter((e) => e.eventType === 'JobStarted')).toHaveLength(1);
    expect(r.rows[0]?.status).toBe('running');
  });

  it('reports the state the loser actually found', async () => {
    const r = rig();
    const created = await r.jobs.create(r.tx, create());
    const results = await Promise.allSettled([
      r.jobs.start(r.tx, move(created.job.id)),
      r.jobs.start(r.tx, move(created.job.id)),
    ]);
    const rejected = results.find((x) => x.status === 'rejected');
    expect(rejected?.reason).toBeInstanceOf(JobError);
  });

  it('lets only one of complete and cancel win', async () => {
    const r = rig();
    const created = await r.jobs.create(r.tx, create());
    await r.jobs.start(r.tx, move(created.job.id));

    await Promise.allSettled([
      r.jobs.complete(r.tx, move(created.job.id)),
      r.jobs.cancel(r.tx, {
        ...move(created.job.id),
        reason: 'operator stopped the run',
        actor: { id: ACTOR, kind: 'user' },
      }),
    ]);

    const terminal = r.published.filter((e) =>
      ['JobCompleted', 'JobCancelled'].includes(e.eventType),
    );
    expect(terminal).toHaveLength(1);
    expect(['completed', 'cancelled']).toContain(r.rows[0]?.status);
  });
});

describe('auditing follows the intervention, not the machine', () => {
  // Cancellation is the only move an actor DECIDES rather than the work
  // reaching an outcome.
  it('audits a cancellation', async () => {
    const r = rig();
    const created = await r.jobs.create(r.tx, create());
    await r.jobs.start(r.tx, move(created.job.id));
    await r.jobs.cancel(r.tx, {
      ...move(created.job.id),
      reason: 'operator stopped the run',
      actor: { id: ACTOR, kind: 'user' },
    });

    expect(r.audits).toHaveLength(1);
    expect(r.audits[0]).toMatchObject({
      action: JOB_AUDIT_ACTIONS.cancel,
      tenantId: WS,
      organizationId: ORG,
      actorId: ACTOR,
      result: 'success',
      reason: 'operator stopped the run',
    });
    expect(r.audits[0]?.context.detail).toMatchObject({ jobType: 'article.generate' });
  });

  // Auditing these would record, at every job's volume, that the machine did
  // what it was asked.
  it('audits neither start, complete nor fail', async () => {
    const r = rig();
    const created = await r.jobs.create(r.tx, create());
    await r.jobs.start(r.tx, move(created.job.id));
    await r.jobs.fail(r.tx, { ...move(created.job.id), reason: 'provider timeout' });
    expect(r.audits).toHaveLength(0);
  });
});

describe('read is bounded and paginates by keyset', () => {
  async function seed(r: Rig, count: number, jobType = 'article.generate') {
    for (let i = 0; i < count; i += 1) await r.jobs.create(r.tx, create({ jobType }));
  }

  it('returns newest first', async () => {
    const r = rig();
    await seed(r, 3);
    const page = await r.jobs.read(r.tx, { workspaceId: WS });
    expect(page.jobs.map((j) => j.createdAt)).toEqual([
      new Date(NOW.getTime() + 3000).toISOString(),
      new Date(NOW.getTime() + 2000).toISOString(),
      new Date(NOW.getTime() + 1000).toISOString(),
    ]);
  });

  it('walks the whole list through the cursor without repeating a row', async () => {
    const r = rig();
    await seed(r, 5);

    const seen: string[] = [];
    let cursor = null as Awaited<ReturnType<typeof r.jobs.read>>['nextCursor'];
    for (let guard = 0; guard < 10; guard += 1) {
      const page = await r.jobs.read(r.tx, { workspaceId: WS, limit: 2, cursor });
      seen.push(...page.jobs.map((j) => j.id));
      cursor = page.nextCursor;
      if (cursor === null) break;
    }

    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
  });

  it('reports no cursor once the page is short', async () => {
    const r = rig();
    await seed(r, 3);
    expect((await r.jobs.read(r.tx, { workspaceId: WS, limit: 10 })).nextCursor).toBeNull();
  });

  it('clamps a request for the whole list to one page', async () => {
    const r = rig();
    await seed(r, 3);
    const page = await r.jobs.read(r.tx, { workspaceId: WS, limit: 100_000 });
    expect(page.jobs.length).toBeLessThanOrEqual(MAX_JOB_PAGE);
  });

  it('filters by status', async () => {
    const r = rig();
    await seed(r, 3);
    const first = r.rows[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    await r.jobs.start(r.tx, move(first.id));

    const queued = await r.jobs.read(r.tx, { workspaceId: WS, status: 'queued' as JobStatus });
    const running = await r.jobs.read(r.tx, { workspaceId: WS, status: 'running' as JobStatus });
    expect(queued.jobs).toHaveLength(2);
    expect(running.jobs).toHaveLength(1);
  });

  it('filters by job type', async () => {
    const r = rig();
    await seed(r, 2, 'article.generate');
    await seed(r, 1, 'image.render');
    const page = await r.jobs.read(r.tx, { workspaceId: WS, jobType: 'image.render' });
    expect(page.jobs).toHaveLength(1);
  });

  it('finds a job by id, and returns null across workspaces', async () => {
    const r = rig();
    const created = await r.jobs.create(r.tx, create());
    expect((await r.jobs.findById(r.tx, WS, created.job.id))?.id).toBe(created.job.id);
    const OTHER_WS = '018f7a1e-0000-7000-8000-0000000000cc';
    expect(await r.jobs.findById(r.tx, OTHER_WS, created.job.id)).toBeNull();
  });
});
