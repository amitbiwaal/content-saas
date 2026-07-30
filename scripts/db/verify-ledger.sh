#!/usr/bin/env bash
# Credit ledger verification — the CI gate entry point.
#
# The assertions live in `verify-ledger.sql` and run as the APPLICATION role,
# because that is the only role whose privileges are the thing under test. A
# check run as the owner or as a superuser would pass against a ledger the
# application can freely rewrite.
#
# Everything runs in one transaction that is rolled back, so the gate is
# repeatable and leaves no rows behind — which matters here more than usual:
# the ledger has no DELETE path to clean up with.
set -euo pipefail
cd "$(dirname "$0")/../.."

APP_URL="${APP_DATABASE_URL:-}"
if [ -z "$APP_URL" ]; then
  echo "==> credit ledger verification COULD NOT RUN"
  echo "    APP_DATABASE_URL is not set. The append-only guarantee is a PRIVILEGE"
  echo "    of contentos_app, so it can only be observed on a connection that holds"
  echo "    it — the owner and a superuser both bypass what this gate checks."
  exit 1
fi

# ON_ERROR_STOP makes the final RAISE EXCEPTION a non-zero exit; the assertion
# report itself arrives as NOTICEs on stderr, so both streams are kept.
exec psql -v ON_ERROR_STOP=1 "$APP_URL" -f scripts/db/verify-ledger.sql
