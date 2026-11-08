-- The corrections of 23 October 2026 to S0.36 and S0.37 (F01, F05 and F06), forward-only. Nothing an earlier migration created is edited:
-- 0027, 0029 and 0030 are left as they are, whether or not an environment holds them, and this file replaces what they made. Applied as
-- melarc_migration_elevated.
--
-- WHAT IT DOES, AND WHAT IT DOES NOT CLAIM.
--
--   F01  The administrators' policies of 0030 admit rows of `session` and `mfa_factor`, and the API's login had `SELECT` on every column
--        of both tables, so a statement run in an administrator's context could name the columns that hold a credential (a session's
--        token hash and synchronizer-token hash, the authority snapshot; a factor's sealed seed). The login's `SELECT` is now a **column
--        list without those columns**, in every context; the code that legitimately reads them is the authentication capability, which
--        reads them through two `SECURITY DEFINER` readers (`melarc.session_by_token_hash`, `melarc.mfa_factor_sealed_seed`) that answer
--        a context of the `authentication` capability alone, as `melarc.staff_credential_hash` of 0016 does for the credential hash. The
--        one fact of the snapshot that an administrator's list needs, whether the bundle is privileged (the idle limit of the session's
--        tier), is a generated column `session.privileged`, so the snapshot itself is not read to classify a session.
--
--        THE THREAT BOUNDARY, STATED PLAINLY. The readers decide by `melarc.principal_type()` and `melarc.task_capability()`, which are
--        transaction settings that the API's login can set (it sets them itself to open every transaction). They are therefore **not an
--        unforgeable proof** that the caller is the authentication code: a login that runs arbitrary SQL can set them. What the column
--        list and the readers do is **narrow what a statement can read under the context the runtime currently holds**: an administration
--        query, or a policy that is wider than intended, run in a context that is not authentication's, can no longer select a credential
--        column (a privilege error, not a row) or call a reader (a refusal). They do **not** stop arbitrary SQL: an injection that can run
--        statements of its own can set the same two settings, assert the authentication context and cross this boundary. The runtime
--        context is trusted for this stage; its ability to assert a context is an existing, recorded residual risk (SECURITY_DESIGN.md
--        section 14; plan 7.36), and this migration does not remove it.
--
--   F05  The pending-delivery fact (`has_pending_delivery`) of both facts functions counted any message of a re-enrolment grant that was
--        not finished, whatever the state of the grant and the age of the message. A message left `RETRYABLE` for a grant that had since
--        been superseded, consumed or expired would keep a reset coalescing for ever. A delivery now **qualifies** only while the message
--        is still within its own deadline (`credential_delivery_job.expires_at` has not passed on the database's clock) and the grant it
--        carries is still `PENDING`; a usable grant (`PENDING` and not past its expiry) is unchanged.
--
--   F06  `revokeSession` names a session by its id, and a session carries several hubs, which the one-hub scope probe cannot compare, so an
--        existing session outside the caller's hubs was told as absent. A probe policy for a session (the one expression the lint
--        accepts: `STAFF` and `id = melarc.scope_probe_id()`) lets the probe, and only the probe, read the row of the one id it names;
--        what the probe selects is the hub set, and with the column list above no credential column is readable in any case.

-- F01: the generated fact (the column is declared by drizzle-kit below, from `session.ts`).
ALTER TABLE "session" ADD COLUMN "privileged" boolean GENERATED ALWAYS AS (((bundle_snapshot ->> 'privileged')::boolean)) STORED;--> statement-breakpoint

-- F01: the login reads the columns that are not credentials, and no others, in every context. `INSERT` is unchanged (the store writes the
-- whole row and reads back none of the secret columns), and so is the `UPDATE` of the three columns a session's life changes.
REVOKE SELECT ON "session" FROM melarc_api_runtime;
--> statement-breakpoint
GRANT SELECT ("id", "principal_type", "principal_id", "bundle_id", "bundle_revision", "policy_revision", "authorized_hub_ids", "registered_device_id", "issued_at", "expires_at", "last_activity_at", "terminated_at", "termination_reason", "privileged") ON "session" TO melarc_api_runtime;
--> statement-breakpoint
REVOKE SELECT ON "mfa_factor" FROM melarc_api_runtime;
--> statement-breakpoint
GRANT SELECT ("id", "staff_identity_id", "ordinal", "factor_type", "status", "enrolled_at", "revoked_at", "last_verified_counter", "created_by_purpose", "revoked_by", "revocation_reason_code", "created_episode_id", "revocation_episode_id") ON "mfa_factor" TO melarc_api_runtime;
--> statement-breakpoint

