-- Run B, 13 November 2026 (Part 1, item 2 of the Product Owner's review of Run A2). melarc.collection_photos_check is the deferred check of a collection record: the number of the parcel photos
-- of a count (0088) and the photo a short count's reason asks for (0089). Forward of 0088 and 0089.
--
-- WHAT WAS WRONG. The function ran with the CALLER'S rights and read the count, its photos and the exception of its stop as the context in force at the COMMIT, under row-level security.
--   (1) It returned quietly when that context could not see the count (NOT FOUND), so a writer that changed its context before COMMIT kept a count with no photos.
--   (2) It judged a good count by what that context could see, so a count Ops had let through without photos was refused when the context at the commit could not read the exception.
-- Every "every writer" test of 0088 wrote as the administrator, which row-level security does not bind, so neither was seen.
--
-- WHAT THIS DOES. The check asserts its own context for its own statements, as melarc.change_role_bundle does (0017): it is a SECURITY DEFINER function of the owner with a fixed search_path, it sets the
-- principal SYSTEM and the task capability collection_photo_check, reads, and puts the caller's context back before it returns. Six SELECT policies admit that capability, each naming the owner as well
-- (current_user = 'melarc_owner'), so a statement of any other login that asserts the label reaches nothing. It raises when it cannot find the count. No login is granted EXECUTE: a trigger function is not
-- called by a login, and the grant below is to the owner alone.

-- 1. What the capability may read, and only as the owner.
CREATE POLICY "collection_record_photo_check_read" ON "collection_record" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'collection_photo_check' AND current_user = 'melarc_owner'
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "collection_parcel_photo_photo_check_read" ON "collection_parcel_photo" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'collection_photo_check' AND current_user = 'melarc_owner'
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "parcel_photo_exception_photo_check_read" ON "parcel_photo_exception" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'collection_photo_check' AND current_user = 'melarc_owner'
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "pickup_stop_evidence_photo_check_read" ON "pickup_stop_evidence" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'collection_photo_check' AND current_user = 'melarc_owner'
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "evidence_photo_check_read" ON "evidence" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'collection_photo_check' AND current_user = 'melarc_owner'
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "reason_code_photo_check_read" ON "reason_code" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'collection_photo_check' AND current_user = 'melarc_owner'
    ELSE false
  END
);
--> statement-breakpoint
-- 2. The deferred check, judged as the system.
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
  PERFORM pg_catalog.set_config('melarc.principal_type', previous_type, true);
  PERFORM pg_catalog.set_config('melarc.task_capability', previous_capability, true);
  RETURN NULL;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.collection_photos_check() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.collection_photos_check() TO melarc_owner;
