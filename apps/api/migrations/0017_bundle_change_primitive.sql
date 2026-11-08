-- The bundle-change primitive (S0.27; SECURITY_DESIGN.md section 13.10a; permission-enforcement.md section 5.5; plan section 7.18).
-- Applied as melarc_migration_elevated, a member of melarc_owner (MIGRATION_AND_SEEDING.md section 5.1).
--
-- Why this exists. 0003 and 0004 gave the three policy tables (role_bundle, role_bundle_grant, fixed_permission_policy) SELECT policies
-- and, for the seed, INSERT ones; 0005 took even the provisioning login's privileges away. Under forced row-level security nobody can
-- UPDATE or DELETE them, the owner and the migration login included, so the registry's "writers: seed, migration" had no way to act
-- once the seed had run. The change of a bundle is the one operation that raises its revision, raises its floor when it is a
-- reduction, and ends the sessions below the floor in the same transaction, and it has to be one operation for a migration, for the
-- seed and for the edit operation of SLICE-009, so it is one definer function and not three pieces of application code.
--
-- The form, decided here (S0.27 decides and records it): SQL functions, not an application function behind a provisioning command.
--
--   * The identity the registry names for a policy change after the seed is the migration login ("policy changes for the deployment
--     window only", data-scope-registry.md section 5). A migration is SQL, and has to be able to call the primitive; an application
--     function behind a command could not be called from one.
--   * The only way into a forced-row-level-security table that this codebase accepts is a definer function with a fixed search_path,
--     whose EXECUTE is restricted and which carries its own task capability for its own statements (0005 is the precedent). An
--     application command would need those same functions for the table writes, and would then also need the privileges to end
--     sessions and to write the audit, which only the runtime holds.
--   * The lock, the diff, the writes, the ending of the sessions and their audit events are then one transaction by construction,
--     with no round trip between them.
--
-- What it grants, and what it does not.
--
--   * A new task capability, policy_change, which only these functions assert. EXECUTE on change_role_bundle and change_fixed_policy
--     is the migration login's alone; the API runtime, the worker and the provisioning login get nothing, and no table privilege is
--     given to anyone. The capability's policies admit a SYSTEM context under it to read the three tables and to update them (and
--     the grants of a bundle also to insert and to delete). A label is not an identity: the runtime logins can assert it, and reach
--     nothing, because they hold SELECT on these tables and no more.
--   * The statements on sessions and on the audit ledger run under the authentication capability, which already has the policies for
--     them. Each function sets the labels for its own statements and puts back what the caller had set. Nothing the caller sets is
--     read as proof.
--   * What the SLICE-009 edit operation needs in order to reach this from the API (an EXECUTE grant to the runtime, or a privileged
--     job) is a decision of that slice and of the Product Owner; nothing here widens it.
--
-- A reduction, and what is not one. A reduction is a removal of a grant, or a narrowing of its hub scope (none < own < all), its
-- ownership scope (own and assigned are not ordered, and both are below any) or its tier (none < A < S < P, where a null tier is
-- "not applicable" and ranks below every tier; it is never read as a ranked tier). A change that both adds and removes is a
-- reduction. **A change that cannot be shown to be a widening is a reduction**: it can only end more sessions, never fewer, so
-- an attribute the orders above do not rank, or a move between own and assigned, is treated as one.
--
-- The lock keys are the same numbers as platform/database/policy-lock/lock-keys.ts (the classes 1296843313 and 1296844337, the VENDOR
-- and RIDER ordinals 1 and 2, the first four bytes of the SHA-256 of the lower-case id as a signed 32-bit integer), written here a
-- second time because SQL cannot import them. test/database/policy-change.db.test.ts holds the two to each other by what the server
-- reports in pg_locks, not by the text of either.

CREATE FUNCTION melarc.policy_bundle_lock_key(bundle_id uuid) RETURNS integer
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path = pg_catalog, pg_temp AS $$
  SELECT ('x' || pg_catalog.encode(pg_catalog.substring(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.lower(bundle_id::pg_catalog.text), 'UTF8')), 1, 4), 'hex'))::pg_catalog.bit(32)::pg_catalog.int4
