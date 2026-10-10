-- Initial seeding enforced by the database (correction F02 of Stage 1). Applied as melarc_migration_elevated, a member of melarc_owner
-- (MIGRATION_AND_SEEDING.md section 5.1). 0004 gave the provisioning login SELECT and INSERT on the seven reference tables and left
-- "the table is empty" to the seed helper's own count, so the application, not the database, was what made an initialization happen
-- once: the login, with the seed label asserted, could still add a permission to an existing bundle after the seed had run, with no
-- raise of the bundle's revision. This migration moves the rule into the database.
--
-- The mechanism, and why it is the smallest that holds:
--
--   * The provisioning login holds no privilege on any of the seven tables from here on (REVOKE below). The label is not what stops it
--     writing: it has no INSERT to assert the label against.
--   * Two SECURITY DEFINER functions, owned by melarc_owner, are the only ways in, and EXECUTE on them is granted to melarc_provisioning
--     alone (revoked from PUBLIC; not the API runtime, not the worker): melarc.initialize_reference_data (the seven tables, once) and
--     melarc.add_reason_fixtures (the test-only reason fixtures, which write FIXTURE_ codes and nothing else). They take their rows as one
--     JSON document, name every table and column in their own text (no dynamic statement, no object name from the caller), fix their
--     search_path and qualify every table.
--   * Once, atomically, serialized: the initialization takes SHARE ROW EXCLUSIVE on all seven tables in one fixed order (it conflicts with
--     itself and with every writer, not with readers), then counts every table, and refuses (SQLSTATE 55000, naming the table and its
--     rows) unless all seven are empty. A concurrent initialization waits for the first to end, then finds the tables filled and refuses;
--     one that failed or was rolled back left nothing, so the next one runs. The function is one statement of the caller's transaction, so
--     a failure at any table (a trigger, a constraint, a short insert) undoes every table. It runs at read committed only, because a
--     snapshot taken before the wait would count the tables as they were before the first initialization committed.
--   * The row-level security policies of 0004 stay the second line: the function sets the SYSTEM context and the seed capability itself,
--     transaction-locally, for its own statements, and puts back what the caller had set. Nothing the caller sets is read as proof.
--     A policy that needs a self-referencing "is the table empty" subquery was not used: it cannot see rows its own statement is
--     inserting, takes no lock, and a second transaction sees the same empty table.
--
-- The policy changes a bundle's grants after the seed belong to SLICE-009 (S0.27), under the exclusive policy lock; nothing here
-- gives that, or any, controlled change.

