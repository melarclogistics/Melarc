-- Run B, 13 November 2026 (Part 1, item 1 of the Product Owner's review of Run A2; OB-S1-52). A short count whose reason asks for a photo (reason_code.requires_photo, read from the
-- catalogue and never hard-coded: PARCEL_DAMAGED_OR_UNSAFE today) could never be recorded. The guard of the record refused such a reason at the insert, for every writer ("no evidence can
-- be stored yet", migration 0070, written before the evidence store existed), so recordCollection answered REASON_REQUIRED for a count that named its photo, and kept nothing.
-- Forward of 0070 (the guard) and 0088 (the deferred check).
--
--   * The guard of the record no longer refuses the reason at the insert. Nothing else of it changes: it is the definition of 0070, word for word, without that one refusal, because the photo
--     is attached to the stop after the record is made, in the same transaction, and the insert cannot see it.
--   * THE PHOTO IS HELD AT THE END OF THE TRANSACTION, as the number of the parcel photos is (0088), for every writer: a short count whose reason asks for a photo has attached to its stop a
--     stored COLLECTION_PROOF record of that stop, captured by the rider who counted (the photo of the parcel left behind, apart from the photo of each parcel counted). The rule is added to
--     the function of 0088, so the one deferred trigger of the record judges both; its constraint is collection_record_reason_photo.

-- 1. The guard of a collection record as 0070 made it, without the refusal of a reason that asks for a photo.
CREATE OR REPLACE FUNCTION melarc.collection_record_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  stop_row public.pickup_stop%ROWTYPE;
  run_state text;
  declared integer;
  catalogue public.reason_code%ROWTYPE;
  instant timestamp with time zone;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- The stop's lock first, and then the judgement: a foreign-key check takes only a share lock on the stop that an update of its state does not
    -- conflict with, so without this a skip or a failure that began after the stop was read as arrived could commit beside the record. With the lock,
    -- the writer that comes second waits for the first and judges what the first left (the skip's trigger looks for a record after it holds the lock,
    -- and this looks at the state after it holds it). A writer the policies do not allow to lock the stop falls back to a plain read: it is refused by
    -- the insert policy, and makes no record.
    SELECT * INTO stop_row FROM public.pickup_stop WHERE id = NEW.pickup_stop_id FOR UPDATE;
    IF NOT FOUND THEN
      SELECT * INTO stop_row FROM public.pickup_stop WHERE id = NEW.pickup_stop_id;
    END IF;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'a collection record names a pickup stop that is not there' USING ERRCODE = '23514';
    END IF;
    IF stop_row.state <> 'ARRIVED' OR stop_row.released_at IS NOT NULL THEN
      RAISE EXCEPTION 'a collection is recorded for a stop that has been arrived at and not resolved' USING ERRCODE = '23514';
    END IF;
    SELECT state INTO run_state FROM public.pickup_manifest WHERE id = stop_row.pickup_manifest_id;
    IF run_state IS DISTINCT FROM 'IN_PROGRESS' THEN
      RAISE EXCEPTION 'a collection is recorded on a run in progress' USING ERRCODE = '23514';
    END IF;
    declared := nullif(stop_row.pickup_summary ->> 'declared_package_count', '')::integer;
    IF declared IS NULL OR NEW.declared_count <> declared THEN
      RAISE EXCEPTION 'the declared count of a collection record is the one the stop declared' USING ERRCODE = '23514';
    END IF;
    IF NEW.version <> 1 OR NEW.handshake_channel IS NOT NULL OR NEW.handshake_override_by IS NOT NULL OR NEW.handshake_confirmed_at IS NOT NULL THEN
      RAISE EXCEPTION 'a collection record begins with no handshake outcome' USING ERRCODE = '23514';
    END IF;
    IF melarc.principal_type() = 'RIDER' AND coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.collection.confirm'
       AND NEW.handshake_type IS DISTINCT FROM melarc.collection_handshake_type(NEW.pickup_stop_id) THEN
      RAISE EXCEPTION 'the direction of a collection record is the one the request''s sender fixes' USING ERRCODE = '23514';
    END IF;
    -- The facts of the record that are the catalogue's and the clock's (OB-S1-60), judged for every writer, with the stop's lock held. A direct insert
    -- by the permitted writer (the rider's key, its own arrived stop) used to keep a reason the catalogue does not hold, with a label and an attribution
    -- of its own, and any instant it chose for the recording and the flag: nothing judged what they said.
    --
    -- The reason of a short count is a reason of the PICKUP_SHORT_COUNT catalogue that is active, with the label and the attribution the catalogue holds
    -- now, in the shape the application builds (its code, its label, its attribution and the rider's note, and no member of a writer's own), and it
    -- satisfies the rules of its metadata: a note where it asks for one. The photo it may ask for is not judged here: it is attached to the stop after the record is made, in the same
    -- transaction, so the insert cannot see it, and the rule is the one of the end of the transaction (melarc.collection_photos_check, 0089). A snapshot read before the catalogue
    -- changed no longer agrees with it and is refused, with the reasons the
    -- application answers as what they are (the DETAIL, read by guardReasonIn): it is the application's to say that the reason it read is not the reason
    -- there is, and the same key and body then make the record from the catalogue as it stands. The snapshot is the reason as it was at the count and is
    -- never read again, so a later edit of the catalogue leaves it as it was (the update branch below freezes it).
    IF NEW.variance = 'SHORT' THEN
      IF NEW.variance_reason_snapshot IS NULL THEN
        RAISE EXCEPTION 'a short count gives the reason of the catalogue' USING ERRCODE = '23514', DETAIL = 'reason=REASON_REQUIRED';
      END IF;
      IF jsonb_typeof(NEW.variance_reason_snapshot) IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION 'the reason of a short count is kept as the application builds it' USING ERRCODE = '23514', DETAIL = 'reason=REASON_NOT_ACTIVE';
      END IF;
      IF EXISTS (SELECT 1 FROM jsonb_object_keys(NEW.variance_reason_snapshot) AS k(key) WHERE k.key NOT IN ('reason_code', 'label', 'attribution', 'note'))
         OR jsonb_typeof(NEW.variance_reason_snapshot -> 'label') IS DISTINCT FROM 'string'
         OR ((NEW.variance_reason_snapshot -> 'note') IS NOT NULL
             AND (jsonb_typeof(NEW.variance_reason_snapshot -> 'note') <> 'string' OR char_length(NEW.variance_reason_snapshot ->> 'note') > 1000)) THEN
        RAISE EXCEPTION 'the reason of a short count is kept as the application builds it' USING ERRCODE = '23514', DETAIL = 'reason=REASON_NOT_ACTIVE';
      END IF;
      SELECT * INTO catalogue FROM public.reason_code AS rc
       WHERE rc.code = (NEW.variance_reason_snapshot ->> 'reason_code') AND rc.domain = 'PICKUP_SHORT_COUNT';
      IF NOT FOUND OR NOT catalogue.active
         OR catalogue.label IS DISTINCT FROM (NEW.variance_reason_snapshot ->> 'label')
         OR catalogue.attribution IS DISTINCT FROM (NEW.variance_reason_snapshot ->> 'attribution') THEN
        RAISE EXCEPTION 'the reason of a short count is an active reason of the PICKUP_SHORT_COUNT catalogue, as the catalogue holds it' USING ERRCODE = '23514', DETAIL = 'reason=REASON_NOT_ACTIVE';
      END IF;
      IF catalogue.requires_note AND btrim(coalesce(NEW.variance_reason_snapshot ->> 'note', '')) = '' THEN
        RAISE EXCEPTION 'the reason of this short count asks for a note' USING ERRCODE = '23514', DETAIL = 'reason=REASON_REQUIRED';
      END IF;
    END IF;
    -- The recording and the office flag are the database's own instants, taken now that the stop's lock is held: a writer that waited for the lock is
    -- stamped no earlier than the moment the writer before it let go, which a default of now() (the beginning of the transaction) does not give. A short
    -- count has its flag raised at the recording, whatever the writer gave; a count that matches has no flag to raise, and one given is refused by the table's
    -- own check (collection_record_shortfall_facts), for every writer. The device's own moment (captured_at) is another fact and is kept as the writer gave it.
    instant := clock_timestamp();
    NEW.recorded_at := instant;
    IF NEW.variance = 'SHORT' THEN
      NEW.office_notified_at := instant;
    END IF;
    RETURN NEW;
  END IF;
  -- An update: what the count says never changes, and what the handshake sets is set once (null to a value, never back).
  IF (to_jsonb(NEW) - 'version' - 'handshake_channel' - 'handshake_override_by' - 'handshake_confirmed_at')
     IS DISTINCT FROM (to_jsonb(OLD) - 'version' - 'handshake_channel' - 'handshake_override_by' - 'handshake_confirmed_at') THEN
    RAISE EXCEPTION 'a collection record is not changed once it is made' USING ERRCODE = '23514';
  END IF;
  IF OLD.handshake_channel IS NOT NULL AND (NEW.handshake_channel IS DISTINCT FROM OLD.handshake_channel
     OR NEW.handshake_override_by IS DISTINCT FROM OLD.handshake_override_by OR NEW.handshake_confirmed_at IS DISTINCT FROM OLD.handshake_confirmed_at) THEN
    RAISE EXCEPTION 'the outcome of a handshake is not changed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
-- 2. The deferred check of the record, with the photo of the parcel left behind added to the number of the parcel photos.
CREATE OR REPLACE FUNCTION melarc.collection_photos_check() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
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
  RETURN NULL;
END
$$;