$$;
--> statement-breakpoint
CREATE FUNCTION melarc.policy_fixed_lock_key(principal_type text) RETURNS integer
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE principal_type WHEN 'VENDOR' THEN 1 WHEN 'RIDER' THEN 2 END
$$;
--> statement-breakpoint
-- Takes the exclusive policy lock of one bundle, in the one canonical order (SECURITY_DESIGN.md section 13.10a: class, then key,
-- ascending). It refuses what the protocol forbids and the database cannot see by itself, because an advisory lock does not conflict
-- with its own holder: a key this transaction holds SHARED (an upgrade would succeed here and could deadlock two holders that both
-- tried), a bundle lock after a fixed-policy lock, and a bundle key lower than one already held. A key already held exclusively is
-- taken again freely: re-entry waits for nobody.
CREATE FUNCTION melarc.lock_policy_bundle(bundle_id uuid) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  lock_key integer := melarc.policy_bundle_lock_key(bundle_id);
  wanted pg_catalog.oid := ((lock_key::pg_catalog.int8 + 4294967296) % 4294967296)::pg_catalog.oid;
  fixed_held bigint;
  exclusive_held bigint;
  shared_held bigint;
  highest_held bigint;
BEGIN
  IF bundle_id IS NULL THEN
    RAISE EXCEPTION 'a bundle lock is taken on a bundle id' USING ERRCODE = '22023';
  END IF;
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'policy locks are taken at read committed isolation only' USING ERRCODE = '25000';
  END IF;
  SELECT pg_catalog.count(*) FILTER (WHERE l.classid = 1296844337::pg_catalog.oid),
         pg_catalog.count(*) FILTER (WHERE l.classid = 1296843313::pg_catalog.oid AND l.objid = wanted AND l.mode = 'ExclusiveLock'),
         pg_catalog.count(*) FILTER (WHERE l.classid = 1296843313::pg_catalog.oid AND l.objid = wanted AND l.mode = 'ShareLock'),
         pg_catalog.max(CASE WHEN l.objid::pg_catalog.int8 >= 2147483648 THEN l.objid::pg_catalog.int8 - 4294967296 ELSE l.objid::pg_catalog.int8 END)
           FILTER (WHERE l.classid = 1296843313::pg_catalog.oid)
    INTO fixed_held, exclusive_held, shared_held, highest_held
    FROM pg_catalog.pg_locks AS l
   WHERE l.locktype = 'advisory' AND l.pid = pg_catalog.pg_backend_pid() AND l.granted AND l.objsubid = 2;
  IF exclusive_held > 0 THEN
    RETURN;
  END IF;
  IF shared_held > 0 THEN
    RAISE EXCEPTION 'this transaction holds that bundle lock shared: a key is never upgraded' USING ERRCODE = '55000', DETAIL = 'lock_upgrade';
  END IF;
  IF fixed_held > 0 THEN
    RAISE EXCEPTION 'a bundle lock is taken before any fixed-policy lock, never after' USING ERRCODE = '55000', DETAIL = 'lock_order';
  END IF;
  IF highest_held IS NOT NULL AND lock_key < highest_held THEN
    RAISE EXCEPTION 'bundle locks are taken in ascending key order: take them together with melarc.lock_policy_keys' USING ERRCODE = '55000', DETAIL = 'lock_order';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(1296843313, lock_key);
END
$$;
--> statement-breakpoint
CREATE FUNCTION melarc.lock_policy_fixed(principal_type text) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  lock_key integer := melarc.policy_fixed_lock_key(principal_type);
  wanted pg_catalog.oid := lock_key::pg_catalog.oid;
  exclusive_held bigint;
  shared_held bigint;
  highest_held bigint;
BEGIN
  IF lock_key IS NULL THEN
    RAISE EXCEPTION 'only a Vendor and a Rider have a fixed permission policy to lock' USING ERRCODE = '22023';
  END IF;
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'policy locks are taken at read committed isolation only' USING ERRCODE = '25000';
  END IF;
  SELECT pg_catalog.count(*) FILTER (WHERE l.objid = wanted AND l.mode = 'ExclusiveLock'),
         pg_catalog.count(*) FILTER (WHERE l.objid = wanted AND l.mode = 'ShareLock'),
         pg_catalog.max(l.objid::pg_catalog.int8)
    INTO exclusive_held, shared_held, highest_held
    FROM pg_catalog.pg_locks AS l
   WHERE l.locktype = 'advisory' AND l.pid = pg_catalog.pg_backend_pid() AND l.granted AND l.objsubid = 2
     AND l.classid = 1296844337::pg_catalog.oid;
  IF exclusive_held > 0 THEN
    RETURN;
  END IF;
  IF shared_held > 0 THEN
    RAISE EXCEPTION 'this transaction holds that fixed-policy lock shared: a key is never upgraded' USING ERRCODE = '55000', DETAIL = 'lock_upgrade';
  END IF;
  IF highest_held IS NOT NULL AND lock_key < highest_held THEN
    RAISE EXCEPTION 'fixed-policy locks are taken in ascending order: take them together with melarc.lock_policy_keys' USING ERRCODE = '55000', DETAIL = 'lock_order';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(1296844337, lock_key);
