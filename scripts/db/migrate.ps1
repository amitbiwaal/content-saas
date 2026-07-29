#!/usr/bin/env pwsh
# Apply migrations in order. Migrations are append-only: an applied migration is
# never edited (03-database/migrations.md). Re-running skips what is applied.
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..' '..')

$compose = 'infrastructure/containers/docker-compose.yml'
function Invoke-Psql([string]$sql) {
  docker compose -f $compose exec -T postgres psql -v ON_ERROR_STOP=1 -tA -U contentos -d contentos -c $sql
}

Invoke-Psql "CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())" | Out-Null

Write-Host '==> applying migrations'
foreach ($file in Get-ChildItem 'infrastructure/migrations/*.sql' | Sort-Object Name) {
  $id = $file.Name.Split('_')[0]
  $applied = (Invoke-Psql "SELECT 1 FROM schema_migrations WHERE id='$id'") -join ''
  if ($applied.Trim() -eq '1') { Write-Host "    skip    $($file.Name)"; continue }

  Write-Host "    apply   $($file.Name)"
  Get-Content -Raw $file.FullName | docker compose -f $compose exec -T postgres psql -v ON_ERROR_STOP=1 -U contentos -d contentos
  if ($LASTEXITCODE -ne 0) { throw "migration $($file.Name) failed" }

  $checksum = (Get-FileHash $file.FullName -Algorithm SHA256).Hash.ToLower()
  Invoke-Psql "INSERT INTO schema_migrations (id, name, checksum) VALUES ('$id', '$($file.Name)', '$checksum') ON CONFLICT (id) DO NOTHING" | Out-Null
}

Write-Host '==> granting login roles into their group roles'
try { Invoke-Psql "GRANT contentos_app TO contentos_app_login" | Out-Null } catch {}
try { Invoke-Psql "GRANT contentos_migrator TO contentos_migrator_login" | Out-Null } catch {}

Write-Host '==> migrations current'
