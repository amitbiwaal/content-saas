#!/usr/bin/env bash
# Credits verification — the CI gate entry point.
#
# Two halves, and neither substitutes for the other:
#
#   `verify-credits.sql`             the schema: hold state machine, the spend
#                                    bound, RLS on both new tables. One
#                                    transaction, rolled back.
#   `verify-credits-concurrency.sh`  the races, in genuinely parallel backends.
#                                    A race cannot be observed inside a single
#                                    transaction, so this one commits and cleans
#                                    up after itself.
#
# Both run as the APPLICATION role, because the guarantees under test are
# properties of what THAT role can do. A superuser bypasses RLS entirely and
# would pass a schema that isolates nothing.
set -euo pipefail
cd "$(dirname "$0")/../.."

APP_URL="${APP_DATABASE_URL:-}"
if [ -z "$APP_URL" ]; then
  echo "==> credits verification COULD NOT RUN"
  echo "    APP_DATABASE_URL is not set. RLS and the concurrent races are"
  echo "    observable only on a connection held by contentos_app."
  exit 1
fi

psql -v ON_ERROR_STOP=1 "$APP_URL" -f scripts/db/verify-credits.sql
bash scripts/db/verify-credits-concurrency.sh
