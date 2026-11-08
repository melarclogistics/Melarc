-- S1.12e (SLICE-001; delivery/planning/SLICE-001-IMPLEMENTATION-PLAN.md S1.12; permissions.md section 7: `notification.read`, A S P at their own hub):
-- the key of the Ops message log reaches a database that was seeded before it was granted to anyone. Applied as melarc_migration_elevated,
-- a member of melarc_owner (MIGRATION_AND_SEEDING.md section 5.1). It changes no table, column, policy or function: it calls the
-- bundle-change primitive of 0017 on the three seeded staff bundles that hold the key.
--
--   * Why a migration and not only the seed. The reference seed fills an empty database once and refuses a database that holds a row
--     (MIGRATION_AND_SEEDING.md section 4), so a database seeded before this can never be seeded again. What the seed now writes for a
--     new database (tools/seed/bundles.ts, NOTIFICATION_READ_GRANTS) a seeded one gets here, once. test/database/slice-001-grants.db.test.ts
--     holds the two to the same result: a database seeded earlier and then migrated holds exactly the grants a new seed writes.
--   * Only an addition, and only where the key is granted. `notification.read` is a key of the catalogue since the first seed (it is
--     already a row of `permission`); this adds it to Ops Staff, Senior Ops and Platform Admin at their own hub, as the catalogue says.
--     Each bundle's new content is the grants it holds now plus the row below that it does not hold yet, so no grant is removed or
--     changed, the primitive reads the change as an ADDITION (the revision rises, the floor does not) and no session is ended: a session
--     issued before this keeps the snapshot it was issued with and a sign-in after it carries the new key (OB-S1-03). Finance, the
--     Rider and the Vendor are not touched (their revisions do not move), and neither is the fixed Vendor and Rider policy.
--   * Only where there is something to add. On a database that has not been seeded the permission and bundle tables are empty and
--     there is nothing to add to: the seed writes the whole content there, and this does nothing. Where the content is already held (a
--     database seeded after this, or this run twice) the primitive answers NONE and writes nothing.
--   * The labels and the locks are those of 0043: the migration reads the bundles under policy_change, puts back what it found, and
--     locks every bundle first in the canonical order of lock_policy_keys (SECURITY_DESIGN.md section 13.10a).
--
-- A Platform Admin created by the bootstrap has no primary hub, so its own-hub grant reaches no hub; the owner's two administrators
-- have the Accra hub as their home hub since 29 October 2026 and read its log.

DO $notification_read_grant$
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
    ARRAY[]::text[]
  );

  PERFORM pg_catalog.set_config('melarc.principal_type', 'SYSTEM', true);
  PERFORM pg_catalog.set_config('melarc.task_capability', 'policy_change', true);
  FOR seeded_bundle IN
    SELECT b.id, b.audience FROM public.role_bundle AS b ORDER BY b.id
  LOOP
    WITH added(bundle_id, permission_key, hub_scope, ownership_scope, tier) AS (
      VALUES
        ('5eed0001-0000-4000-8000-000000000001'::uuid, 'notification.read', 'own', 'any', 'A'),
        ('5eed0001-0000-4000-8000-000000000002'::uuid, 'notification.read', 'own', 'any', 'S'),
        ('5eed0001-0000-4000-8000-000000000003'::uuid, 'notification.read', 'own', 'any', 'P')
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

    outcome := melarc.change_role_bundle(seeded_bundle.id, NULL, merged, 'release-slice-001#notification-read');
    IF outcome->>'kind' NOT IN ('ADDITION', 'NONE') THEN
      RAISE EXCEPTION 'the notification.read grant only adds: the primitive answered % for a bundle', outcome->>'kind'
        USING ERRCODE = '55000';
    END IF;
  END LOOP;

  PERFORM pg_catalog.set_config('melarc.principal_type', previous_type, true);
  PERFORM pg_catalog.set_config('melarc.task_capability', previous_capability, true);
END
$notification_read_grant$;
