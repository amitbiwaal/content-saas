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
const describeIfDb = DATABASE_URL === undefined ? describe.skip : describe;

if (DATABASE_URL === undefined) {
  console.warn(
    '[rls.conformance] SKIPPED — DATABASE_URL is not set. RLS is a database behaviour and cannot be verified without PostgreSQL 17. CI must set this.',
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
