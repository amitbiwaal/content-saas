-- Credit ledger verification, run as the APPLICATION role against real PostgreSQL.
--
-- Every property below is a database behaviour. Asserting them in TypeScript
-- against a fake would test this file's assumptions rather than PostgreSQL's:
-- a revoked privilege, a WITH CHECK rejection and a unique violation are all
-- things only the server can be asked about.
--
-- ── Everything happens inside ONE transaction that is rolled back ────────────
-- The ledger has no DELETE path — that is the point of it — so a gate that
-- COMMITTED its fixtures could not clean up after itself, and the second run on
-- any long-lived database would fail on its own leftovers. Nothing here is
-- committed, so the gate is repeatable and leaves the ledger empty.
--
-- ── Failures are aggregated ─────────────────────────────────────────────────
-- Every assertion reports PASS or FAIL with an explanation and the run always
-- completes. Stopping at the first failure turns one fix-and-rerun cycle into
-- one per fault.
--
-- Results accumulate in an ARRAY rather than a temp table on purpose: when
-- PL/pgSQL catches an exception it rolls back the database changes made inside
-- that block, so a table would lose the very rows recording what failed.
-- Variables survive, which is exactly the property this needs.

BEGIN;

DO $verify$
DECLARE
  ORG   CONSTANT UUID := '018f7a1e-0000-7000-8000-0000000000aa';  -- seeded organization
  WS    CONSTANT UUID := '018f7a1e-0000-7000-8000-0000000000bb';  -- seeded workspace
  OTHER CONSTANT UUID := '018f7a1e-0000-7000-8000-0000000000cc';  -- a tenant that is not ORG
  ACTOR CONSTANT UUID := '018f7a1e-0000-7000-8000-000000000001';  -- seeded user
  CORR  CONSTANT UUID := '018f7a1e-0000-7000-8000-00000000c0aa';

  REPORT CONSTANT TEXT := '    %-4s %-38s %s';

  results  TEXT[] := '{}';
  failures INT    := 0;

  entry_id UUID;
  seen     INT;
  affected INT;
  stored   NUMERIC;
  line     TEXT;
