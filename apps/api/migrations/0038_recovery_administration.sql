-- S0.51b (`recoverStaffCredential`, `recoverVendorCredential`), forward-only: nothing an earlier migration created is amended but the one
-- function replaced below. Applied as melarc_migration_elevated.
--
-- AN ADMINISTRATOR'S RECOVERY REQUEST is the Platform Admin's own act, in a STAFF context under the key of the operation
-- (`staff.credential.recover`, `vendor.credential.recover`, both Platform Admin at every hub: permissions.md section 7), as the re-issue of a
-- setup grant is under `staff.identity.approve` (0029) and `vendor.organization.approve` (0035). The arms below admit that context to the
-- recovery requests and the recovery messages **of the principal the operation has locked, and of no other**:
--   * a staff identity: read and locked in the caller's scope (the lock takes the identity row; the check of the update arm is false, so the
--     row never changes), bound by `melarc.locked_identity`, which `melarc.staff_locked_facts` sets once the lock is held (it admits the key
--     from this migration);
--   * a vendor account: bound by `melarc.locked_vendor_account`, which `melarc.vendor_locked_facts` (0034) sets for the key already;
--   * a request: read, and inserted PENDING and unconsumed with the caller as `initiated_by`; never updated by this context (consuming and
--     ending a request are the completion's, under the authentication capability);
--   * a message: queued untouched for a pending request the caller initiated for that principal, and read; never cancelled by this context.
-- The insert guard of 0037 holds an administrator's request to an eligible principal, its registered channel and the cap of two live links,
-- as it holds every writer.

CREATE POLICY "staff_identity_recoverer_read" ON "staff_identity" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_setting('melarc.authorization_key', true) = 'staff.credential.recover'
      AND (melarc.hub_scope_mode() = 'ALL' OR primary_hub_id = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "staff_identity_recoverer_lock" ON "staff_identity" FOR UPDATE USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_setting('melarc.authorization_key', true) = 'staff.credential.recover'
      AND (melarc.hub_scope_mode() = 'ALL' OR primary_hub_id = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
) WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN false
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "recovery_request_recoverer_select" ON "recovery_request" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN
      (current_setting('melarc.authorization_key', true) = 'staff.credential.recover'
        AND principal_type = 'STAFF'
        AND principal_id = nullif(current_setting('melarc.locked_identity', true), '')::uuid)
      OR (current_setting('melarc.authorization_key', true) = 'vendor.credential.recover'
        AND principal_type = 'VENDOR'
        AND principal_id = nullif(current_setting('melarc.locked_vendor_account', true), '')::uuid)
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "recovery_request_recoverer_insert" ON "recovery_request" FOR INSERT WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN state = 'PENDING' AND consumed_at IS NULL AND initiated_by = melarc.current_principal_id()
      AND ((current_setting('melarc.authorization_key', true) = 'staff.credential.recover'
             AND principal_type = 'STAFF'
             AND principal_id = nullif(current_setting('melarc.locked_identity', true), '')::uuid)
        OR (current_setting('melarc.authorization_key', true) = 'vendor.credential.recover'
             AND principal_type = 'VENDOR'
             AND principal_id = nullif(current_setting('melarc.locked_vendor_account', true), '')::uuid))
    ELSE false
  END
);
--> statement-breakpoint
-- The job table keeps its one guard and no trigger of its own (credential-delivery-job.db.test.ts pins both); the job starts untouched, as
-- the insert policy of 0014 requires of every issuer.
CREATE POLICY "credential_delivery_job_recoverer_insert" ON "credential_delivery_job" FOR INSERT WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN kind = 'RECOVERY_LINK'
      AND redemption_record_type = 'RECOVERY_REQUEST'
      AND state = 'QUEUED'
      AND attempt_count = 0
      AND deferred_claims = 0
      AND lease_version = 0
      AND lease_owner IS NULL
      AND lease_expires_at IS NULL
      AND outcome_class IS NULL
      AND accepted_at IS NULL
      AND ((current_setting('melarc.authorization_key', true) = 'staff.credential.recover'
             AND principal_type = 'STAFF'
             AND principal_id = nullif(current_setting('melarc.locked_identity', true), '')::uuid)
        OR (current_setting('melarc.authorization_key', true) = 'vendor.credential.recover'
             AND principal_type = 'VENDOR'
             AND principal_id = nullif(current_setting('melarc.locked_vendor_account', true), '')::uuid))
      AND EXISTS (SELECT 1 FROM recovery_request r
                   WHERE r.id = credential_delivery_job.redemption_record_id
                     AND r.principal_type = credential_delivery_job.principal_type
                     AND r.principal_id = credential_delivery_job.principal_id
                     AND r.state = 'PENDING' AND r.initiated_by = melarc.current_principal_id())
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "credential_delivery_job_recoverer_select" ON "credential_delivery_job" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN kind = 'RECOVERY_LINK'
      AND redemption_record_type = 'RECOVERY_REQUEST'
      AND ((current_setting('melarc.authorization_key', true) = 'staff.credential.recover'
             AND principal_type = 'STAFF'
             AND principal_id = nullif(current_setting('melarc.locked_identity', true), '')::uuid)
        OR (current_setting('melarc.authorization_key', true) = 'vendor.credential.recover'
             AND principal_type = 'VENDOR'
             AND principal_id = nullif(current_setting('melarc.locked_vendor_account', true), '')::uuid))
    ELSE false
  END
);
--> statement-breakpoint
-- `melarc.staff_locked_facts` of 0029, 0030 and 0033, replaced to admit one more key: an administrator's recovery locks the identity first and
-- judges it under the lock. The body is that of 0033 (the latest definition) and only the list of keys (and its message) differ; a
-- `CREATE OR REPLACE` keeps the callers, and the owner and the grants are stated again below, as every replacement of it states them.
CREATE OR REPLACE FUNCTION melarc.staff_locked_facts(p_id uuid)
RETURNS TABLE (
  identity_id uuid,
  status text,
  origin text,
  privileged boolean,
  has_credential boolean,
  has_active_factor boolean,
  has_pending_factor boolean,
  has_usable_grant boolean,
  has_pending_delivery boolean,
  latest_status text,
  latest_revoked_by_admin boolean,
  latest_has_episode boolean
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  previous_type text := coalesce(pg_catalog.current_setting('melarc.principal_type', true), '');
  previous_capability text := coalesce(pg_catalog.current_setting('melarc.task_capability', true), '');
  locked uuid;
  evaluated_at timestamptz;
BEGIN
  IF previous_type <> 'STAFF'
     OR coalesce(pg_catalog.current_setting('melarc.authorization_key', true), '') NOT IN ('staff.identity.approve', 'staff.mfa.reset', 'staff.session.revoke', 'staff.credential.recover') THEN
    RAISE EXCEPTION 'the facts a mutation reads under the identity''s lock are read by staff.identity.approve, staff.mfa.reset, staff.session.revoke and staff.credential.recover alone' USING ERRCODE = '42501';
  END IF;
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'a mutation reads under its locks at read committed, in no other level' USING ERRCODE = '25000';
  END IF;
  IF p_id IS NULL THEN
    RAISE EXCEPTION 'the facts are asked for one staff identity' USING ERRCODE = '22023';
  END IF;

  -- The identity the transaction acts on is none until one is locked in the caller's scope.
  PERFORM pg_catalog.set_config('melarc.locked_identity', '', true);
  -- The identity, in the caller's own context and under the lock: the policies of the key decide whether the scope shows it.
  SELECT i.id INTO locked FROM public.staff_identity AS i WHERE i.id = p_id FOR NO KEY UPDATE;
  IF locked IS NULL THEN
    RETURN;
  END IF;
  -- The binding of the policies of the grant and the delivery job: this identity, which the scope showed and this transaction holds.
  PERFORM pg_catalog.set_config('melarc.locked_identity', locked::text, true);
  -- One clock for the grant's expiry and the message's deadline, read after the lock (and after any wait for it).
  evaluated_at := pg_catalog.clock_timestamp();

  PERFORM pg_catalog.set_config('melarc.principal_type', 'SYSTEM', true);
  PERFORM pg_catalog.set_config('melarc.task_capability', 'authentication', true);

  RETURN QUERY
    SELECT i.id, i.status::text, i.origin::text, b.privileged, (i.credential_established_at IS NOT NULL),
           EXISTS (SELECT 1 FROM public.mfa_factor AS f WHERE f.staff_identity_id = i.id AND f.status = 'ACTIVE'),
           EXISTS (SELECT 1 FROM public.mfa_factor AS f WHERE f.staff_identity_id = i.id AND f.status = 'PENDING'),
           EXISTS (SELECT 1 FROM public.setup_grant AS g
                    WHERE g.principal_type = 'STAFF' AND g.principal_id = i.id
                      AND g.purpose IN ('MFA_ENROLMENT', 'MFA_REENROLMENT') AND g.state = 'PENDING'
                      AND (g.expires_at IS NULL OR g.expires_at > evaluated_at)),
           EXISTS (SELECT 1 FROM public.credential_delivery_job AS j
                     JOIN public.setup_grant AS g ON g.id = j.redemption_record_id
                    WHERE j.redemption_record_type = 'SETUP_GRANT' AND g.principal_type = 'STAFF' AND g.principal_id = i.id
                      AND g.purpose IN ('MFA_ENROLMENT', 'MFA_REENROLMENT') AND g.state = 'PENDING'
                      AND j.state IN ('QUEUED', 'LEASED', 'RETRYABLE') AND j.expires_at > evaluated_at),
           l.status::text, (l.revoked_by IS NOT NULL), (l.revocation_episode_id IS NOT NULL)
      FROM public.staff_identity AS i
      JOIN public.role_bundle AS b ON b.id = i.role_bundle_id
      LEFT JOIN LATERAL (SELECT f.status, f.revoked_by, f.revocation_episode_id
                           FROM public.mfa_factor AS f
                          WHERE f.staff_identity_id = i.id
                          ORDER BY f.ordinal DESC LIMIT 1) AS l ON true
     WHERE i.id = locked;

  PERFORM pg_catalog.set_config('melarc.principal_type', previous_type, true);
  PERFORM pg_catalog.set_config('melarc.task_capability', previous_capability, true);
  RETURN;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.staff_locked_facts(uuid) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.staff_locked_facts(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.staff_locked_facts(uuid) TO melarc_api_runtime;
