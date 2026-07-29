import { describe, expect, it } from 'vitest';

import type { DomainEvent } from '@contentos/contracts';

import type { GuardExecutor } from '../delivery/guards.js';
import { createRelay, toEvent, type OutboxRow, type PublishResult } from './relay.js';

const TENANT = '018f7a1e-0000-7000-8000-0000000000bb';
const ORG = '018f7a1e-0000-7000-8000-0000000000aa';

function row(over: Partial<OutboxRow> = {}): OutboxRow {
  return {
    id: '1',
    event_id: '018f7a1e-0000-7000-8000-000000000001',
    tenant_id: TENANT,
    organization_id: ORG,
    event_type: 'ArticlePublished',
    event_version: 1,
    aggregate_type: 'Article',
    aggregate_id: '018f7a1e-0000-7000-8000-0000000000c1',
    correlation_id: '018f7a1e-0000-7000-8000-0000000000dd',
    causation_id: null,
    producer: 'content-platform',
    occurred_at: '2026-07-29T10:00:00.000Z',
    payload: { articleId: 'a1' },
    publish_attempts: 0,
    ...over,
  };
}

/** Fake outbox: rows plus the SQL the relay issued against them. */
function outbox(rows: OutboxRow[]) {
  const marked: string[] = [];
  const attempts: string[] = [];
  const sql: string[] = [];
  const tx: GuardExecutor = {
    query<T>(q: string, params?: readonly unknown[]): Promise<readonly T[]> {
      sql.push(q);
      if (q.includes('FROM outbox_events o')) return Promise.resolve(rows as unknown as T[]);
      if (q.includes('SET published_at')) {
        marked.push(...((params?.[0] as string[] | undefined) ?? []));
        return Promise.resolve([] as unknown as T[]);
      }
      if (q.includes('publish_attempts + 1')) {
        attempts.push(String(params?.[0]));
        return Promise.resolve([] as unknown as T[]);
      }
      return Promise.resolve([] as unknown as T[]);
    },
  } as GuardExecutor;
  return {
    marked,
    attempts,
    sql,
    transaction: <T>(work: (t: GuardExecutor) => Promise<T>): Promise<T> => work(tx),
  };
}

const ok: PublishResult = { ok: true };
const fail: PublishResult = { ok: false, code: 'BusUnavailable', message: 'connection refused' };

describe('relay — publication', () => {
  it('publishes a claimed event and marks it published', async () => {
    const store = outbox([row()]);
    const appended: DomainEvent<unknown>[] = [];
    const relay = createRelay({
      transaction: store.transaction,
      append: (e) => {
        appended.push(e);
        return Promise.resolve(ok);
      },
      quarantine: () => Promise.resolve(),
    });

    const result = await relay.drainOnce();
    expect(result).toMatchObject({ claimed: 1, published: 1, quarantined: 0 });
    expect(appended).toHaveLength(1);
    expect(store.marked).toEqual(['1']);
  });

  it('reconstructs the full envelope from the row', () => {
    const event = toEvent(row());
    expect(event).toMatchObject({
      eventId: '018f7a1e-0000-7000-8000-000000000001',
      tenantId: TENANT,
      organizationId: ORG,
      producer: 'content-platform',
      causationId: null,
    });
  });

  it('does nothing when the outbox is empty', async () => {
    const store = outbox([]);
    const relay = createRelay({
      transaction: store.transaction,
      append: () => Promise.resolve(ok),
      quarantine: () => Promise.resolve(),
    });
    expect(await relay.drainOnce()).toMatchObject({ claimed: 0, published: 0 });
    expect(store.marked).toHaveLength(0);
  });
});

