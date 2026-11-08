-- S1.8, Gate 1 (SLICE-001; delivery/planning/SLICE-001-IMPLEMENTATION-PLAN.md S1.8; the Product Owner's decision D-14 of 29 October 2026):
-- the keys the slice's operations need reach a database that was seeded before them. Applied as melarc_migration_elevated, a member of
-- melarc_owner (MIGRATION_AND_SEEDING.md section 5.1). It changes no table, column, policy or function: it adds one permission row and
-- calls the bundle-change primitive of 0017 on the six seeded bundles.
--
--   * Why a migration and not only the seed. The reference seed fills an empty database once and refuses a database that holds a row
--     (MIGRATION_AND_SEEDING.md section 4), so a database seeded on 27 October 2026 with the SLICE-000 keys can never be seeded again.
--     What the seed now writes for a new database (tools/seed/bundles.ts, SLICE_001_GRANTS, and the permission catalogue) a seeded one
--     gets here, once. test/database/slice-001-grants.db.test.ts holds the two to the same result: a database seeded earlier and
--     then migrated holds exactly the grants a new seed writes.
--   * Only an addition. Each bundle's new content is the grants it holds now plus the rows below that it does not hold yet, so no grant
--     is removed or changed, the primitive reads the change as an ADDITION (the revision rises, the floor does not) and no session
--     is ended: a session issued before this keeps the snapshot it was issued with and a sign-in after it carries the new keys
--     (OB-S1-03). The migration refuses to go on if the primitive ever answers anything else.
--   * Only where there is something to add. On a database that has not been seeded the permission, bundle and policy tables are empty
--     and there is nothing to add to: the seed writes the whole content there, and this does nothing. Where the content is already
--     held (a database seeded after this, or this run twice) the primitive answers NONE and writes nothing, and the fixed policy is
--     not released again: the Vendor's and the Rider's revision rises once, with the change to their bundle.
--   * The fixed Vendor and Rider policy. Their rules are the bundle's keys and the predicates compiled into the build
--     (BUILD_FIXED_POLICY, app.module.ts); the build that carries the slice's keys declares revision 2, and the database is told of
--     the release the only way it can be, by melarc.change_fixed_policy, declared an addition (the floor stays 1, so the previous
--     build still serves its own sessions and sessions issued by this one are refused by it with 503, not ended).
--   * The labels. The tables are under forced row-level security, whose policies admit a SYSTEM context under one task capability and
--     nobody else. The migration reads the bundles under policy_change and writes the key under seed, as the primitive and the seed
--     do, and puts back what it found. A label is not an identity: the migration login owns the tables, and the runtime logins that
--     can assert the same labels hold SELECT on these tables and nothing more.
--   * Locks. Every bundle and both fixed policies are locked exclusively first, in the canonical order of lock_policy_keys (SECURITY_DESIGN.md
--     section 13.10a), so the reads that follow cannot be overtaken by a sign-in or another change.
--
-- The rows are the catalogue's holders for the keys of the operations the slice builds (permissions.md section 7; the list and what is
-- left out are in tools/seed/bundles.ts). A Platform Admin created by the bootstrap has no primary hub, so its own-hub grants reach no
-- hub; widening them is a later addition and a decision of the Product Owner (S1.8 finding).

DO $slice_001_grants$
DECLARE
  previous_type text := coalesce(pg_catalog.current_setting('melarc.principal_type', true), '');
  previous_capability text := coalesce(pg_catalog.current_setting('melarc.task_capability', true), '');
  seeded_bundle record;
  merged jsonb;
  outcome jsonb;
