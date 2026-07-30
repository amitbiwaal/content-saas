#!/usr/bin/env bash
# The Sprint Gate's concurrency evidence, against real PostgreSQL.
#
# Everything here runs as the APPLICATION role, in genuinely parallel backends.
# The in-process suite interleaves promises, which proves the service issues the
# right sequence; it cannot prove that `pg_advisory_xact_lock` serialises across
# CONNECTIONS, or that a unique index holds when twenty transactions race for
# it. Those are properties of a server.
#
# Three races, and the invariant each one is allowed to violate if the guard is
# missing:
#
#   1. authorize   — over-reservation: more credits reserved than exist.
#   2. one-run     — double reservation for a single run id.
#   3. consume     — double-charging, and spend past the hold's bound.
#
# Rows are COMMITTED here — a race cannot be observed inside one transaction —
# so everything created is tagged with a distinctive correlation id and removed
# afterwards, including on failure.
set -euo pipefail
cd "$(dirname "$0")/../.."
# shellcheck source=scripts/db/psql.sh
. scripts/db/psql.sh

APP_URL="${APP_DATABASE_URL:-}"
if [ -z "$APP_URL" ]; then
  echo "==> credits concurrency verification COULD NOT RUN"
  echo "    APP_DATABASE_URL is not set. These races must run as contentos_app:"
  echo "    a superuser bypasses the RLS the concurrent statements run under."
  exit 1
fi

ORG='018f7a1e-0000-7000-8000-0000000000aa'   # seeded organization
WS='018f7a1e-0000-7000-8000-0000000000bb'    # seeded workspace
CORR='018f7a1e-0000-7000-8000-00000000face'  # tags everything this gate creates
WORKERS=12

fail=0
note() { printf '    %-4s %-40s %s\n' "$1" "$2" "$3"; }
bad() { note FAIL "$1" "$2"; fail=1; }

# Cleanup runs as the migration role, which is the only one that can remove a
# ledger row at all — the application's DELETE is revoked, by design.
cleanup() {
  psql_exec "DELETE FROM credit_ledger_entries WHERE correlation_id = '${CORR}'" >/dev/null 2>&1 || true
  psql_exec "DELETE FROM credit_holds        WHERE correlation_id = '${CORR}'" >/dev/null 2>&1 || true
  psql_exec "DELETE FROM credit_balances     WHERE tenant_id = '${ORG}'" >/dev/null 2>&1 || true
}
trap cleanup EXIT

app_query() { psql -v ON_ERROR_STOP=1 -tA "$APP_URL" -c "$1" | tr -d '[:space:]'; }

# `SET LOCAL` needs the statement in the same transaction as the query.
scoped_query() {
  psql -v ON_ERROR_STOP=1 -tA "$APP_URL" \
    -c "BEGIN; SET LOCAL app.tenant_id = '${ORG}'; $1; COMMIT;" | grep -E '^-?[0-9.]+$' | head -1
}

echo "==> credits concurrency verification (${WORKERS} parallel backends)"

cleanup

# ── Fixture: a committed grant of 100 credits ───────────────────────────────
psql_exec "INSERT INTO credit_ledger_entries (
             tenant_id, organization_id, entry_type, amount, direction,
             reason, correlation_id)
           VALUES ('${ORG}','${ORG}','grant',100,'credit','Race fixture.','${CORR}')" >/dev/null

granted="$(scoped_query "SELECT count(*) FROM credit_ledger_entries WHERE correlation_id = '${CORR}'")"
if [ "$granted" = "1" ]; then
  note PASS "race-fixture-granted" "100 credits are on the ledger."
else
  bad "race-fixture-granted" "expected 1 grant, found '${granted}'. Nothing below was verified."
  exit 1
fi

# ── Race 1 · parallel authorization cannot over-reserve ─────────────────────
# Twelve runs each want 20 against a balance of 100. At most five may succeed.
for i in $(seq 1 "$WORKERS"); do
  psql -q "$APP_URL" \
    -v org="$ORG" -v ws="$WS" -v corr="$CORR" -v amount=20 -v run="race-auth-${i}" \
    -f scripts/db/credits/race-authorize.sql >/dev/null 2>&1 &
done
wait

reserved="$(scoped_query "SELECT COALESCE(SUM(amount - consumed),0)::text FROM credit_holds WHERE tenant_id='${ORG}' AND state='held'")"
held_count="$(scoped_query "SELECT count(*) FROM credit_holds WHERE tenant_id='${ORG}' AND state='held'")"

if [ "$held_count" = "5" ]; then
  note PASS "race-authorize-exact" "exactly 5 of ${WORKERS} parallel runs reserved."
else
  bad "race-authorize-exact" "${held_count} holds exist; 100 credits at 20 each admits exactly 5."
fi

# The invariant that matters even if the count is off for another reason.
over="$(scoped_query "SELECT CASE WHEN COALESCE(SUM(amount - consumed),0) > 100 THEN 1 ELSE 0 END FROM credit_holds WHERE tenant_id='${ORG}' AND state='held'")"
if [ "$over" = "0" ]; then
  note PASS "race-authorize-no-over-reserve" "reserved ${reserved} of 100 — never more than exists."
