-- D-D5 (the Product Owner, 15 and 16 November 2026): the three codes of the over-count reason domain reach a database that was seeded before them. The domain itself was admitted by migration 0099; this
-- adds its codes, in a file of its own that may be repeated, as migration 0061 does for the carry-over reasons. Applied as melarc_migration_elevated, a member of melarc_owner (MIGRATION_AND_SEEDING.md
-- section 5.1). Forward of 0099; nothing earlier is edited.
--
-- The three over-count reasons reach a database that was seeded before them, as migration 0061 does for the carry-over reasons: only a database the reference seed has filled gets them (the seed refuses a
-- database that holds a row, so one seeded earlier can never be seeded again), once, under the seed capability. A database that has not been seeded gets them from the seed (tools/seed/workflow-reasons.ts),
-- which writes the same rows; this does nothing there, and nothing when run again. A code is the table's primary key and belongs to one domain: the short count's BOOKED_COUNT_WRONG holds one name, so
-- "Booked number was wrong" is OVER_BOOKED_NUMBER_WRONG (provisional until the Product Owner chooses other names). No photo, contact attempt, approval, Ops review or escalation; none consumes an attempt.
DO $pickup_over_count_reasons$
DECLARE
  previous_type text := coalesce(pg_catalog.current_setting('melarc.principal_type', true), '');
  previous_capability text := coalesce(pg_catalog.current_setting('melarc.task_capability', true), '');
BEGIN
  PERFORM pg_catalog.set_config('melarc.principal_type', 'SYSTEM', true);
  PERFORM pg_catalog.set_config('melarc.task_capability', 'seed', true);
  IF EXISTS (SELECT 1 FROM public.reason_code) THEN
    INSERT INTO public.reason_code (
      code, domain, valid_checkpoints, label, requires_note, requires_photo, requires_contact_attempt, requires_approval,
      attribution, consumes_delivery_attempt, requires_ops_review, requires_escalation, active, permitted_operations
    )
    SELECT v.code, v.domain, v.valid_checkpoints, v.label, v.requires_note, v.requires_photo, v.requires_contact_attempt,
           v.requires_approval, v.attribution, v.consumes_delivery_attempt, v.requires_ops_review, v.requires_escalation,
           v.active, v.permitted_operations
      FROM (VALUES
      ('VENDOR_ADDED_PARCELS', 'PICKUP_OVER_COUNT', NULL::text[], 'Vendor added parcels after booking', false, false, false, false, 'CUSTOMER', false, false, false, true, NULL::text[]),
      ('OVER_BOOKED_NUMBER_WRONG', 'PICKUP_OVER_COUNT', NULL::text[], 'Booked number was wrong', false, false, false, false, 'CUSTOMER', false, false, false, true, NULL::text[]),
      ('OVER_OTHER', 'PICKUP_OVER_COUNT', NULL::text[], 'Other', true, false, false, false, 'CUSTOMER', false, false, false, true, NULL::text[])
      ) AS v(
        code, domain, valid_checkpoints, label, requires_note, requires_photo, requires_contact_attempt, requires_approval,
        attribution, consumes_delivery_attempt, requires_ops_review, requires_escalation, active, permitted_operations
      )
     WHERE NOT EXISTS (SELECT 1 FROM public.reason_code AS held WHERE held.code = v.code);
  END IF;
  PERFORM pg_catalog.set_config('melarc.principal_type', previous_type, true);
  PERFORM pg_catalog.set_config('melarc.task_capability', previous_capability, true);
END
$pickup_over_count_reasons$;
