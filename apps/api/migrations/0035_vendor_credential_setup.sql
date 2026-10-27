-- S0.47b (`reissueVendorCredentialSetup`, `completeVendorCredentialSetup`), forward-only: nothing an earlier migration created is amended.
-- Applied as melarc_migration_elevated.
--
-- THE RE-ISSUE runs in the caller's own staff context under `vendor.organization.approve` (Senior Ops or Platform Admin, own hub), the
-- mechanism of migration 0029 for the staff approver: `melarc.vendor_locked_facts` (migration 0034) locks the credential of an account the
-- caller's scope shows and binds the transaction to it (`melarc.locked_vendor_account`), and the arms below admit the key's act on that
-- account and nothing else:
--   * setup_grant: read and end (`SUPERSEDED`, `EXPIRED`) a `PENDING` `VENDOR_CREDENTIAL_SETUP` grant of the locked account, and insert one
--     in the caller's own name, with no episode, no continuation and no attestation. It consumes nothing (the vendor's act, under
--     `authentication`). The arms name no other table: the delivery worker reads this one and holds no privilege on the vendor tables.
--   * credential_delivery_job: queue the `SETUP_GRANT` message of a pending grant the caller issued to the locked account, untouched as
--     every issuer's starts; read and cancel the locked account's live setup messages. The job table keeps its one guard.
-- THE GRANTS A VENDOR CAN USE, for every writer (the authentication capability included): a vendor grant names an account that exists,
-- is `ACTIVE`, and whose organisation is `ACTIVE`; a `VENDOR_CREDENTIAL_SETUP` grant is for an account that holds **no secret** (the guard
-- of the re-issue, and of the setup that consumes it: replacing a secret is a recovery's act), and a `VENDOR_DEVICE_ENROLMENT` grant is for
-- one that holds a secret (a browser joins an account that can sign in). The guard reads the vendor tables under the authentication
-- capability, with the writer's own privileges (the columns it reads are the runtime's to read: the moment a secret was set, never the
-- secret), and puts the writer's context back before it returns.
-- THE SETUP is the authentication capability's: consuming the grant, writing the first secret and registering the browser are the arms of
-- migrations 0018 and 0034.

CREATE POLICY "setup_grant_vendor_approver_select" ON "setup_grant" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_setting('melarc.authorization_key', true) = 'vendor.organization.approve'
      AND principal_type = 'VENDOR'
      AND purpose = 'VENDOR_CREDENTIAL_SETUP'
      AND principal_id = nullif(current_setting('melarc.locked_vendor_account', true), '')::uuid
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "setup_grant_vendor_approver_insert" ON "setup_grant" FOR INSERT WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_setting('melarc.authorization_key', true) = 'vendor.organization.approve'
      AND state = 'PENDING'
      AND principal_type = 'VENDOR'
      AND purpose = 'VENDOR_CREDENTIAL_SETUP'
      AND issued_by = melarc.current_principal_id()
      AND episode_id IS NULL
      AND continued_from_grant_id IS NULL
      AND attestation_challenge_hash IS NULL
      AND consumed_at IS NULL
      AND principal_id = nullif(current_setting('melarc.locked_vendor_account', true), '')::uuid
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "setup_grant_vendor_approver_update" ON "setup_grant" FOR UPDATE USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_setting('melarc.authorization_key', true) = 'vendor.organization.approve'
      AND principal_type = 'VENDOR'
      AND purpose = 'VENDOR_CREDENTIAL_SETUP'
      AND state = 'PENDING'
      AND principal_id = nullif(current_setting('melarc.locked_vendor_account', true), '')::uuid
    ELSE false
  END
) WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_setting('melarc.authorization_key', true) = 'vendor.organization.approve'
      AND state IN ('SUPERSEDED', 'EXPIRED')
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "credential_delivery_job_vendor_approver_insert" ON "credential_delivery_job" FOR INSERT WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_setting('melarc.authorization_key', true) = 'vendor.organization.approve'
      AND kind = 'SETUP_GRANT'
      AND redemption_record_type = 'SETUP_GRANT'
      AND principal_type = 'VENDOR'
      AND state = 'QUEUED'
      AND attempt_count = 0
      AND deferred_claims = 0
      AND lease_version = 0
      AND lease_owner IS NULL
      AND lease_expires_at IS NULL
      AND outcome_class IS NULL
      AND accepted_at IS NULL
      AND principal_id = nullif(current_setting('melarc.locked_vendor_account', true), '')::uuid
      AND EXISTS (SELECT 1 FROM setup_grant g
                   WHERE g.id = credential_delivery_job.redemption_record_id AND g.principal_type = 'VENDOR'
                     AND g.principal_id = credential_delivery_job.principal_id AND g.purpose = 'VENDOR_CREDENTIAL_SETUP'
                     AND g.state = 'PENDING' AND g.issued_by = melarc.current_principal_id())
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "credential_delivery_job_vendor_approver_select" ON "credential_delivery_job" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_setting('melarc.authorization_key', true) = 'vendor.organization.approve'
      AND kind = 'SETUP_GRANT'
      AND redemption_record_type = 'SETUP_GRANT'
      AND principal_type = 'VENDOR'
      AND principal_id = nullif(current_setting('melarc.locked_vendor_account', true), '')::uuid
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "credential_delivery_job_vendor_approver_cancel" ON "credential_delivery_job" FOR UPDATE USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_setting('melarc.authorization_key', true) = 'vendor.organization.approve'
      AND kind = 'SETUP_GRANT'
      AND redemption_record_type = 'SETUP_GRANT'
      AND principal_type = 'VENDOR'
      AND state IN ('QUEUED', 'LEASED', 'RETRYABLE')
      AND principal_id = nullif(current_setting('melarc.locked_vendor_account', true), '')::uuid
    ELSE false
  END
) WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_setting('melarc.authorization_key', true) = 'vendor.organization.approve'
      AND state = 'CANCELLED'
    ELSE false
  END
);
--> statement-breakpoint

