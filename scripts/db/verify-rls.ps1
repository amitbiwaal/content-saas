#!/usr/bin/env pwsh
# RLS verification — the Windows developer entry point.
#
# CARRIED-OVER CORRECTION (T3.3). This script used to be a SECOND, independent
# implementation of the checks, and it still held the constant that increment
# removed everywhere else:
#
#     if ($count -eq '5') { ... }
#
# Two implementations of one security gate is how they diverge: this one checked
# five of the assertions the manifest now declares twenty of, so a developer
# could see GREEN on Windows for a schema CI would reject. It is now the same
# launcher `verify-rls.sh` is, over the same manifest-driven engine.
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..' '..')

# The artifact the verifier reads must match the TypeScript manifest it is
# generated from; a stale artifact fails the gate rather than being verified
# against.
node scripts/db/generate-rls-manifest.mjs --check
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

node scripts/db/verify-rls.mjs
exit $LASTEXITCODE
