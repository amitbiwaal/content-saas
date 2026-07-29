#!/usr/bin/env bash
# Start the local container stack and wait until it is usable.
set -euo pipefail
cd "$(dirname "$0")/../.."

COMPOSE_FILE="infrastructure/containers/docker-compose.yml"
command -v docker >/dev/null 2>&1 || { echo "docker is required but not installed."; exit 1; }

echo "==> starting containers"
docker compose -f "$COMPOSE_FILE" up -d

# ClamAV loads its signature database on first start and is slow; it is excluded
# from the readiness wait so a first run does not appear to hang.
echo "==> waiting for postgres, redis, minio"
for svc in postgres redis minio; do
  printf '    %-9s' "$svc"
  status=starting
  for _ in $(seq 1 60); do
    status="$(docker inspect -f '{{.State.Health.Status}}' "contentos-$svc" 2>/dev/null || echo starting)"
    if [ "$status" = "healthy" ]; then echo "ready"; break; fi
    sleep 2
  done
  if [ "$status" != "healthy" ]; then echo "NOT READY"; exit 1; fi
done

echo "==> stack up"
echo "    postgres  localhost:5432"
echo "    redis     localhost:6379"
echo "    minio     localhost:9000  (console :9001)"
echo "    mailpit   localhost:8025"
echo "    clamav    localhost:3310  (signature load may take ~3 min on first run)"
