-- Feature flag layer verification, run as the APPLICATION role.
--
-- Flags add NO tables. They live in the `settings` JSONB the resolver already
-- reads, under the `flags.` namespace, so the shape checks belong to the
-- settings gate (5d) and are not repeated here. What IS flag-specific:
--
--   A flag value must come back out of JSONB as a json BOOLEAN. The resolver
--   type-checks it, and a value stored as the string "true" would be rejected
--   and fall through to the built-in — silently, and for a kill switch that
--   means the switch reads as un-thrown.
--
--   The namespace must actually separate the two key spaces inside one column,
--   because that separation is the only thing standing between a flag override
--   and a setting of the same name.
--
-- One transaction, rolled back. Failures are aggregated; results accumulate in
-- an ARRAY because a caught exception rolls back database changes made inside
-- the block.

BEGIN;

DO $verify$
DECLARE
  ORG   CONSTANT UUID := '018f7a1e-0000-7000-8000-0000000000aa';  -- seeded organization
  WS    CONSTANT UUID := '018f7a1e-0000-7000-8000-0000000000bb';  -- seeded workspace
  OTHER CONSTANT UUID := '018f7a1e-0000-7000-8000-0000000000cc';  -- a second seeded workspace

  REPORT CONSTANT TEXT := '    %-4s %-40s %s';

  results  TEXT[] := '{}';
  failures INT    := 0;

  seen     INT;
  layer    JSONB;
  kind     TEXT;
  flag_on  BOOLEAN;
  ws_ver   INT;
  line     TEXT;
BEGIN
  PERFORM set_config('app.tenant_id', WS::text, true);

  -- ── 1 · a flag override round-trips as a json boolean ─────────────────────
  UPDATE workspaces
     SET settings = settings || '{"flags.knowledge.vector_search": true}'::jsonb,
         version = version + 1
   WHERE id = WS;

  SELECT jsonb_typeof(settings -> 'flags.knowledge.vector_search') INTO kind
    FROM workspaces WHERE id = WS;

  IF kind = 'boolean' THEN
    results := results || format(REPORT, 'PASS', 'flags-boolean-round-trip',
      'a flag override reads back as a json boolean.');
  ELSE
    failures := failures + 1;
    results := results || format(REPORT, 'FAIL', 'flags-boolean-round-trip',
      format('a flag override read back as %s; the resolver type-checks it and would fall through to the built-in.',
             coalesce(kind, 'NULL')));
  END IF;

  -- ── 2 · and its value is the one that was written ─────────────────────────
  SELECT count(*) INTO seen
    FROM workspaces
   WHERE id = WS AND (settings -> 'flags.knowledge.vector_search')::boolean IS TRUE;
  IF seen = 1 THEN
    results := results || format(REPORT, 'PASS', 'flags-value-preserved',
      'the override evaluates to the value that was stored.');
  ELSE
    failures := failures + 1;
    results := results || format(REPORT, 'FAIL', 'flags-value-preserved',
      'the stored override did not read back as true.');
  END IF;

  -- ── 3 · a string "true" is NOT a boolean ──────────────────────────────────
  -- The failure this gate exists for: it looks right in the column and is
  -- rejected by the resolver.
  UPDATE workspaces
     SET settings = settings || '{"flags.publishing.wordpress_connector": "true"}'::jsonb
   WHERE id = WS;
  SELECT jsonb_typeof(settings -> 'flags.publishing.wordpress_connector') INTO kind
    FROM workspaces WHERE id = WS;
  IF kind = 'string' THEN
    results := results || format(REPORT, 'PASS', 'flags-string-is-distinguishable',
      'a quoted "true" is stored as a string and is therefore rejectable, not silently truthy.');
  ELSE
    failures := failures + 1;
    results := results || format(REPORT, 'FAIL', 'flags-string-is-distinguishable',
      format('a quoted "true" read back as %s; a mistyped override would be indistinguishable from a real one.',
             coalesce(kind, 'NULL')));
  END IF;

  -- ── 4 · the namespace separates flags from settings in one column ─────────
  UPDATE workspaces
     SET settings = settings || '{"content.locale":"fr-FR"}'::jsonb
   WHERE id = WS;

  SELECT settings INTO layer FROM workspaces WHERE id = WS;
  IF layer ->> 'content.locale' = 'fr-FR'
     AND (layer -> 'flags.knowledge.vector_search')::boolean IS TRUE
     AND layer -> 'knowledge.vector_search' IS NULL THEN
    results := results || format(REPORT, 'PASS', 'flags-namespace-separates',
      'a flag override and a setting coexist in one layer without either shadowing the other.');
  ELSE
    failures := failures + 1;
    results := results || format(REPORT, 'FAIL', 'flags-namespace-separates',
      'the flag namespace does not separate the two key spaces inside the settings column.');
  END IF;

  -- ── 5 · an organization-layer override is readable above the tenant ───────
  -- Entitlement flags are organization-scoped, and the resolver reads that
  -- layer from under a WORKSPACE tenant.
  UPDATE organizations
     SET settings = settings || '{"flags.entitlements.sso": true}'::jsonb
   WHERE id = ORG;

  SELECT (o.settings -> 'flags.entitlements.sso')::boolean INTO flag_on
    FROM workspaces w JOIN organizations o ON o.id = w.organization_id
   WHERE w.id = WS;

  IF flag_on IS TRUE THEN
    results := results || format(REPORT, 'PASS', 'flags-organization-layer-readable',
      'an organization-scoped entitlement flag is readable from under a workspace tenant.');
  ELSE
    failures := failures + 1;
    results := results || format(REPORT, 'FAIL', 'flags-organization-layer-readable',
      'the organization flag layer is invisible to the resolver; every entitlement would read as its built-in default.');
  END IF;

  -- ── 6 · writing a flag override advances the version ──────────────────────
  -- Flags share the settings version, which is what invalidates the shared
  -- cache. If a flag write did not move it, a thrown kill switch would keep
  -- reading as un-thrown until something else happened to write the row.
  SELECT version INTO ws_ver FROM workspaces WHERE id = WS;
  IF ws_ver > 1 THEN
    results := results || format(REPORT, 'PASS', 'flags-version-advances',
      format('the workspace layer is at version %s after a flag write.', ws_ver));
  ELSE
    failures := failures + 1;
    results := results || format(REPORT, 'FAIL', 'flags-version-advances',
      'a flag override did not advance version; a cached evaluation would never be reloaded.');
  END IF;

  -- ── 7 · flag overrides are tenant-isolated ────────────────────────────────
  SELECT count(*) INTO seen FROM workspaces WHERE id = OTHER;
  IF seen = 0 THEN
    results := results || format(REPORT, 'PASS', 'flags-cross-tenant-read-blocked',
      'another workspace''s flag overrides are invisible under this tenant.');
  ELSE
    failures := failures + 1;
    results := results || format(REPORT, 'FAIL', 'flags-cross-tenant-read-blocked',
      'another workspace''s flag overrides were readable.');
  END IF;

  -- ── Report ────────────────────────────────────────────────────────────────
  RAISE NOTICE '==> feature flag layer verification (% assertions)', array_length(results, 1);
  FOREACH line IN ARRAY results LOOP
    RAISE NOTICE '%', line;
  END LOOP;

  IF failures > 0 THEN
    RAISE EXCEPTION 'feature flag layer verification FAILED (% failing assertion(s))', failures;
  END IF;

  RAISE NOTICE '==> feature flag layer verification GREEN';
END
$verify$;

-- Nothing above is kept.
ROLLBACK;
