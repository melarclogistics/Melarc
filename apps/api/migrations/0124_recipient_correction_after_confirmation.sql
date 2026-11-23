-- STAGE 7, THE RECIPIENT OF A CONFIRMED ORDER IS CORRECTED, NOT FROZEN WITH ITS PRICE (Run F, Part 1: D-S7-1 of the Product Owner's decisions of 23 November 2026; contract 5.119.0). The ALTER of the first two statements is
-- Drizzle's, from `order-change.schema.ts`; the rest is hand-written.
--
-- An officer who has typed a recipient's name or phone wrongly could not put it right once the price was fixed: the guard of the order accepted a change of what was transcribed only before the freeze. D-S7-1: an officer
-- (the key to itemize) may correct the NAME and the PHONE of a confirmed order, with a reason in words; an ADDRESS that leaves the zone and the price as they are is corrected the same way (the server decides that, with
-- the hub's configuration; the database holds that nothing but the recipient moves). A change of address that moves the zone or the price is a request decided by a checker, on the pattern of the payer correction: it
-- is NOT built here, and is refused by the operation (rule `address_changes_zone`) until the task of the plan that builds it (S1.39g).
--
--   * The record is the amendment record, with a `kind`: `AMENDMENT` (an order not yet confirmed, as before) or `RECIPIENT_CORRECTION`, whose `before` and `after` hold the recipient as it was and as it became, so that the old and
--     the new values are kept as an amendment keeps them. The audit event names the fields that changed and never their values.
--   * melarc.order_amendment_guard: a confirmed order takes a record of the kind `RECIPIENT_CORRECTION` and of no other; an order that is not confirmed takes the other kind alone; the record of a correction holds the
--     recipient and nothing else.
--   * melarc.order_guard (restated from 0115's text, its last definition, with the one new branch): the recipient of a confirmed order changes only beside the record of this transaction, on the version that was read,
--     while the order is PRICED, NO_VENDOR_CHARGE or PAYMENT_REQUIRED and awaits or is ready for dispatch (none of paid for, reserved or dispatched exists yet), and nothing else of the order moves.
--   * melarc.order_recipient_corrected_here(order, version): the proof helper of that branch (executable by the runtime login, whose update fires the guard).
--   * melarc.correct_order_recipient(order, version, record, note, recipient): the act, for staff under the key to itemize: the intake locked first, the order second, the version judged, the record written first, the
--     recipient replaced. It answers the new version and the fields that changed (names).

ALTER TABLE "order_amendment" ADD COLUMN "kind" text DEFAULT 'AMENDMENT' NOT NULL;--> statement-breakpoint
ALTER TABLE "order_amendment" ADD CONSTRAINT "order_amendment_kind_closed" CHECK ("order_amendment"."kind" IN ('AMENDMENT', 'RECIPIENT_CORRECTION'));
--> statement-breakpoint
CREATE FUNCTION melarc.order_recipient_corrected_here(p_order uuid, p_version integer) RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.order_amendment AS a WHERE a.order_id = p_order AND a.kind = 'RECIPIENT_CORRECTION' AND a.order_version = p_version AND a.amended_at = pg_catalog.transaction_timestamp())
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.order_recipient_corrected_here(uuid, integer) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.order_recipient_corrected_here(uuid, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.order_recipient_corrected_here(uuid, integer) TO melarc_api_runtime;
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
      IF EXISTS (SELECT 1 FROM public."order" AS o WHERE o.intake_parcel_id = NEW.intake_parcel_id AND o.commercial_state IS DISTINCT FROM 'REVERSED') THEN
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

    PERFORM melarc.order_content_check(NEW, intake.responsible_hub_id);

    -- The origin zone is the request's, resolved once: every order of an intake carries the same (AC-SLICE-001-57).
    SELECT o.origin_zone_snapshot INTO first_origin FROM public."order" AS o WHERE o.pickup_intake_id = NEW.pickup_intake_id ORDER BY o.created_at, o.id LIMIT 1;
    IF FOUND AND first_origin IS DISTINCT FROM NEW.origin_zone_snapshot THEN
      RAISE EXCEPTION 'the origin zone is the request''s, resolved once: every order of an intake carries the same' USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
  END IF;

  -- A reversed order is history: it is kept as it was.
  IF OLD.commercial_state = 'REVERSED' THEN
    RAISE EXCEPTION 'a reversed order is history and is kept as it was' USING ERRCODE = '23514';
  END IF;
  -- THE REVERSAL OF AN ARRIVAL: the order moves to REVERSED, once, while it is confirmed and has not been paid for, reserved or dispatched, beside the record of the reversal made in this transaction, and nothing else
  -- of it moves.
  IF NEW.commercial_state IS NOT DISTINCT FROM 'REVERSED' THEN
    IF OLD.locked_at IS NULL OR OLD.commercial_state NOT IN ('PRICED', 'NO_VENDOR_CHARGE', 'PAYMENT_REQUIRED') OR NOT melarc.order_reversed_here(NEW.id) THEN
      RAISE EXCEPTION 'an order is reversed only by the reversal of its arrival, while it is confirmed and has not been paid for, reserved or dispatched' USING ERRCODE = '23514';
    END IF;
    IF (pg_catalog.to_jsonb(NEW) - 'version' - 'commercial_state') IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) - 'version' - 'commercial_state') THEN
      RAISE EXCEPTION 'a reversal changes the state of the order and nothing else' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  -- THE CORRECTION OF THE RECIPIENT OF A CONFIRMED ORDER (Run F, D-S7-1; migration 0124): the name, the phone and an address that leaves the zone and the price as they are change while the order has not been paid for,
  -- reserved or dispatched, on the version that was read, beside the record of the correction made in this transaction, and nothing else of the order moves with it. NO ORDER IS PAID FOR, RESERVED OR DISPATCHED YET in this
  -- slice (an order is PRICED, NO_VENDOR_CHARGE or PAYMENT_REQUIRED, and awaits or is ready for dispatch, until a later task moves it): the states are named so that the task that adds one has to decide what a correction
  -- then is, and the guard refuses it until it has.
  IF OLD.locked_at IS NOT NULL AND NEW.recipient IS DISTINCT FROM OLD.recipient THEN
    IF (pg_catalog.to_jsonb(NEW) - 'version' - 'recipient') IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) - 'version' - 'recipient') THEN
      RAISE EXCEPTION 'a correction of the recipient changes the recipient and nothing else' USING ERRCODE = '23514';
    END IF;
    IF OLD.commercial_state IS NULL OR OLD.commercial_state NOT IN ('PRICED', 'NO_VENDOR_CHARGE', 'PAYMENT_REQUIRED')
       OR OLD.fulfilment_state NOT IN ('AWAITING_RECIPIENT_CONFIRMATION', 'READY_FOR_DISPATCH')
       OR NOT melarc.order_recipient_corrected_here(NEW.id, OLD.version) THEN
      RAISE EXCEPTION 'the recipient of a confirmed order is corrected only while it has not been paid for, reserved or dispatched, on the version that was read, and with the record of the correction' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  -- THE AMENDMENT OF AN ORDER THAT IS NOT CONFIRMED: what the officer transcribed changes only while the price is not frozen, on the version that was read, beside the record of the amendment made in this
  -- transaction; nothing that is not transcribed moves with it, and the content rules are the ones of an order that is made.
  IF melarc.order_editable(NEW) IS DISTINCT FROM melarc.order_editable(OLD) THEN
    IF OLD.locked_at IS NOT NULL OR NEW.locked_at IS NOT NULL OR NEW.commercial_state IS NOT NULL OR NOT melarc.order_amended_here(NEW.id, OLD.version) THEN
      RAISE EXCEPTION 'an order is amended only while its price is not frozen, on the version that was read, and with the record of the amendment' USING ERRCODE = '23514';
    END IF;
    IF melarc.order_fixed(NEW) IS DISTINCT FROM melarc.order_fixed(OLD) THEN
      RAISE EXCEPTION 'an amendment changes what was transcribed and nothing else' USING ERRCODE = '23514';
    END IF;
    PERFORM melarc.order_content_check(NEW, OLD.responsible_hub_id);
    RETURN NEW;
  END IF;
  -- An update. So far an order takes one change: the freeze of its price. Nothing else about it is moved.
  IF (pg_catalog.to_jsonb(NEW) - 'version' - 'locked_price_minor' - 'locked_at' - 'payer_allocation' - 'commercial_state')
     IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) - 'version' - 'locked_price_minor' - 'locked_at' - 'payer_allocation' - 'commercial_state') THEN
    RAISE EXCEPTION 'an order is kept as it was: the freeze of its price is the one change it takes so far' USING ERRCODE = '23514';
  END IF;
  IF OLD.locked_at IS NOT NULL THEN
    IF NEW.locked_price_minor IS DISTINCT FROM OLD.locked_price_minor OR NEW.locked_at IS DISTINCT FROM OLD.locked_at THEN
      RAISE EXCEPTION 'a locked price is never rewritten: a correction is a linked adjustment' USING ERRCODE = '23514';
    END IF;
    IF NEW.payer_allocation IS DISTINCT FROM OLD.payer_allocation THEN
      -- The portions of a locked price move only to what a payer correction decided in this very transaction wrote, for this order, with the commercial gate re-run from the new portions: the zero branch first.
      IF NOT EXISTS (
        SELECT 1 FROM public.payer_correction AS c
         WHERE c.order_id = NEW.id AND c.state = 'APPROVED' AND c.decided_at = pg_catalog.transaction_timestamp()
           AND c.resulting_allocation = NEW.payer_allocation AND c.resulting_commercial_state IS NOT DISTINCT FROM NEW.commercial_state
      ) THEN
        RAISE EXCEPTION 'the portions of a locked price change only by a payer correction that was approved' USING ERRCODE = '23514';
      END IF;
      IF OLD.commercial_state IS NULL OR OLD.commercial_state NOT IN ('NO_VENDOR_CHARGE', 'PAYMENT_REQUIRED') THEN
        RAISE EXCEPTION 'the portions of a price that has been paid for or reserved are not corrected here' USING ERRCODE = '23514';
      END IF;
      IF (NEW.payer_allocation ->> 'sender_minor') IS NULL OR (NEW.payer_allocation ->> 'sender_minor') !~ '^[0-9]+$'
         OR (NEW.payer_allocation ->> 'recipient_minor') IS NULL OR (NEW.payer_allocation ->> 'recipient_minor') !~ '^[0-9]+$'
         OR (NEW.payer_allocation ->> 'sender_minor')::bigint + (NEW.payer_allocation ->> 'recipient_minor')::bigint <> NEW.locked_price_minor THEN
        RAISE EXCEPTION 'the portions of the locked price add up to it' USING ERRCODE = '23514';
      END IF;
      IF NEW.commercial_state IS DISTINCT FROM (CASE WHEN (NEW.payer_allocation ->> 'sender_minor')::bigint = 0 THEN 'NO_VENDOR_CHARGE' ELSE 'PAYMENT_REQUIRED' END) THEN
        RAISE EXCEPTION 'the commercial gate is re-run from the new portions: zero is NO_VENDOR_CHARGE, above zero is PAYMENT_REQUIRED' USING ERRCODE = '23514';
      END IF;
    ELSIF NEW.commercial_state IS DISTINCT FROM OLD.commercial_state THEN
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
CREATE OR REPLACE FUNCTION melarc.order_amendment_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  ord public."order"%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'the record of an amendment is kept as it was and never removed' USING ERRCODE = '23514';
  END IF;
  IF coalesce(pg_catalog.current_setting('melarc.authorization_key', true), '') <> 'hub.intake.itemize' THEN
    RAISE EXCEPTION 'an order is amended by the officer who holds the key to itemize' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO ord FROM public."order" AS o WHERE o.id = NEW.order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'an amendment is of an order of the officer''s hubs' USING ERRCODE = '23514';
  END IF;
  IF ord.locked_at IS NOT NULL AND NEW.kind IS DISTINCT FROM 'RECIPIENT_CORRECTION' THEN
    RAISE EXCEPTION 'an order whose price is frozen is confirmed: it is not amended' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT', HINT = 'rule=order_confirmed';
  END IF;
  IF ord.locked_at IS NULL AND NEW.kind IS NOT DISTINCT FROM 'RECIPIENT_CORRECTION' THEN
    RAISE EXCEPTION 'the recipient of an order that is not confirmed is amended with the order' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT', HINT = 'rule=order_not_confirmed';
  END IF;
  IF NEW.kind IS NOT DISTINCT FROM 'RECIPIENT_CORRECTION'
     AND ((NEW.before - 'recipient') <> '{}'::jsonb OR (NEW.after - 'recipient') <> '{}'::jsonb OR NOT (NEW.before ? 'recipient') OR NOT (NEW.after ? 'recipient')) THEN
    RAISE EXCEPTION 'the record of a correction of the recipient says what the recipient was and what it became, and nothing else' USING ERRCODE = '23514';
  END IF;
  IF NEW.order_version IS DISTINCT FROM ord.version THEN
    RAISE EXCEPTION 'the order has changed since it was read' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT', HINT = 'rule=stale';
  END IF;
  IF pg_catalog.jsonb_typeof(NEW.before) IS DISTINCT FROM 'object' OR pg_catalog.jsonb_typeof(NEW.after) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'an amendment says what was and what became' USING ERRCODE = '23514';
  END IF;
  NEW.responsible_hub_id := ord.responsible_hub_id;
  NEW.amended_by := melarc.current_principal_id();
  NEW.amended_at := pg_catalog.transaction_timestamp();
  RETURN NEW;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.order_amendment_guard() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.order_amendment_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION melarc.correct_order_recipient(p_order uuid, p_version integer, p_amendment uuid, p_note text, p_recipient jsonb)
