CREATE TABLE "collection_parcel_photo_staged" (
	"evidence_id" uuid PRIMARY KEY NOT NULL,
	"pickup_stop_id" uuid NOT NULL,
	"responsible_hub_id" uuid NOT NULL,
	"staged_by_rider" uuid NOT NULL,
	"staged_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "collection_parcel_photo_staged" ADD CONSTRAINT "collection_parcel_photo_staged_evidence_fkey" FOREIGN KEY ("evidence_id") REFERENCES "public"."evidence"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_parcel_photo_staged" ADD CONSTRAINT "collection_parcel_photo_staged_stop_fkey" FOREIGN KEY ("pickup_stop_id","responsible_hub_id") REFERENCES "public"."pickup_stop"("id","responsible_hub_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_parcel_photo_staged" ADD CONSTRAINT "collection_parcel_photo_staged_rider_fkey" FOREIGN KEY ("staged_by_rider") REFERENCES "public"."rider_identity"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "collection_parcel_photo_staged_stop_idx" ON "collection_parcel_photo_staged" USING btree ("pickup_stop_id","staged_at");
--> statement-breakpoint
-- Run E, 17 November 2026 (the Product Owner's decision D-E1; pickup-collection.md section 5.5; the plan's Stage 6b). Everything above this comment is generated (drizzle-kit, from
-- src/pickup/collection-parcel-photo-staged.schema.ts); everything below is in this migration so that the table never exists for a moment without its owner, row-level security, policies, grants and
-- guard. Forward of 0088 and 0090; nothing earlier is edited. Applied as melarc_migration_elevated, a member of melarc_owner (MIGRATION_AND_SEEDING.md section 5.1).
--
--   * collection_parcel_photo_staged holds the parcel photos of a count that is not yet made, put aside by the rider in batches, so that a collection of any size reaches the server in requests the
--     transport admits (the body limit stays; the most one request could name was 2,624 identifiers). The count (recordCollection) attaches the staged photos and the ones it names together, in its own
--     transaction; THIS TABLE IS NOT THE COUNT'S LINK (collection_parcel_photo is) and nothing that counts reads it.
--   * THE STAGED SET IS CLOSED BY THE COUNT. The guard takes the stop's row lock first, as the link of a photo to a count does (0088) and as Ops's skip and a failure do, and then judges: the stop is
--     ARRIVED on a run in progress assigned to the rider who captured the photo, the stop has no collection record, and Ops has not let it through without parcel photos. Staging and the count both
--     take that lock before they judge, so one of them commits first and the other finds the stop as it then is: a batch that commits before the count is counted, a batch that meets the count is
--     refused (STATE_CONFLICT). A row is never changed or removed, and a photo is staged once (the evidence record is the key).
--   * The deferred check of a count (melarc.collection_photos_check, 0088 and 0090) is restated at the end of this file: it ran once for every photo row at the commit and counted all of the count's
--     photos each time, so a count of N photos cost N counts of N rows.

-- 1. The table: its owner, row-level security and who reads and writes.
ALTER TABLE "collection_parcel_photo_staged" OWNER TO melarc_owner;
--> statement-breakpoint
ALTER TABLE "collection_parcel_photo_staged" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "collection_parcel_photo_staged" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Who reads: the rider, what it staged, under the key of the count. No staff, vendor or system context reads a staged photo: Ops reads the stop's photos from the evidence list, and what a count
-- attached is the link table's.
CREATE POLICY "collection_parcel_photo_staged_read" ON "collection_parcel_photo_staged" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'RIDER' THEN coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.collection.confirm'
      AND "collection_parcel_photo_staged"."staged_by_rider" = melarc.current_rider_id()
    ELSE false
  END
);
--> statement-breakpoint
-- Who writes: the rider, under the key of the count, for a record it captured (the guard derives the rider from the evidence and the policy ties it to the session).
CREATE POLICY "collection_parcel_photo_staged_stage" ON "collection_parcel_photo_staged" FOR INSERT WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'RIDER' THEN coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.collection.confirm'
      AND "collection_parcel_photo_staged"."staged_by_rider" = melarc.current_rider_id()
    ELSE false
  END
);
--> statement-breakpoint
-- The writer names the photo and nothing else: the stop, the hub, the rider and the moment are the guard's.
GRANT SELECT ON "collection_parcel_photo_staged" TO melarc_api_runtime;
--> statement-breakpoint
GRANT INSERT ("evidence_id") ON "collection_parcel_photo_staged" TO melarc_api_runtime;
--> statement-breakpoint
-- 2. The guard, for every writer: what may be staged, and when the staged set is closed.
CREATE FUNCTION melarc.collection_parcel_photo_staged_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  proof public.evidence%ROWTYPE;
  stop_row public.pickup_stop%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'the photos staged for a count are kept as they were staged: never changed and never removed' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO proof FROM public.evidence WHERE id = NEW.evidence_id;
  IF NOT FOUND OR proof.state <> 'STORED' OR proof.owner_type <> 'PICKUP_STOP' OR proof.purpose <> 'PARCEL_PHOTO' OR proof.captured_by_principal_type <> 'RIDER' THEN
    RAISE EXCEPTION 'only a stored photo of a stop, captured as a parcel''s photo by a rider, is staged for its count' USING ERRCODE = '23514', DETAIL = 'reason=EVIDENCE_NOT_STORED';
  END IF;
  -- The stop's lock first, and then the judgement (as the link of a photo to a count does): a count, a skip or a failure that began after the stop was read as arrived cannot commit beside a
  -- staged photo, in either order.
  SELECT * INTO stop_row FROM public.pickup_stop WHERE id = proof.owner_id FOR UPDATE;
  IF NOT FOUND THEN
    SELECT * INTO stop_row FROM public.pickup_stop WHERE id = proof.owner_id;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'a photo is staged for a pickup stop that is not there' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT';
  END IF;
  IF stop_row.state <> 'ARRIVED' OR stop_row.released_at IS NOT NULL
     OR NOT EXISTS (
       SELECT 1 FROM public.pickup_manifest m
        WHERE m.id = stop_row.pickup_manifest_id AND m.state = 'IN_PROGRESS' AND m.assigned_rider_id = proof.captured_by_actor
     ) THEN
    RAISE EXCEPTION 'a photo is staged for a stop the rider has arrived at, on a run in progress that is assigned to it' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT', HINT = 'rule=stop_not_arrived';
  END IF;
  -- The count closes the staged set: once the stop has its collection record nothing is added to it.
  IF EXISTS (SELECT 1 FROM public.collection_record WHERE pickup_stop_id = stop_row.id) THEN
    RAISE EXCEPTION 'the count of this stop is made, and its staged photos are closed' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT', HINT = 'rule=collection_recorded';
  END IF;
  -- A stop that Ops let through without parcel photos takes none, staged or named.
  IF EXISTS (SELECT 1 FROM public.parcel_photo_exception WHERE pickup_stop_id = stop_row.id) THEN
    RAISE EXCEPTION 'Ops let this stop through without parcel photos, so none is staged for it' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT', HINT = 'rule=parcel_photo_exception';
  END IF;
  IF EXISTS (SELECT 1 FROM public.collection_parcel_photo WHERE evidence_id = NEW.evidence_id) THEN
    RAISE EXCEPTION 'a photo that is attached to a count is not staged' USING ERRCODE = '23514', DETAIL = 'reason=EVIDENCE_NOT_STORED';
  END IF;
  -- The stop, the hub, the rider and the moment are derived, never given.
  NEW.pickup_stop_id := stop_row.id;
  NEW.responsible_hub_id := stop_row.responsible_hub_id;
  NEW.staged_by_rider := proof.captured_by_actor;
  NEW.staged_at := pg_catalog.date_trunc('milliseconds', pg_catalog.clock_timestamp());
  RETURN NEW;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.collection_parcel_photo_staged_guard() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.collection_parcel_photo_staged_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "collection_parcel_photo_staged_guard" BEFORE INSERT OR UPDATE OR DELETE ON "collection_parcel_photo_staged"
  FOR EACH ROW EXECUTE FUNCTION melarc.collection_parcel_photo_staged_guard();