-- F01: the reader of a session for authentication: found by the hash of its token and by nothing else, answered to the authentication
-- capability alone, with the columns a `StoredSession` is made from (the token hash itself is not among them: nothing needs it again).
CREATE FUNCTION melarc.session_by_token_hash(p_token_hash bytea)
RETURNS TABLE (
  id uuid,
  principal_type text,
  principal_id uuid,
  bundle_snapshot jsonb,
  bundle_id uuid,
  bundle_revision integer,
  policy_revision integer,
  authorized_hub_ids uuid[],
  registered_device_id uuid,
  client_root_signal text,
  csrf_token_hash bytea,
  issued_at timestamptz,
  expires_at timestamptz,
  last_activity_at timestamptz,
  terminated_at timestamptz,
  termination_reason text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF melarc.principal_type() IS DISTINCT FROM 'SYSTEM' OR melarc.task_capability() IS DISTINCT FROM 'authentication' THEN
    RAISE EXCEPTION 'a session is read by the hash of its token under the authentication capability alone' USING ERRCODE = '42501';
  END IF;
  IF p_token_hash IS NULL OR pg_catalog.octet_length(p_token_hash) <> 32 THEN
    RETURN;
  END IF;
  RETURN QUERY
    SELECT s.id, s.principal_type, s.principal_id, s.bundle_snapshot, s.bundle_id, s.bundle_revision, s.policy_revision,
           s.authorized_hub_ids, s.registered_device_id, s.client_root_signal, s.csrf_token_hash, s.issued_at, s.expires_at,
           s.last_activity_at, s.terminated_at, s.termination_reason
      FROM public.session AS s
     WHERE s.token_hash = p_token_hash;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.session_by_token_hash(bytea) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.session_by_token_hash(bytea) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.session_by_token_hash(bytea) TO melarc_api_runtime;
--> statement-breakpoint

-- F01: the reader of a factor's sealed seed, to open it in memory for the one verification: the authentication capability alone, one
-- factor by its id, a `PENDING` or `ACTIVE` one (a revoked factor's secret is no longer for anything), and the five columns that seal it.
CREATE FUNCTION melarc.mfa_factor_sealed_seed(p_factor_id uuid)
RETURNS TABLE (
  staff_identity_id uuid,
  secret_ciphertext bytea,
  secret_nonce bytea,
  secret_key_version integer,
  secret_envelope_version integer
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF melarc.principal_type() IS DISTINCT FROM 'SYSTEM' OR melarc.task_capability() IS DISTINCT FROM 'authentication' THEN
    RAISE EXCEPTION 'the sealed seed of a factor is read under the authentication capability alone' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT f.staff_identity_id, f.secret_ciphertext, f.secret_nonce, f.secret_key_version, f.secret_envelope_version
      FROM public.mfa_factor AS f
     WHERE f.id = p_factor_id AND f.status IN ('PENDING', 'ACTIVE');
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.mfa_factor_sealed_seed(uuid) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.mfa_factor_sealed_seed(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.mfa_factor_sealed_seed(uuid) TO melarc_api_runtime;
--> statement-breakpoint

-- F06: the scope probe's policy for a session (SECURITY_DESIGN.md section 14.4b): for a staff context, the row of the one id the probe has
-- named, to `SELECT` and to nothing else (no `UPDATE` or `FOR UPDATE`: a probe predicate in any other policy is refused by the lint).
CREATE POLICY "session_probe" ON "session" FOR SELECT USING (melarc.principal_type() = 'STAFF' AND id = melarc.scope_probe_id());
--> statement-breakpoint

-- F05: the facts of a staff identity's second factor, with a delivery that qualifies only while it can still deliver something. The
-- function of 0027 (the staff reads) and the one of 0030 (the mutations, under the identity's lock) are replaced with the same text
-- except for that one expression; owner, grants and callers are as they were.
CREATE OR REPLACE FUNCTION melarc.staff_reset_facts(p_ids uuid[])
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
  evaluated_at timestamptz := pg_catalog.clock_timestamp();
  visible uuid[];
BEGIN
  IF previous_type = 'STAFF' THEN
    IF coalesce(pg_catalog.current_setting('melarc.authorization_key', true), '') <> 'staff.read' THEN
      RAISE EXCEPTION 'the second-factor facts are read under the authorization of staff.read or the authentication capability alone' USING ERRCODE = '42501';
    END IF;
    IF pg_catalog.current_setting('transaction_isolation') NOT IN ('repeatable read', 'serializable') THEN
      RAISE EXCEPTION 'the second-factor facts of staff identities are read in one snapshot or not at all (repeatable read)' USING ERRCODE = '25000';
    END IF;
  ELSIF previous_type <> 'SYSTEM' OR previous_capability <> 'authentication' THEN
    RAISE EXCEPTION 'the second-factor facts are read under the authorization of staff.read or the authentication capability alone' USING ERRCODE = '42501';
  END IF;
  IF p_ids IS NULL OR pg_catalog.cardinality(p_ids) > 100 THEN
    RAISE EXCEPTION 'the facts are asked for a list of at most 100 staff identities' USING ERRCODE = '22023';
  END IF;

  -- The scope first, in the caller's own context: only identities it is shown.
  SELECT coalesce(pg_catalog.array_agg(i.id), '{}'::uuid[]) INTO visible
    FROM public.staff_identity AS i
   WHERE i.id = ANY (p_ids);

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
           -- A delivery qualifies while it can still deliver: the message is queued, leased or waiting to be retried, it is within its own
           -- deadline on the database's clock, and the grant it carries is still PENDING (a message for a grant that has been
           -- superseded, consumed or marked expired delivers nothing usable and never keeps a reset coalescing).
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
     WHERE i.id = ANY (visible)
     ORDER BY i.id;

  PERFORM pg_catalog.set_config('melarc.principal_type', previous_type, true);
  PERFORM pg_catalog.set_config('melarc.task_capability', previous_capability, true);
  RETURN;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.staff_reset_facts(uuid[]) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.staff_reset_facts(uuid[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.staff_reset_facts(uuid[]) TO melarc_api_runtime;
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
