CREATE TABLE "evidence" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_type" text NOT NULL,
	"owner_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"captured_by_actor" uuid NOT NULL,
	"captured_by_principal_type" text NOT NULL,
	"device_context" jsonb,
	"storage_ref" text NOT NULL,
	"responsible_hub_id" uuid,
	"vendor_organization_id" uuid,
	"access_rule" text NOT NULL,
	"retention_policy" text NOT NULL,
	"state" text DEFAULT 'PENDING_UPLOAD' NOT NULL,
	"content_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"checksum_sha256" text NOT NULL,
	"upload_ttl_seconds" integer NOT NULL,
	"upload_expires_at" timestamp with time zone NOT NULL,
	"uploaded_at" timestamp with time zone,
	"validated_signature" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "evidence_state_closed" CHECK ("evidence"."state" IN ('PENDING_UPLOAD', 'STORED', 'EXPIRED')),
	CONSTRAINT "evidence_owner_type_closed" CHECK ("evidence"."owner_type" IN ('PICKUP_STOP', 'PICKUP_INTAKE', 'ORDER', 'DELIVERY_STOP', 'THIRD_PARTY_HANDOFF', 'MOTORCYCLE', 'FUEL_RECORD', 'VENDOR_ORGANIZATION', 'APPROVED_AGENT')),
	CONSTRAINT "evidence_purpose_closed" CHECK ("evidence"."purpose" IN ('COLLECTION_PROOF', 'CONDITION', 'OSD', 'HANDOFF_RECEIPT', 'DELIVERY_PROOF', 'RETURN_PROOF', 'MAINTENANCE', 'FUEL', 'COMPLIANCE_DOCUMENT')),
	CONSTRAINT "evidence_capture_principal_closed" CHECK ("evidence"."captured_by_principal_type" IN ('STAFF', 'RIDER', 'VENDOR')),
	CONSTRAINT "evidence_access_rule_closed" CHECK ("evidence"."access_rule" IN ('SUBJECT_READERS')),
	CONSTRAINT "evidence_retention_policy_closed" CHECK ("evidence"."retention_policy" IN ('PICKUP_STOP_EVIDENCE')),
	CONSTRAINT "evidence_checksum_shape" CHECK ("evidence"."checksum_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "evidence_storage_ref_shape" CHECK ("evidence"."storage_ref" ~ '^ev/[0-9a-f]{32}$'),
	CONSTRAINT "evidence_content_type_shape" CHECK ("evidence"."content_type" ~ '^[a-z]+/[a-z0-9][a-z0-9.+-]*$' AND char_length("evidence"."content_type") <= 127),
	CONSTRAINT "evidence_byte_size_positive" CHECK ("evidence"."byte_size" >= 1),
	CONSTRAINT "evidence_upload_ttl_positive" CHECK ("evidence"."upload_ttl_seconds" >= 1),
	CONSTRAINT "evidence_scope_owner_aware" CHECK (("evidence"."owner_type" = 'VENDOR_ORGANIZATION' AND "evidence"."responsible_hub_id" IS NULL AND "evidence"."vendor_organization_id" IS NOT NULL AND "evidence"."vendor_organization_id" = "evidence"."owner_id") OR ("evidence"."owner_type" <> 'VENDOR_ORGANIZATION' AND "evidence"."responsible_hub_id" IS NOT NULL)),
	CONSTRAINT "evidence_scope_vendor_neutral" CHECK ("evidence"."owner_type" NOT IN ('MOTORCYCLE', 'FUEL_RECORD', 'APPROVED_AGENT') OR "evidence"."vendor_organization_id" IS NULL),
	CONSTRAINT "evidence_stored_facts" CHECK (("evidence"."state" = 'STORED' AND "evidence"."uploaded_at" IS NOT NULL AND "evidence"."validated_signature" IS NOT NULL) OR ("evidence"."state" <> 'STORED' AND "evidence"."uploaded_at" IS NULL AND "evidence"."validated_signature" IS NULL)),
	CONSTRAINT "evidence_signature_matches_type" CHECK ("evidence"."validated_signature" IS NULL OR ("evidence"."content_type" = 'image/jpeg' AND "evidence"."validated_signature" = 'JPEG') OR ("evidence"."content_type" = 'image/png' AND "evidence"."validated_signature" = 'PNG') OR ("evidence"."content_type" = 'application/pdf' AND "evidence"."validated_signature" = 'PDF'))
);
--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_hub_fkey" FOREIGN KEY ("responsible_hub_id") REFERENCES "public"."hub"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "evidence_storage_ref_key" ON "evidence" USING btree ("storage_ref");--> statement-breakpoint
CREATE INDEX "evidence_owner_idx" ON "evidence" USING btree ("owner_type","owner_id");--> statement-breakpoint
CREATE INDEX "evidence_hub_idx" ON "evidence" USING btree ("responsible_hub_id","created_at");--> statement-breakpoint
CREATE INDEX "evidence_pending_expiry_idx" ON "evidence" USING btree ("upload_expires_at") WHERE "evidence"."state" = 'PENDING_UPLOAD';
--> statement-breakpoint
-- S1.11 (SLICE-001; delivery/planning/SLICE-001-IMPLEMENTATION-PLAN.md S1.11; domain-model.md section 3.6; state-machines.md section 17; SECURITY_DESIGN.md sections 14.10 and
-- 14.18; security-test-matrix.md Families M and N). Everything above this comment is generated (drizzle-kit, from src/platform/database/schema/evidence.ts, whose header explains
-- the table); everything below is in this migration so that the table never exists for a moment without its owner, row-level security, policies, grants and guard.
-- Applied as melarc_migration_elevated, a member of melarc_owner (MIGRATION_AND_SEEDING.md section 5.1).
--
--   * Who writes. Evidence is captured in the course of another act, so its authorization is that act's (x-permission: owner): the first owner this build supports is a pickup stop
--     whose failure the rider reports, under the key pickup.failure.report. The rider declares a record for a stop it has arrived at (INSERT) and moves it to STORED once the
--     bytes arrived (UPDATE of the state); the evidence_validation lane of the delivery worker moves an abandoned capture to EXPIRED. Nothing deletes a row: the table has no
--     DELETE privilege and the guard refuses one for every writer. A later owner type adds its own arm of these policies and its own derivation in its own migration.
--   * Who reads. The rider that captured a record reads it (to complete it); the staff of the record's hub read the evidence about a pickup stop under pickup.read (the read of
--     the subject), within the hubs of the grant; a vendor reads none yet (no act of a vendor captures evidence in this slice); the lane reads the abandoned captures and nothing else.
--   * What the database holds for every writer (the guard below). A record is declared PENDING_UPLOAD at its first version; the moment of a capture is not in the future; the
--     database takes the record's creation instant and the end of its upload window from its own clock; for a pickup stop under the rider's key the hub and the vendor organisation
--     are DERIVED from the stop, never given (GBT-M9), and the stop must be one the rider has arrived at on a run in progress that is assigned to it; a record changes in one way
--     only, PENDING_UPLOAD to STORED (before the window ends, with the instant of the upload the database's own) or to EXPIRED (after it), and then it is final.
--   * Family M of the matrix is the table's checks (evidence_scope_owner_aware, evidence_scope_vendor_neutral) and the read policy below.
ALTER TABLE "evidence" OWNER TO melarc_owner;
--> statement-breakpoint
ALTER TABLE "evidence" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "evidence" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "evidence_read" ON "evidence" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'RIDER' THEN coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.failure.report'
      AND "evidence"."captured_by_principal_type" = 'RIDER' AND "evidence"."captured_by_actor" = melarc.current_rider_id()
    WHEN 'STAFF' THEN coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.read'
      AND "evidence"."owner_type" = 'PICKUP_STOP' AND "evidence"."responsible_hub_id" IS NOT NULL
      AND (melarc.hub_scope_mode() = 'ALL' OR "evidence"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'evidence_validation' AND "evidence"."state" = 'PENDING_UPLOAD'
    ELSE false
  END
);
--> statement-breakpoint
-- The scope probe (SECURITY_DESIGN.md section 14.4b): a staff member's miss on another hub's evidence is told from a record that does not exist.
CREATE POLICY "evidence_probe" ON "evidence" FOR SELECT USING (melarc.principal_type() = 'STAFF' AND id = melarc.scope_probe_id());
--> statement-breakpoint
CREATE POLICY "evidence_declare" ON "evidence" FOR INSERT WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'RIDER' THEN coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.failure.report'
      AND "evidence"."owner_type" = 'PICKUP_STOP' AND "evidence"."purpose" = 'COLLECTION_PROOF'
      AND "evidence"."captured_by_principal_type" = 'RIDER' AND "evidence"."captured_by_actor" = melarc.current_rider_id()
      AND "evidence"."state" = 'PENDING_UPLOAD' AND "evidence"."access_rule" = 'SUBJECT_READERS' AND "evidence"."retention_policy" = 'PICKUP_STOP_EVIDENCE'
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "evidence_store" ON "evidence" FOR UPDATE USING (
  CASE melarc.principal_type()
    WHEN 'RIDER' THEN coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.failure.report'
      AND "evidence"."captured_by_principal_type" = 'RIDER' AND "evidence"."captured_by_actor" = melarc.current_rider_id() AND "evidence"."state" = 'PENDING_UPLOAD'
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'evidence_validation' AND "evidence"."state" = 'PENDING_UPLOAD'
    ELSE false
  END
) WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'RIDER' THEN "evidence"."state" = 'STORED'
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'evidence_validation' AND "evidence"."state" = 'EXPIRED'
    ELSE false
  END
);
--> statement-breakpoint
GRANT SELECT, INSERT ON "evidence" TO melarc_api_runtime;
--> statement-breakpoint
GRANT UPDATE ("state", "validated_signature") ON "evidence" TO melarc_api_runtime;
--> statement-breakpoint
-- The lane that expires abandoned captures reads the id, the state and the end of the window, and writes the state: nothing else of a record.
GRANT SELECT ("id", "state", "upload_expires_at") ON "evidence" TO melarc_worker_cap_evidence_validation;
--> statement-breakpoint
GRANT UPDATE ("state") ON "evidence" TO melarc_worker_cap_evidence_validation;
--> statement-breakpoint
-- The request of a stop is not the rider's to read (a rider's context reads no request: the existence rule and OB-S1-53). The derivation of the scope of the evidence of a stop asks
-- for the request's vendor organisation inside the one function below, which runs as the owner, as the operations of the count do (0068): this arm admits the owner-run statement
-- under this key, and no statement of the login.
CREATE POLICY "pickup_request_evidence_rider_read" ON "pickup_request" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'RIDER' THEN coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.failure.report' AND current_user = 'melarc_owner'
    ELSE false
  END
);
--> statement-breakpoint
-- melarc.evidence_pickup_stop_scope: the hub and the vendor organisation of a stop's evidence, derived and never given. It answers the rider that reports the failure of a stop it has
-- arrived at, on a run in progress that is assigned to it, and nobody else: any other caller, and any stop that is not that, is 42501, the same.
CREATE FUNCTION melarc.evidence_pickup_stop_scope(p_stop uuid, OUT out_hub uuid, OUT out_vendor uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF melarc.principal_type() <> 'RIDER'
     OR coalesce(pg_catalog.current_setting('melarc.authorization_key', true), '') <> 'pickup.failure.report' THEN
    RAISE EXCEPTION 'the scope of the evidence of a stop is derived for the rider that reports its failure, and for nobody else' USING ERRCODE = '42501';
  END IF;
  IF p_stop IS NULL THEN
    RAISE EXCEPTION 'the scope of the evidence of a stop is asked for one stop' USING ERRCODE = '22023';
  END IF;
  SELECT s.responsible_hub_id, r.vendor_organization_id INTO out_hub, out_vendor
    FROM public.pickup_stop AS s
    JOIN public.pickup_manifest AS m ON m.id = s.pickup_manifest_id
    JOIN public.pickup_request AS r ON r.id = s.pickup_request_id
   WHERE s.id = p_stop AND s.state = 'ARRIVED' AND s.released_at IS NULL
     AND m.state = 'IN_PROGRESS' AND m.assigned_rider_id = melarc.current_rider_id();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'evidence is declared for a stop the calling rider has arrived at, on a run in progress that is assigned to it' USING ERRCODE = '42501';
  END IF;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.evidence_pickup_stop_scope(uuid) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.evidence_pickup_stop_scope(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.evidence_pickup_stop_scope(uuid) TO melarc_api_runtime;
--> statement-breakpoint
-- The guard, for every writer (the invoker's rights; the derivation above is the one thing it asks of the owner).
CREATE FUNCTION melarc.evidence_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  derived record;
  instant timestamp with time zone := pg_catalog.clock_timestamp();
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'evidence is retained and never deleted' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'PENDING_UPLOAD' OR NEW.uploaded_at IS NOT NULL OR NEW.validated_signature IS NOT NULL THEN
      RAISE EXCEPTION 'evidence is declared pending its upload' USING ERRCODE = '23514', DETAIL = 'reason=VALIDATION_FAILED';
    END IF;
    IF NEW.captured_at > instant THEN
      RAISE EXCEPTION 'the moment of a capture is not in the future' USING ERRCODE = '23514', DETAIL = 'reason=VALIDATION_FAILED';
    END IF;
    -- The instants are the database's own: a writer does not choose when a record was made or when its upload window ends (to the second, so that the upload instruction can be made again, identically).
    NEW.created_at := pg_catalog.date_trunc('second', instant);
    NEW.upload_expires_at := NEW.created_at + pg_catalog.make_interval(secs => NEW.upload_ttl_seconds);
    NEW.version := 1;
    -- Under the rider's key the scope is derived from the stop and is not the writer's to give (GBT-M9).
    IF NEW.owner_type = 'PICKUP_STOP'
       AND melarc.principal_type() = 'RIDER'
       AND coalesce(pg_catalog.current_setting('melarc.authorization_key', true), '') = 'pickup.failure.report' THEN
      SELECT * INTO derived FROM melarc.evidence_pickup_stop_scope(NEW.owner_id);
      NEW.responsible_hub_id := derived.out_hub;
      NEW.vendor_organization_id := derived.out_vendor;
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.owner_type IS DISTINCT FROM OLD.owner_type OR NEW.owner_id IS DISTINCT FROM OLD.owner_id
     OR NEW.purpose IS DISTINCT FROM OLD.purpose OR NEW.captured_at IS DISTINCT FROM OLD.captured_at
     OR NEW.captured_by_actor IS DISTINCT FROM OLD.captured_by_actor OR NEW.captured_by_principal_type IS DISTINCT FROM OLD.captured_by_principal_type
     OR NEW.device_context IS DISTINCT FROM OLD.device_context OR NEW.storage_ref IS DISTINCT FROM OLD.storage_ref
     OR NEW.responsible_hub_id IS DISTINCT FROM OLD.responsible_hub_id OR NEW.vendor_organization_id IS DISTINCT FROM OLD.vendor_organization_id
     OR NEW.access_rule IS DISTINCT FROM OLD.access_rule OR NEW.retention_policy IS DISTINCT FROM OLD.retention_policy
     OR NEW.content_type IS DISTINCT FROM OLD.content_type OR NEW.byte_size IS DISTINCT FROM OLD.byte_size
     OR NEW.checksum_sha256 IS DISTINCT FROM OLD.checksum_sha256 OR NEW.upload_ttl_seconds IS DISTINCT FROM OLD.upload_ttl_seconds
     OR NEW.upload_expires_at IS DISTINCT FROM OLD.upload_expires_at OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'evidence keeps its owner, its scope, its storage reference and what was declared of it' USING ERRCODE = '23514';
  END IF;
  IF OLD.state <> 'PENDING_UPLOAD' THEN
    RAISE EXCEPTION 'stored and expired evidence is final' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT';
  END IF;
  IF NEW.state = 'STORED' THEN
    IF instant >= OLD.upload_expires_at THEN
      RAISE EXCEPTION 'the upload window of this evidence has passed' USING ERRCODE = '23514', DETAIL = 'reason=EVIDENCE_UPLOAD_EXPIRED';
    END IF;
    NEW.uploaded_at := instant;
  ELSIF NEW.state = 'EXPIRED' THEN
    IF instant < OLD.upload_expires_at THEN
      RAISE EXCEPTION 'an upload window that is still open does not expire' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT';
    END IF;
  ELSE
    RAISE EXCEPTION 'evidence changes by being stored or by expiring, and in no other way' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.evidence_guard() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.evidence_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION melarc.evidence_version() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  NEW.version := OLD.version + 1;
  RETURN NEW;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.evidence_version() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.evidence_version() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "evidence_guard" BEFORE INSERT OR UPDATE OR DELETE ON "evidence"
  FOR EACH ROW EXECUTE FUNCTION melarc.evidence_guard();
--> statement-breakpoint
CREATE TRIGGER "evidence_version" BEFORE UPDATE ON "evidence"
  FOR EACH ROW EXECUTE FUNCTION melarc.evidence_version();
--> statement-breakpoint
-- The two development values of OB-S1-05 (the owner's decision of 29 October 2026, D-13): at most 10 MB, and JPEG, PNG or PDF. They are platform settings, with no default in code;
-- the launch values stay the owner's. Only a database the reference seed has filled gets them from here (the seed refuses a database that holds a row, so a database seeded earlier
-- can never be seeded again), once, under the seed capability, as migrations 0043, 0044, 0054 and 0056 do; a database that has not been seeded gets the same rows from the seed
-- (tools/seed/settings.ts). The two lifetimes (15 and 5 minutes) are seeded already.
DO $evidence_settings$
DECLARE
  previous_type text := coalesce(pg_catalog.current_setting('melarc.principal_type', true), '');
  previous_capability text := coalesce(pg_catalog.current_setting('melarc.task_capability', true), '');
BEGIN
  PERFORM pg_catalog.set_config('melarc.principal_type', 'SYSTEM', true);
  PERFORM pg_catalog.set_config('melarc.task_capability', 'seed', true);
  IF EXISTS (SELECT 1 FROM public.setting) THEN
    INSERT INTO public.setting (key, scope, value_type, value, unit, description)
    SELECT v.key, v.scope, v.value_type, v.value, v.unit, v.description
      FROM (VALUES
        ('evidence_upload_max_bytes', 'PLATFORM', 'integer', '10485760'::jsonb, 'bytes', 'The largest single evidence upload accepted (10 MB, read as 10 MiB): a development value decided by the Product Owner on 29 October 2026; the launch value stays the owner’s.'),
        ('evidence_upload_allowed_mime_types', 'PLATFORM', 'list', '["image/jpeg", "image/png", "application/pdf"]'::jsonb, 'MIME types', 'The types of evidence accepted, each checked against the actual file signature: JPEG, PNG or PDF, a development value decided by the Product Owner on 29 October 2026; the launch value stays the owner’s.')
      ) AS v(key, scope, value_type, value, unit, description)
     WHERE NOT EXISTS (SELECT 1 FROM public.setting AS held WHERE held.key = v.key);
  END IF;
  PERFORM pg_catalog.set_config('melarc.principal_type', previous_type, true);
  PERFORM pg_catalog.set_config('melarc.task_capability', previous_capability, true);
END
$evidence_settings$;
--> statement-breakpoint
-- The rider's key reads the three evidence settings it needs and no other platform row (staff read every setting already: setting_read).
CREATE POLICY "setting_evidence_read" ON "setting" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'RIDER' THEN coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.failure.report'
      AND key IN ('evidence_upload_max_bytes', 'evidence_upload_allowed_mime_types', 'evidence_upload_authorization_ttl_minutes')
    ELSE false
  END
);
