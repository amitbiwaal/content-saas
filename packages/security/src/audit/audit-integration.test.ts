/**
 * The audit service against the real writer and the real chain.
 *
 * The unit suite checks validation and redaction on values. This drives the
 * REAL `createPersistentAuditWriter` over a fake `audit_log` that behaves like
 * the table — per-tenant head lookup, append-only, no update — and asserts the
 * property the whole system exists for: that what lands in the table is a
 * verifiable chain, and that the service did not disturb it.
 */

import { describe, expect, it } from 'vitest';

import { createPersistentAuditWriter, type AuditExecutor } from './persistent-writer.js';
import { CATEGORY_METADATA_KEY, categoryOf, type AuditEvent } from './model.js';
import { createAuditService, type CredentialScanner } from './service.js';
import { GENESIS_HASH, hashAuditRecord, verifyChainLink, type AuditRecord } from './writer.js';

const ORG = '018f7a1e-0000-7000-8000-0000000000aa';
const TENANT_A = '018f7a1e-0000-7000-8000-0000000000bb';
const TENANT_B = '018f7a1e-0000-7000-8000-0000000000cc';
const ACTOR = '018f7a1e-0000-7000-8000-000000000001';
const CORRELATION = '018f7a1e-0000-7000-8000-0000000000dd';

interface Row {
  readonly values: readonly unknown[];
}

/**
 * A stand-in for `audit_log`.
 *
 * Models exactly what the correctness argument rests on: the per-tenant head
 * lookup, insert-only, and no path to update or delete. Nothing else.
 */
function fakeTable(): { executor: AuditExecutor; rows: Row[]; statements: string[] } {
  const rows: Row[] = [];
  const statements: string[] = [];

  const executor: AuditExecutor = {
    query<T>(sql: string, params: readonly unknown[] = []): Promise<readonly T[]> {
      statements.push(sql.trim().split(/\s+/).slice(0, 2).join(' '));

      if (sql.includes('SELECT')) {
        // The head for this tenant, newest first — `tenant_id IS NOT DISTINCT FROM`.
        const tenant = params[0];
        const mine = rows.filter((row) => row.values[1] === tenant);
        const head = mine[mine.length - 1];
        return Promise.resolve(
          (head === undefined ? [] : [{ hash: head.values[15] as string }]) as T[],
        );
      }

      rows.push({ values: params });
      return Promise.resolve([] as T[]);
    },
  };

  return { executor, rows, statements };
}

/** Read a stored row back as the record it is. */
function toRecord(row: Row): AuditRecord {
  const v = row.values;
  return {
    auditId: v[0] as string,
    tenantId: v[1] as string | null,
    organizationId: v[2] as string,
    actorId: v[3] as string,
    actorKind: v[4] as AuditRecord['actorKind'],
    correlationId: v[5] as string,
    timestamp: new Date(v[6] as string),
    action: v[7] as string,
    target: { kind: v[8] as string, id: v[9] as string, tenantId: v[10] as string | null },
    result: v[11] as AuditRecord['result'],
    reason: v[12] as string,
    context: JSON.parse(v[13] as string) as AuditRecord['context'],
    previousHash: v[14] as string,
    hash: v[15] as string,
  };
}

const event = (overrides: Partial<AuditEvent> = {}): AuditEvent => ({
  category: 'workspace_lifecycle',
  action: 'workspace.created',
  tenantId: TENANT_A,
  organizationId: ORG,
  actor: { id: ACTOR, kind: 'user' },
  correlationId: CORRELATION,
  target: { kind: 'workspace', id: 'ws-1', tenantId: TENANT_A },
  result: 'success',
  reason: 'Provisioned by the owner.',
  ipAddress: null,
  userAgent: null,
  sessionId: null,
  stepUpSatisfied: false,
  ...overrides,
});