END
$$;
--> statement-breakpoint
-- The exclusive keys of a seed or of a release step that creates or changes several policy objects, in the canonical order: every
-- bundle by its key ascending (two ids whose keys collide are one lock), then the fixed policies by ordinal. One call, so that a caller
-- cannot take them in another order. It is a definer so that the seed and a migration can call it without being able to call the
-- helpers it is made of, and it reads and writes no table.
CREATE FUNCTION melarc.lock_policy_keys(bundle_ids uuid[], fixed_types text[]) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  each_id uuid;
  each_type text;
BEGIN
  FOR each_id IN
    SELECT DISTINCT ON (melarc.policy_bundle_lock_key(b.id)) b.id
      FROM pg_catalog.unnest(bundle_ids) AS b(id)
     WHERE b.id IS NOT NULL
     ORDER BY melarc.policy_bundle_lock_key(b.id), b.id
  LOOP
    PERFORM melarc.lock_policy_bundle(each_id);
  END LOOP;
  FOR each_type IN
    SELECT t.type FROM pg_catalog.unnest(fixed_types) AS t(type) GROUP BY t.type
     ORDER BY melarc.policy_fixed_lock_key(t.type), t.type
  LOOP
    PERFORM melarc.lock_policy_fixed(each_type);
  END LOOP;
