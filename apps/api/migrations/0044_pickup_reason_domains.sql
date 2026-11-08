-- S1.7 (SLICE-001; delivery/planning/SLICE-001-IMPLEMENTATION-PLAN.md S1.7; the Product Owner's decision D-05 of 29 October 2026): the reason
-- catalogue gains the domains of the pickup operations, and a database seeded before them gains the four reasons of the stop skip. Applied
-- as melarc_migration_elevated, a member of melarc_owner (MIGRATION_AND_SEEDING.md section 5.1).
--
--   * The closed set of domains (the generated statements below) admits PICKUP_CANCELLATION, PICKUP_FAILURE and PICKUP_SHORT_COUNT. The
--     codes of those three are the Product Owner's and none is seeded: an operation that takes a reason of one of them refuses every
--     code (REASON_NOT_ACTIVE) until they are decided (OB-S1-13). The other checks of the table are unchanged and already right for them
--     (no checkpoints, no permitted operations: those belong to RECIPIENT_CONTACT and the identity domains).
--   * The four PICKUP_STOP_SKIP reasons (domain-model.md section 3.9, MSC-DEC-412) are added only to a database the reference seed has
--     filled: the seed refuses a database that holds a row, so a database seeded on 27 October 2026 can never be seeded again, and it
--     gets them here, once, under the seed capability (the policy of reason_code admits no other writer), as the seed and migration 0043
--     do. A database that has not been seeded gets them from the seed, which writes the same rows (tools/seed/workflow-reasons.ts); this
--     does nothing there, and nothing when run again. test/database/pickup-reasons.db.test.ts holds the two to the same rows.
--   * The rows are generated from tools/seed/workflow-reasons.ts, which seed-data.test.ts holds to the document.

ALTER TABLE "reason_code" DROP CONSTRAINT "reason_code_domain_closed";--> statement-breakpoint
ALTER TABLE "reason_code" ADD CONSTRAINT "reason_code_domain_closed" CHECK ("reason_code"."domain" IN ('DELIVERY_FAILURE', 'RECIPIENT_CONTACT', 'PICKUP_STOP_SKIP', 'HANDOFF_FAILURE', 'PICKUP_CANCELLATION', 'PICKUP_FAILURE', 'PICKUP_SHORT_COUNT', 'SESSION_REVOCATION', 'STAFF_PROFILE_REJECTION', 'STAFF_MFA_RESET', 'CREDENTIAL_ADMINISTRATION', 'RIDER_DEVICE_REPLACEMENT', 'RIDER_DEVICE_REVOCATION'));

--> statement-breakpoint
DO $pickup_reasons$
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
      ('RUN_CUT_SHORT', 'PICKUP_STOP_SKIP', NULL::text[], 'Run cut short', false, false, false, false, 'MELARC', false, false, false, true, NULL::text[]),
      ('VENDOR_REQUESTED_SKIP', 'PICKUP_STOP_SKIP', NULL::text[], 'Vendor requested skip', false, false, false, false, 'CUSTOMER', false, false, false, true, NULL::text[]),
      ('LOCATION_INACCESSIBLE', 'PICKUP_STOP_SKIP', NULL::text[], 'Location inaccessible', true, false, false, false, 'EXTERNAL', false, false, false, true, NULL::text[]),
      ('STOP_RAISED_IN_ERROR', 'PICKUP_STOP_SKIP', NULL::text[], 'Stop raised in error', true, false, false, false, 'MELARC', false, false, false, true, NULL::text[])
      ) AS v(
        code, domain, valid_checkpoints, label, requires_note, requires_photo, requires_contact_attempt, requires_approval,
        attribution, consumes_delivery_attempt, requires_ops_review, requires_escalation, active, permitted_operations
      )
     WHERE NOT EXISTS (SELECT 1 FROM public.reason_code AS held WHERE held.code = v.code);
  END IF;
  PERFORM pg_catalog.set_config('melarc.principal_type', previous_type, true);
  PERFORM pg_catalog.set_config('melarc.task_capability', previous_capability, true);
END
$pickup_reasons$;
