#!/usr/bin/env bash
# Notification verification — the CI gate entry point.
#
# Runs as the APPLICATION role, because the property under test is what THAT
# role can do: immutability here is a column-level GRANT, and a superuser holds
# every column regardless. Run as the owner this gate would pass against a table
# whose payloads are freely rewritable.
#
# One transaction, rolled back, so the gate is repeatable.
set -euo pipefail
cd "$(dirname "$0")/../.."

APP_URL="${APP_DATABASE_URL:-}"
if [ -z "$APP_URL" ]; then
  echo "==> notification verification COULD NOT RUN"
  echo "    APP_DATABASE_URL is not set. What a notification SAID is immutable"
  echo "    because contentos_app was never granted UPDATE on those columns;"
  echo "    only a connection held by that role can demonstrate it."
  exit 1
fi

exec psql -v ON_ERROR_STOP=1 "$APP_URL" -f scripts/db/verify-notifications.sql
