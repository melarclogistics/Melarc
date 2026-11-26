-- S1.38: CLOSING AN INTAKE, THE VENDOR'S SUMMARY AND THE READ OF AN ORDER (itemization.md sections 5.1 and 5.2; state-machines.md sections 7 and 8; AC-SLICE-001-40, -46, -51, -52, -56).
--
--   * THE CLOSE IS WRITTEN WITH ITS FACTS. closed_at (the database's moment), closed_by (the officer), and, for a close without parity, parity_exception_id with the reason in words, are written by melarc.close_intake and
--     held for every writer by a guard of their own (melarc.pickup_intake_close_guard): they are made once, with the move to CLOSED, never separately and never changed. Parity is the number of orders of the parcels that
--     arrived (and of a blind-count intake) against the hub-received count, and a PAYMENT_REQUIRED order counts; an order that has no locked price refuses the close; the only way past a parity that is not met is the
--     approved exception, under the key hub.intake.close_exception, with a reason (the guard says INSUFFICIENT_AUTHORITY, REASON_REQUIRED and PARITY_NOT_MET by name).
--   * AN INTAKE CLEARED FOR ITEMIZING THAT HOLDS ITS ORDERS ALREADY IS CLOSED THROUGH ITEMIZING. An intake whose orders were all made early (before its vendor was finished) is still READY_FOR_ITEMIZATION when it is
--     closed: the close moves it to ITEMIZING first and to CLOSED in the same change, so the state machine's edges are the ones it had.
--   * THE KEYS OF THE CLOSE READ WHAT THE INTAKE'S READS READ, so that the ETag the officer read is recomputed as the reads do (the same additive policies the key of itemizing has, and the three functions that gate on
--     the keys that read intakes name the two keys too).
--   * THE VENDOR'S SUMMARY is a function of the database that returns the closed intake's orders as the vendor may see them and nothing else: no count, no declaration, no discrepancy, no evidence and no adjudication
--     is in what it reads or returns (the omission is the guard). A vendor reads its own; staff read the hubs of their grant; an intake that is not closed is an intake that does not exist.
--   * THE READ OF AN ORDER (pricing.read): the order, with the state of its parcel and its commitment, to the staff of its hub and to the vendor whose order it is.

