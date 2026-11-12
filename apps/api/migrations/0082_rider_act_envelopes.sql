-- THE ENVELOPES OF TWO RIDER ACTS (S1.28, the messages of a failure; OB-S1-51, the office told of a short count). Hand-written throughout: no table changes.
--
-- A business act writes its outbox envelope in its own transaction, as the principal that did the act (0055). The rider's arm of the outbox insert policy asks for an
-- envelope that names the rider (`rider_id`), and the insert guard refuses a rider scope on a pickup request, which has none, so no rider could ever write the envelope of
-- an act about a request. The collection handshake met the same wall and went round it (0070): an operation that runs as the owner writes the envelope, and one narrow policy
-- arm admits it. The two acts here are the rider's too, and are done by the application's own statements, so each gets ONE narrow operation for its envelope, in the same way:
--
--   * melarc.failure_envelope(stop): the envelope `pickup.failure.reported` of a failure the calling rider has just reported (key `pickup.failure.report`). It asks for a stop
--     that is FAILED, on a run assigned to the caller, whose failure the database stamped in THIS transaction (`resolved_at` is not before the transaction began), and it reads
--     everything the envelope says from that stop and its request: the request (the aggregate), the hub, the vendor organisation, the category and the code of the reason. The
--     caller gives nothing but the stop, so a caller cannot choose what the envelope says, tell the lane a failure that did not happen, or write one for a stop it did not just
--     fail. A second call in the same transaction meets the key of the table (event, aggregate, correlation); a call in a later transaction meets the stamp.
--   * melarc.shortfall_envelope(stop): the envelope `pickup.collection.shortfall_flagged` of a short count the calling rider has just recorded (key `pickup.collection.confirm`),
--     for the same reasons: a record of that stop that is SHORT, was made by the caller in this transaction, and carries the office flag; the payload is the stop and the code of
--     the variance reason.
--
-- The payload of each is the stop (so that an envelope can be told from the next) and closed tokens (`category`, `reason`): no note, no number, no address. The lane makes the
-- messages from the request it reloads (the message list), and copies into a notification only the tokens a message declares.
--
-- The policies are beside the outbox's own and narrow it no further than they must: each admits one event, from the owner's own statement (`current_user`, which only these two
-- functions run as), under one key, for the calling rider as the origin, with no rider scope, for a request that has such a stop of that rider. The runtime login cannot become the
-- owner, so no statement of its own reaches them. The reads they make of the request are admitted by the policies of 0068 and 0080 (the counting key and the failure key, to a
-- statement that runs as the owner), and of the stop, the manifest and the record by the rider's own read policies.

