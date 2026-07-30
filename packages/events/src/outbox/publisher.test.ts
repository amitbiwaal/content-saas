import { describe, expect, it } from 'vitest';

import type { DomainEvent, Transaction } from '@contentos/contracts';

import { createEventRegistry, type EventRegistry } from '../registry/registry.js';
import { createOutboxPublisher, type TransactionalExecutor } from './publisher.js';

const UUID_A = '018f7a1e-0000-7000-8000-000000000001';
const TENANT = '018f7a1e-0000-7000-8000-0000000000bb';
const ORG = '018f7a1e-0000-7000-8000-0000000000aa';

const registry: EventRegistry = createEventRegistry([
  {
    eventType: 'ArticlePublished',
    version: 1,
    state: 'active',
    stream: 'article',
    producer: 'content-platform',
    tenantScope: 'workspace',
    consumers: [],
  },
]);

function event(
  over: Partial<DomainEvent<Record<string, unknown>>> = {},
): DomainEvent<Record<string, unknown>> {
  return {
    eventId: UUID_A,
    eventType: 'ArticlePublished',
    eventVersion: 1,
    aggregateType: 'Article',
    aggregateId: '018f7a1e-0000-7000-8000-0000000000cc',
    tenantId: TENANT,
    organizationId: ORG,
    correlationId: '018f7a1e-0000-7000-8000-0000000000dd',
    causationId: null,
    producer: 'content-platform',
    occurredAt: '2026-07-29T10:00:00.000Z',
    payload: { articleId: '018f7a1e-0000-7000-8000-0000000000cc' },
    ...over,
  };
}

function tx(): TransactionalExecutor & { sql: string[]; params: unknown[][] } {
  const sql: string[] = [];
  const params: unknown[][] = [];
  return {
    sql,
    params,
    query<T>(q: string, p?: readonly unknown[]): Promise<readonly T[]> {
      sql.push(q);
      params.push([...(p ?? [])]);
      return Promise.resolve([] as unknown as T[]);
    },
  } as TransactionalExecutor & { sql: string[]; params: unknown[][] };
}

describe('publishing requires a transaction — ADR-020', () => {
  it('writes the event inside the caller transaction', async () => {
    const t = tx();
    await createOutboxPublisher({ registry }).publish(t, event());
    expect(t.sql[0]).toContain('INSERT INTO outbox_events');
  });

  // The event and the state change commit together or not at all.
  it('issues no query of its own beyond the insert', async () => {
    const t = tx();
    await createOutboxPublisher({ registry }).publish(t, event());
    expect(t.sql).toHaveLength(1);
  });

  it('refuses a handle with no query surface', async () => {
    const notATransaction = { __brand: 'Transaction' } as unknown as Transaction;
    await expect(
      createOutboxPublisher({ registry }).publish(notATransaction, event()),
    ).rejects.toThrow(/requires a live transaction handle/);
  });

  // A retried producer transaction must not duplicate the row.
  it('is idempotent on event_id', async () => {
    const t = tx();
    await createOutboxPublisher({ registry }).publish(t, event());
    expect(t.sql[0]).toContain('ON CONFLICT (event_id) DO NOTHING');
  });

  it('persists every frozen envelope field', async () => {
    const t = tx();
    await createOutboxPublisher({ registry }).publish(t, event());
    const [row] = t.params;
    expect(row).toHaveLength(12);
    expect(row?.[0]).toBe(UUID_A);
    expect(row?.[1]).toBe(TENANT);
    expect(row?.[9]).toBe('content-platform');
  });
});

describe('validation happens before commit', () => {
  it('rejects an unregistered event type', async () => {
    await expect(
      createOutboxPublisher({ registry }).publish(tx(), event({ eventType: 'NeverDeclared' })),
    ).rejects.toThrow(/not registered/);
  });

  it('rejects a retired version', async () => {
    const retired = createEventRegistry([
      {
        eventType: 'OldThingHappened',
        version: 1,
        state: 'retired',
        stream: 's',
        producer: 'content-platform',
        tenantScope: 'workspace',
        consumers: [],
      },
    ]);
    await expect(
      createOutboxPublisher({ registry: retired }).publish(
        tx(),
        event({ eventType: 'OldThingHappened' }),
      ),
    ).rejects.toThrow(/retired/);
  });

  it('writes nothing when validation fails', async () => {
    const t = tx();
    await expect(
      createOutboxPublisher({ registry }).publish(t, event({ eventType: 'NeverDeclared' })),
    ).rejects.toThrow();
    expect(t.sql).toHaveLength(0);
  });

  it('rejects a malformed envelope', async () => {
    await expect(
      createOutboxPublisher({ registry }).publish(tx(), event({ tenantId: 'not-a-uuid' })),
    ).rejects.toThrow(/tenantId/);
  });

  // Events reach consumers with weaker controls than the source table.
  it('rejects a payload carrying a credential', async () => {
    await expect(
      createOutboxPublisher({ registry }).publish(
        tx(),
        event({ payload: { apiKey: 'sk-live-abc' } }),
      ),
    ).rejects.toThrow(/CREDENTIAL_FIELD|apiKey/);
  });

  it('rejects a payload carrying content', async () => {
    await expect(
      createOutboxPublisher({ registry }).publish(tx(), event({ payload: { body: 'the draft' } })),
    ).rejects.toThrow(/CONTENT_FIELD|body/);
  });
});

describe('batch publication', () => {
  it('writes every event in one transaction', async () => {
    const t = tx();
    await createOutboxPublisher({ registry }).publishBatch(t, [
      event(),
      event({ eventId: '018f7a1e-0000-7000-8000-000000000002' }),
    ]);
    expect(t.sql).toHaveLength(2);
  });

  it('is a no-op on an empty batch', async () => {
    const t = tx();
    await createOutboxPublisher({ registry }).publishBatch(t, []);
    expect(t.sql).toHaveLength(0);
  });

  it('rejects the whole batch if any event is invalid', async () => {
    const t = tx();
    await expect(
      createOutboxPublisher({ registry }).publishBatch(t, [
        event(),
        event({ eventType: 'NeverDeclared' }),
      ]),
    ).rejects.toThrow();
    expect(t.sql).toHaveLength(0);
  });
});
