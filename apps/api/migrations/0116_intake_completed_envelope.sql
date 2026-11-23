-- THE INTAKE IS COMPLETED: THE ENVELOPE OF THE CLOSE (OB-S1-143; itemization.md section 5.2 and the message list, "Intake completed"). Hand-written throughout: no table changes.
--
-- The close of an intake writes its outbox envelope `intake.completed` in the SAME transaction (melarc.close_intake, restated from 0112 with that one addition), so that the close and the message that tells the
-- sender or the vendor are atomic, and a provider's outage can never reopen an intake: the lane sends the message on its own schedule, retries it on its own, and holds an unapproved wording back. The envelope is the
-- request the intake was opened for (the aggregate), its hub and its vendor, from the rows the close just read; the payload is the intake alone. One narrow policy arm admits it: the owner's own statement (which only
-- melarc.close_intake runs as), under the key of the close or of its exception, for the officer that closes, for a request that has a closed intake. **The policy names only columns the runtime login may read
-- (state, request, hub): a policy is evaluated with the privileges of the login that writes the table, and a column it cannot read (closed_at) fails every envelope with 42501, the trap 0107 names.**

CREATE POLICY "outbox_insert_intake_completed" ON "outbox" FOR INSERT WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_user = 'melarc_owner' AND coalesce(current_setting('melarc.authorization_key', true), '') IN ('hub.intake.close', 'hub.intake.close_exception')
      AND event_type = 'intake.completed' AND aggregate_type = 'PICKUP_REQUEST' AND operation_id = 'closeHubIntake'
      AND originating_principal_type = 'STAFF' AND originating_principal_id = melarc.current_principal_id() AND rider_id IS NULL
      AND EXISTS (SELECT 1 FROM "pickup_intake" i WHERE i.pickup_request_id = "outbox"."aggregate_id" AND i.responsible_hub_id = "outbox"."responsible_hub_id"
                   AND i.state = 'CLOSED')
    ELSE false
  END
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION melarc.close_intake(p_intake uuid, p_exception_id uuid, p_exception_note text)
RETURNS TABLE (previous_state text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  held public.pickup_intake%ROWTYPE;
BEGIN
  IF melarc.principal_type() IS DISTINCT FROM 'STAFF'
     OR coalesce(pg_catalog.current_setting('melarc.authorization_key', true), '') NOT IN ('hub.intake.close', 'hub.intake.close_exception') THEN
    RAISE EXCEPTION 'an intake is closed by the officer who holds the key of the close' USING ERRCODE = '42501';
  END IF;
  IF (p_exception_id IS NULL) <> (p_exception_note IS NULL) THEN
    RAISE EXCEPTION 'an exception is its identifier and its reason together' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO held FROM public.pickup_intake AS i WHERE i.id = p_intake FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'there is no such intake in the officer''s hubs' USING ERRCODE = '42501';
  END IF;
  IF held.state NOT IN ('READY_FOR_ITEMIZATION', 'ITEMIZING') THEN
    RAISE EXCEPTION 'an intake is closed once it is cleared for itemizing' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT',
      HINT = CASE held.state
        WHEN 'AWAITING_COUNT' THEN CASE held.receiving_mode WHEN 'PHOTO_CHECK_IN' THEN 'rule=check_in_open' ELSE 'rule=intake_not_counted' END
        WHEN 'RECONCILIATION_REQUIRED' THEN 'rule=reconciliation_open'
        WHEN 'CLOSED' THEN 'rule=already_closed'
        ELSE 'rule=intake_not_ready' END;
  END IF;
  previous_state := held.state;
  IF held.state = 'READY_FOR_ITEMIZATION' THEN
    UPDATE public.pickup_intake SET state = 'ITEMIZING' WHERE id = p_intake;
  END IF;
  UPDATE public.pickup_intake
     SET state = 'CLOSED', closed_at = pg_catalog.clock_timestamp(), closed_by = melarc.current_principal_id(),
         parity_exception_id = p_exception_id, parity_exception_note = p_exception_note
   WHERE id = p_intake;
  -- THE INTAKE IS COMPLETED (OB-S1-143): the envelope that tells the vendor or the sender is written in the transaction of the close, from the request the intake was opened for, and never from what a caller
  -- says. The lane sends it, or holds it back, on its own: a provider that is down never reopens an intake, and a wording that is not approved is held back and not sent.
  INSERT INTO public.outbox (id, event_type, aggregate_type, aggregate_id, responsible_hub_id, vendor_organization_id, originating_principal_type, originating_principal_id, operation_id, correlation_id, payload)
  SELECT pg_catalog.uuidv7(), 'intake.completed', 'PICKUP_REQUEST', held.pickup_request_id, held.responsible_hub_id, r.vendor_organization_id, 'STAFF', melarc.current_principal_id(), 'closeHubIntake',
         pg_catalog.current_setting('melarc.correlation_id', true), pg_catalog.jsonb_build_object('intake', held.id)
    FROM public.pickup_request AS r WHERE r.id = held.pickup_request_id;
  RETURN NEXT;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.close_intake(uuid, uuid, text) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.close_intake(uuid, uuid, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.close_intake(uuid, uuid, text) TO melarc_api_runtime;
