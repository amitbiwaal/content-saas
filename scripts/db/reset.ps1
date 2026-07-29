#!/usr/bin/env pwsh
# DESTRUCTIVE: drops the database volume and rebuilds from migration 0001.
# Local only. Refuses to run unless NODE_ENV is development or unset.
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..' '..')

$env_name = if ($env:NODE_ENV) { $env:NODE_ENV } else { 'development' }
if ($env_name -ne 'development') {
  Write-Host "reset refuses to run with NODE_ENV=$env_name. Local development only."
  exit 1
}

$confirm = Read-Host "This DELETES all local database data. Type 'reset' to continue"
if ($confirm -ne 'reset') { Write-Host 'aborted'; exit 1 }

$compose = 'infrastructure/containers/docker-compose.yml'
docker compose -f $compose stop postgres
docker compose -f $compose rm -f postgres
docker volume rm -f contentos_postgres-data
& (Join-Path $PSScriptRoot '..' 'dev' 'start.ps1')
& (Join-Path $PSScriptRoot 'migrate.ps1')
& (Join-Path $PSScriptRoot 'seed.ps1')
Write-Host '==> reset complete'