REVOKE SELECT, INSERT ON "hub" FROM melarc_provisioning;
--> statement-breakpoint
REVOKE SELECT, INSERT ON "permission" FROM melarc_provisioning;
--> statement-breakpoint
REVOKE SELECT, INSERT ON "role_bundle" FROM melarc_provisioning;
--> statement-breakpoint
REVOKE SELECT, INSERT ON "role_bundle_grant" FROM melarc_provisioning;
--> statement-breakpoint
REVOKE SELECT, INSERT ON "fixed_permission_policy" FROM melarc_provisioning;
--> statement-breakpoint
REVOKE SELECT, INSERT ON "setting" FROM melarc_provisioning;
--> statement-breakpoint
REVOKE SELECT, INSERT ON "reason_code" FROM melarc_provisioning;
--> statement-breakpoint
CREATE FUNCTION melarc.initialize_reference_data(payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  previous_type text := coalesce(pg_catalog.current_setting('melarc.principal_type', true), '');
  previous_capability text := coalesce(pg_catalog.current_setting('melarc.task_capability', true), '');
  found bigint;
  inserted bigint;
  planned bigint;
  report jsonb := '{}'::jsonb;
BEGIN
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'reference data is initialized at read committed isolation only' USING ERRCODE = '25000';
  END IF;
  IF payload IS NULL OR pg_catalog.jsonb_typeof(payload) <> 'object' THEN
    RAISE EXCEPTION 'the payload is one JSON object, with an array of rows for each of the seven tables' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_object_keys(payload) AS k
     WHERE k NOT IN ('hub', 'permission', 'role_bundle', 'role_bundle_grant', 'fixed_permission_policy', 'setting', 'reason_code')
  ) THEN
    RAISE EXCEPTION 'the payload names a table that is not part of the initialization' USING ERRCODE = '22023';
  END IF;
  IF (
    SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_each(payload) AS e
     WHERE pg_catalog.jsonb_typeof(e.value) = 'array' AND pg_catalog.jsonb_array_length(e.value) > 0
  ) <> 7 THEN
    RAISE EXCEPTION 'the payload carries a non-empty array of rows for each of the seven tables' USING ERRCODE = '22023';
  END IF;

  -- One order for every caller, so that two initializations wait for each other and never for each other's second table.
  LOCK TABLE public.hub, public.permission, public.role_bundle, public.role_bundle_grant,
             public.fixed_permission_policy, public.setting, public.reason_code
    IN SHARE ROW EXCLUSIVE MODE;

  -- The seed label is set for this function's own statements, so that the counts below see every row and the inserts meet the
  -- policies of 0004; the caller's values come back at the end.
  PERFORM pg_catalog.set_config('melarc.principal_type', 'SYSTEM', true);
  PERFORM pg_catalog.set_config('melarc.task_capability', 'seed', true);

  SELECT pg_catalog.count(*) INTO found FROM public.hub;
  IF found <> 0 THEN
    RAISE EXCEPTION 'reference data is already initialized: table hub holds % rows', found
      USING ERRCODE = '55000', TABLE = 'hub', DETAIL = pg_catalog.format('rows=%s', found);
  END IF;
  SELECT pg_catalog.count(*) INTO found FROM public.permission;
  IF found <> 0 THEN
    RAISE EXCEPTION 'reference data is already initialized: table permission holds % rows', found
      USING ERRCODE = '55000', TABLE = 'permission', DETAIL = pg_catalog.format('rows=%s', found);
  END IF;
  SELECT pg_catalog.count(*) INTO found FROM public.role_bundle;
  IF found <> 0 THEN
    RAISE EXCEPTION 'reference data is already initialized: table role_bundle holds % rows', found
      USING ERRCODE = '55000', TABLE = 'role_bundle', DETAIL = pg_catalog.format('rows=%s', found);
  END IF;
  SELECT pg_catalog.count(*) INTO found FROM public.role_bundle_grant;
  IF found <> 0 THEN
    RAISE EXCEPTION 'reference data is already initialized: table role_bundle_grant holds % rows', found
      USING ERRCODE = '55000', TABLE = 'role_bundle_grant', DETAIL = pg_catalog.format('rows=%s', found);
  END IF;
  SELECT pg_catalog.count(*) INTO found FROM public.fixed_permission_policy;
  IF found <> 0 THEN
    RAISE EXCEPTION 'reference data is already initialized: table fixed_permission_policy holds % rows', found
      USING ERRCODE = '55000', TABLE = 'fixed_permission_policy', DETAIL = pg_catalog.format('rows=%s', found);
  END IF;
  SELECT pg_catalog.count(*) INTO found FROM public.setting;
  IF found <> 0 THEN
    RAISE EXCEPTION 'reference data is already initialized: table setting holds % rows', found
      USING ERRCODE = '55000', TABLE = 'setting', DETAIL = pg_catalog.format('rows=%s', found);
  END IF;
  SELECT pg_catalog.count(*) INTO found FROM public.reason_code;
  IF found <> 0 THEN
    RAISE EXCEPTION 'reference data is already initialized: table reason_code holds % rows', found
      USING ERRCODE = '55000', TABLE = 'reason_code', DETAIL = pg_catalog.format('rows=%s', found);
  END IF;

  -- The columns each table takes from the payload are named here. Revisions and floors are not among them: a bundle and a fixed
  -- policy start at revision 1 and floor 1, which are the tables' defaults.
  planned := pg_catalog.jsonb_array_length(payload -> 'hub');
  INSERT INTO public.hub (id, name)
    SELECT r.id, r.name FROM pg_catalog.jsonb_populate_recordset(NULL::public.hub, payload -> 'hub') AS r;
  GET DIAGNOSTICS inserted = ROW_COUNT;
  IF inserted <> planned THEN
    RAISE EXCEPTION 'table hub received % of % rows', inserted, planned USING ERRCODE = '22023', TABLE = 'hub';
  END IF;
  report := report || pg_catalog.jsonb_build_object('hub', inserted);

  planned := pg_catalog.jsonb_array_length(payload -> 'permission');
  INSERT INTO public.permission (key, domain)
    SELECT r.key, r.domain FROM pg_catalog.jsonb_populate_recordset(NULL::public.permission, payload -> 'permission') AS r;
  GET DIAGNOSTICS inserted = ROW_COUNT;
  IF inserted <> planned THEN
    RAISE EXCEPTION 'table permission received % of % rows', inserted, planned USING ERRCODE = '22023', TABLE = 'permission';
  END IF;
  report := report || pg_catalog.jsonb_build_object('permission', inserted);

  planned := pg_catalog.jsonb_array_length(payload -> 'role_bundle');
  INSERT INTO public.role_bundle (id, name, audience, privileged)
    SELECT r.id, r.name, r.audience, r.privileged
      FROM pg_catalog.jsonb_populate_recordset(NULL::public.role_bundle, payload -> 'role_bundle') AS r;
  GET DIAGNOSTICS inserted = ROW_COUNT;
  IF inserted <> planned THEN
    RAISE EXCEPTION 'table role_bundle received % of % rows', inserted, planned USING ERRCODE = '22023', TABLE = 'role_bundle';
  END IF;
  report := report || pg_catalog.jsonb_build_object('role_bundle', inserted);

  planned := pg_catalog.jsonb_array_length(payload -> 'role_bundle_grant');
  INSERT INTO public.role_bundle_grant (bundle_id, permission_key, hub_scope, ownership_scope, tier)
    SELECT r.bundle_id, r.permission_key, r.hub_scope, r.ownership_scope, r.tier
      FROM pg_catalog.jsonb_populate_recordset(NULL::public.role_bundle_grant, payload -> 'role_bundle_grant') AS r;
  GET DIAGNOSTICS inserted = ROW_COUNT;
  IF inserted <> planned THEN
    RAISE EXCEPTION 'table role_bundle_grant received % of % rows', inserted, planned USING ERRCODE = '22023', TABLE = 'role_bundle_grant';
  END IF;
  report := report || pg_catalog.jsonb_build_object('role_bundle_grant', inserted);

  planned := pg_catalog.jsonb_array_length(payload -> 'fixed_permission_policy');
  INSERT INTO public.fixed_permission_policy (principal_type)
    SELECT r.principal_type
      FROM pg_catalog.jsonb_populate_recordset(NULL::public.fixed_permission_policy, payload -> 'fixed_permission_policy') AS r;
  GET DIAGNOSTICS inserted = ROW_COUNT;
  IF inserted <> planned THEN
    RAISE EXCEPTION 'table fixed_permission_policy received % of % rows', inserted, planned USING ERRCODE = '22023', TABLE = 'fixed_permission_policy';
  END IF;
  report := report || pg_catalog.jsonb_build_object('fixed_permission_policy', inserted);

  planned := pg_catalog.jsonb_array_length(payload -> 'setting');
  INSERT INTO public.setting (key, scope, value_type, value, unit, description)
    SELECT r.key, r.scope, r.value_type, r.value, r.unit, r.description
      FROM pg_catalog.jsonb_populate_recordset(NULL::public.setting, payload -> 'setting') AS r;
  GET DIAGNOSTICS inserted = ROW_COUNT;
  IF inserted <> planned THEN
    RAISE EXCEPTION 'table setting received % of % rows', inserted, planned USING ERRCODE = '22023', TABLE = 'setting';
  END IF;
  report := report || pg_catalog.jsonb_build_object('setting', inserted);

  planned := pg_catalog.jsonb_array_length(payload -> 'reason_code');
  INSERT INTO public.reason_code (code, domain, valid_checkpoints, label, requires_note, requires_photo, requires_contact_attempt,
                                  requires_approval, attribution, consumes_delivery_attempt, requires_ops_review, requires_escalation,
                                  active, permitted_operations)
    SELECT r.code, r.domain, r.valid_checkpoints, r.label, r.requires_note, r.requires_photo, r.requires_contact_attempt,
           r.requires_approval, r.attribution, r.consumes_delivery_attempt, r.requires_ops_review, r.requires_escalation,
           r.active, r.permitted_operations
      FROM pg_catalog.jsonb_populate_recordset(NULL::public.reason_code, payload -> 'reason_code') AS r;
  GET DIAGNOSTICS inserted = ROW_COUNT;
  IF inserted <> planned THEN
    RAISE EXCEPTION 'table reason_code received % of % rows', inserted, planned USING ERRCODE = '22023', TABLE = 'reason_code';
  END IF;
  report := report || pg_catalog.jsonb_build_object('reason_code', inserted);

  PERFORM pg_catalog.set_config('melarc.principal_type', previous_type, true);
  PERFORM pg_catalog.set_config('melarc.task_capability', previous_capability, true);
  RETURN report;
