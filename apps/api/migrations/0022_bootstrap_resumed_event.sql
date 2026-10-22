-- A07 of the audit of 21 October 2026, adopted by the owner: the resume command writes one enhanced summary event, `auth.bootstrap.resumed`,
-- for every committed resume, on both paths, beside the detailed events it already writes. Forward-only: it replaces the audit-insert
-- policy of the `bootstrap` capability and the bodies of two functions of migration 0019, and changes no table, column, grant, trigger
-- or row. It is a new migration and not an edit of 0019 because a database may already hold that one: a migration that a database has
-- applied is never amended (the history check refuses it), and the applied history of every environment is not known.
--
--   * audit_event_bootstrap_insert admits a sixth event, `auth.bootstrap.resumed`, and only as an enhanced event about a StaffIdentity.
--     The actor stays null and the surface the system's: the reserved bootstrap actor is a fact of the event and never the actor.
--   * melarc.bootstrap_identity_state also returns `lapsed_grants`, the identity's grants that are PENDING and past their expiry, which the
--     re-enrolment ends as EXPIRED and which the summary names. Everything else it returns, and its lock, are unchanged.
--   * melarc.resume_bootstrap_identity takes one more event in its document, the summary, and **derives the facts of it from what it
--     wrote** (the grants it ended, with purpose and state, the grant it issued, the factors it revoked, each in id order) and refuses,
--     writing nothing, a document whose summary says anything else. The event is inserted by the same statement as the others, in the
--     same transaction, so a summary that cannot be written takes the change back with it. Every other rule it judged it still judges.
--   * CREATE OR REPLACE keeps each function's owner and privileges; the statements that follow restate what 0019 set, so the migration is
--     correct whoever ran it.
-- Applied as melarc_migration_elevated.