CREATE FUNCTION melarc.failure_envelope(p_stop uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  failed record;
BEGIN
  IF melarc.principal_type() <> 'RIDER'
     OR coalesce(pg_catalog.current_setting('melarc.authorization_key', true), '') <> 'pickup.failure.report' THEN
    RAISE EXCEPTION 'the envelope of a failure is written for the rider that reports it, and for nobody else' USING ERRCODE = '42501';
  END IF;
  IF p_stop IS NULL THEN
    RAISE EXCEPTION 'the envelope of a failure is written for one stop' USING ERRCODE = '22023';
  END IF;
  SELECT s.id AS stop_id, s.pickup_request_id, s.responsible_hub_id, r.vendor_organization_id,
         s.failure_category AS category, s.failure_reason_snapshot ->> 'reason_code' AS reason
    INTO failed
    FROM public.pickup_stop AS s
    JOIN public.pickup_manifest AS m ON m.id = s.pickup_manifest_id
    JOIN public.pickup_request AS r ON r.id = s.pickup_request_id
   WHERE s.id = p_stop AND s.state = 'FAILED' AND s.failure_category IS NOT NULL
     AND m.assigned_rider_id = melarc.current_rider_id()
     AND s.resolved_at >= pg_catalog.transaction_timestamp();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the envelope of a failure is written for a stop the calling rider has failed in this transaction' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.outbox (id, event_type, aggregate_type, aggregate_id, responsible_hub_id, vendor_organization_id, originating_principal_type,
                             originating_principal_id, operation_id, correlation_id, payload)
    VALUES (pg_catalog.uuidv7(), 'pickup.failure.reported', 'PICKUP_REQUEST', failed.pickup_request_id, failed.responsible_hub_id, failed.vendor_organization_id, 'RIDER',
            melarc.current_principal_id(), 'reportPickupFailure', pg_catalog.current_setting('melarc.correlation_id', true),
            pg_catalog.jsonb_build_object('stop', failed.stop_id, 'category', failed.category, 'reason', failed.reason));
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.failure_envelope(uuid) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.failure_envelope(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.failure_envelope(uuid) TO melarc_api_runtime;
--> statement-breakpoint
CREATE FUNCTION melarc.shortfall_envelope(p_stop uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  counted record;
BEGIN
  IF melarc.principal_type() <> 'RIDER'
     OR coalesce(pg_catalog.current_setting('melarc.authorization_key', true), '') <> 'pickup.collection.confirm' THEN
    RAISE EXCEPTION 'the envelope of a short count is written for the rider that records it, and for nobody else' USING ERRCODE = '42501';
  END IF;
  IF p_stop IS NULL THEN
    RAISE EXCEPTION 'the envelope of a short count is written for one stop' USING ERRCODE = '22023';
  END IF;
  SELECT s.id AS stop_id, s.pickup_request_id, s.responsible_hub_id, r.vendor_organization_id,
         c.variance_reason_snapshot ->> 'reason_code' AS reason
    INTO counted
    FROM public.collection_record AS c
    JOIN public.pickup_stop AS s ON s.id = c.pickup_stop_id
    JOIN public.pickup_request AS r ON r.id = s.pickup_request_id
   WHERE c.pickup_stop_id = p_stop AND c.variance = 'SHORT' AND c.office_notified_at IS NOT NULL
     AND c.recorded_by = melarc.current_rider_id()
     AND c.recorded_at >= pg_catalog.transaction_timestamp();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the envelope of a short count is written for a stop the calling rider has counted short in this transaction' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.outbox (id, event_type, aggregate_type, aggregate_id, responsible_hub_id, vendor_organization_id, originating_principal_type,
                             originating_principal_id, operation_id, correlation_id, payload)
    VALUES (pg_catalog.uuidv7(), 'pickup.collection.shortfall_flagged', 'PICKUP_REQUEST', counted.pickup_request_id, counted.responsible_hub_id, counted.vendor_organization_id, 'RIDER',
            melarc.current_principal_id(), 'recordCollection', pg_catalog.current_setting('melarc.correlation_id', true),
            pg_catalog.jsonb_build_object('stop', counted.stop_id, 'reason', counted.reason));
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.shortfall_envelope(uuid) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.shortfall_envelope(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.shortfall_envelope(uuid) TO melarc_api_runtime;
--> statement-breakpoint
-- The two arms, as policies of their own beside the outbox's (a policy is one CASE over the principal type with every other principal refused).
CREATE POLICY "outbox_insert_failure" ON "outbox" FOR INSERT WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'RIDER' THEN current_user = 'melarc_owner' AND coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.failure.report'
      AND event_type = 'pickup.failure.reported' AND aggregate_type = 'PICKUP_REQUEST' AND operation_id = 'reportPickupFailure'
      AND originating_principal_type = 'RIDER' AND originating_principal_id = melarc.current_principal_id() AND rider_id IS NULL
      AND EXISTS (SELECT 1 FROM "pickup_stop" s JOIN "pickup_manifest" m ON m.id = s.pickup_manifest_id
                   WHERE s.pickup_request_id = "outbox"."aggregate_id" AND s.responsible_hub_id = "outbox"."responsible_hub_id"
                     AND s.state = 'FAILED' AND s.resolved_at >= transaction_timestamp() AND m.assigned_rider_id = melarc.current_rider_id())
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "outbox_insert_shortfall" ON "outbox" FOR INSERT WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'RIDER' THEN current_user = 'melarc_owner' AND coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.collection.confirm'
      AND event_type = 'pickup.collection.shortfall_flagged' AND aggregate_type = 'PICKUP_REQUEST' AND operation_id = 'recordCollection'
      AND originating_principal_type = 'RIDER' AND originating_principal_id = melarc.current_principal_id() AND rider_id IS NULL
      AND EXISTS (SELECT 1 FROM "collection_record" c JOIN "pickup_stop" s ON s.id = c.pickup_stop_id
                   WHERE s.pickup_request_id = "outbox"."aggregate_id" AND c.responsible_hub_id = "outbox"."responsible_hub_id"
                     AND c.variance = 'SHORT' AND c.office_notified_at IS NOT NULL AND c.recorded_at >= transaction_timestamp()
                     AND c.recorded_by = melarc.current_rider_id())
    ELSE false
  END
);