--> statement-breakpoint
-- 3. THE DEFERRED CHECK OF A COUNT, MADE ONCE FOR A COUNT. melarc.collection_photos_check (0088; judged as the system since 0090) is a deferred constraint trigger on the count and on each of its photos,
-- so it runs once for every photo row at the end of the transaction, and each run counted all of the count's photos: a count of N photos cost N counts of N rows, which is quadratic. The first
-- run of a count in a transaction now remembers, in a setting that is local to the transaction, the count it has judged, and a later run for a photo of the same count returns at once.
--
-- Why that is as strict as it was: deferred triggers all run at the commit, after every statement of the transaction, so the first sees what the last would. A transaction that asked for its checks
-- earlier (SET CONSTRAINTS ... IMMEDIATE) runs them at the end of each statement, and a statement that changes the photos puts the setting back to empty first (the statement trigger below), so
-- the count is judged again by the first run after it. A transaction that touches several counts judges each again when it comes back to it, which is slower and never wrong.
-- THE SETTING IS NOT TRUSTED ALONE. Any statement of the runtime login can set a custom setting, so a writer could add a photo to a count that an EARLIER transaction made and then set the setting
-- to that count before the commit. The shortcut is therefore taken only when the count's own row was made by THIS transaction (its xmin is the transaction's): the count made here has its own deferred
-- event, which is never skipped and judges every photo of the transaction, so a forged setting hides nothing there, and a count of an earlier transaction is always judged in full. A count made
-- inside a savepoint carries the savepoint's identifier and is judged in full each time: slower and never wrong. Nothing else of the function changes: it is 0090's, word for word, beside the
-- lines marked 0108.
CREATE FUNCTION melarc.collection_photos_unchecked() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM pg_catalog.set_config('melarc.photos_checked', '', true);
  RETURN NULL;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.collection_photos_unchecked() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.collection_photos_unchecked() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "collection_parcel_photo_unchecked" BEFORE INSERT OR UPDATE OR DELETE ON "collection_parcel_photo"
  FOR EACH STATEMENT EXECUTE FUNCTION melarc.collection_photos_unchecked();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION melarc.collection_photos_check() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  previous_type text := coalesce(pg_catalog.current_setting('melarc.principal_type', true), '');
  previous_capability text := coalesce(pg_catalog.current_setting('melarc.task_capability', true), '');
  counted public.collection_record%ROWTYPE;
  photos bigint;
  excused boolean;
