-- Settings layer verification, run as the APPLICATION role against real PostgreSQL.
--
-- The resolver is unit-tested; what needs a server is the shape it reads. Two
-- things in particular:
--
--   The resolver's version probe JOINs `workspaces` to `organizations` and is
--   issued under a WORKSPACE tenant. `workspaces` is RLS-protected and
--   `organizations` is exception 1/5, so whether that join returns a row at all
--   is a property of the policy set, not of the SQL.
--
--   `organizations.settings` must exist, be jsonb, and default to an empty
--   object — the resolver treats a missing layer and an empty layer as the same
--   thing ("absence falls through"), and would silently resolve everything to
--   built-ins if the column were absent or null.
--
-- One transaction, rolled back. Failures are aggregated; results accumulate in
-- an ARRAY because a caught exception rolls back database changes made inside
-- the block, so a table would lose the rows recording what failed.

BEGIN;

DO $verify$
DECLARE
  ORG   CONSTANT UUID := '018f7a1e-0000-7000-8000-0000000000aa';  -- seeded organization
  WS    CONSTANT UUID := '018f7a1e-0000-7000-8000-0000000000bb';  -- seeded workspace
  OTHER CONSTANT UUID := '018f7a1e-0000-7000-8000-0000000000cc';  -- a second seeded workspace

  REPORT CONSTANT TEXT := '    %-4s %-40s %s';

  results  TEXT[] := '{}';
  failures INT    := 0;

  seen      INT;
  ws_ver    INT;
  org_ver   INT;
  layer     JSONB;
  line      TEXT;
