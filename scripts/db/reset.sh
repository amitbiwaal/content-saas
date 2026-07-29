#!/usr/bin/env bash
# DESTRUCTIVE: drops the database volume and rebuilds from migration 0001.
# Local only. Refuses to run unless NODE_ENV is development or unset.
set -euo pipefail
cd "$(dirname "$0")/../.."

if [ "${NODE_ENV:-development}" != "development" ]; then
  echo "reset refuses to run with NODE_ENV=${NODE_ENV}. Local development only."
  exit 1
fi

read -r -p "This DELETES all local database data. Type 'reset' to continue: " confirm
if [ "$confirm" != "reset" ]; then echo "aborted"; exit 1; fi

COMPOSE="infrastructure/containers/docker-compose.yml"
docker compose -f "$COMPOSE" stop postgres
docker compose -f "$COMPOSE" rm -f postgres
docker volume rm -f contentos_postgres-data
bash scripts/dev/start.sh
bash scripts/db/migrate.sh
bash scripts/db/seed.sh
echo "==> reset complete"
