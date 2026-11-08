-- S0.49 (`requestAdditionalDeviceGrant`, `completeAdditionalDeviceEnrolment`, `listVendorDevices`, `revokeVendorDevice`), forward-only:
-- nothing an earlier migration created is amended. Applied as melarc_migration_elevated.
--
-- THE VENDOR'S OWN CREDENTIAL ACTS run under the `authentication` capability, holding the vendor session's policy locks (the registry gives a
-- Vendor no write on `SetupGrant`, `CredentialDeliveryJob` or `RegisteredDevice`): the grant, its message, the browser and the ended
-- sessions are that capability's arms of migrations 0016, 0018 and 0034, and the events name the account as their actor. **One thing more
-- is needed, and it is this migration**: `requestAdditionalDeviceGrant` takes an `Idempotency-Key`, whose record is the vendor's own and is
-- kept in the act's transaction, which runs under the capability. The capability may therefore insert, read and complete **the vendor's
-- record of that one operation** (`ON_BEHALF_OPERATIONS` in `idempotency-scope.ts`) and no other row; the record keeps its principal, so no
-- principal is ever given another's saved answer, and the table's guard is unchanged.

CREATE POLICY "idempotency_record_on_behalf_select" ON "idempotency_record" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'authentication'
      AND principal_type = 'VENDOR' AND operation_id = 'requestAdditionalDeviceGrant'
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "idempotency_record_on_behalf_insert" ON "idempotency_record" FOR INSERT WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'authentication'
      AND principal_type = 'VENDOR' AND operation_id = 'requestAdditionalDeviceGrant'
      AND sealed_ciphertext IS NULL
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "idempotency_record_on_behalf_update" ON "idempotency_record" FOR UPDATE USING (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'authentication'
      AND principal_type = 'VENDOR' AND operation_id = 'requestAdditionalDeviceGrant'
    ELSE false
  END
) WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'authentication'
      AND principal_type = 'VENDOR' AND operation_id = 'requestAdditionalDeviceGrant'
      AND sealed_ciphertext IS NULL
    ELSE false
  END
);
