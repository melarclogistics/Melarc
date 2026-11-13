-- D-A4 (OB-S1-73; the Product Owner's decision of 11 November 2026) and the evidence photo of a failed stop (S1.28, the first owner of S1.11's evidence).
-- Applied as melarc_migration_elevated, a member of melarc_owner (MIGRATION_AND_SEEDING.md section 5.1).
--
--   * A failure reason belongs to ONE of the four fixed failure categories, and the catalogue holds it (reason_code.failure_category). The categories carry the rules that
--     must not be stepped around by pairing: the door wait of VENDOR_UNAVAILABLE (OB-S1-69) and the escalation-only rule of REFUSED_COLLECTION (AC-SLICE-001-33). The column is
--     mandatory for the PICKUP_FAILURE domain and null for every other (a check). The eight reasons are bound as domain-model.md section 3.9 reads them (two under each category,
--     in the order of pickup-failure.md section 5.1; the pairing is the provisional reading of that table, which is the Product Owner's to confirm). A database seeded earlier gets
--     the categories here, once, under the seed capability, through a policy of the update that exists for this migration alone (reason_code has no standing update path: the
--     runtime holds SELECT only and the seed INSERT); a database that has not been seeded gets the same rows from the seed (tools/seed/workflow-reasons.ts), whose functions
--     melarc.initialize_reference_data and melarc.add_reason_fixtures are restated below with the new column.
--   * The stop's guard (melarc.pickup_stop_guard, as 0073 made it) holds the pairing for every writer: the snapshot's reason is the one whose category is the stop's. It also holds the
--     photo: a failure whose reason requires one (reason_code.requires_photo, read from the catalogue and never hard-coded) is refused unless the stop has evidence attached, which
--     replaces the refusal "no evidence can be stored yet".
--   * pickup_stop_evidence is the link between a failed stop and the stored evidence the rider attached to its failure: append-only, one row for each record of evidence (the record
--     is the key, so it is attached once), and a guard that holds, for every writer, that only STORED evidence about this very stop, captured by the rider as the proof of the
--     collection, is attached, to a stop the rider has arrived at on a run in progress that is assigned to it. The stop's lock is taken before anything is judged (as the collection
--     record's guard takes it), so a skip or a failure that began after the stop was read as arrived cannot commit beside a link.
ALTER TABLE "reason_code" ADD COLUMN "failure_category" text;
--> statement-breakpoint
-- The update policy exists for this migration alone and is dropped below: a SYSTEM arm names one capability and the domain it may touch.
CREATE POLICY "reason_code_seed_category" ON "reason_code" FOR UPDATE USING (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'seed' AND "reason_code"."domain" = 'PICKUP_FAILURE'
    ELSE false
  END
) WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'seed' AND "reason_code"."domain" = 'PICKUP_FAILURE'
    ELSE false
  END
);
--> statement-breakpoint
DO $failure_categories$
DECLARE
  previous_type text := coalesce(pg_catalog.current_setting('melarc.principal_type', true), '');
  previous_capability text := coalesce(pg_catalog.current_setting('melarc.task_capability', true), '');
BEGIN
  PERFORM pg_catalog.set_config('melarc.principal_type', 'SYSTEM', true);
  PERFORM pg_catalog.set_config('melarc.task_capability', 'seed', true);
  UPDATE public.reason_code AS held SET failure_category = v.category
    FROM (VALUES
      ('VENDOR_NOT_AT_LOCATION', 'VENDOR_UNAVAILABLE'),
      ('VENDOR_UNREACHABLE_BY_PHONE', 'VENDOR_UNAVAILABLE'),
      ('ENTRY_REFUSED_BY_SECURITY', 'ACCESS_DENIED'),
      ('LOCATION_CLOSED', 'ACCESS_DENIED'),
      ('PARCELS_NOT_PACKED', 'PARCEL_NOT_READY'),
      ('VENDOR_ASKED_TO_COME_BACK_LATER', 'PARCEL_NOT_READY'),
      ('VENDOR_REFUSED_HANDOVER', 'REFUSED_COLLECTION'),
      ('PARCEL_NOT_ACCEPTABLE', 'REFUSED_COLLECTION')
    ) AS v(code, category)
   WHERE held.code = v.code AND held.domain = 'PICKUP_FAILURE';
  PERFORM pg_catalog.set_config('melarc.principal_type', previous_type, true);
  PERFORM pg_catalog.set_config('melarc.task_capability', previous_capability, true);
