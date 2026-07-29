#!/usr/bin/env bash
# One command, idempotent. Running it twice is safe and re-converges a drifted
# environment — the most common action after pulling a branch that changed
# migrations (`07-development-guide/local-development.md`).
set -euo pipefail
cd "$(dirname "$0")/../.."

echo "==> 1/8 verifying toolchain"
node_major="$(node -v | sed 's/^v\([0-9]*\).*/\1/')"
if [ "$node_major" -lt 22 ]; then
  echo "    Node 22 is required; found $(node -v)."
  echo "    Install via nvm:  nvm install 22 && nvm use 22"
  exit 1
fi
command -v pnpm >/dev/null 2>&1 || {
  echo "    pnpm missing. Run: corepack enable && corepack prepare pnpm@9.15.4 --activate"
  exit 1
}
command -v docker >/dev/null 2>&1 || { echo "    docker is required but not installed."; exit 1; }
echo "    node $(node -v), pnpm $(pnpm -v), docker present"

echo "==> 2/8 installing dependencies (frozen lockfile)"
pnpm install --frozen-lockfile

echo "==> 3/8 creating .env if absent"
if [ -f .env ]; then echo "    .env already present"; else cp .env.example .env; echo "    .env created from template"; fi

echo "==> 4/8 starting containers"
bash scripts/dev/start.sh

echo "==> 5/8 applying migrations"
bash scripts/db/migrate.sh

echo "==> 6/8 verifying RLS conformance"
bash scripts/db/verify-rls.sh

echo "==> 7/8 seeding development data"
bash scripts/db/seed.sh

echo "==> 8/8 building workspace"
pnpm build

echo
echo "==> bootstrap complete. Next: pnpm verify && pnpm test"
