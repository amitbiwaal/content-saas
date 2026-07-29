#!/usr/bin/env bash
# Idempotent development seed. Safe to run repeatedly.
#
# SQL lives in seed.sql so the bash, PowerShell, and CI paths share one source.
# Runs identically in CI (service container) and locally (compose).
set -euo pipefail
cd "$(dirname "$0")/../.."
# shellcheck source=scripts/db/psql.sh
. scripts/db/psql.sh

echo "==> seeding development data (mode: $(db_mode))"
psql_file scripts/db/seed.sql
echo "==> seed complete (workspace 018f7a1e-0000-7000-8000-0000000000bb)"