CREATE FUNCTION melarc.setup_grant_vendor_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  previous_type text := coalesce(pg_catalog.current_setting('melarc.principal_type', true), '');
  previous_capability text := coalesce(pg_catalog.current_setting('melarc.task_capability', true), '');
  account_status text;
  organization_status text;
  established boolean;
BEGIN
  IF NEW.principal_type IS DISTINCT FROM 'VENDOR' THEN
    RETURN NEW;
  END IF;
  -- The vendor tables are read as the authentication capability reads them, and the caller's context is put back at once.
  PERFORM pg_catalog.set_config('melarc.principal_type', 'SYSTEM', true);
  PERFORM pg_catalog.set_config('melarc.task_capability', 'authentication', true);
  SELECT a.status, o.operational_status, (c.credential_established_at IS NOT NULL)
    INTO account_status, organization_status, established
    FROM public.vendor_account AS a
    JOIN public.vendor_organization AS o ON o.id = a.vendor_organization_id
    JOIN public.vendor_credential AS c ON c.vendor_account_id = a.id
   WHERE a.id = NEW.principal_id;
  PERFORM pg_catalog.set_config('melarc.principal_type', previous_type, true);
  PERFORM pg_catalog.set_config('melarc.task_capability', previous_capability, true);

  IF account_status IS NULL THEN
    RAISE EXCEPTION 'a vendor grant is issued to a vendor account' USING ERRCODE = '23514';
  END IF;
  IF account_status <> 'ACTIVE' OR organization_status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'a vendor grant is issued to an active account of an active organisation' USING ERRCODE = '23514';
  END IF;
  IF NEW.purpose = 'VENDOR_CREDENTIAL_SETUP' AND established THEN
    RAISE EXCEPTION 'a vendor setup grant is issued to an account with no secret: replacing one is a recovery' USING ERRCODE = '23514';
  END IF;
  IF NEW.purpose = 'VENDOR_DEVICE_ENROLMENT' AND NOT established THEN
    RAISE EXCEPTION 'a vendor browser grant is issued to an account that holds a secret' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.setup_grant_vendor_guard() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.setup_grant_vendor_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "setup_grant_vendor_guard" BEFORE INSERT ON "setup_grant"
  FOR EACH ROW EXECUTE FUNCTION melarc.setup_grant_vendor_guard();
