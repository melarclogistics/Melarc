CREATE TABLE "collection_parcel_photo" (
	"evidence_id" uuid PRIMARY KEY NOT NULL,
	"collection_record_id" uuid NOT NULL,
	"pickup_stop_id" uuid NOT NULL,
	"responsible_hub_id" uuid NOT NULL,
	"attached_by_rider" uuid NOT NULL,
	"attached_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "parcel_photo_exception" (
	"id" uuid PRIMARY KEY NOT NULL,
	"pickup_stop_id" uuid NOT NULL,
	"responsible_hub_id" uuid NOT NULL,
	"authorised_by" uuid NOT NULL,
	"authorised_at" timestamp with time zone DEFAULT now() NOT NULL,
	"note" text NOT NULL,
	CONSTRAINT "parcel_photo_exception_note_present" CHECK (char_length(btrim("parcel_photo_exception"."note")) >= 1)
);
--> statement-breakpoint
ALTER TABLE "evidence" DROP CONSTRAINT "evidence_purpose_closed";--> statement-breakpoint
ALTER TABLE "collection_parcel_photo" ADD CONSTRAINT "collection_parcel_photo_evidence_fkey" FOREIGN KEY ("evidence_id") REFERENCES "public"."evidence"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_parcel_photo" ADD CONSTRAINT "collection_parcel_photo_record_fkey" FOREIGN KEY ("collection_record_id") REFERENCES "public"."collection_record"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_parcel_photo" ADD CONSTRAINT "collection_parcel_photo_stop_fkey" FOREIGN KEY ("pickup_stop_id","responsible_hub_id") REFERENCES "public"."pickup_stop"("id","responsible_hub_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_parcel_photo" ADD CONSTRAINT "collection_parcel_photo_rider_fkey" FOREIGN KEY ("attached_by_rider") REFERENCES "public"."rider_identity"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parcel_photo_exception" ADD CONSTRAINT "parcel_photo_exception_stop_fkey" FOREIGN KEY ("pickup_stop_id","responsible_hub_id") REFERENCES "public"."pickup_stop"("id","responsible_hub_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parcel_photo_exception" ADD CONSTRAINT "parcel_photo_exception_officer_fkey" FOREIGN KEY ("authorised_by") REFERENCES "public"."staff_identity"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "collection_parcel_photo_record_idx" ON "collection_parcel_photo" USING btree ("collection_record_id");--> statement-breakpoint
CREATE INDEX "collection_parcel_photo_stop_idx" ON "collection_parcel_photo" USING btree ("pickup_stop_id");--> statement-breakpoint
CREATE INDEX "collection_parcel_photo_hub_idx" ON "collection_parcel_photo" USING btree ("responsible_hub_id","attached_at");--> statement-breakpoint
CREATE UNIQUE INDEX "parcel_photo_exception_stop_key" ON "parcel_photo_exception" USING btree ("pickup_stop_id");--> statement-breakpoint
CREATE INDEX "parcel_photo_exception_hub_idx" ON "parcel_photo_exception" USING btree ("responsible_hub_id","authorised_at");--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_purpose_closed" CHECK ("evidence"."purpose" IN ('COLLECTION_PROOF', 'PARCEL_PHOTO', 'CONDITION', 'OSD', 'HANDOFF_RECEIPT', 'DELIVERY_PROOF', 'RETURN_PROOF', 'MAINTENANCE', 'FUEL', 'COMPLIANCE_DOCUMENT'));
--> statement-breakpoint
-- Run A2, 12 November 2026 (the Product Owner's decision D-A10: the photo of every parcel at the door; pickup-collection.md section 5.5). Everything above this comment is generated
-- (drizzle-kit, from src/pickup/collection-parcel-photo.schema.ts, src/pickup/parcel-photo-exception.schema.ts and src/platform/evidence/evidence-vocabulary.ts); everything below is in
-- this migration so that neither table exists for a moment without its owner, row-level security, policies, grants and guards. Forward of 0080, 0083 and 0085.
--
--   * A new purpose of evidence, PARCEL_PHOTO: the photo of one parcel at the door. It is declared and completed by the rider under the key of the count it belongs to
--     (pickup.collection.confirm), where a failure's photo (COLLECTION_PROOF) is declared under the key of the failure (pickup.failure.report); the policies pair each purpose with its key.
--     The count may also read the failure-kind photo a short count's reason asks for (it is attached to the stop as a failure's photo is, in pickup_stop_evidence).
--   * collection_parcel_photo links each stored parcel photo to the count it was made for: append-only, each photo attached once, and a guard that holds for every writer that only a
--     STORED photo of this very stop, captured as a parcel's photo by the rider who made the count, is attached to it. The hub, the rider and the moment are the guard's.
--   * THE NUMBER IS HELD BY THE DATABASE, at the end of the transaction, on both tables: a count has exactly collected_count photos, or none when Ops let the stop through without them
--     (parcel_photo_exception). A count with another number, a count with none included, and a photo added to a count later, are refused for every writer.
--   * parcel_photo_exception is written by one operation of the database (melarc.authorise_parcel_photo_exception, an officer of the stop's hub holding pickup.handshake.override), once
--     for a stop, before the count, and never changed or removed. The ledger's enhanced event is the application's, written beside it in the same transaction.
--   * Two policies that name another table are NOT used on a table the notification lane or another role reads (0085 found that out for the request): the policy of the exception names
--     the stop and the run, and the exception is read by the runtime login alone.

-- 1. The evidence of a parcel photo is declared, read, stored and scanned under the key of the count, and the evidence of a failure under the key of the failure. The key of the count is
-- also given the failure-kind photo for reading (a short count's reason may ask for one), the four evidence settings, and the derivation of the scope of a stop.
DROP POLICY "evidence_read" ON "evidence";
--> statement-breakpoint
CREATE POLICY "evidence_read" ON "evidence" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'RIDER' THEN (
        (coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.failure.report' AND "evidence"."purpose" = 'COLLECTION_PROOF')
        OR (coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.collection.confirm' AND "evidence"."purpose" IN ('PARCEL_PHOTO', 'COLLECTION_PROOF'))
      )
      AND "evidence"."captured_by_principal_type" = 'RIDER' AND "evidence"."captured_by_actor" = melarc.current_rider_id()
    WHEN 'STAFF' THEN coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.read'
      AND "evidence"."owner_type" = 'PICKUP_STOP' AND "evidence"."responsible_hub_id" IS NOT NULL
      AND (melarc.hub_scope_mode() = 'ALL' OR "evidence"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'evidence_validation' AND "evidence"."state" IN ('PENDING_UPLOAD', 'EXPIRED')
    ELSE false
  END
);
--> statement-breakpoint
DROP POLICY "evidence_declare" ON "evidence";
--> statement-breakpoint
CREATE POLICY "evidence_declare" ON "evidence" FOR INSERT WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'RIDER' THEN (
        (coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.failure.report' AND "evidence"."purpose" = 'COLLECTION_PROOF')
        OR (coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.collection.confirm' AND "evidence"."purpose" = 'PARCEL_PHOTO')
      )
      AND "evidence"."owner_type" = 'PICKUP_STOP'
      AND "evidence"."captured_by_principal_type" = 'RIDER' AND "evidence"."captured_by_actor" = melarc.current_rider_id()
      AND "evidence"."state" = 'PENDING_UPLOAD' AND "evidence"."access_rule" = 'SUBJECT_READERS' AND "evidence"."retention_policy" = 'PICKUP_STOP_EVIDENCE'
    ELSE false
  END
);
--> statement-breakpoint
DROP POLICY "evidence_store" ON "evidence";
--> statement-breakpoint
CREATE POLICY "evidence_store" ON "evidence" FOR UPDATE USING (
  CASE melarc.principal_type()
    WHEN 'RIDER' THEN (
        (coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.failure.report' AND "evidence"."purpose" = 'COLLECTION_PROOF')
        OR (coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.collection.confirm' AND "evidence"."purpose" = 'PARCEL_PHOTO')
      )
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
DROP POLICY "setting_evidence_read" ON "setting";
--> statement-breakpoint
CREATE POLICY "setting_evidence_read" ON "setting" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'RIDER' THEN coalesce(current_setting('melarc.authorization_key', true), '') IN ('pickup.failure.report', 'pickup.collection.confirm')
      AND key IN ('evidence_upload_max_bytes', 'evidence_upload_allowed_mime_types', 'evidence_upload_authorization_ttl_minutes', 'evidence_capture_clock_tolerance_minutes')
    ELSE false
  END
);
--> statement-breakpoint
DROP POLICY "pickup_request_evidence_rider_read" ON "pickup_request";
--> statement-breakpoint
CREATE POLICY "pickup_request_evidence_rider_read" ON "pickup_request" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'RIDER' THEN coalesce(current_setting('melarc.authorization_key', true), '') IN ('pickup.failure.report', 'pickup.collection.confirm') AND current_user = 'melarc_owner'
      AND melarc.rider_run_holds_request("pickup_request"."id")
    ELSE false
  END
);
--> statement-breakpoint
-- The failure-kind photo a short count's reason asks for is attached to the stop, as a failure's is: the count's key attaches and reads it as the failure's key does.
DROP POLICY "pickup_stop_evidence_read" ON "pickup_stop_evidence";
--> statement-breakpoint
CREATE POLICY "pickup_stop_evidence_read" ON "pickup_stop_evidence" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN split_part(coalesce(current_setting('melarc.authorization_key', true), ''), '.', 1) = 'pickup'
      AND (melarc.hub_scope_mode() = 'ALL' OR "pickup_stop_evidence"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    WHEN 'RIDER' THEN coalesce(current_setting('melarc.authorization_key', true), '') IN ('pickup.failure.report', 'pickup.collection.confirm')
      AND "pickup_stop_evidence"."attached_by_rider" = melarc.current_rider_id()
    ELSE false
  END
);
--> statement-breakpoint
DROP POLICY "pickup_stop_evidence_attach" ON "pickup_stop_evidence";
--> statement-breakpoint
CREATE POLICY "pickup_stop_evidence_attach" ON "pickup_stop_evidence" FOR INSERT WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'RIDER' THEN coalesce(current_setting('melarc.authorization_key', true), '') IN ('pickup.failure.report', 'pickup.collection.confirm')
      AND "pickup_stop_evidence"."attached_by_rider" = melarc.current_rider_id()
    ELSE false
  END
);
--> statement-breakpoint
-- The derivation of the scope of a stop's evidence, for either key (0080 asked for the failure's alone).
CREATE OR REPLACE FUNCTION melarc.evidence_pickup_stop_scope(p_stop uuid, OUT out_hub uuid, OUT out_vendor uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF melarc.principal_type() <> 'RIDER'
     OR coalesce(pg_catalog.current_setting('melarc.authorization_key', true), '') NOT IN ('pickup.failure.report', 'pickup.collection.confirm') THEN
    RAISE EXCEPTION 'the scope of the evidence of a stop is derived for the rider that reports its failure or counts its parcels, and for nobody else' USING ERRCODE = '42501';
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
-- The guard of the evidence record as 0086 made it, with the scope derived under either key.
CREATE OR REPLACE FUNCTION melarc.evidence_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  derived record;
  instant timestamp with time zone := pg_catalog.clock_timestamp();
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'evidence is retained and never deleted' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'PENDING_UPLOAD' OR NEW.uploaded_at IS NOT NULL OR NEW.validated_signature IS NOT NULL
       OR NEW.scanner IS NOT NULL OR NEW.scanner_signature_version IS NOT NULL OR NEW.scanned_at IS NOT NULL THEN
      RAISE EXCEPTION 'evidence is declared pending its upload' USING ERRCODE = '23514', DETAIL = 'reason=VALIDATION_FAILED';
    END IF;
    -- The moment of a capture may run ahead of the database's clock by the platform's tolerance and no more (D-A8). It bounds the future only.
    IF NEW.captured_at > instant + pg_catalog.make_interval(mins => melarc.evidence_limit('evidence_capture_clock_tolerance_minutes', 0)) THEN
      RAISE EXCEPTION 'the moment of a capture is not ahead of the clock by more than the tolerance' USING ERRCODE = '23514', DETAIL = 'reason=VALIDATION_FAILED';
    END IF;
    -- The lifetime of the upload instruction and the size of the file are the platform's settings, for every writer (finding M1 of the review of Run A). A shorter lifetime is no harm.
    IF NEW.upload_ttl_seconds::bigint > melarc.evidence_limit('evidence_upload_authorization_ttl_minutes', 1)::bigint * 60 THEN
      RAISE EXCEPTION 'the upload instruction of evidence lives no longer than the platform setting grants' USING ERRCODE = '23514', DETAIL = 'reason=UPLOAD_LIFETIME_EXCEEDED';
    END IF;
    IF NEW.byte_size::bigint > melarc.evidence_limit('evidence_upload_max_bytes', 1)::bigint THEN
      RAISE EXCEPTION 'evidence is no larger than the platform setting grants' USING ERRCODE = '23514', DETAIL = 'reason=UPLOAD_SIZE_EXCEEDED';
    END IF;
    -- The instants are the database's own: a writer does not choose when a record was made or when its upload window ends (to the second, so that the upload instruction can be made again, identically).
    NEW.created_at := pg_catalog.date_trunc('second', instant);
    NEW.upload_expires_at := NEW.created_at + pg_catalog.make_interval(secs => NEW.upload_ttl_seconds);
    NEW.version := 1;
    -- Under the rider's key (the failure's, or the count's for a parcel's photo) the scope is derived from the stop and is not the writer's to give (GBT-M9).
    IF NEW.owner_type = 'PICKUP_STOP'
       AND melarc.principal_type() = 'RIDER'
       AND coalesce(pg_catalog.current_setting('melarc.authorization_key', true), '') IN ('pickup.failure.report', 'pickup.collection.confirm') THEN
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
    -- Stored only on a clean verdict (D-A6): the scanner and the version of its signatures are on the record, and the moment is the database's, never the writer's.
    IF NEW.scanner IS NULL OR NEW.scanner_signature_version IS NULL THEN
      RAISE EXCEPTION 'evidence is stored only with the clean verdict of the content scan recorded on it' USING ERRCODE = '23514', DETAIL = 'reason=VALIDATION_FAILED';
    END IF;
    NEW.uploaded_at := instant;
    NEW.scanned_at := instant;
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

-- 2. The photos of a count.
ALTER TABLE "collection_parcel_photo" OWNER TO melarc_owner;
--> statement-breakpoint
ALTER TABLE "collection_parcel_photo" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "collection_parcel_photo" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Who reads: the staff of the stop's hub under a key of the pickup domain (the stop's photos are Ops's screen, S1.30); the rider only what it attached. No vendor reads a photo of its own
-- stop yet (SLICE-015 builds that read), and no other principal reads at all.
CREATE POLICY "collection_parcel_photo_read" ON "collection_parcel_photo" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN split_part(coalesce(current_setting('melarc.authorization_key', true), ''), '.', 1) = 'pickup'
      AND (melarc.hub_scope_mode() = 'ALL' OR "collection_parcel_photo"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    WHEN 'RIDER' THEN coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.collection.confirm'
      AND "collection_parcel_photo"."attached_by_rider" = melarc.current_rider_id()
    ELSE false
  END
);
--> statement-breakpoint
-- Who writes: the rider, under the key of the count, for a record it captured (the guard derives the rider from the evidence and the policy ties it to the session).
CREATE POLICY "collection_parcel_photo_attach" ON "collection_parcel_photo" FOR INSERT WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'RIDER' THEN coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.collection.confirm'
      AND "collection_parcel_photo"."attached_by_rider" = melarc.current_rider_id()
    ELSE false
  END
);
--> statement-breakpoint
-- The writer names the photo and the count and nothing else: the stop, the hub, the rider and the moment are the guard's.
GRANT SELECT ON "collection_parcel_photo" TO melarc_api_runtime;
--> statement-breakpoint
GRANT INSERT ("evidence_id", "collection_record_id") ON "collection_parcel_photo" TO melarc_api_runtime;
--> statement-breakpoint
CREATE FUNCTION melarc.collection_parcel_photo_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  counted public.collection_record%ROWTYPE;
  stop_row public.pickup_stop%ROWTYPE;
  proof public.evidence%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'the photos of a count are kept as they were attached: never changed and never removed' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO counted FROM public.collection_record WHERE id = NEW.collection_record_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'a photo is attached to a count that is not there' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT';
  END IF;
  -- The stop's lock first, and then the judgement (as the failure photo's guard does): a skip or a failure that began after the stop was read as arrived cannot commit beside a link.
  SELECT * INTO stop_row FROM public.pickup_stop WHERE id = counted.pickup_stop_id FOR UPDATE;
  IF NOT FOUND THEN
    SELECT * INTO stop_row FROM public.pickup_stop WHERE id = counted.pickup_stop_id;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'a photo is attached to a pickup stop that is not there' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT';
  END IF;
  SELECT * INTO proof FROM public.evidence WHERE id = NEW.evidence_id;
  IF NOT FOUND OR proof.state <> 'STORED' OR proof.owner_type <> 'PICKUP_STOP' OR proof.owner_id <> stop_row.id
     OR proof.purpose <> 'PARCEL_PHOTO' OR proof.captured_by_principal_type <> 'RIDER' OR proof.captured_by_actor <> counted.recorded_by THEN
    RAISE EXCEPTION 'only a stored photo of this very stop, captured as a parcel''s photo by the rider who made the count, is attached to the count' USING ERRCODE = '23514', DETAIL = 'reason=EVIDENCE_NOT_STORED';
  END IF;
  IF stop_row.state <> 'ARRIVED' OR stop_row.released_at IS NOT NULL
     OR NOT EXISTS (
       SELECT 1 FROM public.pickup_manifest m
        WHERE m.id = stop_row.pickup_manifest_id AND m.state = 'IN_PROGRESS' AND m.assigned_rider_id = proof.captured_by_actor
     ) THEN
    RAISE EXCEPTION 'a photo is attached to the count of a stop the rider has arrived at, on a run in progress that is assigned to it' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT';
  END IF;
  -- The stop, the hub, the rider and the moment are derived, never given.
  NEW.pickup_stop_id := stop_row.id;
  NEW.responsible_hub_id := stop_row.responsible_hub_id;
  NEW.attached_by_rider := proof.captured_by_actor;
  NEW.attached_at := pg_catalog.date_trunc('milliseconds', pg_catalog.clock_timestamp());
  RETURN NEW;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.collection_parcel_photo_guard() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.collection_parcel_photo_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "collection_parcel_photo_guard" BEFORE INSERT OR UPDATE OR DELETE ON "collection_parcel_photo"
  FOR EACH ROW EXECUTE FUNCTION melarc.collection_parcel_photo_guard();
--> statement-breakpoint

-- 3. Ops lets a stop's count through without parcel photos.
ALTER TABLE "parcel_photo_exception" OWNER TO melarc_owner;
--> statement-breakpoint
ALTER TABLE "parcel_photo_exception" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "parcel_photo_exception" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Who reads: the staff of the stop's hub under a key of the pickup domain, and the rider only for a stop it has arrived at on its own run in progress, to know whether its count takes
-- photos. The policy names the stop and the run, which is allowed because the runtime login is the only role with a privilege on this table.
CREATE POLICY "parcel_photo_exception_read" ON "parcel_photo_exception" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN split_part(coalesce(current_setting('melarc.authorization_key', true), ''), '.', 1) = 'pickup'
      AND (melarc.hub_scope_mode() = 'ALL' OR "parcel_photo_exception"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    WHEN 'RIDER' THEN coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.collection.confirm'
      AND EXISTS (
        SELECT 1 FROM public.pickup_stop AS s JOIN public.pickup_manifest AS m ON m.id = s.pickup_manifest_id
         WHERE s.id = "parcel_photo_exception"."pickup_stop_id" AND m.state = 'IN_PROGRESS' AND m.assigned_rider_id = melarc.current_rider_id()
      )
    ELSE false
  END
);
--> statement-breakpoint
-- Who writes: nobody but the operation (a statement that runs as the owner), for an officer of the stop's hub holding the key of the override, and as that officer.
CREATE POLICY "parcel_photo_exception_authorise" ON "parcel_photo_exception" FOR INSERT WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_user = 'melarc_owner' AND coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.handshake.override'
      AND "parcel_photo_exception"."authorised_by" = melarc.current_principal_id()
      AND (melarc.hub_scope_mode() = 'ALL' OR "parcel_photo_exception"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
);
--> statement-breakpoint
GRANT SELECT ON "parcel_photo_exception" TO melarc_api_runtime;
--> statement-breakpoint
CREATE FUNCTION melarc.parcel_photo_exception_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  stop_row public.pickup_stop%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'the exception for a stop is kept as it was made: never changed and never removed' USING ERRCODE = '23514';
  END IF;
  IF NEW.note IS NULL OR pg_catalog.btrim(NEW.note) = '' THEN
    RAISE EXCEPTION 'an exception says why the stop is let through without parcel photos' USING ERRCODE = '23514', DETAIL = 'reason=REASON_REQUIRED';
  END IF;
  SELECT * INTO stop_row FROM public.pickup_stop WHERE id = NEW.pickup_stop_id FOR UPDATE;
  IF NOT FOUND THEN
    SELECT * INTO stop_row FROM public.pickup_stop WHERE id = NEW.pickup_stop_id;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'there is no such stop in the officer''s hubs' USING ERRCODE = '42501';
  END IF;
  IF stop_row.state <> 'ARRIVED' OR stop_row.released_at IS NOT NULL THEN
    RAISE EXCEPTION 'only a stop that has been arrived at and not closed is let through without parcel photos' USING ERRCODE = '23514', DETAIL = 'reason=STOP_NOT_ARRIVED';
  END IF;
  IF EXISTS (SELECT 1 FROM public.collection_record AS c WHERE c.pickup_stop_id = NEW.pickup_stop_id) THEN
    RAISE EXCEPTION 'a stop that has been counted cannot be let through without parcel photos' USING ERRCODE = '23514', DETAIL = 'reason=COLLECTION_RECORDED';
  END IF;
  -- The hub is the stop's, the officer is the session's, the moment is the database's: a writer gives the stop and the note and nothing else.
  NEW.responsible_hub_id := stop_row.responsible_hub_id;
  IF melarc.principal_type() = 'STAFF' THEN
    NEW.authorised_by := melarc.current_principal_id();
  ELSIF NEW.authorised_by IS NULL THEN
    RAISE EXCEPTION 'an exception names the officer who made it' USING ERRCODE = '23514';
  END IF;
  NEW.authorised_at := pg_catalog.date_trunc('milliseconds', pg_catalog.clock_timestamp());
  NEW.note := pg_catalog.btrim(NEW.note);
  RETURN NEW;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.parcel_photo_exception_guard() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.parcel_photo_exception_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "parcel_photo_exception_guard" BEFORE INSERT OR UPDATE OR DELETE ON "parcel_photo_exception"
  FOR EACH ROW EXECUTE FUNCTION melarc.parcel_photo_exception_guard();
--> statement-breakpoint
-- melarc.authorise_parcel_photo_exception: `authoriseParcelPhotoException`. An officer of the stop's hub, under the key `pickup.handshake.override`, lets a stop's count through without parcel
-- photos, with the note that says why. The stop is locked first (as the count locks it), so that the exception and the count meet in either order: a count that commits first leaves
-- nothing to except, and an exception that commits first is seen by the count. The enhanced event is the application's, written beside this change in the same transaction.
CREATE FUNCTION melarc.authorise_parcel_photo_exception(p_new_id uuid, p_stop uuid, p_note text)
RETURNS TABLE (out_id uuid, out_pickup_stop_id uuid, out_responsible_hub_id uuid, out_authorised_by uuid, out_authorised_at timestamp with time zone, out_note text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  stop_row public.pickup_stop%ROWTYPE;
  made public.parcel_photo_exception%ROWTYPE;
BEGIN
  IF melarc.principal_type() <> 'STAFF' OR coalesce(pg_catalog.current_setting('melarc.authorization_key', true), '') <> 'pickup.handshake.override' THEN
    RAISE EXCEPTION 'a stop is let through without parcel photos by an officer holding the key of the override' USING ERRCODE = '42501';
  END IF;
  IF p_new_id IS NULL OR p_stop IS NULL THEN
    RAISE EXCEPTION 'an exception names a stop' USING ERRCODE = '22023';
  END IF;
  IF p_note IS NULL OR pg_catalog.btrim(p_note) = '' THEN
    RAISE EXCEPTION 'an exception says why the stop is let through without parcel photos' USING ERRCODE = '23514', DETAIL = 'reason=REASON_REQUIRED';
  END IF;
  SELECT * INTO stop_row FROM public.pickup_stop AS s WHERE s.id = p_stop FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'there is no such stop in the officer''s hubs' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.parcel_photo_exception (id, pickup_stop_id, note) VALUES (p_new_id, p_stop, p_note) RETURNING * INTO made;
  RETURN QUERY SELECT made.id, made.pickup_stop_id, made.responsible_hub_id, made.authorised_by, made.authorised_at, made.note;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.authorise_parcel_photo_exception(uuid, uuid, text) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.authorise_parcel_photo_exception(uuid, uuid, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.authorise_parcel_photo_exception(uuid, uuid, text) TO melarc_api_runtime;
--> statement-breakpoint

-- 4. THE NUMBER OF PHOTOS IS THE COUNT'S, checked at the end of the transaction on both tables: exactly collected_count, or none when Ops let the stop through without them. A count
-- made and a photo added later are both checked, so neither the record without its photos, nor the photos without their record, nor a photo added to a count afterwards, can be kept.
CREATE FUNCTION melarc.collection_photos_check() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  counted public.collection_record%ROWTYPE;
  photos bigint;
  excused boolean;
BEGIN
  IF TG_TABLE_NAME = 'collection_record' THEN
    SELECT * INTO counted FROM public.collection_record WHERE id = NEW.id;
  ELSE
    SELECT * INTO counted FROM public.collection_record WHERE id = NEW.collection_record_id;
  END IF;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  SELECT pg_catalog.count(*) INTO photos FROM public.collection_parcel_photo WHERE collection_record_id = counted.id;
  excused := EXISTS (SELECT 1 FROM public.parcel_photo_exception WHERE pickup_stop_id = counted.pickup_stop_id);
  IF (excused AND photos <> 0) OR (NOT excused AND photos <> counted.collected_count) THEN
    RAISE EXCEPTION 'a count has one parcel photo for each parcel counted, or none when Ops let the stop through without them'
      USING ERRCODE = '23514', CONSTRAINT = 'collection_parcel_photo_count';
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.collection_photos_check() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.collection_photos_check() FROM PUBLIC;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "collection_record_photo_count" AFTER INSERT ON "collection_record"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION melarc.collection_photos_check();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "collection_parcel_photo_count" AFTER INSERT ON "collection_parcel_photo"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION melarc.collection_photos_check();