END
$$;
--> statement-breakpoint
-- How one attribute of a grant moved: SAME, WIDER (the new value reaches everything the old one did, and more), or OTHER (narrower,
-- not comparable, or not known: all of them are reductions). The hub scope is the chain none < own < all; the ownership scope has
-- `any` over `own` and over `assigned`, which are not ordered between themselves; the tier is the chain null < A < S < P, where null
-- is "not applicable" (domain-model.md section 6.9, OB-75) and never a ranked tier.
CREATE FUNCTION melarc.grant_attribute_change(attribute text, previous text, next text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE
    WHEN previous IS NOT DISTINCT FROM next THEN 'SAME'
    WHEN attribute = 'hub_scope' AND next = 'own' AND previous = 'none' THEN 'WIDER'
    WHEN attribute = 'hub_scope' AND next = 'all' AND previous IN ('none', 'own') THEN 'WIDER'
    WHEN attribute = 'ownership_scope' AND next = 'any' AND previous IN ('own', 'assigned') THEN 'WIDER'
    WHEN attribute = 'tier' AND next = 'A' AND previous IS NULL THEN 'WIDER'
    WHEN attribute = 'tier' AND next = 'S' AND (previous IS NULL OR previous = 'A') THEN 'WIDER'
    WHEN attribute = 'tier' AND next = 'P' AND (previous IS NULL OR previous IN ('A', 'S')) THEN 'WIDER'
    ELSE 'OTHER'
  END
$$;
--> statement-breakpoint
-- The capability's policies. One supported structure (a SYSTEM arm naming exactly one capability, a closed ELSE), the same as the
-- seed's. Nothing here admits a Staff, Vendor or Rider context.
CREATE POLICY "role_bundle_policy_change_read" ON "role_bundle" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'policy_change'
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "role_bundle_policy_change_update" ON "role_bundle" FOR UPDATE USING (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'policy_change'
    ELSE false
  END
) WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'policy_change'
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "role_bundle_grant_policy_change_read" ON "role_bundle_grant" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'policy_change'
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "role_bundle_grant_policy_change_insert" ON "role_bundle_grant" FOR INSERT WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'policy_change'
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "role_bundle_grant_policy_change_update" ON "role_bundle_grant" FOR UPDATE USING (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'policy_change'
    ELSE false
  END
) WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'policy_change'
    ELSE false
  END
);
--> statement-breakpoint
-- allow-delete: a change of a bundle's content removes the grants that are no longer in it, inside melarc.change_role_bundle only
CREATE POLICY "role_bundle_grant_policy_change_delete" ON "role_bundle_grant" FOR DELETE USING (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'policy_change'
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "fixed_permission_policy_policy_change_read" ON "fixed_permission_policy" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'policy_change'
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "fixed_permission_policy_policy_change_update" ON "fixed_permission_policy" FOR UPDATE USING (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'policy_change'
    ELSE false
  END
) WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'policy_change'
    ELSE false
  END
);
--> statement-breakpoint
-- The change of a bundle. `p_grants` is the complete new set of the bundle's grants as a JSON array of objects with exactly the keys
-- permission_key, hub_scope, ownership_scope and tier (tier null where the holder has none), or null to leave the grants alone;
-- `p_name` is the new name or null. Returns a JSON object: the kind of change (NONE, NAME_ONLY, ADDITION, REDUCTION), the bundle's
-- revision and floor, and the ids of the sessions it ended.
--
-- One transaction, in this order: the arguments are checked (no table is read); the exclusive lock of the bundle is taken, and
-- nothing is read before it; the current revision is read under it; the kind of change is decided on the diff; the new content and the
-- counters are written; and, for a REDUCTION, every live session of the bundle recorded below the new floor is ended with
-- AUTHORITY_CHANGED and given one enhanced auth.session.authority_revoked. An ADDITION raises the revision and ends nothing. A change
-- of the name alone raises nothing. It runs at read committed only, so that every read follows the lock.
CREATE FUNCTION melarc.change_role_bundle(p_bundle_id uuid, p_name text, p_grants jsonb, p_correlation_id text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  previous_type text := coalesce(pg_catalog.current_setting('melarc.principal_type', true), '');
  previous_capability text := coalesce(pg_catalog.current_setting('melarc.task_capability', true), '');
  current_revision integer;
  current_floor integer;
  current_name text;
  new_revision integer;
  kind text := 'NONE';
  removed boolean := false;
  narrowed boolean := false;
  widened boolean := false;
  each_grant record;
  changes text[];
  ended uuid[] := ARRAY[]::uuid[];
BEGIN
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'a bundle is changed at read committed isolation only' USING ERRCODE = '25000';
  END IF;
  -- The correlation id names a release step or an operation and is written to the ledger as it is: letters, digits and . _ : / # -,
  -- 1 to 128 of them. That is a check of shape and no screen for a secret or for data about a person: the caller passes an
  -- identifier it generated or a fixed label of the release step (a UUID, "release-2026.10#policy-1"), never text that a user typed.
  IF p_bundle_id IS NULL OR p_correlation_id IS NULL OR p_correlation_id !~ '^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,127}$' THEN
    RAISE EXCEPTION 'a bundle change names the bundle and carries a correlation id of 1 to 128 letters, digits and . _ : / # - (a release step or an operation)' USING ERRCODE = '22023';
  END IF;
  IF p_name IS NOT NULL AND pg_catalog.length(pg_catalog.btrim(p_name)) = 0 THEN
    RAISE EXCEPTION 'a bundle name is not empty' USING ERRCODE = '22023';
  END IF;
  IF p_grants IS NOT NULL THEN
    IF pg_catalog.jsonb_typeof(p_grants) <> 'array' THEN
      RAISE EXCEPTION 'the grants of a bundle are a JSON array of grants' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_catalog.jsonb_array_elements(p_grants) AS e
       WHERE CASE WHEN pg_catalog.jsonb_typeof(e) <> 'object' THEN true
                  ELSE (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(e)) <> 4
                       OR NOT (pg_catalog.jsonb_exists(e, 'permission_key') AND pg_catalog.jsonb_exists(e, 'hub_scope')
                               AND pg_catalog.jsonb_exists(e, 'ownership_scope') AND pg_catalog.jsonb_exists(e, 'tier'))
                       OR (e ->> 'permission_key') IS NULL
                       OR (e ->> 'hub_scope') IS NULL OR (e ->> 'hub_scope') NOT IN ('none', 'own', 'all')
                       OR (e ->> 'ownership_scope') IS NULL OR (e ->> 'ownership_scope') NOT IN ('own', 'assigned', 'any')
                       OR ((e ->> 'tier') IS NOT NULL AND (e ->> 'tier') NOT IN ('A', 'S', 'P'))
             END
    ) THEN
      RAISE EXCEPTION 'every grant has exactly a permission_key, a hub_scope (none, own, all), an ownership_scope (own, assigned, any) and a tier (A, S, P or null)' USING ERRCODE = '22023';
    END IF;
    IF (SELECT pg_catalog.count(*) <> pg_catalog.count(DISTINCT e ->> 'permission_key') FROM pg_catalog.jsonb_array_elements(p_grants) AS e) THEN
      RAISE EXCEPTION 'a bundle holds each permission once' USING ERRCODE = '22023';
    END IF;
  END IF;

  -- The exclusive lock first: nothing is read before it is held.
  PERFORM melarc.lock_policy_bundle(p_bundle_id);
  PERFORM pg_catalog.set_config('melarc.principal_type', 'SYSTEM', true);
  PERFORM pg_catalog.set_config('melarc.task_capability', 'policy_change', true);

  SELECT b.revision, b.reduction_floor, b.name INTO current_revision, current_floor, current_name
    FROM public.role_bundle AS b WHERE b.id = p_bundle_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'there is no such bundle' USING ERRCODE = 'P0002';
  END IF;

  IF p_grants IS NOT NULL THEN
    FOR each_grant IN
      SELECT o.permission_key AS old_key, o.hub_scope AS old_hub, o.ownership_scope AS old_ownership, o.tier AS old_tier,
             n.permission_key AS new_key, n.hub_scope AS new_hub, n.ownership_scope AS new_ownership, n.tier AS new_tier
        FROM (SELECT g.permission_key, g.hub_scope, g.ownership_scope, g.tier
                FROM public.role_bundle_grant AS g WHERE g.bundle_id = p_bundle_id) AS o
        FULL JOIN (SELECT e ->> 'permission_key' AS permission_key, e ->> 'hub_scope' AS hub_scope,
                          e ->> 'ownership_scope' AS ownership_scope, e ->> 'tier' AS tier
                     FROM pg_catalog.jsonb_array_elements(p_grants) AS e) AS n
          ON n.permission_key = o.permission_key
    LOOP
      IF each_grant.new_key IS NULL THEN
        removed := true;
      ELSIF each_grant.old_key IS NULL THEN
        widened := true;
      ELSE
        changes := ARRAY[
          melarc.grant_attribute_change('hub_scope', each_grant.old_hub, each_grant.new_hub),
          melarc.grant_attribute_change('ownership_scope', each_grant.old_ownership, each_grant.new_ownership),
          melarc.grant_attribute_change('tier', each_grant.old_tier, each_grant.new_tier)
        ];
        IF 'OTHER' = ANY (changes) THEN narrowed := true;
        ELSIF 'WIDER' = ANY (changes) THEN widened := true;
        END IF;
      END IF;
    END LOOP;
    IF removed OR narrowed THEN
      kind := 'REDUCTION';
    ELSIF widened THEN
      kind := 'ADDITION';
    END IF;
  END IF;

  IF kind = 'NONE' THEN
    IF p_name IS NOT NULL AND p_name <> current_name THEN
      UPDATE public.role_bundle SET name = p_name WHERE id = p_bundle_id;
      kind := 'NAME_ONLY';
    END IF;
  ELSE
    new_revision := current_revision + 1;
    DELETE FROM public.role_bundle_grant AS o
     WHERE o.bundle_id = p_bundle_id
       AND NOT EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(p_grants) AS e WHERE e ->> 'permission_key' = o.permission_key);
    INSERT INTO public.role_bundle_grant (bundle_id, permission_key, hub_scope, ownership_scope, tier)
      SELECT p_bundle_id, e ->> 'permission_key', e ->> 'hub_scope', e ->> 'ownership_scope', e ->> 'tier'
        FROM pg_catalog.jsonb_array_elements(p_grants) AS e
      ON CONFLICT (bundle_id, permission_key)
      DO UPDATE SET hub_scope = excluded.hub_scope, ownership_scope = excluded.ownership_scope, tier = excluded.tier
      WHERE (role_bundle_grant.hub_scope, role_bundle_grant.ownership_scope, role_bundle_grant.tier)
            IS DISTINCT FROM (excluded.hub_scope, excluded.ownership_scope, excluded.tier);
    UPDATE public.role_bundle
       SET revision = new_revision,
           reduction_floor = CASE WHEN kind = 'REDUCTION' THEN new_revision ELSE reduction_floor END,
           name = coalesce(p_name, name)
     WHERE id = p_bundle_id;

    IF kind = 'REDUCTION' THEN
      -- Ending a session is the very state change a reduction makes, so these statements take session rows (in id order) and no
      -- policy lock; they and the audit run under the authentication capability, which has the policies for both.
      PERFORM pg_catalog.set_config('melarc.task_capability', 'authentication', true);
      WITH locked AS (
        SELECT s.id FROM public.session AS s
         WHERE s.bundle_id = p_bundle_id AND s.terminated_at IS NULL AND s.bundle_revision < new_revision
         ORDER BY s.id FOR UPDATE
      ), done AS (
        UPDATE public.session AS s
           SET terminated_at = greatest(pg_catalog.clock_timestamp(), s.issued_at), termination_reason = 'AUTHORITY_CHANGED'
          FROM locked WHERE s.id = locked.id
        RETURNING s.id
      ), written AS (
        INSERT INTO public.audit_event (id, event_code, occurred_at, actor_type, actor_id, surface_context, object_type, object_id,
                                        correlation_id, reason_code, reason_label, related_ids, before_after, detail, outcome,
                                        enhanced, serialisation_version)
          SELECT pg_catalog.uuidv7(), 'auth.session.authority_revoked', pg_catalog.clock_timestamp(), 'SYSTEM', NULL, 'SYSTEM',
                 'Session', done.id, p_correlation_id, 'AUTHORITY_CHANGED', 'Authority changed',
                 pg_catalog.jsonb_build_object('bundle_id', p_bundle_id, 'revision', new_revision, 'reduction_floor', new_revision),
                 '{"session": "ACTIVE_TO_TERMINATED"}'::pg_catalog.jsonb, '{}'::pg_catalog.jsonb, 'SUCCEEDED', true, 1
            FROM done
      )
      SELECT coalesce(pg_catalog.array_agg(done.id ORDER BY done.id), ARRAY[]::uuid[]) INTO ended FROM done;
      PERFORM pg_catalog.set_config('melarc.task_capability', 'policy_change', true);
    END IF;
  END IF;

  PERFORM pg_catalog.set_config('melarc.principal_type', previous_type, true);
  PERFORM pg_catalog.set_config('melarc.task_capability', previous_capability, true);
  RETURN pg_catalog.jsonb_build_object(
    'kind', kind,
    'revision', coalesce(new_revision, current_revision),
    'reduction_floor', CASE WHEN kind = 'REDUCTION' THEN new_revision ELSE current_floor END,
    'ended', pg_catalog.to_jsonb(ended)
  );
