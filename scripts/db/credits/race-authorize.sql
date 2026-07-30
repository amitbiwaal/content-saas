-- One authorization attempt, run concurrently with many others.
--
-- This is the SEQUENCE `CreditsService.authorizeSpend` issues, reduced to the
-- part a database can be held responsible for: take the organization lock,
-- compute available, reserve only if it covers the request. The service's
-- composition of these steps is unit-tested; what needs a real server is
-- whether the lock serialises across BACKENDS, which no in-process fake can
-- demonstrate.
--
-- `available` mirrors `SUM_OPEN_HOLDS_SQL` in `balance.ts`: the UNSPENT part of
-- open holds, because what is consumed is already a ledger debit.
--
-- Failing to reserve is a normal outcome here — most callers are meant to lose.
\set ON_ERROR_STOP on

BEGIN;

SET LOCAL app.tenant_id = :'org';

-- Transaction-scoped, so it releases on commit or rollback either way.
SELECT pg_advisory_xact_lock(hashtext('credit_authorization'), hashtext(:'org'));

INSERT INTO credit_holds (
  tenant_id, organization_id, workspace_id, run_id, amount, expires_at,
  reason, correlation_id
)
SELECT
  :'org'::uuid, :'org'::uuid, :'ws'::uuid, :'run', :amount::numeric,
  now() + interval '1 hour', 'Race participant.', :'corr'::uuid
WHERE (
  SELECT
    COALESCE(SUM(e.amount) FILTER (WHERE e.direction = 'credit'), 0)
    - COALESCE(SUM(e.amount) FILTER (WHERE e.direction = 'debit'), 0)
    FROM credit_ledger_entries e
   WHERE e.tenant_id = :'org'::uuid
) - (
  SELECT COALESCE(SUM(h.amount - h.consumed), 0)
    FROM credit_holds h
   WHERE h.tenant_id = :'org'::uuid AND h.state = 'held'
) >= :amount::numeric
ON CONFLICT (tenant_id, run_id) DO NOTHING;

COMMIT;
