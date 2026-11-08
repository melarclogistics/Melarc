-- S1.8 (SLICE-001), found by the release of SLICE-001 itself: a new database starts its fixed policy at the revision of the build that
-- seeds it. Applied as melarc_migration_elevated, a member of melarc_owner (MIGRATION_AND_SEEDING.md section 5.1).
--
-- Why. `melarc.change_fixed_policy` (0017) raises the *stored* revision by one and, for a reduction, sets the floor to the new stored
-- revision; the compiled revision a build declares has to equal it. The seed wrote revision 1 whatever the build declared. That was
-- right while every build declared 1; a build that declares 2 (the keys of SLICE-001, migration 0043) seeded onto a new database left
-- the stored revision at 1, and the next reduction, which raises the floor to 2, would have ended no session issued under 2: a
-- reduction that does not reduce. A database seeded earlier is brought to the build's revision by the release step that follows it
-- (0043 for this release); a new database is migrated before it is seeded, so no release step can reach it, and the seed has to start
-- where the steps would have left it. SECURITY_DESIGN.md section 13.10 says the same in other words: the database holds, per type,
-- *the latest released* revision.
--
--   * The seed-insert policy of the fixed policy admitted revision 1 only (0004). It now admits any revision from 1 and a floor of 1,
--     named in the policy, because the floor was pinned to 1 only through the table's range check (1 <= floor <= revision) while the
--     revision was pinned to 1. A seed that started reduced would end the first sessions it could issue; this one cannot.
--   * melarc.initialize_reference_data is replaced by itself, the text of 0005 with one change: the fixed-policy insert names the
--     revision as well as the audience and takes it from the payload (1 where the payload names none, as the seed of 27 October 2026
--     did not). CREATE OR REPLACE keeps the owner, the search_path, the revoked PUBLIC privilege and the one EXECUTE grant to
--     melarc_provisioning, and the statements after it restate them (as 0021 did), so the migration is right whoever ran the earlier
--     ones. The table's own checks bound the number (a positive integer).
--   * Nothing else changes, and the payload of an older seed (no revision) still works: test/database/support/earlier-seed.ts uses one.

DROP POLICY "fixed_permission_policy_seed_insert" ON "fixed_permission_policy";
--> statement-breakpoint
CREATE POLICY "fixed_permission_policy_seed_insert" ON "fixed_permission_policy" FOR INSERT WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'seed' AND revision >= 1 AND minimum_revision = 1
    ELSE false
  END
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION melarc.initialize_reference_data(payload jsonb) RETURNS jsonb
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

  -- The columns each table takes from the payload are named here. A floor is never among them: a bundle and a fixed policy start at
  -- floor 1, and a bundle at revision 1 too, which are the tables' defaults. A fixed policy takes its revision from the payload (migration
  -- 0046): it is the latest released revision of the build that seeds, and 1 where the payload names none.
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
  INSERT INTO public.fixed_permission_policy (principal_type, revision)
    SELECT r.principal_type, coalesce(r.revision, 1)
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
ALTER FUNCTION melarc.initialize_reference_data(jsonb) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.initialize_reference_data(jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.initialize_reference_data(jsonb) TO melarc_provisioning;
