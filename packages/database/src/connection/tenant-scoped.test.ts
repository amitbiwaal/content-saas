import { describe, expect, it } from 'vitest';

import {
  assertPoolMode,
  createTenantScopedConnection,
  type Transaction,
  type TransactionRunner,
} from './tenant-scoped.js';

const CTX = {
  tenantId: '018f7a1e-0000-7000-8000-000000000001',
  organizationId: '018f7a1e-0000-7000-8000-000000000002',
  source: 'request' as const,
};

/**
 * The state object is returned directly rather than spread.
 *
 * `{ ...state, transaction }` would copy `transactions: 0` BY VALUE, so
 * incrementing `state.transactions` would never be visible on the returned
 * object — the array shares a reference and appears to work, while the number
 * silently does not.
 */
function runner(): TransactionRunner & { sql: string[]; transactions: number } {
  const tx: Transaction = {
    query<T>(q: string): Promise<readonly T[]> {
      state.sql.push(q);
      return Promise.resolve([] as unknown as T[]);
    },
  };
  const state: TransactionRunner & { sql: string[]; transactions: number } = {
    sql: [],
    transactions: 0,
    transaction<T>(work: (t: Transaction) => Promise<T>): Promise<T> {
      state.transactions += 1;
      return work(tx);
    },
  };
  return state;
}

describe('pool mode', () => {
  it('permits transaction pooling — the required mode', () => {
    expect(() => {
      assertPoolMode('transaction');
    }).not.toThrow();
  });

  it('permits session pooling', () => {
    expect(() => {
      assertPoolMode('session');
    }).not.toThrow();
  });

  // Under statement pooling RLS provides no guarantee at all.
  it('PROHIBITS statement pooling', () => {
    expect(() => {
      assertPoolMode('statement');
    }).toThrow(/prohibited/);
  });

  it('refuses to construct a connection in statement-pooling mode', () => {
    expect(() => createTenantScopedConnection({ runner: runner(), poolMode: 'statement' })).toThrow(
      /prohibited/,
    );
  });
});

describe('withTenant', () => {
  it('opens exactly one transaction', async () => {
    const r = runner();
    const conn = createTenantScopedConnection({ runner: r, poolMode: 'transaction' });
    await conn.withTenant(CTX, () => Promise.resolve('ok'));
    expect(r.transactions).toBe(1);
  });

  // SET LOCAL, never SET. A plain SET persists on the pooled connection and the
  // next borrower inherits the previous tenant's context.
  it('uses SET LOCAL and never a bare SET', async () => {
    const r = runner();
    const conn = createTenantScopedConnection({ runner: r, poolMode: 'transaction' });
    await conn.withTenant(CTX, () => Promise.resolve(null));

    expect(r.sql[0]).toBe(`SET LOCAL app.tenant_id = '${CTX.tenantId}'`);
    expect(r.sql.every((s) => !/^\s*SET\s+(?!LOCAL)/i.test(s))).toBe(true);
  });

  it('sets tenant context before the work runs', async () => {
    const r = runner();
    const conn = createTenantScopedConnection({ runner: r, poolMode: 'transaction' });
    await conn.withTenant(CTX, async (tx) => {
      await tx.query('SELECT 1');
      return null;
    });
    expect(r.sql.indexOf(`SET LOCAL app.tenant_id = '${CTX.tenantId}'`)).toBeLessThan(
      r.sql.indexOf('SELECT 1'),
    );
  });

  it('also sets organization context for the org-scoped read policy', async () => {
    const r = runner();
    const conn = createTenantScopedConnection({ runner: r, poolMode: 'transaction' });
    await conn.withTenant(CTX, () => Promise.resolve(null));
    expect(r.sql).toContain(`SET LOCAL app.organization_id = '${CTX.organizationId}'`);
  });

  it('returns the work result', async () => {
    const conn = createTenantScopedConnection({ runner: runner(), poolMode: 'transaction' });
    expect(await conn.withTenant(CTX, () => Promise.resolve(42))).toBe(42);
  });

  it('propagates a failure so the transaction rolls back', async () => {
    const conn = createTenantScopedConnection({ runner: runner(), poolMode: 'transaction' });
    await expect(conn.withTenant(CTX, () => Promise.reject(new Error('boom')))).rejects.toThrow(
      'boom',
    );
  });

  // The tenant id is interpolated because SET LOCAL takes no bind parameters.
  it('rejects a non-UUID tenant id rather than interpolating it', async () => {
    const conn = createTenantScopedConnection({ runner: runner(), poolMode: 'transaction' });
    await expect(
      conn.withTenant({ ...CTX, tenantId: "'; DROP TABLE users; --" }, () => Promise.resolve(1)),
    ).rejects.toThrow(/must be a UUID/);
  });

  it('rejects a non-UUID organization id', async () => {
    const conn = createTenantScopedConnection({ runner: runner(), poolMode: 'transaction' });
    await expect(
      conn.withTenant({ ...CTX, organizationId: 'not-a-uuid' }, () => Promise.resolve(1)),
    ).rejects.toThrow(/must be a UUID/);
  });

  it('does not open a transaction when validation fails', async () => {
    const r = runner();
    const conn = createTenantScopedConnection({ runner: r, poolMode: 'transaction' });
    await expect(
      conn.withTenant({ ...CTX, tenantId: 'bad' }, () => Promise.resolve(1)),
    ).rejects.toThrow();
    expect(r.transactions).toBe(0);
  });
});

describe('withoutTenant', () => {
  it('requires a typed reason and records the access', async () => {
    const seen: string[] = [];
    const conn = createTenantScopedConnection({
      runner: runner(),
      poolMode: 'transaction',
      onExceptionAccess: (reason) => seen.push(reason),
    });
    await conn.withoutTenant('authentication', () => Promise.resolve(null));
    expect(seen).toEqual(['authentication']);
  });

  it('sets no tenant context — every policied table then reads zero rows', async () => {
    const r = runner();
    const conn = createTenantScopedConnection({ runner: r, poolMode: 'transaction' });
    await conn.withoutTenant('membership-resolution', () => Promise.resolve(null));
    expect(r.sql.some((s) => s.includes('app.tenant_id'))).toBe(false);
  });

  it('still runs inside a transaction', async () => {
    const r = runner();
    const conn = createTenantScopedConnection({ runner: r, poolMode: 'transaction' });
    await conn.withoutTenant('organization-admin', () => Promise.resolve(null));
    expect(r.transactions).toBe(1);
  });
});
