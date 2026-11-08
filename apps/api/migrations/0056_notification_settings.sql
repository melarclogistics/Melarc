-- S1.12e (SLICE-001; delivery/planning/SLICE-001-IMPLEMENTATION-PLAN.md S1.12; the Product Owner's pilot figures of 29 October 2026): the three
-- platform settings of the business text messages reach a database that was seeded before them, and the notification lane may read them.
-- Applied as melarc_migration_elevated, a member of melarc_owner (MIGRATION_AND_SEEDING.md section 5.1).
--
--   * The settings (settings.md section 7.8): `sms_enabled`, the one switch that stops every business text, and the two limits of a day,
--     `sms_per_number_daily_limit` (10) and `sms_daily_limit` (500). Only a database the reference seed has filled gets them from here: the
--     seed refuses a database that holds a row, so a database seeded earlier can never be seeded again, and it gets them once, under the seed
--     capability (the policy of setting admits no other writer), as migrations 0043, 0044 and 0054 do. A database that has not been seeded gets
--     them from the seed, which writes the same rows (tools/seed/settings.ts); this does nothing there, and nothing when run again.
--     test/database/notification-settings.db.test.ts holds the two to the same rows.
--   * The lane's read (registry section 5.2, the notification row): the capability reads the three rows and no other row of setting, by a
--     policy that names them, and only the two columns that say what a setting is (the key and the value). The worker's login holds no
--     privilege on setting of its own; the grant is the capability role's. The lane can write nothing of setting.

DO $notification_settings$
DECLARE
  previous_type text := coalesce(pg_catalog.current_setting('melarc.principal_type', true), '');
  previous_capability text := coalesce(pg_catalog.current_setting('melarc.task_capability', true), '');
BEGIN
  PERFORM pg_catalog.set_config('melarc.principal_type', 'SYSTEM', true);
  PERFORM pg_catalog.set_config('melarc.task_capability', 'seed', true);
  IF EXISTS (SELECT 1 FROM public.setting) THEN
    INSERT INTO public.setting (key, scope, value_type, value, unit, description)
    SELECT v.key, v.scope, v.value_type, v.value, v.unit, v.description
      FROM (VALUES
        ('sms_enabled', 'PLATFORM', 'boolean', 'true'::jsonb, 'on/off', 'The global switch of the business text messages the notification lane sends: off holds every text back, and feed entries and credential messages are not affected.'),
        ('sms_per_number_daily_limit', 'PLATFORM', 'integer', '10'::jsonb, 'messages per day', 'The most business texts one number is sent in a day (the UTC day); the next is held back. Pilot figure decided by the Product Owner on 29 October 2026.'),
        ('sms_daily_limit', 'PLATFORM', 'integer', '500'::jsonb, 'messages per day', 'The most business texts all numbers together are sent in a day (the UTC day); the next is held back. Pilot figure decided by the Product Owner on 29 October 2026.')
      ) AS v(key, scope, value_type, value, unit, description)
     WHERE NOT EXISTS (SELECT 1 FROM public.setting AS held WHERE held.key = v.key);
  END IF;
  PERFORM pg_catalog.set_config('melarc.principal_type', previous_type, true);
  PERFORM pg_catalog.set_config('melarc.task_capability', previous_capability, true);
END
$notification_settings$;
--> statement-breakpoint
CREATE POLICY "setting_notification_read" ON "setting" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'notification' AND key IN ('sms_enabled', 'sms_per_number_daily_limit', 'sms_daily_limit')
    ELSE false
  END
);
--> statement-breakpoint
GRANT SELECT ("key", "value") ON "setting" TO melarc_worker_cap_notification;
