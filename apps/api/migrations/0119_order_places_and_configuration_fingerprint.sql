-- WHAT THE THIRD EXTERNAL REVIEW OF STAGE 7 FOUND (21 November 2026, findings 1 and 5), AS THE DATABASE HOLDS IT. Hand-written throughout: no table changes.
--
--   * FINDING 1, A BLIND INTAKE TAKES NO MORE ORDERS THAN THE PARCELS IT RECEIVED. A photo intake's orders are one for each parcel, so they can never be more than the parcels that arrived; a blind count has no
--     parcel to be one-to-one with, and nothing held the number of its orders to the count. Two parcels received and three orders made was an intake the close accepted with the approved exception as "no shortage"
--     (the assessment counted what was outstanding as nothing and the queue of the closes that left work filtered it out), and the vendor's summary then listed three priced orders for two parcels. The order of a
--     blind intake is now refused when the orders that stand already equal the count (`orders_exceed_received`), for every writer, under the lock of the intake (`order_places_guard`); the close is refused over
--     a surplus that already stands, with or without the exception (`pickup_intake_close_guard`, restated from 0117 with the one added rule), because the exception is for parcels that are missing an order and
--     never for orders that have no parcel.
--   * FINDING 5, WHAT THE HUB'S CONFIGURATION WAS WHEN A SAVE TOOK ITS LOCKS. The configuration of a hub is read in a transaction of its own before the save's transaction begins (the reader may not run inside it),
--     so a save that waited for the intake carried the rates it had read before it waited. `melarc.hub_configuration_fingerprint` is a digest of the hub's own settings, zones and aliases as they are now; the reader
--     takes it before it reads the configuration, and the save asks it again after it holds its locks: another answer is a configuration that moved while the save waited, and the save reads it again. It is
--     an ordinary function of the caller (the policies of those tables already show a hub's staff the rows of their hub, and the configuration reader its own), not a definer.

CREATE FUNCTION melarc.order_places_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  intake public.pickup_intake%ROWTYPE;
  standing integer;
BEGIN
  -- The intake is held while its orders are counted, so that two orders for the last place are one after the other (the application holds it already, and a direct writer is made to).
  SELECT * INTO intake FROM public.pickup_intake AS i WHERE i.id = NEW.pickup_intake_id FOR UPDATE;
  IF NOT FOUND OR intake.receiving_mode IS DISTINCT FROM 'BLIND_COUNT' OR intake.physical_count IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT pg_catalog.count(*)::integer INTO standing
    FROM public."order" AS o
   WHERE o.pickup_intake_id = NEW.pickup_intake_id AND o.commercial_state IS DISTINCT FROM 'REVERSED';
  IF standing >= intake.physical_count THEN
    RAISE EXCEPTION 'an intake that is counted blind has an order for no more parcels than it received' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT', HINT = 'rule=orders_exceed_received';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.order_places_guard() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.order_places_guard() FROM PUBLIC;
--> statement-breakpoint
-- It fires after the order's own guard ("order_guard" sorts first), so a state or a shape that the guard refuses is told before the places are counted.
CREATE TRIGGER "order_places_guard" BEFORE INSERT ON "order"
  FOR EACH ROW EXECUTE FUNCTION melarc.order_places_guard();
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
  -- More orders than parcels received is never closed over: the exception is for parcels that are missing an order, not for orders that have no parcel.
  IF NEW.physical_count IS NOT NULL AND ordered > NEW.physical_count THEN
    RAISE EXCEPTION 'the orders are more than the parcels the hub received' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT', HINT = 'rule=orders_exceed_received';
  END IF;
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
CREATE FUNCTION melarc.hub_configuration_fingerprint(p_hub uuid) RETURNS text LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT pg_catalog.md5(
    coalesce((SELECT pg_catalog.string_agg(pg_catalog.md5(pg_catalog.to_jsonb(s)::text), ',' ORDER BY s.id) FROM public.hub_setting AS s WHERE s.hub_id = p_hub), '')
    || '|' || coalesce((SELECT pg_catalog.string_agg(pg_catalog.md5(pg_catalog.to_jsonb(z)::text), ',' ORDER BY z.id) FROM public.service_zone AS z WHERE z.hub_id = p_hub), '')
    || '|' || coalesce((SELECT pg_catalog.string_agg(pg_catalog.md5(pg_catalog.to_jsonb(a)::text), ',' ORDER BY a.id) FROM public.service_zone_alias AS a WHERE a.hub_id = p_hub), ''))
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.hub_configuration_fingerprint(uuid) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.hub_configuration_fingerprint(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.hub_configuration_fingerprint(uuid) TO melarc_api_runtime;
