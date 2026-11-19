-- S1.37: THE COMMERCIAL GATE (state-machines.md section 8; D-12, decided 29 October 2026: no credit reservation, the gate has two outcomes). The freeze of 0110 enters an order into its commercial machine at PRICED and
-- stopped there. From this migration the freeze goes on, in the same change, to the gate: the RESOLVED vendor portion is tested first, and a zero portion takes the order to NO_VENDOR_CHARGE with no reading of the
-- vendor's account (AC-SLICE-001-65, -66: the test reads payer_allocation.sender_minor, never the request's intent); a portion above zero takes it to PAYMENT_REQUIRED, because no allowance exists in this slice (D-12:
-- CREDIT_RESERVED and its ledger are SLICE-007's, so the credit conditions of the machine are never met). The guard holds it for every writer: the move is made once, from PRICED, by the resolved portion alone. A
-- payer correction after the freeze re-runs the gate and is S1.39's: it restates this guard when it moves the state again.
--> statement-breakpoint
CREATE OR REPLACE FUNCTION melarc.order_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  intake public.pickup_intake%ROWTYPE;
  parcel public.intake_parcel%ROWTYPE;
  request public.pickup_request%ROWTYPE;
  first_origin jsonb;
  cited uuid[];
  stored integer;
  summed bigint;
  components jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'an order is never removed' USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT * INTO intake FROM public.pickup_intake AS i WHERE i.id = NEW.pickup_intake_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'an order is made for an intake' USING ERRCODE = '23514';
    END IF;
    SELECT * INTO request FROM public.pickup_request AS r WHERE r.id = intake.pickup_request_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'an order is made for the request its intake was opened for' USING ERRCODE = '23514';
    END IF;
    -- The hub, the sender and the moment are the intake's, the request's and the database's, whatever the writer gave.
    NEW.responsible_hub_id := intake.responsible_hub_id;
    NEW.vendor_organization_id := request.vendor_organization_id;
    NEW.ad_hoc_sender_id := request.ad_hoc_sender_id;
    NEW.created_at := pg_catalog.clock_timestamp();
    NEW.version := 1;
    IF NEW.commercial_state IS NOT NULL OR NEW.locked_price_minor IS NOT NULL OR NEW.locked_at IS NOT NULL OR NEW.payer_allocation IS NOT NULL THEN
      RAISE EXCEPTION 'an order is made unfrozen: its price is frozen by a later act of the database, when its parcel has arrived' USING ERRCODE = '23514';
    END IF;
    IF NEW.fulfilment_state <> 'AWAITING_RECIPIENT_CONFIRMATION' OR NEW.delivery_attempt_count <> 0 OR NEW.delivery_date_override IS NOT NULL THEN
      RAISE EXCEPTION 'an order begins at the beginning of its life' USING ERRCODE = '23514';
    END IF;

    -- The parcel and the intake. A checked-in intake's order is made for one of its parcels; a blind-count intake has none.
    IF intake.receiving_mode = 'PHOTO_CHECK_IN' THEN
      IF NEW.intake_parcel_id IS NULL THEN
        RAISE EXCEPTION 'an order of an intake that is checked in against door photos is made for one of its parcels' USING ERRCODE = '23514', DETAIL = 'reason=VALIDATION_FAILED', HINT = 'rule=parcel_required';
      END IF;
      SELECT * INTO parcel FROM public.intake_parcel AS p WHERE p.id = NEW.intake_parcel_id AND p.pickup_intake_id = NEW.pickup_intake_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'an order is made for a parcel of its own intake' USING ERRCODE = '23514', DETAIL = 'reason=VALIDATION_FAILED', HINT = 'rule=unknown_parcel';
      END IF;
      IF parcel.state = 'VOID' THEN
        RAISE EXCEPTION 'a parcel taken back has no order' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT', HINT = 'rule=parcel_void';
      END IF;
      IF parcel.state = 'MISSING' THEN
        RAISE EXCEPTION 'a parcel that is missing is never priced or dispatched' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT', HINT = 'rule=parcel_missing';
      END IF;
      IF EXISTS (SELECT 1 FROM public."order" AS o WHERE o.intake_parcel_id = NEW.intake_parcel_id) THEN
        RAISE EXCEPTION 'a parcel has one order' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT', HINT = 'rule=parcel_ordered';
      END IF;
      IF parcel.state = 'EXPECTED' AND intake.state <> 'AWAITING_COUNT' THEN
        RAISE EXCEPTION 'an order for a parcel that has not been checked in waits for it while the vendor''s check-in is open' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT', HINT = 'rule=check_in_finished';
      END IF;
      IF parcel.state = 'ARRIVED' AND intake.state NOT IN ('READY_FOR_ITEMIZATION', 'ITEMIZING') THEN
        RAISE EXCEPTION 'an order for a parcel that has arrived is made once the vendor''s check-in is finished and cleared' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT',
          HINT = CASE intake.state WHEN 'AWAITING_COUNT' THEN 'rule=check_in_open' WHEN 'RECONCILIATION_REQUIRED' THEN 'rule=reconciliation_open' ELSE 'rule=intake_not_ready' END;
      END IF;
    ELSE
      IF NEW.intake_parcel_id IS NOT NULL THEN
        RAISE EXCEPTION 'an intake that is counted blind has no parcel to make an order for' USING ERRCODE = '23514', DETAIL = 'reason=VALIDATION_FAILED', HINT = 'rule=parcel_not_allowed';
      END IF;
      IF intake.state NOT IN ('READY_FOR_ITEMIZATION', 'ITEMIZING') THEN
        RAISE EXCEPTION 'an order is made once the intake is counted and cleared for itemization' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT',
          HINT = CASE intake.state WHEN 'AWAITING_COUNT' THEN 'rule=intake_not_counted' WHEN 'RECONCILIATION_REQUIRED' THEN 'rule=reconciliation_open' ELSE 'rule=intake_not_ready' END;
      END IF;
    END IF;

    -- The evidence: each piece cited once, stored, the intake's own and of the purpose of an itemization, in the intake's hub: "attached evidence" is never satisfied by a record with no bytes behind it.
    cited := NEW.high_value_evidence_ids || CASE WHEN NEW.carrier_waybill_evidence_id IS NULL THEN ARRAY[]::uuid[] ELSE ARRAY[NEW.carrier_waybill_evidence_id] END;
    IF pg_catalog.cardinality(cited) > 0 THEN
      IF (SELECT pg_catalog.count(DISTINCT e) FROM pg_catalog.unnest(cited) AS e) <> pg_catalog.cardinality(cited) THEN
        RAISE EXCEPTION 'an order cites each piece of evidence once' USING ERRCODE = '23514', DETAIL = 'reason=VALIDATION_FAILED', HINT = 'rule=evidence_once';
      END IF;
      SELECT pg_catalog.count(*) INTO stored FROM public.evidence AS v
       WHERE v.id = ANY (cited) AND v.state = 'STORED' AND v.owner_type = 'PICKUP_INTAKE' AND v.owner_id = NEW.pickup_intake_id
         AND v.responsible_hub_id = intake.responsible_hub_id AND v.purpose = 'ITEMIZATION';
      IF stored <> pg_catalog.cardinality(cited) THEN
        RAISE EXCEPTION 'an order cites evidence that is stored and is the intake''s own' USING ERRCODE = '23514', DETAIL = 'reason=EVIDENCE_NOT_STORED';
      END IF;
    END IF;

    -- The origin zone is the request's, resolved once: every order of an intake carries the same (AC-SLICE-001-57).
    SELECT o.origin_zone_snapshot INTO first_origin FROM public."order" AS o WHERE o.pickup_intake_id = NEW.pickup_intake_id ORDER BY o.created_at, o.id LIMIT 1;
    IF FOUND AND first_origin IS DISTINCT FROM NEW.origin_zone_snapshot THEN
      RAISE EXCEPTION 'the origin zone is the request''s, resolved once: every order of an intake carries the same' USING ERRCODE = '23514';
    END IF;

    -- The price as calculated: its components name the hub of the order and add up to its total.
    components := NEW.price_components_snapshot -> 'components';
    IF pg_catalog.jsonb_typeof(components) IS DISTINCT FROM 'array' OR pg_catalog.jsonb_array_length(components) = 0
       OR (NEW.price_components_snapshot ->> 'total_minor') IS NULL OR (NEW.price_components_snapshot ->> 'total_minor') !~ '^[0-9]+$' THEN
      RAISE EXCEPTION 'a price is a total and the components it is made of' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_catalog.jsonb_array_elements(components) AS c
       WHERE (c ->> 'amount_minor') IS NULL OR (c ->> 'amount_minor') !~ '^[0-9]+$' OR (c ->> 'hub_id') IS DISTINCT FROM intake.responsible_hub_id::text
    ) THEN
      RAISE EXCEPTION 'every component of a price names its amount and the hub of the order' USING ERRCODE = '23514';
    END IF;
    SELECT coalesce(pg_catalog.sum((c ->> 'amount_minor')::bigint), 0) INTO summed FROM pg_catalog.jsonb_array_elements(components) AS c;
    IF summed <> (NEW.price_components_snapshot ->> 'total_minor')::bigint THEN
      RAISE EXCEPTION 'the components of a price add up to its total' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  -- An update. So far an order takes one change: the freeze of its price. Nothing else about it is moved.
  IF (pg_catalog.to_jsonb(NEW) - 'version' - 'locked_price_minor' - 'locked_at' - 'payer_allocation' - 'commercial_state')
     IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) - 'version' - 'locked_price_minor' - 'locked_at' - 'payer_allocation' - 'commercial_state') THEN
    RAISE EXCEPTION 'an order is kept as it was: the freeze of its price is the one change it takes so far' USING ERRCODE = '23514';
  END IF;
  IF OLD.locked_at IS NOT NULL THEN
    IF NEW.locked_price_minor IS DISTINCT FROM OLD.locked_price_minor OR NEW.locked_at IS DISTINCT FROM OLD.locked_at
       OR NEW.payer_allocation IS DISTINCT FROM OLD.payer_allocation THEN
      RAISE EXCEPTION 'a locked price is never rewritten: a correction is a linked adjustment' USING ERRCODE = '23514';
    END IF;
    IF NEW.commercial_state IS DISTINCT FROM OLD.commercial_state THEN
      -- The commercial gate: made once, from PRICED, by the resolved vendor portion alone (zero is tested first and reads nothing of the account), to one of the two outcomes D-12 leaves.
      IF OLD.commercial_state IS DISTINCT FROM 'PRICED' THEN
        RAISE EXCEPTION 'the commercial gate is run once, from PRICED' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT', HINT = 'rule=gate_already_run';
      END IF;
      IF (OLD.payer_allocation ->> 'sender_minor')::bigint = 0 THEN
        IF NEW.commercial_state IS DISTINCT FROM 'NO_VENDOR_CHARGE' THEN
          RAISE EXCEPTION 'a resolved vendor portion of zero is NO_VENDOR_CHARGE' USING ERRCODE = '23514';
        END IF;
      ELSIF NEW.commercial_state IS DISTINCT FROM 'PAYMENT_REQUIRED' THEN
        RAISE EXCEPTION 'a vendor portion above zero, with no allowance to reserve it against, is PAYMENT_REQUIRED' USING ERRCODE = '23514';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.locked_price_minor IS NULL THEN
    RETURN NEW;
  END IF;

  -- The freeze.
  SELECT * INTO intake FROM public.pickup_intake AS i WHERE i.id = OLD.pickup_intake_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'an order is frozen for an intake the officer''s hubs show' USING ERRCODE = '23514';
  END IF;
  IF OLD.intake_parcel_id IS NOT NULL THEN
    SELECT * INTO parcel FROM public.intake_parcel AS p WHERE p.id = OLD.intake_parcel_id;
    IF NOT FOUND OR parcel.state <> 'ARRIVED' THEN
      RAISE EXCEPTION 'an order is frozen once its parcel has arrived' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT', HINT = 'rule=parcel_not_arrived';
    END IF;
  END IF;
  IF intake.state = 'AWAITING_COUNT' THEN
    RAISE EXCEPTION 'an order is frozen once the vendor''s check-in is finished: a parcel tapped while it is open can still be taken back' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT', HINT = 'rule=check_in_open';
  END IF;
  IF NEW.commercial_state IS DISTINCT FROM 'PRICED' THEN
    RAISE EXCEPTION 'a frozen order enters its commercial machine at PRICED' USING ERRCODE = '23514';
  END IF;
  IF NEW.locked_price_minor IS DISTINCT FROM (OLD.price_components_snapshot ->> 'total_minor')::integer THEN
    RAISE EXCEPTION 'the locked price is the price that was calculated' USING ERRCODE = '23514';
  END IF;
  IF (NEW.payer_allocation ->> 'sender_minor') IS NULL OR (NEW.payer_allocation ->> 'sender_minor') !~ '^[0-9]+$'
     OR (NEW.payer_allocation ->> 'recipient_minor') IS NULL OR (NEW.payer_allocation ->> 'recipient_minor') !~ '^[0-9]+$'
     OR (NEW.payer_allocation ->> 'sender_minor')::bigint + (NEW.payer_allocation ->> 'recipient_minor')::bigint <> NEW.locked_price_minor THEN
    RAISE EXCEPTION 'the portions of the locked price add up to it' USING ERRCODE = '23514';
  END IF;
  NEW.locked_at := pg_catalog.clock_timestamp();
  RETURN NEW;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.order_guard() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.order_guard() FROM PUBLIC;
