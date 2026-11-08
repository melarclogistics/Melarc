-- F02 of the audit of 22 October 2026, forward-only: the facts of a staff identity's second factor, for the staff reads (S0.35) and for
-- the reset rule (S0.37), read in one place. Nothing an earlier migration created is amended. Applied as melarc_migration_elevated.
--
-- THE MECHANISM, STATED BEFORE THE FUNCTION (the audit asks for it first).
--
-- Why a function at all. The factor, the grant and the delivery job are tables that only the `authentication` capability reads (their
-- policies name it and nothing else), and a staff context must never be handed a row of them. The second-factor state a staff read
-- returns (`mfa_enrolled`, `mfa_reset_state`) is derived from them. Until now the read made a second transaction under that capability
-- after the identity read: two pictures of the data, a row the second could not find silently dropped from a list, and an ETag that
-- counted only some of what the posture is made of. Reading the facts needs the capability; reading them for **an identity the caller's
-- scope shows**, in **the caller's own snapshot**, needs the function below to hold both.
--
--   1. WHO MAY CALL. The API's login alone (EXECUTE is revoked from PUBLIC and granted to melarc_api_runtime only), and then only (a) a
--      STAFF context whose authorization key is `staff.read` (the guard sets it from the grant that authorizes the operation, as the
--      identity policy of 0024 relies on) in a **REPEATABLE READ or SERIALIZABLE** transaction, or (b) the `authentication` capability
--      itself, which already reads all of it, at any isolation (the reset takes the identity's lock and reads under it). Anything else
--      is refused (42501): a Senior Ops session for another operation, a Vendor, a Rider, another capability. A staff context at READ
--      COMMITTED is refused (25000): each statement of the function would then see what was committed when it began, and the facts of a
--      page would not be one state.
--   2. WHICH IDENTITIES. The function reads `staff_identity` **first, in the caller's context** (the owner role that runs it is subject
--      to forced row-level security, whose policies are written on the transaction's settings and not on the role): so it learns which of
--      the named identifiers the caller's scope shows (the hubs of `staff_identity_staff_read`, every one under the all-hub scope, or
--      all of them for the `authentication` capability), and nothing else is read. An identifier outside the scope, or that matches no
--      row, is **absent from the answer**: the function can neither confirm that a record outside the scope exists nor widen the scope.
--   3. WHAT IT READS AND RETURNS. Only for those identities, and only after it has switched this transaction's context to SYSTEM and
--      `authentication` (the pattern of 0005, 0017 and 0019: the two settings are saved, set transaction-locally, and restored to what
--      they were before the function returns, so the caller leaves in the context it came in). It returns a closed list of **facts**:
--      the status, the origin, whether the bundle is privileged, whether a credential is established, whether an ACTIVE or a PENDING
--      factor exists, whether a usable enrolment grant exists, whether a delivery attempt of such a grant is pending, and how the latest
--      factor ended (by an administrator, with an episode). It never returns a credential hash, a secret, a token, a counter or the
--      identifier of a grant, a job or a factor.
--   4. ONE PICTURE, ONE INSTANT. The statements of the function read the snapshot of the transaction the staff read opened (the
--      identity rows, the visible set and every fact come from it: REPEATABLE READ), and a grant's expiry is judged at **one instant**,
--      the database's clock read once at the start of the call, for every identity of the page. A grant that lapses between two rows
--      of a page cannot make one usable and the next not.
--   5. WHAT IT LEAVES TO ITS CALLERS. The decision (`decideMfaResetState`) stays in the application, in one rule, for the screen and the
--      operation alike. The ETag of a staff identity is computed by the application from the representation the read returns and the
--      identity's `version`; a mutation that takes `If-Match` must compare it **under the identity's lock, recomputed from this same
--      function in that transaction** (obligation recorded for S0.36 and S0.37 in plan 7.33). No lock is taken here.
CREATE FUNCTION melarc.staff_reset_facts(p_ids uuid[])
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
