-- Job lifecycle verification, run as the APPLICATION role against real PostgreSQL.
--
-- Two things here exist only in a server and cannot be observed against a fake.
--
-- The GUARDED TRANSITION: every state change is an UPDATE carrying the current
-- state in its predicate, so a repeated call matches no rows rather than moving
-- a job that has already moved on. `service.test.ts` asserts the SQL contains
-- that predicate; only PostgreSQL can show that the second call updates nothing.
--
-- The ILLEGAL SHAPE: a completed job with no completion time, a failed one with
-- no reason, a job keyed to a workspace other than its own. The state machine in
-- `packages/ai` refuses the illegal MOVES; these CHECKs make the illegal STATES
-- unwritable by anything, including a future service that forgets to ask.
--
-- Everything runs inside ONE transaction that is rolled back, so the gate is
-- repeatable and leaves no rows behind.
--
-- Failures are aggregated; results accumulate in an ARRAY because a caught
-- exception rolls back database changes made inside the block, so a table would
-- lose the very rows recording what failed.

BEGIN;

DO $verify$
DECLARE
  ORG   CONSTANT UUID := '018f7a1e-0000-7000-8000-0000000000aa';  -- seeded organization
  WS    CONSTANT UUID := '018f7a1e-0000-7000-8000-0000000000bb';  -- seeded workspace = tenant
  OTHER CONSTANT UUID := '018f7a1e-0000-7000-8000-0000000000cc';  -- the OTHER seeded workspace
  CORR  CONSTANT UUID := '018f7a1e-0000-7000-8000-00000000d0b5';

  REPORT CONSTANT TEXT := '    %-4s %-44s %s';

  results  TEXT[] := '{}';
  failures INT    := 0;

  job_id   UUID;
  other_id UUID;
  moved    INT;
  seen     INT;
  state    TEXT;
  stamp    TIMESTAMPTZ;
  why      TEXT;
  line     TEXT;
