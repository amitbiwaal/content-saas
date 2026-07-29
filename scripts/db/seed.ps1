#!/usr/bin/env pwsh
# Idempotent development seed. Safe to run repeatedly.
# Seeds ONLY the identity and tenancy tables that exist at migration 0005.
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..' '..')

Write-Host '==> seeding development data'
Get-Content -Raw 'scripts/db/seed.sql' |
  docker compose -f infrastructure/containers/docker-compose.yml exec -T postgres `
    psql -v ON_ERROR_STOP=1 -U contentos -d contentos
if ($LASTEXITCODE -ne 0) { throw 'seed failed' }
Write-Host '==> seed complete (workspace 018f7a1e-0000-7000-8000-0000000000bb)'
