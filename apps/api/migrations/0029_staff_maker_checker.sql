-- S0.36 (`createStaffIdentity`, `approveStaffIdentity`, `reissueStaffCredentialSetup`), forward-only: nothing an earlier migration created is
-- amended except the guard function of a table this migration adds a second guard to (it is not touched: a trigger of its own is added).
-- Applied as melarc_migration_elevated.
--
-- THE MECHANISM, STATED BEFORE THE FUNCTION (the brief of 22 October 2026 asks for it first; the plan records it in section 7.34).
--
-- The problem. A staff member who makes, approves or re-issues another person's identity acts on rows that, until now, only the
-- `authentication` capability reached: the identity's status and checker, its setup grant, the message that carries it. The operation
-- must be one transaction under the caller's own authority, at READ COMMITTED, under the shared policy locks of `OperationRunner.mutate`
-- (SECURITY_DESIGN.md section 13.10a), and the caller's scope (the hubs of the grant that authorizes the operation) must decide which
-- identities it reaches. Running it under the `authentication` capability would give it every principal's rows and make the scope the
-- application's to remember (the owner has refused that: plan 7.33, "does not run a staff operation under broad authentication");
-- calling `staff_reset_facts` with another key would spoof `staff.read` (also refused).
--
-- The mechanism, in four parts.
--
--   1. KEYED ARMS. Each table gets a policy of its own whose STAFF arm names **the authorization key of the operation** (the guard sets
--      `melarc.authorization_key` from the grant that authorizes the request, as the policy of 0024 relies on) and the exact shape of the
--      act. The key is the operation's: `staff.identity.create` for the maker, `staff.identity.approve` for the approver and for the
--      re-issue (one key, the same authority exercised again). No other key, and no request without one, reaches the arm.
--        * staff_identity: the maker INSERTs a `PENDING_APPROVAL` profile of origin `MAKER_CHECKER` in its own name, with no checker, in a
--          hub of its scope (or, under the all-hub scope, any or none), naming a bundle of the STAFF audience, and reads back the pending
--          profile it just made and nothing else; the approver reads and locks the identities **its scope shows** and decides a pending one
--          (the new row: ACTIVE or REJECTED, the checker the caller). A guard trigger holds the state machine of state-machines.md 13.3
--          for every writer: a profile is decided once, from `PENDING_APPROVAL`, never reopened; the checker is written once.
--        * setup_grant: the approver reads, ends (`SUPERSEDED`, `EXPIRED`) and inserts a `STAFF_CREDENTIAL_SETUP` grant, only for **the
--          identity it has locked**, and (to insert) only for an identity its scope shows that is `ACTIVE`, of origin `MAKER_CHECKER` and
--          holds no credential, in its own name, with no episode and no lineage but the reissue's. It consumes nothing (the grant's
--          consumption is the person's, under `authentication`).
--        * credential_delivery_job: the approver queues a `SETUP_GRANT` message for the locked identity and for a pending grant it
--          issued to it, in the state a job starts in, reads the jobs of the locked identity (the columns the runtime may read), and
--          cancels a live one.
--      **The arms that read or change a row are bound to the identity the transaction has locked, not to a subquery.** A policy is
--      evaluated by every login that reaches its table with that command, and the delivery worker (three columns of `setup_grant`,
--      `SELECT` and `UPDATE` on the job) has no privilege on `staff_identity`: a policy that read it would be refused to the worker whatever
--      its `CASE` takes (the bootstrap policies of 0019 are pinned to this). So `melarc.staff_locked_facts` (part 3), which locks an
--      identity **in the caller's scope** and in no other case, sets the transaction-local `melarc.locked_identity` to it (and clears it
--      first), and those arms admit only that identity's rows. The arms that INSERT are a command the worker never issues on either table,
--      so they judge the target itself, under the caller's own policies (an identity outside the scope is invisible to them), as well as
--      being bound to the locked identity. A grant, a factor or a job of any other kind, any other purpose, principal type or key is the
--      closed ELSE. The setting is as trustworthy as `melarc.authorization_key` beside it: both are written by the data layer for the
--      request, and the scope itself is decided by the policies of `staff_identity`.
--   2. NO NEW CAPABILITY AND NO ELEVATION. The context stays STAFF throughout. The TypeScript stores (`SetupGrantStore`, the delivery
--      queue) accept a staff context whose key is one of the issuing keys; they do not accept a staff context otherwise, and every
--      other method of them (consumption, a lookup by token) stays the `authentication` capability's.
--   3. THE FACTS A MUTATION READS UNDER THE IDENTITY'S LOCK: `melarc.staff_locked_facts(uuid)`.
--        WHO MAY CALL: the API's login alone (EXECUTE revoked from PUBLIC), and then only a STAFF context whose authorization key is
--        `staff.identity.approve`, in a transaction at **READ COMMITTED** (a mutation never runs at a stricter level: the policy locks and the
--        revalidation after a wait stay READ COMMITTED, SECURITY_DESIGN.md 13.10a). `staff_reset_facts` is not widened: it still admits
--        `staff.read` at REPEATABLE READ and the `authentication` capability, and nothing else.
--        WHICH ROWS: **one** identity, named. The function locks it `FOR NO KEY UPDATE` **in the caller's context** (the policies of the
--        key decide whether the caller's scope shows it; an identity outside the scope, or none, gives no row and the function returns
--        nothing, so it can neither confirm that a record outside the scope exists nor widen the scope). The lock is the identity lock
--        of the order of 13.10a: it is taken here, so that the facts are read under it and no caller can read them without holding it.
--        It also records the identity it locked in `melarc.locked_identity` for the transaction (part 1), and clears the record first.
--        WHAT IT RETURNS: the same closed list of facts as `staff_reset_facts` (status, origin, privileged, credential established, the
--        factor and grant and delivery facts, how the latest factor ended); never a hash, a secret, a token, a counter or the
--        identifier of a grant, a job or a factor. The grant's expiry is judged on one clock read after the lock.
--        HOW: it switches the transaction to SYSTEM and `authentication` to read, and puts the caller's context back before it returns
--        (the pattern of 0005, 0017, 0019 and 0027). The decision stays in the application (`decideMfaResetState`), and so does the
--        comparison of `If-Match`: the application recomputes the ETag from these facts and the identity row, after this call, in the
--        transaction that acts.
--   4. THE DECISIONS OF THE APPLICATION, NOT OF THE DATABASE: the tier (a privileged bundle needs a Platform Admin), the maker-checker
--      refusal order (the maker is last), the reason's branch and the eligibility are the use case's. The database holds what it can
--      state without them: the shapes above, the state machine, and the checker who is not the maker (a constraint of 0016).

