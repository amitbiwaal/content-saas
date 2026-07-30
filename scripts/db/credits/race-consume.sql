-- One consumption attempt against a shared hold, run concurrently with others.
--
-- `SELECT ... FOR UPDATE` is what serialises these: under READ COMMITTED the
-- second waiter re-reads the COMMITTED row and sees `consumed` already
-- advanced, rather than the value it queued behind. Without it, every attempt
-- would read zero and the reservation bound would mean nothing.
--
-- The ledger insert converges on `UNIQUE (tenant_id, idempotency_key)`, and
-- `consumed` advances only when that insert really wrote a row — which is what
-- keeps the hold and the ledger in agreement.
\set ON_ERROR_STOP on

BEGIN;

SET LOCAL app.tenant_id = :'org';

SELECT id FROM credit_holds
 WHERE tenant_id = :'org'::uuid AND id = :'hold'::uuid AND state = 'held'
   FOR UPDATE;

WITH appended AS (
  INSERT INTO credit_ledger_entries (
    tenant_id, organization_id, workspace_id, entry_type, amount, direction,
    idempotency_key, reason, correlation_id
  )
  SELECT
    :'org'::uuid, :'org'::uuid, :'ws'::uuid, 'consumption', :amount::numeric, 'debit',
    :'key', 'Race consumption.', :'corr'::uuid
  -- Only within the reservation. The CHECK below is the backstop; this is what
  -- lets the losers fail cleanly instead of aborting on a constraint.
  WHERE (
    SELECT h.amount - h.consumed FROM credit_holds h
     WHERE h.tenant_id = :'org'::uuid AND h.id = :'hold'::uuid AND h.state = 'held'
  ) >= :amount::numeric
  ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
  RETURNING amount
)
UPDATE credit_holds
   SET consumed = consumed + (SELECT amount FROM appended), updated_at = now()
 WHERE tenant_id = :'org'::uuid
   AND id = :'hold'::uuid
   AND state = 'held'
   AND EXISTS (SELECT 1 FROM appended);

COMMIT;
