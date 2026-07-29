#!/usr/bin/env pwsh
# One command, idempotent. Running it twice is safe and re-converges a drifted
# environment (07-development-guide/local-development.md).
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..' '..')

Write-Host '==> 1/8 verifying toolchain'
$nodeMajor = [int]((node -v) -replace '^v(\d+).*', '$1')
if ($nodeMajor -lt 22) {
  Write-Host "    Node 22 is required; found $(node -v)."
  Write-Host '    Install via nvm-windows:  nvm install 22 ; nvm use 22'
  exit 1
}
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
  Write-Host '    pnpm missing. Run: corepack enable ; corepack prepare pnpm@9.15.4 --activate'
  exit 1
}
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw 'docker is required but not installed.' }
Write-Host "    node $(node -v), pnpm $(pnpm -v), docker present"

Write-Host '==> 2/8 installing dependencies (frozen lockfile)'
pnpm install --frozen-lockfile
if ($LASTEXITCODE -ne 0) { throw 'pnpm install failed' }

Write-Host '==> 3/8 creating .env if absent'
if (Test-Path .env) { Write-Host '    .env already present' }
else { Copy-Item .env.example .env; Write-Host '    .env created from template' }

Write-Host '==> 4/8 starting containers'
& (Join-Path $PSScriptRoot 'start.ps1')

Write-Host '==> 5/8 applying migrations'
& (Join-Path $PSScriptRoot '..' 'db' 'migrate.ps1')

Write-Host '==> 6/8 verifying RLS conformance'
& (Join-Path $PSScriptRoot '..' 'db' 'verify-rls.ps1')

Write-Host '==> 7/8 seeding development data'
& (Join-Path $PSScriptRoot '..' 'db' 'seed.ps1')

Write-Host '==> 8/8 building workspace'
pnpm build
if ($LASTEXITCODE -ne 0) { throw 'pnpm build failed' }

Write-Host ''
Write-Host '==> bootstrap complete. Next: pnpm verify ; pnpm test'
