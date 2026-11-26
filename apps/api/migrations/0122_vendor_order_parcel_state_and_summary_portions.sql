-- STAGE 7, WHAT A VENDOR IS TOLD OF ITS OWN ORDERS (Run F, Part 1: D-S7-4 and D-S7-10 of the Product Owner's decisions of 23 November 2026; OB-S1-120 and OB-S1-144; contract 5.119.0). Hand-written throughout: no table changes.
--
--   * D-S7-4. An order made early for a parcel that is written off stays as a record, never frozen, counted or summarised, and THE VENDOR WHO READS IT IS TOLD THE PARCEL WAS NOT RECEIVED. The order read joined the
--     parcel under the caller's own policies, and a vendor has none on `intake_parcel` (the hub's inside), so a vendor's `intake_parcel_state` was always null: no vendor could tell a parcel that did not come from one
--     the hub had not yet looked at. `melarc.vendor_order_parcel_state(order)` answers the state of the parcel of the vendor's OWN order and of no other (the owner reads the parcel under a policy of its own that names the
--     vendor's organisation through the order, as `0114` lets the owner read orders for the worklist), and it is the one thing of the parcel a vendor is told.
--   * D-S7-10. A vendor sees the who-pays amounts on its own orders (its portion and the recipient's). `getOrder` has shown a vendor `payer_allocation` since 0110 and the contract never said so; the vendor's summary of a
--     closed intake now carries it too, where the price is shown (the owning vendor, and the staff whose own `pricing.read` reaches the hub: an amount is money, and is left out, never shown as zero, where the price is). The
--     function that reads the summary is restated from 0117's text with that one member added.
--
-- The new policy admits the OWNER only (`current_user = 'melarc_owner'`), so the runtime login still cannot select a row of `intake_parcel` as a vendor.

CREATE POLICY "intake_parcel_vendor_state_read" ON "intake_parcel" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'VENDOR' THEN current_user = 'melarc_owner' AND coalesce(current_setting('melarc.authorization_key', true), '') = 'pricing.read'
      AND EXISTS (
        SELECT 1 FROM public."order" AS o
         WHERE o.intake_parcel_id = "intake_parcel"."id"
           AND o.vendor_organization_id = melarc.current_vendor_organization_id()
           AND o.commercial_state IS DISTINCT FROM 'REVERSED')
    ELSE false
  END
);
--> statement-breakpoint
CREATE FUNCTION melarc.vendor_order_parcel_state(p_order uuid)
RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  parcel_state text;
BEGIN
  IF melarc.principal_type() IS DISTINCT FROM 'VENDOR'
     OR coalesce(pg_catalog.current_setting('melarc.authorization_key', true), '') <> 'pricing.read' THEN
    RAISE EXCEPTION 'the state of the parcel of an order is told to the vendor of the order, and to nobody else by this function' USING ERRCODE = '42501';
  END IF;
  SELECT p.state INTO parcel_state
    FROM public."order" AS o
    JOIN public.intake_parcel AS p ON p.id = o.intake_parcel_id
   WHERE o.id = p_order
     AND o.vendor_organization_id = melarc.current_vendor_organization_id()
     AND o.commercial_state IS DISTINCT FROM 'REVERSED';
  RETURN parcel_state;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.vendor_order_parcel_state(uuid) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.vendor_order_parcel_state(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.vendor_order_parcel_state(uuid) TO melarc_api_runtime;
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
           'size_class', o.size_class, 'locked_price_minor', o.locked_price_minor, 'commercial_state', o.commercial_state,
           'payer_allocation', o.payer_allocation)
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
