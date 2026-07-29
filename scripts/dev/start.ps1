#!/usr/bin/env pwsh
# Start the local container stack and wait until it is usable.
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..' '..')

$compose = 'infrastructure/containers/docker-compose.yml'
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw 'docker is required but not installed.' }

Write-Host '==> starting containers'
docker compose -f $compose up -d
if ($LASTEXITCODE -ne 0) { throw 'docker compose up failed' }

# ClamAV loads its signature database on first start and is slow; excluded from
# the readiness wait so a first run does not appear to hang.
Write-Host '==> waiting for postgres, redis, minio'
foreach ($svc in @('postgres', 'redis', 'minio')) {
  $status = 'starting'
  for ($i = 0; $i -lt 60; $i++) {
    $status = (docker inspect -f '{{.State.Health.Status}}' "contentos-$svc" 2>$null)
    if ($status -eq 'healthy') { break }
    Start-Sleep -Seconds 2
  }
  if ($status -ne 'healthy') { throw "$svc did not become healthy" }
  Write-Host ("    {0,-9} ready" -f $svc)
}

Write-Host '==> stack up'
Write-Host '    postgres  localhost:5432'
Write-Host '    redis     localhost:6379'
Write-Host '    minio     localhost:9000  (console :9001)'
Write-Host '    mailpit   localhost:8025'
Write-Host '    clamav    localhost:3310  (signature load may take ~3 min on first run)'