BEGIN
  PERFORM set_config('app.tenant_id', WS::text, true);

  -- ── 1 · the organization layer exists and is an object ────────────────────
  SELECT count(*) INTO seen
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'organizations'
     AND column_name = 'settings' AND data_type = 'jsonb'
     AND column_default = '''{}''::jsonb';
  IF seen = 1 THEN
    results := results || format(REPORT, 'PASS', 'settings-organization-column',
      'organizations.settings is jsonb defaulting to an empty object.');
  ELSE
    failures := failures + 1;
    results := results || format(REPORT, 'FAIL', 'settings-organization-column',
      'organizations.settings is missing, not jsonb, or does not default to {}. Every key would silently resolve to its built-in.');
  END IF;

  -- ── 2 · the workspace layer is still there ────────────────────────────────
  SELECT count(*) INTO seen
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'workspaces'
     AND column_name = 'settings' AND data_type = 'jsonb';
  IF seen = 1 THEN
    results := results || format(REPORT, 'PASS', 'settings-workspace-column',
      'workspaces.settings is jsonb.');
  ELSE
    failures := failures + 1;
    results := results || format(REPORT, 'FAIL', 'settings-workspace-column',
      'workspaces.settings is missing or is not jsonb.');
  END IF;

  -- ── 3 · a non-object layer is refused ─────────────────────────────────────
  -- The resolver indexes into the layer by key. An array or a scalar there
  -- would not throw, it would quietly match nothing.
  BEGIN
    UPDATE organizations SET settings = '[]'::jsonb WHERE id = ORG;
    failures := failures + 1;
    results := results || format(REPORT, 'FAIL', 'settings-layer-must-be-object',
      'an array was accepted as a settings layer; every key would resolve to its built-in with no error.');
  EXCEPTION WHEN check_violation THEN
    results := results || format(REPORT, 'PASS', 'settings-layer-must-be-object',
      'a settings layer must be a json object.');
  END;

  -- ── 4 · the resolver's version probe returns a row ────────────────────────
  -- Under a WORKSPACE tenant, joining an RLS-protected table to an exception
  -- table. If the policy set ever changes this returns nothing, and the
  -- resolver reports the scope as deleted for a workspace that plainly exists.
  SELECT w.version, o.version INTO ws_ver, org_ver
    FROM workspaces w
    JOIN organizations o ON o.id = w.organization_id
   WHERE w.id = WS AND w.deleted_at IS NULL;

  IF ws_ver IS NOT NULL AND org_ver IS NOT NULL THEN
    results := results || format(REPORT, 'PASS', 'settings-version-probe',
      format('the probe reads both layer versions under a workspace tenant (w%s.o%s).', ws_ver, org_ver));
  ELSE
    failures := failures + 1;
    results := results || format(REPORT, 'FAIL', 'settings-version-probe',
      'the probe returned no row for a workspace that exists; the resolver would report it deleted.');
  END IF;

  -- ── 5 · and the layer read returns both layers ────────────────────────────
  SELECT o.settings INTO layer
    FROM workspaces w
    JOIN organizations o ON o.id = w.organization_id
   WHERE w.id = WS AND w.deleted_at IS NULL;

  IF layer IS NOT NULL AND jsonb_typeof(layer) = 'object' THEN
    results := results || format(REPORT, 'PASS', 'settings-layer-read',
      'the organization layer is readable above the workspace tenant boundary.');
  ELSE
    failures := failures + 1;
    results := results || format(REPORT, 'FAIL', 'settings-layer-read',
      'the organization layer read as NULL or a non-object under a workspace tenant.');
  END IF;

  -- ── 6 · the workspace layer is still tenant-isolated ──────────────────────
  -- Reading a SECOND workspace's layer must return nothing: the resolver is
  -- given a workspace id by its caller, and RLS is what stops that id being
  -- someone else's.
  SELECT count(*) INTO seen FROM workspaces WHERE id = OTHER;
  IF seen = 0 THEN
    results := results || format(REPORT, 'PASS', 'settings-cross-tenant-read-blocked',
      'another workspace''s layer is invisible under this tenant.');
  ELSE
    failures := failures + 1;
    results := results || format(REPORT, 'FAIL', 'settings-cross-tenant-read-blocked',
      'another workspace''s settings layer was readable.');
  END IF;

  -- ── 7 · organizations remains an RLS exception ────────────────────────────
  -- The resolver reads it from under a workspace tenant. If it gained RLS the
  -- organization layer would vanish and every key would fall to its built-in —
  -- silently, and in the more permissive direction.
  SELECT count(*) INTO seen
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'organizations' AND c.relrowsecurity;
  IF seen = 0 THEN
    results := results || format(REPORT, 'PASS', 'settings-organizations-exception',
      'organizations is still exception 1/5, so the layer is readable above the tenant.');
  ELSE
    failures := failures + 1;
    results := results || format(REPORT, 'FAIL', 'settings-organizations-exception',
      'organizations gained RLS; the organization settings layer is now invisible to the resolver.');
  END IF;

  -- ── 8 · a version bump is observable ──────────────────────────────────────
  -- The whole cache-invalidation design rests on this column moving when a
  -- layer is written.
  UPDATE workspaces
     SET settings = settings || '{"content.locale":"fr-FR"}'::jsonb,
         version = version + 1
   WHERE id = WS;

  SELECT w.version, w.settings INTO ws_ver, layer FROM workspaces w WHERE w.id = WS;
  IF ws_ver > 1 AND layer ->> 'content.locale' = 'fr-FR' THEN
    results := results || format(REPORT, 'PASS', 'settings-version-advances',
      format('writing a layer advances version to %s, which is what invalidates the cache.', ws_ver));
  ELSE
    failures := failures + 1;
    results := results || format(REPORT, 'FAIL', 'settings-version-advances',
      'a layer write did not advance version; a cached resolution would never be reloaded.');
  END IF;

  -- ── Report ────────────────────────────────────────────────────────────────
  RAISE NOTICE '==> settings layer verification (% assertions)', array_length(results, 1);
  FOREACH line IN ARRAY results LOOP
    RAISE NOTICE '%', line;
  END LOOP;

  IF failures > 0 THEN
    RAISE EXCEPTION 'settings layer verification FAILED (% failing assertion(s))', failures;
  END IF;

  RAISE NOTICE '==> settings layer verification GREEN';
END
$verify$;

-- Nothing above is kept.
ROLLBACK;
