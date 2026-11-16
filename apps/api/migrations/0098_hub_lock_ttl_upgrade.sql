-- The audit of 15 November 2026, point 3: the receive lock's idle time for a hub that was configured before the setting existed. Forward of 0097; nothing earlier is edited. This migration is applied as
-- melarc_migration_elevated, a member of melarc_owner (MIGRATION_AND_SEEDING.md section 5.1). No table, column, policy or grant changes: it adds rows of data to a table, and only where a hub has none.
--
-- THE DEFECT. A hub's configuration is seeded once (melarc.seed_hub_configuration refuses a second run, 0042), and `intake_lock_idle_ttl_minutes` was added to the plan after some databases had been seeded
-- (S1.32, 0093). `melarc.intake_lock_idle_ttl_minutes` answers NULL for a hub that has no row for it, and a hub with no usable idle time offers no takeover at all (0093, the guard): on such a database the
-- lock of a receiver who has left stays theirs for ever, and the indicator of who is counting never clears. A fresh database is seeded from the current plan and behaves correctly, which is why no test saw it.
--
-- THE UPGRADE. Every hub that already has configuration (a row of hub_setting) and no row for this key in its company-wide scope is given the approved value, fifteen minutes, as version 1 of that key:
-- the Product Owner's development value of 29 October 2026 (D-13), the value of the seed's plan (src/tools/seed/hub-configuration.ts, held to this file by test/database/hub-lock-ttl-upgrade.db.test.ts).
--   * EXPLICIT CONFIGURATION IS PRESERVED. A hub that has any row of its own for the key in that scope, a usable value or not, is left exactly as it is: nothing is invented over a decision, and an unusable
--     value stays the owner's to correct with a new version (a row of this table is never changed in place: the trigger of 0042).
--   * A HUB WITH NO CONFIGURATION AT ALL IS LEFT WITHOUT ANY. The seed refuses unless the hub's configuration tables are empty, so a row given to a hub before its seed would make the seed fail; such a hub
--     is seeded from the plan, which holds the key. On a database that is migrated before it is seeded, this migration therefore writes nothing.
--   * THE ROW IS THE SYSTEM'S, as the seed's is: `created_by` is the reserved system actor and `effective_from` the migration's own time.
--
-- hub_setting is forced row-level security, written only by the seed (policy: SYSTEM under the seed capability). The migration states that context for its own statement, as melarc.seed_hub_configuration
-- does, and puts back what it found, because the run is one transaction.
DO $$
DECLARE
  previous_type text := coalesce(pg_catalog.current_setting('melarc.principal_type', true), '');
  previous_capability text := coalesce(pg_catalog.current_setting('melarc.task_capability', true), '');
BEGIN
  PERFORM pg_catalog.set_config('melarc.principal_type', 'SYSTEM', true);
  PERFORM pg_catalog.set_config('melarc.task_capability', 'seed', true);

  INSERT INTO public.hub_setting (id, hub_id, setting_key, scope_ref, version, value, unit, effective_from, created_by)
    SELECT pg_catalog.gen_random_uuid(), h.id, 'intake_lock_idle_ttl_minutes', '', 1, '15'::jsonb, 'minutes',
           pg_catalog.transaction_timestamp(), melarc.reserved_system_actor_id()
      FROM public.hub AS h
     WHERE EXISTS (SELECT 1 FROM public.hub_setting AS any_setting WHERE any_setting.hub_id = h.id)
       AND NOT EXISTS (
         SELECT 1 FROM public.hub_setting AS own
          WHERE own.hub_id = h.id AND own.setting_key = 'intake_lock_idle_ttl_minutes' AND own.scope_ref = ''
       );

  PERFORM pg_catalog.set_config('melarc.principal_type', previous_type, true);
  PERFORM pg_catalog.set_config('melarc.task_capability', previous_capability, true);
END
$$;
