-- S1.7 (SLICE-001; delivery/planning/SLICE-001-IMPLEMENTATION-PLAN.md S1.7; the Product Owner's approval of 29 October 2026, D-05): the 25 codes
-- of the three pickup catalogues (PICKUP_CANCELLATION 12, PICKUP_FAILURE 8, PICKUP_SHORT_COUNT 5; domain-model.md section 3.9) reach a database
-- that was seeded before them. Applied as melarc_migration_elevated, a member of melarc_owner (MIGRATION_AND_SEEDING.md section 5.1).
--
--   * Only a database the reference seed has filled gets them: the seed refuses a database that holds a row, so a database seeded earlier
--     can never be seeded again, and it gets them here, once, under the seed capability (the policy of reason_code admits no other writer),
--     as the seed and migrations 0043 and 0044 do. A database that has not been seeded gets them from the seed, which writes the same rows
--     (tools/seed/workflow-reasons.ts); this does nothing there, and nothing when run again. test/database/pickup-reasons.db.test.ts holds
--     the two to the same rows.
--   * The domains themselves were admitted by migration 0044; nothing about the table changes here.
--   * The rows are generated from tools/seed/workflow-reasons.ts, which seed-data.test.ts holds to the document and to the list the
--     Product Owner approved.

DO $pickup_reason_codes$
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
      ('VENDOR_NO_LONGER_NEEDS_PICKUP', 'PICKUP_CANCELLATION', NULL::text[], 'Vendor no longer needs pickup', false, false, false, false, 'CUSTOMER', false, false, false, true, NULL::text[]),
      ('VENDOR_PARCELS_NOT_READY', 'PICKUP_CANCELLATION', NULL::text[], 'Vendor parcels not ready', false, false, false, false, 'CUSTOMER', false, false, false, true, NULL::text[]),
      ('VENDOR_WRONG_DETAILS', 'PICKUP_CANCELLATION', NULL::text[], 'Vendor wrong details', false, false, false, false, 'CUSTOMER', false, false, false, true, NULL::text[]),
      ('DUPLICATE_REQUEST', 'PICKUP_CANCELLATION', NULL::text[], 'Duplicate request', false, false, false, false, 'CUSTOMER', false, false, false, true, NULL::text[]),
      ('OTHER_CUSTOMER_REASON', 'PICKUP_CANCELLATION', NULL::text[], 'Other customer reason', true, false, false, false, 'CUSTOMER', false, false, false, true, NULL::text[]),
      ('NO_RIDER_AVAILABLE', 'PICKUP_CANCELLATION', NULL::text[], 'No rider available', false, false, false, false, 'MELARC', false, false, false, true, NULL::text[]),
      ('HUB_SYSTEM_FAULT', 'PICKUP_CANCELLATION', NULL::text[], 'Hub system fault', false, false, false, false, 'MELARC', false, false, false, true, NULL::text[]),
      ('INTERNAL_ROUTING_ERROR', 'PICKUP_CANCELLATION', NULL::text[], 'Internal routing error', false, false, false, false, 'MELARC', false, false, false, true, NULL::text[]),
      ('OTHER_MELARC_REASON', 'PICKUP_CANCELLATION', NULL::text[], 'Other melarc reason', true, false, false, false, 'MELARC', false, false, false, true, NULL::text[]),
      ('ROAD_OR_WEATHER_DISRUPTION', 'PICKUP_CANCELLATION', NULL::text[], 'Road or weather disruption', false, false, false, false, 'EXTERNAL', false, false, false, true, NULL::text[]),
      ('GENUINE_EMERGENCY', 'PICKUP_CANCELLATION', NULL::text[], 'Genuine emergency', true, false, false, false, 'EXTERNAL', false, false, false, true, NULL::text[]),
      ('OTHER_EXTERNAL_REASON', 'PICKUP_CANCELLATION', NULL::text[], 'Other external reason', true, false, false, false, 'EXTERNAL', false, false, false, true, NULL::text[]),
      ('VENDOR_NOT_AT_LOCATION', 'PICKUP_FAILURE', NULL::text[], 'Vendor not at location', true, false, true, false, 'CUSTOMER', false, false, false, true, NULL::text[]),
      ('VENDOR_UNREACHABLE_BY_PHONE', 'PICKUP_FAILURE', NULL::text[], 'Vendor unreachable by phone', true, false, true, false, 'CUSTOMER', false, false, false, true, NULL::text[]),
      ('ENTRY_REFUSED_BY_SECURITY', 'PICKUP_FAILURE', NULL::text[], 'Entry refused by security', true, true, false, false, 'EXTERNAL', false, false, false, true, NULL::text[]),
      ('LOCATION_CLOSED', 'PICKUP_FAILURE', NULL::text[], 'Location closed', true, true, false, false, 'EXTERNAL', false, false, false, true, NULL::text[]),
      ('PARCELS_NOT_PACKED', 'PICKUP_FAILURE', NULL::text[], 'Parcels not packed', true, false, false, false, 'CUSTOMER', false, false, false, true, NULL::text[]),
      ('VENDOR_ASKED_TO_COME_BACK_LATER', 'PICKUP_FAILURE', NULL::text[], 'Vendor asked to come back later', true, false, false, false, 'CUSTOMER', false, false, false, true, NULL::text[]),
      ('VENDOR_REFUSED_HANDOVER', 'PICKUP_FAILURE', NULL::text[], 'Vendor refused handover', true, false, false, false, 'CUSTOMER', false, false, false, true, NULL::text[]),
      ('PARCEL_NOT_ACCEPTABLE', 'PICKUP_FAILURE', NULL::text[], 'Parcel not acceptable', true, false, false, false, 'CUSTOMER', false, false, false, true, NULL::text[]),
      ('SOME_PARCELS_NOT_READY', 'PICKUP_SHORT_COUNT', NULL::text[], 'Some parcels not ready', false, false, false, false, 'CUSTOMER', false, false, false, true, NULL::text[]),
      ('VENDOR_HELD_BACK_PARCELS', 'PICKUP_SHORT_COUNT', NULL::text[], 'Vendor held back parcels', true, false, false, false, 'CUSTOMER', false, false, false, true, NULL::text[]),
      ('PARCEL_DAMAGED_OR_UNSAFE', 'PICKUP_SHORT_COUNT', NULL::text[], 'Parcel damaged or unsafe', false, true, false, false, 'CUSTOMER', false, false, false, true, NULL::text[]),
      ('BOOKED_COUNT_WRONG', 'PICKUP_SHORT_COUNT', NULL::text[], 'Booked count wrong', false, false, false, false, 'CUSTOMER', false, false, false, true, NULL::text[]),
      ('VENDOR_DISPUTES_COUNT', 'PICKUP_SHORT_COUNT', NULL::text[], 'Vendor disputes count', true, false, false, false, 'CUSTOMER', false, false, false, true, NULL::text[])
      ) AS v(
        code, domain, valid_checkpoints, label, requires_note, requires_photo, requires_contact_attempt, requires_approval,
        attribution, consumes_delivery_attempt, requires_ops_review, requires_escalation, active, permitted_operations
      )
     WHERE NOT EXISTS (SELECT 1 FROM public.reason_code AS held WHERE held.code = v.code);
  END IF;
  PERFORM pg_catalog.set_config('melarc.principal_type', previous_type, true);
  PERFORM pg_catalog.set_config('melarc.task_capability', previous_capability, true);
END
$pickup_reason_codes$;