--> statement-breakpoint
-- THE FREEZE OF ONE ORDER, now followed by the commercial gate (not granted to any login: the operations call it). The portions are resolved from the sender's payer arrangement **as it stands now** (the vendor may edit it until the freeze, §23.5): the order's own override when it has one, else the request's. The sender pays all, none, a fixed amount (never more than the
-- price) or a percentage of it (rounded to the pesewa, half up), and the recipient pays the rest, so that the two always add up. Returns the locked price.
CREATE OR REPLACE FUNCTION melarc.freeze_order_row(p_order uuid) RETURNS integer
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  ord public."order"%ROWTYPE;
  req public.pickup_request%ROWTYPE;
  total integer;
  intent text;
  basis text;
  amount integer;
  pct numeric;
  sender integer;
BEGIN
  SELECT * INTO ord FROM public."order" AS o WHERE o.id = p_order FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'there is no such order in the officer''s hubs' USING ERRCODE = '42501';
  END IF;
  IF ord.locked_at IS NOT NULL THEN
    RETURN ord.locked_price_minor;
  END IF;
  SELECT r.* INTO req FROM public.pickup_request AS r JOIN public.pickup_intake AS i ON i.pickup_request_id = r.id WHERE i.id = ord.pickup_intake_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'an order is frozen against the request of its intake' USING ERRCODE = '23514';
  END IF;
  total := (ord.price_components_snapshot ->> 'total_minor')::integer;
  IF ord.payer_override IS NOT NULL THEN
    intent := ord.payer_override ->> 'payer_intent';
    basis := ord.payer_override ->> 'split_basis';
    amount := (ord.payer_override ->> 'split_sender_amount_minor')::integer;
    pct := (ord.payer_override ->> 'split_sender_percentage')::numeric;
  ELSE
    intent := req.default_payer_intent;
    basis := req.split_basis;
    amount := req.split_sender_amount_minor;
    pct := req.split_sender_percentage;
  END IF;
  sender := CASE intent
    WHEN 'RECIPIENT_PAYS' THEN 0
    WHEN 'SENDER_PAYS_FULL' THEN total
    WHEN 'SPLIT' THEN CASE basis
      WHEN 'FIXED_AMOUNT' THEN LEAST(amount, total)
      WHEN 'PERCENTAGE' THEN LEAST(total, GREATEST(0, pg_catalog.round(total::numeric * pct / 100)::integer))
    END
  END;
  IF sender IS NULL OR sender < 0 THEN
    RAISE EXCEPTION 'the payer arrangement of the order cannot be resolved into portions of its price' USING ERRCODE = '23514';
  END IF;
  UPDATE public."order"
     SET commercial_state = 'PRICED', locked_price_minor = total, locked_at = pg_catalog.clock_timestamp(),
         payer_allocation = pg_catalog.jsonb_build_object('payer_intent', intent, 'split_basis', basis, 'sender_minor', sender, 'recipient_minor', total - sender)
   WHERE id = p_order;
  -- The commercial gate (S1.37), in the same change: the resolved portion is tested first and an account is never read for a portion of zero.
  UPDATE public."order"
     SET commercial_state = CASE WHEN sender = 0 THEN 'NO_VENDOR_CHARGE' ELSE 'PAYMENT_REQUIRED' END
   WHERE id = p_order;
  RETURN total;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.freeze_order_row(uuid) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.freeze_order_row(uuid) FROM PUBLIC;
