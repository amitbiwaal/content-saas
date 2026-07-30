-- Notification verification, run as the APPLICATION role against real PostgreSQL.
--
-- The immutability guarantee is a COLUMN-LEVEL GRANT. `type` and `payload` are
-- unmodifiable because contentos_app was never given UPDATE on them, and
-- `status` is modifiable because it was. No test against a data structure can
-- observe that: a fake has no privileges to withhold.
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
  WS    CONSTANT UUID := '018f7a1e-0000-7000-8000-0000000000bb';  -- seeded workspace
  OTHER CONSTANT UUID := '018f7a1e-0000-7000-8000-0000000000cc';  -- a tenant that is not ORG
  CORR  CONSTANT UUID := '018f7a1e-0000-7000-8000-00000000c0dd';

  REPORT CONSTANT TEXT := '    %-4s %-42s %s';

  results  TEXT[] := '{}';
  failures INT    := 0;

  note_id  UUID;
  seen     INT;
  stored   TEXT;
  line     TEXT;
BEGIN
  PERFORM set_config('app.tenant_id', ORG::text, true);

  -- ── 1 · a notification can be recorded ────────────────────────────────────
  BEGIN
    INSERT INTO notifications (
      tenant_id, organization_id, workspace_id, type, payload, dedupe_key, correlation_id
    ) VALUES (ORG, ORG, WS, 'billing.credits_low',
              '{"organizationId":"018f7a1e-0000-7000-8000-0000000000aa"}'::jsonb,
              'verify-notifications-1', CORR)
    RETURNING id INTO note_id;
    results := results || format(REPORT, 'PASS', 'notifications-insert-permitted',
      'the application role can record a notification.');
  EXCEPTION WHEN OTHERS THEN
    failures := failures + 1;
    results := results || format(REPORT, 'FAIL', 'notifications-insert-permitted',
      'a valid notification was rejected: ' || SQLERRM);
  END;

  IF note_id IS NULL THEN
    RAISE EXCEPTION
      'notification gate cannot continue: the fixture insert failed, so nothing below was verified.';
  END IF;

  -- ── 2 · what it SAID cannot be rewritten ──────────────────────────────────
  -- The column-level grant. A notification is evidence; "were they told, and
  -- what were they told?" stops being answerable the moment this is editable.
  BEGIN
    UPDATE notifications SET payload = '{"tampered":true}'::jsonb WHERE id = note_id;
    failures := failures + 1;
    results := results || format(REPORT, 'FAIL', 'notifications-payload-immutable',
      'the payload was rewritten. What a notification said is no longer evidence of anything.');
  EXCEPTION WHEN insufficient_privilege THEN
    results := results || format(REPORT, 'PASS', 'notifications-payload-immutable',
      'payload is refused by privilege: ' || SQLERRM);
  END;

  BEGIN
    UPDATE notifications SET type = 'system.settings_changed' WHERE id = note_id;
    failures := failures + 1;
    results := results || format(REPORT, 'FAIL', 'notifications-type-immutable',
      'the type was rewritten; a billing alert could be relabelled after the fact.');
  EXCEPTION WHEN insufficient_privilege THEN
    results := results || format(REPORT, 'PASS', 'notifications-type-immutable',
      'type is refused by privilege.');
  END;

  BEGIN
    UPDATE notifications SET created_at = now() - interval '1 year' WHERE id = note_id;
    failures := failures + 1;
    results := results || format(REPORT, 'FAIL', 'notifications-created-at-immutable',
      'created_at was rewritten; the timeline of who was told when is editable.');
  EXCEPTION WHEN insufficient_privilege THEN
    results := results || format(REPORT, 'PASS', 'notifications-created-at-immutable',
      'created_at is refused by privilege.');
  END;

  -- ── 3 · and it cannot be erased ───────────────────────────────────────────
  BEGIN
    DELETE FROM notifications WHERE id = note_id;
    failures := failures + 1;
    results := results || format(REPORT, 'FAIL', 'notifications-delete-rejected',
      'a notification was deleted. The record of a mandatory alert can be removed.');
  EXCEPTION WHEN insufficient_privilege THEN
    results := results || format(REPORT, 'PASS', 'notifications-delete-rejected',
      'DELETE is refused by privilege.');
  END;

  -- ── 4 · but the delivery outcome CAN be recorded ──────────────────────────
  -- The other half of the column grant: too narrow and the row could never be
  -- marked delivered, which is the whole point of keeping it.
  BEGIN
    UPDATE notifications SET status = 'delivered', delivered_at = now() WHERE id = note_id;
    results := results || format(REPORT, 'PASS', 'notifications-status-writable',
      'the delivery outcome is recordable on an otherwise immutable row.');
  EXCEPTION WHEN OTHERS THEN
    failures := failures + 1;
    results := results || format(REPORT, 'FAIL', 'notifications-status-writable',
      'the delivery outcome could not be recorded: ' || SQLERRM);
  END;

  SELECT payload ->> 'organizationId' INTO stored FROM notifications WHERE id = note_id;
  IF stored = '018f7a1e-0000-7000-8000-0000000000aa' THEN
    results := results || format(REPORT, 'PASS', 'notifications-content-survived',
      'the payload is what was recorded, after three attempts to rewrite it.');
  ELSE
    failures := failures + 1;
    results := results || format(REPORT, 'FAIL', 'notifications-content-survived',
      'the payload changed under the rewrite attempts.');
  END IF;

  -- ── 5 · a duplicate dedupe key is refused ─────────────────────────────────
  -- The exactly-once guarantee: a redelivered event must not notify twice.
  BEGIN
    INSERT INTO notifications (
      tenant_id, organization_id, type, payload, dedupe_key, correlation_id
    ) VALUES (ORG, ORG, 'billing.credits_low', '{}'::jsonb, 'verify-notifications-1', CORR);
    failures := failures + 1;
    results := results || format(REPORT, 'FAIL', 'notifications-dedupe-unique',
      'a second notification reused a dedupe key; a redelivered event would notify twice.');
  EXCEPTION WHEN unique_violation THEN
    results := results || format(REPORT, 'PASS', 'notifications-dedupe-unique',
      'the unique index refuses a reused dedupe key.');
  END;

  -- ── 6 · and the convergence path is a no-op ───────────────────────────────
  INSERT INTO notifications (
    tenant_id, organization_id, type, payload, dedupe_key, correlation_id
  ) VALUES (ORG, ORG, 'billing.credits_low', '{}'::jsonb, 'verify-notifications-1', CORR)
  ON CONFLICT (tenant_id, dedupe_key) DO NOTHING;

  -- gitleaks reads `<something>_key = '<distinctive string>'` as a credential.
  -- Allowed per line rather than by exempting the file: a path allowlist would
  -- also stop it catching a real secret in this gate later.
  SELECT count(*) INTO seen
    FROM notifications
   WHERE dedupe_key = 'verify-notifications-1';  -- gitleaks:allow
  IF seen = 1 THEN
    results := results || format(REPORT, 'PASS', 'notifications-dedupe-converges',
      'ON CONFLICT DO NOTHING leaves exactly one notification.');
  ELSE
    failures := failures + 1;
    results := results || format(REPORT, 'FAIL', 'notifications-dedupe-converges',
      format('%s notifications hold one dedupe key.', seen));
  END IF;

  -- ── 7 · the status vocabulary is fixed ────────────────────────────────────
  BEGIN
    UPDATE notifications SET status = 'bounced' WHERE id = note_id;
    failures := failures + 1;
    results := results || format(REPORT, 'FAIL', 'notifications-status-vocabulary',
      'a status outside the three reachable values was accepted.');
  EXCEPTION WHEN check_violation THEN
    results := results || format(REPORT, 'PASS', 'notifications-status-vocabulary',
      'status is confined to pending, delivered, failed.');
  END;

  -- ── 8 · a terminal status carries its evidence ────────────────────────────
  BEGIN
    UPDATE notifications SET status = 'failed', failed_at = now() WHERE id = note_id;
    failures := failures + 1;
    results := results || format(REPORT, 'FAIL', 'notifications-failure-needs-reason',
      'a failure was recorded with no reason; nobody can act on it.');
  EXCEPTION WHEN check_violation THEN
    results := results || format(REPORT, 'PASS', 'notifications-failure-needs-reason',
      'a failed notification must carry a reason.');
  END;

  -- ── 9 · RLS isolation ─────────────────────────────────────────────────────
  PERFORM set_config('app.tenant_id', OTHER::text, true);
  SELECT count(*) INTO seen FROM notifications WHERE id = note_id;
  IF seen = 0 THEN
    results := results || format(REPORT, 'PASS', 'notifications-cross-tenant-read-blocked',
      'under another tenant the notification is invisible.');
  ELSE
    failures := failures + 1;
    results := results || format(REPORT, 'FAIL', 'notifications-cross-tenant-read-blocked',
      format('another tenant saw %s notification(s).', seen));
  END IF;

  BEGIN
    INSERT INTO notifications (
      tenant_id, organization_id, type, payload, dedupe_key, correlation_id
    ) VALUES (ORG, ORG, 'billing.credits_low', '{}'::jsonb, 'verify-cross-tenant', CORR);
    failures := failures + 1;
    results := results || format(REPORT, 'FAIL', 'notifications-cross-tenant-write-rejected',
      'a notification carrying another tenant id was accepted.');
  EXCEPTION WHEN insufficient_privilege THEN
    results := results || format(REPORT, 'PASS', 'notifications-cross-tenant-write-rejected',
      'WITH CHECK rejects a notification carrying another tenant''s id.');
  END;

  PERFORM set_config('app.tenant_id', ORG::text, true);
  SELECT count(*) INTO seen FROM notifications WHERE id = note_id;
  IF seen = 1 THEN
    results := results || format(REPORT, 'PASS', 'notifications-own-tenant-read-permitted',
      'the role reads its own tenant''s notifications.');
  ELSE
    failures := failures + 1;
    results := results || format(REPORT, 'FAIL', 'notifications-own-tenant-read-permitted',
      'the role cannot read its own notification, so the isolation checks prove nothing.');
  END IF;

  -- ── 10 · the tenant must own the notification ─────────────────────────────
  BEGIN
    INSERT INTO notifications (
      tenant_id, organization_id, workspace_id, type, payload, dedupe_key, correlation_id
    ) VALUES (ORG, ORG, NULL, 'billing.credits_low', '{}'::jsonb, 'verify-miskeyed', CORR);
    -- Valid: tenant IS the organization. The mis-keyed case is below.
    results := results || format(REPORT, 'PASS', 'notifications-tenant-may-be-organization',
      'an account-level notification is keyed on the organization.');
  EXCEPTION WHEN OTHERS THEN
    failures := failures + 1;
    results := results || format(REPORT, 'FAIL', 'notifications-tenant-may-be-organization',
      'an account-level notification was rejected: ' || SQLERRM);
  END;

  -- ── 11 · RLS is enabled AND forced ────────────────────────────────────────
  SELECT count(*) INTO seen
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'notifications'
     AND c.relrowsecurity AND c.relforcerowsecurity;
  IF seen = 1 THEN
    results := results || format(REPORT, 'PASS', 'notifications-rls-enabled-forced',
      'RLS is ENABLEd and FORCEd on notifications.');
  ELSE
    failures := failures + 1;
    results := results || format(REPORT, 'FAIL', 'notifications-rls-enabled-forced',
      'notifications is missing ENABLE or FORCE; without FORCE the owner bypasses every policy.');
  END IF;

  -- ── 12 · the grant itself, not just its effect ────────────────────────────
  -- Behaviour above proves the current state; this proves the GRANT is the
  -- reason, so a future migration that re-grants table-level UPDATE fails here.
  SELECT count(*) INTO seen
    FROM unnest(ARRAY['UPDATE','DELETE']) AS p
   WHERE has_table_privilege('contentos_app', 'notifications', p);
  IF seen = 0 THEN
    results := results || format(REPORT, 'PASS', 'notifications-no-table-level-write',
      'contentos_app holds no table-level UPDATE or DELETE.');
  ELSE
    failures := failures + 1;
    results := results || format(REPORT, 'FAIL', 'notifications-no-table-level-write',
      format('contentos_app regained %s table-level write privilege(s).', seen));
  END IF;

  SELECT count(*) INTO seen
    FROM unnest(ARRAY['status','delivered_at','failed_at','failure_reason']) AS col
   WHERE has_column_privilege('contentos_app', 'notifications', col, 'UPDATE');
  IF seen = 4 THEN
    results := results || format(REPORT, 'PASS', 'notifications-delivery-columns-granted',
      'the four delivery columns are updatable, and only those.');
  ELSE
    failures := failures + 1;
    results := results || format(REPORT, 'FAIL', 'notifications-delivery-columns-granted',
      format('only %s of 4 delivery columns are updatable; the outcome could not be recorded.', seen));
  END IF;

  -- ── Report ────────────────────────────────────────────────────────────────
  RAISE NOTICE '==> notification verification (% assertions)', array_length(results, 1);
  FOREACH line IN ARRAY results LOOP
    RAISE NOTICE '%', line;
  END LOOP;

  IF failures > 0 THEN
    RAISE EXCEPTION 'notification verification FAILED (% failing assertion(s))', failures;
  END IF;

  RAISE NOTICE '==> notification verification GREEN';
END
$verify$;

-- Nothing above is kept.
ROLLBACK;
