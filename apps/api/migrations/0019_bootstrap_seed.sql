-- The bootstrap seed and the resume command (S0.30). Applied as melarc_migration_elevated, a member of melarc_owner
-- (MIGRATION_AND_SEEDING.md section 5.1). Hand-written: no table changes here, only what the two commands of
-- MIGRATION_AND_SEEDING.md section 3 need, in the shape that 0005 gave the reference seed and 0017 gave the policy change.
--
-- The mechanism, and why it is the smallest that holds:
--
--   * The provisioning login holds no privilege on staff_identity, setup_grant, mfa_factor, session, audit_event or setting, from here
--     as before: the label is not what stops it writing an identity, it has no INSERT to assert the label against. Four SECURITY
--     DEFINER functions, owned by melarc_owner, are the only ways in, and EXECUTE on them is granted to melarc_provisioning alone
--     (revoked from PUBLIC; not the API runtime, not the worker): melarc.bootstrap_status, melarc.seed_bootstrap_administrators,
--     melarc.bootstrap_identity_state and melarc.resume_bootstrap_identity. They take their rows as one JSON document, name every
--     table and column in their own text (no dynamic statement, no object name from the caller), fix their search_path and qualify
--     every table. The registry (data-scope-registry.md section 5.2, `bootstrap`) says the same of the capability as it says of `seed`.
--   * The pair is made once, atomically, serialized: bootstrap_status and the seed take SHARE ROW EXCLUSIVE on staff_identity (it
--     conflicts with itself and with every writer, not with readers), then count, and the seed refuses (SQLSTATE 55000, naming the
--     table and its rows) unless the table is empty. A second seed waits for the first to end, then finds the table filled and
--     refuses; one that failed or was rolled back left nothing, so the next one runs. The function is one statement of the caller's
--     transaction, so a failure at any insert (a constraint, a trigger, the ledger) undoes the identities, the grants and the events
--     together. It runs at read committed only, because a snapshot taken before the wait would count the table as it was before the
--     first seed committed. The identities and the grants and the six events are written in that one statement, so the staff table is
--     never left holding one identity.
--   * The shape of the pair is the function's, and not the document's: the origin (BOOTSTRAP), the status (ACTIVE), the bundle
--     (Platform Admin), the absence of a primary hub (the HQ reach is the bundle's own all-hub grants, MIGRATION_AND_SEEDING.md
--     section 3.2), no credential, and the reserved system actor as both the maker and the checker are written by the function and
--     cannot be named by a caller. What the document supplies is the identifiers, the work emails, the names, the hash of each
--     secret and the audit events, and the function refuses an event that is not one of the six it expects.
--   * The row-level security policies stay the second line (the `bootstrap` branch of each, below): each function sets the SYSTEM
--     context and the bootstrap capability itself, transaction-locally, for its own statements, and puts back what the caller had set.
--     Nothing the caller sets is read as proof. The branches are narrow: the identity insert admits the bootstrap shape and nothing
--     else (GBT-E8), the grant insert a PENDING grant of the two purposes the commands issue, the factor update only the revocation of
--     a PENDING factor with no administrator, the audit insert only the five events the commands write, as SYSTEM and as the
--     catalogue tiers them. A branch holds no subquery on staff_identity: it would be evaluated by every login that reads the table it
--     guards (the delivery worker reads three columns of setup_grant and has no privilege on staff_identity), so that the principal of
--     a grant is one of the two bootstrap identities is checked by the functions, which read the identity under its row lock.
--
-- The resume command (MIGRATION_AND_SEEDING.md section 3.3a) judges the six conditions here, under the identity's row lock
-- (FOR NO KEY UPDATE, the lock the credential operations take, so a setup that races it waits): the origin is BOOTSTRAP (read from
-- the column, never inferred from the actor), the identity is not offboarded, no ACTIVE factor exists (which is conditions 4 and 6:
-- setup is complete once one does), and no session of the identity is live (condition 5); a password established is the path of the
-- re-enrolment (a fresh MFA_REENROLMENT, whose lifetime is the setting recovery_link_ttl_minutes and never a figure of the function's
-- own), and no password is the path of the lost bundle (the unconsumed BOOTSTRAP_SETUP superseded by a new one). A live setup grant
-- other than that one secret makes the identity not stranded yet, and the command refuses until it has lapsed. Nothing is revived: a
-- consumed secret is never presented again, and no session, factor or password is touched.
--
-- Finding for the Product Owner (plan section 7.23): AC-SLICE-000-93 asks for "an enhanced audit record under the reserved system
-- actor" when the command issues a fresh MFA_REENROLMENT, and the catalogue names no event for it. The events written here are the
-- catalogue's own for what the command does: auth.setup_grant.issued (ordinary, and its row already lists the controlled provisioning
-- channel), auth.setup_grant.superseded (ordinary), and auth.mfa.revoked (enhanced) for a stale PENDING factor it revokes. Where it
-- revokes none, no enhanced event is written; naming one is the owner's, and adding it is one more code in the lists below.