BEGIN
  PERFORM set_config('app.tenant_id', ORG::text, true);

  -- ── 1 · a well-formed entry is accepted ───────────────────────────────────
  BEGIN
    INSERT INTO credit_ledger_entries (
      tenant_id, organization_id, entry_type, amount, direction,
      idempotency_key, reason, correlation_id, created_by
    ) VALUES (ORG, ORG, 'grant', 100.500000, 'credit',
              'verify-ledger-grant-1', 'Gate fixture.', CORR, ACTOR)
    RETURNING id INTO entry_id;
    results := results || format(REPORT, 'PASS', 'ledger-insert-permitted',
      'the application role can append a well-formed entry.');
  EXCEPTION WHEN OTHERS THEN
    failures := failures + 1;
    results := results || format(REPORT, 'FAIL', 'ledger-insert-permitted',
      'a valid append was rejected: ' || SQLERRM);
  END;

  -- Every remaining assertion needs that row. Without it the gate would report
  -- a wall of green from checks that never ran.
  IF entry_id IS NULL THEN
    RAISE EXCEPTION
      'ledger gate cannot continue: the fixture append failed, so nothing below was verified.';
  END IF;

  -- ── 2 · UPDATE is revoked, not merely discouraged ─────────────────────────
  BEGIN
    UPDATE credit_ledger_entries SET amount = 1 WHERE id = entry_id;
    failures := failures + 1;
    results := results || format(REPORT, 'FAIL', 'ledger-update-rejected',
      'an UPDATE succeeded. The ledger is mutable, so no balance can be trusted to reconcile.');
  EXCEPTION WHEN insufficient_privilege THEN
    results := results || format(REPORT, 'PASS', 'ledger-update-rejected',
      'UPDATE is refused: ' || SQLERRM);
  END;

  -- ── 3 · DELETE likewise ───────────────────────────────────────────────────
  BEGIN
    DELETE FROM credit_ledger_entries WHERE id = entry_id;
    failures := failures + 1;
    results := results || format(REPORT, 'FAIL', 'ledger-delete-rejected',
      'a DELETE succeeded. History can be erased, which defeats auditing the balance to any point in time.');
  EXCEPTION WHEN insufficient_privilege THEN
    results := results || format(REPORT, 'PASS', 'ledger-delete-rejected',
      'DELETE is refused: ' || SQLERRM);
  END;

  -- ── 4 · the row survived both attempts unchanged ──────────────────────────
  SELECT amount INTO stored FROM credit_ledger_entries WHERE id = entry_id;
  IF stored = 100.500000 THEN
    results := results || format(REPORT, 'PASS', 'ledger-entry-immutable',
      'the entry is exactly what was appended, after an UPDATE and a DELETE attempt.');
  ELSE
    failures := failures + 1;
    results := results || format(REPORT, 'FAIL', 'ledger-entry-immutable',
      'amount is now ' || coalesce(stored::text, 'NULL') || ', expected 100.500000.');
  END IF;

  -- ── 5 · a duplicate idempotency key is refused by the constraint ──────────
  BEGIN
    INSERT INTO credit_ledger_entries (
      tenant_id, organization_id, entry_type, amount, direction,
      idempotency_key, reason, correlation_id, created_by
    ) VALUES (ORG, ORG, 'grant', 999, 'credit',
              'verify-ledger-grant-1', 'Duplicate.', CORR, ACTOR);
    failures := failures + 1;
    results := results || format(REPORT, 'FAIL', 'ledger-idempotency-unique',
      'a second entry reused an idempotency key. A retried AI call would double-charge.');
  EXCEPTION WHEN unique_violation THEN
    results := results || format(REPORT, 'PASS', 'ledger-idempotency-unique',
      'the unique index refuses a reused key.');
  END;

  -- ── 6 · and the convergence path writes nothing ───────────────────────────
  -- ON CONFLICT DO NOTHING is what `append()` issues; it must be a no-op rather
  -- than an error, and must leave the winning row untouched.
  INSERT INTO credit_ledger_entries (
    tenant_id, organization_id, entry_type, amount, direction,
    idempotency_key, reason, correlation_id, created_by
  ) VALUES (ORG, ORG, 'grant', 999, 'credit',
            'verify-ledger-grant-1', 'Converging retry.', CORR, ACTOR)
  ON CONFLICT (tenant_id, idempotency_key) DO NOTHING;
  GET DIAGNOSTICS affected = ROW_COUNT;

  SELECT count(*) INTO seen
    FROM credit_ledger_entries WHERE idempotency_key = 'verify-ledger-grant-1';

  IF affected = 0 AND seen = 1 THEN
    results := results || format(REPORT, 'PASS', 'ledger-idempotency-converges',
      'a retry inserts nothing and the original entry stands alone.');
  ELSE
    failures := failures + 1;
    results := results || format(REPORT, 'FAIL', 'ledger-idempotency-converges',
      format('retry inserted %s row(s); %s entries hold the key.', affected, seen));
  END IF;

  -- ── 7 · the positive control ──────────────────────────────────────────────
  -- Without it, the isolation checks below would also pass if the role simply
  -- could not read the ledger at all.
  SELECT count(*) INTO seen FROM credit_ledger_entries WHERE id = entry_id;
  IF seen = 1 THEN
    results := results || format(REPORT, 'PASS', 'ledger-own-tenant-read-permitted',
      'the role reads its own organization''s ledger.');
  ELSE
    failures := failures + 1;
    results := results || format(REPORT, 'FAIL', 'ledger-own-tenant-read-permitted',
      'the role cannot read its own entry, so the isolation checks prove nothing.');
  END IF;

  -- ── 8 · another tenant cannot see it ──────────────────────────────────────
  PERFORM set_config('app.tenant_id', OTHER::text, true);
  SELECT count(*) INTO seen FROM credit_ledger_entries WHERE id = entry_id;
  IF seen = 0 THEN
    results := results || format(REPORT, 'PASS', 'ledger-cross-tenant-read-blocked',
      'under another tenant the entry is invisible.');
  ELSE
    failures := failures + 1;
    results := results || format(REPORT, 'FAIL', 'ledger-cross-tenant-read-blocked',
      format('another tenant saw %s of this organization''s ledger rows.', seen));
  END IF;

  -- ── 9 · nor write into it ─────────────────────────────────────────────────
  -- The reverse leak, and the one most likely to go undetected: the writer never
  -- sees the result. The CHECK is satisfied here, so only RLS can refuse it.
  BEGIN
    INSERT INTO credit_ledger_entries (
      tenant_id, organization_id, entry_type, amount, direction,
      reason, correlation_id, created_by
    ) VALUES (ORG, ORG, 'grant', 1, 'credit', 'Cross-tenant write.', CORR, ACTOR);
    failures := failures + 1;
    results := results || format(REPORT, 'FAIL', 'ledger-cross-tenant-write-rejected',
      'a write carrying another tenant id was accepted — WITH CHECK is not enforcing.');
  EXCEPTION WHEN insufficient_privilege THEN
    results := results || format(REPORT, 'PASS', 'ledger-cross-tenant-write-rejected',
      'WITH CHECK rejects a write carrying another organization''s id.');
  END;

  -- ── 10 · tenant_id must BE the organization id ────────────────────────────
  -- Satisfies RLS (the tenant matches the session) so only the CHECK can refuse
  -- it. A ledger row keyed to anything but its organization is invisible to
  -- every balance read, permanently — there is no UPDATE to correct it with.
  BEGIN
    INSERT INTO credit_ledger_entries (
      tenant_id, organization_id, entry_type, amount, direction,
      reason, correlation_id, created_by
    ) VALUES (OTHER, ORG, 'grant', 1, 'credit', 'Mis-keyed.', CORR, ACTOR);
    failures := failures + 1;
    results := results || format(REPORT, 'FAIL', 'ledger-tenant-is-organization',
      'an entry was accepted whose tenant_id is not its organization_id.');
  EXCEPTION WHEN check_violation THEN
    results := results || format(REPORT, 'PASS', 'ledger-tenant-is-organization',
      'tenant_id is constrained to equal organization_id.');
  END;

  PERFORM set_config('app.tenant_id', ORG::text, true);

  -- ── 11 · the amount is a magnitude; the type carries the sign ─────────────
  BEGIN
    INSERT INTO credit_ledger_entries (
      tenant_id, organization_id, entry_type, amount, direction,
      reason, correlation_id, created_by
    ) VALUES (ORG, ORG, 'grant', -1, 'credit', 'Negative grant.', CORR, ACTOR);
    failures := failures + 1;
    results := results || format(REPORT, 'FAIL', 'ledger-amount-non-negative',
      'a negative amount was accepted — a grant can masquerade as a charge.');
  EXCEPTION WHEN check_violation THEN
    results := results || format(REPORT, 'PASS', 'ledger-amount-non-negative',
      'amount >= 0 is enforced.');
  END;

  -- ── 12 · the entry-type vocabulary is fixed ───────────────────────────────
  BEGIN
    INSERT INTO credit_ledger_entries (
      tenant_id, organization_id, entry_type, amount, direction,
      reason, correlation_id, created_by
    ) VALUES (ORG, ORG, 'chargeback', 1, 'debit', 'Invented type.', CORR, ACTOR);
    failures := failures + 1;
    results := results || format(REPORT, 'FAIL', 'ledger-entry-type-vocabulary',
      'an entry type outside the fixed vocabulary was accepted.');
  EXCEPTION WHEN check_violation THEN
    results := results || format(REPORT, 'PASS', 'ledger-entry-type-vocabulary',
      'entry_type is confined to the five documented values.');
  END;

  -- ── 13 · direction cannot contradict the type ─────────────────────────────
  BEGIN
    INSERT INTO credit_ledger_entries (
      tenant_id, organization_id, entry_type, amount, direction,
      reason, correlation_id, created_by
    ) VALUES (ORG, ORG, 'grant', 1, 'debit', 'Grant as a debit.', CORR, ACTOR);
    failures := failures + 1;
    results := results || format(REPORT, 'FAIL', 'ledger-direction-matches-type',
      'a grant was recorded as a debit, which is indistinguishable from a charge.');
  EXCEPTION WHEN check_violation THEN
    results := results || format(REPORT, 'PASS', 'ledger-direction-matches-type',
      'the four self-signing types cannot be recorded against their own direction.');
  END;

  -- ── 14 · an adjustment may go either way ──────────────────────────────────
  -- The complement of 13. Without it, 13 would also pass if the constraint
  -- simply forbade every direction, and support could correct nothing.
  BEGIN
    INSERT INTO credit_ledger_entries (
      tenant_id, organization_id, entry_type, amount, direction,
      reason, correlation_id, created_by
    ) VALUES (ORG, ORG, 'adjustment', 5, 'debit', 'Support removal.', CORR, ACTOR);
    INSERT INTO credit_ledger_entries (
      tenant_id, organization_id, entry_type, amount, direction,
      reason, correlation_id, created_by
    ) VALUES (ORG, ORG, 'adjustment', 5, 'credit', 'Support addition.', CORR, ACTOR);
    results := results || format(REPORT, 'PASS', 'ledger-adjustment-either-direction',
      'an audited adjustment may add or remove.');
  EXCEPTION WHEN OTHERS THEN
    failures := failures + 1;
    results := results || format(REPORT, 'FAIL', 'ledger-adjustment-either-direction',
      'a legitimate adjustment was rejected: ' || SQLERRM);
  END;

  -- ── 15 · consumption is always attributed to a workspace ──────────────────
  BEGIN
    INSERT INTO credit_ledger_entries (
      tenant_id, organization_id, entry_type, amount, direction,
      reason, correlation_id, created_by
    ) VALUES (ORG, ORG, 'consumption', 1, 'debit', 'Unattributed.', CORR, ACTOR);
    failures := failures + 1;
    results := results || format(REPORT, 'FAIL', 'ledger-consumption-attributed',
      'a consumption was accepted with no workspace; per-client reporting would be incomplete.');
  EXCEPTION WHEN check_violation THEN
    results := results || format(REPORT, 'PASS', 'ledger-consumption-attributed',
      'consumption must name the workspace the work happened in.');
  END;

  -- ── 16 · and an attributed one is accepted, at full resolution ────────────
  BEGIN
    INSERT INTO credit_ledger_entries (
      tenant_id, organization_id, workspace_id, entry_type, amount, direction,
      idempotency_key, reason, correlation_id, created_by
    ) VALUES (ORG, ORG, WS, 'consumption', 0.000001, 'debit',
              'verify-ledger-consumption-1', 'Attributed.', CORR, ACTOR);

    -- gitleaks reads `<something>_key = '<high-entropy string>'` as a credential.
    -- Allowed per line rather than by exempting the file: a path allowlist here
    -- would also stop it catching a real secret in this gate later.
    SELECT amount INTO stored
      FROM credit_ledger_entries
     WHERE idempotency_key = 'verify-ledger-consumption-1';  -- gitleaks:allow
    IF stored = 0.000001 THEN
      results := results || format(REPORT, 'PASS', 'ledger-consumption-accepted',
        'a workspace-attributed consumption round-trips at NUMERIC(20,6) resolution.');
    ELSE
      failures := failures + 1;
      results := results || format(REPORT, 'FAIL', 'ledger-consumption-accepted',
        'the smallest recordable charge stored as ' || coalesce(stored::text, 'NULL') || '.');
    END IF;
  EXCEPTION WHEN OTHERS THEN
    failures := failures + 1;
    results := results || format(REPORT, 'FAIL', 'ledger-consumption-accepted',
      'a valid consumption was rejected: ' || SQLERRM);
  END;

  -- ── 17 · the privileges themselves ────────────────────────────────────────
  -- The behaviour above proves the current state; this proves the GRANT is the
  -- reason, so a future migration that re-grants UPDATE fails here too.
  SELECT count(*) INTO seen
    FROM unnest(ARRAY['UPDATE','DELETE']) AS p
   WHERE has_table_privilege('contentos_app', 'credit_ledger_entries', p);
  IF seen = 0 THEN
    results := results || format(REPORT, 'PASS', 'ledger-append-only-privileges',
      'contentos_app holds neither UPDATE nor DELETE.');
  ELSE
    failures := failures + 1;
    results := results || format(REPORT, 'FAIL', 'ledger-append-only-privileges',
      format('contentos_app still holds %s mutating privilege(s).', seen));
  END IF;

  SELECT count(*) INTO seen
    FROM unnest(ARRAY['SELECT','INSERT']) AS p
   WHERE has_table_privilege('contentos_app', 'credit_ledger_entries', p);
  IF seen = 2 THEN
    results := results || format(REPORT, 'PASS', 'ledger-append-privileges-present',
      'contentos_app can read and append.');
  ELSE
    failures := failures + 1;
    results := results || format(REPORT, 'FAIL', 'ledger-append-privileges-present',
      'contentos_app is missing SELECT or INSERT; the ledger is unusable.');
  END IF;

  -- ── 18 · RLS is enabled AND forced ────────────────────────────────────────
  SELECT count(*) INTO seen
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'credit_ledger_entries'
     AND c.relrowsecurity AND c.relforcerowsecurity;
  IF seen = 1 THEN
    results := results || format(REPORT, 'PASS', 'ledger-rls-enabled-forced',
      'RLS is ENABLEd and FORCEd on the ledger.');
  ELSE
    failures := failures + 1;
    results := results || format(REPORT, 'FAIL', 'ledger-rls-enabled-forced',
      'the ledger is missing ENABLE or FORCE; without FORCE the owner bypasses every policy.');
  END IF;

  -- ── Report ────────────────────────────────────────────────────────────────
  RAISE NOTICE '==> credit ledger verification (% assertions)', array_length(results, 1);
  FOREACH line IN ARRAY results LOOP
    RAISE NOTICE '%', line;
  END LOOP;

  IF failures > 0 THEN
    RAISE EXCEPTION 'credit ledger verification FAILED (% failing assertion(s))', failures;
  END IF;

  RAISE NOTICE '==> credit ledger verification GREEN';
END
$verify$;

-- Nothing above is kept. The ledger has no delete path, so the gate must not
-- leave rows behind for the next run to trip over.
ROLLBACK;
