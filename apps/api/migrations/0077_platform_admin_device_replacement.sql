-- Task P1.1 (Ops Portal redesign, 6 November 2026; the Product Owner's decision of 6 November 2026): the Platform Admin may replace a rider's device at every hub. Migration 0075
-- widened every operational grant of the Platform Admin bundle to all hubs EXCEPT `staff.device.reregister`, which stayed at the administrator's own hub on the strength of the
-- decision of 8 October 2026 (AC-SLICE-000-23). The decision of 6 November 2026 overrides it for the Platform Admin alone: this brings a database seeded before it to what a new
-- seed writes (tools/seed/bundles.ts, GRANTS). Applied as melarc_migration_elevated, a member of melarc_owner (MIGRATION_AND_SEEDING.md section 5.1). It changes no table, column,
-- policy or function: it calls the bundle-change primitive of 0017 on the one bundle, exactly as 0075 does.
--
--   * What it changes. The Platform Admin's grant of `staff.device.reregister` goes from `own` to `all`. Senior Ops keep it at their own hub, and no other grant and no other bundle is
--     touched: the ownership scope and the tier of every grant are carried over, so the rules that compare the tier (the maker-checker exception, the privileged-target rule) read what
--     they read before. The rider still attends in person with the identity verified (MSC-DEC-235), and the reason, the verification note and the audit stay mandatory: nothing here
--     touches them.
--   * A widening is an ADDITION to the primitive (none < own < all): the revision of the bundle rises, the floor does not, and no session is ended. A session issued before this keeps
--     the snapshot it was issued with and the new scope reaches a session issued after it (the administrator signs in again; the release step in DEPLOYMENT_AND_ENVIRONMENTS.md has the
--     existing sessions of every Platform Admin revoked so that they do). The migration refuses to go on if the primitive reads the change as anything but an ADDITION (or NONE, when it
--     is run twice or on a database the new seed wrote): a change it cannot show to be a widening would be a reduction, which ends sessions, and nothing here is meant to.
--   * Only where there is something to widen. On a database that has not been seeded the bundle table is empty and there is nothing to do: the seed writes the whole content there.
--   * The labels and the locks are those of 0043, 0057 and 0075: the migration reads the bundle under policy_change, puts back what it found, and locks every bundle first in the
--     canonical order of lock_policy_keys (SECURITY_DESIGN.md section 13.10a).
--
-- test/database/slice-001-grants.db.test.ts holds the four stages together: a database seeded earlier and then migrated holds exactly the grants a new seed writes.

DO $platform_admin_device_replacement$
DECLARE
  previous_type text := coalesce(pg_catalog.current_setting('melarc.principal_type', true), '');
  previous_capability text := coalesce(pg_catalog.current_setting('melarc.task_capability', true), '');
  platform_admin constant uuid := '5eed0001-0000-4000-8000-000000000003';
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
    ARRAY[]::text[]
  );

  PERFORM pg_catalog.set_config('melarc.principal_type', 'SYSTEM', true);
  PERFORM pg_catalog.set_config('melarc.task_capability', 'policy_change', true);

  IF EXISTS (SELECT 1 FROM public.role_bundle AS b WHERE b.id = platform_admin) THEN
    SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
             'permission_key', g.permission_key,
             'hub_scope', CASE
                            WHEN g.hub_scope = 'own' AND g.permission_key = 'staff.device.reregister' THEN 'all'
                            ELSE g.hub_scope
                          END,
             'ownership_scope', g.ownership_scope,
             'tier', g.tier) ORDER BY g.permission_key), '[]'::jsonb)
      INTO merged
      FROM public.role_bundle_grant AS g
     WHERE g.bundle_id = platform_admin;

    outcome := melarc.change_role_bundle(platform_admin, NULL, merged, 'release-p1-1#platform-admin-device-replacement');
    IF outcome->>'kind' NOT IN ('ADDITION', 'NONE') THEN
      RAISE EXCEPTION 'the Platform Admin grants only widen: the primitive answered % for the bundle', outcome->>'kind'
        USING ERRCODE = '55000';
    END IF;
  END IF;

  PERFORM pg_catalog.set_config('melarc.principal_type', previous_type, true);
  PERFORM pg_catalog.set_config('melarc.task_capability', previous_capability, true);
END
$platform_admin_device_replacement$;
