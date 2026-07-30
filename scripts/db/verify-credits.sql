-- Credits schema verification, run as the APPLICATION role against real PostgreSQL.
--
-- The hold state machine, the reservation bound, and RLS on the two tables
-- 0022 adds. Everything runs inside ONE transaction that is rolled back, so the
-- gate is repeatable and leaves no rows behind.
--
-- The CONCURRENCY half is a separate script: proving that parallel
-- authorizations cannot over-reserve needs real backends running at the same
-- time, which a single session cannot demonstrate.
--
-- Failures are aggregated; every assertion reports PASS or FAIL and the run
-- always completes. Results accumulate in an ARRAY rather than a temp table: a
-- caught exception rolls back database changes made inside the block, so a
-- table would lose the very rows recording what failed.

BEGIN;

DO $verify$
DECLARE
  ORG   CONSTANT UUID := '018f7a1e-0000-7000-8000-0000000000aa';  -- seeded organization
  WS    CONSTANT UUID := '018f7a1e-0000-7000-8000-0000000000bb';  -- seeded workspace
  OTHER CONSTANT UUID := '018f7a1e-0000-7000-8000-0000000000cc';  -- a tenant that is not ORG
  ACTOR CONSTANT UUID := '018f7a1e-0000-7000-8000-000000000001';
  CORR  CONSTANT UUID := '018f7a1e-0000-7000-8000-00000000c0bb';
  FUTURE CONSTANT TIMESTAMPTZ := now() + interval '1 day';

  REPORT CONSTANT TEXT := '    %-4s %-40s %s';

  results  TEXT[] := '{}';
  failures INT    := 0;

  hold_id  UUID;
  seen     INT;
  line     TEXT;
