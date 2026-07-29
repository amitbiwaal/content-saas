#!/usr/bin/env bash
# Shared psql invocation, sourced by the other db scripts.
#
# TWO MODES, one code path:
#
#   DIRECT    — PGHOST is set. PostgreSQL is reachable on the network and the
#               `psql` client runs on this machine. This is GitHub Actions with
#               a service container, and any managed database.
#   COMPOSE   — PGHOST is unset. PostgreSQL runs in the local compose stack and
#               `psql` is invoked inside the container.
#
# The alternative — separate CI and local scripts — means the thing CI verifies
# is not the thing a developer runs, which is exactly how a migration path rots.

COMPOSE_FILE="${COMPOSE_FILE:-infrastructure/containers/docker-compose.yml}"
PG_USER="${PGUSER:-contentos}"
PG_DB="${PGDATABASE:-contentos}"

db_mode() {
  if [ -n "${PGHOST:-}" ]; then echo "direct"; else echo "compose"; fi
}

# Run a single SQL statement, returning tuples-only unaligned output.
psql_query() {
  if [ "$(db_mode)" = "direct" ]; then
    PGPASSWORD="${PGPASSWORD:-}" psql -v ON_ERROR_STOP=1 -tA \
      -h "$PGHOST" -p "${PGPORT:-5432}" -U "$PG_USER" -d "$PG_DB" -c "$1"
  else
    docker compose -f "$COMPOSE_FILE" exec -T postgres \
      psql -v ON_ERROR_STOP=1 -tA -U "$PG_USER" -d "$PG_DB" -c "$1"
  fi
}

# Run a statement, discarding tuple formatting (for DDL and INSERTs).
psql_exec() {
  if [ "$(db_mode)" = "direct" ]; then
    PGPASSWORD="${PGPASSWORD:-}" psql -v ON_ERROR_STOP=1 \
      -h "$PGHOST" -p "${PGPORT:-5432}" -U "$PG_USER" -d "$PG_DB" -c "$1"
  else
    docker compose -f "$COMPOSE_FILE" exec -T postgres \
      psql -v ON_ERROR_STOP=1 -U "$PG_USER" -d "$PG_DB" -c "$1"
  fi
}

# Apply a whole file ATOMICALLY.
#
# `--single-transaction` is load-bearing, not tidiness: the migrations use
# `SET LOCAL ROLE contentos_migrator`, and SET LOCAL outside a transaction block
# is a no-op that emits only a warning — so without this the role would silently
# not be assumed and objects would be owned by the connecting user. It also
# means a migration that fails halfway leaves NOTHING behind.
psql_file() {
  if [ "$(db_mode)" = "direct" ]; then
    PGPASSWORD="${PGPASSWORD:-}" psql -v ON_ERROR_STOP=1 --single-transaction \
      -h "$PGHOST" -p "${PGPORT:-5432}" -U "$PG_USER" -d "$PG_DB" -f "$1"
  else
    docker compose -f "$COMPOSE_FILE" exec -T postgres \
      psql -v ON_ERROR_STOP=1 --single-transaction -U "$PG_USER" -d "$PG_DB" < "$1"
  fi
}
