#!/usr/bin/env bash
# Apply migrations in order.
#
# Migrations are append-only: an applied migration is never edited
# (`03-database/migrations.md`). Re-running skips what is already applied, and a
# checksum mismatch fails loudly rather than letting environments diverge.
#
# Runs identically in CI (service container) and locally (compose) — see psql.sh.
set -euo pipefail
cd "$(dirname "$0")/../.."
# shellcheck source=scripts/db/psql.sh
. scripts/db/psql.sh

echo "==> migration mode: $(db_mode)"

psql_exec "CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now())" >/dev/null

echo "==> applying migrations"
applied_count=0
skipped_count=0

for file in infrastructure/migrations/*.sql; do
  name="$(basename "$file")"
  id="${name%%_*}"
  checksum="$(sha256sum "$file" | cut -d' ' -f1)"

  recorded="$(psql_query "SELECT checksum FROM schema_migrations WHERE id='${id}'" | tr -d '[:space:]')"

  if [ -n "$recorded" ]; then
    # Drift detection: the file on disk differs from what was applied.
    if [ "$recorded" != "$checksum" ]; then
      echo "    DRIFT   $name"
      echo "            recorded: $recorded"
      echo "            on disk : $checksum"
      echo "    Migrations are append-only. Add a new migration; never edit an applied one."
      exit 1
    fi
    echo "    skip    $name"
    skipped_count=$((skipped_count + 1))
    continue
  fi

  echo "    apply   $name"
  psql_file "$file"
  psql_exec "INSERT INTO schema_migrations (id, name, checksum)
             VALUES ('${id}', '${name}', '${checksum}')" >/dev/null
  applied_count=$((applied_count + 1))
done

echo "==> granting login roles into their group roles"
psql_exec "GRANT contentos_app TO contentos_app_login" >/dev/null 2>&1 || true
psql_exec "GRANT contentos_migrator TO contentos_migrator_login" >/dev/null 2>&1 || true

echo "==> migrations current (${applied_count} applied, ${skipped_count} already present)"