CREATE FUNCTION melarc.reserved_system_actor_id() RETURNS uuid LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT '5eed0000-0000-4000-8000-0000000000a1'::uuid
$$;
--> statement-breakpoint
CREATE FUNCTION melarc.bootstrap_bundle_id() RETURNS uuid LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT '5eed0001-0000-4000-8000-000000000003'::uuid
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.reserved_system_actor_id() OWNER TO melarc_owner;
--> statement-breakpoint
ALTER FUNCTION melarc.bootstrap_bundle_id() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.reserved_system_actor_id() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.bootstrap_bundle_id() FROM PUBLIC;
--> statement-breakpoint
-- A policy's expression is evaluated by the login that runs the statement, so the API runtime, which will insert staff identities
-- itself (createStaffIdentity), must be able to call what the insert policy calls, as it calls melarc.task_capability().
GRANT EXECUTE ON FUNCTION melarc.reserved_system_actor_id() TO melarc_api_runtime;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.bootstrap_bundle_id() TO melarc_api_runtime;
--> statement-breakpoint
CREATE POLICY "staff_identity_bootstrap_select" ON "staff_identity" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'bootstrap'
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "staff_identity_bootstrap_insert" ON "staff_identity" FOR INSERT WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'bootstrap' AND origin = 'BOOTSTRAP' AND status = 'ACTIVE' AND created_by = melarc.reserved_system_actor_id() AND approved_by = melarc.reserved_system_actor_id() AND role_bundle_id = melarc.bootstrap_bundle_id() AND primary_hub_id IS NULL AND credential_established_at IS NULL AND credential_generation = 0
    ELSE false
  END
);
--> statement-breakpoint
-- The lock of the resume command: a row lock (FOR NO KEY UPDATE) needs the UPDATE policy to admit the row as well as the SELECT policy.
-- The check says false, so that no statement of the capability changes an identity: it locks one and changes nothing.
CREATE POLICY "staff_identity_bootstrap_lock" ON "staff_identity" FOR UPDATE USING (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'bootstrap' AND origin = 'BOOTSTRAP'
    ELSE false
  END
) WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'bootstrap' AND false
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "setup_grant_bootstrap_select" ON "setup_grant" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'bootstrap'
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "setup_grant_bootstrap_insert" ON "setup_grant" FOR INSERT WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'bootstrap' AND state = 'PENDING' AND principal_type = 'STAFF' AND purpose IN ('BOOTSTRAP_SETUP', 'MFA_REENROLMENT') AND issued_by IS NULL
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "setup_grant_bootstrap_update" ON "setup_grant" FOR UPDATE USING (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'bootstrap' AND state = 'PENDING' AND principal_type = 'STAFF'
    ELSE false
  END
) WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'bootstrap' AND state IN ('SUPERSEDED', 'EXPIRED') AND principal_type = 'STAFF'
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "mfa_factor_bootstrap_select" ON "mfa_factor" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'bootstrap'
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "mfa_factor_bootstrap_update" ON "mfa_factor" FOR UPDATE USING (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'bootstrap' AND status = 'PENDING'
    ELSE false
  END
) WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'bootstrap' AND status = 'REVOKED' AND revoked_by IS NULL AND revocation_reason_code IS NULL AND revocation_episode_id IS NULL
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "session_bootstrap_select" ON "session" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'bootstrap'
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "setting_bootstrap_read" ON "setting" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'bootstrap' AND key = 'recovery_link_ttl_minutes'
    ELSE false
  END
);
--> statement-breakpoint
-- The reader of GBT-E7 (system-branch.ts) refuses the word SYSTEM anywhere in a branch but its arm, so the actor and the surface are
-- stated the other way round: a null actor is the SYSTEM actor (the table's own check holds actor_type = 'SYSTEM' to actor_id IS NULL),
-- and a surface that is none of the three of a person is the system's (the surface set is closed).
CREATE POLICY "audit_event_bootstrap_insert" ON "audit_event" FOR INSERT WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'bootstrap' AND actor_id IS NULL AND surface_context NOT IN ('OPS_PORTAL', 'VENDOR_PWA', 'RIDER_ANDROID') AND outcome = 'SUCCEEDED' AND ((event_code IN ('staff.identity.created', 'staff.identity.approved', 'auth.mfa.revoked') AND enhanced) OR (event_code IN ('auth.setup_grant.issued', 'auth.setup_grant.superseded') AND NOT enhanced))
    ELSE false
  END
);
--> statement-breakpoint
CREATE FUNCTION melarc.bootstrap_status() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  previous_type text := coalesce(pg_catalog.current_setting('melarc.principal_type', true), '');
  previous_capability text := coalesce(pg_catalog.current_setting('melarc.task_capability', true), '');
  found bigint;