BEGIN
  -- The system's own context for the statements of this function, whatever context the writer is in at the commit (as melarc.change_role_bundle does, 0017); the caller's is put back below.
  PERFORM pg_catalog.set_config('melarc.principal_type', 'SYSTEM', true);
  PERFORM pg_catalog.set_config('melarc.task_capability', 'collection_photo_check', true);
  -- 0108: a photo of a count that this transaction made and judged, when no statement has changed the photos since (the statement trigger puts the setting back to empty), is not judged again.
  -- The count's own row must be this transaction's: a setting alone is not believed (see above). Read as the system, like everything else here.
  IF TG_TABLE_NAME = 'collection_parcel_photo' THEN
    IF coalesce(pg_catalog.current_setting('melarc.photos_checked', true), '') = NEW.collection_record_id::text
       AND EXISTS (
         SELECT 1 FROM public.collection_record AS made
          WHERE made.id = NEW.collection_record_id
            AND made.xmin::text = (pg_catalog.pg_current_xact_id()::text::bigint % 4294967296)::text
       ) THEN
      PERFORM pg_catalog.set_config('melarc.principal_type', previous_type, true);
      PERFORM pg_catalog.set_config('melarc.task_capability', previous_capability, true);
      RETURN NULL;
    END IF;
  END IF;
  IF TG_TABLE_NAME = 'collection_record' THEN
    SELECT * INTO counted FROM public.collection_record WHERE id = NEW.id;
  ELSE
    SELECT * INTO counted FROM public.collection_record WHERE id = NEW.collection_record_id;
  END IF;
  IF NOT FOUND THEN
    -- A count that cannot be found at the end of the transaction is not judged good: nothing the application does removes one, and a check that returns quietly lets through whatever it could not read.
    RAISE EXCEPTION 'the count that was checked is not there to be judged'
      USING ERRCODE = '23514', CONSTRAINT = 'collection_photos_check_record';
  END IF;
  SELECT pg_catalog.count(*) INTO photos FROM public.collection_parcel_photo WHERE collection_record_id = counted.id;
  excused := EXISTS (SELECT 1 FROM public.parcel_photo_exception WHERE pickup_stop_id = counted.pickup_stop_id);
  IF (excused AND photos <> 0) OR (NOT excused AND photos <> counted.collected_count) THEN
    RAISE EXCEPTION 'a count has one parcel photo for each parcel counted, or none when Ops let the stop through without them'
      USING ERRCODE = '23514', CONSTRAINT = 'collection_parcel_photo_count';
  END IF;
  -- The photo of the parcel left behind (OB-S1-52): a short count whose reason asks for a photo (read from the catalogue as it stands, never hard-coded) has attached to its stop a
  -- stored COLLECTION_PROOF record of that stop, captured by the rider who counted. The record is attached to the stop in pickup_stop_evidence, as a failure's photo is, and its own
  -- guard holds that it is stored, of this stop and a rider's; this holds that one is there when the count is kept, by whichever transaction attached it.
  IF counted.variance = 'SHORT'
     AND EXISTS (
       SELECT 1 FROM public.reason_code AS reason
        WHERE reason.domain = 'PICKUP_SHORT_COUNT' AND reason.requires_photo AND reason.code = (counted.variance_reason_snapshot ->> 'reason_code')
     )
     AND NOT EXISTS (
       SELECT 1 FROM public.pickup_stop_evidence AS attached JOIN public.evidence AS proof ON proof.id = attached.evidence_id
        WHERE attached.pickup_stop_id = counted.pickup_stop_id AND proof.state = 'STORED' AND proof.purpose = 'COLLECTION_PROOF'
          AND proof.owner_type = 'PICKUP_STOP' AND proof.owner_id = counted.pickup_stop_id
          AND proof.captured_by_principal_type = 'RIDER' AND proof.captured_by_actor = counted.recorded_by
     ) THEN
    RAISE EXCEPTION 'a short count whose reason asks for a photo has the photo of the parcel left behind attached to its stop'
      USING ERRCODE = '23514', CONSTRAINT = 'collection_record_reason_photo';
  END IF;
  -- 0108: this count is judged as it stands; a run for another photo of it, in this transaction, returns at once (until a statement changes the photos).
  PERFORM pg_catalog.set_config('melarc.photos_checked', counted.id::text, true);
  PERFORM pg_catalog.set_config('melarc.principal_type', previous_type, true);
  PERFORM pg_catalog.set_config('melarc.task_capability', previous_capability, true);
  RETURN NULL;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.collection_photos_check() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.collection_photos_check() TO melarc_owner;
