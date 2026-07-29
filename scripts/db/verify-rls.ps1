#!/usr/bin/env pwsh
# Sprint 0 exit criterion, checked against a REAL PostgreSQL instance.
# Six of the seven RLS failure modes have NO SYMPTOM, so each is checked
# explicitly rather than inferred from the application working.
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..' '..')

$compose = 'infrastructure/containers/docker-compose.yml'
function Q([string]$sql) {
  ((docker compose -f $compose exec -T postgres psql -v ON_ERROR_STOP=1 -tA -U contentos -d contentos -c $sql) -join '').Trim()
}

$fail = 0
Write-Host '==> RLS conformance'

$count = Q "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND NOT c.relrowsecurity AND c.relname <> 'schema_migrations'"
if ($count -eq '5') { Write-Host '    exception tables:        5' }
else { Write-Host "    FAIL exception tables:   $count (must be exactly 5; a sixth requires an ADR)"; $fail = 1 }

$missingForce = Q "SELECT coalesce(string_agg(c.relname, ','), '') FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND c.relrowsecurity AND NOT c.relforcerowsecurity"
if ([string]::IsNullOrEmpty($missingForce)) { Write-Host '    ENABLE + FORCE:          all tables' }
else { Write-Host "    FAIL missing FORCE on:   $missingForce"; $fail = 1 }

$bypass = Q "SELECT rolbypassrls FROM pg_roles WHERE rolname='contentos_app'"
if ($bypass -eq 'f') { Write-Host '    contentos_app BYPASSRLS: no' }
else { Write-Host '    FAIL contentos_app holds BYPASSRLS — isolation disabled platform-wide'; $fail = 1 }

$owned = Q "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND pg_get_userbyid(c.relowner)='contentos_app'"
if ($owned -eq '0') { Write-Host '    contentos_app owns:      0 tables' }
else { Write-Host "    FAIL contentos_app owns $owned table(s) — an owner bypasses RLS"; $fail = 1 }

$nocheck = Q "SELECT coalesce(string_agg(tablename, ','), '') FROM pg_policies WHERE schemaname='public' AND cmd='ALL' AND with_check IS NULL"
if ([string]::IsNullOrEmpty($nocheck)) { Write-Host '    WITH CHECK:              present on every FOR ALL policy' }
else { Write-Host "    FAIL policies without WITH CHECK: $nocheck — permits cross-tenant WRITES"; $fail = 1 }

if ($fail -eq 0) { Write-Host '==> RLS conformance GREEN' } else { Write-Host '==> RLS conformance FAILED'; exit 1 }
