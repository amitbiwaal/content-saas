#!/usr/bin/env bash
# RLS verification — the CI gate entry point.
#
# The assertions themselves live in `verify-rls.mjs`, and this script is
# deliberately a launcher and nothing else. It used to hold the checks inline,
# including the one numeric constant this increment removed:
#
#     if [ "$count" = "5" ]; then ...
#
# A count cannot tell a permitted exception from an unpermitted one. Swap one
# table for another and the number is unchanged while the guarantee is gone, so
# verification is now driven by the manifest, by name, in both directions.
#
# It stays a shell script because that is the interface CI, the compose stack,
# and the developer runbooks already call.
set -euo pipefail
cd "$(dirname "$0")/../.."

# The artifact the verifier reads must match the TypeScript manifest it is
# generated from. The unit suite asserts the same thing; checking here as well
# means a stale artifact fails the gate rather than being verified against.
node scripts/db/generate-rls-manifest.mjs --check

exec node scripts/db/verify-rls.mjs