--> statement-breakpoint
-- 4. THE LINK GUARD, WITHOUT THE LOOKUPS THE COUNT HAS ALREADY MADE (measured in Run E, 17 November 2026). melarc.collection_parcel_photo_guard (0088) judges every photo of a count by four reads
-- under row-level security (the count, the stop under its lock, the evidence record, the run) and, with the staged photos of 0108, a count of N photos was N such judgements: 3.3 seconds of
-- attaching for 5,000 photos as the rider and 0.5 as the administrator, which row-level security does not bind, and a count of 10,000 did not fit in the platform's ten-second transaction.
--
-- A photo that was STAGED for this very stop by the rider who makes the count has been judged already: when it was staged the staged guard held that it is a stored parcel photo of the stop,
-- captured by that rider, and a stored record never changes its stop, its purpose or its rider. What is left to judge at the link is the stop and the run, and for a count made BY THIS
-- TRANSACTION the count's own guard (0068, 0069) has just judged both under the stop's lock, which this transaction holds until it ends, so nothing can have changed them. The guard
-- therefore takes the shortcut only when BOTH hold, each read from the database and neither a setting a writer can set: the count's own row was made by this transaction (its xmin is the
-- transaction's), and the staged table holds the photo for the count's own stop and rider. It then derives the same four columns from that row. Every other photo (one the count names, a
-- count of an earlier transaction, a staged photo of another stop or rider) is judged as 0088 judged it, by the same statements. The number of photos is still held at the commit by the
-- deferred check, which no shortcut here touches.
CREATE OR REPLACE FUNCTION melarc.collection_parcel_photo_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  counted_stop uuid;
  counted_rider uuid;
  made_here boolean;
  staged public.collection_parcel_photo_staged%ROWTYPE;
  stop_row public.pickup_stop%ROWTYPE;
  proof public.evidence%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'the photos of a count are kept as they were attached: never changed and never removed' USING ERRCODE = '23514';
  END IF;
  SELECT counted.pickup_stop_id, counted.recorded_by,
         counted.xmin::text = (pg_catalog.pg_current_xact_id()::text::bigint % 4294967296)::text
    INTO counted_stop, counted_rider, made_here
    FROM public.collection_record AS counted WHERE counted.id = NEW.collection_record_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'a photo is attached to a count that is not there' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT';
  END IF;
  -- 0108: a photo staged for this stop by the rider who makes this count, for a count this transaction made: judged when it was staged, and the stop and the run when the count was made.
  IF made_here THEN
    SELECT * INTO staged FROM public.collection_parcel_photo_staged AS held
     WHERE held.evidence_id = NEW.evidence_id AND held.pickup_stop_id = counted_stop AND held.staged_by_rider = counted_rider;
    IF FOUND THEN
      NEW.pickup_stop_id := staged.pickup_stop_id;
      NEW.responsible_hub_id := staged.responsible_hub_id;
      NEW.attached_by_rider := staged.staged_by_rider;
      NEW.attached_at := pg_catalog.date_trunc('milliseconds', pg_catalog.clock_timestamp());
      RETURN NEW;
    END IF;
  END IF;
  -- The stop's lock first, and then the judgement (as the failure photo's guard does): a skip or a failure that began after the stop was read as arrived cannot commit beside a link.
  SELECT * INTO stop_row FROM public.pickup_stop WHERE id = counted_stop FOR UPDATE;
  IF NOT FOUND THEN
    SELECT * INTO stop_row FROM public.pickup_stop WHERE id = counted_stop;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'a photo is attached to a pickup stop that is not there' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT';
  END IF;
  SELECT * INTO proof FROM public.evidence WHERE id = NEW.evidence_id;
  IF NOT FOUND OR proof.state <> 'STORED' OR proof.owner_type <> 'PICKUP_STOP' OR proof.owner_id <> stop_row.id
     OR proof.purpose <> 'PARCEL_PHOTO' OR proof.captured_by_principal_type <> 'RIDER' OR proof.captured_by_actor <> counted_rider THEN
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