BEGIN
  PERFORM set_config('app.tenant_id', ORG::text, true);

  -- ── 1 · a hold can be taken ───────────────────────────────────────────────
  BEGIN
    INSERT INTO credit_holds (
      tenant_id, organization_id, workspace_id, run_id, amount, expires_at,
      reason, correlation_id, created_by
    ) VALUES (ORG, ORG, WS, 'verify-credits-run-1', 20, FUTURE,
              'Gate fixture.', CORR, ACTOR)
    RETURNING id INTO hold_id;
    results := results || format(REPORT, 'PASS', 'holds-insert-permitted',
      'the application role can take a hold.');
  EXCEPTION WHEN OTHERS THEN
    failures := failures + 1;
    results := results || format(REPORT, 'FAIL', 'holds-insert-permitted',
      'a valid hold was rejected: ' || SQLERRM);
  END;

  IF hold_id IS NULL THEN
    RAISE EXCEPTION
      'credits gate cannot continue: the fixture hold failed, so nothing below was verified.';
  END IF;

  -- ── 2 · one hold per run ──────────────────────────────────────────────────
  -- What makes a retried authorizeSpend converge instead of reserving twice.
  BEGIN
    INSERT INTO credit_holds (
      tenant_id, organization_id, workspace_id, run_id, amount, expires_at,
      reason, correlation_id, created_by
    ) VALUES (ORG, ORG, WS, 'verify-credits-run-1', 20, FUTURE,
              'Duplicate.', CORR, ACTOR);
    failures := failures + 1;
    results := results || format(REPORT, 'FAIL', 'holds-one-per-run',
      'a second hold was taken for the same run — a Temporal retry would reserve twice.');
  EXCEPTION WHEN unique_violation THEN
    results := results || format(REPORT, 'PASS', 'holds-one-per-run',
      'the unique index refuses a second hold for one run.');
  END;

  -- ── 3 · and the convergence path is a no-op ───────────────────────────────
  INSERT INTO credit_holds (
    tenant_id, organization_id, workspace_id, run_id, amount, expires_at,
    reason, correlation_id, created_by
  ) VALUES (ORG, ORG, WS, 'verify-credits-run-1', 20, FUTURE,
            'Converging retry.', CORR, ACTOR)
  ON CONFLICT (tenant_id, run_id) DO NOTHING;

  SELECT count(*) INTO seen FROM credit_holds WHERE run_id = 'verify-credits-run-1';
  IF seen = 1 THEN
    results := results || format(REPORT, 'PASS', 'holds-retry-converges',
      'ON CONFLICT DO NOTHING leaves exactly one hold.');
  ELSE
    failures := failures + 1;
    results := results || format(REPORT, 'FAIL', 'holds-retry-converges',
      format('%s holds exist for one run.', seen));
  END IF;

  -- ── 4 · consumption cannot exceed the reservation ─────────────────────────
  -- The bound on worst-case spend, enforced by the database rather than by the
  -- caller remembering.
  BEGIN
    UPDATE credit_holds SET consumed = 20.000001 WHERE id = hold_id;
    failures := failures + 1;
    results := results || format(REPORT, 'FAIL', 'holds-consumed-within-bound',
      'a hold was consumed past its reservation — the spend bound is not enforced.');
  EXCEPTION WHEN check_violation THEN
    results := results || format(REPORT, 'PASS', 'holds-consumed-within-bound',
      'consumed <= amount is enforced.');
  END;

  UPDATE credit_holds SET consumed = 20 WHERE id = hold_id;
  results := results || format(REPORT, 'PASS', 'holds-consumed-to-bound',
    'consuming exactly the reservation is permitted.');
  UPDATE credit_holds SET consumed = 0 WHERE id = hold_id;

  -- ── 5 · the state vocabulary is fixed ─────────────────────────────────────
  BEGIN
    UPDATE credit_holds SET state = 'refunded' WHERE id = hold_id;
    failures := failures + 1;
    results := results || format(REPORT, 'FAIL', 'holds-state-vocabulary',
      'a state outside the documented four was accepted.');
  EXCEPTION WHEN check_violation THEN
    results := results || format(REPORT, 'PASS', 'holds-state-vocabulary',
      'state is confined to held, settled, released, expired.');
  END;

  -- ── 6 · a terminal state carries its timestamp ────────────────────────────
  BEGIN
    UPDATE credit_holds SET state = 'settled' WHERE id = hold_id;
    failures := failures + 1;
    results := results || format(REPORT, 'FAIL', 'holds-settled-timestamped',
      'a hold was settled with no settled_at — the audit trail has a gap.');
  EXCEPTION WHEN check_violation THEN
    results := results || format(REPORT, 'PASS', 'holds-settled-timestamped',
      'settling requires settled_at.');
  END;

  BEGIN
    UPDATE credit_holds SET state = 'released' WHERE id = hold_id;
    failures := failures + 1;
    results := results || format(REPORT, 'FAIL', 'holds-released-timestamped',
      'a hold was released with no released_at.');
  EXCEPTION WHEN check_violation THEN
    results := results || format(REPORT, 'PASS', 'holds-released-timestamped',
      'releasing requires released_at.');
  END;

  -- ── 7 · the guarded transition only fires once ────────────────────────────
  -- What makes settle and release idempotent: the second call matches nothing.
  UPDATE credit_holds
     SET state = 'settled', settled_at = now()
   WHERE id = hold_id AND state = 'held';
  GET DIAGNOSTICS seen = ROW_COUNT;
  IF seen <> 1 THEN
    failures := failures + 1;
    results := results || format(REPORT, 'FAIL', 'holds-settle-transition',
      format('settling an open hold affected %s rows.', seen));
  ELSE
    UPDATE credit_holds
       SET state = 'settled', settled_at = now()
     WHERE id = hold_id AND state = 'held';
    GET DIAGNOSTICS seen = ROW_COUNT;
    IF seen = 0 THEN
      results := results || format(REPORT, 'PASS', 'holds-settle-transition',
        'the state predicate makes a repeated settle a no-op.');
    ELSE
      failures := failures + 1;
      results := results || format(REPORT, 'FAIL', 'holds-settle-transition',
        'a settled hold was settled again.');
    END IF;
  END IF;

  -- ── 8 · tenant_id must BE the organization id ─────────────────────────────
  PERFORM set_config('app.tenant_id', OTHER::text, true);
  BEGIN
    INSERT INTO credit_holds (
      tenant_id, organization_id, workspace_id, run_id, amount, expires_at,
      reason, correlation_id, created_by
    ) VALUES (OTHER, ORG, WS, 'verify-credits-miskeyed', 1, FUTURE,
              'Mis-keyed.', CORR, ACTOR);
    failures := failures + 1;
    results := results || format(REPORT, 'FAIL', 'holds-tenant-is-organization',
      'a hold was accepted whose tenant_id is not its organization_id.');
  EXCEPTION WHEN check_violation THEN
    results := results || format(REPORT, 'PASS', 'holds-tenant-is-organization',
      'tenant_id is constrained to equal organization_id.');
  END;

  -- ── 9 · RLS isolation on holds ────────────────────────────────────────────
  SELECT count(*) INTO seen FROM credit_holds WHERE id = hold_id;
  IF seen = 0 THEN
    results := results || format(REPORT, 'PASS', 'holds-cross-tenant-read-blocked',
      'under another tenant the hold is invisible.');
  ELSE
    failures := failures + 1;
    results := results || format(REPORT, 'FAIL', 'holds-cross-tenant-read-blocked',
      format('another tenant saw %s hold(s).', seen));
  END IF;

  BEGIN
    INSERT INTO credit_holds (
      tenant_id, organization_id, workspace_id, run_id, amount, expires_at,
      reason, correlation_id, created_by
    ) VALUES (ORG, ORG, WS, 'verify-credits-cross', 1, FUTURE,
              'Cross-tenant write.', CORR, ACTOR);
    failures := failures + 1;
    results := results || format(REPORT, 'FAIL', 'holds-cross-tenant-write-rejected',
      'a hold carrying another tenant id was accepted.');
  EXCEPTION WHEN insufficient_privilege THEN
    results := results || format(REPORT, 'PASS', 'holds-cross-tenant-write-rejected',
      'WITH CHECK rejects a hold carrying another organization''s id.');
  END;

  PERFORM set_config('app.tenant_id', ORG::text, true);

  SELECT count(*) INTO seen FROM credit_holds WHERE id = hold_id;
  IF seen = 1 THEN
    results := results || format(REPORT, 'PASS', 'holds-own-tenant-read-permitted',
      'the role reads its own organization''s holds.');
  ELSE
    failures := failures + 1;
    results := results || format(REPORT, 'FAIL', 'holds-own-tenant-read-permitted',
      'the role cannot read its own hold, so the isolation checks prove nothing.');
  END IF;

  -- ── 10 · the balance read model ───────────────────────────────────────────
  INSERT INTO credit_balances (tenant_id, organization_id, credited, debited, entries_projected)
  VALUES (ORG, ORG, 100, 25, 2)
  ON CONFLICT (tenant_id) DO UPDATE SET credited = 100, debited = 25, entries_projected = 2;
  results := results || format(REPORT, 'PASS', 'balances-upsert-permitted',
    'the projection can be written and re-written.');

  BEGIN
    UPDATE credit_balances SET threshold_state = 'nearly' WHERE tenant_id = ORG;
    failures := failures + 1;
    results := results || format(REPORT, 'FAIL', 'balances-threshold-vocabulary',
      'a threshold state outside ok/low/exhausted was accepted.');
  EXCEPTION WHEN check_violation THEN
    results := results || format(REPORT, 'PASS', 'balances-threshold-vocabulary',
      'threshold_state is confined to ok, low, exhausted.');
  END;

  -- Half a watermark cannot be compared against (created_at, id) and would read
  -- as "nothing projected", re-aggregating the whole ledger on every request.
  BEGIN
    UPDATE credit_balances
       SET projected_through_at = now(), projected_through_id = NULL
     WHERE tenant_id = ORG;
    failures := failures + 1;
    results := results || format(REPORT, 'FAIL', 'balances-watermark-complete',
      'half a watermark was accepted.');
  EXCEPTION WHEN check_violation THEN
    results := results || format(REPORT, 'PASS', 'balances-watermark-complete',
      'both halves of the watermark are required together.');
  END;

  PERFORM set_config('app.tenant_id', OTHER::text, true);
  SELECT count(*) INTO seen FROM credit_balances WHERE tenant_id = ORG;
  IF seen = 0 THEN
    results := results || format(REPORT, 'PASS', 'balances-cross-tenant-read-blocked',
      'under another tenant the projection is invisible.');
  ELSE
    failures := failures + 1;
    results := results || format(REPORT, 'FAIL', 'balances-cross-tenant-read-blocked',
      format('another tenant saw %s balance row(s).', seen));
  END IF;
  PERFORM set_config('app.tenant_id', ORG::text, true);

  -- ── 11 · RLS is enabled AND forced on both ────────────────────────────────
  SELECT count(*) INTO seen
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relname IN ('credit_holds', 'credit_balances')
     AND c.relrowsecurity AND c.relforcerowsecurity;
  IF seen = 2 THEN
    results := results || format(REPORT, 'PASS', 'credits-rls-enabled-forced',
      'both credits tables are ENABLEd and FORCEd.');
  ELSE
    failures := failures + 1;
    results := results || format(REPORT, 'FAIL', 'credits-rls-enabled-forced',
      format('only %s of 2 credits tables have ENABLE and FORCE.', seen));
  END IF;

  -- ── 12 · the ledger is still append-only ──────────────────────────────────
  -- This increment must not have loosened T3.4's guarantee.
  SELECT count(*) INTO seen
    FROM unnest(ARRAY['UPDATE','DELETE']) AS p
   WHERE has_table_privilege('contentos_app', 'credit_ledger_entries', p);
  IF seen = 0 THEN
    results := results || format(REPORT, 'PASS', 'ledger-still-append-only',
      'contentos_app still holds neither UPDATE nor DELETE on the ledger.');
  ELSE
    failures := failures + 1;
    results := results || format(REPORT, 'FAIL', 'ledger-still-append-only',
      format('contentos_app regained %s mutating privilege(s) on the ledger.', seen));
  END IF;

  -- ── Report ────────────────────────────────────────────────────────────────
  RAISE NOTICE '==> credits schema verification (% assertions)', array_length(results, 1);
  FOREACH line IN ARRAY results LOOP
    RAISE NOTICE '%', line;
  END LOOP;

  IF failures > 0 THEN
    RAISE EXCEPTION 'credits schema verification FAILED (% failing assertion(s))', failures;
  END IF;

  RAISE NOTICE '==> credits schema verification GREEN';
END
$verify$;

ROLLBACK;