END
$$;
--> statement-breakpoint
CREATE FUNCTION melarc.add_reason_fixtures(payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  previous_type text := coalesce(pg_catalog.current_setting('melarc.principal_type', true), '');
  previous_capability text := coalesce(pg_catalog.current_setting('melarc.task_capability', true), '');
  found bigint;
  inserted bigint;
  planned bigint;
BEGIN
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'reason fixtures are added at read committed isolation only' USING ERRCODE = '25000';
  END IF;
  IF payload IS NULL OR pg_catalog.jsonb_typeof(payload) <> 'object'
     OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(payload)) <> 1
     OR pg_catalog.jsonb_typeof(payload -> 'reason_code') IS DISTINCT FROM 'array'
     OR pg_catalog.jsonb_array_length(payload -> 'reason_code') = 0 THEN
    RAISE EXCEPTION 'the payload is one JSON object with a non-empty array of reason_code rows' USING ERRCODE = '22023';
  END IF;
  -- A fixture is a reason whose code starts with FIXTURE_. Nothing else is written through here.
  IF EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_populate_recordset(NULL::public.reason_code, payload -> 'reason_code') AS r
     WHERE r.code IS NULL OR r.code NOT LIKE 'FIXTURE\_%'
  ) THEN
    RAISE EXCEPTION 'every reason added here has a code that starts with FIXTURE_' USING ERRCODE = '22023', TABLE = 'reason_code';
  END IF;

  LOCK TABLE public.reason_code IN SHARE ROW EXCLUSIVE MODE;
  PERFORM pg_catalog.set_config('melarc.principal_type', 'SYSTEM', true);
  PERFORM pg_catalog.set_config('melarc.task_capability', 'seed', true);

  SELECT pg_catalog.count(*) INTO found FROM public.reason_code WHERE code LIKE 'FIXTURE\_%';
  IF found <> 0 THEN
    RAISE EXCEPTION 'the reason fixtures are already present: table reason_code holds % of them', found
      USING ERRCODE = '55000', TABLE = 'reason_code', DETAIL = pg_catalog.format('rows=%s', found);
  END IF;

  planned := pg_catalog.jsonb_array_length(payload -> 'reason_code');
  INSERT INTO public.reason_code (code, domain, valid_checkpoints, label, requires_note, requires_photo, requires_contact_attempt,
                                  requires_approval, attribution, consumes_delivery_attempt, requires_ops_review, requires_escalation,
                                  active, permitted_operations)
    SELECT r.code, r.domain, r.valid_checkpoints, r.label, r.requires_note, r.requires_photo, r.requires_contact_attempt,
           r.requires_approval, r.attribution, r.consumes_delivery_attempt, r.requires_ops_review, r.requires_escalation,
           r.active, r.permitted_operations
      FROM pg_catalog.jsonb_populate_recordset(NULL::public.reason_code, payload -> 'reason_code') AS r;
  GET DIAGNOSTICS inserted = ROW_COUNT;
  IF inserted <> planned THEN
    RAISE EXCEPTION 'table reason_code received % of % rows', inserted, planned USING ERRCODE = '22023', TABLE = 'reason_code';
  END IF;

  PERFORM pg_catalog.set_config('melarc.principal_type', previous_type, true);
  PERFORM pg_catalog.set_config('melarc.task_capability', previous_capability, true);
  RETURN pg_catalog.jsonb_build_object('reason_code', inserted);
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.initialize_reference_data(jsonb) OWNER TO melarc_owner;
--> statement-breakpoint
ALTER FUNCTION melarc.add_reason_fixtures(jsonb) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.initialize_reference_data(jsonb) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.add_reason_fixtures(jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.initialize_reference_data(jsonb) TO melarc_provisioning;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.add_reason_fixtures(jsonb) TO melarc_provisioning;
