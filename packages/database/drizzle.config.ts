/**
 * Drizzle Kit configuration (ADR-022 — PostgreSQL 17 + Drizzle ORM).
 *
 * `out` points at `infrastructure/migrations/` because the frozen layout places
 * migration SQL there, "applied via packages/database"
 * (`07-development-guide/project-structure.md`).
 *
 * NOTE: ADR-022 is still **Proposed**. `17-implementation/implementation-order.md`
 * directs Sprint 0 to proceed on the working assumption but to accept it, or
 * accept it as risk, BEFORE THE FIRST MIGRATION SHIPS.
 *
 * Excluded from `tsconfig.json`'s `include` (which is `src/**`), so it does not
 * enter the typecheck until `drizzle-kit` is installed.
 */
export default {
  dialect: 'postgresql',
  schema: './src/schema/*.ts',
  out: '../../infrastructure/migrations',
  strict: true,
  verbose: true,
};