END
$failure_categories$;
--> statement-breakpoint
DROP POLICY "reason_code_seed_category" ON "reason_code";
--> statement-breakpoint
ALTER TABLE "reason_code" ADD CONSTRAINT "reason_code_failure_category_by_domain" CHECK (("reason_code"."domain" = 'PICKUP_FAILURE' AND "reason_code"."failure_category" IS NOT NULL AND "reason_code"."failure_category" IN ('VENDOR_UNAVAILABLE', 'ACCESS_DENIED', 'PARCEL_NOT_READY', 'REFUSED_COLLECTION')) OR ("reason_code"."domain" <> 'PICKUP_FAILURE' AND "reason_code"."failure_category" IS NULL));
--> statement-breakpoint
-- The reference seed and the reason fixtures as 0046 and 0005 made them, with the one new column in the insert of the catalogue (the payload row names it; a row that does not is null).
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
                                  active, permitted_operations, failure_category)
    SELECT r.code, r.domain, r.valid_checkpoints, r.label, r.requires_note, r.requires_photo, r.requires_contact_attempt,
           r.requires_approval, r.attribution, r.consumes_delivery_attempt, r.requires_ops_review, r.requires_escalation,
           r.active, r.permitted_operations, r.failure_category
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
CREATE OR REPLACE FUNCTION melarc.add_reason_fixtures(payload jsonb) RETURNS jsonb
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
                                  active, permitted_operations, failure_category)
    SELECT r.code, r.domain, r.valid_checkpoints, r.label, r.requires_note, r.requires_photo, r.requires_contact_attempt,
           r.requires_approval, r.attribution, r.consumes_delivery_attempt, r.requires_ops_review, r.requires_escalation,
           r.active, r.permitted_operations, r.failure_category
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
--> statement-breakpoint
CREATE TABLE "pickup_stop_evidence" (
	"evidence_id" uuid PRIMARY KEY NOT NULL,
	"pickup_stop_id" uuid NOT NULL,
	"responsible_hub_id" uuid NOT NULL,
	"attached_by_rider" uuid NOT NULL,
	"attached_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pickup_stop_evidence" ADD CONSTRAINT "pickup_stop_evidence_evidence_fkey" FOREIGN KEY ("evidence_id") REFERENCES "public"."evidence"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pickup_stop_evidence" ADD CONSTRAINT "pickup_stop_evidence_stop_fkey" FOREIGN KEY ("pickup_stop_id","responsible_hub_id") REFERENCES "public"."pickup_stop"("id","responsible_hub_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pickup_stop_evidence" ADD CONSTRAINT "pickup_stop_evidence_rider_fkey" FOREIGN KEY ("attached_by_rider") REFERENCES "public"."rider_identity"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pickup_stop_evidence_stop_idx" ON "pickup_stop_evidence" USING btree ("pickup_stop_id");--> statement-breakpoint
CREATE INDEX "pickup_stop_evidence_hub_idx" ON "pickup_stop_evidence" USING btree ("responsible_hub_id","attached_at");
--> statement-breakpoint
ALTER TABLE "pickup_stop_evidence" OWNER TO melarc_owner;
--> statement-breakpoint
ALTER TABLE "pickup_stop_evidence" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "pickup_stop_evidence" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Who reads: the staff of the stop's hub under a key of the pickup domain (the failure decision queue, S1.30, reads under pickup.failure.resolve); the rider only what it attached. No
-- vendor reads a photo of its own failed pickup (no act of a vendor shows one in this slice), and no other principal reads at all.
CREATE POLICY "pickup_stop_evidence_read" ON "pickup_stop_evidence" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN split_part(coalesce(current_setting('melarc.authorization_key', true), ''), '.', 1) = 'pickup'
      AND (melarc.hub_scope_mode() = 'ALL' OR "pickup_stop_evidence"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    WHEN 'RIDER' THEN coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.failure.report'
      AND "pickup_stop_evidence"."attached_by_rider" = melarc.current_rider_id()
    ELSE false
  END
);
--> statement-breakpoint
-- Who writes: the rider, under the key of the failure it reports, for a record it captured (the guard derives the rider from the evidence and the policy ties it to the session).
CREATE POLICY "pickup_stop_evidence_attach" ON "pickup_stop_evidence" FOR INSERT WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'RIDER' THEN coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.failure.report'
      AND "pickup_stop_evidence"."attached_by_rider" = melarc.current_rider_id()
    ELSE false
  END
);
--> statement-breakpoint
-- The writer names the record and the stop and nothing else: the hub, the rider and the moment are the guard's.
GRANT SELECT ON "pickup_stop_evidence" TO melarc_api_runtime;
--> statement-breakpoint
GRANT INSERT ("evidence_id", "pickup_stop_id") ON "pickup_stop_evidence" TO melarc_api_runtime;
--> statement-breakpoint
CREATE FUNCTION melarc.pickup_stop_evidence_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  stop_row public.pickup_stop%ROWTYPE;
  proof public.evidence%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'the evidence attached to a failure is kept as it was attached: never changed and never removed' USING ERRCODE = '23514';
  END IF;
  -- The stop's lock first, and then the judgement: a foreign-key check takes only a share lock on the stop that an update of its state does not conflict with, so without this a skip
  -- or a failure that began after the stop was read as arrived could commit beside the link. A writer the policies do not allow to lock the stop falls back to a plain read.
  SELECT * INTO stop_row FROM public.pickup_stop WHERE id = NEW.pickup_stop_id FOR UPDATE;
  IF NOT FOUND THEN
    SELECT * INTO stop_row FROM public.pickup_stop WHERE id = NEW.pickup_stop_id;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'evidence is attached to a pickup stop that is not there' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT';
  END IF;
  SELECT * INTO proof FROM public.evidence WHERE id = NEW.evidence_id;
  IF NOT FOUND OR proof.state <> 'STORED' OR proof.owner_type <> 'PICKUP_STOP' OR proof.owner_id <> NEW.pickup_stop_id
     OR proof.purpose <> 'COLLECTION_PROOF' OR proof.captured_by_principal_type <> 'RIDER' THEN
    RAISE EXCEPTION 'only stored evidence of this very stop, captured by a rider as the proof of its collection, is attached to it' USING ERRCODE = '23514', DETAIL = 'reason=EVIDENCE_NOT_STORED';
  END IF;
  IF stop_row.state <> 'ARRIVED' OR stop_row.released_at IS NOT NULL
     OR NOT EXISTS (
       SELECT 1 FROM public.pickup_manifest m
        WHERE m.id = stop_row.pickup_manifest_id AND m.state = 'IN_PROGRESS' AND m.assigned_rider_id = proof.captured_by_actor
     ) THEN
    RAISE EXCEPTION 'evidence is attached to a stop the rider has arrived at, on a run in progress that is assigned to it' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT';
  END IF;
  -- The scope, the rider and the moment are derived, never given: the hub is the stop's, the rider is the one who captured the record, the moment is the database's.
  NEW.responsible_hub_id := stop_row.responsible_hub_id;
  NEW.attached_by_rider := proof.captured_by_actor;
  NEW.attached_at := pg_catalog.date_trunc('milliseconds', pg_catalog.clock_timestamp());
  RETURN NEW;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.pickup_stop_evidence_guard() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.pickup_stop_evidence_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "pickup_stop_evidence_guard" BEFORE INSERT OR UPDATE OR DELETE ON "pickup_stop_evidence"
  FOR EACH ROW EXECUTE FUNCTION melarc.pickup_stop_evidence_guard();
