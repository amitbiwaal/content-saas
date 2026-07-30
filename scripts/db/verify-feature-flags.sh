#!/usr/bin/env bash
# Feature flag layer verification — the CI gate entry point.
#
# Runs as the APPLICATION role: the resolver reads flag overrides from an
# RLS-protected workspace layer joined to an exception-table organization layer,
# and a superuser bypasses the policies that decide what it can see.
#
# One transaction, rolled back, so the gate is repeatable.
set -euo pipefail
cd "$(dirname "$0")/../.."

APP_URL="${APP_DATABASE_URL:-}"
if [ -z "$APP_URL" ]; then
  echo "==> feature flag layer verification COULD NOT RUN"
  echo "    APP_DATABASE_URL is not set. Whether a flag override is visible from"
  echo "    under a workspace tenant is an RLS question, and only a connection"
  echo "    held by contentos_app can answer it."
  exit 1
fi

exec psql -v ON_ERROR_STOP=1 "$APP_URL" -f scripts/db/verify-feature-flags.sql
