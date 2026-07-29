/**
 * Tenant-scoped connection — the only ordinary data access path.
 *
 * Spec: `16-security/row-level-security.md` §Interfaces and §"Connection
 * pooling".
 *
 * Three rules are enforced structurally here rather than by review:
 *
 *  1. `SET LOCAL`, never `SET`. A plain `SET` persists on the connection, so
 *     when it returns to the pool the next borrower inherits the previous
 *     tenant's context — a cross-tenant leak produced by one missing keyword.
 *
 *  2. Every query runs inside an explicit transaction. `withTenant` opens the
 *     transaction and sets context as ONE unit, so a caller cannot obtain a
 *     connection without context; the unsafe combination is not constructible.
 *
 *  3. Reaching an exception table requires a typed reason from a closed union.
 *     An untyped escape hatch would be used for convenience within a month.
 */

import type { ExceptionTableAccess } from '../rls/exceptions.js';

/**
 * The ORM transaction handle. Structural, so this module depends on no driver
 * and the port stays swappable (ADR-022 fixes Drizzle; it is still Proposed).
 */
export interface Transaction {
  query<T>(sql: string, params?: readonly unknown[]): Promise<readonly T[]>;
}

/** Tenant context. Resolved from the authenticated subject — never client input. */
export interface TenantContext {
  readonly tenantId: string;
  readonly organizationId: string;
  readonly source: 'request' | 'event';
}

export interface TenantScopedConnection {
  withTenant<T>(ctx: TenantContext, work: (tx: Transaction) => Promise<T>): Promise<T>;
  withoutTenant<T>(reason: ExceptionTableAccess, work: (tx: Transaction) => Promise<T>): Promise<T>;
}

/** Pool modes. `SET LOCAL` correctness depends entirely on this. */
export type PoolMode = 'session' | 'transaction' | 'statement';

/**
 * Statement pooling is PROHIBITED outright.
 *
 * It may route statements of one logical transaction to different backend
 * connections, so `SET LOCAL` and the query it protects can land on different
 * connections. The query then runs with no tenant context or, worse, with
 * another transaction's. Under statement pooling RLS provides no guarantee at
 * all.
 */
export function assertPoolMode(mode: PoolMode): void {
  if (mode === 'statement') {
    throw new Error(
      'Statement pooling is prohibited: SET LOCAL and the query it protects can land on different backend connections, leaving RLS unenforced (16-security/row-level-security.md).',
    );
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The tenant id is interpolated into `SET LOCAL`, which does not accept bind
 * parameters. It is therefore validated as a UUID first and rejected otherwise.
 *
 * This is the one place a value reaches SQL by interpolation, and the value
 * comes from `TenantContext` — never from a header, query parameter, or body.
 */
function assertUuid(value: string, field: string): void {
  if (!UUID.test(value)) {
    throw new Error(`${field} must be a UUID; refusing to set tenant context.`);
  }
}

export interface TransactionRunner {
  /** Open a transaction, run `work`, commit on success and roll back on throw. */
  transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T>;
}

export interface ConnectionOptions {
  readonly runner: TransactionRunner;
  readonly poolMode: PoolMode;
  /** Counts exception-table access by reason, for the audited metric. */
  readonly onExceptionAccess?: (reason: ExceptionTableAccess) => void;
}

class PostgresTenantScopedConnection implements TenantScopedConnection {
  readonly #runner: TransactionRunner;
  readonly #onExceptionAccess: ((reason: ExceptionTableAccess) => void) | undefined;

  constructor(options: ConnectionOptions) {
    assertPoolMode(options.poolMode);
    this.#runner = options.runner;
    this.#onExceptionAccess = options.onExceptionAccess;
  }

  async withTenant<T>(ctx: TenantContext, work: (tx: Transaction) => Promise<T>): Promise<T> {
    assertUuid(ctx.tenantId, 'tenantId');
    assertUuid(ctx.organizationId, 'organizationId');

    return this.#runner.transaction(async (tx) => {
      // SET LOCAL — transaction-scoped, reverts on commit or rollback.
      await tx.query(`SET LOCAL app.tenant_id = '${ctx.tenantId}'`);
      await tx.query(`SET LOCAL app.organization_id = '${ctx.organizationId}'`);
      return work(tx);
    });
  }

  async withoutTenant<T>(
    reason: ExceptionTableAccess,
    work: (tx: Transaction) => Promise<T>,
  ): Promise<T> {
    this.#onExceptionAccess?.(reason);
    // No context is set. The five exception tables carry no policy; every other
    // table therefore reads zero rows here, which fails closed.
    return this.#runner.transaction(work);
  }
}

export function createTenantScopedConnection(options: ConnectionOptions): TenantScopedConnection {
  return new PostgresTenantScopedConnection(options);
}