else
  bad "race-authorize-no-over-reserve" "reserved ${reserved} against a balance of 100. Credits were sold twice."
fi

# ── Race 2 · one run id reserves once ───────────────────────────────────────
for i in $(seq 1 "$WORKERS"); do
  psql -q "$APP_URL" \
    -v org="$ORG" -v ws="$WS" -v corr="$CORR" -v amount=0 -v run="race-single-run" \
    -f scripts/db/credits/race-authorize.sql >/dev/null 2>&1 &
done
wait

singles="$(scoped_query "SELECT count(*) FROM credit_holds WHERE tenant_id='${ORG}' AND run_id='race-single-run'")"
if [ "$singles" = "1" ]; then
  note PASS "race-one-hold-per-run" "${WORKERS} concurrent attempts produced one hold."
else
  bad "race-one-hold-per-run" "${singles} holds exist for one run id — a retry storm reserved repeatedly."
fi

# ── Race 3 · parallel consumption cannot double-charge ──────────────────────
# One hold of 50. Twelve backends each try to charge 10 under the SAME
# idempotency key: exactly one charge may land.
psql_exec "INSERT INTO credit_holds (
             tenant_id, organization_id, workspace_id, run_id, amount,
             expires_at, reason, correlation_id)
           VALUES ('${ORG}','${ORG}','${WS}','race-consume',50,
                   now() + interval '1 hour','Race fixture.','${CORR}')" >/dev/null

hold_id="$(scoped_query "SELECT count(*) FROM credit_holds WHERE run_id='race-consume'")"
if [ "$hold_id" != "1" ]; then
  bad "race-consume-fixture" "the consumption fixture hold was not created."
  exit 1
fi
HOLD="$(psql -v ON_ERROR_STOP=1 -tA "$APP_URL" \
  -c "BEGIN; SET LOCAL app.tenant_id = '${ORG}'; SELECT id FROM credit_holds WHERE run_id='race-consume'; COMMIT;" \
  | grep -Ei '^[0-9a-f-]{36}$' | head -1)"

for _ in $(seq 1 "$WORKERS"); do
  psql -q "$APP_URL" \
    -v org="$ORG" -v ws="$WS" -v corr="$CORR" -v amount=10 \
    -v hold="$HOLD" -v key="race-consume:step-1" \
    -f scripts/db/credits/race-consume.sql >/dev/null 2>&1 &
done
wait

charges="$(scoped_query "SELECT count(*) FROM credit_ledger_entries WHERE tenant_id='${ORG}' AND idempotency_key='race-consume:step-1'")"
consumed="$(scoped_query "SELECT consumed::text FROM credit_holds WHERE run_id='race-consume'")"

if [ "$charges" = "1" ]; then
  note PASS "race-consume-exactly-once" "${WORKERS} concurrent retries produced one ledger entry."
else
  bad "race-consume-exactly-once" "${charges} entries hold one idempotency key — the customer was charged ${charges} times."
fi

if [ "$consumed" = "10.000000" ]; then
  note PASS "race-consume-hold-agrees" "the hold advanced once, to ${consumed}."
else
  bad "race-consume-hold-agrees" "hold consumed=${consumed}, expected 10.000000 — the hold and the ledger disagree."
fi

# ── Race 4 · distinct concurrent charges stay inside the reservation ────────
for i in $(seq 1 "$WORKERS"); do
  psql -q "$APP_URL" \
    -v org="$ORG" -v ws="$WS" -v corr="$CORR" -v amount=10 \
    -v hold="$HOLD" -v key="race-consume:distinct-${i}" \
    -f scripts/db/credits/race-consume.sql >/dev/null 2>&1 &
done
wait

final="$(scoped_query "SELECT consumed::text FROM credit_holds WHERE run_id='race-consume'")"
within="$(scoped_query "SELECT CASE WHEN consumed <= amount THEN 1 ELSE 0 END FROM credit_holds WHERE run_id='race-consume'")"
if [ "$within" = "1" ]; then
  note PASS "race-consume-within-bound" "consumed ${final} of a 50 reservation — the bound held."
else
  bad "race-consume-within-bound" "consumed ${final} against a 50 reservation. The spend bound is not enforced."
fi

# The ledger and the hold must agree to the last decimal, or reconciliation
# reports a discrepancy nobody can explain.
ledger_total="$(scoped_query "SELECT COALESCE(SUM(amount),0)::text FROM credit_ledger_entries WHERE tenant_id='${ORG}' AND direction='debit' AND correlation_id='${CORR}'")"
if [ "$ledger_total" = "$final" ]; then
  note PASS "race-ledger-reconciles" "ledger debits ${ledger_total} equal hold consumption ${final}."
else
  bad "race-ledger-reconciles" "ledger debits ${ledger_total} but the hold recorded ${final}."
fi

if [ "$fail" = "0" ]; then
  echo "==> credits concurrency verification GREEN"
else
  echo "==> credits concurrency verification FAILED"
  exit 1
fi
