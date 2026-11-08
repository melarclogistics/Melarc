-- S1.20 closeout (SLICE-001; the decision of 2 November 2026, the reviewer's recommendation applied on the Product Owner's instruction;
-- contracts/domain-model.md section 3.9, "The PICKUP_CARRYOVER contents are seeded"): the eight codes of the carry-over reason domain reach a
-- database that was seeded before them. The domain itself was admitted by migration 0059; this adds its codes. Applied as
-- melarc_migration_elevated, a member of melarc_owner (MIGRATION_AND_SEEDING.md section 5.1).
--
--   * Only a database the reference seed has filled gets them, as migration 0054 does for the three pickup catalogues: the seed refuses a
--     database that holds a row, so a database seeded earlier can never be seeded again, and it gets them here, once, under the seed
--     capability (the policy of reason_code admits no other writer). A database that has not been seeded gets them from the seed, which writes
--     the same rows (tools/seed/workflow-reasons.ts); this does nothing there, and nothing when run again. test/database/pickup-reasons.db.test.ts
--     holds the two to the same rows.
--   * A code is the primary key of reason_code, so it belongs to one domain. Five of the approved names are codes of PICKUP_CANCELLATION
--     already (ROAD_OR_WEATHER_DISRUPTION, NO_RIDER_AVAILABLE, OTHER_CUSTOMER_REASON, OTHER_MELARC_REASON, OTHER_EXTERNAL_REASON) and carry
--     the prefix CARRYOVER_ here; the prefix is provisional until the Product Owner chooses other names. The label is the approved words.
--   * They explain a carry-over and nothing else: no photo, contact attempt, approval, Ops review or escalation, no checkpoints, no
--     permitted operations, and no delivery attempt consumed (a carry-over never creates a charge or resets the promise it explains).
--   * The rows are generated from tools/seed/workflow-reasons.ts, which seed-data.test.ts holds to the document.

DO $pickup_carryover_reasons$
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
      ('CARRYOVER_ROAD_OR_WEATHER_DISRUPTION', 'PICKUP_CARRYOVER', NULL::text[], 'Road or weather disruption', true, false, false, false, 'EXTERNAL', false, false, false, true, NULL::text[]),
      ('CARRYOVER_NO_RIDER_AVAILABLE', 'PICKUP_CARRYOVER', NULL::text[], 'No rider available', false, false, false, false, 'MELARC', false, false, false, true, NULL::text[]),
      ('RUN_FULL_OR_OUT_OF_TIME', 'PICKUP_CARRYOVER', NULL::text[], 'Run full or out of time', true, false, false, false, 'MELARC', false, false, false, true, NULL::text[]),
      ('VENDOR_ASKED_FOR_LATER_PICKUP', 'PICKUP_CARRYOVER', NULL::text[], 'Vendor asked for a later pickup', true, false, false, false, 'CUSTOMER', false, false, false, true, NULL::text[]),
      ('HUB_OR_SYSTEM_FAULT', 'PICKUP_CARRYOVER', NULL::text[], 'Hub or system fault', true, false, false, false, 'MELARC', false, false, false, true, NULL::text[]),
      ('CARRYOVER_OTHER_CUSTOMER_REASON', 'PICKUP_CARRYOVER', NULL::text[], 'Other customer reason', true, false, false, false, 'CUSTOMER', false, false, false, true, NULL::text[]),
      ('CARRYOVER_OTHER_MELARC_REASON', 'PICKUP_CARRYOVER', NULL::text[], 'Other Melarc reason', true, false, false, false, 'MELARC', false, false, false, true, NULL::text[]),
      ('CARRYOVER_OTHER_EXTERNAL_REASON', 'PICKUP_CARRYOVER', NULL::text[], 'Other external reason', true, false, false, false, 'EXTERNAL', false, false, false, true, NULL::text[])
      ) AS v(
        code, domain, valid_checkpoints, label, requires_note, requires_photo, requires_contact_attempt, requires_approval,
        attribution, consumes_delivery_attempt, requires_ops_review, requires_escalation, active, permitted_operations
      )
     WHERE NOT EXISTS (SELECT 1 FROM public.reason_code AS held WHERE held.code = v.code);
  END IF;
  PERFORM pg_catalog.set_config('melarc.principal_type', previous_type, true);
  PERFORM pg_catalog.set_config('melarc.task_capability', previous_capability, true);
END
$pickup_carryover_reasons$;
