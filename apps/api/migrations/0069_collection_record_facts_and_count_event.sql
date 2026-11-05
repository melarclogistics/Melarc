-- S1.26 closeout, on the Product Owner's approval of 4 November 2026: OB-S1-60 (the database is authoritative for the facts of a collection record)
-- and OB-S1-54 (the count has its own audit event). A forward migration: 0068 is not edited.
--
-- Why forward. `0068` is untracked in git and was applied to no database this machine holds (a read-only look at every database of the local server on
-- 4 November 2026, through the repository's own `checkAgainstApplied`: the owner's `melarc_dev` holds 0000 to 0063, and 0064 to 0068 are pending; four
-- leftover test databases stop at 0041 or 0057; no database holds 0068). But the text of 0068 has been given to two reviewers in archives, and what an
-- archive was run against cannot be established from here. The rule is that a migration an environment may hold is never edited, so the closeout is a
-- migration of its own, and a database that holds 0068 as reviewed takes this one in order.
--
-- 1. OB-S1-60. A real runtime rider's direct insert, under the counting key, for its own arrived stop, could keep a reason the PICKUP_SHORT_COUNT catalogue
--    does not hold (with a label and an attribution of its own) and any instant it chose for the recording and the flag. The guard now judges what the
--    snapshot says against the catalogue, and takes the two instants from the database's clock once the stop's lock is held (see the guard).
-- 2. OB-S1-54. The ledger's arm for the count named `pickup.stop.collected` and `pickup.stop.partially_collected`, which say that a stop closed, and
--    admitted them while the stop was still `ARRIVED`. The arm now admits `pickup.collection.recorded` and nothing else of the counting key, bound to the
--    stored record. The two events of the close are the handshake's (S1.27), which will add its own arm.
--
-- No owner, grant, policy of a table, trigger or function name changes: the guard is replaced in place (the trigger that calls it is the one 0068 made),
-- and the ledger's insert policy is replaced whole, as 0068 replaced 0067's, with the arm of the count changed and every other arm as 0068 left it.
CREATE OR REPLACE FUNCTION melarc.collection_record_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  stop_row pickup_stop%ROWTYPE;
  run_state text;
  declared integer;
  catalogue reason_code%ROWTYPE;
  instant timestamp with time zone;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- The stop's lock first, and then the judgement: a foreign-key check takes only a share lock on the stop that an update of its state does not
    -- conflict with, so without this a skip or a failure that began after the stop was read as arrived could commit beside the record. With the lock,
    -- the writer that comes second waits for the first and judges what the first left (the skip's trigger looks for a record after it holds the lock,
    -- and this looks at the state after it holds it). A writer the policies do not allow to lock the stop falls back to a plain read: it is refused by
    -- the insert policy, and makes no record.
    SELECT * INTO stop_row FROM pickup_stop WHERE id = NEW.pickup_stop_id FOR UPDATE;
    IF NOT FOUND THEN
      SELECT * INTO stop_row FROM pickup_stop WHERE id = NEW.pickup_stop_id;
    END IF;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'a collection record names a pickup stop that is not there' USING ERRCODE = '23514';
    END IF;
    IF stop_row.state <> 'ARRIVED' OR stop_row.released_at IS NOT NULL THEN
      RAISE EXCEPTION 'a collection is recorded for a stop that has been arrived at and not resolved' USING ERRCODE = '23514';
    END IF;
    SELECT state INTO run_state FROM pickup_manifest WHERE id = stop_row.pickup_manifest_id;
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
    -- satisfies the rules of its metadata: a note where it asks for one, and no photo asked for (no evidence can be stored before S1.28, so a reason
    -- that asks for one cannot be satisfied). A snapshot read before the catalogue changed no longer agrees with it and is refused, with the reasons the
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
      SELECT * INTO catalogue FROM reason_code AS rc
       WHERE rc.code = (NEW.variance_reason_snapshot ->> 'reason_code') AND rc.domain = 'PICKUP_SHORT_COUNT';
      IF NOT FOUND OR NOT catalogue.active
         OR catalogue.label IS DISTINCT FROM (NEW.variance_reason_snapshot ->> 'label')
         OR catalogue.attribution IS DISTINCT FROM (NEW.variance_reason_snapshot ->> 'attribution') THEN
        RAISE EXCEPTION 'the reason of a short count is an active reason of the PICKUP_SHORT_COUNT catalogue, as the catalogue holds it' USING ERRCODE = '23514', DETAIL = 'reason=REASON_NOT_ACTIVE';
      END IF;
      IF catalogue.requires_note AND btrim(coalesce(NEW.variance_reason_snapshot ->> 'note', '')) = '' THEN
        RAISE EXCEPTION 'the reason of this short count asks for a note' USING ERRCODE = '23514', DETAIL = 'reason=REASON_REQUIRED';
      END IF;
      IF catalogue.requires_photo THEN
        RAISE EXCEPTION 'the reason of this short count asks for a photo, and no evidence can be stored yet' USING ERRCODE = '23514', DETAIL = 'reason=REASON_REQUIRED';
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
ALTER FUNCTION melarc.collection_record_guard() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.collection_record_guard() FROM PUBLIC;
--> statement-breakpoint
ALTER POLICY "audit_event_insert" ON "audit_event" WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN actor_type = 'STAFF' AND actor_id = melarc.current_principal_id()
    WHEN 'VENDOR' THEN actor_type = 'VENDOR_ACCOUNT' AND actor_id = melarc.current_principal_id() AND surface_context = 'VENDOR_PWA' AND (
      (event_code = 'auth.session.terminated' AND object_type = 'Session' AND object_id = nullif(current_setting('melarc.session_id', true), '')::uuid AND reason_code = 'SIGNED_OUT' AND outcome = 'SUCCEEDED' AND enhanced = false)
      OR (event_code IN ('pickup.request.created', 'pickup.request.cancelled') AND object_type = 'PickupRequest' AND vendor_organization_id = melarc.current_vendor_organization_id() AND outcome = 'SUCCEEDED' AND enhanced = false)
    )
    WHEN 'RIDER' THEN actor_type = 'RIDER' AND actor_id = melarc.current_principal_id() AND surface_context = 'RIDER_ANDROID' AND outcome = 'SUCCEEDED' AND (
      (enhanced = false AND (
        (event_code = 'auth.session.terminated' AND object_type = 'Session' AND object_id = nullif(current_setting('melarc.session_id', true), '')::uuid AND reason_code = 'SIGNED_OUT')
        OR (coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.run.execute' AND (
          (event_code = 'pickup.manifest.started' AND object_type = 'PickupManifest' AND previous_state = 'DISPATCHED' AND resulting_state = 'IN_PROGRESS' AND EXISTS (SELECT 1 FROM pickup_manifest m WHERE m.id = "audit_event"."object_id" AND m.assigned_rider_id = melarc.current_rider_id() AND m.responsible_hub_id = "audit_event"."responsible_hub_id" AND "audit_event"."related_ids" = jsonb_build_object('rider_id', melarc.current_rider_id()::text)))
          OR (event_code = 'pickup.stop.arrived' AND object_type = 'PickupStop' AND previous_state = 'PENDING' AND resulting_state = 'ARRIVED' AND EXISTS (SELECT 1 FROM pickup_stop s WHERE s.id = "audit_event"."object_id" AND s.responsible_hub_id = "audit_event"."responsible_hub_id" AND "audit_event"."related_ids" = jsonb_build_object('pickup_manifest_id', s.pickup_manifest_id::text, 'pickup_request_id', s.pickup_request_id::text, 'rider_id', melarc.current_rider_id()::text)))
        ))
        OR (coalesce(current_setting('melarc.authorization_key', true), '') = 'fleet.custody.accept'
            AND event_code = 'pickup.manifest.completed' AND object_type = 'PickupManifest' AND previous_state = 'IN_PROGRESS' AND resulting_state = 'COMPLETED'
            AND EXISTS (
              SELECT 1 FROM pickup_manifest m
               WHERE m.id = "audit_event"."object_id" AND m.state = 'COMPLETED' AND m.responsible_hub_id = "audit_event"."responsible_hub_id"
                 AND "audit_event"."related_ids" = jsonb_build_object('rider_id', m.assigned_rider_id::text)
                 AND EXISTS (SELECT 1 FROM run_custody_handover h WHERE h.manifest_id = m.id AND h.to_rider_id = melarc.current_rider_id() AND h.state = 'COMPLETED')))
        -- S1.26 closeout (OB-S1-54): the event of a count is the count's own, `pickup.collection.recorded`, the same for a clean count and a short one.
        -- Its object is the record, and it says that a count was recorded and that the stop it was recorded at is still `ARRIVED`. `pickup.stop.collected`
        -- and `pickup.stop.partially_collected` say that the stop closed, which the handshake does (S1.27): no arm of the counting key admits them, so an
        -- abandoned handshake never reads as a completed collection. Every member of the event is bound to the stored record and to its stop, not to a claim:
        -- the record is the rider's own, in the event's hub; the reason is the record's snapshot, member for member, or none; the related identifiers are
        -- the record's stop and the stop's run and request and the rider; the detail is the record's counts, variance, flag and direction and nothing
        -- else. The rider's note is on the record and nowhere in the event, and the other free-form members (the note, the diff, the device context, the
        -- bundle, the organization, the approval) are absent, so that nothing a direct writer chooses can be stored in it. The correlation id is the
        -- transaction's own.
        OR (coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.collection.confirm'
            AND event_code = 'pickup.collection.recorded' AND object_type = 'CollectionRecord'
            AND previous_state = 'ARRIVED' AND resulting_state = 'ARRIVED'
            AND note IS NULL AND before_after IS NULL AND device_context IS NULL AND actor_bundle IS NULL AND vendor_organization_id IS NULL AND approval_id IS NULL
            AND correlation_id = current_setting('melarc.correlation_id', true)
            AND EXISTS (
              SELECT 1 FROM collection_record c JOIN pickup_stop s ON s.id = c.pickup_stop_id
               WHERE c.id = "audit_event"."object_id" AND c.recorded_by = melarc.current_rider_id()
                 AND c.responsible_hub_id = "audit_event"."responsible_hub_id"
                 AND s.state = 'ARRIVED'
                 AND "audit_event"."reason_code" IS NOT DISTINCT FROM (c.variance_reason_snapshot ->> 'reason_code')
                 AND "audit_event"."reason_label" IS NOT DISTINCT FROM (c.variance_reason_snapshot ->> 'label')
                 AND "audit_event"."related_ids" = jsonb_build_object('pickup_stop_id', c.pickup_stop_id::text, 'pickup_manifest_id', s.pickup_manifest_id::text,
                                                                       'pickup_request_id', s.pickup_request_id::text, 'rider_id', c.recorded_by::text)
                 AND "audit_event"."detail" = jsonb_build_object('declared_count', c.declared_count, 'collected_count', c.collected_count, 'variance', c.variance,
                                                                  'office_notified', c.office_notified_at IS NOT NULL, 'handshake_type', c.handshake_type)))
        -- ... and the promotion that count causes (AC-SLICE-001-28), which is the operation's own event and nobody else's: `melarc.promote_collected_sender`
        -- writes it in the change it records, as the owner, and this arm admits it to a statement that runs as the owner and to no other. A marker the key can
        -- set, a count the rider really made and the right facts are not enough for a statement of the runtime login, which cannot become the owner: it
        -- cannot write the event for a sender it did not promote, cite another counted stop in it, or write it a second time.
        OR (coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.collection.confirm'
            AND current_user = 'melarc_owner'
            AND event_code = 'pickup.sender.promoted' AND object_type = 'AdHocSender'
            AND previous_state = 'PROVISIONAL' AND resulting_state = 'REUSABLE'
            AND EXISTS (
              SELECT 1 FROM collection_record c
               WHERE c.pickup_stop_id::text = "audit_event"."related_ids" ->> 'pickup_stop_id' AND c.recorded_by = melarc.current_rider_id()
                 AND c.responsible_hub_id = "audit_event"."responsible_hub_id"))
      ))
      OR (enhanced = true AND coalesce(current_setting('melarc.authorization_key', true), '') = 'fleet.custody.accept'
          AND event_code = 'fleet.custody.accepted' AND object_type = 'RunCustodyHandover' AND previous_state = 'PENDING' AND resulting_state = 'COMPLETED'
          AND EXISTS (
            SELECT 1 FROM run_custody_handover h
             WHERE h.id = "audit_event"."object_id" AND h.state = 'COMPLETED' AND h.to_rider_id = melarc.current_rider_id()
               AND h.responsible_hub_id = "audit_event"."responsible_hub_id"
               AND "audit_event"."related_ids" = jsonb_build_object('pickup_manifest_id', h.manifest_id::text, 'from_rider_id', h.from_rider_id::text, 'to_rider_id', h.to_rider_id::text)))
    )
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'authentication'
    ELSE false
  END
);
