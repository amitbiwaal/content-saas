-- 0002_roles_and_grants.sql
--
-- Spec: 03-database/migrations.md — 0002 roles_and_grants, BEFORE every table.
--   "Roles and grants come first because RLS is meaningless without a
--    non-superuser application role, and creating tables before the role that
--    will be denied by policy invites a window where policies are declared but
--    unenforced."
--
-- Role model owned by 16-security/row-level-security.md §"Role model", which
-- names the database roles and their privileges.
--
-- NAMING NOTE: migrations.md sketches these as `app_user, migrator, relay,
-- analytics_reader`; row-level-security.md names `contentos_app`,
-- `contentos_migrator`, `contentos_operator`. The RLS document owns the role
-- model, so its names and prefix are canonical here. `relay` and
-- `analytics_reader` are additionally required by 03-database/tables.md §8
-- (outbox relay cross-tenant read) and are created under the same prefix.
--
-- ROLLBACK: REASSIGN OWNED BY contentos_migrator TO CURRENT_USER;
--           DROP OWNED BY <each role>; DROP ROLE <each role>;
--
-- Idempotent: safe to re-run.

DO $$
BEGIN
  -- contentos_app — the ONLY role in the request path.
  -- NOBYPASSRLS is the single most important privilege statement in the
  -- platform: a role with BYPASSRLS ignores every policy silently.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'contentos_app') THEN
    CREATE ROLE contentos_app NOLOGIN NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;

  -- contentos_migrator — owns tables; DDL only; never serves requests.
  -- The application must NOT connect as the owner: a table's owner bypasses
  -- RLS by default unless FORCE is set, so ownership is kept away from the
  -- request path as defence in depth alongside FORCE.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'contentos_migrator') THEN
    CREATE ROLE contentos_migrator NOLOGIN NOBYPASSRLS NOSUPERUSER CREATEDB;
  END IF;

  -- contentos_operator — break-glass only. Human-initiated, time-boxed, and
  -- every session is audited and pages unconditionally.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'contentos_operator') THEN
    CREATE ROLE contentos_operator NOLOGIN BYPASSRLS NOSUPERUSER;
  END IF;

  -- contentos_relay — outbox relay; documented, audited cross-tenant read
  -- (03-database/tables.md §8). NOT BYPASSRLS: it is granted an explicit
  -- policy on outbox_events at 0015 rather than blanket bypass.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'contentos_relay') THEN
    CREATE ROLE contentos_relay NOLOGIN NOBYPASSRLS NOSUPERUSER;
  END IF;

  -- contentos_analytics — read-only reporting path.
  -- Read replicas enforce identical policies; a reporting role with BYPASSRLS
  -- would be a complete bypass, which is the usual way this is introduced.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'contentos_analytics') THEN
    CREATE ROLE contentos_analytics NOLOGIN NOBYPASSRLS NOSUPERUSER;
  END IF;
END
$$;

-- Schema usage. Tables are owned by the migrator; the app never owns anything.
GRANT USAGE ON SCHEMA public TO contentos_app, contentos_relay, contentos_analytics;

-- The migrator owns every table, so it must be able to create them.
--
-- PostgreSQL 15 removed the implicit `CREATE` grant on schema `public` that
-- earlier versions gave to `PUBLIC`; only the database owner retains it. Without
-- this, `SET LOCAL ROLE contentos_migrator` in 0003 fails with
-- "permission denied for schema public" on the first CREATE TABLE.
GRANT CREATE, USAGE ON SCHEMA public TO contentos_migrator;

-- Default privileges for objects the migrator creates from here on.
ALTER DEFAULT PRIVILEGES FOR ROLE contentos_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO contentos_app;

ALTER DEFAULT PRIVILEGES FOR ROLE contentos_migrator IN SCHEMA public
  GRANT SELECT ON TABLES TO contentos_analytics;

ALTER DEFAULT PRIVILEGES FOR ROLE contentos_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO contentos_app;

-- Guard: contentos_app must never acquire BYPASSRLS. Asserted here at migrate
-- time and again by the conformance suite on every CI run.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'contentos_app' AND rolbypassrls) THEN
    RAISE EXCEPTION
      'contentos_app holds BYPASSRLS — tenant isolation would be disabled platform-wide';
  END IF;
END
$$;
