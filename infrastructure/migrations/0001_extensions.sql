-- 0001_extensions.sql
--
-- Spec: 03-database/migrations.md §"Migration ordering" — 0001 extensions.
-- PostgreSQL 17. `uuidv7()` is native in 17 and needs no extension
-- (03-database/tables.md §1.1).
--
-- ROLLBACK: DROP EXTENSION citext, btree_gin, pgcrypto;
--   `vector` is intentionally NOT created here — 0019 is deferred until the
--   embedding dimension is fixed (OQ-11). Creating it now would invite a
--   guessed VECTOR(n) and a full-table rewrite later.
--
-- Idempotent: safe to re-run.

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_bytes for token material
CREATE EXTENSION IF NOT EXISTS citext;     -- users.email is CITEXT (tables.md §2)
CREATE EXTENSION IF NOT EXISTS btree_gin;  -- composite GIN for JSONB + scalar predicates

-- Fail fast on an unsupported server: uuidv7() and the schema below assume 17+.
DO $$
BEGIN
  IF current_setting('server_version_num')::int < 170000 THEN
    RAISE EXCEPTION
      'ContentOS requires PostgreSQL 17 or later (ADR-022); found %',
      current_setting('server_version');
  END IF;
END
$$;