-- Columns. The maker writes the profile and nothing of the credential, the counters or the version; the approver's decision changes the
-- status and the checker and nothing else (the bundle cannot be swapped at approval, the hub cannot be moved, the maker cannot be rewritten).
GRANT INSERT ("id", "work_email", "work_email_canonical", "full_name", "phone", "status", "role_bundle_id", "primary_hub_id", "created_by", "origin") ON "staff_identity" TO melarc_api_runtime;
--> statement-breakpoint
GRANT UPDATE ("status", "approved_by") ON "staff_identity" TO melarc_api_runtime;
--> statement-breakpoint
CREATE POLICY "staff_identity_maker_insert" ON "staff_identity" FOR INSERT WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_setting('melarc.authorization_key', true) = 'staff.identity.create'
      AND origin = 'MAKER_CHECKER'
      AND status = 'PENDING_APPROVAL'
      AND approved_by IS NULL
      AND created_by = melarc.current_principal_id()
      AND (melarc.hub_scope_mode() = 'ALL' OR primary_hub_id = ANY (melarc.authorized_hub_ids()))
      AND EXISTS (SELECT 1 FROM role_bundle b WHERE b.id = role_bundle_id AND b.audience = 'STAFF')
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "staff_identity_maker_read" ON "staff_identity" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_setting('melarc.authorization_key', true) = 'staff.identity.create'
      AND origin = 'MAKER_CHECKER'
      AND status = 'PENDING_APPROVAL'
      AND created_by = melarc.current_principal_id()
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "staff_identity_approver_read" ON "staff_identity" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_setting('melarc.authorization_key', true) = 'staff.identity.approve'
      AND (melarc.hub_scope_mode() = 'ALL' OR primary_hub_id = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "staff_identity_approver_update" ON "staff_identity" FOR UPDATE USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_setting('melarc.authorization_key', true) = 'staff.identity.approve'
      AND (melarc.hub_scope_mode() = 'ALL' OR primary_hub_id = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
) WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_setting('melarc.authorization_key', true) = 'staff.identity.approve'
      AND status IN ('ACTIVE', 'REJECTED')
      AND approved_by = melarc.current_principal_id()
      AND (melarc.hub_scope_mode() = 'ALL' OR primary_hub_id = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
);
--> statement-breakpoint
-- The state machine of state-machines.md 13.3, for every writer. A pending profile is decided once (approved or rejected, with its checker);
-- an `ACTIVE` or `SUSPENDED` one may be suspended, reactivated or offboarded (the offboarding slice's acts, which this does not build);
-- `REJECTED` and `OFFBOARDED` are terminal; the checker is written once, with the decision, and never changed. The check that the checker is
-- not the maker is the constraint of 0016. The trigger fires after the guard of 0016 and before the version trigger of 0024 (by name).
CREATE FUNCTION melarc.staff_identity_transition_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.approved_by IS DISTINCT FROM OLD.approved_by AND OLD.approved_by IS NOT NULL THEN
    RAISE EXCEPTION 'the checker of a staff identity is written once, with the decision' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (
         (OLD.status = 'PENDING_APPROVAL' AND OLD.origin = 'MAKER_CHECKER' AND NEW.status IN ('ACTIVE', 'REJECTED') AND NEW.approved_by IS NOT NULL)
      OR (OLD.status = 'ACTIVE' AND NEW.status IN ('SUSPENDED', 'OFFBOARDED'))
      OR (OLD.status = 'SUSPENDED' AND NEW.status IN ('ACTIVE', 'OFFBOARDED'))
    ) THEN
      RAISE EXCEPTION 'that change of status is not one the staff identity machine makes' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.approved_by IS DISTINCT FROM OLD.approved_by THEN
    RAISE EXCEPTION 'the checker of a staff identity is written with the decision and with nothing else' USING ERRCODE = '23514';
  END IF;

  -- WHO MAY WRITE WHAT, for the API login (found by the adversarial review of 23 October 2026). The grants of this migration give the login
  -- UPDATE of the status and the checker, and the login already held UPDATE of the credential and its lockout for the authentication
  -- capability; a policy names the key of an operation but cannot name a column, and the policy of the approval has to admit an ACTIVE or
  -- SUSPENDED row (the identity lock of a re-issue needs it). So the guard, which fires for every writer, holds both:
  --   * a STAFF context never writes the credential, its generation or its lockout: they are the authentication capability's;
  --   * the API login changes the status or the checker only in the decision of a pending profile, under the key of the approval, with
  --     the caller as the checker. The `authentication` label, any other key, and a suspension, a reactivation or an offboarding are
  --     refused here; the offboarding slice gives those their own keys and their own clause, in its own migration.
  IF melarc.principal_type() = 'STAFF' AND (
       NEW.credential_hash IS DISTINCT FROM OLD.credential_hash
    OR NEW.credential_established_at IS DISTINCT FROM OLD.credential_established_at
    OR NEW.credential_generation IS DISTINCT FROM OLD.credential_generation
    OR NEW.failed_attempt_count IS DISTINCT FROM OLD.failed_attempt_count
    OR NEW.locked_until IS DISTINCT FROM OLD.locked_until
  ) THEN
    RAISE EXCEPTION 'a staff member does not write the credential of a staff identity or its lockout' USING ERRCODE = '42501';
  END IF;
  IF current_user = 'melarc_api_runtime'
     AND (NEW.status IS DISTINCT FROM OLD.status OR NEW.approved_by IS DISTINCT FROM OLD.approved_by)
     AND NOT (
          melarc.principal_type() = 'STAFF'
      AND coalesce(pg_catalog.current_setting('melarc.authorization_key', true), '') = 'staff.identity.approve'
      AND OLD.status = 'PENDING_APPROVAL'
      AND NEW.approved_by = melarc.current_principal_id()
     ) THEN
    RAISE EXCEPTION 'only the approval decides a pending staff identity, as its checker' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.staff_identity_transition_guard() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.staff_identity_transition_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "staff_identity_transition" BEFORE UPDATE ON "staff_identity"
  FOR EACH ROW EXECUTE FUNCTION melarc.staff_identity_transition_guard();
--> statement-breakpoint
-- The approver's arms on the setup grant and the delivery job. The arms that READ or CHANGE a row are bound to **the identity the operation
-- has locked**; the arms that INSERT judge the target itself.
--   * READ and CHANGE (SELECT, UPDATE) name no other table. A policy is evaluated by every login that reaches its table with that command,
--     and the delivery worker (three columns of `setup_grant`, `SELECT` and `UPDATE` on the job) has no privilege on `staff_identity`: a
--     policy that read it would be refused to the worker whatever its `CASE` takes (the bootstrap policies of 0019 are pinned to this, and
--     so is the worker's claim of a job). The binding is `melarc.locked_identity`, set by `melarc.staff_locked_facts` below in the same
--     transaction once the identity has been locked **in the caller's scope** (an identity the scope does not show is never locked, and the
--     setting is cleared first).
--   * INSERT is a command the worker never issues on either table, so its check may read the target, and does: the identity (or the grant)
--     is judged under the caller's own policies, so one outside the scope is invisible and the write is refused, and it must be of the
--     shape the key allows. It is bound to the locked identity as well, so that no grant or message is made for an identity the operation
--     did not lock.
-- The approver reads and ends only a `PENDING` grant of the one purpose, and only to `SUPERSEDED` or `EXPIRED`: the consumption of a grant
-- is the person's act, under the authentication capability.
CREATE POLICY "setup_grant_approver_select" ON "setup_grant" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_setting('melarc.authorization_key', true) = 'staff.identity.approve'
      AND principal_type = 'STAFF'
      AND purpose = 'STAFF_CREDENTIAL_SETUP'
      AND principal_id = nullif(current_setting('melarc.locked_identity', true), '')::uuid
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "setup_grant_approver_insert" ON "setup_grant" FOR INSERT WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_setting('melarc.authorization_key', true) = 'staff.identity.approve'
      AND state = 'PENDING'
      AND principal_type = 'STAFF'
      AND purpose = 'STAFF_CREDENTIAL_SETUP'
      AND issued_by = melarc.current_principal_id()
      AND episode_id IS NULL
      AND continued_from_grant_id IS NULL
      AND attestation_challenge_hash IS NULL
      AND consumed_at IS NULL
      AND principal_id = nullif(current_setting('melarc.locked_identity', true), '')::uuid
      AND EXISTS (SELECT 1 FROM staff_identity i
                   WHERE i.id = setup_grant.principal_id AND i.status = 'ACTIVE' AND i.origin = 'MAKER_CHECKER' AND i.credential_generation = 0)
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "setup_grant_approver_update" ON "setup_grant" FOR UPDATE USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_setting('melarc.authorization_key', true) = 'staff.identity.approve'
      AND principal_type = 'STAFF'
      AND purpose = 'STAFF_CREDENTIAL_SETUP'
      AND state = 'PENDING'
      AND principal_id = nullif(current_setting('melarc.locked_identity', true), '')::uuid
    ELSE false
  END
) WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_setting('melarc.authorization_key', true) = 'staff.identity.approve'
      AND state IN ('SUPERSEDED', 'EXPIRED')
    ELSE false
  END
);
--> statement-breakpoint
-- The approver's arms on the delivery job: queued for the locked identity and for a pending grant the caller issued to it, read and
-- cancelled for the locked identity's setup message; the job starts untouched, as the insert policy of 0014 requires of every issuer. The
-- job table keeps its one guard and no trigger of its own (credential-delivery-job.db.test.ts pins both).
CREATE POLICY "credential_delivery_job_approver_insert" ON "credential_delivery_job" FOR INSERT WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_setting('melarc.authorization_key', true) = 'staff.identity.approve'
      AND kind = 'SETUP_GRANT'
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
                     AND g.principal_id = credential_delivery_job.principal_id AND g.purpose = 'STAFF_CREDENTIAL_SETUP'
                     AND g.state = 'PENDING' AND g.issued_by = melarc.current_principal_id())
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "credential_delivery_job_approver_select" ON "credential_delivery_job" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_setting('melarc.authorization_key', true) = 'staff.identity.approve'
      AND kind = 'SETUP_GRANT'
      AND redemption_record_type = 'SETUP_GRANT'
      AND principal_type = 'STAFF'
      AND principal_id = nullif(current_setting('melarc.locked_identity', true), '')::uuid
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "credential_delivery_job_approver_cancel" ON "credential_delivery_job" FOR UPDATE USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_setting('melarc.authorization_key', true) = 'staff.identity.approve'
      AND kind = 'SETUP_GRANT'
      AND redemption_record_type = 'SETUP_GRANT'
      AND principal_type = 'STAFF'
      AND state IN ('QUEUED', 'LEASED', 'RETRYABLE')
      AND principal_id = nullif(current_setting('melarc.locked_identity', true), '')::uuid
    ELSE false
  END
) WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_setting('melarc.authorization_key', true) = 'staff.identity.approve'
      AND state = 'CANCELLED'
    ELSE false
  END
);
--> statement-breakpoint
CREATE FUNCTION melarc.staff_locked_facts(p_id uuid)
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
     OR coalesce(pg_catalog.current_setting('melarc.authorization_key', true), '') <> 'staff.identity.approve' THEN
    RAISE EXCEPTION 'the facts a mutation reads under the identity''s lock are read by staff.identity.approve alone' USING ERRCODE = '42501';
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
