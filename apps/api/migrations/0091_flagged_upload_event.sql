-- Run B, 13 November 2026 (Part 1, item 4 of the Product Owner's review of Run A2; the decision D-B3). A flagged upload is a security fact, so it writes an enhanced event of its own,
-- pickup.evidence.flagged (audit.md section 5.1), in the rider's transaction, committed although the upload is refused: the record, the rider, the stop and the name of the signature, never
-- the object's key. Forward of 0072, the last statement of the ledger's insert policy.
--
-- The rider's arm of audit_event_insert takes the events of the rider's own acts one by one (0065 to 0072), and none of them is about evidence. A new, PERMISSIVE policy admits this one event
-- and no other, so that the arm of 0072 is not restated for it (the policies of a table are alternatives; the arms that exist are untouched). It admits the event to the rider's evidence
-- keys alone, for a record of the rider's own that is still pending, under the key of its purpose (a failure's proof under pickup.failure.report, a parcel's photo under
-- pickup.collection.confirm: the pairing of 0088), in the record's own hub, bound to the record's own stop and rider in related_ids, and only as the enhanced rejection the application
-- writes: the record stays PENDING_UPLOAD, so the event states the state before and after as the same, and carries no before_after (a rejected attempt changed nothing: audit.md section 6).
-- The facts the application adds (detail: the signature's name and whether the object could be removed) are screened by the writer and are not judged here.
CREATE POLICY "audit_event_insert_flagged_upload" ON "audit_event" FOR INSERT WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'RIDER' THEN event_code = 'pickup.evidence.flagged'
      AND actor_type = 'RIDER' AND actor_id = melarc.current_principal_id() AND surface_context = 'RIDER_ANDROID'
      AND outcome = 'REJECTED' AND enhanced = true AND object_type = 'Evidence'
      AND previous_state = 'PENDING_UPLOAD' AND resulting_state = 'PENDING_UPLOAD'
      AND EXISTS (
        SELECT 1 FROM evidence AS e
         WHERE e.id = "audit_event"."object_id" AND e.state = 'PENDING_UPLOAD' AND e.owner_type = 'PICKUP_STOP'
           AND e.captured_by_principal_type = 'RIDER' AND e.captured_by_actor = melarc.current_rider_id()
           AND e.responsible_hub_id IS NOT DISTINCT FROM "audit_event"."responsible_hub_id"
           AND "audit_event"."related_ids" = jsonb_build_object('pickup_stop_id', e.owner_id::text, 'rider_id', melarc.current_rider_id()::text)
           AND (
             (coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.failure.report' AND e.purpose = 'COLLECTION_PROOF')
             OR (coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.collection.confirm' AND e.purpose = 'PARCEL_PHOTO')
           )
      )
    ELSE false
  END
);
