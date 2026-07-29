#!/usr/bin/env pwsh
# Stop the stack. Volumes are PRESERVED; use scripts/db/reset.ps1 to drop data.
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..' '..')
docker compose -f infrastructure/containers/docker-compose.yml down
Write-Host '==> stopped (volumes preserved)'