BEGIN
  PERFORM melarc.lock_policy_keys(
    ARRAY[
      '5eed0001-0000-4000-8000-000000000001',
      '5eed0001-0000-4000-8000-000000000002',
      '5eed0001-0000-4000-8000-000000000003',
      '5eed0001-0000-4000-8000-000000000004',
      '5eed0001-0000-4000-8000-000000000005',
      '5eed0001-0000-4000-8000-000000000006'
    ]::uuid[],
    ARRAY['VENDOR', 'RIDER']
  );

  -- The permission the slice added to the catalogue (pickup.handshake.resolve, Senior Ops and Platform Admin). Only a database the seed
  -- has filled gets it from here; the seed writes it to a new one.
  PERFORM pg_catalog.set_config('melarc.principal_type', 'SYSTEM', true);
  PERFORM pg_catalog.set_config('melarc.task_capability', 'seed', true);
  IF EXISTS (SELECT 1 FROM public.permission) THEN
    INSERT INTO public.permission (key, domain)
    SELECT 'pickup.handshake.resolve', 'pickup'
     WHERE NOT EXISTS (SELECT 1 FROM public.permission WHERE key = 'pickup.handshake.resolve');
  END IF;

  PERFORM pg_catalog.set_config('melarc.task_capability', 'policy_change', true);
  FOR seeded_bundle IN
    SELECT b.id, b.audience FROM public.role_bundle AS b ORDER BY b.id
  LOOP
    WITH added(bundle_id, permission_key, hub_scope, ownership_scope, tier) AS (
      VALUES
        -- opsStaff (23)
        ('5eed0001-0000-4000-8000-000000000001'::uuid, 'fleet.custody.accept', 'own', 'any', 'A'),
        ('5eed0001-0000-4000-8000-000000000001'::uuid, 'fleet.custody.initiate', 'own', 'any', 'A'),
        ('5eed0001-0000-4000-8000-000000000001'::uuid, 'fleet.custody.read', 'own', 'any', 'A'),
        ('5eed0001-0000-4000-8000-000000000001'::uuid, 'hub.intake.close', 'own', 'any', 'A'),
        ('5eed0001-0000-4000-8000-000000000001'::uuid, 'hub.intake.count', 'own', 'any', 'A'),
        ('5eed0001-0000-4000-8000-000000000001'::uuid, 'hub.intake.itemize', 'own', 'any', 'A'),
        ('5eed0001-0000-4000-8000-000000000001'::uuid, 'hub.read', 'own', 'any', 'A'),
        ('5eed0001-0000-4000-8000-000000000001'::uuid, 'pickup.exception.approve', 'own', 'any', 'A'),
        ('5eed0001-0000-4000-8000-000000000001'::uuid, 'pickup.exception.request', 'own', 'any', 'A'),
        ('5eed0001-0000-4000-8000-000000000001'::uuid, 'pickup.failure.resolve', 'own', 'any', 'A'),
        ('5eed0001-0000-4000-8000-000000000001'::uuid, 'pickup.handshake.override', 'own', 'any', 'A'),
        ('5eed0001-0000-4000-8000-000000000001'::uuid, 'pickup.manifest.assign', 'own', 'any', 'A'),
        ('5eed0001-0000-4000-8000-000000000001'::uuid, 'pickup.manifest.create', 'own', 'any', 'A'),
        ('5eed0001-0000-4000-8000-000000000001'::uuid, 'pickup.manifest.dispatch', 'own', 'any', 'A'),
        ('5eed0001-0000-4000-8000-000000000001'::uuid, 'pickup.read', 'own', 'any', 'A'),
        ('5eed0001-0000-4000-8000-000000000001'::uuid, 'pickup.request.cancel', 'own', 'any', 'A'),
        ('5eed0001-0000-4000-8000-000000000001'::uuid, 'pickup.request.cancel_chargeable', 'own', 'any', 'A'),
        ('5eed0001-0000-4000-8000-000000000001'::uuid, 'pickup.request.confirm', 'own', 'any', 'A'),
        ('5eed0001-0000-4000-8000-000000000001'::uuid, 'pickup.request.create', 'own', 'any', 'A'),
        ('5eed0001-0000-4000-8000-000000000001'::uuid, 'pickup.stop.skip', 'own', 'any', 'A'),
        ('5eed0001-0000-4000-8000-000000000001'::uuid, 'pricing.correction.create', 'own', 'any', 'A'),
        ('5eed0001-0000-4000-8000-000000000001'::uuid, 'pricing.read', 'own', 'any', 'A'),
        ('5eed0001-0000-4000-8000-000000000001'::uuid, 'vendor.pickup_location.manage', 'own', 'any', 'A'),
        -- seniorOps (29)
        ('5eed0001-0000-4000-8000-000000000002'::uuid, 'fleet.custody.accept', 'own', 'any', 'S'),
        ('5eed0001-0000-4000-8000-000000000002'::uuid, 'fleet.custody.initiate', 'own', 'any', 'S'),
        ('5eed0001-0000-4000-8000-000000000002'::uuid, 'fleet.custody.read', 'own', 'any', 'S'),
        ('5eed0001-0000-4000-8000-000000000002'::uuid, 'hub.intake.close', 'own', 'any', 'S'),
        ('5eed0001-0000-4000-8000-000000000002'::uuid, 'hub.intake.close_exception', 'own', 'any', 'S'),
        ('5eed0001-0000-4000-8000-000000000002'::uuid, 'hub.intake.count', 'own', 'any', 'S'),
        ('5eed0001-0000-4000-8000-000000000002'::uuid, 'hub.intake.itemize', 'own', 'any', 'S'),
        ('5eed0001-0000-4000-8000-000000000002'::uuid, 'hub.osd.adjudicate', 'own', 'any', 'S'),
        ('5eed0001-0000-4000-8000-000000000002'::uuid, 'hub.read', 'own', 'any', 'S'),
        ('5eed0001-0000-4000-8000-000000000002'::uuid, 'pickup.attempt.extend', 'own', 'any', 'S'),
        ('5eed0001-0000-4000-8000-000000000002'::uuid, 'pickup.cancellation_charge.waive', 'own', 'any', 'S'),
        ('5eed0001-0000-4000-8000-000000000002'::uuid, 'pickup.exception.approve', 'own', 'any', 'S'),
        ('5eed0001-0000-4000-8000-000000000002'::uuid, 'pickup.exception.request', 'own', 'any', 'S'),
        ('5eed0001-0000-4000-8000-000000000002'::uuid, 'pickup.failure.resolve', 'own', 'any', 'S'),
        ('5eed0001-0000-4000-8000-000000000002'::uuid, 'pickup.handshake.override', 'own', 'any', 'S'),
        ('5eed0001-0000-4000-8000-000000000002'::uuid, 'pickup.handshake.resolve', 'own', 'any', 'S'),
        ('5eed0001-0000-4000-8000-000000000002'::uuid, 'pickup.manifest.assign', 'own', 'any', 'S'),
        ('5eed0001-0000-4000-8000-000000000002'::uuid, 'pickup.manifest.create', 'own', 'any', 'S'),
        ('5eed0001-0000-4000-8000-000000000002'::uuid, 'pickup.manifest.dispatch', 'own', 'any', 'S'),
        ('5eed0001-0000-4000-8000-000000000002'::uuid, 'pickup.read', 'own', 'any', 'S'),
        ('5eed0001-0000-4000-8000-000000000002'::uuid, 'pickup.request.cancel', 'own', 'any', 'S'),
        ('5eed0001-0000-4000-8000-000000000002'::uuid, 'pickup.request.cancel_chargeable', 'own', 'any', 'S'),
        ('5eed0001-0000-4000-8000-000000000002'::uuid, 'pickup.request.confirm', 'own', 'any', 'S'),
        ('5eed0001-0000-4000-8000-000000000002'::uuid, 'pickup.request.create', 'own', 'any', 'S'),
        ('5eed0001-0000-4000-8000-000000000002'::uuid, 'pickup.stop.skip', 'own', 'any', 'S'),
        ('5eed0001-0000-4000-8000-000000000002'::uuid, 'pricing.correction.approve', 'own', 'any', 'S'),
        ('5eed0001-0000-4000-8000-000000000002'::uuid, 'pricing.correction.create', 'own', 'any', 'S'),
        ('5eed0001-0000-4000-8000-000000000002'::uuid, 'pricing.read', 'own', 'any', 'S'),
        ('5eed0001-0000-4000-8000-000000000002'::uuid, 'vendor.pickup_location.manage', 'own', 'any', 'S'),
        -- platformAdmin (29)
        ('5eed0001-0000-4000-8000-000000000003'::uuid, 'fleet.custody.accept', 'own', 'any', 'P'),
        ('5eed0001-0000-4000-8000-000000000003'::uuid, 'fleet.custody.initiate', 'own', 'any', 'P'),
        ('5eed0001-0000-4000-8000-000000000003'::uuid, 'fleet.custody.read', 'own', 'any', 'P'),
        ('5eed0001-0000-4000-8000-000000000003'::uuid, 'hub.intake.close', 'own', 'any', 'P'),
        ('5eed0001-0000-4000-8000-000000000003'::uuid, 'hub.intake.close_exception', 'own', 'any', 'P'),
        ('5eed0001-0000-4000-8000-000000000003'::uuid, 'hub.intake.count', 'own', 'any', 'P'),
        ('5eed0001-0000-4000-8000-000000000003'::uuid, 'hub.intake.itemize', 'own', 'any', 'P'),
        ('5eed0001-0000-4000-8000-000000000003'::uuid, 'hub.osd.adjudicate', 'own', 'any', 'P'),
        ('5eed0001-0000-4000-8000-000000000003'::uuid, 'hub.read', 'own', 'any', 'P'),
        ('5eed0001-0000-4000-8000-000000000003'::uuid, 'pickup.attempt.extend', 'own', 'any', 'P'),
        ('5eed0001-0000-4000-8000-000000000003'::uuid, 'pickup.cancellation_charge.waive', 'own', 'any', 'P'),
        ('5eed0001-0000-4000-8000-000000000003'::uuid, 'pickup.exception.approve', 'all', 'any', 'P'),
        ('5eed0001-0000-4000-8000-000000000003'::uuid, 'pickup.exception.request', 'own', 'any', 'P'),
        ('5eed0001-0000-4000-8000-000000000003'::uuid, 'pickup.failure.resolve', 'own', 'any', 'P'),
        ('5eed0001-0000-4000-8000-000000000003'::uuid, 'pickup.handshake.override', 'own', 'any', 'P'),
        ('5eed0001-0000-4000-8000-000000000003'::uuid, 'pickup.handshake.resolve', 'own', 'any', 'P'),
        ('5eed0001-0000-4000-8000-000000000003'::uuid, 'pickup.manifest.assign', 'own', 'any', 'P'),
        ('5eed0001-0000-4000-8000-000000000003'::uuid, 'pickup.manifest.create', 'own', 'any', 'P'),
        ('5eed0001-0000-4000-8000-000000000003'::uuid, 'pickup.manifest.dispatch', 'own', 'any', 'P'),
        ('5eed0001-0000-4000-8000-000000000003'::uuid, 'pickup.read', 'own', 'any', 'P'),
        ('5eed0001-0000-4000-8000-000000000003'::uuid, 'pickup.request.cancel', 'own', 'any', 'P'),
        ('5eed0001-0000-4000-8000-000000000003'::uuid, 'pickup.request.cancel_chargeable', 'own', 'any', 'P'),
        ('5eed0001-0000-4000-8000-000000000003'::uuid, 'pickup.request.confirm', 'own', 'any', 'P'),
        ('5eed0001-0000-4000-8000-000000000003'::uuid, 'pickup.request.create', 'own', 'any', 'P'),
        ('5eed0001-0000-4000-8000-000000000003'::uuid, 'pickup.stop.skip', 'own', 'any', 'P'),
        ('5eed0001-0000-4000-8000-000000000003'::uuid, 'pricing.correction.approve', 'own', 'any', 'P'),
        ('5eed0001-0000-4000-8000-000000000003'::uuid, 'pricing.correction.create', 'own', 'any', 'P'),
        ('5eed0001-0000-4000-8000-000000000003'::uuid, 'pricing.read', 'own', 'any', 'P'),
        ('5eed0001-0000-4000-8000-000000000003'::uuid, 'vendor.pickup_location.manage', 'own', 'any', 'P'),
        -- finance (1)
        ('5eed0001-0000-4000-8000-000000000004'::uuid, 'pricing.read', 'all', 'any', NULL::text),
        -- rider (7)
        ('5eed0001-0000-4000-8000-000000000005'::uuid, 'fleet.custody.accept', 'none', 'assigned', NULL::text),
        ('5eed0001-0000-4000-8000-000000000005'::uuid, 'fleet.custody.read', 'none', 'assigned', NULL::text),
        ('5eed0001-0000-4000-8000-000000000005'::uuid, 'hub.handover.submit', 'none', 'assigned', NULL::text),
        ('5eed0001-0000-4000-8000-000000000005'::uuid, 'pickup.collection.confirm', 'none', 'assigned', NULL::text),
        ('5eed0001-0000-4000-8000-000000000005'::uuid, 'pickup.failure.report', 'none', 'assigned', NULL::text),
        ('5eed0001-0000-4000-8000-000000000005'::uuid, 'pickup.read', 'none', 'assigned', NULL::text),
        ('5eed0001-0000-4000-8000-000000000005'::uuid, 'pickup.run.execute', 'none', 'assigned', NULL::text),
        -- vendor (6)
        ('5eed0001-0000-4000-8000-000000000006'::uuid, 'pickup.collection.confirm', 'none', 'own', NULL::text),
        ('5eed0001-0000-4000-8000-000000000006'::uuid, 'pickup.read', 'none', 'own', NULL::text),
        ('5eed0001-0000-4000-8000-000000000006'::uuid, 'pickup.request.cancel', 'none', 'own', NULL::text),
        ('5eed0001-0000-4000-8000-000000000006'::uuid, 'pickup.request.create', 'none', 'own', NULL::text),
        ('5eed0001-0000-4000-8000-000000000006'::uuid, 'pricing.read', 'none', 'own', NULL::text),
        ('5eed0001-0000-4000-8000-000000000006'::uuid, 'vendor.pickup_location.manage', 'none', 'own', NULL::text)
    ), content AS (
      SELECT g.permission_key, g.hub_scope, g.ownership_scope, g.tier
        FROM public.role_bundle_grant AS g
       WHERE g.bundle_id = seeded_bundle.id
      UNION ALL
      SELECT a.permission_key, a.hub_scope, a.ownership_scope, a.tier
        FROM added AS a
       WHERE a.bundle_id = seeded_bundle.id
         AND NOT EXISTS (
           SELECT 1 FROM public.role_bundle_grant AS held
            WHERE held.bundle_id = seeded_bundle.id AND held.permission_key = a.permission_key
         )
    )
    SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
             'permission_key', c.permission_key,
             'hub_scope', c.hub_scope,
             'ownership_scope', c.ownership_scope,
             'tier', c.tier)), '[]'::jsonb)
      INTO merged
      FROM content AS c;

    outcome := melarc.change_role_bundle(seeded_bundle.id, NULL, merged, 'release-slice-001#bundle');
    IF outcome->>'kind' NOT IN ('ADDITION', 'NONE') THEN
      RAISE EXCEPTION 'the SLICE-001 grants only add: the primitive answered % for a bundle', outcome->>'kind'
        USING ERRCODE = '55000';
    END IF;
    IF outcome->>'kind' = 'ADDITION' AND seeded_bundle.audience IN ('VENDOR', 'RIDER') THEN
      PERFORM melarc.change_fixed_policy(seeded_bundle.audience, false, 'release-slice-001#policy');
    END IF;
  END LOOP;

  PERFORM pg_catalog.set_config('melarc.principal_type', previous_type, true);
  PERFORM pg_catalog.set_config('melarc.task_capability', previous_capability, true);
END
$slice_001_grants$;
