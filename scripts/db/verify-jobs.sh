#!/usr/bin/env bash
# Job lifecycle verification — the CI gate entry point.
#
# Runs as the APPLICATION role, because the properties under test are what THAT
# role sees: RLS is not applied to a superuser, so run as the owner this gate
# would report isolation on a table where every tenant reads every job.
#
# The guarded transitions need a server for a different reason — an UPDATE that
# matches nothing is indistinguishable from one that matches a row until
# PostgreSQL reports the count.
#
# One transaction, rolled back, so the gate is repeatable.
set -euo pipefail
cd "$(dirname "$0")/../.."

APP_URL="${APP_DATABASE_URL:-}"
if [ -z "$APP_URL" ]; then
  echo "==> job lifecycle verification COULD NOT RUN"
  echo "    APP_DATABASE_URL is not set. Tenant isolation on jobs is a property"
  echo "    of the policies contentos_app runs under; a superuser bypasses them"
  echo "    and this gate would pass against a table with no isolation at all."
  exit 1
fi

exec psql -v ON_ERROR_STOP=1 "$APP_URL" -f scripts/db/verify-jobs.sql
