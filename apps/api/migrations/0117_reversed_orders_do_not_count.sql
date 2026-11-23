-- A REVERSED ORDER IS HISTORY, AND DOES NOT COUNT (Stage 7, the reversal of a mistaken arrival, migration 0115). Hand-written throughout: no table changes.
--
-- A parcel whose arrival was reversed and that is then found again is ordered afresh, so it can hold two orders: the reversed one (kept, with its locked price and trail) and the one that stands. The three places
-- of 0112 that count the orders of the parcels that arrived, or list them, are restated so that a reversed order is none of them: the facts the officer judges before a close, the guard of the close (the parity of
-- the orders that stand against the hub-received count, for every writer) and the vendor's summary of a closed intake (which must never show a vendor an order that was taken back). Nothing else of the three changes.

CREATE OR REPLACE FUNCTION melarc.intake_close_facts(p_intake uuid)
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
   WHERE o.pickup_intake_id = p_intake AND o.commercial_state IS DISTINCT FROM 'REVERSED'
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
CREATE OR REPLACE FUNCTION melarc.pickup_intake_close_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
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
   WHERE o.pickup_intake_id = NEW.id AND o.commercial_state IS DISTINCT FROM 'REVERSED'
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
CREATE OR REPLACE FUNCTION melarc.intake_summary(p_intake uuid)
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
   WHERE o.pickup_intake_id = p_intake AND o.locked_at IS NOT NULL AND o.commercial_state IS DISTINCT FROM 'REVERSED'
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