ALTER TABLE "pickup_intake" ADD COLUMN "closed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "pickup_intake" ADD COLUMN "closed_by" uuid;
--> statement-breakpoint
ALTER TABLE "pickup_intake" ADD COLUMN "parity_exception_id" uuid;
--> statement-breakpoint
ALTER TABLE "pickup_intake" ADD COLUMN "parity_exception_note" text;
--> statement-breakpoint
ALTER TABLE "pickup_intake" ADD CONSTRAINT "pickup_intake_close_facts" CHECK (("pickup_intake"."closed_at" IS NULL) = ("pickup_intake"."closed_by" IS NULL) AND ("pickup_intake"."parity_exception_id" IS NULL) = ("pickup_intake"."parity_exception_note" IS NULL) AND ("pickup_intake"."parity_exception_id" IS NULL OR "pickup_intake"."closed_at" IS NOT NULL));
--> statement-breakpoint
CREATE POLICY "pickup_intake_close_read" ON "pickup_intake" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN coalesce(current_setting('melarc.authorization_key', true), '') IN ('hub.intake.close', 'hub.intake.close_exception')
      AND (melarc.hub_scope_mode() = 'ALL' OR "pickup_intake"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "pickup_intake_close_lock" ON "pickup_intake" FOR UPDATE USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN coalesce(current_setting('melarc.authorization_key', true), '') IN ('hub.intake.close', 'hub.intake.close_exception')
      AND (melarc.hub_scope_mode() = 'ALL' OR "pickup_intake"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
) WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN false
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "pickup_intake_close" ON "pickup_intake" FOR UPDATE USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_user = 'melarc_owner' AND coalesce(current_setting('melarc.authorization_key', true), '') IN ('hub.intake.close', 'hub.intake.close_exception')
      AND (melarc.hub_scope_mode() = 'ALL' OR "pickup_intake"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
) WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_user = 'melarc_owner' AND coalesce(current_setting('melarc.authorization_key', true), '') IN ('hub.intake.close', 'hub.intake.close_exception')
      AND (melarc.hub_scope_mode() = 'ALL' OR "pickup_intake"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "intake_parcel_close_read" ON "intake_parcel" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN coalesce(current_setting('melarc.authorization_key', true), '') IN ('hub.intake.close', 'hub.intake.close_exception')
      AND (melarc.hub_scope_mode() = 'ALL' OR "intake_parcel"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "pickup_intake_finding_close_read" ON "pickup_intake_finding" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN coalesce(current_setting('melarc.authorization_key', true), '') IN ('hub.intake.close', 'hub.intake.close_exception')
      AND (melarc.hub_scope_mode() = 'ALL' OR "pickup_intake_finding"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "pickup_stop_close_read" ON "pickup_stop" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_user = 'melarc_owner' AND coalesce(current_setting('melarc.authorization_key', true), '') IN ('hub.intake.close', 'hub.intake.close_exception')
      AND (melarc.hub_scope_mode() = 'ALL' OR "pickup_stop"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "collection_parcel_photo_close_read" ON "collection_parcel_photo" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_user = 'melarc_owner' AND coalesce(current_setting('melarc.authorization_key', true), '') IN ('hub.intake.close', 'hub.intake.close_exception')
      AND (melarc.hub_scope_mode() = 'ALL' OR "collection_parcel_photo"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "collection_record_close_read" ON "collection_record" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_user = 'melarc_owner' AND coalesce(current_setting('melarc.authorization_key', true), '') IN ('hub.intake.close', 'hub.intake.close_exception')
      AND (melarc.hub_scope_mode() = 'ALL' OR "collection_record"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "pickup_request_close_read" ON "pickup_request" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_user = 'melarc_owner' AND coalesce(current_setting('melarc.authorization_key', true), '') IN ('hub.intake.close', 'hub.intake.close_exception')
      AND (melarc.hub_scope_mode() = 'ALL' OR "pickup_request"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "pickup_manifest_close_read" ON "pickup_manifest" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN coalesce(current_setting('melarc.authorization_key', true), '') IN ('hub.intake.close', 'hub.intake.close_exception')
      AND (melarc.hub_scope_mode() = 'ALL' OR "pickup_manifest"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
      AND melarc.run_has_intake("pickup_manifest"."id")
    ELSE false
  END
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION melarc.receiving_names(p_intake_ids uuid[])
RETURNS TABLE (party text, party_id uuid, intake_id uuid, display_name text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  previous_type text := coalesce(pg_catalog.current_setting('melarc.principal_type', true), '');
  previous_capability text := coalesce(pg_catalog.current_setting('melarc.task_capability', true), '');
  rider_ids uuid[];
  staff_ids uuid[];
BEGIN
  IF melarc.principal_type() IS DISTINCT FROM 'STAFF'
     OR coalesce(pg_catalog.current_setting('melarc.authorization_key', true), '') NOT IN ('hub.read', 'hub.intake.count', 'hub.osd.adjudicate', 'hub.intake.itemize', 'hub.intake.close', 'hub.intake.close_exception') THEN
    RAISE EXCEPTION 'the names of the receiving side are read by staff that read intakes, and by nobody else' USING ERRCODE = '42501';
  END IF;
  IF p_intake_ids IS NULL OR pg_catalog.cardinality(p_intake_ids) > 1000 THEN
    RAISE EXCEPTION 'the names are asked for at most a thousand intakes at a time' USING ERRCODE = '22023';
  END IF;
  -- As the caller: the vendors, from the stops' snapshots, and the ids of the riders and of the officers that appear on the intakes the caller may see.
  RETURN QUERY
    SELECT 'VENDOR'::text, NULL::uuid, i.id, s.pickup_summary ->> 'sender_display_name'
      FROM public.pickup_intake AS i
      JOIN public.pickup_stop AS s ON s.pickup_manifest_id = i.pickup_manifest_id AND s.pickup_request_id = i.pickup_request_id
     WHERE i.id = ANY (p_intake_ids) AND pg_catalog.btrim(coalesce(s.pickup_summary ->> 'sender_display_name', '')) <> ''
     ORDER BY i.id;
  SELECT coalesce(pg_catalog.array_agg(DISTINCT i.handed_over_by), ARRAY[]::uuid[]) INTO rider_ids
    FROM public.pickup_intake AS i WHERE i.id = ANY (p_intake_ids);
  SELECT coalesce(pg_catalog.array_agg(DISTINCT x.actor), ARRAY[]::uuid[]) INTO staff_ids FROM (
    SELECT i.counted_by AS actor FROM public.pickup_intake AS i WHERE i.id = ANY (p_intake_ids)
    UNION
    SELECT i.active_receiver_id FROM public.pickup_intake AS i WHERE i.id = ANY (p_intake_ids)
    UNION
    SELECT p.arrived_by FROM public.intake_parcel AS p WHERE p.pickup_intake_id = ANY (p_intake_ids)
    UNION
    SELECT f.recorded_by FROM public.pickup_intake_finding AS f WHERE f.pickup_intake_id = ANY (p_intake_ids)
  ) AS x WHERE x.actor IS NOT NULL;
  -- As the system, for the one statement of each kind that reads the names of those ids and no other column.
  PERFORM pg_catalog.set_config('melarc.principal_type', 'SYSTEM', true);
  PERFORM pg_catalog.set_config('melarc.task_capability', 'receiving_names', true);
  RETURN QUERY SELECT 'RIDER'::text, r.id, NULL::uuid, r.full_name FROM public.rider_identity AS r WHERE r.id = ANY (rider_ids) ORDER BY r.id;
  RETURN QUERY SELECT 'STAFF'::text, t.id, NULL::uuid, t.full_name FROM public.staff_identity AS t WHERE t.id = ANY (staff_ids) ORDER BY t.id;
  PERFORM pg_catalog.set_config('melarc.principal_type', previous_type, true);
  PERFORM pg_catalog.set_config('melarc.task_capability', previous_capability, true);
  RETURN;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.receiving_names(uuid[]) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.receiving_names(uuid[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.receiving_names(uuid[]) TO melarc_api_runtime;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION melarc.receiving_run_codes(p_manifest_ids uuid[])
RETURNS TABLE (manifest_id uuid, run_code text, service_date date)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF melarc.principal_type() IS DISTINCT FROM 'STAFF'
     OR coalesce(pg_catalog.current_setting('melarc.authorization_key', true), '') NOT IN ('hub.read', 'hub.intake.count', 'hub.osd.adjudicate', 'hub.intake.itemize', 'hub.intake.close', 'hub.intake.close_exception') THEN
    RAISE EXCEPTION 'the codes of runs are read by staff that read intakes, and by nobody else' USING ERRCODE = '42501';
  END IF;
  IF p_manifest_ids IS NULL OR pg_catalog.cardinality(p_manifest_ids) > 1000 THEN
    RAISE EXCEPTION 'the codes are asked for at most a thousand runs at a time' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY SELECT m.id, m.code, m.service_date FROM public.pickup_manifest AS m WHERE m.id = ANY (p_manifest_ids) ORDER BY m.id;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.receiving_run_codes(uuid[]) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.receiving_run_codes(uuid[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.receiving_run_codes(uuid[]) TO melarc_api_runtime;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION melarc.hub_intake_after_count(p_intake_ids uuid[]) RETURNS TABLE (intake_id uuid, rider_declared_count integer, parcel_photo_ids uuid[])
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF melarc.principal_type() IS DISTINCT FROM 'STAFF'
     OR coalesce(pg_catalog.current_setting('melarc.authorization_key', true), '') NOT IN ('hub.read', 'hub.intake.count', 'hub.osd.adjudicate', 'hub.intake.itemize', 'hub.intake.close', 'hub.intake.close_exception') THEN
    RAISE EXCEPTION 'the declaration of a counted intake is read by staff that read intakes, and by nobody else' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT i.id, i.rider_declared_count,
           coalesce(
             (SELECT pg_catalog.array_agg(p.evidence_id ORDER BY p.attached_at, p.evidence_id)
                FROM public.pickup_stop AS s
                JOIN public.collection_parcel_photo AS p ON p.pickup_stop_id = s.id
               WHERE s.pickup_manifest_id = i.pickup_manifest_id AND s.pickup_request_id = i.pickup_request_id),
             ARRAY[]::uuid[])
      FROM public.pickup_intake AS i
     WHERE i.id = ANY (p_intake_ids) AND ((i.state <> 'AWAITING_COUNT' AND i.physical_count IS NOT NULL) OR i.receiving_mode = 'PHOTO_CHECK_IN')
     ORDER BY i.id;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.hub_intake_after_count(uuid[]) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.hub_intake_after_count(uuid[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.hub_intake_after_count(uuid[]) TO melarc_api_runtime;
--> statement-breakpoint
-- THE FACTS OF A CLOSE, for the officer's act to judge before it asks the database to make it: the state, the receiving mode, the hub-received count (the number of parcels that arrived, or the blind count), the
-- orders that stand for those parcels (an order for a parcel that is missing or taken back stands for nothing), and how many of them have no locked price. The database repeats every rule when it closes.
CREATE FUNCTION melarc.intake_close_facts(p_intake uuid)
RETURNS TABLE (state text, receiving_mode text, received integer, ordered integer, unpriced integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  held public.pickup_intake%ROWTYPE;
BEGIN
  IF melarc.principal_type() IS DISTINCT FROM 'STAFF'
     OR coalesce(pg_catalog.current_setting('melarc.authorization_key', true), '') NOT IN ('hub.intake.close', 'hub.intake.close_exception') THEN
    RAISE EXCEPTION 'the facts of a close are read by the officer who closes' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO held FROM public.pickup_intake AS i WHERE i.id = p_intake;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  state := held.state;
  receiving_mode := held.receiving_mode;
  received := held.physical_count;
  SELECT pg_catalog.count(*)::integer, (pg_catalog.count(*) FILTER (WHERE o.locked_at IS NULL))::integer INTO ordered, unpriced
    FROM public."order" AS o
   WHERE o.pickup_intake_id = p_intake
     AND (o.intake_parcel_id IS NULL OR EXISTS (SELECT 1 FROM public.intake_parcel AS p WHERE p.id = o.intake_parcel_id AND p.state = 'ARRIVED'));
  RETURN NEXT;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.intake_close_facts(uuid) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.intake_close_facts(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.intake_close_facts(uuid) TO melarc_api_runtime;
--> statement-breakpoint
-- The owner reads the orders of an intake for the facts above, under the keys of the close, in the hubs of the grant.
CREATE POLICY "order_close_read" ON "order" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_user = 'melarc_owner' AND coalesce(current_setting('melarc.authorization_key', true), '') IN ('hub.intake.close', 'hub.intake.close_exception')
      AND (melarc.hub_scope_mode() = 'ALL' OR "order"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
);
--> statement-breakpoint
-- THE GUARD OF A CLOSE, for every writer. The facts of a close are made once, with the move to CLOSED, by the key of the close: the database's moment, the officer who acts, and nothing a writer chose. The close
-- needs every order of an arrived parcel to have its locked price (ORDER_UNPRICED), and the orders that stand for the arrived parcels to be as many as the hub received (PARITY_NOT_MET); an intake that has not
-- that parity is closed only by the approved exception, under the key that holds it, with the reason in words, and an exception is never recorded for an intake that has parity.
CREATE FUNCTION melarc.pickup_intake_close_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  act_key text := coalesce(pg_catalog.current_setting('melarc.authorization_key', true), '');
  ordered integer;
  unpriced integer;
BEGIN
  IF NEW.closed_at IS NOT DISTINCT FROM OLD.closed_at AND NEW.closed_by IS NOT DISTINCT FROM OLD.closed_by
     AND NEW.parity_exception_id IS NOT DISTINCT FROM OLD.parity_exception_id AND NEW.parity_exception_note IS NOT DISTINCT FROM OLD.parity_exception_note
     AND NOT (NEW.state = 'CLOSED' AND OLD.state IS DISTINCT FROM 'CLOSED') THEN
    RETURN NEW;
  END IF;
  IF NOT (NEW.state = 'CLOSED' AND OLD.state = 'ITEMIZING') THEN
    RAISE EXCEPTION 'the facts of a close are made once, with the move from ITEMIZING to CLOSED, and never changed' USING ERRCODE = '23514';
  END IF;
  IF OLD.closed_at IS NOT NULL THEN
    RAISE EXCEPTION 'the facts of a close are made once and never changed' USING ERRCODE = '23514';
  END IF;
  IF act_key NOT IN ('hub.intake.close', 'hub.intake.close_exception') THEN
    RAISE EXCEPTION 'an intake is closed by the officer who holds the key of the close' USING ERRCODE = '23514';
  END IF;
  IF NEW.closed_at IS NULL OR NEW.closed_by IS NULL OR NEW.closed_by IS DISTINCT FROM melarc.current_principal_id() THEN
    RAISE EXCEPTION 'an intake is closed in the name of the officer who closes it' USING ERRCODE = '23514';
  END IF;
  NEW.closed_at := pg_catalog.clock_timestamp();
  SELECT pg_catalog.count(*)::integer, (pg_catalog.count(*) FILTER (WHERE o.locked_at IS NULL))::integer INTO ordered, unpriced
    FROM public."order" AS o
   WHERE o.pickup_intake_id = NEW.id
     AND (o.intake_parcel_id IS NULL OR EXISTS (SELECT 1 FROM public.intake_parcel AS p WHERE p.id = o.intake_parcel_id AND p.state = 'ARRIVED'));
  IF unpriced > 0 THEN
    RAISE EXCEPTION 'every order of an arrived parcel has its locked price before the intake is closed' USING ERRCODE = '23514', DETAIL = 'reason=ORDER_UNPRICED', HINT = 'rule=order_unpriced';
  END IF;
  IF ordered IS DISTINCT FROM NEW.physical_count THEN
    IF NEW.parity_exception_id IS NULL THEN
      RAISE EXCEPTION 'the orders must be as many as the parcels the hub received' USING ERRCODE = '23514', DETAIL = 'reason=PARITY_NOT_MET', HINT = 'rule=parity_not_met';
    END IF;
    IF act_key <> 'hub.intake.close_exception' THEN
      RAISE EXCEPTION 'closing without parity is the approved exception, and its key is not held' USING ERRCODE = '23514', DETAIL = 'reason=INSUFFICIENT_AUTHORITY', HINT = 'rule=close_exception_required';
    END IF;
    IF pg_catalog.btrim(coalesce(NEW.parity_exception_note, '')) = '' THEN
      RAISE EXCEPTION 'closing without parity needs a reason in words' USING ERRCODE = '23514', DETAIL = 'reason=REASON_REQUIRED', HINT = 'rule=exception_note_required';
    END IF;
  ELSIF NEW.parity_exception_id IS NOT NULL THEN
    RAISE EXCEPTION 'an exception is recorded only for an intake that has not got parity' USING ERRCODE = '23514', DETAIL = 'reason=VALIDATION_FAILED', HINT = 'rule=exception_not_needed';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.pickup_intake_close_guard() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.pickup_intake_close_guard() FROM PUBLIC;
--> statement-breakpoint
-- It fires before the version trigger and the guard of the states, whatever their names.
CREATE TRIGGER "pickup_intake_a_close_guard" BEFORE UPDATE ON "pickup_intake"
  FOR EACH ROW EXECUTE FUNCTION melarc.pickup_intake_close_guard();
--> statement-breakpoint
-- CLOSING THE INTAKE: as the owner, for an intake of the hubs of the grant, under one of the keys of the close, with the reason of an exception when there is one. An intake that is cleared for itemizing is moved
-- to ITEMIZING first, in the same change. The states and the facts are the guards' to judge: the state is told by name here because the officer's act asks for it.
CREATE FUNCTION melarc.close_intake(p_intake uuid, p_exception_id uuid, p_exception_note text)
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
  RETURN NEXT;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.close_intake(uuid, uuid, text) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.close_intake(uuid, uuid, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.close_intake(uuid, uuid, text) TO melarc_api_runtime;
--> statement-breakpoint
-- THE READ OF AN ORDER (pricing.read) and THE VENDOR'S SUMMARY (pickup.read). The staff of an order's hub read it, and the vendor whose order it is reads it: another vendor's is one that does not exist. The parcel of the
-- order is read by the keys that read the order, in the same hubs, for the state the order shows.
CREATE POLICY "order_probe" ON "order" FOR SELECT USING (melarc.principal_type() = 'STAFF' AND id = melarc.scope_probe_id());
--> statement-breakpoint
CREATE POLICY "order_pricing_read" ON "order" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN coalesce(current_setting('melarc.authorization_key', true), '') = 'pricing.read'
      AND (melarc.hub_scope_mode() = 'ALL' OR "order"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    WHEN 'VENDOR' THEN coalesce(current_setting('melarc.authorization_key', true), '') = 'pricing.read'
      AND "order"."vendor_organization_id" = melarc.current_vendor_organization_id()
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "intake_parcel_pricing_read" ON "intake_parcel" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN coalesce(current_setting('melarc.authorization_key', true), '') = 'pricing.read'
      AND (melarc.hub_scope_mode() = 'ALL' OR "intake_parcel"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
);
--> statement-breakpoint
-- The summary's function reads, as the owner, the closed intake and its orders under the key that reads a request; who may see them is decided in the function by the request the caller can see (a vendor's own, or
-- a hub of the grant), and the policy admits nothing else.
CREATE POLICY "pickup_intake_summary_read" ON "pickup_intake" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_user = 'melarc_owner' AND coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.read' AND "pickup_intake"."state" = 'CLOSED'
      AND (melarc.hub_scope_mode() = 'ALL' OR "pickup_intake"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    WHEN 'VENDOR' THEN current_user = 'melarc_owner' AND coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.read' AND "pickup_intake"."state" = 'CLOSED'
      AND EXISTS (SELECT 1 FROM "pickup_request" AS r WHERE r.id = "pickup_intake"."pickup_request_id" AND r.vendor_organization_id = melarc.current_vendor_organization_id())
    ELSE false
  END
);
--> statement-breakpoint
-- The route's guard asks the caller's own key whether it can see the record it names before it tells another hub's from an absent one: staff under pickup.read can see a CLOSED intake of their hubs (the staff who
-- hold the key, Ops, Senior Ops and Platform Admin, hold hub.read besides), and no other intake.
CREATE POLICY "pickup_intake_summary_staff_read" ON "pickup_intake" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.read' AND "pickup_intake"."state" = 'CLOSED'
      AND (melarc.hub_scope_mode() = 'ALL' OR "pickup_intake"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "order_summary_read" ON "order" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_user = 'melarc_owner' AND coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.read'
      AND (melarc.hub_scope_mode() = 'ALL' OR "order"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    WHEN 'VENDOR' THEN current_user = 'melarc_owner' AND coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.read'
      AND "order"."vendor_organization_id" = melarc.current_vendor_organization_id()
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "intake_parcel_summary_read" ON "intake_parcel" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_user = 'melarc_owner' AND coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.read'
      AND (melarc.hub_scope_mode() = 'ALL' OR "intake_parcel"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    WHEN 'VENDOR' THEN current_user = 'melarc_owner' AND coalesce(current_setting('melarc.authorization_key', true), '') = 'pickup.read'
      AND EXISTS (SELECT 1 FROM "pickup_intake" AS i JOIN "pickup_request" AS r ON r.id = i.pickup_request_id
                   WHERE i.id = "intake_parcel"."pickup_intake_id" AND r.vendor_organization_id = melarc.current_vendor_organization_id())
    ELSE false
  END
);
--> statement-breakpoint
-- The vendor-facing intake-completed and order summary, and nothing else (22.9, 23.10): the orders of the parcels that arrived (and of a blind-count intake), each with what a vendor may know of it. No count, no
-- declaration, no discrepancy, no evidence and no adjudication is read here or returned. An intake that is not closed, or that the caller may not see, is no row.
CREATE FUNCTION melarc.intake_summary(p_intake uuid)
RETURNS TABLE (intake_id uuid, pickup_request_id uuid, closed_at timestamp with time zone, orders jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  held public.pickup_intake%ROWTYPE;
BEGIN
  IF melarc.principal_type() NOT IN ('STAFF', 'VENDOR')
     OR coalesce(pg_catalog.current_setting('melarc.authorization_key', true), '') <> 'pickup.read' THEN
    RAISE EXCEPTION 'the summary is read by a vendor or by the staff of the hub' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO held FROM public.pickup_intake AS i WHERE i.id = p_intake AND i.state = 'CLOSED' AND i.closed_at IS NOT NULL;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  intake_id := held.id;
  pickup_request_id := held.pickup_request_id;
  closed_at := held.closed_at;
  SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'id', o.id, 'code', o.code, 'recipient_name', o.recipient ->> 'name',
           'service_area', coalesce(o.destination_zone_snapshot ->> 'service_area', o.destination_zone_snapshot ->> 'scope'),
           'size_class', o.size_class, 'locked_price_minor', o.locked_price_minor, 'commercial_state', o.commercial_state)
         ORDER BY o.created_at, o.id), '[]'::jsonb)
    INTO orders
    FROM public."order" AS o
   WHERE o.pickup_intake_id = p_intake AND o.locked_at IS NOT NULL
     AND (o.intake_parcel_id IS NULL OR EXISTS (SELECT 1 FROM public.intake_parcel AS p WHERE p.id = o.intake_parcel_id AND p.state = 'ARRIVED'));
  RETURN NEXT;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.intake_summary(uuid) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.intake_summary(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.intake_summary(uuid) TO melarc_api_runtime;