--> statement-breakpoint
-- THE CONFIRMATION OF THE ORDERS THAT WAITED, now telling what the gate decided: the runtime reads an order only under the key that itemizes, and a confirmation is made under the key of the check-in or of the senior, so the
-- function hands back, with the price it froze, the state the gate took the order to and the two portions it read, for the ledger. Its rules are those of 0110.
DROP FUNCTION melarc.freeze_orders(uuid);
--> statement-breakpoint
CREATE FUNCTION melarc.freeze_orders(p_intake uuid) RETURNS TABLE (order_id uuid, locked_price_minor integer, commercial_state text, sender_minor integer, recipient_minor integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  held public.pickup_intake%ROWTYPE;
  each_order record;
BEGIN
  IF melarc.principal_type() IS DISTINCT FROM 'STAFF'
     OR coalesce(pg_catalog.current_setting('melarc.authorization_key', true), '') NOT IN ('hub.intake.count', 'hub.osd.adjudicate') THEN
    RAISE EXCEPTION 'the orders that waited are confirmed by the receiver or the senior whose act committed the arrival, and by nobody else' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO held FROM public.pickup_intake AS i WHERE i.id = p_intake;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'there is no such intake in the officer''s hubs' USING ERRCODE = '42501';
  END IF;
  IF held.state = 'AWAITING_COUNT' THEN
    RETURN;
  END IF;
  FOR each_order IN
    SELECT o.id FROM public."order" AS o
     WHERE o.pickup_intake_id = p_intake AND o.locked_at IS NULL
       AND (o.intake_parcel_id IS NULL OR EXISTS (SELECT 1 FROM public.intake_parcel AS p WHERE p.id = o.intake_parcel_id AND p.state = 'ARRIVED'))
     ORDER BY o.created_at, o.id
  LOOP
    order_id := each_order.id;
    locked_price_minor := melarc.freeze_order_row(each_order.id);
    SELECT o.commercial_state, (o.payer_allocation ->> 'sender_minor')::integer, (o.payer_allocation ->> 'recipient_minor')::integer
      INTO commercial_state, sender_minor, recipient_minor FROM public."order" AS o WHERE o.id = each_order.id;
    RETURN NEXT;
  END LOOP;
  RETURN;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.freeze_orders(uuid) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.freeze_orders(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.freeze_orders(uuid) TO melarc_api_runtime;