END
$$;
--> statement-breakpoint
-- The matching change of the compiled fixed policy of the Vendor or the Rider (SECURITY_DESIGN.md section 13.10, "Fixed Vendor and
-- Rider authority"). The compiled rules are code and not rows, so the release states whether it reduced them. It raises the revision by
-- one; a reduction also raises the minimum to it and ends every live session of that audience recorded under a lower policy revision
-- (or under none: such a session cannot be trusted), with AUTHORITY_CHANGED and one enhanced auth.session.authority_revoked each. It
-- takes the fixed-policy lock, after any bundle lock of the same transaction.
CREATE FUNCTION melarc.change_fixed_policy(p_principal_type text, p_reduction boolean, p_correlation_id text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  previous_type text := coalesce(pg_catalog.current_setting('melarc.principal_type', true), '');
  previous_capability text := coalesce(pg_catalog.current_setting('melarc.task_capability', true), '');
  current_revision integer;
  current_minimum integer;
  new_revision integer;
  ended uuid[] := ARRAY[]::uuid[];
BEGIN
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'a fixed policy is changed at read committed isolation only' USING ERRCODE = '25000';
  END IF;
  IF p_reduction IS NULL OR p_correlation_id IS NULL OR p_correlation_id !~ '^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,127}$' THEN
    RAISE EXCEPTION 'a fixed-policy change states whether it reduces the policy and carries a correlation id of 1 to 128 letters, digits and . _ : / # - (a release step or an operation)' USING ERRCODE = '22023';
  END IF;

  PERFORM melarc.lock_policy_fixed(p_principal_type);
  PERFORM pg_catalog.set_config('melarc.principal_type', 'SYSTEM', true);
  PERFORM pg_catalog.set_config('melarc.task_capability', 'policy_change', true);

  SELECT f.revision, f.minimum_revision INTO current_revision, current_minimum
    FROM public.fixed_permission_policy AS f WHERE f.principal_type = p_principal_type FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'there is no fixed policy for that audience' USING ERRCODE = 'P0002';
  END IF;
  new_revision := current_revision + 1;
  UPDATE public.fixed_permission_policy
     SET revision = new_revision, minimum_revision = CASE WHEN p_reduction THEN new_revision ELSE minimum_revision END
   WHERE principal_type = p_principal_type;

  IF p_reduction THEN
    PERFORM pg_catalog.set_config('melarc.task_capability', 'authentication', true);
    WITH locked AS (
      SELECT s.id FROM public.session AS s
       WHERE s.principal_type = p_principal_type AND s.terminated_at IS NULL
         AND (s.policy_revision IS NULL OR s.policy_revision < new_revision)
       ORDER BY s.id FOR UPDATE
    ), done AS (
      UPDATE public.session AS s
         SET terminated_at = greatest(pg_catalog.clock_timestamp(), s.issued_at), termination_reason = 'AUTHORITY_CHANGED'
        FROM locked WHERE s.id = locked.id
      RETURNING s.id
    ), written AS (
      INSERT INTO public.audit_event (id, event_code, occurred_at, actor_type, actor_id, surface_context, object_type, object_id,
                                      correlation_id, reason_code, reason_label, related_ids, before_after, detail, outcome,
                                      enhanced, serialisation_version)
        SELECT pg_catalog.uuidv7(), 'auth.session.authority_revoked', pg_catalog.clock_timestamp(), 'SYSTEM', NULL, 'SYSTEM',
               'Session', done.id, p_correlation_id, 'AUTHORITY_CHANGED', 'Authority changed',
               pg_catalog.jsonb_build_object('principal_type', p_principal_type, 'minimum_revision', new_revision),
               '{"session": "ACTIVE_TO_TERMINATED"}'::pg_catalog.jsonb, '{}'::pg_catalog.jsonb, 'SUCCEEDED', true, 1
          FROM done
    )
    SELECT coalesce(pg_catalog.array_agg(done.id ORDER BY done.id), ARRAY[]::uuid[]) INTO ended FROM done;
  END IF;

  PERFORM pg_catalog.set_config('melarc.principal_type', previous_type, true);
  PERFORM pg_catalog.set_config('melarc.task_capability', previous_capability, true);
  RETURN pg_catalog.jsonb_build_object(
    'kind', CASE WHEN p_reduction THEN 'REDUCTION' ELSE 'ADDITION' END,
    'revision', new_revision,
    'minimum_revision', CASE WHEN p_reduction THEN new_revision ELSE current_minimum END,
    'ended', pg_catalog.to_jsonb(ended)
  );
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.policy_bundle_lock_key(uuid) OWNER TO melarc_owner;
--> statement-breakpoint
ALTER FUNCTION melarc.policy_fixed_lock_key(text) OWNER TO melarc_owner;
--> statement-breakpoint
ALTER FUNCTION melarc.lock_policy_bundle(uuid) OWNER TO melarc_owner;
--> statement-breakpoint
ALTER FUNCTION melarc.lock_policy_fixed(text) OWNER TO melarc_owner;
--> statement-breakpoint
ALTER FUNCTION melarc.lock_policy_keys(uuid[], text[]) OWNER TO melarc_owner;
--> statement-breakpoint
ALTER FUNCTION melarc.grant_attribute_change(text, text, text) OWNER TO melarc_owner;
--> statement-breakpoint
ALTER FUNCTION melarc.change_role_bundle(uuid, text, jsonb, text) OWNER TO melarc_owner;
--> statement-breakpoint
ALTER FUNCTION melarc.change_fixed_policy(text, boolean, text) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.policy_bundle_lock_key(uuid) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.policy_fixed_lock_key(text) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.lock_policy_bundle(uuid) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.lock_policy_fixed(text) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.lock_policy_keys(uuid[], text[]) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.grant_attribute_change(text, text, text) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.change_role_bundle(uuid, text, jsonb, text) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.change_fixed_policy(text, boolean, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.change_role_bundle(uuid, text, jsonb, text) TO melarc_migration_elevated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.change_fixed_policy(text, boolean, text) TO melarc_migration_elevated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.lock_policy_keys(uuid[], text[]) TO melarc_migration_elevated, melarc_provisioning;