-- The reader of GBT-E7 (system-branch.ts) refuses the word SYSTEM anywhere in a branch but its arm, so the actor and the surface are
-- stated as 0019 states them: a null actor is the SYSTEM actor, and a surface that is none of the three of a person is the system's.
ALTER POLICY "audit_event_bootstrap_insert" ON "audit_event" WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'bootstrap' AND actor_id IS NULL AND surface_context NOT IN ('OPS_PORTAL', 'VENDOR_PWA', 'RIDER_ANDROID') AND outcome = 'SUCCEEDED' AND ((event_code IN ('staff.identity.created', 'staff.identity.approved', 'auth.mfa.revoked') AND enhanced) OR (event_code IN ('auth.setup_grant.issued', 'auth.setup_grant.superseded') AND NOT enhanced) OR (event_code = 'auth.bootstrap.resumed' AND enhanced AND object_type = 'StaffIdentity' AND object_id IS NOT NULL))
    ELSE false
  END
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION melarc.bootstrap_identity_state(canonical_email text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  previous_type text := coalesce(pg_catalog.current_setting('melarc.principal_type', true), '');
  previous_capability text := coalesce(pg_catalog.current_setting('melarc.task_capability', true), '');
  looked_up record;
  identity record;
  pending uuid[];
  live_grant uuid;
  lapsed jsonb;
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
  -- The grants of the identity that are still PENDING and whose expiry has passed: the re-enrolment ends each as EXPIRED, and the summary
  -- event names them. The resume function derives the same list from what it ends, and refuses a document that says otherwise.
  SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', g.id, 'purpose', g.purpose) ORDER BY g.id), '[]'::pg_catalog.jsonb) INTO lapsed
    FROM public.setup_grant g
   WHERE g.principal_type = 'STAFF' AND g.principal_id = identity.id AND g.state = 'PENDING'
     AND g.expires_at IS NOT NULL AND g.expires_at <= pg_catalog.clock_timestamp();

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
    'live_bootstrap_grant_id', live_grant,
    'lapsed_grants', lapsed
  );
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION melarc.resume_bootstrap_identity(payload jsonb) RETURNS jsonb
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
  ended_rows jsonb := '[]'::pg_catalog.jsonb;
  before_grants jsonb;
  after_grants jsonb;
  expected_related jsonb;
  expected_before_after jsonb;
  summary public.audit_event;
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
  IF pg_catalog.jsonb_array_length(payload -> 'audit') NOT BETWEEN 2 AND 17 THEN
    RAISE EXCEPTION 'the resume writes between two and seventeen audit events: its detailed events and its summary' USING ERRCODE = '22023';
  END IF;
  -- The events that do not depend on what the database holds: each is one of the three the command writes, by SYSTEM, a success and
  -- tiered as the catalogue says; there is exactly one issue and it names this grant; and no two name the same object.
  SELECT pg_catalog.count(*) INTO matched
    FROM pg_catalog.jsonb_populate_recordset(NULL::public.audit_event, payload -> 'audit') AS r
   WHERE r.actor_type = 'SYSTEM' AND r.actor_id IS NULL AND r.surface_context = 'SYSTEM' AND r.outcome = 'SUCCEEDED'
     AND ((r.event_code = 'auth.mfa.revoked' AND r.object_type = 'MfaFactor' AND r.enhanced AND path = 'REENROLMENT')
          OR (r.event_code = 'auth.setup_grant.superseded' AND r.object_type = 'SetupGrant' AND NOT r.enhanced AND path = 'BUNDLE_LOST')
          OR (r.event_code = 'auth.setup_grant.issued' AND r.object_type = 'SetupGrant' AND NOT r.enhanced AND r.object_id = grant_id)
          OR (r.event_code = 'auth.bootstrap.resumed' AND r.object_type = 'StaffIdentity' AND r.enhanced AND r.object_id = identity_id
              AND r.previous_state IS NULL AND r.resulting_state IS NULL AND r.reason_code IS NULL AND r.reason_label IS NULL
              AND r.note IS NULL AND r.approval_id IS NULL AND r.actor_bundle IS NULL AND r.device_context IS NULL
              AND r.vendor_organization_id IS NULL AND r.responsible_hub_id IS NULL));
  IF matched <> pg_catalog.jsonb_array_length(payload -> 'audit')
     OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_populate_recordset(NULL::public.audit_event, payload -> 'audit') AS r
          WHERE r.event_code = 'auth.setup_grant.issued') <> 1
     OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_populate_recordset(NULL::public.audit_event, payload -> 'audit') AS r
          WHERE r.event_code = 'auth.bootstrap.resumed') <> 1
     OR (SELECT pg_catalog.count(DISTINCT r.object_id) FROM pg_catalog.jsonb_populate_recordset(NULL::public.audit_event, payload -> 'audit') AS r)
        <> pg_catalog.jsonb_array_length(payload -> 'audit') THEN
    RAISE EXCEPTION 'the audit events are not the ones the resume writes: a revocation for each stale factor, the supersession of the lost secret, one issue naming this grant and one summary naming the identity, by SYSTEM, enhanced as the catalogue says' USING ERRCODE = '22023';
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
      RETURNING g.id, g.purpose
    )
    SELECT coalesce(pg_catalog.array_agg(e.id ORDER BY e.id), ARRAY[]::uuid[]),
           coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', e.id, 'purpose', e.purpose, 'state', 'EXPIRED') ORDER BY e.id), '[]'::pg_catalog.jsonb)
      INTO expired, ended_rows FROM ended AS e;
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
    WITH changed AS (
      UPDATE public.mfa_factor f SET status = 'REVOKED', revoked_at = at
       WHERE f.staff_identity_id = identity.id AND f.status = 'PENDING'
      RETURNING f.id
    )
    SELECT coalesce(pg_catalog.array_agg(c.id ORDER BY c.id), ARRAY[]::uuid[]) INTO revoked FROM changed AS c;
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
    WITH changed AS (
      UPDATE public.setup_grant g SET state = 'SUPERSEDED' WHERE g.id = superseded
      RETURNING g.id, g.purpose
    )
    SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', c.id, 'purpose', c.purpose, 'state', 'SUPERSEDED') ORDER BY c.id), '[]'::pg_catalog.jsonb)
      INTO ended_rows FROM changed AS c;
  END IF;

  -- The new grant: the secret's hash only; BOOTSTRAP_SETUP has no expiry and an MFA_REENROLMENT the lifetime of the setting; no
  -- issuer and no episode (no administrator reset this identity); a replacement names the secret it replaced.
  expires := CASE WHEN purpose = 'MFA_REENROLMENT' THEN at + pg_catalog.make_interval(mins => lifetime_minutes) END;
  INSERT INTO public.setup_grant (id, principal_type, principal_id, purpose, token_hash, issued_at, expires_at, state, issued_by,
                                  supersedes_grant_id)
    VALUES (grant_id, 'STAFF', identity.id, purpose, pg_catalog.decode(payload -> 'grant' ->> 'token_hash', 'hex'), at, expires,
            'PENDING', NULL, superseded);

  -- The summary event says what the resume did, and the function derives what it did from what it wrote: the grants it ended with the
  -- purpose and state of each, the grant it issued, the factors it revoked, all in id order. A document whose summary says anything
  -- else (a grant that lapsed after the state was read, a factor that appeared, a fact the plan invented) is refused, and nothing is
  -- written: no identifier of the summary comes from the caller as an assertion (A07, AC-SLICE-000-93).
  SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', x ->> 'id', 'purpose', x ->> 'purpose', 'state', 'PENDING')
                                       ORDER BY (x ->> 'id')::uuid), '[]'::pg_catalog.jsonb)
    INTO before_grants FROM pg_catalog.jsonb_array_elements(ended_rows) AS x;
  SELECT coalesce(pg_catalog.jsonb_agg(x ORDER BY (x ->> 'id')::uuid), '[]'::pg_catalog.jsonb)
         || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('id', grant_id, 'purpose', purpose, 'state', 'PENDING'))
    INTO after_grants FROM pg_catalog.jsonb_array_elements(ended_rows) AS x;
  expected_related := pg_catalog.jsonb_build_object(
    'principal_id', identity.id,
    'reserved_system_actor_id', melarc.reserved_system_actor_id(),
    'setup_grant_id', grant_id,
    'superseded_grant_ids', coalesce((SELECT pg_catalog.jsonb_agg(x ->> 'id' ORDER BY (x ->> 'id')::uuid)
                                        FROM pg_catalog.jsonb_array_elements(ended_rows) AS x WHERE x ->> 'state' = 'SUPERSEDED'), '[]'::pg_catalog.jsonb),
    'expired_grant_ids', coalesce((SELECT pg_catalog.jsonb_agg(x ->> 'id' ORDER BY (x ->> 'id')::uuid)
                                     FROM pg_catalog.jsonb_array_elements(ended_rows) AS x WHERE x ->> 'state' = 'EXPIRED'), '[]'::pg_catalog.jsonb),
    'revoked_factor_ids', pg_catalog.to_jsonb(revoked));
  expected_before_after := pg_catalog.jsonb_build_object(
    'grants', pg_catalog.jsonb_build_object('before', before_grants, 'after', after_grants),
    'factors', pg_catalog.jsonb_build_object(
      'before', coalesce((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', f, 'status', 'PENDING') ORDER BY f)
                            FROM pg_catalog.unnest(revoked) AS f), '[]'::pg_catalog.jsonb),
      'after', coalesce((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', f, 'status', 'REVOKED') ORDER BY f)
                           FROM pg_catalog.unnest(revoked) AS f), '[]'::pg_catalog.jsonb)));
  SELECT r.* INTO summary
    FROM pg_catalog.jsonb_populate_recordset(NULL::public.audit_event, payload -> 'audit') AS r
   WHERE r.event_code = 'auth.bootstrap.resumed';
  IF summary.detail IS DISTINCT FROM pg_catalog.jsonb_build_object('path', path, 'purpose', purpose, 'channel', 'PROVISIONING_CHANNEL')
     OR summary.related_ids IS DISTINCT FROM expected_related
     OR summary.before_after IS DISTINCT FROM expected_before_after THEN
    RAISE EXCEPTION 'the summary event does not describe what the resume changed: nothing was written' USING ERRCODE = '55000', DETAIL = 'reason=STATE_CHANGED';
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
ALTER FUNCTION melarc.bootstrap_identity_state(text) OWNER TO melarc_owner;
--> statement-breakpoint
ALTER FUNCTION melarc.resume_bootstrap_identity(jsonb) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.bootstrap_identity_state(text) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.resume_bootstrap_identity(jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.bootstrap_identity_state(text) TO melarc_provisioning;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.resume_bootstrap_identity(jsonb) TO melarc_provisioning;
