#!/usr/bin/env bash
# Settings layer verification — the CI gate entry point.
#
# Runs as the APPLICATION role, because the property under test is what THAT
# role can see: the resolver joins an RLS-protected table to an exception table
# from under a workspace tenant, and a superuser bypasses the very policies that
# decide whether the join returns anything.
#
# One transaction, rolled back, so the gate is repeatable.
set -euo pipefail
cd "$(dirname "$0")/../.."

APP_URL="${APP_DATABASE_URL:-}"
if [ -z "$APP_URL" ]; then
  echo "==> settings layer verification COULD NOT RUN"
  echo "    APP_DATABASE_URL is not set. Whether the organization layer is"
  echo "    readable from under a workspace tenant is an RLS question, and only"
  echo "    a connection held by contentos_app can answer it."
  exit 1
fi

exec psql -v ON_ERROR_STOP=1 "$APP_URL" -f scripts/db/verify-settings.sql
