/**
 * `@contentos/database` — THE public surface.
 *
 * Specified by `03-database/` (schema, migrations, indexes) and
 * `16-security/row-level-security.md` (roles, policies, exception set).
 *
 * `drizzle-orm` is permitted ONLY inside this package
 * (`07-development-guide/project-structure.md` §"Banned imports") — one schema
 * owner. Nothing above this layer may import it.
 */

// RLS — the closed exception sets and the conformance suite
export type { ExceptionTableAccess, IdentityExceptionTable } from './rls/exceptions.js';
export {
  ALL_EXCEPTION_TABLES,
  APPROVED_POLICY_VARIANTS,
  EXCEPTION_JUSTIFICATIONS,
  IDENTITY_EXCEPTION_TABLES,
  isExceptionTable,
  REFERENCE_DATA_EXCEPTION_TABLES,
} from './rls/exceptions.js';
export type { ConformanceFinding, ConformanceReport, SqlExecutor } from './rls/conformance.js';
export {
  assertRlsConformance,
  OWNERS_SQL,
  POLICIES_SQL,
  ROLES_SQL,
  runRlsConformance,
  TABLES_SQL,
} from './rls/conformance.js';

// Connection and transactions
export type {
  ConnectionOptions,
  PoolMode,
  TenantContext,
  TenantScopedConnection,
  Transaction,
  TransactionRunner,
} from './connection/tenant-scoped.js';
export { assertPoolMode, createTenantScopedConnection } from './connection/tenant-scoped.js';

// Migrations
export type {
  AppliedMigration,
  MigrationExecutor,
  MigrationFile,
  MigrationPlan,
} from './migrations/runner.js';
export {
  assertSequence,
  checksum,
  currentVersion,
  migrate,
  MIGRATIONS_TABLE_SQL,
  planMigrations,
} from './migrations/runner.js';