RETURNS TABLE (version integer, changed text[])
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  ord public."order"%ROWTYPE;
  held public.pickup_intake%ROWTYPE;
  fields text[] := ARRAY[]::text[];
BEGIN
  IF melarc.principal_type() IS DISTINCT FROM 'STAFF'
     OR coalesce(pg_catalog.current_setting('melarc.authorization_key', true), '') <> 'hub.intake.itemize' THEN
    RAISE EXCEPTION 'the recipient of an order is corrected by the officer who holds the key to itemize, and by nobody else' USING ERRCODE = '42501';
  END IF;
  IF p_note IS NULL OR pg_catalog.btrim(p_note) = '' THEN
    RAISE EXCEPTION 'a correction says why' USING ERRCODE = '23514', DETAIL = 'reason=REASON_REQUIRED';
  END IF;
  IF p_recipient IS NULL OR pg_catalog.jsonb_typeof(p_recipient) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'a correction restates the recipient' USING ERRCODE = '22023';
  END IF;
  SELECT i.* INTO held FROM public.pickup_intake AS i
   WHERE i.id = (SELECT o.pickup_intake_id FROM public."order" AS o WHERE o.id = p_order) FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'there is no such order in the officer''s hubs' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO ord FROM public."order" AS o WHERE o.id = p_order FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'there is no such order in the officer''s hubs' USING ERRCODE = '42501';
  END IF;
  IF ord.version <> p_version THEN
    RAISE EXCEPTION 'the order has changed since it was read' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT', HINT = 'rule=stale';
  END IF;
  IF ord.locked_at IS NULL THEN
    RAISE EXCEPTION 'the recipient of an order that is not confirmed is amended with the order' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT', HINT = 'rule=order_not_confirmed';
  END IF;
  IF ord.commercial_state = 'REVERSED' THEN
    RAISE EXCEPTION 'an order whose arrival was taken back is history' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT', HINT = 'rule=order_reversed';
  END IF;
  -- Nothing has been paid for, reserved or dispatched yet, so no order is past a correction; the day one is, the rule names it.
  IF ord.commercial_state IS NULL OR ord.commercial_state NOT IN ('PRICED', 'NO_VENDOR_CHARGE', 'PAYMENT_REQUIRED') THEN
    RAISE EXCEPTION 'an order that has been paid for or reserved is not corrected here' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT', HINT = 'rule=order_progressed';
  END IF;
  IF ord.fulfilment_state NOT IN ('AWAITING_RECIPIENT_CONFIRMATION', 'READY_FOR_DISPATCH') THEN
    RAISE EXCEPTION 'an order that has been dispatched is not corrected here' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT', HINT = 'rule=order_dispatched';
  END IF;
  IF (ord.recipient ->> 'name') IS DISTINCT FROM (p_recipient ->> 'name') THEN fields := pg_catalog.array_append(fields, 'name'); END IF;
  IF (ord.recipient ->> 'phone') IS DISTINCT FROM (p_recipient ->> 'phone') THEN fields := pg_catalog.array_append(fields, 'phone'); END IF;
  IF (ord.recipient -> 'location') IS DISTINCT FROM (p_recipient -> 'location') THEN fields := pg_catalog.array_append(fields, 'address'); END IF;
  IF pg_catalog.cardinality(fields) = 0 THEN
    RAISE EXCEPTION 'a correction changes something' USING ERRCODE = '23514', DETAIL = 'reason=VALIDATION_FAILED', HINT = 'rule=no_change';
  END IF;
  INSERT INTO public.order_amendment (id, order_id, responsible_hub_id, amended_by, order_version, note, before, after, kind)
  VALUES (p_amendment, p_order, ord.responsible_hub_id, melarc.current_principal_id(), p_version, pg_catalog.btrim(p_note),
          pg_catalog.jsonb_build_object('recipient', ord.recipient), pg_catalog.jsonb_build_object('recipient', p_recipient), 'RECIPIENT_CORRECTION');
  UPDATE public."order" SET recipient = p_recipient WHERE id = p_order;
  RETURN QUERY SELECT o.version, fields FROM public."order" AS o WHERE o.id = p_order;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.correct_order_recipient(uuid, integer, uuid, text, jsonb) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.correct_order_recipient(uuid, integer, uuid, text, jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.correct_order_recipient(uuid, integer, uuid, text, jsonb) TO melarc_api_runtime;