--> statement-breakpoint
-- The guard of a stop as 0073 made it, with the category of the reason held to the stop's (D-A4) and the photo held to the evidence attached to it (replacing the refusal of a photo that could not yet be given).
CREATE OR REPLACE FUNCTION melarc.pickup_stop_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  catalogue public.reason_code%ROWTYPE;
  instant timestamp with time zone;
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.pickup_manifest_id IS DISTINCT FROM OLD.pickup_manifest_id
     OR NEW.pickup_request_id IS DISTINCT FROM OLD.pickup_request_id
     OR NEW.responsible_hub_id IS DISTINCT FROM OLD.responsible_hub_id
     OR NEW.carryover_snapshot IS DISTINCT FROM OLD.carryover_snapshot
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a pickup stop keeps its manifest, its request, its hub and its carry-over reason' USING ERRCODE = '23514';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state
     AND NOT (
       (OLD.state = 'PENDING' AND NEW.state IN ('ARRIVED', 'SKIPPED'))
       OR (OLD.state = 'ARRIVED' AND NEW.state IN ('COLLECTED', 'PARTIALLY_COLLECTED', 'FAILED', 'SKIPPED'))
     ) THEN
    RAISE EXCEPTION 'a pickup stop moves from PENDING to ARRIVED or SKIPPED and from ARRIVED to COLLECTED, PARTIALLY_COLLECTED, FAILED or SKIPPED, and no other way' USING ERRCODE = '23514';
  END IF;
  IF OLD.released_at IS NOT NULL AND NEW.released_at IS DISTINCT FROM OLD.released_at THEN
    RAISE EXCEPTION 'the release of the claim of a pickup stop is never changed or cleared' USING ERRCODE = '23514';
  END IF;
  IF OLD.state IN ('COLLECTED', 'PARTIALLY_COLLECTED', 'FAILED', 'SKIPPED')
     AND (to_jsonb(NEW) - 'released_at' - 'version') IS DISTINCT FROM (to_jsonb(OLD) - 'released_at' - 'version') THEN
    RAISE EXCEPTION 'a resolved pickup stop is frozen but for the release of its claim' USING ERRCODE = '23514';
  END IF;
  IF NEW.pickup_summary IS DISTINCT FROM OLD.pickup_summary THEN
    IF OLD.pickup_summary IS NOT NULL THEN
      RAISE EXCEPTION 'the summary of a pickup stop is made once and never changed' USING ERRCODE = '23514';
    END IF;
    IF coalesce(current_setting('melarc.authorization_key', true), '') <> 'pickup.manifest.dispatch' THEN
      RAISE EXCEPTION 'only the dispatch of a manifest makes the summary of its stops' USING ERRCODE = '23514';
    END IF;
  END IF;
  -- The moment of an arrival is the rider's act and no other writer's. A grant is not per key, and the planning reaches a stop through a policy that
  -- lets it order the stops and cancel the manifest by skipping them together with the release of their claims, a skip whose statement may carry
  -- other columns with it (below). It has no reason to write an arrival, so a change of the moment under it is refused, whatever else the same
  -- statement writes. (The keys of the cancellation of a request and of the skip are held to their own columns by their rules below, which include this one.)
  IF NEW.arrived_at IS DISTINCT FROM OLD.arrived_at
     AND coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.manifest.create' THEN
    RAISE EXCEPTION 'the moment of an arrival is written by the arrival of the rider and by no ordering' USING ERRCODE = '23514';
  END IF;
  IF coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.manifest.create' THEN
    IF NEW.sequence IS DISTINCT FROM OLD.sequence THEN
      IF (to_jsonb(NEW) - 'sequence' - 'version') IS DISTINCT FROM (to_jsonb(OLD) - 'sequence' - 'version') THEN
        RAISE EXCEPTION 'the ordering of the stops changes their sequence and nothing else' USING ERRCODE = '23514';
      END IF;
    ELSIF (to_jsonb(NEW) - 'version') IS DISTINCT FROM (to_jsonb(OLD) - 'version')
          AND NOT (NEW.state = 'SKIPPED' AND NEW.released_at IS NOT NULL) THEN
      RAISE EXCEPTION 'the cancellation of a manifest skips a stop and releases its claim together' USING ERRCODE = '23514';
    END IF;
  ELSIF coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.manifest.dispatch'
        AND (to_jsonb(NEW) - 'pickup_summary' - 'version') IS DISTINCT FROM (to_jsonb(OLD) - 'pickup_summary' - 'version') THEN
    RAISE EXCEPTION 'the dispatch of a manifest makes the summary of a stop and changes nothing else of it' USING ERRCODE = '23514';
  ELSIF coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.request.cancel' THEN
    -- The cancellation of a request skips the stop that holds it, if it is still to be worked, and writes nothing else: the stop keeps its place in the
    -- order, its claim (the cancelled request must not return to the pool that can be manifested) and the arrival the rider recorded (the evidence
    -- of a visit that happened). The reason is the system's, not one of the catalogue Ops chooses from when it skips a stop for itself. Only a stop
    -- that is still to be worked can be skipped: the moves above allow SKIPPED from PENDING and ARRIVED alone, and a resolved stop is frozen.
    IF NEW.state <> 'SKIPPED' THEN
      RAISE EXCEPTION 'the cancellation of a request skips a stop and does nothing else' USING ERRCODE = '23514';
    END IF;
    IF (to_jsonb(NEW) - 'state' - 'resolved_at' - 'skip_snapshot' - 'version') IS DISTINCT FROM (to_jsonb(OLD) - 'state' - 'resolved_at' - 'skip_snapshot' - 'version') THEN
      RAISE EXCEPTION 'the skip a cancellation makes writes the state, the moment and the reason, and keeps the place, the claim and the arrival of the stop' USING ERRCODE = '23514';
    END IF;
    IF NEW.resolved_at IS NULL OR (NEW.skip_snapshot ->> 'reason_code') IS DISTINCT FROM 'REQUEST_CANCELLED' THEN
      RAISE EXCEPTION 'the skip a cancellation makes carries its moment and the reason REQUEST_CANCELLED' USING ERRCODE = '23514';
    END IF;
  ELSIF coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.stop.skip' THEN
    -- Ops's authorised skip (MSC-DEC-412): a stop still to be worked becomes SKIPPED, with its moment and the snapshot of the reason, and nothing
    -- else of it changes, so it keeps its place in the order, its arrival and its claim (a skip does not release it). The reason is a code of the
    -- PICKUP_STOP_SKIP catalogue, active, with a note where the code requires one: the system's own codes (the cancellation of a request or of a
    -- manifest) are not in the catalogue, so the key cannot write them. The moment in the snapshot is the moment of the skip.
    IF NEW.state <> 'SKIPPED' THEN
      RAISE EXCEPTION 'the skip of a stop moves it to SKIPPED and does nothing else' USING ERRCODE = '23514';
    END IF;
    IF (to_jsonb(NEW) - 'state' - 'resolved_at' - 'skip_snapshot' - 'version') IS DISTINCT FROM (to_jsonb(OLD) - 'state' - 'resolved_at' - 'skip_snapshot' - 'version') THEN
      RAISE EXCEPTION 'the skip of a stop writes the state, the moment and the reason, and keeps the place, the claim and the arrival of the stop' USING ERRCODE = '23514';
    END IF;
    IF NEW.resolved_at IS NULL
       OR (NEW.skip_snapshot ->> 'skipped_at') IS NULL
       OR (NEW.skip_snapshot ->> 'skipped_at')::timestamptz IS DISTINCT FROM NEW.resolved_at THEN
      RAISE EXCEPTION 'the skip of a stop carries its moment, and the snapshot names the same moment' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.reason_code rc
       WHERE rc.domain = 'PICKUP_STOP_SKIP' AND rc.active AND rc.code = (NEW.skip_snapshot ->> 'reason_code')
         AND (NOT rc.requires_note OR btrim(coalesce(NEW.skip_snapshot ->> 'note', '')) <> '')
    ) THEN
      RAISE EXCEPTION 'the skip of a stop gives an active reason of the PICKUP_STOP_SKIP catalogue, with its note where the reason requires one' USING ERRCODE = '23514';
    END IF;
  ELSIF coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.run.execute' THEN
    IF OLD.state <> 'PENDING' OR NEW.state <> 'ARRIVED' THEN
      RAISE EXCEPTION 'the arrival at a stop moves a pending stop to ARRIVED and does nothing else' USING ERRCODE = '23514';
    END IF;
    IF NEW.arrived_at IS NULL
       OR (to_jsonb(NEW) - 'state' - 'arrived_at' - 'version') IS DISTINCT FROM (to_jsonb(OLD) - 'state' - 'arrived_at' - 'version') THEN
      RAISE EXCEPTION 'the arrival at a stop changes its state and the moment of the arrival and nothing else' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.pickup_manifest m
       WHERE m.id = NEW.pickup_manifest_id AND m.state = 'IN_PROGRESS' AND m.assigned_rider_id = melarc.current_rider_id()
    ) THEN
      RAISE EXCEPTION 'a stop is arrived at once its run has started, by the rider the run is assigned to' USING ERRCODE = '23514';
    END IF;
    -- The moment of the arrival is the database's own, taken now that the stop's lock is held, as the moment of a failure is: a writer under this key does not choose it. It is the
    -- moment the door wait is measured from (a vendor-unavailable failure is accepted once the wait has passed since it), so a moment given by the writer would be a wait given by the writer.
    NEW.arrived_at := pg_catalog.date_trunc('milliseconds', pg_catalog.clock_timestamp());
  ELSIF current_user = 'melarc_owner' AND coalesce(current_setting('melarc.authorization_key', true), '') IN ('pickup.collection.confirm', 'pickup.handshake.override', 'pickup.handshake.resolve') THEN
    -- The close of a counted stop by its handshake (S1.27, migration 0070): an operation of the handshake, running as the owner under the rider's, the vendor's or the
    -- officer's own key, moves a stop that has been arrived at to COLLECTED or PARTIALLY_COLLECTED, with its moment, and writes nothing else of it. The record's
    -- variance names the state (equal counts close it collected, fewer partially collected) and the handshake must already have ended well, so a stop is never closed
    -- by anything that has not verified, been overridden or been resolved by hand. Under the same keys a statement may take the lock of a stop and change nothing.
    IF NEW.state IS DISTINCT FROM OLD.state THEN
      IF OLD.state <> 'ARRIVED' OR NEW.state NOT IN ('COLLECTED', 'PARTIALLY_COLLECTED') OR NEW.resolved_at IS NULL THEN
        RAISE EXCEPTION 'the handshake closes a stop that has been arrived at, as collected or partially collected, with its moment' USING ERRCODE = '23514';
      END IF;
      IF (to_jsonb(NEW) - 'state' - 'resolved_at' - 'version') IS DISTINCT FROM (to_jsonb(OLD) - 'state' - 'resolved_at' - 'version') THEN
        RAISE EXCEPTION 'the close of a stop by its handshake writes the state and the moment and nothing else' USING ERRCODE = '23514';
      END IF;
      -- (The relations are named with their schema: the operations that fire this guard run with an empty search path.)
      IF NOT EXISTS (
           SELECT 1 FROM public.collection_record c
            WHERE c.pickup_stop_id = NEW.id AND ((c.variance = 'MATCH' AND NEW.state = 'COLLECTED') OR (c.variance = 'SHORT' AND NEW.state = 'PARTIALLY_COLLECTED')))
         OR NOT EXISTS (SELECT 1 FROM public.collection_handshake h WHERE h.pickup_stop_id = NEW.id AND h.state IN ('VERIFIED', 'MANUALLY_RESOLVED')) THEN
        RAISE EXCEPTION 'a stop is closed as its count says, by a handshake that has ended well' USING ERRCODE = '23514';
      END IF;
    ELSIF (to_jsonb(NEW) - 'version') IS DISTINCT FROM (to_jsonb(OLD) - 'version') THEN
      RAISE EXCEPTION 'under the key of a handshake a stop is locked or closed, and nothing else of it is written' USING ERRCODE = '23514';
    END IF;
  ELSIF coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.failure.report' THEN
    -- The report of a failure (S1.28, migration 0072): the rider's key moves a stop that has been arrived at to FAILED, with the fixed category, the snapshot of the
    -- reason and the moment, and writes nothing else of it, so the stop keeps its place in the order, its arrival and its claim (a failure does not release it).
    -- What is the catalogue's or the clock's is judged here, for every writer: the reason is an active reason of the PICKUP_FAILURE catalogue with the label and the
    -- attribution the catalogue holds now, in the shape the application builds, and it satisfies its metadata (a note where it asks for one, a contact attempt
    -- where it asks for one, and a photo, meaning evidence attached to the stop in pickup_stop_evidence, where it asks for one) and belongs to the category the failure is reported under
    -- (D-A4: the catalogue binds each reason to one category, so the door wait and the escalation-only rule cannot be stepped around by pairing). The moment is the
    -- database's own, taken now that the stop's lock is held, and the snapshot names the same moment; a moment given by the writer is not kept.
    IF OLD.state <> 'ARRIVED' OR NEW.state <> 'FAILED' THEN
      RAISE EXCEPTION 'the report of a failure moves a stop that has been arrived at to FAILED and does nothing else' USING ERRCODE = '23514';
    END IF;
    IF (to_jsonb(NEW) - 'state' - 'resolved_at' - 'failure_category' - 'failure_reason_snapshot' - 'version') IS DISTINCT FROM (to_jsonb(OLD) - 'state' - 'resolved_at' - 'failure_category' - 'failure_reason_snapshot' - 'version') THEN
      RAISE EXCEPTION 'the report of a failure writes the state, the moment, the category and the reason, and keeps the place, the claim and the arrival of the stop' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.pickup_manifest m
       WHERE m.id = NEW.pickup_manifest_id AND m.state = 'IN_PROGRESS' AND m.assigned_rider_id = melarc.current_rider_id()
    ) THEN
      RAISE EXCEPTION 'a failure is reported once the run has started, by the rider the run is assigned to' USING ERRCODE = '23514';
    END IF;
    IF NEW.failure_reason_snapshot IS NULL THEN
      RAISE EXCEPTION 'a failure gives the reason of the catalogue' USING ERRCODE = '23514', DETAIL = 'reason=REASON_REQUIRED';
    END IF;
    IF jsonb_typeof(NEW.failure_reason_snapshot) IS DISTINCT FROM 'object'
       OR EXISTS (SELECT 1 FROM jsonb_object_keys(NEW.failure_reason_snapshot) AS k(key) WHERE k.key NOT IN ('reason_code', 'label', 'attribution', 'note', 'contact_attempts'))
       OR jsonb_typeof(NEW.failure_reason_snapshot -> 'label') IS DISTINCT FROM 'string'
       OR ((NEW.failure_reason_snapshot -> 'note') IS NOT NULL
           AND (jsonb_typeof(NEW.failure_reason_snapshot -> 'note') <> 'string' OR char_length(NEW.failure_reason_snapshot ->> 'note') > 1000)) THEN
      RAISE EXCEPTION 'the reason of a failure is kept as the application builds it' USING ERRCODE = '23514', DETAIL = 'reason=REASON_NOT_ACTIVE';
    END IF;
    -- The contact attempts, where there are any: at most ten, each the moment as the application writes it (an instant in UTC, to the millisecond) and what came of it.
    IF (NEW.failure_reason_snapshot -> 'contact_attempts') IS NOT NULL
       AND (jsonb_typeof(NEW.failure_reason_snapshot -> 'contact_attempts') <> 'array'
            OR jsonb_array_length(NEW.failure_reason_snapshot -> 'contact_attempts') > 10
            OR EXISTS (
              SELECT 1 FROM jsonb_array_elements(NEW.failure_reason_snapshot -> 'contact_attempts') AS e(attempt)
               WHERE jsonb_typeof(e.attempt) IS DISTINCT FROM 'object'
                  OR NOT jsonb_exists_all(e.attempt, ARRAY['method', 'attempted_at', 'outcome'])
                  OR (e.attempt - ARRAY['method', 'attempted_at', 'outcome', 'note']) <> '{}'::jsonb
                  OR jsonb_typeof(e.attempt -> 'attempted_at') IS DISTINCT FROM 'string'
                  OR jsonb_typeof(e.attempt -> 'outcome') IS DISTINCT FROM 'string'
                  OR (e.attempt ->> 'attempted_at') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
                  OR (e.attempt ->> 'outcome') ~ '^[[:space:]]*$'
                  OR char_length(e.attempt ->> 'outcome') > 1000
                  OR jsonb_typeof(e.attempt -> 'method') IS DISTINCT FROM 'string'
                  OR (e.attempt ->> 'method') NOT IN ('PHONE_CALL', 'SMS', 'IN_PERSON')
                  OR (pg_catalog.jsonb_exists(e.attempt, 'note')
                      AND (jsonb_typeof(e.attempt -> 'note') IS DISTINCT FROM 'string' OR (e.attempt ->> 'note') ~ '^[[:space:]]*$' OR char_length(e.attempt ->> 'note') > 1000)))) THEN
      RAISE EXCEPTION 'the contact attempts of a failure are kept as the application builds them' USING ERRCODE = '23514', DETAIL = 'reason=REASON_NOT_ACTIVE';
    END IF;
    SELECT * INTO catalogue FROM public.reason_code AS rc
     WHERE rc.code = (NEW.failure_reason_snapshot ->> 'reason_code') AND rc.domain = 'PICKUP_FAILURE';
    IF NOT FOUND OR NOT catalogue.active
       OR catalogue.label IS DISTINCT FROM (NEW.failure_reason_snapshot ->> 'label')
       OR catalogue.attribution IS DISTINCT FROM (NEW.failure_reason_snapshot ->> 'attribution') THEN
      RAISE EXCEPTION 'the reason of a failure is an active reason of the PICKUP_FAILURE catalogue, as the catalogue holds it' USING ERRCODE = '23514', DETAIL = 'reason=REASON_NOT_ACTIVE';
    END IF;
    IF catalogue.failure_category IS DISTINCT FROM NEW.failure_category THEN
      RAISE EXCEPTION 'the reason of a failure belongs to the category the catalogue gives it' USING ERRCODE = '23514', DETAIL = 'reason=REASON_CATEGORY_MISMATCH';
    END IF;
    IF catalogue.requires_note AND coalesce(NEW.failure_reason_snapshot ->> 'note', '') ~ '^[[:space:]]*$' THEN
      RAISE EXCEPTION 'the reason of this failure asks for a note' USING ERRCODE = '23514', DETAIL = 'reason=REASON_REQUIRED';
    END IF;
    IF catalogue.requires_contact_attempt AND coalesce(jsonb_array_length(NEW.failure_reason_snapshot -> 'contact_attempts'), 0) = 0 THEN
      RAISE EXCEPTION 'the reason of this failure asks for a contact attempt' USING ERRCODE = '23514', DETAIL = 'reason=REASON_REQUIRED';
    END IF;
    IF catalogue.requires_photo AND NOT EXISTS (SELECT 1 FROM public.pickup_stop_evidence AS photo WHERE photo.pickup_stop_id = NEW.id) THEN
      RAISE EXCEPTION 'the reason of this failure asks for a photo' USING ERRCODE = '23514', DETAIL = 'reason=REASON_REQUIRED';
    END IF;
    instant := date_trunc('milliseconds', clock_timestamp());
    -- The door wait (review of 5 November 2026; pickup-collection.md, "Vendor simply busy"): the category VENDOR_UNAVAILABLE is accepted once the hub's door wait has passed since
    -- the rider arrived, on the database's clock and the arrival the database recorded. The other categories carry no wait.
    IF NEW.failure_category = 'VENDOR_UNAVAILABLE'
       AND (OLD.arrived_at IS NULL OR instant < OLD.arrived_at + pg_catalog.make_interval(mins => melarc.rider_door_wait_minutes(NEW.responsible_hub_id))) THEN
      RAISE EXCEPTION 'the rider has not waited at the door as long as the hub requires' USING ERRCODE = '23514', DETAIL = 'reason=PICKUP_DOOR_WAIT_NOT_ELAPSED';
    END IF;
    NEW.resolved_at := instant;
    NEW.failure_reason_snapshot := NEW.failure_reason_snapshot || jsonb_build_object('reported_at', to_char(instant AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.pickup_stop_guard() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.pickup_stop_guard() FROM PUBLIC;
