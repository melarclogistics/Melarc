-- G2 follow-up (P-6): a new credential_delivery_job starts untouched, stated at the database boundary and not left to follow from other
-- constraints. Forward-only: it replaces one CHECK and one policy of migration 0009, and changes no row, grant, guard or index.
--
--   * credential_delivery_job_queued_is_untouched now also says deferred_claims = 0. It was true already, but only because
--     deferred_claims <= attempt_count (0011) and attempt_count = 0 composed; a job that started with a deferral credit would be sent
--     fewer times than the Class 1 schedule allows (the sends so far are attempt_count - deferred_claims), so the constraint that
--     describes a queued job says it itself. Existing rows are untouched: every queued row satisfies it, and none is rewritten.
--   * The insert policy now requires the same of the row it admits. The issuing identity (melarc_api_runtime) holds INSERT on every
--     column, so the policy is what keeps it from starting a job with an attempt, a deferral credit, a lease or an outcome already on
--     it, and the CHECK is the backstop for any writer the policy does not govern. A violation of the policy is reported as 42501,
--     before the constraints are looked at, as the policy's other refusals are.
-- Applied as melarc_migration_elevated.

ALTER TABLE "credential_delivery_job" DROP CONSTRAINT "credential_delivery_job_queued_is_untouched";--> statement-breakpoint
ALTER TABLE "credential_delivery_job" ADD CONSTRAINT "credential_delivery_job_queued_is_untouched" CHECK ("credential_delivery_job"."state" <> 'QUEUED' OR ("credential_delivery_job"."attempt_count" = 0 AND "credential_delivery_job"."deferred_claims" = 0 AND "credential_delivery_job"."lease_version" = 0 AND "credential_delivery_job"."lease_owner" IS NULL AND "credential_delivery_job"."lease_expires_at" IS NULL AND "credential_delivery_job"."outcome_class" IS NULL AND "credential_delivery_job"."accepted_at" IS NULL));--> statement-breakpoint
ALTER POLICY "credential_delivery_job_insert" ON "credential_delivery_job" WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'authentication'
      AND state = 'QUEUED'
      AND attempt_count = 0
      AND deferred_claims = 0
      AND lease_version = 0
      AND lease_owner IS NULL
      AND lease_expires_at IS NULL
      AND outcome_class IS NULL
      AND accepted_at IS NULL
    ELSE false
  END
);
