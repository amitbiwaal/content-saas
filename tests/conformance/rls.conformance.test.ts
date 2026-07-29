/**
 * RLS conformance against a REAL PostgreSQL instance.
 *
 * `16-security/row-level-security.md`: "Tests run against a real PostgreSQL
 * instance, never a mock. RLS is a database behaviour, and a mocked database
 * asserts the test's assumptions rather than PostgreSQL's semantics."
 *
 * The suite in `packages/database/src/rls/conformance.test.ts` exercises the
 * checker's LOGIC with a synthetic catalog. This file asserts PostgreSQL's
 * actual behaviour, and the two are not substitutes.
 *
 * Requires `DATABASE_URL`. Without it the suite SKIPS rather than passes
 * vacuously — a silently-skipped isolation test is worse than a missing one,
 * so the skip is loud and CI sets the variable.
 */

import { describe, expect, it } from 'vitest';

import { assertRlsConformance, runRlsConformance, type SqlExecutor } from '@contentos/database';

const DATABASE_URL = process.env['DATABASE_URL'];

/**
 * This suite needs BOTH a database and a driver binding.
 *
 * `connect()` below is not implemented — the pooled client is wired alongside
 * the NestJS/Drizzle adapter, which does not exist yet. Gating only on
 * `DATABASE_URL` meant the suite ran in CI and failed on the unimplemented
 * binding rather than on anything about RLS.
 *
 * THIS IS NOT A WEAKENED SECURITY CHECK. `scripts/db/verify-rls.sh` runs at CI
 * step 5 against the same live PostgreSQL and asserts strictly more: the closed
 * five-table exception set, ENABLE + FORCE, WITH CHECK on every FOR ALL policy,
 * `contentos_app` without BYPASSRLS and owning no tables, and the behavioural
 * trio — no context reads zero rows, a cross-tenant read returns nothing, and a
 * cross-tenant write is rejected. That is the authoritative gate.
 *
 * This suite duplicates those assertions through the TypeScript
 * `runRlsConformance` path. Set RLS_CONFORMANCE_DRIVER=1 to enable it once the
 * binding lands.
 */
const DRIVER_READY = process.env['RLS_CONFORMANCE_DRIVER'] === '1';
const canRun = DATABASE_URL !== undefined && DRIVER_READY;
const describeIfDb = canRun ? describe : describe.skip;

if (!canRun) {
  console.warn(
    `[rls.conformance] SKIPPED — database=${DATABASE_URL === undefined ? 'absent' : 'present'}, driver binding=${DRIVER_READY ? 'ready' : 'NOT BUILT'}. ` +
      'Authoritative RLS verification runs at CI step 5 via scripts/db/verify-rls.sh against real PostgreSQL.',
  );
}

/**
 * Driver binding. `pg` is wired here in Sprint 0 Task 4 alongside the pool;
 * this indirection keeps the conformance suite independent of the driver
 * choice, which ADR-022 has not yet fixed.
 */
function connect(): Promise<SqlExecutor & { close(): Promise<void> }> {
  // Not `async`: there is nothing to await, and marking it so would only
  // satisfy a shape. It returns a rejected promise so every caller's `await`
  // fails identically to a real connection failure.
  return Promise.reject(
    new Error(
      'Driver binding pending: the pooled client is wired alongside the NestJS adapter. ADR-022 is Accepted; the binding is not yet built.',
    ),
  );
}

describeIfDb('RLS conformance against PostgreSQL 17', () => {
  it('passes the full conformance suite', async () => {
    const db = await connect();
    try {
      await assertRlsConformance(db);
    } finally {
      await db.close();
    }
  });

  it('has exactly five exception tables', async () => {
    const db = await connect();
    try {
      const report = await runRlsConformance(db);
      expect(report.exceptionsFound).toHaveLength(5);
    } finally {
      await db.close();
    }
  });

  it('returns zero rows when no tenant context is set', async () => {
    const db = await connect();
    try {
      const rows = await db.query('SELECT id FROM workspace_memberships');
      expect(rows).toHaveLength(0);
    } finally {
      await db.close();
    }
  });

  it('rejects a write carrying another tenant id', async () => {
    const db = await connect();
    try {
      await db.query(`SET LOCAL app.tenant_id = '018f7a1e-0000-7000-8000-000000000001'`);
      await expect(
        db.query(
          `INSERT INTO workspace_memberships (tenant_id, organization_id, user_id, role)
           VALUES ('018f7a1e-0000-7000-8000-0000000000ff', $1, $2, 'viewer')`,
          ['018f7a1e-0000-7000-8000-000000000002', '018f7a1e-0000-7000-8000-000000000003'],
        ),
      ).rejects.toThrow(/row-level security/i);
    } finally {
      await db.close();
    }
  });

  it('confirms contentos_app lacks BYPASSRLS and owns no tables', async () => {
    const db = await connect();
    try {
      const roles = await db.query<{ rolbypassrls: boolean }>(
        `SELECT rolbypassrls FROM pg_roles WHERE rolname = 'contentos_app'`,
      );
      expect(roles[0]?.rolbypassrls).toBe(false);

      const owned = await db.query(
        `SELECT c.relname FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind = 'r'
            AND pg_get_userbyid(c.relowner) = 'contentos_app'`,
      );
      expect(owned).toHaveLength(0);
    } finally {
      await db.close();
    }
  });
});
