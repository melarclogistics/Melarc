-- S0.37 (`listSessions`, `revokeSession`, `resetStaffMfa`), forward-only: nothing an earlier migration created is amended except the
-- function `melarc.staff_locked_facts` of 0029, which is replaced to admit one more key (the function is this batch's own, and a
-- `CREATE OR REPLACE` keeps its owner, its grants and its callers). Applied as melarc_migration_elevated.
--
-- THE MECHANISM IS THE ONE OF 0029 (read its header first): the operation runs in the caller's own staff context, at READ COMMITTED, under
-- the shared policy locks of `OperationRunner.mutate`, and every row only the `authentication` capability reached is admitted to **the
-- authorization key of the operation**, bound to a target the caller's scope shows and to the exact shape of the act. The grant and the
-- delivery job are read and changed only for the identity the operation has locked (`melarc.locked_identity`, set by
-- `melarc.staff_locked_facts`): the delivery worker reads those two tables and has no privilege on `staff_identity`, so the policies of
-- those commands name no other table (see the header of 0029, part 1). Here the keys are:
--
--   * `staff.mfa.reset` (Platform Admin, all hubs) for `resetStaffMfa`: it reads and locks the identity its scope shows (and changes none),
--     reads the target's factors and revokes one administratively (the one statement that writes the revocation episode, with the
--     administrator named), reads and ends the target's pending enrolment and re-enrolment grants, issues one `MFA_REENROLMENT` grant that
--     carries the reset episode, queues its message (kind `MFA_REENROLMENT`), and ends the target's live sessions with `MFA_RESET`. It
--     creates no factor and no session: there is no insert arm on `mfa_factor` or `session` for any administrator.
--   * `staff.session.revoke` (Platform Admin for staff and vendors, Senior Ops for riders; the tier is the application's, read from the
--     session's own principal type) for `revokeSession`: it reads the sessions its scope reaches and ends one of them with `ADMIN_REVOKED`.
--   * `staff.read` for `listSessions`: it reads the same sessions, and writes none.
--   The scope of a session is the hubs it was issued for (`authorized_hub_ids`: a staff member's or a rider's hubs; a vendor's session has
--   none and no hub-scoped boundary): a caller reaches a session whose hubs it shares, or every session under the all-hub scope. A session
--   that is not reached is not seen at all: the answer is `NOT_FOUND`, and `HUB_SCOPE_VIOLATION` for a staff session of another hub waits
--   for the probe that a record with several hubs does not have (a finding of the plan, section 7.34).
--   The facts a mutation reads under the identity's lock (0029): `melarc.staff_locked_facts` now admits `staff.mfa.reset` as well as
--   `staff.identity.approve`; nothing else about it changes (one identity, READ COMMITTED, the caller's scope, the closed facts).

-- The identity the reset acts on: read and locked in the caller's scope, changed never (the check of the update arm is false).
CREATE POLICY "staff_identity_resetter_read" ON "staff_identity" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_setting('melarc.authorization_key', true) = 'staff.mfa.reset'
      AND (melarc.hub_scope_mode() = 'ALL' OR primary_hub_id = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "staff_identity_resetter_lock" ON "staff_identity" FOR UPDATE USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_setting('melarc.authorization_key', true) = 'staff.mfa.reset'
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
-- The target's factors: seen, and ended by an administrator as the table allows it (status, administrator, reason and episode together),
-- for the identity the reset has locked and no other (the adversarial review of 23 October 2026: a subquery on the scope reached every
-- identity the caller could see).
CREATE POLICY "mfa_factor_resetter_select" ON "mfa_factor" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_setting('melarc.authorization_key', true) = 'staff.mfa.reset'
      AND staff_identity_id = nullif(current_setting('melarc.locked_identity', true), '')::uuid
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "mfa_factor_resetter_update" ON "mfa_factor" FOR UPDATE USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_setting('melarc.authorization_key', true) = 'staff.mfa.reset'
      AND status IN ('PENDING', 'ACTIVE')
      AND staff_identity_id = nullif(current_setting('melarc.locked_identity', true), '')::uuid
    ELSE false
  END
) WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_setting('melarc.authorization_key', true) = 'staff.mfa.reset'
      AND status = 'REVOKED'
      AND revoked_by = melarc.current_principal_id()
      AND revocation_reason_code IS NOT NULL
      AND revocation_episode_id IS NOT NULL
    ELSE false
  END
);
--> statement-breakpoint
-- The target's enrolment and re-enrolment grants: seen and ended; one re-enrolment grant issued, carrying the episode of the reset. The arms
-- that read or change a row are bound to the identity the operation has locked (`melarc.locked_identity`, set by
-- `melarc.staff_locked_facts`) and name no other table, because the delivery worker reads these two tables and has no privilege on
-- `staff_identity`; the arms that insert judge the target itself, as in 0029 (see the header there, part 1).
CREATE POLICY "setup_grant_resetter_select" ON "setup_grant" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_setting('melarc.authorization_key', true) = 'staff.mfa.reset'
      AND principal_type = 'STAFF'
      AND purpose IN ('MFA_ENROLMENT', 'MFA_REENROLMENT')
      AND principal_id = nullif(current_setting('melarc.locked_identity', true), '')::uuid
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "setup_grant_resetter_insert" ON "setup_grant" FOR INSERT WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_setting('melarc.authorization_key', true) = 'staff.mfa.reset'
      AND state = 'PENDING'
      AND principal_type = 'STAFF'
      AND purpose = 'MFA_REENROLMENT'
      AND issued_by = melarc.current_principal_id()
      AND episode_id IS NOT NULL
      AND continued_from_grant_id IS NULL
      AND attestation_challenge_hash IS NULL
      AND consumed_at IS NULL
      AND principal_id = nullif(current_setting('melarc.locked_identity', true), '')::uuid
      AND EXISTS (SELECT 1 FROM staff_identity i JOIN role_bundle b ON b.id = i.role_bundle_id
                   WHERE i.id = setup_grant.principal_id AND i.id <> melarc.current_principal_id()
                     AND i.status IN ('ACTIVE', 'SUSPENDED') AND i.credential_generation > 0 AND b.privileged)
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "setup_grant_resetter_update" ON "setup_grant" FOR UPDATE USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_setting('melarc.authorization_key', true) = 'staff.mfa.reset'
      AND principal_type = 'STAFF'
      AND purpose IN ('MFA_ENROLMENT', 'MFA_REENROLMENT')
      AND state = 'PENDING'
      AND principal_id = nullif(current_setting('melarc.locked_identity', true), '')::uuid
    ELSE false
  END
) WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_setting('melarc.authorization_key', true) = 'staff.mfa.reset'
      AND state IN ('SUPERSEDED', 'EXPIRED')
    ELSE false
  END
);
--> statement-breakpoint
-- The message of the re-enrolment grant: queued for the locked identity and for a pending grant the caller issued to it, read and cancelled
-- for the locked identity's.
CREATE POLICY "credential_delivery_job_resetter_insert" ON "credential_delivery_job" FOR INSERT WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_setting('melarc.authorization_key', true) = 'staff.mfa.reset'
      AND kind = 'MFA_REENROLMENT'
      AND redemption_record_type = 'SETUP_GRANT'
      AND principal_type = 'STAFF'
      AND state = 'QUEUED'
      AND attempt_count = 0
      AND deferred_claims = 0
      AND lease_version = 0
      AND lease_owner IS NULL
      AND lease_expires_at IS NULL
      AND outcome_class IS NULL
      AND accepted_at IS NULL
      AND principal_id = nullif(current_setting('melarc.locked_identity', true), '')::uuid
      AND EXISTS (SELECT 1 FROM setup_grant g
                   WHERE g.id = credential_delivery_job.redemption_record_id AND g.principal_type = 'STAFF'
                     AND g.principal_id = credential_delivery_job.principal_id AND g.purpose = 'MFA_REENROLMENT'
                     AND g.state = 'PENDING' AND g.issued_by = melarc.current_principal_id())
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "credential_delivery_job_resetter_select" ON "credential_delivery_job" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_setting('melarc.authorization_key', true) = 'staff.mfa.reset'
      AND kind = 'MFA_REENROLMENT'
      AND redemption_record_type = 'SETUP_GRANT'
      AND principal_type = 'STAFF'
      AND principal_id = nullif(current_setting('melarc.locked_identity', true), '')::uuid
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "credential_delivery_job_resetter_cancel" ON "credential_delivery_job" FOR UPDATE USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_setting('melarc.authorization_key', true) = 'staff.mfa.reset'
      AND kind = 'MFA_REENROLMENT'
      AND redemption_record_type = 'SETUP_GRANT'
      AND principal_type = 'STAFF'
      AND state IN ('QUEUED', 'LEASED', 'RETRYABLE')
      AND principal_id = nullif(current_setting('melarc.locked_identity', true), '')::uuid
    ELSE false
  END
) WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_setting('melarc.authorization_key', true) = 'staff.mfa.reset'
      AND state = 'CANCELLED'
    ELSE false
  END
);
--> statement-breakpoint
-- The sessions of another principal: read for the list and the revocation (the hubs a session was issued for are its scope; a vendor's
-- session has none), and ended with `ADMIN_REVOKED` by the key that revokes. The tier is the application's.
CREATE POLICY "session_administrator_select" ON "session" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_setting('melarc.authorization_key', true) IN ('staff.read', 'staff.session.revoke')
      AND (principal_type = 'VENDOR' OR melarc.hub_scope_mode() = 'ALL' OR authorized_hub_ids && melarc.authorized_hub_ids())
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "session_revoker_update" ON "session" FOR UPDATE USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_setting('melarc.authorization_key', true) = 'staff.session.revoke'
      AND terminated_at IS NULL
      AND (principal_type = 'VENDOR' OR melarc.hub_scope_mode() = 'ALL' OR authorized_hub_ids && melarc.authorized_hub_ids())
    ELSE false
  END
) WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_setting('melarc.authorization_key', true) = 'staff.session.revoke'
      AND terminated_at IS NOT NULL
      AND termination_reason = 'ADMIN_REVOKED'
    ELSE false
  END
);
--> statement-breakpoint
-- The sessions of the identity a reset has locked: seen and ended with `MFA_RESET`. Bound to that identity and not to the scope, so that a
-- reset ends the sessions of the identity it resets and no other, and these policies name no table a login without a privilege on
-- `staff_identity` could not read (the session maintenance worker of the registry reads `session`).
CREATE POLICY "session_resetter_select" ON "session" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_setting('melarc.authorization_key', true) = 'staff.mfa.reset'
      AND principal_type = 'STAFF'
      AND principal_id = nullif(current_setting('melarc.locked_identity', true), '')::uuid
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "session_resetter_update" ON "session" FOR UPDATE USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_setting('melarc.authorization_key', true) = 'staff.mfa.reset'
      AND principal_type = 'STAFF'
      AND terminated_at IS NULL
      AND principal_id = nullif(current_setting('melarc.locked_identity', true), '')::uuid
    ELSE false
  END
) WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_setting('melarc.authorization_key', true) = 'staff.mfa.reset'
      AND terminated_at IS NOT NULL
      AND termination_reason = 'MFA_RESET'
    ELSE false
  END
);
--> statement-breakpoint
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
     OR coalesce(pg_catalog.current_setting('melarc.authorization_key', true), '') NOT IN ('staff.identity.approve', 'staff.mfa.reset') THEN
    RAISE EXCEPTION 'the facts a mutation reads under the identity''s lock are read by staff.identity.approve and staff.mfa.reset alone' USING ERRCODE = '42501';
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
  -- One clock for the grant's expiry, read after the lock (and after any wait for it).
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
                      AND g.purpose IN ('MFA_ENROLMENT', 'MFA_REENROLMENT')
                      AND j.state IN ('QUEUED', 'LEASED', 'RETRYABLE')),
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
