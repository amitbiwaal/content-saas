#!/usr/bin/env bash
# Stop the stack. Volumes are PRESERVED; use scripts/db/reset.* to drop data.
set -euo pipefail
cd "$(dirname "$0")/../.."
docker compose -f infrastructure/containers/docker-compose.yml down
echo "==> stopped (volumes preserved)"
