-- The retention cleanup of credential material (S0.19). Applied as melarc_migration_elevated, a member of melarc_owner
-- (MIGRATION_AND_SEEDING.md section 5.1). It creates no table: it gives the delivery worker's capability the one thing the registry
-- allows it on the idempotency record, which is to erase the sealed replay of a record whose window has closed.
--
-- The registry (data-scope-registry.md section 5.2) gives the credential_delivery capability, among its tasks, erase_expired_credential_material,
-- and for the IdempotencyRecord table "UPDATE that erases the sealed columns only". Nothing here deletes a row, and nothing could:
-- no identity holds DELETE on idempotency_record (the registry gives none, and who reclaims a record after idempotency_record_ttl_hours
-- is the Product Owner's decision, plan section 7.14), and none holds it on credential_delivery_job either (the retention of a finished
-- job's metadata is OQ-028, unset).
--
-- Row-level security. A SYSTEM context under credential_delivery:
--   * reads a record that holds a sealed replay or says it held one (the second is needed because PostgreSQL checks the row an UPDATE
--     leaves behind against the SELECT policy: without it the erasure itself would be refused);
--   * updates a record that still holds a sealed replay **whose window has closed** (sealed_expires_at, on the database's clock), into
--     one that holds none and says it held one (WITH CHECK), which is the whole of what it may do. It completes no command in
--     progress, changes no answer, cannot lengthen a window and cannot erase a replay a client may still ask for: the cleanup's own
--     statement keeps to the window, and so does this policy, for any statement the capability sends.
-- Each policy names one capability, so the worker's arm and the issuing capability's (migration 0007) stay separate. The guard trigger
-- of 0007 holds every updater, this one included, to the same rules: a completed record keeps its answer byte for byte, and the sealed
-- fields only go, all together, with the tombstone set in the same update.
--
-- Grants, to the capability role the worker's login inherits (melarc_worker_cap_credential_delivery, 0002): SELECT on the two columns that
-- find a record (its identity and the end of its window), and UPDATE on the six columns an erasure changes. The worker cannot read the
-- sealed bytes, the saved answer or whose record it is, and it can neither insert nor delete.
--
-- The cleanup of delivery jobs needs nothing here: the job table's own policies and grants (0009) already let the worker end a job whose
-- redemption record has ended and erase its payload.

CREATE POLICY "idempotency_record_select_worker" ON "idempotency_record" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'credential_delivery' AND (sealed_ciphertext IS NOT NULL OR replay_unavailable_at IS NOT NULL)
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "idempotency_record_erase" ON "idempotency_record" FOR UPDATE USING (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'credential_delivery' AND sealed_ciphertext IS NOT NULL
      AND sealed_expires_at <= clock_timestamp()
    ELSE false
  END
) WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'credential_delivery' AND sealed_ciphertext IS NULL AND replay_unavailable_at IS NOT NULL
    ELSE false
  END
);
--> statement-breakpoint
GRANT SELECT ("id", "sealed_expires_at") ON "idempotency_record" TO melarc_worker_cap_credential_delivery;
--> statement-breakpoint
GRANT UPDATE ("sealed_ciphertext", "sealed_nonce", "sealed_key_version", "sealed_envelope_version", "sealed_expires_at", "replay_unavailable_at") ON "idempotency_record" TO melarc_worker_cap_credential_delivery;
