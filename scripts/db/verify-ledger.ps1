#!/usr/bin/env pwsh
# Credit ledger verification — the Windows developer entry point.
#
# A launcher over the same `verify-ledger.sql` the POSIX script and CI run. It
# is deliberately not a second implementation of the checks: two implementations
# of one gate is how a developer comes to see GREEN locally for a schema CI
# rejects, which is the failure `verify-rls.ps1` actually had.
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..' '..')

if ([string]::IsNullOrEmpty($env:APP_DATABASE_URL)) {
  Write-Host '==> credit ledger verification COULD NOT RUN'
  Write-Host '    APP_DATABASE_URL is not set. The append-only guarantee is a PRIVILEGE'
  Write-Host '    of contentos_app, so it can only be observed on a connection that holds'
  Write-Host '    it — the owner and a superuser both bypass what this gate checks.'
  exit 1
}

psql -v ON_ERROR_STOP=1 $env:APP_DATABASE_URL -f scripts/db/verify-ledger.sql
exit $LASTEXITCODE