BEGIN
  -- ADR-017 — the workspace IS the tenant, so this is what a job runner sets.
  PERFORM set_config('app.tenant_id', WS::text, true);

  -- ── 1 · a job can be queued ───────────────────────────────────────────────
  BEGIN
    INSERT INTO jobs (tenant_id, workspace_id, organization_id, job_type, correlation_id, payload)
    VALUES (WS, WS, ORG, 'article.generate', CORR, '{"topic":"t"}'::jsonb)
    RETURNING id INTO job_id;
    results := results || format(REPORT, 'PASS', 'jobs-insert-permitted',
      'the application role can queue a job.');
  EXCEPTION WHEN OTHERS THEN
    failures := failures + 1;
    results := results || format(REPORT, 'FAIL', 'jobs-insert-permitted',
      'a valid job was rejected: ' || SQLERRM);
  END;

  IF job_id IS NULL THEN
    RAISE EXCEPTION
      'job gate cannot continue: the fixture insert failed, so nothing below was verified.';
  END IF;

  SELECT status, started_at INTO state, stamp FROM jobs WHERE id = job_id;
  IF state = 'queued' AND stamp IS NULL THEN
    results := results || format(REPORT, 'PASS', 'jobs-starts-queued',
      'a new job is queued and has not started.');
  ELSE
    failures := failures + 1;
    results := results || format(REPORT, 'FAIL', 'jobs-starts-queued',
      format('a new job is ''%s'' with started_at %s.', state, stamp));
  END IF;

  -- ── 2 · the guarded transitions ───────────────────────────────────────────
  -- Exactly the predicate the service issues: the CURRENT state is in the WHERE
  -- clause, so the second attempt has nothing to match.
  UPDATE jobs SET status = 'running', started_at = now(), updated_at = now()
   WHERE tenant_id = WS AND id = job_id AND status = 'queued';
  GET DIAGNOSTICS moved = ROW_COUNT;
  IF moved = 1 THEN
    results := results || format(REPORT, 'PASS', 'jobs-start-moves-queued-job',
      'queued -> running moved exactly one row.');
  ELSE
    failures := failures + 1;
    results := results || format(REPORT, 'FAIL', 'jobs-start-moves-queued-job',
      format('the start predicate matched %s rows.', moved));
  END IF;

  -- THE property. Two runners receive the same JobQueued — at-least-once
  -- delivery guarantees it — and the second must change nothing.
  UPDATE jobs SET status = 'running', started_at = now(), updated_at = now()
   WHERE tenant_id = WS AND id = job_id AND status = 'queued';
  GET DIAGNOSTICS moved = ROW_COUNT;
  IF moved = 0 THEN
    results := results || format(REPORT, 'PASS', 'jobs-start-not-repeatable',
      'a second start matches nothing; a redelivered JobQueued cannot start a job twice.');
  ELSE
    failures := failures + 1;
    results := results || format(REPORT, 'FAIL', 'jobs-start-not-repeatable',
      format('a second start moved %s row(s) — a job can be started twice.', moved));
  END IF;

  SELECT started_at INTO stamp FROM jobs WHERE id = job_id;
  IF stamp IS NOT NULL THEN
    results := results || format(REPORT, 'PASS', 'jobs-running-records-start-time',
      'a running job carries the moment it started.');
  ELSE
    failures := failures + 1;
    results := results || format(REPORT, 'FAIL', 'jobs-running-records-start-time',
      'a running job has no start time; how long it has been running is unanswerable.');
  END IF;

  UPDATE jobs SET status = 'completed', completed_at = now(), updated_at = now()
   WHERE tenant_id = WS AND id = job_id AND status = 'running';
  GET DIAGNOSTICS moved = ROW_COUNT;
  IF moved = 1 THEN
    results := results || format(REPORT, 'PASS', 'jobs-complete-moves-running-job',
      'running -> completed moved exactly one row.');
  ELSE
    failures := failures + 1;
    results := results || format(REPORT, 'FAIL', 'jobs-complete-moves-running-job',
      format('the complete predicate matched %s rows.', moved));
  END IF;

  UPDATE jobs SET status = 'completed', completed_at = now(), updated_at = now()
   WHERE tenant_id = WS AND id = job_id AND status = 'running';
  GET DIAGNOSTICS moved = ROW_COUNT;
  IF moved = 0 THEN
    results := results || format(REPORT, 'PASS', 'jobs-complete-not-repeatable',
      'a second completion matches nothing.');
  ELSE
    failures := failures + 1;
    results := results || format(REPORT, 'FAIL', 'jobs-complete-not-repeatable',
      format('a second completion moved %s row(s).', moved));
  END IF;

  -- ── 3 · a terminal job stays terminal ─────────────────────────────────────
  -- Not "the service declines to try" — the predicate itself has no match, so a
  -- caller holding a stale view cannot resurrect a finished job.
  UPDATE jobs SET status = 'running', started_at = now()
   WHERE tenant_id = WS AND id = job_id AND status = 'queued';
  GET DIAGNOSTICS moved = ROW_COUNT;
  IF moved = 0 THEN
    results := results || format(REPORT, 'PASS', 'jobs-terminal-not-restartable',
      'a completed job cannot be started again.');
  ELSE
    failures := failures + 1;
    results := results || format(REPORT, 'FAIL', 'jobs-terminal-not-restartable',
      'a completed job was moved back to running.');
  END IF;

  UPDATE jobs SET status = 'cancelled', reason = 'too late'
   WHERE tenant_id = WS AND id = job_id AND status = 'running';
  GET DIAGNOSTICS moved = ROW_COUNT;
  IF moved = 0 THEN
    results := results || format(REPORT, 'PASS', 'jobs-terminal-not-cancellable',
      'a completed job cannot be cancelled after the fact.');
  ELSE
    failures := failures + 1;
    results := results || format(REPORT, 'FAIL', 'jobs-terminal-not-cancellable',
      'a completed job was cancelled; two outcomes were recorded for one job.');
  END IF;

  SELECT status INTO state FROM jobs WHERE id = job_id;
  IF state = 'completed' THEN
    results := results || format(REPORT, 'PASS', 'jobs-outcome-survived',
      'after four rejected transitions the job is still completed.');
  ELSE
    failures := failures + 1;
    results := results || format(REPORT, 'FAIL', 'jobs-outcome-survived',
      format('the job ended as ''%s''.', state));
  END IF;

  -- ── 4 · the illegal SHAPES are unwritable ─────────────────────────────────
  BEGIN
    INSERT INTO jobs (tenant_id, workspace_id, organization_id, job_type, correlation_id,
                      status, started_at)
    VALUES (WS, WS, ORG, 'article.generate', CORR, 'queued', now());
    failures := failures + 1;
    results := results || format(REPORT, 'FAIL', 'jobs-queued-has-not-started',
      'a queued job carries a start time; "has this begun?" has two answers.');
  EXCEPTION WHEN check_violation THEN
    results := results || format(REPORT, 'PASS', 'jobs-queued-has-not-started',
      'a queued job cannot carry a start time.');
  END;

  BEGIN
    INSERT INTO jobs (tenant_id, workspace_id, organization_id, job_type, correlation_id, status)
    VALUES (WS, WS, ORG, 'article.generate', CORR, 'running');
    failures := failures + 1;
    results := results || format(REPORT, 'FAIL', 'jobs-running-has-started',
      'a running job was written with no start time.');
  EXCEPTION WHEN check_violation THEN
    results := results || format(REPORT, 'PASS', 'jobs-running-has-started',
      'a running job must record when it started.');
  END;

  BEGIN
    INSERT INTO jobs (tenant_id, workspace_id, organization_id, job_type, correlation_id,
                      status, started_at)
    VALUES (WS, WS, ORG, 'article.generate', CORR, 'completed', now());
    failures := failures + 1;
    results := results || format(REPORT, 'FAIL', 'jobs-terminal-has-ended',
      'a completed job was written with no completion time.');
  EXCEPTION WHEN check_violation THEN
    results := results || format(REPORT, 'PASS', 'jobs-terminal-has-ended',
      'a terminal job must record when it stopped.');
  END;

  BEGIN
    INSERT INTO jobs (tenant_id, workspace_id, organization_id, job_type, correlation_id,
                      status, started_at, completed_at)
    VALUES (WS, WS, ORG, 'article.generate', CORR, 'failed', now(), now());
    failures := failures + 1;
    results := results || format(REPORT, 'FAIL', 'jobs-failure-explains-itself',
      'a failed job was written with no reason; nobody can triage it.');
  EXCEPTION WHEN check_violation THEN
    results := results || format(REPORT, 'PASS', 'jobs-failure-explains-itself',
      'a failed job must carry a reason.');
  END;

  BEGIN
    INSERT INTO jobs (tenant_id, workspace_id, organization_id, job_type, correlation_id,
                      status, started_at, completed_at, reason)
    VALUES (WS, WS, ORG, 'article.generate', CORR, 'completed', now(), now(), 'all good');
    failures := failures + 1;
    results := results || format(REPORT, 'FAIL', 'jobs-success-has-no-reason',
      'a successful job carries a reason — a result in disguise, in a column nothing reads.');
  EXCEPTION WHEN check_violation THEN
    results := results || format(REPORT, 'PASS', 'jobs-success-has-no-reason',
      'only a failed or cancelled job carries a reason.');
  END;

  BEGIN
    INSERT INTO jobs (tenant_id, workspace_id, organization_id, job_type, correlation_id, status)
    VALUES (WS, WS, ORG, 'article.generate', CORR, 'paused');
    failures := failures + 1;
    results := results || format(REPORT, 'FAIL', 'jobs-status-vocabulary-closed',
      'a status outside the five was accepted; the lifecycle is open-ended.');
  EXCEPTION WHEN check_violation THEN
    results := results || format(REPORT, 'PASS', 'jobs-status-vocabulary-closed',
      'status is confined to queued, running, completed, failed, cancelled.');
  END;

  -- The row must be keyed to its OWN workspace: a job keyed elsewhere is
  -- invisible to the runner that has to execute it, and visible to a tenant
  -- that never asked for it.
  BEGIN
    INSERT INTO jobs (tenant_id, workspace_id, organization_id, job_type, correlation_id)
    VALUES (WS, OTHER, ORG, 'article.generate', CORR);
    failures := failures + 1;
    results := results || format(REPORT, 'FAIL', 'jobs-tenant-is-its-workspace',
      'a job was keyed to a workspace other than its own.');
  EXCEPTION WHEN check_violation THEN
    results := results || format(REPORT, 'PASS', 'jobs-tenant-is-its-workspace',
      'tenant_id and workspace_id must agree (ADR-017).');
  END;

  BEGIN
    INSERT INTO jobs (tenant_id, workspace_id, organization_id, job_type, correlation_id)
    VALUES (WS, WS, ORG, '   ', CORR);
    failures := failures + 1;
    results := results || format(REPORT, 'FAIL', 'jobs-type-required',
      'a job with no type was accepted; nothing can decide what to run.');
  EXCEPTION WHEN check_violation THEN
    results := results || format(REPORT, 'PASS', 'jobs-type-required',
      'a job must say what it is.');
  END;

  BEGIN
    INSERT INTO jobs (tenant_id, workspace_id, organization_id, job_type, correlation_id, payload)
    VALUES (WS, WS, ORG, 'article.generate', CORR, '[1,2]'::jsonb);
    failures := failures + 1;
    results := results || format(REPORT, 'FAIL', 'jobs-payload-is-an-object',
      'a non-object payload was accepted; every reader would have to guess its shape.');
  EXCEPTION WHEN check_violation THEN
    results := results || format(REPORT, 'PASS', 'jobs-payload-is-an-object',
      'a payload is a JSON object.');
  END;

  -- ── 5 · the failure path works, not merely the guard against it ───────────
  INSERT INTO jobs (tenant_id, workspace_id, organization_id, job_type, correlation_id)
  VALUES (WS, WS, ORG, 'article.generate', CORR)
  RETURNING id INTO other_id;

  UPDATE jobs SET status = 'running', started_at = now()
   WHERE tenant_id = WS AND id = other_id AND status = 'queued';

  UPDATE jobs SET status = 'failed', completed_at = now(), reason = 'provider timeout'
   WHERE tenant_id = WS AND id = other_id AND status = 'running';
  GET DIAGNOSTICS moved = ROW_COUNT;

  SELECT reason, completed_at INTO why, stamp FROM jobs WHERE id = other_id;
  IF moved = 1 AND why = 'provider timeout' AND stamp IS NOT NULL THEN
    results := results || format(REPORT, 'PASS', 'jobs-failure-recorded-with-reason',
      'a failure records its reason and the moment it stopped.');
  ELSE
    failures := failures + 1;
    results := results || format(REPORT, 'FAIL', 'jobs-failure-recorded-with-reason',
      format('%s row(s) moved, reason=%s.', moved, COALESCE(why, '<null>')));
  END IF;

  -- ── 6 · RLS isolation ─────────────────────────────────────────────────────
  -- OTHER is a REAL seeded workspace, so a foreign key cannot be what rejects
  -- the write below; only the policy can.
  PERFORM set_config('app.tenant_id', OTHER::text, true);

  SELECT count(*) INTO seen FROM jobs WHERE id = job_id;
  IF seen = 0 THEN
    results := results || format(REPORT, 'PASS', 'jobs-cross-tenant-read-blocked',
      'under another workspace the job is invisible.');
  ELSE
    failures := failures + 1;
    results := results || format(REPORT, 'FAIL', 'jobs-cross-tenant-read-blocked',
      format('another workspace saw %s job(s) — one tenant''s work is readable by another.', seen));
  END IF;

  -- A stale predicate is not enough to reach across the boundary either.
  UPDATE jobs SET status = 'cancelled', reason = 'not yours' WHERE id = other_id;
  GET DIAGNOSTICS moved = ROW_COUNT;
  IF moved = 0 THEN
    results := results || format(REPORT, 'PASS', 'jobs-cross-tenant-write-blocked',
      'another workspace cannot cancel this workspace''s job.');
  ELSE
    failures := failures + 1;
    results := results || format(REPORT, 'FAIL', 'jobs-cross-tenant-write-blocked',
      format('another workspace modified %s job(s).', moved));
  END IF;

  BEGIN
    INSERT INTO jobs (tenant_id, workspace_id, organization_id, job_type, correlation_id)
    VALUES (WS, WS, ORG, 'article.generate', CORR);
    failures := failures + 1;
    results := results || format(REPORT, 'FAIL', 'jobs-cross-tenant-insert-rejected',
      'a job carrying another workspace''s id was accepted; work could be queued into a tenant that never asked.');
  EXCEPTION WHEN insufficient_privilege THEN
    results := results || format(REPORT, 'PASS', 'jobs-cross-tenant-insert-rejected',
      'WITH CHECK rejects a job carrying another workspace''s id.');
  END;

  PERFORM set_config('app.tenant_id', WS::text, true);
  SELECT count(*) INTO seen FROM jobs WHERE id = job_id;
  IF seen = 1 THEN
    results := results || format(REPORT, 'PASS', 'jobs-own-tenant-read-permitted',
      'the role reads its own workspace''s jobs.');
  ELSE
    failures := failures + 1;
    results := results || format(REPORT, 'FAIL', 'jobs-own-tenant-read-permitted',
      'the role cannot read its own job, so the isolation checks above prove nothing.');
  END IF;

  -- With no tenant context the table must not read wide open — the failure mode
  -- where a background job forgets to establish context and quietly sees
  -- everything. Erroring is an acceptable outcome and a raised cast error is
  -- caught here as one: both are closed, and "everything" is the only answer
  -- that is not.
  BEGIN
    PERFORM set_config('app.tenant_id', '', true);
    SELECT count(*) INTO seen FROM jobs;
    IF seen = 0 THEN
      results := results || format(REPORT, 'PASS', 'jobs-no-tenant-sees-nothing',
        'with no tenant context the table reads empty.');
    ELSE
      failures := failures + 1;
      results := results || format(REPORT, 'FAIL', 'jobs-no-tenant-sees-nothing',
        format('with no tenant context %s job(s) were visible.', seen));
    END IF;
  EXCEPTION WHEN OTHERS THEN
    results := results || format(REPORT, 'PASS', 'jobs-no-tenant-sees-nothing',
      'with no tenant context the read fails closed: ' || SQLERRM);
  END;
  PERFORM set_config('app.tenant_id', WS::text, true);

  -- ── 7 · the policy itself, not only its effect ────────────────────────────
  SELECT count(*) INTO seen
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'jobs'
     AND c.relrowsecurity AND c.relforcerowsecurity;
  IF seen = 1 THEN
    results := results || format(REPORT, 'PASS', 'jobs-rls-enabled-forced',
      'RLS is ENABLEd and FORCEd on jobs.');
  ELSE
    failures := failures + 1;
    results := results || format(REPORT, 'FAIL', 'jobs-rls-enabled-forced',
      'jobs is missing ENABLE or FORCE; without FORCE the owner bypasses every policy.');
  END IF;

  -- A USING clause with no WITH CHECK reads correctly and writes anywhere,
  -- which is the mistake that looks right in every SELECT.
  SELECT count(*) INTO seen
    FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'jobs'
     AND qual LIKE '%app.tenant_id%' AND with_check LIKE '%app.tenant_id%';
  IF seen = 1 THEN
    results := results || format(REPORT, 'PASS', 'jobs-policy-checks-both-ways',
      'the policy constrains reads AND writes to the tenant.');
  ELSE
    failures := failures + 1;
    results := results || format(REPORT, 'FAIL', 'jobs-policy-checks-both-ways',
      format('%s policy on jobs constrains both directions.', seen));
  END IF;

  -- ── 8 · the claim path is indexed ─────────────────────────────────────────
  -- A runner reads the queue on every cycle; a sequential scan over every job
  -- ever run is a slow failure that no correctness assertion would catch.
  SELECT count(*) INTO seen
    FROM pg_indexes
   WHERE schemaname = 'public' AND tablename = 'jobs'
     AND indexdef LIKE '%tenant_id%' AND indexdef LIKE '%status = ''queued''%';
  IF seen = 1 THEN
    results := results || format(REPORT, 'PASS', 'jobs-queue-is-indexed',
      'the queued-job claim path has its partial index.');
  ELSE
    failures := failures + 1;
    results := results || format(REPORT, 'FAIL', 'jobs-queue-is-indexed',
      'no partial index on queued jobs; every claim scans the whole table.');
  END IF;

  -- ── Report ────────────────────────────────────────────────────────────────
  RAISE NOTICE '==> job lifecycle verification (% assertions)', array_length(results, 1);
  FOREACH line IN ARRAY results LOOP
    RAISE NOTICE '%', line;
  END LOOP;

  IF failures > 0 THEN
    RAISE EXCEPTION 'job lifecycle verification FAILED (% failing assertion(s))', failures;
  END IF;

  RAISE NOTICE '==> job lifecycle verification GREEN';
END
$verify$;

-- Nothing above is kept.
ROLLBACK;