describe('relay — never loses an event', () => {
  // Marked published only AFTER the bus accepts it.
  it('does NOT mark an event published when the bus rejects it', async () => {
    const store = outbox([row()]);
    const relay = createRelay({
      transaction: store.transaction,
      append: () => Promise.resolve(fail),
      quarantine: () => Promise.resolve(),
    });

    const result = await relay.drainOnce();
    expect(result.published).toBe(0);
    expect(store.marked).toHaveLength(0);
    expect(store.attempts).toEqual(['1']);
  });

  // A crash between append and mark re-delivers rather than loses.
  it('leaves the row claimable after a failure, so the next cycle retries it', async () => {
    const store = outbox([row({ publish_attempts: 1 })]);
    const relay = createRelay({
      transaction: store.transaction,
      append: () => Promise.resolve(fail),
      quarantine: () => Promise.resolve(),
    });
    const result = await relay.drainOnce();
    expect(result.retried).toBe(1);
    expect(store.marked).toHaveLength(0);
  });

  it('quarantines once publish attempts are exhausted', async () => {
    const store = outbox([row({ publish_attempts: 4 })]);
    const quarantined: string[] = [];
    const relay = createRelay({
      transaction: store.transaction,
      append: () => Promise.resolve(fail),
      quarantine: (_tx, e, code) => {
        quarantined.push(`${e.eventId}:${code}`);
        return Promise.resolve();
      },
      maxPublishAttempts: 5,
    });

    const result = await relay.drainOnce();
    expect(result.quarantined).toBe(1);
    expect(quarantined[0]).toContain('BusUnavailable');
    // Marked so it is not re-claimed forever — it is durably in the DLQ now.
    expect(store.marked).toEqual(['1']);
  });

  it('never silently drops: a failure is retried or quarantined, never neither', async () => {
    const store = outbox([row({ publish_attempts: 0 }), row({ id: '2', publish_attempts: 4 })]);
    const quarantined: string[] = [];
    const relay = createRelay({
      transaction: store.transaction,
      append: () => Promise.resolve(fail),
      quarantine: (_tx, e) => {
        quarantined.push(e.eventId);
        return Promise.resolve();
      },
    });
    const result = await relay.drainOnce();
    expect(result.retried + result.quarantined).toBe(2);
  });
});

describe('relay — per-aggregate ordering', () => {
  // The claim itself excludes a row with an earlier unpublished sibling.
  it('claims in publication order and excludes out-of-order siblings in SQL', async () => {
    const store = outbox([row()]);
    const relay = createRelay({
      transaction: store.transaction,
      append: () => Promise.resolve(ok),
      quarantine: () => Promise.resolve(),
    });
    await relay.drainOnce();

    const claim = store.sql.find((s) => s.includes('FROM outbox_events o'));
    expect(claim).toContain('ORDER BY o.id');
    expect(claim).toContain('e.aggregate_id = o.aggregate_id');
    expect(claim).toContain('e.id < o.id');
  });

  // Multiple relay instances must claim disjoint sets without blocking.
  it('claims with FOR UPDATE SKIP LOCKED', async () => {
    const store = outbox([row()]);
    const relay = createRelay({
      transaction: store.transaction,
      append: () => Promise.resolve(ok),
      quarantine: () => Promise.resolve(),
    });
    await relay.drainOnce();
    expect(store.sql.find((s) => s.includes('FROM outbox_events o'))).toContain(
      'FOR UPDATE SKIP LOCKED',
    );
  });

  it('publishes a batch in claim order', async () => {
    const store = outbox([
      row(),
      row({ id: '2', event_id: '018f7a1e-0000-7000-8000-000000000002' }),
    ]);
    const order: string[] = [];
    const relay = createRelay({
      transaction: store.transaction,
      append: (e) => {
        order.push(e.eventId);
        return Promise.resolve(ok);
      },
      quarantine: () => Promise.resolve(),
    });
    await relay.drainOnce();
    expect(order).toEqual([
      '018f7a1e-0000-7000-8000-000000000001',
      '018f7a1e-0000-7000-8000-000000000002',
    ]);
  });

  it('respects the batch size', async () => {
    const store = outbox([row()]);
    const relay = createRelay({
      transaction: store.transaction,
      append: () => Promise.resolve(ok),
      quarantine: () => Promise.resolve(),
      batchSize: 25,
    });
    await relay.drainOnce();
    expect(store.sql.find((s) => s.includes('LIMIT $1'))).toBeTruthy();
  });
});
