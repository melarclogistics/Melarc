-- S0.35 (the staff reads, `listStaffIdentities` and `getStaffIdentity`). The first two statements are the generated part (drizzle-kit, from
-- src/staff/staff-identity.schema.ts); the rest is written by hand and is in this migration so that the columns never exist for a moment
-- without the trigger that moves the version, the grants and the policies. Forward-only: nothing an earlier migration created is amended.
-- Applied as melarc_migration_elevated.
--
--   * `phone` (nullable, as entered) and `version` (the record's ETag, domain-model.md section 6.8). The runtime reads both and updates
--     neither: the version is moved by the database alone, by a BEFORE UPDATE trigger that sets it, whatever the update says, to the next
--     one when something a read of the record returns changed (the name, the work email, the phone, the status, the role bundle, the
--     primary hub, the approver, the establishment or replacement of the credential) and to the same one otherwise. **A failed attempt, a
--     lock and a rehash of the credential at a new cost move nothing**: no read returns them. A factor's enrolment and revocation are rows
--     of another table, and the ETag a read carries adds them (the read counts them), so that no trigger on that table has to write this one
--     past the row-level security that admits only the authentication capability.
--   * `staff_identity_staff_read` admits a STAFF context to read the identities of **the scope of the operation it runs**: only while the
--     authorization key of the transaction is `staff.read` (the guard sets it from the grant that authorizes the operation, and a context
--     that holds another key or none gets nothing from this policy), the identities whose primary hub is among the context's hubs, or every
--     identity (the one with no primary hub included) under the explicit all-hub scope. An empty set of hubs reaches no hub-scoped row.
--     The policy that lets a staff member read its own row (`staff_identity_select`) is unchanged.
--   * `staff_identity_probe` is the scope probe's policy (SECURITY_DESIGN.md section 14.4b): while the probe holds an id, a STAFF context
--     reads that one row, and no other command can change it. The probe reads the hub of the record from `primary_hub_id` (the entity names
--     its hub column).
ALTER TABLE "staff_identity" ADD COLUMN "phone" text;--> statement-breakpoint
ALTER TABLE "staff_identity" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
GRANT SELECT ("phone", "version") ON "staff_identity" TO melarc_api_runtime;
--> statement-breakpoint
CREATE FUNCTION melarc.staff_identity_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.work_email IS DISTINCT FROM OLD.work_email
     OR NEW.work_email_canonical IS DISTINCT FROM OLD.work_email_canonical
     OR NEW.full_name IS DISTINCT FROM OLD.full_name
     OR NEW.phone IS DISTINCT FROM OLD.phone
     OR NEW.status IS DISTINCT FROM OLD.status
     OR NEW.role_bundle_id IS DISTINCT FROM OLD.role_bundle_id
     OR NEW.primary_hub_id IS DISTINCT FROM OLD.primary_hub_id
     OR NEW.approved_by IS DISTINCT FROM OLD.approved_by
     OR NEW.credential_established_at IS DISTINCT FROM OLD.credential_established_at
     OR NEW.credential_generation IS DISTINCT FROM OLD.credential_generation THEN
    NEW.version := OLD.version + 1;
  ELSE
    NEW.version := OLD.version;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.staff_identity_version() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.staff_identity_version() FROM PUBLIC;
--> statement-breakpoint
-- The guard of 0016 fires first (triggers of one event run by name) and refuses what the identity may not change; this one runs after it.
CREATE TRIGGER "staff_identity_version" BEFORE UPDATE ON "staff_identity"
  FOR EACH ROW EXECUTE FUNCTION melarc.staff_identity_version();
--> statement-breakpoint
CREATE POLICY "staff_identity_staff_read" ON "staff_identity" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_setting('melarc.authorization_key', true) = 'staff.read' AND (melarc.hub_scope_mode() = 'ALL' OR primary_hub_id = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "staff_identity_probe" ON "staff_identity" FOR SELECT USING (melarc.principal_type() = 'STAFF' AND id = melarc.scope_probe_id());
