import { describe, expect, it } from 'vitest';

import { verifyChainLink, type NewAuditRecord, type Transaction } from './writer.js';
import {
  createPersistentAuditWriter,
  GENESIS_HASH,
  type AuditExecutor,
} from './persistent-writer.js';

const TENANT = '018f7a1e-0000-7000-8000-0000000000bb';
const ORG = '018f7a1e-0000-7000-8000-0000000000aa';

function entry(over: Partial<NewAuditRecord> = {}): NewAuditRecord {
  return {
    tenantId: TENANT,
    organizationId: ORG,
    actorId: '018f7a1e-0000-7000-8000-000000000001',
    actorKind: 'user',
    correlationId: '018f7a1e-0000-7000-8000-0000000000dd',
    action: 'article.published',
    target: { kind: 'article', id: 'a1', tenantId: TENANT },
    result: 'success',
    reason: 'ok',
    context: { ipAddress: null, userAgent: null, sessionId: null, stepUpSatisfied: true },
    ...over,
  };
}

/** Fake audit_log that remembers rows so the chain can be inspected. */
function db() {
  const rows: unknown[][] = [];
  const tx: AuditExecutor = {
    query<T>(sql: string, params?: readonly unknown[]): Promise<readonly T[]> {
      if (sql.includes('SELECT hash FROM audit_log')) {
        const last = rows.at(-1);
        return Promise.resolve((last ? [{ hash: last[15] }] : []) as unknown as T[]);
      }
      if (sql.includes('INSERT INTO audit_log')) {
        rows.push([...(params ?? [])]);
      }
      return Promise.resolve([] as unknown as T[]);
    },
  } as AuditExecutor;
  return { rows, tx };
}

describe('persistent audit writer', () => {
  it('writes the record inside the caller transaction', async () => {
    const { rows, tx } = db();
    await createPersistentAuditWriter().record(tx, entry());
    expect(rows).toHaveLength(1);
  });

  it('returns the audit id', async () => {
    const { tx } = db();
    const id = await createPersistentAuditWriter().record(tx, entry());
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  // A failed audit write must fail the action it describes.
  it('refuses a handle with no query surface', async () => {
    const notATransaction = { __brand: 'Transaction' } as unknown as Transaction;
    await expect(createPersistentAuditWriter().record(notATransaction, entry())).rejects.toThrow(
      /live transaction handle/,
    );
  });

  it('uses the server clock, never a client value', async () => {
    const at = new Date('2026-07-29T10:00:00.000Z');
    const { rows, tx } = db();
    await createPersistentAuditWriter({ now: () => at }).record(tx, entry());
    expect(rows[0]?.[6]).toBe(at.toISOString());
  });

  it('persists a null tenant for a pre-tenant action', async () => {
    const { rows, tx } = db();
    await createPersistentAuditWriter().record(tx, entry({ tenantId: null }));
    expect(rows[0]?.[1]).toBeNull();
  });
});

describe('tamper-evidence chain', () => {
  it('starts at the genesis hash', async () => {
    const { rows, tx } = db();
    await createPersistentAuditWriter().record(tx, entry());
    expect(rows[0]?.[14]).toBe(GENESIS_HASH);
  });

  // Read from the database, not memory: an in-memory head forks across
  // restarts and replicas, and verification would report that as tampering.
  it('links each record to the previous one', async () => {
    const { rows, tx } = db();
    const writer = createPersistentAuditWriter();
    await writer.record(tx, entry());
    await writer.record(tx, entry({ action: 'article.unpublished' }));

    const firstHash = rows[0]?.[15];
    expect(rows[1]?.[14]).toBe(firstHash);
    expect(rows[1]?.[15]).not.toBe(firstHash);
  });

  it('produces a verifiable link', async () => {
    const at = new Date('2026-07-29T10:00:00.000Z');
    const { rows, tx } = db();
    await createPersistentAuditWriter({ now: () => at, newId: () => 'fixed-id' }).record(
      tx,
      entry(),
    );
    const row = rows[0];

    expect(
      verifyChainLink({
        auditId: String(row?.[0]),
        tenantId: TENANT,
        organizationId: ORG,
        actorId: String(row?.[3]),
        actorKind: 'user',
        correlationId: String(row?.[5]),
        timestamp: at,
        action: 'article.published',
        target: { kind: 'article', id: 'a1', tenantId: TENANT },
        result: 'success',
        reason: 'ok',
        context: { ipAddress: null, userAgent: null, sessionId: null, stepUpSatisfied: true },
        previousHash: GENESIS_HASH,
        hash: String(row?.[15]),
      }),
    ).toBe(true);
  });

  it('writes a 64-character hex hash, matching the CHECK constraint', async () => {
    const { rows, tx } = db();
    await createPersistentAuditWriter().record(tx, entry());
    expect(String(rows[0]?.[15])).toMatch(/^[0-9a-f]{64}$/);
    expect(String(rows[0]?.[14])).toMatch(/^[0-9a-f]{64}$/);
  });
});
