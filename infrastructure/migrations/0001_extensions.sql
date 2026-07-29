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

-- Fail fast on an unsupported server.
DO $$
BEGIN
  IF current_setting('server_version_num')::int < 170000 THEN
    RAISE EXCEPTION
      'ContentOS requires PostgreSQL 17 or later (ADR-022); found %',
      current_setting('server_version');
  END IF;
END
$$;

-- ── uuidv7() ────────────────────────────────────────────────────────────────
--
-- `03-database/tables.md` §1.1 specifies `DEFAULT uuidv7()` on every table and
-- annotates it "PostgreSQL 17: uuidv7() native". That annotation is incorrect:
-- a native `uuidv7()` arrived in PostgreSQL **18**. ADR-022 pins 17, so the
-- function is supplied here rather than changing every table definition or the
-- pinned version.
--
-- The identifier choice is load-bearing, not cosmetic: v7 is time-ordered, so
-- B-tree insertion stays sequential and index bloat is avoided (tables.md §1.1).
-- Substituting `gen_random_uuid()` would silently discard that property.
--
-- RFC 9562 layout: 48-bit big-endian Unix milliseconds, then version 7, then
-- the variant bits, with the remainder random. Built by overlaying the
-- timestamp onto a v4 UUID and setting the version nibble.
--
-- `CREATE OR REPLACE` keeps this migration idempotent.
CREATE OR REPLACE FUNCTION uuidv7() RETURNS uuid AS $$
  SELECT encode(
    set_bit(
      set_bit(
        overlay(
          uuid_send(gen_random_uuid())
          PLACING substring(
            int8send(floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint)
            FROM 3
          )
          FROM 1 FOR 6
        ),
        52, 1
      ),
      53, 1
    ),
    'hex')::uuid;
$$ LANGUAGE sql VOLATILE;

COMMENT ON FUNCTION uuidv7() IS
  'RFC 9562 UUIDv7. Supplied because PostgreSQL 17 has no native uuidv7(); remove when the pinned server reaches 18.';

-- Verify the bit arithmetic rather than trusting it. A malformed identifier
-- would otherwise propagate into every primary key in the schema before anyone
-- noticed.
DO $$
DECLARE
  sample uuid := uuidv7();
  version_nibble TEXT := substring(sample::text, 15, 1);
  variant_nibble TEXT := substring(sample::text, 20, 1);
BEGIN
  IF version_nibble <> '7' THEN
    RAISE EXCEPTION 'uuidv7() produced version % (expected 7): %', version_nibble, sample;
  END IF;
  IF variant_nibble !~ '^[89ab]$' THEN
    RAISE EXCEPTION 'uuidv7() produced RFC-invalid variant nibble %: %', variant_nibble, sample;
  END IF;
END
$$;