BEGIN
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'the bootstrap runs at read committed isolation only' USING ERRCODE = '25000';
  END IF;
  -- The lock is the seed's own and is held to the end of the caller's transaction: a second seed that asks for the status waits here,
  -- and a sweep of orphan bundles that follows a status read never runs while another run is between its bundles and its commit.
  LOCK TABLE public.staff_identity IN SHARE ROW EXCLUSIVE MODE;
  PERFORM pg_catalog.set_config('melarc.principal_type', 'SYSTEM', true);
  PERFORM pg_catalog.set_config('melarc.task_capability', 'bootstrap', true);
  SELECT pg_catalog.count(*) INTO found FROM public.staff_identity;
  PERFORM pg_catalog.set_config('melarc.principal_type', previous_type, true);
  PERFORM pg_catalog.set_config('melarc.task_capability', previous_capability, true);
  RETURN pg_catalog.jsonb_build_object('staff_identity', found);
END
$$;
--> statement-breakpoint
CREATE FUNCTION melarc.seed_bootstrap_administrators(payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  previous_type text := coalesce(pg_catalog.current_setting('melarc.principal_type', true), '');
  previous_capability text := coalesce(pg_catalog.current_setting('melarc.task_capability', true), '');
  uuid_pattern constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  entry jsonb;
  grant_entry jsonb;
  found bigint;
  inserted bigint;
  matched bigint;
  distinct_events bigint;
BEGIN
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'the bootstrap seed runs at read committed isolation only' USING ERRCODE = '25000';
  END IF;

  -- The document: one object with the administrators and the events of the run, and nothing else. Every check below is on the
  -- document alone and runs before any lock, so a malformed document is refused whatever the table holds.
  IF payload IS NULL OR pg_catalog.jsonb_typeof(payload) <> 'object'
     OR EXISTS (SELECT 1 FROM pg_catalog.jsonb_object_keys(payload) AS k WHERE k NOT IN ('administrators', 'audit'))
     OR NOT (payload ?& ARRAY['administrators', 'audit'])
     OR pg_catalog.jsonb_typeof(payload -> 'administrators') IS DISTINCT FROM 'array'
     OR pg_catalog.jsonb_typeof(payload -> 'audit') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'the payload is one JSON object with the administrators and the audit events of the run' USING ERRCODE = '22023';
  END IF;
  IF pg_catalog.jsonb_array_length(payload -> 'administrators') <> 2 THEN
    RAISE EXCEPTION 'the bootstrap creates exactly two administrators' USING ERRCODE = '22023';
  END IF;
  IF pg_catalog.jsonb_array_length(payload -> 'audit') <> 6 THEN
    RAISE EXCEPTION 'the bootstrap writes exactly six audit events: the creation, the approval and the issue of the secret of each administrator' USING ERRCODE = '22023';
  END IF;
  FOR entry IN SELECT a FROM pg_catalog.jsonb_array_elements(payload -> 'administrators') AS a LOOP
    IF pg_catalog.jsonb_typeof(entry) <> 'object'
       OR EXISTS (SELECT 1 FROM pg_catalog.jsonb_object_keys(entry) AS k
                   WHERE k NOT IN ('id', 'work_email', 'work_email_canonical', 'full_name', 'grant'))
       OR NOT (entry ?& ARRAY['id', 'work_email', 'work_email_canonical', 'full_name', 'grant'])
       OR pg_catalog.jsonb_typeof(entry -> 'id') IS DISTINCT FROM 'string'
       OR pg_catalog.jsonb_typeof(entry -> 'work_email') IS DISTINCT FROM 'string'
       OR pg_catalog.jsonb_typeof(entry -> 'work_email_canonical') IS DISTINCT FROM 'string'
       OR pg_catalog.jsonb_typeof(entry -> 'full_name') IS DISTINCT FROM 'string'
       OR pg_catalog.jsonb_typeof(entry -> 'grant') IS DISTINCT FROM 'object'
       OR NOT coalesce((entry ->> 'id') ~ uuid_pattern, false) THEN
      RAISE EXCEPTION 'each administrator is an object with an identifier, a work email, its canonical form, a name and a grant' USING ERRCODE = '22023';
    END IF;
    grant_entry := entry -> 'grant';
    IF EXISTS (SELECT 1 FROM pg_catalog.jsonb_object_keys(grant_entry) AS k WHERE k NOT IN ('id', 'token_hash'))
       OR NOT (grant_entry ?& ARRAY['id', 'token_hash'])
       OR pg_catalog.jsonb_typeof(grant_entry -> 'id') IS DISTINCT FROM 'string'
       OR pg_catalog.jsonb_typeof(grant_entry -> 'token_hash') IS DISTINCT FROM 'string'
       OR NOT coalesce((grant_entry ->> 'id') ~ uuid_pattern, false)
       OR NOT coalesce((grant_entry ->> 'token_hash') ~ '^[0-9a-f]{64}$', false) THEN
      RAISE EXCEPTION 'each grant is an identifier and the hash of its secret as 64 hexadecimal digits' USING ERRCODE = '22023';
    END IF;
  END LOOP;
  IF (SELECT pg_catalog.count(DISTINCT a ->> 'id') FROM pg_catalog.jsonb_array_elements(payload -> 'administrators') AS a) <> 2
     OR (SELECT pg_catalog.count(DISTINCT a ->> 'work_email_canonical') FROM pg_catalog.jsonb_array_elements(payload -> 'administrators') AS a) <> 2
     OR (SELECT pg_catalog.count(DISTINCT a -> 'grant' ->> 'id') FROM pg_catalog.jsonb_array_elements(payload -> 'administrators') AS a) <> 2
     OR (SELECT pg_catalog.count(DISTINCT a -> 'grant' ->> 'token_hash') FROM pg_catalog.jsonb_array_elements(payload -> 'administrators') AS a) <> 2 THEN
    RAISE EXCEPTION 'the two administrators have their own identifier, work email, grant and secret: a pair that collapses to one is not two custodians' USING ERRCODE = '22023';
  END IF;

  -- The events: exactly the creation and the approval (enhanced) and the issue of the secret (ordinary) of each administrator,
  -- each naming the identity or the grant of this document, recorded by SYSTEM, as a success.
  SELECT pg_catalog.count(*), pg_catalog.count(DISTINCT (r.event_code, r.object_id)) INTO matched, distinct_events
    FROM pg_catalog.jsonb_populate_recordset(NULL::public.audit_event, payload -> 'audit') AS r
    JOIN (
      SELECT 'staff.identity.created' AS code, 'StaffIdentity' AS object_type, (a ->> 'id')::uuid AS object_id, true AS enhanced
        FROM pg_catalog.jsonb_array_elements(payload -> 'administrators') AS a
      UNION ALL
      SELECT 'staff.identity.approved', 'StaffIdentity', (a ->> 'id')::uuid, true
        FROM pg_catalog.jsonb_array_elements(payload -> 'administrators') AS a
      UNION ALL
      SELECT 'auth.setup_grant.issued', 'SetupGrant', (a -> 'grant' ->> 'id')::uuid, false
        FROM pg_catalog.jsonb_array_elements(payload -> 'administrators') AS a
    ) AS e
      ON r.event_code = e.code AND r.object_type = e.object_type AND r.object_id = e.object_id AND r.enhanced = e.enhanced
   WHERE r.actor_type = 'SYSTEM' AND r.actor_id IS NULL AND r.surface_context = 'SYSTEM' AND r.outcome = 'SUCCEEDED';
  IF matched <> 6 OR distinct_events <> 6 THEN
    RAISE EXCEPTION 'the audit events are not the six the bootstrap writes, each for its own identity or grant, by SYSTEM, enhanced as the catalogue says' USING ERRCODE = '22023';
  END IF;

  -- Once: the table is locked against every writer and every other seed, then counted. The lock is held to the end of the caller's
  -- transaction, so a second seed waits and then finds the table filled.
  LOCK TABLE public.staff_identity IN SHARE ROW EXCLUSIVE MODE;
  PERFORM pg_catalog.set_config('melarc.principal_type', 'SYSTEM', true);
  PERFORM pg_catalog.set_config('melarc.task_capability', 'bootstrap', true);

  SELECT pg_catalog.count(*) INTO found FROM public.staff_identity;
  IF found <> 0 THEN
    RAISE EXCEPTION 'the bootstrap is already done: table staff_identity holds % rows', found
      USING ERRCODE = '55000', TABLE = 'staff_identity', DETAIL = pg_catalog.format('reason=STAFF_TABLE_NOT_EMPTY;rows=%s', found);
  END IF;

  -- The shape is fixed here: the caller names the identifier, the email, the name and the secret's hash, and nothing else.
  INSERT INTO public.staff_identity (id, work_email, work_email_canonical, full_name, status, role_bundle_id, primary_hub_id,
                                     credential_hash, credential_established_at, credential_generation, created_by, approved_by, origin)
    SELECT (a ->> 'id')::uuid, a ->> 'work_email', a ->> 'work_email_canonical', a ->> 'full_name', 'ACTIVE',
           melarc.bootstrap_bundle_id(), NULL, NULL, NULL, 0, melarc.reserved_system_actor_id(), melarc.reserved_system_actor_id(), 'BOOTSTRAP'
      FROM pg_catalog.jsonb_array_elements(payload -> 'administrators') AS a;
  GET DIAGNOSTICS inserted = ROW_COUNT;
  IF inserted <> 2 THEN
    RAISE EXCEPTION 'table staff_identity received % of 2 rows', inserted USING ERRCODE = '22023', TABLE = 'staff_identity';
  END IF;

  -- One BOOTSTRAP_SETUP for each: no expiry (a clock there could strand an environment nobody can sign into), no episode, no issuer.
  INSERT INTO public.setup_grant (id, principal_type, principal_id, purpose, token_hash, issued_at, expires_at, state, issued_by)
    SELECT (a -> 'grant' ->> 'id')::uuid, 'STAFF', (a ->> 'id')::uuid, 'BOOTSTRAP_SETUP',
           pg_catalog.decode(a -> 'grant' ->> 'token_hash', 'hex'), pg_catalog.clock_timestamp(), NULL, 'PENDING', NULL
      FROM pg_catalog.jsonb_array_elements(payload -> 'administrators') AS a;
  GET DIAGNOSTICS inserted = ROW_COUNT;
  IF inserted <> 2 THEN
    RAISE EXCEPTION 'table setup_grant received % of 2 rows', inserted USING ERRCODE = '22023', TABLE = 'setup_grant';
  END IF;

  INSERT INTO public.audit_event (id, event_code, occurred_at, actor_type, actor_id, actor_bundle, surface_context, device_context,
                                  vendor_organization_id, responsible_hub_id, object_type, object_id, correlation_id, previous_state,
                                  resulting_state, reason_code, reason_label, note, approval_id, before_after, related_ids, detail,
                                  outcome, enhanced, serialisation_version)
    SELECT r.id, r.event_code, r.occurred_at, r.actor_type, r.actor_id, r.actor_bundle, r.surface_context, r.device_context,
           r.vendor_organization_id, r.responsible_hub_id, r.object_type, r.object_id, r.correlation_id, r.previous_state,
           r.resulting_state, r.reason_code, r.reason_label, r.note, r.approval_id, r.before_after, r.related_ids, r.detail,
           r.outcome, r.enhanced, r.serialisation_version
      FROM pg_catalog.jsonb_populate_recordset(NULL::public.audit_event, payload -> 'audit') AS r;
  GET DIAGNOSTICS inserted = ROW_COUNT;
  IF inserted <> 6 THEN
    RAISE EXCEPTION 'table audit_event received % of 6 rows', inserted USING ERRCODE = '22023', TABLE = 'audit_event';
  END IF;

  PERFORM pg_catalog.set_config('melarc.principal_type', previous_type, true);
  PERFORM pg_catalog.set_config('melarc.task_capability', previous_capability, true);
  RETURN pg_catalog.jsonb_build_object('staff_identity', 2, 'setup_grant', 2, 'audit_event', 6);
END
$$;
--> statement-breakpoint
CREATE FUNCTION melarc.bootstrap_identity_state(canonical_email text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  previous_type text := coalesce(pg_catalog.current_setting('melarc.principal_type', true), '');
  previous_capability text := coalesce(pg_catalog.current_setting('melarc.task_capability', true), '');
  looked_up record;
  identity record;
  pending uuid[];
  live_grant uuid;
BEGIN
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'the bootstrap runs at read committed isolation only' USING ERRCODE = '25000';
  END IF;
  IF canonical_email IS NULL OR pg_catalog.length(canonical_email) NOT BETWEEN 3 AND 320 THEN
    RAISE EXCEPTION 'the work email is the canonical form of an address' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_catalog.set_config('melarc.principal_type', 'SYSTEM', true);
  PERFORM pg_catalog.set_config('melarc.task_capability', 'bootstrap', true);

  -- Found, and judged, before it is locked: the lock policy admits a bootstrap identity alone, so an identity of another origin would
  -- be skipped by the lock and read as absent. A rejected profile has released its address and is not the identity.
  SELECT s.id, s.origin INTO looked_up
    FROM public.staff_identity s WHERE s.work_email_canonical = canonical_email AND s.status <> 'REJECTED';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no staff identity has that work email' USING ERRCODE = '55000', DETAIL = 'reason=NO_SUCH_IDENTITY';
  END IF;
  IF looked_up.origin <> 'BOOTSTRAP' THEN
    RAISE EXCEPTION 'that identity is not a bootstrap identity' USING ERRCODE = '55000', DETAIL = 'reason=NOT_BOOTSTRAP_IDENTITY';
  END IF;
  -- Then locked as the credential operations lock it, and held to the end of the caller's transaction: what is read from here is what
  -- the resume that follows changes.
  SELECT s.id, s.origin, s.status, s.full_name, s.work_email, s.credential_established_at IS NOT NULL AS established INTO identity
    FROM public.staff_identity s WHERE s.id = looked_up.id
     FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no staff identity has that work email' USING ERRCODE = '55000', DETAIL = 'reason=NO_SUCH_IDENTITY';
  END IF;

  SELECT coalesce(pg_catalog.array_agg(f.id ORDER BY f.id), ARRAY[]::uuid[]) INTO pending
    FROM public.mfa_factor f WHERE f.staff_identity_id = identity.id AND f.status = 'PENDING';
  -- At most one: the partial unique index of the table keeps one PENDING setup grant of a purpose for a principal.
  SELECT g.id INTO live_grant
    FROM public.setup_grant g
   WHERE g.principal_type = 'STAFF' AND g.principal_id = identity.id AND g.purpose = 'BOOTSTRAP_SETUP' AND g.state = 'PENDING';

  PERFORM pg_catalog.set_config('melarc.principal_type', previous_type, true);
  PERFORM pg_catalog.set_config('melarc.task_capability', previous_capability, true);
  RETURN pg_catalog.jsonb_build_object(
    'id', identity.id,
    'origin', identity.origin,
    'status', identity.status,
    'full_name', identity.full_name,
    'work_email', identity.work_email,
    'credential_established', identity.established,
    'pending_factor_ids', pg_catalog.to_jsonb(pending),
    'live_bootstrap_grant_id', live_grant
  );
END
$$;
--> statement-breakpoint
CREATE FUNCTION melarc.resume_bootstrap_identity(payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  previous_type text := coalesce(pg_catalog.current_setting('melarc.principal_type', true), '');
  previous_capability text := coalesce(pg_catalog.current_setting('melarc.task_capability', true), '');
  uuid_pattern constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  identity_id uuid;
  grant_id uuid;
  path text;
  purpose text;
  looked_up record;
  identity record;
  lifetime_minutes integer;
  setting_row record;
  at timestamptz;
  expires timestamptz;
  expired uuid[] := ARRAY[]::uuid[];
  revoked uuid[] := ARRAY[]::uuid[];
  superseded uuid;
  matched bigint;
  inserted bigint;
BEGIN
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'the resume command runs at read committed isolation only' USING ERRCODE = '25000';
  END IF;

  -- The document, judged on its own before anything is read.
  IF payload IS NULL OR pg_catalog.jsonb_typeof(payload) <> 'object'
     OR EXISTS (SELECT 1 FROM pg_catalog.jsonb_object_keys(payload) AS k WHERE k NOT IN ('identity_id', 'path', 'grant', 'audit'))
     OR NOT (payload ?& ARRAY['identity_id', 'path', 'grant', 'audit'])
     OR pg_catalog.jsonb_typeof(payload -> 'identity_id') IS DISTINCT FROM 'string'
     OR pg_catalog.jsonb_typeof(payload -> 'path') IS DISTINCT FROM 'string'
     OR pg_catalog.jsonb_typeof(payload -> 'grant') IS DISTINCT FROM 'object'
     OR pg_catalog.jsonb_typeof(payload -> 'audit') IS DISTINCT FROM 'array'
     OR NOT coalesce((payload ->> 'identity_id') ~ uuid_pattern, false)
     OR (payload ->> 'path') NOT IN ('REENROLMENT', 'BUNDLE_LOST') THEN
    RAISE EXCEPTION 'the payload is one JSON object with an identity, a path, a grant and the audit events of the run' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.jsonb_object_keys(payload -> 'grant') AS k WHERE k NOT IN ('id', 'token_hash'))
     OR NOT ((payload -> 'grant') ?& ARRAY['id', 'token_hash'])
     OR pg_catalog.jsonb_typeof(payload -> 'grant' -> 'id') IS DISTINCT FROM 'string'
     OR pg_catalog.jsonb_typeof(payload -> 'grant' -> 'token_hash') IS DISTINCT FROM 'string'
     OR NOT coalesce((payload -> 'grant' ->> 'id') ~ uuid_pattern, false)
     OR NOT coalesce((payload -> 'grant' ->> 'token_hash') ~ '^[0-9a-f]{64}$', false) THEN
    RAISE EXCEPTION 'the grant is an identifier and the hash of its secret as 64 hexadecimal digits' USING ERRCODE = '22023';
  END IF;
  identity_id := (payload ->> 'identity_id')::uuid;
  grant_id := (payload -> 'grant' ->> 'id')::uuid;
  path := payload ->> 'path';
  purpose := CASE path WHEN 'REENROLMENT' THEN 'MFA_REENROLMENT' ELSE 'BOOTSTRAP_SETUP' END;
  IF pg_catalog.jsonb_array_length(payload -> 'audit') NOT BETWEEN 1 AND 16 THEN
    RAISE EXCEPTION 'the resume writes between one and sixteen audit events' USING ERRCODE = '22023';
  END IF;
  -- The events that do not depend on what the database holds: each is one of the three the command writes, by SYSTEM, a success and
  -- tiered as the catalogue says; there is exactly one issue and it names this grant; and no two name the same object.
  SELECT pg_catalog.count(*) INTO matched
    FROM pg_catalog.jsonb_populate_recordset(NULL::public.audit_event, payload -> 'audit') AS r
   WHERE r.actor_type = 'SYSTEM' AND r.actor_id IS NULL AND r.surface_context = 'SYSTEM' AND r.outcome = 'SUCCEEDED'
     AND ((r.event_code = 'auth.mfa.revoked' AND r.object_type = 'MfaFactor' AND r.enhanced AND path = 'REENROLMENT')
          OR (r.event_code = 'auth.setup_grant.superseded' AND r.object_type = 'SetupGrant' AND NOT r.enhanced AND path = 'BUNDLE_LOST')
          OR (r.event_code = 'auth.setup_grant.issued' AND r.object_type = 'SetupGrant' AND NOT r.enhanced AND r.object_id = grant_id));
  IF matched <> pg_catalog.jsonb_array_length(payload -> 'audit')
     OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_populate_recordset(NULL::public.audit_event, payload -> 'audit') AS r
          WHERE r.event_code = 'auth.setup_grant.issued') <> 1
     OR (SELECT pg_catalog.count(DISTINCT r.object_id) FROM pg_catalog.jsonb_populate_recordset(NULL::public.audit_event, payload -> 'audit') AS r)
        <> pg_catalog.jsonb_array_length(payload -> 'audit') THEN
    RAISE EXCEPTION 'the audit events are not the ones the resume writes: a revocation for each stale factor, the supersession of the lost secret, and one issue naming this grant, by SYSTEM, enhanced as the catalogue says' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.set_config('melarc.principal_type', 'SYSTEM', true);
  PERFORM pg_catalog.set_config('melarc.task_capability', 'bootstrap', true);

  -- Condition 1 is judged on the column before the lock is asked for (the lock policy admits a bootstrap identity alone, and an identity
  -- of another origin would be skipped by it and read as absent); the other five are judged under the lock.
  SELECT s.id, s.origin INTO looked_up FROM public.staff_identity s WHERE s.id = identity_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no staff identity has that identifier' USING ERRCODE = '55000', DETAIL = 'reason=NO_SUCH_IDENTITY';
  END IF;
  IF looked_up.origin <> 'BOOTSTRAP' THEN
    RAISE EXCEPTION 'condition 1: that identity is not a bootstrap identity' USING ERRCODE = '55000', DETAIL = 'reason=NOT_BOOTSTRAP_IDENTITY';
  END IF;
  SELECT s.id, s.origin, s.status, s.credential_established_at IS NOT NULL AS established INTO identity
    FROM public.staff_identity s WHERE s.id = identity_id
     FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no staff identity has that identifier' USING ERRCODE = '55000', DETAIL = 'reason=NO_SUCH_IDENTITY';
  END IF;
  IF identity.status = 'OFFBOARDED' THEN
    RAISE EXCEPTION 'condition 2: that bootstrap identity is offboarded' USING ERRCODE = '55000', DETAIL = 'reason=OFFBOARDED';
  END IF;
  IF EXISTS (SELECT 1 FROM public.mfa_factor f WHERE f.staff_identity_id = identity.id AND f.status = 'ACTIVE') THEN
    RAISE EXCEPTION 'conditions 4 and 6: that identity holds an ACTIVE factor' USING ERRCODE = '55000', DETAIL = 'reason=ACTIVE_FACTOR';
  END IF;
  IF EXISTS (SELECT 1 FROM public.session s
              WHERE s.principal_type = 'STAFF' AND s.principal_id = identity.id AND s.terminated_at IS NULL
                AND s.expires_at > pg_catalog.clock_timestamp()) THEN
    RAISE EXCEPTION 'condition 5: a session of that identity is live' USING ERRCODE = '55000', DETAIL = 'reason=LIVE_SESSION';
  END IF;
  IF identity.established IS DISTINCT FROM (path = 'REENROLMENT') THEN
    RAISE EXCEPTION 'the identity is not in the state the plan read: nothing was written' USING ERRCODE = '55000', DETAIL = 'reason=STATE_CHANGED';
  END IF;

  at := pg_catalog.clock_timestamp();

  IF path = 'REENROLMENT' THEN
    -- A grant of the identity that has lapsed is ended on its expiry (never rewritten after, never named by a new grant). One that is
    -- still live means the identity is not stranded yet.
    WITH ended AS (
      UPDATE public.setup_grant g SET state = 'EXPIRED'
       WHERE g.principal_type = 'STAFF' AND g.principal_id = identity.id AND g.state = 'PENDING'
         AND g.expires_at IS NOT NULL AND g.expires_at <= at
      RETURNING g.id
    )
    SELECT coalesce(pg_catalog.array_agg(id ORDER BY id), ARRAY[]::uuid[]) INTO expired FROM ended;
    IF EXISTS (SELECT 1 FROM public.setup_grant g
                WHERE g.principal_type = 'STAFF' AND g.principal_id = identity.id AND g.state = 'PENDING') THEN
      RAISE EXCEPTION 'that identity holds a live setup grant' USING ERRCODE = '55000', DETAIL = 'reason=LIVE_GRANT';
    END IF;
    SELECT s.value, s.value_type INTO setting_row FROM public.setting s WHERE s.key = 'recovery_link_ttl_minutes';
    IF NOT FOUND OR setting_row.value_type <> 'integer' OR pg_catalog.jsonb_typeof(setting_row.value) <> 'number'
       OR (setting_row.value)::text !~ '^[1-9][0-9]{0,5}$' THEN
      RAISE EXCEPTION 'the setting recovery_link_ttl_minutes is not seeded as a positive integer' USING ERRCODE = '55000', DETAIL = 'reason=SETTING_MISSING';
    END IF;
    lifetime_minutes := (setting_row.value)::text::integer;

    -- Every stale PENDING factor, and the document must name exactly those: the events are the record of what was revoked.
    SELECT coalesce(pg_catalog.array_agg(f.id ORDER BY f.id), ARRAY[]::uuid[]) INTO revoked
      FROM public.mfa_factor f WHERE f.staff_identity_id = identity.id AND f.status = 'PENDING';
    IF revoked IS DISTINCT FROM (
         SELECT coalesce(pg_catalog.array_agg(r.object_id ORDER BY r.object_id), ARRAY[]::uuid[])
           FROM pg_catalog.jsonb_populate_recordset(NULL::public.audit_event, payload -> 'audit') AS r
          WHERE r.event_code = 'auth.mfa.revoked') THEN
      RAISE EXCEPTION 'the factors of the identity are not the ones the plan read: nothing was written' USING ERRCODE = '55000', DETAIL = 'reason=STATE_CHANGED';
    END IF;
    UPDATE public.mfa_factor f SET status = 'REVOKED', revoked_at = at
     WHERE f.staff_identity_id = identity.id AND f.status = 'PENDING';
  ELSE
    -- The lost bundle: the one unconsumed BOOTSTRAP_SETUP is superseded, and no other live grant may exist beside it.
    IF EXISTS (SELECT 1 FROM public.setup_grant g
                WHERE g.principal_type = 'STAFF' AND g.principal_id = identity.id AND g.state = 'PENDING'
                  AND g.purpose <> 'BOOTSTRAP_SETUP') THEN
      RAISE EXCEPTION 'that identity holds a live setup grant' USING ERRCODE = '55000', DETAIL = 'reason=LIVE_GRANT';
    END IF;
    SELECT g.id INTO superseded FROM public.setup_grant g
     WHERE g.principal_type = 'STAFF' AND g.principal_id = identity.id AND g.purpose = 'BOOTSTRAP_SETUP' AND g.state = 'PENDING';
    IF superseded IS NULL
       OR superseded IS DISTINCT FROM (
            SELECT r.object_id FROM pg_catalog.jsonb_populate_recordset(NULL::public.audit_event, payload -> 'audit') AS r
             WHERE r.event_code = 'auth.setup_grant.superseded') THEN
      RAISE EXCEPTION 'the secret of the identity is not the one the plan read: nothing was written' USING ERRCODE = '55000', DETAIL = 'reason=STATE_CHANGED';
    END IF;
    UPDATE public.setup_grant g SET state = 'SUPERSEDED' WHERE g.id = superseded;
  END IF;

  -- The new grant: the secret's hash only; BOOTSTRAP_SETUP has no expiry and an MFA_REENROLMENT the lifetime of the setting; no
  -- issuer and no episode (no administrator reset this identity); a replacement names the secret it replaced.
  expires := CASE WHEN purpose = 'MFA_REENROLMENT' THEN at + pg_catalog.make_interval(mins => lifetime_minutes) END;
  INSERT INTO public.setup_grant (id, principal_type, principal_id, purpose, token_hash, issued_at, expires_at, state, issued_by,
                                  supersedes_grant_id)
    VALUES (grant_id, 'STAFF', identity.id, purpose, pg_catalog.decode(payload -> 'grant' ->> 'token_hash', 'hex'), at, expires,
            'PENDING', NULL, superseded);

  INSERT INTO public.audit_event (id, event_code, occurred_at, actor_type, actor_id, actor_bundle, surface_context, device_context,
                                  vendor_organization_id, responsible_hub_id, object_type, object_id, correlation_id, previous_state,
                                  resulting_state, reason_code, reason_label, note, approval_id, before_after, related_ids, detail,
                                  outcome, enhanced, serialisation_version)
    SELECT r.id, r.event_code, r.occurred_at, r.actor_type, r.actor_id, r.actor_bundle, r.surface_context, r.device_context,
           r.vendor_organization_id, r.responsible_hub_id, r.object_type, r.object_id, r.correlation_id, r.previous_state,
           r.resulting_state, r.reason_code, r.reason_label, r.note, r.approval_id, r.before_after, r.related_ids, r.detail,
           r.outcome, r.enhanced, r.serialisation_version
      FROM pg_catalog.jsonb_populate_recordset(NULL::public.audit_event, payload -> 'audit') AS r;
  GET DIAGNOSTICS inserted = ROW_COUNT;
  IF inserted <> pg_catalog.jsonb_array_length(payload -> 'audit') THEN
    RAISE EXCEPTION 'table audit_event received % of % rows', inserted, pg_catalog.jsonb_array_length(payload -> 'audit')
      USING ERRCODE = '22023', TABLE = 'audit_event';
  END IF;

  PERFORM pg_catalog.set_config('melarc.principal_type', previous_type, true);
  PERFORM pg_catalog.set_config('melarc.task_capability', previous_capability, true);
  RETURN pg_catalog.jsonb_build_object(
    'path', path,
    'grant_id', grant_id,
    'purpose', purpose,
    'issued_at', at,
    'expires_at', expires,
    'revoked_factor_ids', pg_catalog.to_jsonb(revoked),
    'superseded_grant_id', superseded,
    'expired_grant_ids', pg_catalog.to_jsonb(expired)
  );
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.bootstrap_status() OWNER TO melarc_owner;
--> statement-breakpoint
ALTER FUNCTION melarc.seed_bootstrap_administrators(jsonb) OWNER TO melarc_owner;
--> statement-breakpoint
ALTER FUNCTION melarc.bootstrap_identity_state(text) OWNER TO melarc_owner;
--> statement-breakpoint
ALTER FUNCTION melarc.resume_bootstrap_identity(jsonb) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.bootstrap_status() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.seed_bootstrap_administrators(jsonb) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.bootstrap_identity_state(text) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.resume_bootstrap_identity(jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.bootstrap_status() TO melarc_provisioning;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.seed_bootstrap_administrators(jsonb) TO melarc_provisioning;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.bootstrap_identity_state(text) TO melarc_provisioning;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.resume_bootstrap_identity(jsonb) TO melarc_provisioning;
