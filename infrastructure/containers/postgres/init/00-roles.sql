-- Runs once, on first container start, BEFORE any migration.
--
-- Creates the login roles the application uses. Migration 0002 creates the
-- NOLOGIN roles and their grants; this file only gives the local containers a
-- way to connect as them. Production credentials come from the secret store
-- (16-security/secrets-management.md) and never from a file like this.
--
-- Development passwords only. This file is local-compose scoped.

CREATE ROLE contentos_app_login LOGIN PASSWORD 'contentos_dev_app';
CREATE ROLE contentos_migrator_login LOGIN PASSWORD 'contentos_dev_migrator';

-- 0002 creates contentos_app / contentos_migrator as NOLOGIN group roles and
-- assigns privileges; the login roles above are granted into them by
-- scripts/db/migrate.* after migrations have run.