/** The observability scanner's shape. */
const scanner: CredentialScanner = (value) => {
  const out = value
    .replace(/\bsk_live_[A-Za-z0-9]+/g, '[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._-]{16,}/gi, '[REDACTED]');
  return { value: out, hits: out === value ? 0 : 1 };
};

function rig() {
  const table = fakeTable();
  let seq = 0;
  const writer = createPersistentAuditWriter({
    now: () => new Date('2026-03-01T00:00:00.000Z'),
    newId: () => `audit-${String((seq += 1)).padStart(4, '0')}`,
  });

  return { table, writer, service: createAuditService({ writer, scanner }) };
}

// ── The chain, through the service ──────────────────────────────────────────

describe('records written through the service form a verifiable chain', () => {
  it('starts at the genesis hash', async () => {
    const r = rig();
    await r.service.record(r.table.executor, event());

    const record = toRecord(r.table.rows[0] as Row);
    expect(record.previousHash).toBe(GENESIS_HASH);
    expect(verifyChainLink(record)).toBe(true);
  });

  it('links each record to the one before it', async () => {
    const r = rig();
    await r.service.record(r.table.executor, event({ action: 'workspace.created' }));
    await r.service.record(r.table.executor, event({ action: 'workspace.suspended' }));
    await r.service.record(r.table.executor, event({ action: 'workspace.restored' }));

    const records = r.table.rows.map(toRecord);
    expect(records).toHaveLength(3);
    expect(records[1]?.previousHash).toBe(records[0]?.hash);
    expect(records[2]?.previousHash).toBe(records[1]?.hash);
  });

  it('verifies every link', async () => {
    const r = rig();
    for (const action of ['workspace.created', 'workspace.suspended', 'workspace.archived']) {
      await r.service.record(r.table.executor, event({ action }));
    }

    for (const record of r.table.rows.map(toRecord)) {
      expect(verifyChainLink(record)).toBe(true);
    }
  });

  it('chains per tenant, not globally', async () => {
    // A global chain would serialise every audit write across the platform.
    const r = rig();
    await r.service.record(r.table.executor, event({ tenantId: TENANT_A }));
    await r.service.record(r.table.executor, event({ tenantId: TENANT_B }));

    const [first, second] = r.table.rows.map(toRecord);
    expect(first?.previousHash).toBe(GENESIS_HASH);
    // The second tenant starts its own chain rather than following the first.
    expect(second?.previousHash).toBe(GENESIS_HASH);
  });

  it('detects a tampered record', async () => {
    const r = rig();
    await r.service.record(r.table.executor, event());

    const record = toRecord(r.table.rows[0] as Row);
    const tampered: AuditRecord = { ...record, reason: 'Something else entirely.' };

    expect(verifyChainLink(record)).toBe(true);
    expect(verifyChainLink(tampered)).toBe(false);
  });

  it('reads the head from the table, not from memory', async () => {
    // An in-memory head is wrong across restarts and replicas: two writers
    // would each believe they follow the same record and fork the chain.
    const r = rig();
    await r.service.record(r.table.executor, event());

    expect(r.table.statements).toContain('SELECT hash');
  });

  it('inserts and never updates', async () => {
    const r = rig();
    await r.service.record(r.table.executor, event());
    await r.service.record(r.table.executor, event({ action: 'workspace.suspended' }));

    for (const statement of r.table.statements) {
      expect(statement).not.toMatch(/^UPDATE|^DELETE/);
    }
    expect(r.table.statements.filter((s) => s.startsWith('INSERT'))).toHaveLength(2);
  });
});

// ── Validation and redaction reach the table ────────────────────────────────

describe('what the service refuses never reaches the table', () => {
  it('writes nothing for a free-text action', async () => {
    const r = rig();
    await expect(
      r.service.record(r.table.executor, event({ action: 'Created a workspace' })),
    ).rejects.toThrow();

    expect(r.table.rows).toHaveLength(0);
    expect(r.table.statements).toEqual([]);
  });

  it('writes nothing for an unknown category', async () => {
    const r = rig();
    await expect(
      r.service.record(r.table.executor, event({ category: 'security' as 'billing' })),
    ).rejects.toThrow();

    expect(r.table.rows).toHaveLength(0);
  });

  it('writes nothing for malformed metadata', async () => {
    const r = rig();
    await expect(
      r.service.record(r.table.executor, event({ metadata: { count: 3 as unknown as string } })),
    ).rejects.toThrow();

    expect(r.table.rows).toHaveLength(0);
  });

  it('leaves the chain untouched after a refusal', async () => {
    // A refused submission must not consume a link, or the next verification
    // would report a gap that never happened.
    const r = rig();
    await r.service.record(r.table.executor, event());
    await expect(r.service.record(r.table.executor, event({ action: 'bad' }))).rejects.toThrow();
    await r.service.record(r.table.executor, event({ action: 'workspace.suspended' }));

    const records = r.table.rows.map(toRecord);
    expect(records).toHaveLength(2);
    expect(records[1]?.previousHash).toBe(records[0]?.hash);
    expect(records.every((record) => verifyChainLink(record))).toBe(true);
  });

  it('stores a redacted reason, and the redaction is inside the hash', async () => {
    // `reason` is in the preimage, so the stored hash must cover the redacted
    // text — otherwise verification of a sanitised record would fail forever.
    const r = rig();
    await r.service.record(
      r.table.executor,
      event({ reason: 'Rotated sk_live_abcdef123456 for the tenant.' }), // gitleaks:allow — fixture: the test asserts this is redacted
    );

    const record = toRecord(r.table.rows[0] as Row);
    expect(record.reason).toBe('Rotated [REDACTED] for the tenant.');
    expect(record.reason).not.toContain('sk_live_');
    expect(verifyChainLink(record)).toBe(true);
  });

  it('stores redacted metadata', async () => {
    const r = rig();
    await r.service.record(
      r.table.executor,
      event({ metadata: { header: 'Bearer abcdefghij0123456789' } }),
    );

    const record = toRecord(r.table.rows[0] as Row);
    expect(record.context.detail?.['header']).toBe('[REDACTED]');
  });

  it('files the category where a reader can find it', async () => {
    const r = rig();
    await r.service.record(r.table.executor, event({ category: 'deletion' }));

    const record = toRecord(r.table.rows[0] as Row);
    expect(record.context.detail?.[CATEGORY_METADATA_KEY]).toBe('deletion');
    expect(categoryOf(record.context)).toBe('deletion');
  });

  it('files the category without changing what the hash covers', async () => {
    // `detail` is outside the preimage, so an older record and a categorised
    // one with the same action hash identically.
    const r = rig();
    await r.service.record(r.table.executor, event());

    const record = toRecord(r.table.rows[0] as Row);
    const { hash, ...rest } = record;
    const withoutDetail = {
      ...rest,
      context: { ...rest.context, detail: undefined },
    };

    expect(hashAuditRecord(withoutDetail)).toBe(hash);
  });
});

// ── The two streams stay apart ──────────────────────────────────────────────

describe('an audit record is not a log line', () => {
  it('carries no severity and no level', async () => {
    // `audit.md` §"Three distinct streams": audit answers "who did what, to
    // what, with what result" — not "what happened in the code".
    const r = rig();
    await r.service.record(r.table.executor, event());

    const record = toRecord(r.table.rows[0] as Row);
    const keys = Object.keys(record);
    expect(keys).not.toContain('level');
    expect(keys).not.toContain('severity');
    expect(keys).not.toContain('event');
    expect(keys).not.toContain('service');
  });

  it('carries what a log line does not: an actor, a target and a chain', async () => {
    const r = rig();
    await r.service.record(r.table.executor, event());

    const record = toRecord(r.table.rows[0] as Row);
    expect(record.actorId).toBe(ACTOR);
    expect(record.target.id).toBe('ws-1');
    expect(record.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(record.previousHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is written inside the caller’s transaction, not fire-and-forget', async () => {
    // The property that separates audit from everything else: the action and
    // its record commit together or neither happens.
    const r = rig();
    let handedTheExecutor = false;
    const watching: AuditExecutor = {
      query: (sql, params) => {
        handedTheExecutor = true;
        return r.table.executor.query(sql, params);
      },
    };

    await r.service.record(watching, event());
    expect(handedTheExecutor).toBe(true);
  });

  it('fails the action when the write fails', async () => {
    // "An unauditable action does not proceed — the one place where the
    // platform prefers unavailability to incompleteness."
    const broken: AuditExecutor = {
      query: () => Promise.reject(new Error('the audit table is unreachable')),
    };
    const r = rig();

    await expect(r.service.record(broken, event())).rejects.toThrow(/audit table is unreachable/);
  });
});
