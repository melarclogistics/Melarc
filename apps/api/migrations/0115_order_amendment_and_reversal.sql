CREATE TABLE "order_amendment" (
	"id" uuid PRIMARY KEY NOT NULL,
	"order_id" uuid NOT NULL,
	"responsible_hub_id" uuid NOT NULL,
	"amended_by" uuid NOT NULL,
	"amended_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"order_version" integer NOT NULL,
	"note" text NOT NULL,
	"before" jsonb NOT NULL,
	"after" jsonb NOT NULL,
	CONSTRAINT "order_amendment_note_present" CHECK (btrim("order_amendment"."note") <> '')
);
--> statement-breakpoint
CREATE TABLE "order_reversal" (
	"id" uuid PRIMARY KEY NOT NULL,
	"order_id" uuid NOT NULL,
	"intake_parcel_id" uuid NOT NULL,
	"pickup_intake_id" uuid NOT NULL,
	"responsible_hub_id" uuid NOT NULL,
	"reversed_by" uuid NOT NULL,
	"reversed_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"order_version" integer NOT NULL,
	"previous_commercial_state" text NOT NULL,
	"previous_parcel_state" text NOT NULL,
	"resulting_parcel_state" text NOT NULL,
	"note" text NOT NULL,
	CONSTRAINT "order_reversal_note_present" CHECK (btrim("order_reversal"."note") <> ''),
	CONSTRAINT "order_reversal_parcel_states" CHECK ("order_reversal"."previous_parcel_state" = 'ARRIVED' AND "order_reversal"."resulting_parcel_state" IN ('MISSING', 'VOID'))
);
--> statement-breakpoint
DROP INDEX "order_parcel_key";--> statement-breakpoint
ALTER TABLE "order_amendment" ADD CONSTRAINT "order_amendment_order_fkey" FOREIGN KEY ("order_id") REFERENCES "public"."order"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_reversal" ADD CONSTRAINT "order_reversal_order_fkey" FOREIGN KEY ("order_id") REFERENCES "public"."order"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_reversal" ADD CONSTRAINT "order_reversal_parcel_fkey" FOREIGN KEY ("intake_parcel_id") REFERENCES "public"."intake_parcel"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "order_amendment_order_idx" ON "order_amendment" USING btree ("order_id","amended_at");--> statement-breakpoint
CREATE UNIQUE INDEX "order_reversal_order_key" ON "order_reversal" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "order_reversal_intake_idx" ON "order_reversal" USING btree ("pickup_intake_id","reversed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "order_parcel_key" ON "order" USING btree ("intake_parcel_id") WHERE "order"."commercial_state" IS DISTINCT FROM 'REVERSED';

--> statement-breakpoint
-- STAGE 7: THE CONTROLLED CHANGES OF AN ORDER (the external review of 19 November 2026, findings B, C and E; itemization.md sections 5.1 and 5.2; state-machines.md sections 7 and 8).
--
--   * AN ORDER IS PREPARED BEFORE IT IS CONFIRMED (B, C). While the price of an order is not frozen, an authorized officer corrects what was transcribed (melarc.amend_order, key hub.intake.itemize), on the
--     version that was read, with the price recalculated by the server and a reason in words; the change is recorded in order_amendment with what it was and what it became. The guard of the order accepts a change of
--     what the officer transcribed ONLY beside a row of that table made in the same transaction, for the version that was read, and ONLY while the price is not frozen: so nothing else can edit an order, and a
--     confirmed order cannot be edited at all. **The freeze and the edit take the same row lock** (melarc.freeze_order_row selects the order FOR UPDATE; so does the edit, after the intake's own), and the edit
--     judges the freeze after it holds it, so they cannot disagree about which payer arrangement or price won. The payer arrangement of one order (payer_override) is edited the same way, which closes the interval
--     between a run that has started and the freeze; the payer arrangement of the REQUEST is no longer refused for the run having started (it is a financial instruction and moves no rider), and is still refused
--     once any order of the request is frozen (price_frozen).
--   * A CONFIRMED ORDER IS NEVER ERASED; A MISTAKEN ARRIVAL IS REVERSED (E). melarc.reverse_order_arrival (key hub.osd.adjudicate: Senior Ops and the Platform Admin) takes back the arrival of a parcel whose order is
--     frozen and not yet paid for, reserved or dispatched, with a reason in words: the order keeps its locked price, its portions and its trail and moves to REVERSED; the parcel moves to MISSING (a door parcel) or
--     VOID (an extra); the intake's count is recomputed and the intake goes back to RECONCILIATION_REQUIRED, where a missing parcel is searched for as any is. One order for a parcel THAT STANDS (the unique key is
--     partial): a reversed order is history, and a parcel that is found again is ordered afresh. The guards of the order, of the parcel and of the intake accept the moves a reversal makes ONLY beside a row of
--     order_reversal made in the same transaction (a payer correction's pattern: the proof is a row, never a setting), and the parcel's guard, as before, never lets a parcel leave ARRIVED under a standing order.
--   * AN INTAKE BEGINS ITEMIZING WHEN ITS FIRST ORDER IS CONFIRMED (OB-S1-142). melarc.freeze_orders, which confirms the orders that waited for their parcel, moves a READY_FOR_ITEMIZATION intake to ITEMIZING when it
--     has confirmed one, so that the state says what the work is and the close no longer has to compensate for it (it still can, for an intake that was closed with all its orders made early).
--   * melarc.payer_preview resolves the payer arrangement into portions of a total, for the preview an officer reads before confirming (the same arithmetic as the freeze: melarc.payer_portion).

ALTER TABLE "order_amendment" OWNER TO melarc_owner;
--> statement-breakpoint
ALTER TABLE "order_amendment" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "order_amendment" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT ON "order_amendment" TO melarc_api_runtime;
--> statement-breakpoint
ALTER TABLE "order_reversal" OWNER TO melarc_owner;
--> statement-breakpoint
ALTER TABLE "order_reversal" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "order_reversal" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT ON "order_reversal" TO melarc_api_runtime;
--> statement-breakpoint
CREATE POLICY "order_amendment_read" ON "order_amendment" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN coalesce(current_setting('melarc.authorization_key', true), '') IN ('hub.intake.itemize', 'pricing.read')
      AND (melarc.hub_scope_mode() = 'ALL' OR "order_amendment"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "order_amendment_insert" ON "order_amendment" FOR INSERT WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_user = 'melarc_owner' AND coalesce(current_setting('melarc.authorization_key', true), '') = 'hub.intake.itemize'
      AND (melarc.hub_scope_mode() = 'ALL' OR "order_amendment"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "order_reversal_read" ON "order_reversal" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN coalesce(current_setting('melarc.authorization_key', true), '') IN ('hub.osd.adjudicate', 'pricing.read')
      AND (melarc.hub_scope_mode() = 'ALL' OR "order_reversal"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "order_reversal_insert" ON "order_reversal" FOR INSERT WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_user = 'melarc_owner' AND coalesce(current_setting('melarc.authorization_key', true), '') = 'hub.osd.adjudicate'
      AND (melarc.hub_scope_mode() = 'ALL' OR "order_reversal"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
);
--> statement-breakpoint
-- The senior who reverses an arrival reads the order as `getOrder` shows it, to hold the version of what was read (the key of the adjudication already reads the parcels, and holds pricing.read).
CREATE POLICY "order_reversal_order_read" ON "order" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN coalesce(current_setting('melarc.authorization_key', true), '') = 'hub.osd.adjudicate'
      AND (melarc.hub_scope_mode() = 'ALL' OR "order"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
);
--> statement-breakpoint
-- The reversal looks for a payer correction that waits for its decision (as the owner, under the key of the adjudication): a correction held for a decision is never reversed away.
CREATE POLICY "payer_correction_reversal_read" ON "payer_correction" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_user = 'melarc_owner' AND coalesce(current_setting('melarc.authorization_key', true), '') = 'hub.osd.adjudicate'
      AND (melarc.hub_scope_mode() = 'ALL' OR "payer_correction"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
);
--> statement-breakpoint
-- The commitment of an order that is not yet confirmed is rewritten with the order's dates (the guard below holds the rest).
CREATE POLICY "delivery_commitment_amend" ON "delivery_commitment" FOR UPDATE USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_user = 'melarc_owner' AND coalesce(current_setting('melarc.authorization_key', true), '') = 'hub.intake.itemize'
      AND (melarc.hub_scope_mode() = 'ALL' OR "delivery_commitment"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
) WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_user = 'melarc_owner' AND coalesce(current_setting('melarc.authorization_key', true), '') = 'hub.intake.itemize'
      AND (melarc.hub_scope_mode() = 'ALL' OR "delivery_commitment"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
);
--> statement-breakpoint
-- THE PROOFS THE GUARDS LOOK FOR: a row made in this very transaction (the database's moment of the transaction is its time), never a setting a writer could assert.
CREATE FUNCTION melarc.order_amended_here(p_order uuid, p_version integer) RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.order_amendment AS a WHERE a.order_id = p_order AND (p_version IS NULL OR a.order_version = p_version) AND a.amended_at = pg_catalog.transaction_timestamp())
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.order_amended_here(uuid, integer) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.order_amended_here(uuid, integer) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION melarc.order_reversed_here(p_order uuid) RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.order_reversal AS r WHERE r.order_id = p_order AND r.reversed_at = pg_catalog.transaction_timestamp())
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.order_reversed_here(uuid) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.order_reversed_here(uuid) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION melarc.parcel_reversed_here(p_parcel uuid, p_to text) RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.order_reversal AS r WHERE r.intake_parcel_id = p_parcel AND r.resulting_parcel_state = p_to AND r.reversed_at = pg_catalog.transaction_timestamp())
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.parcel_reversed_here(uuid, text) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.parcel_reversed_here(uuid, text) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION melarc.intake_reversed_here(p_intake uuid) RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.order_reversal AS r WHERE r.pickup_intake_id = p_intake AND r.reversed_at = pg_catalog.transaction_timestamp())
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.intake_reversed_here(uuid) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.intake_reversed_here(uuid) FROM PUBLIC;
--> statement-breakpoint
-- THE GUARDS OF THE TWO RECORDS, for every writer: appended and never edited or removed; who, when and where are the database's.
CREATE FUNCTION melarc.order_amendment_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
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
  IF ord.locked_at IS NOT NULL THEN
    RAISE EXCEPTION 'an order whose price is frozen is confirmed: it is not amended' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT', HINT = 'rule=order_confirmed';
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
CREATE TRIGGER "order_amendment_guard" BEFORE INSERT OR UPDATE OR DELETE ON "order_amendment"
  FOR EACH ROW EXECUTE FUNCTION melarc.order_amendment_guard();
--> statement-breakpoint
CREATE FUNCTION melarc.order_reversal_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  ord public."order"%ROWTYPE;
  parcel public.intake_parcel%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'the record of a reversal is kept as it was and never removed' USING ERRCODE = '23514';
  END IF;
  IF coalesce(pg_catalog.current_setting('melarc.authorization_key', true), '') <> 'hub.osd.adjudicate' THEN
    RAISE EXCEPTION 'an arrival is reversed by the senior officer who holds the key of the adjudication' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO ord FROM public."order" AS o WHERE o.id = NEW.order_id;
  IF NOT FOUND OR ord.intake_parcel_id IS DISTINCT FROM NEW.intake_parcel_id OR ord.pickup_intake_id IS DISTINCT FROM NEW.pickup_intake_id THEN
    RAISE EXCEPTION 'a reversal is of an order of the officer''s hubs, with its own parcel and its own intake' USING ERRCODE = '23514';
  END IF;
  IF ord.locked_at IS NULL OR ord.commercial_state NOT IN ('PRICED', 'NO_VENDOR_CHARGE', 'PAYMENT_REQUIRED') THEN
    RAISE EXCEPTION 'only a confirmed order that has not been paid for, reserved or dispatched is reversed' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT', HINT = 'rule=order_progressed';
  END IF;
  IF NEW.order_version IS DISTINCT FROM ord.version THEN
    RAISE EXCEPTION 'the order has changed since it was read' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT', HINT = 'rule=stale';
  END IF;
  SELECT * INTO parcel FROM public.intake_parcel AS p WHERE p.id = NEW.intake_parcel_id;
  IF NOT FOUND OR parcel.state <> 'ARRIVED' THEN
    RAISE EXCEPTION 'the arrival that is reversed is the arrival of a parcel that is there' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT', HINT = 'rule=parcel_not_arrived';
  END IF;
  NEW.responsible_hub_id := ord.responsible_hub_id;
  NEW.reversed_by := melarc.current_principal_id();
  NEW.reversed_at := pg_catalog.transaction_timestamp();
  NEW.previous_commercial_state := ord.commercial_state;
  NEW.previous_parcel_state := parcel.state;
  NEW.resulting_parcel_state := CASE parcel.origin WHEN 'DOOR_PHOTO' THEN 'MISSING' ELSE 'VOID' END;
  RETURN NEW;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.order_reversal_guard() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.order_reversal_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "order_reversal_guard" BEFORE INSERT OR UPDATE OR DELETE ON "order_reversal"
  FOR EACH ROW EXECUTE FUNCTION melarc.order_reversal_guard();
--> statement-breakpoint
-- THE CONTENT RULES OF AN ORDER, the same for the order that is made and for the order that is amended: each piece of evidence cited once, stored, the intake's own and of the purpose of an itemization, in the
-- intake's hub (an attached evidence is never satisfied by a record with no bytes behind it); and a price that is a total and the components it is made of, each naming its amount and the hub of the order.
CREATE FUNCTION melarc.order_content_check(ord public."order", p_hub uuid) RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  cited uuid[];
  stored integer;
  summed bigint;
  components jsonb;
BEGIN
    -- The evidence: each piece cited once, stored, the intake's own and of the purpose of an itemization, in the intake's hub: "attached evidence" is never satisfied by a record with no bytes behind it.
    cited := ord.high_value_evidence_ids || CASE WHEN ord.carrier_waybill_evidence_id IS NULL THEN ARRAY[]::uuid[] ELSE ARRAY[ord.carrier_waybill_evidence_id] END;
    IF pg_catalog.cardinality(cited) > 0 THEN
      IF (SELECT pg_catalog.count(DISTINCT e) FROM pg_catalog.unnest(cited) AS e) <> pg_catalog.cardinality(cited) THEN
        RAISE EXCEPTION 'an order cites each piece of evidence once' USING ERRCODE = '23514', DETAIL = 'reason=VALIDATION_FAILED', HINT = 'rule=evidence_once';
      END IF;
      SELECT pg_catalog.count(*) INTO stored FROM public.evidence AS v
       WHERE v.id = ANY (cited) AND v.state = 'STORED' AND v.owner_type = 'PICKUP_INTAKE' AND v.owner_id = ord.pickup_intake_id
         AND v.responsible_hub_id = p_hub AND v.purpose = 'ITEMIZATION';
      IF stored <> pg_catalog.cardinality(cited) THEN
        RAISE EXCEPTION 'an order cites evidence that is stored and is the intake''s own' USING ERRCODE = '23514', DETAIL = 'reason=EVIDENCE_NOT_STORED';
      END IF;
    END IF;

    -- The price as calculated: its components name the hub of the order and add up to its total.
    components := ord.price_components_snapshot -> 'components';
    IF pg_catalog.jsonb_typeof(components) IS DISTINCT FROM 'array' OR pg_catalog.jsonb_array_length(components) = 0
       OR (ord.price_components_snapshot ->> 'total_minor') IS NULL OR (ord.price_components_snapshot ->> 'total_minor') !~ '^[0-9]+$' THEN
      RAISE EXCEPTION 'a price is a total and the components it is made of' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_catalog.jsonb_array_elements(components) AS c
       WHERE (c ->> 'amount_minor') IS NULL OR (c ->> 'amount_minor') !~ '^[0-9]+$' OR (c ->> 'hub_id') IS DISTINCT FROM p_hub::text
    ) THEN
      RAISE EXCEPTION 'every component of a price names its amount and the hub of the order' USING ERRCODE = '23514';
    END IF;
    SELECT coalesce(pg_catalog.sum((c ->> 'amount_minor')::bigint), 0) INTO summed FROM pg_catalog.jsonb_array_elements(components) AS c;
    IF summed <> (ord.price_components_snapshot ->> 'total_minor')::bigint THEN
      RAISE EXCEPTION 'the components of a price add up to its total' USING ERRCODE = '23514';
    END IF;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.order_content_check(public."order", uuid) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.order_content_check(public."order", uuid) FROM PUBLIC;


--> statement-breakpoint
-- What of an order is transcribed (the members an amendment may change), and what is not (everything else but the version): one list, for the guard and for the amendment.
CREATE FUNCTION melarc.order_editable(ord public."order") RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT coalesce(pg_catalog.jsonb_object_agg(e.key, e.value), '{}'::jsonb)
    FROM pg_catalog.jsonb_each(pg_catalog.to_jsonb(ord)) AS e
   WHERE e.key = ANY (ARRAY['recipient', 'destination_zone_snapshot', 'destination_zone_resolution', 'declared_value_minor', 'is_serialized_goods', 'serial_imei', 'requested_delivery_date',
                            'derived_delivery_date', 'size_class', 'size_class_selected_by', 'carrier_cost_minor', 'carrier_waybill_evidence_id', 'is_high_value', 'high_value_evidence_ids', 'lane',
                            'commercial_mode', 'payer_override', 'payer_override_applied', 'price_components_snapshot'])
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.order_editable(public."order") OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.order_editable(public."order") FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION melarc.order_fixed(ord public."order") RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT coalesce(pg_catalog.jsonb_object_agg(e.key, e.value), '{}'::jsonb)
    FROM pg_catalog.jsonb_each(pg_catalog.to_jsonb(ord)) AS e
   WHERE e.key <> 'version' AND NOT (e.key = ANY (ARRAY['recipient', 'destination_zone_snapshot', 'destination_zone_resolution', 'declared_value_minor', 'is_serialized_goods', 'serial_imei',
                            'requested_delivery_date', 'derived_delivery_date', 'size_class', 'size_class_selected_by', 'carrier_cost_minor', 'carrier_waybill_evidence_id', 'is_high_value',
                            'high_value_evidence_ids', 'lane', 'commercial_mode', 'payer_override', 'payer_override_applied', 'price_components_snapshot']))
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.order_fixed(public."order") OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.order_fixed(public."order") FROM PUBLIC;

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
CREATE OR REPLACE FUNCTION melarc.delivery_commitment_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  held public."order"%ROWTYPE;
  custody timestamp with time zone;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a commitment is never removed' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (pg_catalog.to_jsonb(NEW) - 'superseded_at' - 'default_date' - 'requested_date' - 'committed_date' - 'committed_window_start' - 'committed_window_end')
         IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) - 'superseded_at' - 'default_date' - 'requested_date' - 'committed_date' - 'committed_window_start' - 'committed_window_end')
       OR (OLD.superseded_at IS NOT NULL AND NEW.superseded_at IS DISTINCT FROM OLD.superseded_at) THEN
      RAISE EXCEPTION 'a commitment is kept as it was: only its supersession is written, once' USING ERRCODE = '23514';
    END IF;
    -- The dates of the promise of an order that is NOT confirmed are rewritten by the amendment of that order, and by nothing else (the promise of a confirmed order is kept).
    IF NEW.default_date IS DISTINCT FROM OLD.default_date OR NEW.requested_date IS DISTINCT FROM OLD.requested_date OR NEW.committed_date IS DISTINCT FROM OLD.committed_date
       OR NEW.committed_window_start IS DISTINCT FROM OLD.committed_window_start OR NEW.committed_window_end IS DISTINCT FROM OLD.committed_window_end THEN
      SELECT * INTO held FROM public."order" AS o WHERE o.id = NEW.order_id;
      IF NOT FOUND OR held.locked_at IS NOT NULL OR NOT melarc.order_amended_here(NEW.order_id, NULL) THEN
        RAISE EXCEPTION 'the promise of an order is rewritten only by the amendment of an order that is not confirmed' USING ERRCODE = '23514';
      END IF;
      IF NEW.sequence <> 1 OR NEW.default_date IS DISTINCT FROM held.derived_delivery_date OR NEW.requested_date IS DISTINCT FROM held.requested_delivery_date
         OR NEW.committed_date IS DISTINCT FROM coalesce(held.requested_delivery_date, held.derived_delivery_date) THEN
        RAISE EXCEPTION 'the initial commitment is the order''s own dates: the default, what was asked, and what is promised' USING ERRCODE = '23514';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO held FROM public."order" AS o WHERE o.id = NEW.order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'a commitment is of an order' USING ERRCODE = '23514';
  END IF;
  IF NEW.sequence <> 1 OR NEW.superseded_at IS NOT NULL OR NEW.change_reason_code IS NOT NULL OR NEW.approved_by_staff_id IS NOT NULL THEN
    RAISE EXCEPTION 'only the initial commitment of an order is made so far: the revision of a promise is a task of its own' USING ERRCODE = '23514';
  END IF;
  IF NEW.default_date IS DISTINCT FROM held.derived_delivery_date OR NEW.requested_date IS DISTINCT FROM held.requested_delivery_date
     OR NEW.committed_date IS DISTINCT FROM coalesce(held.requested_delivery_date, held.derived_delivery_date) THEN
    RAISE EXCEPTION 'the initial commitment is the order''s own dates: the default, what was asked, and what is promised' USING ERRCODE = '23514';
  END IF;
  custody := melarc.pickup_custody_at(held.pickup_intake_id);
  IF custody IS NULL THEN
    RAISE EXCEPTION 'the moment custody passed cannot be read from the stop''s collection' USING ERRCODE = '23514', DETAIL = 'reason=COMMITMENT_SOURCE_UNRESOLVED';
  END IF;
  NEW.responsible_hub_id := held.responsible_hub_id;
  NEW.sla_start_at := custody;
  NEW.created_at := pg_catalog.clock_timestamp();
  RETURN NEW;
END
$$;

--> statement-breakpoint
ALTER FUNCTION melarc.delivery_commitment_guard() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.delivery_commitment_guard() FROM PUBLIC;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION melarc.intake_parcel_order_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF OLD.state = 'ARRIVED' AND NEW.state IS DISTINCT FROM OLD.state
     AND EXISTS (SELECT 1 FROM public."order" AS o WHERE o.intake_parcel_id = OLD.id AND o.locked_at IS NOT NULL AND o.commercial_state IS DISTINCT FROM 'REVERSED') THEN
    RAISE EXCEPTION 'a parcel whose order is priced is not taken back' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT', HINT = 'rule=parcel_has_order';
  END IF;
  RETURN NEW;
END
$$;

--> statement-breakpoint
ALTER FUNCTION melarc.intake_parcel_order_guard() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.intake_parcel_order_guard() FROM PUBLIC;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION melarc.intake_parcel_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  act_key text := coalesce(pg_catalog.current_setting('melarc.authorization_key', true), '');
  intake_hub uuid;
  intake_state text;
  intake_mode text;
  intake_manifest uuid;
  intake_request uuid;
  evidence_found integer;
  reversal boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a parcel is kept and never removed' USING ERRCODE = '23514';
  END IF;
  SELECT i.responsible_hub_id, i.state, i.receiving_mode, i.pickup_manifest_id, i.pickup_request_id
    INTO intake_hub, intake_state, intake_mode, intake_manifest, intake_request
    FROM public.pickup_intake AS i WHERE i.id = NEW.pickup_intake_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'a parcel is a parcel of an intake that is there' USING ERRCODE = '23514';
  END IF;
  IF intake_mode IS DISTINCT FROM 'PHOTO_CHECK_IN' THEN
    RAISE EXCEPTION 'only an intake that is checked in against door photos has parcels' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT', HINT = 'rule=blind_count_intake';
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.responsible_hub_id := intake_hub;
    NEW.version := 1;
    NEW.created_at := pg_catalog.clock_timestamp();
    IF NEW.origin = 'DOOR_PHOTO' THEN
      -- A door parcel is opened with its intake, for an intake that is waiting to be checked in, and is made for one of the photos of the stop's count. Its place among them (the set is exactly the photos,
      -- once each and in their order) is judged at the end of the transaction, for every writer, by melarc.intake_parcel_set_check.
      IF intake_state <> 'AWAITING_COUNT' OR NEW.state <> 'EXPECTED' THEN
        RAISE EXCEPTION 'a door parcel is opened, expected, for an intake that is waiting to be checked in' USING ERRCODE = '23514';
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM public.collection_parcel_photo AS counted_photo
          JOIN public.pickup_stop AS counted_stop ON counted_stop.id = counted_photo.pickup_stop_id
         WHERE counted_photo.evidence_id = NEW.door_photo_evidence_id
           AND counted_stop.pickup_manifest_id = intake_manifest AND counted_stop.pickup_request_id = intake_request
      ) THEN
        RAISE EXCEPTION 'a door parcel is made for one of the photos of the stop''s count' USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END IF;
    -- An extra, found at the hub with no photo of the door: added while the vendor's check-in is open or the case is open, never to a case that was resolved or once itemizing has started.
    IF intake_state IN ('ITEMIZING', 'CLOSED') THEN
      RAISE EXCEPTION 'an extra is not added once itemizing has started' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT', HINT = 'rule=itemization_started';
    END IF;
    IF intake_state NOT IN ('AWAITING_COUNT', 'RECONCILIATION_REQUIRED') THEN
      RAISE EXCEPTION 'an extra is not added to a case that was resolved' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT', HINT = 'rule=check_in_finished';
    END IF;
    IF NEW.state <> 'ARRIVED' THEN
      RAISE EXCEPTION 'an extra is on the table: it is added arrived' USING ERRCODE = '23514';
    END IF;
    SELECT pg_catalog.count(*) INTO evidence_found FROM public.evidence AS v
     WHERE v.id = NEW.hub_photo_evidence_id AND v.state = 'STORED' AND v.owner_type = 'PICKUP_INTAKE' AND v.owner_id = NEW.pickup_intake_id
       AND v.responsible_hub_id = intake_hub AND v.purpose = 'OSD';
    IF evidence_found <> 1 THEN
      RAISE EXCEPTION 'an extra has a stored photo of this intake' USING ERRCODE = '23514', DETAIL = 'reason=EVIDENCE_NOT_STORED';
    END IF;
    NEW.ordinal := coalesce((SELECT pg_catalog.max(p.ordinal) FROM public.intake_parcel AS p WHERE p.pickup_intake_id = NEW.pickup_intake_id), 0) + 1;
    NEW.arrived_by := melarc.current_principal_id();
    NEW.arrived_at := pg_catalog.clock_timestamp();
    RETURN NEW;
  END IF;

  -- An update. A parcel keeps its intake, its hub, its place, its origin and its photo for ever.
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.pickup_intake_id IS DISTINCT FROM OLD.pickup_intake_id
     OR NEW.responsible_hub_id IS DISTINCT FROM OLD.responsible_hub_id
     OR NEW.ordinal IS DISTINCT FROM OLD.ordinal
     OR NEW.origin IS DISTINCT FROM OLD.origin
     OR NEW.door_photo_evidence_id IS DISTINCT FROM OLD.door_photo_evidence_id
     OR NEW.hub_photo_evidence_id IS DISTINCT FROM OLD.hub_photo_evidence_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a parcel keeps its intake, its hub, its place, its origin and its photo' USING ERRCODE = '23514';
  END IF;
  IF NEW.state IS NOT DISTINCT FROM OLD.state THEN
    -- Who checked a parcel in, and when, change only with its state.
    IF NEW.arrived_by IS DISTINCT FROM OLD.arrived_by OR NEW.arrived_at IS DISTINCT FROM OLD.arrived_at OR NEW.missing_marked_at IS DISTINCT FROM OLD.missing_marked_at THEN
      RAISE EXCEPTION 'who checked a parcel in, and when, change only with its state' USING ERRCODE = '23514';
    END IF;
    NEW.version := OLD.version;
    RETURN NEW;
  END IF;
  -- The move a reversal of an arrival makes (a senior officer, beside the record of the reversal made in this transaction): the only move of a parcel once itemizing has started.
  reversal := OLD.state = 'ARRIVED' AND NEW.state IN ('MISSING', 'VOID') AND act_key = 'hub.osd.adjudicate'
    AND intake_state IN ('READY_FOR_ITEMIZATION', 'ITEMIZING', 'RECONCILIATION_REQUIRED') AND melarc.parcel_reversed_here(OLD.id, NEW.state);
  IF NOT reversal AND intake_state IN ('ITEMIZING', 'CLOSED') THEN
    RAISE EXCEPTION 'a parcel does not move once itemizing has started' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT', HINT = 'rule=itemization_started';
  END IF;
  IF NOT reversal AND NOT (
    -- the tap, the untap and the finishing of the vendor, by the receiver, while the vendor's check-in is open
    (OLD.state = 'EXPECTED' AND NEW.state = 'ARRIVED' AND act_key = 'hub.intake.count' AND intake_state = 'AWAITING_COUNT')
    OR (OLD.state = 'ARRIVED' AND NEW.state = 'EXPECTED' AND OLD.origin = 'DOOR_PHOTO' AND act_key = 'hub.intake.count' AND intake_state = 'AWAITING_COUNT')
    OR (OLD.state = 'EXPECTED' AND NEW.state = 'MISSING' AND act_key = 'hub.intake.count' AND intake_state = 'AWAITING_COUNT')
    -- a parcel that is found, by the receiver while the case is open, and by the senior's correction before itemizing
    OR (OLD.state = 'MISSING' AND NEW.state = 'ARRIVED' AND (
         (act_key = 'hub.intake.count' AND intake_state = 'RECONCILIATION_REQUIRED')
         OR (act_key = 'hub.osd.adjudicate' AND intake_state IN ('RECONCILIATION_REQUIRED', 'READY_FOR_ITEMIZATION'))))
    -- the senior's other corrections: a door parcel that did not arrive, an extra taken back or restored
    OR (OLD.state = 'ARRIVED' AND NEW.state = 'MISSING' AND OLD.origin = 'DOOR_PHOTO' AND act_key = 'hub.osd.adjudicate' AND intake_state IN ('RECONCILIATION_REQUIRED', 'READY_FOR_ITEMIZATION'))
    OR (OLD.state = 'ARRIVED' AND NEW.state = 'VOID' AND OLD.origin = 'HUB_EXTRA' AND (
         (act_key = 'hub.intake.count' AND intake_state = 'AWAITING_COUNT')
         OR (act_key = 'hub.osd.adjudicate' AND intake_state IN ('RECONCILIATION_REQUIRED', 'READY_FOR_ITEMIZATION'))))
    OR (OLD.state = 'VOID' AND NEW.state = 'ARRIVED' AND act_key = 'hub.osd.adjudicate' AND intake_state IN ('RECONCILIATION_REQUIRED', 'READY_FOR_ITEMIZATION'))
  ) THEN
    RAISE EXCEPTION 'a parcel moves as the machine of an intake says, by the key of its act, and no other way' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT', HINT = 'rule=check_in_finished';
  END IF;
  -- Who and when are the database's, and what a state implies is the state's: the officer in whose name the statement runs, the moment of the clock.
  IF NEW.state = 'ARRIVED' THEN
    NEW.arrived_by := melarc.current_principal_id();
    NEW.arrived_at := pg_catalog.clock_timestamp();
  ELSIF NEW.state = 'EXPECTED' THEN
    NEW.arrived_by := NULL;
    NEW.arrived_at := NULL;
    NEW.missing_marked_at := NULL;
  ELSIF NEW.state = 'MISSING' THEN
    NEW.arrived_by := NULL;
    NEW.arrived_at := NULL;
    NEW.missing_marked_at := pg_catalog.clock_timestamp();
  ELSE
    -- VOID: the extra had arrived, and keeps who and when.
    NEW.arrived_by := OLD.arrived_by;
    NEW.arrived_at := OLD.arrived_at;
    NEW.missing_marked_at := OLD.missing_marked_at;
  END IF;
  NEW.version := OLD.version + 1;
  RETURN NEW;
END
$$;

--> statement-breakpoint
ALTER FUNCTION melarc.intake_parcel_guard() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.intake_parcel_guard() FROM PUBLIC;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION melarc.pickup_intake_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  run_state text;
  run_completed_at timestamp with time zone;
  idle_minutes integer;
  act_key text := coalesce(pg_catalog.current_setting('melarc.authorization_key', true), '');
  facts record;
  count_moved boolean;
  routed_clean boolean;
  reversal boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'AWAITING_COUNT' THEN
      RAISE EXCEPTION 'an intake is opened at AWAITING_COUNT, with nothing counted' USING ERRCODE = '23514';
    END IF;
    SELECT m.state, m.completed_at INTO run_state, run_completed_at
      FROM public.pickup_manifest AS m WHERE m.id = NEW.pickup_manifest_id AND m.responsible_hub_id = NEW.responsible_hub_id;
    IF NOT FOUND OR run_state IS DISTINCT FROM 'COMPLETED' OR run_completed_at IS NULL THEN
      RAISE EXCEPTION 'an intake is opened by the hub handover of a completed run' USING ERRCODE = '23514';
    END IF;
    -- The guard reads whether the request was collected, and never what it was collected at (MSC-DEC-194 part 3).
    IF NOT EXISTS (
      SELECT 1 FROM public.pickup_stop AS s
       WHERE s.pickup_manifest_id = NEW.pickup_manifest_id AND s.pickup_request_id = NEW.pickup_request_id AND s.state IN ('COLLECTED', 'PARTIALLY_COLLECTED')
    ) THEN
      RAISE EXCEPTION 'an intake is opened for a request that was collected on its run' USING ERRCODE = '23514';
    END IF;
    IF melarc.run_custody_holder(NEW.pickup_manifest_id) IS DISTINCT FROM NEW.handed_over_by THEN
      RAISE EXCEPTION 'an intake is opened in the name of the custody holder of its run' USING ERRCODE = '23514';
    END IF;
    -- The receipt is the database's: the moment the handover completed the run, whatever the writer gave.
    NEW.handed_over_at := run_completed_at;
    -- The receiving mode is the stop's, whatever the writer gave (Run D): a stop whose count carries door photos is checked in against them, any other is counted blind.
    NEW.receiving_mode := CASE
      WHEN EXISTS (SELECT 1 FROM melarc.intake_door_photos(NEW.pickup_manifest_id, NEW.pickup_request_id)) THEN 'PHOTO_CHECK_IN'
      ELSE 'BLIND_COUNT'
    END;
    NEW.lock_opened_at := NULL;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.code IS DISTINCT FROM OLD.code
     OR NEW.responsible_hub_id IS DISTINCT FROM OLD.responsible_hub_id
     OR NEW.pickup_request_id IS DISTINCT FROM OLD.pickup_request_id
     OR NEW.pickup_manifest_id IS DISTINCT FROM OLD.pickup_manifest_id
     OR NEW.handed_over_by IS DISTINCT FROM OLD.handed_over_by
     OR NEW.handed_over_at IS DISTINCT FROM OLD.handed_over_at
     OR NEW.declaration_captured_at IS DISTINCT FROM OLD.declaration_captured_at
     OR NEW.rider_declared_count IS DISTINCT FROM OLD.rider_declared_count
     OR NEW.prefilled_count IS DISTINCT FROM OLD.prefilled_count
     OR NEW.receiving_mode IS DISTINCT FROM OLD.receiving_mode THEN
    RAISE EXCEPTION 'an intake keeps its identity, its run, its request, its hub, its handover, its declaration and its receiving mode' USING ERRCODE = '23514';
  END IF;

  -- A count, once made, keeps its receiver and its moment for ever. Its number, its difference and its variance change only before itemizing starts, and only by the acts that are for it (Run D): a found parcel
  -- or an extra of a photo intake (hub.intake.count, the case open), and a senior's correction of a photo intake or of a blind count (hub.osd.adjudicate, the case open or the intake cleared).
  count_moved := NEW.physical_count IS DISTINCT FROM OLD.physical_count
    OR NEW.count_variance IS DISTINCT FROM OLD.count_variance
    OR NEW.count_difference IS DISTINCT FROM OLD.count_difference;
  -- THE REVERSAL OF AN ARRIVAL (a senior officer, beside the record of the reversal made in this transaction) sends an intake back to reconciliation with the count recomputed, even from ITEMIZING: the one way a
  -- count moves once itemizing has started.
  reversal := act_key = 'hub.osd.adjudicate' AND NEW.state = 'RECONCILIATION_REQUIRED' AND OLD.state IN ('READY_FOR_ITEMIZATION', 'ITEMIZING', 'RECONCILIATION_REQUIRED')
    AND melarc.intake_reversed_here(NEW.id);
  IF OLD.physical_count IS NOT NULL
     AND (NEW.counted_at IS DISTINCT FROM OLD.counted_at OR NEW.counted_by IS DISTINCT FROM OLD.counted_by) THEN
    RAISE EXCEPTION 'a count, once made, is kept as it was' USING ERRCODE = '23514';
  END IF;
  IF OLD.physical_count IS NOT NULL AND count_moved AND NOT reversal THEN
    IF OLD.state NOT IN ('RECONCILIATION_REQUIRED', 'READY_FOR_ITEMIZATION')
       OR NEW.state NOT IN ('RECONCILIATION_REQUIRED', 'READY_FOR_ITEMIZATION')
       OR NOT (
         (OLD.receiving_mode = 'PHOTO_CHECK_IN' AND act_key IN ('hub.intake.count', 'hub.osd.adjudicate'))
         OR (OLD.receiving_mode = 'BLIND_COUNT' AND act_key = 'hub.osd.adjudicate')
       ) THEN
      RAISE EXCEPTION 'a count, once made, is kept as it was' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state
     AND NOT (
       (OLD.state = 'AWAITING_COUNT' AND NEW.state = 'COUNTED')
       OR (OLD.state = 'COUNTED' AND NEW.state IN ('READY_FOR_ITEMIZATION', 'RECONCILIATION_REQUIRED'))
       OR (OLD.state = 'RECONCILIATION_REQUIRED' AND NEW.state = 'READY_FOR_ITEMIZATION')
       OR (OLD.state = 'READY_FOR_ITEMIZATION' AND NEW.state = 'RECONCILIATION_REQUIRED')
       OR (OLD.state = 'READY_FOR_ITEMIZATION' AND NEW.state = 'ITEMIZING')
       OR (OLD.state = 'ITEMIZING' AND NEW.state = 'CLOSED')
       OR (OLD.state = 'ITEMIZING' AND NEW.state = 'RECONCILIATION_REQUIRED' AND reversal)
       OR (OLD.state = 'CLOSED' AND NEW.state = 'ITEMIZING')
     ) THEN
    RAISE EXCEPTION 'an intake moves from AWAITING_COUNT to COUNTED, from COUNTED to READY_FOR_ITEMIZATION or RECONCILIATION_REQUIRED, from RECONCILIATION_REQUIRED to READY_FOR_ITEMIZATION and back when a condition is found, then to ITEMIZING and CLOSED, and a closed one is reopened to ITEMIZING, and no other way' USING ERRCODE = '23514';
  END IF;

  -- The count (S1.33; state-machines.md section 7). The comparison is the database's, for every writer, and the moment of the first count is the database's, whatever the writer gave. A blind count's
  -- difference is the physical count minus the declaration; a photo intake's count is the number of its parcels that arrived and its difference is that number minus the number expected (the door photos).
  IF NEW.physical_count IS NOT NULL AND (OLD.physical_count IS NULL OR count_moved) THEN
    IF NEW.receiving_mode = 'PHOTO_CHECK_IN' THEN
      SELECT * INTO facts FROM melarc.intake_parcel_facts(NEW.id);
      IF NEW.physical_count IS DISTINCT FROM facts.arrived
         OR NEW.count_difference IS DISTINCT FROM NEW.physical_count - facts.expected
         OR NEW.count_variance IS DISTINCT FROM (
           CASE WHEN NEW.physical_count = facts.expected THEN 'MATCH'
                WHEN NEW.physical_count < facts.expected THEN 'SHORT'
                ELSE 'OVER' END) THEN
        RAISE EXCEPTION 'a photo intake is counted by its parcels: its count is the number that arrived, and its difference and its variance are that number against the number expected' USING ERRCODE = '23514';
      END IF;
    ELSIF NEW.count_difference IS DISTINCT FROM NEW.physical_count - OLD.rider_declared_count
       OR NEW.count_variance IS DISTINCT FROM (
         CASE WHEN NEW.physical_count = OLD.rider_declared_count THEN 'MATCH'
              WHEN NEW.physical_count < OLD.rider_declared_count THEN 'SHORT'
              ELSE 'OVER' END) THEN
      RAISE EXCEPTION 'a count is compared with the declaration by the database: its difference and its variance are that comparison' USING ERRCODE = '23514';
    END IF;
    IF OLD.physical_count IS NULL THEN
      NEW.counted_at := pg_catalog.clock_timestamp();
    END IF;
  END IF;

  -- The System's move out of COUNTED: a count with a variance, a zero declaration or a finding of condition goes to reconciliation and is not cleared for itemization; a clean one is cleared and is not sent to
  -- reconciliation. A photo intake is clean only if, besides, no parcel is missing and no extra stands.
  IF OLD.state = 'COUNTED' AND NEW.state IS DISTINCT FROM OLD.state THEN
    routed_clean := OLD.count_variance IS NOT DISTINCT FROM 'MATCH' AND OLD.rider_declared_count > 0 AND OLD.condition = 'OK';
    IF OLD.receiving_mode = 'PHOTO_CHECK_IN' THEN
      SELECT * INTO facts FROM melarc.intake_parcel_facts(NEW.id);
      routed_clean := routed_clean AND facts.missing = 0 AND facts.extras = 0;
    END IF;
    IF NOT routed_clean THEN
      IF NEW.state = 'READY_FOR_ITEMIZATION' THEN
        RAISE EXCEPTION 'a count with a variance, a zero declaration or a finding is not cleared for itemization' USING ERRCODE = '23514';
      END IF;
    ELSIF NEW.state = 'RECONCILIATION_REQUIRED' THEN
      RAISE EXCEPTION 'a clean count is not sent to reconciliation' USING ERRCODE = '23514';
    END IF;
  END IF;

  -- A count that changes after it was made (Run D): a senior's correction routes the intake again by the same rule, and a found parcel or an extra changes the count of an intake in reconciliation and
  -- leaves it there (a senior closes the case even when nothing is missing any more).
  IF OLD.physical_count IS NOT NULL AND count_moved THEN
    routed_clean := NEW.count_variance IS NOT DISTINCT FROM 'MATCH' AND NEW.rider_declared_count > 0 AND NEW.condition = 'OK';
    IF NEW.receiving_mode = 'PHOTO_CHECK_IN' THEN
      SELECT * INTO facts FROM melarc.intake_parcel_facts(NEW.id);
      routed_clean := routed_clean AND facts.missing = 0 AND facts.extras = 0;
    END IF;
    IF reversal THEN
      NULL;
    ELSIF act_key = 'hub.osd.adjudicate' THEN
      IF NEW.state IS DISTINCT FROM (CASE WHEN routed_clean THEN 'READY_FOR_ITEMIZATION' ELSE 'RECONCILIATION_REQUIRED' END) THEN
        RAISE EXCEPTION 'a correction routes the intake again: cleared for itemization when it is clean, in reconciliation when it is not' USING ERRCODE = '23514';
      END IF;
    ELSIF OLD.state <> 'RECONCILIATION_REQUIRED' OR NEW.state IS DISTINCT FROM OLD.state THEN
      RAISE EXCEPTION 'a parcel that is found, or an extra, changes the count of an intake in reconciliation and leaves it there' USING ERRCODE = '23514';
    END IF;
  END IF;

  -- The condition (S1.34; state-machines.md section 7). It is found after the count and before itemization starts, for every writer: an intake that is being itemized or is closed keeps the condition it has. A
  -- photo intake's parcel may have a condition found while the vendor's check-in is open (never to put it back to OK). An intake cleared for itemization goes back to reconciliation only with a condition that is
  -- not OK (the finding that sends it) or with a count that a correction changed.
  IF NEW.condition IS DISTINCT FROM OLD.condition THEN
    IF OLD.state IN ('READY_FOR_ITEMIZATION', 'RECONCILIATION_REQUIRED') THEN
      NULL;
    ELSIF OLD.state = 'AWAITING_COUNT' AND OLD.receiving_mode = 'PHOTO_CHECK_IN' AND NEW.condition <> 'OK' THEN
      NULL;
    ELSE
      RAISE EXCEPTION 'a condition is found after the count and before itemization starts' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF OLD.state = 'READY_FOR_ITEMIZATION' AND NEW.state = 'RECONCILIATION_REQUIRED' AND NEW.condition = 'OK' AND NOT count_moved THEN
    RAISE EXCEPTION 'an intake cleared for itemization goes back to reconciliation for a condition that is not OK' USING ERRCODE = '23514';
  END IF;

  -- The receive lock (S1.32; state-machines.md section 7, "acquire receive lock"). A lock that is taken, kept or refreshed is for an intake that is waiting for its count, before and after the write.
  -- Another receiver takes a held lock over only after the idle time of the hub on the database's clock, and a hub that has none (or none that is usable) offers no takeover. The moment is the
  -- database's, whatever the writer gave. Clearing the lock (both columns null, which the check of the table keeps together) is not judged here: the count that follows, or an operator, may release it. Run D:
  -- the moment the CURRENT holder first took the lock (lock_opened_at) is given with the lock, kept through the holder's own refreshes, and never a writer's.
  IF NEW.active_receiver_id IS DISTINCT FROM OLD.active_receiver_id OR NEW.lock_acquired_at IS DISTINCT FROM OLD.lock_acquired_at THEN
    IF NEW.active_receiver_id IS NOT NULL THEN
      IF OLD.state <> 'AWAITING_COUNT' OR NEW.state <> 'AWAITING_COUNT' THEN
        RAISE EXCEPTION 'the receive lock is taken on an intake that is waiting for its count' USING ERRCODE = '23514';
      END IF;
      IF OLD.active_receiver_id IS NOT NULL AND NEW.active_receiver_id IS DISTINCT FROM OLD.active_receiver_id THEN
        idle_minutes := melarc.intake_lock_idle_ttl_minutes(NEW.responsible_hub_id);
        IF idle_minutes IS NULL OR OLD.lock_acquired_at > pg_catalog.clock_timestamp() - pg_catalog.make_interval(mins => idle_minutes) THEN
          RAISE EXCEPTION 'the receive lock of another receiver is taken over only after it has been idle for the time of the hub' USING ERRCODE = '23514';
        END IF;
      END IF;
      NEW.lock_acquired_at := pg_catalog.clock_timestamp();
      IF OLD.active_receiver_id IS NULL OR OLD.active_receiver_id IS DISTINCT FROM NEW.active_receiver_id THEN
        NEW.lock_opened_at := NEW.lock_acquired_at;
      ELSE
        NEW.lock_opened_at := coalesce(OLD.lock_opened_at, OLD.lock_acquired_at);
      END IF;
    ELSE
      NEW.lock_opened_at := NULL;
    END IF;
  ELSE
    NEW.lock_opened_at := OLD.lock_opened_at;
  END IF;
  RETURN NEW;
END
$$;

--> statement-breakpoint
ALTER FUNCTION melarc.pickup_intake_guard() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.pickup_intake_guard() FROM PUBLIC;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION melarc.amend_request_payer(p_request uuid, p_payer jsonb, p_version integer) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  req public.pickup_request%ROWTYPE;
BEGIN
  IF melarc.principal_type() NOT IN ('STAFF', 'VENDOR')
     OR coalesce(pg_catalog.current_setting('melarc.authorization_key', true), '') <> 'pickup.request.create' THEN
    RAISE EXCEPTION 'a request is amended by the vendor that owns it or by the staff of its hub' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO req FROM public.pickup_request AS r WHERE r.id = p_request FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'there is no such request for the caller' USING ERRCODE = '42501';
  END IF;
  IF req.version <> p_version THEN
    RAISE EXCEPTION 'the request has changed since it was read' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT', HINT = 'rule=stale';
  END IF;
  IF melarc.principal_type() = 'VENDOR' AND req.state <> 'PENDING' THEN
    RAISE EXCEPTION 'a vendor amends only a pending request of its own' USING ERRCODE = '23514', DETAIL = 'reason=PERMISSION_DENIED';
  END IF;
  IF req.state NOT IN ('PENDING', 'CONFIRMED') THEN
    RAISE EXCEPTION 'only a pending or a confirmed request is amended' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT', HINT = 'rule=request_closed';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public."order" AS o JOIN public.pickup_intake AS i ON i.id = o.pickup_intake_id
     WHERE i.pickup_request_id = p_request AND o.locked_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'the price is frozen: the same edit is now a correction of the order' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT', HINT = 'rule=price_frozen';
  END IF;
  -- The run having started no longer stops this edit: it changes who pays and moves no rider (the review of 19 November 2026, finding C). What stops it is the freeze of the first order of the request, and an
  -- intake that is closed.
  IF EXISTS (SELECT 1 FROM public.pickup_intake AS i WHERE i.pickup_request_id = p_request AND i.state = 'CLOSED') THEN
    RAISE EXCEPTION 'the intake of the request is closed' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT', HINT = 'rule=intake_closed';
  END IF;
  UPDATE public.pickup_request
     SET default_payer_intent = p_payer ->> 'payer_intent',
         split_basis = p_payer ->> 'split_basis',
         split_sender_amount_minor = (p_payer ->> 'split_sender_amount_minor')::integer,
         split_sender_percentage = (p_payer ->> 'split_sender_percentage')::numeric
   WHERE id = p_request;
END
$$;

--> statement-breakpoint
ALTER FUNCTION melarc.amend_request_payer(uuid, jsonb, integer) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.amend_request_payer(uuid, jsonb, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.amend_request_payer(uuid, jsonb, integer) TO melarc_api_runtime;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION melarc.freeze_orders(p_intake uuid) RETURNS TABLE (order_id uuid, locked_price_minor integer, commercial_state text, sender_minor integer, recipient_minor integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  held public.pickup_intake%ROWTYPE;
  each_order record;
  confirmed_any boolean := false;
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
    confirmed_any := true;
    SELECT o.commercial_state, (o.payer_allocation ->> 'sender_minor')::integer, (o.payer_allocation ->> 'recipient_minor')::integer
      INTO commercial_state, sender_minor, recipient_minor FROM public."order" AS o WHERE o.id = each_order.id;
    RETURN NEXT;
  END LOOP;
  -- An intake whose first order is confirmed is being itemized (OB-S1-142): the state says what the work is. An intake in reconciliation stays there.
  IF confirmed_any AND held.state = 'READY_FOR_ITEMIZATION' THEN
    UPDATE public.pickup_intake SET state = 'ITEMIZING' WHERE id = p_intake;
  END IF;
  RETURN;
END
$$;

--> statement-breakpoint
ALTER FUNCTION melarc.freeze_orders(uuid) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.freeze_orders(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.freeze_orders(uuid) TO melarc_api_runtime;

--> statement-breakpoint
-- AMENDING AN ORDER THAT IS NOT YET CONFIRMED: as the owner, for an order of the hubs of the grant, under the key that itemizes. The intake is locked first (as an order is made), then the order, and the version the
-- officer read and the freeze are judged after both locks are held. The record is written first, the order and its commitment second, and the guards of both repeat every rule.
CREATE FUNCTION melarc.amend_order(p_order uuid, p_version integer, p_amendment uuid, p_note text, p_facts jsonb)
RETURNS TABLE (new_version integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  ord public."order"%ROWTYPE;
  held public.pickup_intake%ROWTYPE;
  parcel_state text;
  old_json jsonb;
  new_json jsonb;
  changed_before jsonb;
  changed_after jsonb;
  commitment jsonb;
BEGIN
  IF melarc.principal_type() IS DISTINCT FROM 'STAFF'
     OR coalesce(pg_catalog.current_setting('melarc.authorization_key', true), '') <> 'hub.intake.itemize' THEN
    RAISE EXCEPTION 'an order is amended by an officer of the hub holding the key to itemize, and by nobody else' USING ERRCODE = '42501';
  END IF;
  IF p_note IS NULL OR pg_catalog.btrim(p_note) = '' THEN
    RAISE EXCEPTION 'an amendment says why' USING ERRCODE = '23514', DETAIL = 'reason=REASON_REQUIRED';
  END IF;
  IF p_facts IS NULL OR pg_catalog.jsonb_typeof(p_facts) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'an order is amended from the facts of its parcel' USING ERRCODE = '22023';
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
  IF ord.locked_at IS NOT NULL THEN
    RAISE EXCEPTION 'an order whose price is frozen is confirmed: its payer arrangement is a correction and a mistaken arrival is a reversal' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT', HINT = 'rule=order_confirmed';
  END IF;
  IF held.state = 'CLOSED' THEN
    RAISE EXCEPTION 'an order of a closed intake is not amended' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT', HINT = 'rule=intake_closed';
  END IF;
  IF ord.intake_parcel_id IS NOT NULL THEN
    SELECT p.state INTO parcel_state FROM public.intake_parcel AS p WHERE p.id = ord.intake_parcel_id;
    IF parcel_state = 'MISSING' THEN
      RAISE EXCEPTION 'a parcel that is missing is never priced or dispatched' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT', HINT = 'rule=parcel_missing';
    ELSIF parcel_state = 'VOID' THEN
      RAISE EXCEPTION 'a parcel taken back has no order' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT', HINT = 'rule=parcel_void';
    END IF;
  END IF;
  commitment := p_facts -> 'commitment';
  old_json := melarc.order_editable(ord);
  new_json := (SELECT pg_catalog.jsonb_object_agg(e.key, e.value) FROM pg_catalog.jsonb_each(p_facts - 'commitment') AS e);
  -- The officer who judges the size is the officer who changes it, and no other (the judgement is kept when it is not changed).
  IF (new_json ->> 'size_class') IS DISTINCT FROM ord.size_class THEN
    new_json := new_json || pg_catalog.jsonb_build_object('size_class_selected_by', melarc.current_principal_id());
  ELSE
    new_json := new_json || pg_catalog.jsonb_build_object('size_class_selected_by', ord.size_class_selected_by);
  END IF;
  -- Whether the order has its own payer arrangement follows from the one it is given.
  new_json := new_json || pg_catalog.jsonb_build_object('payer_override_applied', (NULLIF(p_facts -> 'payer_override', 'null'::jsonb) IS NOT NULL));
  IF (SELECT pg_catalog.array_agg(k ORDER BY k) FROM pg_catalog.jsonb_object_keys(new_json) AS k) IS DISTINCT FROM (SELECT pg_catalog.array_agg(k ORDER BY k) FROM pg_catalog.jsonb_object_keys(old_json) AS k) THEN
    RAISE EXCEPTION 'an amendment restates every member of what was transcribed, and no other' USING ERRCODE = '22023';
  END IF;
  SELECT pg_catalog.jsonb_object_agg(n.key, old_json -> n.key), pg_catalog.jsonb_object_agg(n.key, n.value) INTO changed_before, changed_after
    FROM pg_catalog.jsonb_each(new_json) AS n WHERE (old_json -> n.key) IS DISTINCT FROM n.value;
  IF changed_after IS NULL THEN
    RAISE EXCEPTION 'an amendment changes something' USING ERRCODE = '23514', DETAIL = 'reason=VALIDATION_FAILED', HINT = 'rule=no_change';
  END IF;
  INSERT INTO public.order_amendment (id, order_id, responsible_hub_id, amended_by, order_version, note, before, after)
  VALUES (p_amendment, p_order, ord.responsible_hub_id, melarc.current_principal_id(), p_version, pg_catalog.btrim(p_note), changed_before, changed_after);
  UPDATE public."order" SET
    recipient = p_facts -> 'recipient',
    destination_zone_snapshot = p_facts -> 'destination_zone_snapshot',
    destination_zone_resolution = p_facts ->> 'destination_zone_resolution',
    declared_value_minor = (p_facts ->> 'declared_value_minor')::integer,
    is_serialized_goods = coalesce((p_facts ->> 'is_serialized_goods')::boolean, false),
    serial_imei = p_facts ->> 'serial_imei',
    requested_delivery_date = (p_facts ->> 'requested_delivery_date')::date,
    derived_delivery_date = (p_facts ->> 'derived_delivery_date')::date,
    size_class = p_facts ->> 'size_class',
    size_class_selected_by = (new_json ->> 'size_class_selected_by')::uuid,
    carrier_cost_minor = (p_facts ->> 'carrier_cost_minor')::integer,
    carrier_waybill_evidence_id = (p_facts ->> 'carrier_waybill_evidence_id')::uuid,
    is_high_value = coalesce((p_facts ->> 'is_high_value')::boolean, false),
    high_value_evidence_ids = ARRAY(SELECT pg_catalog.jsonb_array_elements_text(p_facts -> 'high_value_evidence_ids'))::uuid[],
    lane = p_facts ->> 'lane',
    commercial_mode = p_facts ->> 'commercial_mode',
    payer_override = NULLIF(p_facts -> 'payer_override', 'null'::jsonb),
    payer_override_applied = (NULLIF(p_facts -> 'payer_override', 'null'::jsonb) IS NOT NULL),
    price_components_snapshot = p_facts -> 'price_components_snapshot'
   WHERE id = p_order;
  UPDATE public.delivery_commitment SET
    default_date = (commitment ->> 'default_date')::date,
    requested_date = (commitment ->> 'requested_date')::date,
    committed_date = (commitment ->> 'committed_date')::date,
    committed_window_start = (commitment ->> 'window_start')::time,
    committed_window_end = (commitment ->> 'window_end')::time
   WHERE order_id = p_order AND sequence = 1 AND superseded_at IS NULL;
  RETURN QUERY SELECT o.version FROM public."order" AS o WHERE o.id = p_order;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.amend_order(uuid, integer, uuid, text, jsonb) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.amend_order(uuid, integer, uuid, text, jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.amend_order(uuid, integer, uuid, text, jsonb) TO melarc_api_runtime;
--> statement-breakpoint
-- REVERSING THE ARRIVAL OF A PARCEL WHOSE ORDER IS CONFIRMED: as the owner, for an order of the hubs of the grant, under the key of the adjudication, with a reason in words. The intake is locked first, then the
-- order, then the parcel; the record is written first, the order moves to REVERSED, the parcel to MISSING or VOID, the count is recomputed from the parcels as correct_intake_count does, and the intake is
-- sent to reconciliation. The guards of the four tables repeat every rule and accept these moves only beside the record of this transaction.
CREATE FUNCTION melarc.reverse_order_arrival(p_order uuid, p_version integer, p_reversal uuid, p_note text)
RETURNS TABLE (intake_id uuid, previous_intake_state text, resulting_intake_state text, parcel_id uuid, resulting_parcel_state text, old_received integer, new_received integer, previous_commercial_state text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  ord public."order"%ROWTYPE;
  held public.pickup_intake%ROWTYPE;
  parcel public.intake_parcel%ROWTYPE;
  facts record;
  target text;
  new_count integer;
  difference integer;
  compared text;
BEGIN
  IF melarc.principal_type() IS DISTINCT FROM 'STAFF'
     OR coalesce(pg_catalog.current_setting('melarc.authorization_key', true), '') <> 'hub.osd.adjudicate' THEN
    RAISE EXCEPTION 'an arrival is reversed by Senior Ops holding the key of the adjudication, and by nobody else' USING ERRCODE = '42501';
  END IF;
  IF p_note IS NULL OR pg_catalog.btrim(p_note) = '' THEN
    RAISE EXCEPTION 'a reversal says why' USING ERRCODE = '23514', DETAIL = 'reason=REASON_REQUIRED';
  END IF;
  SELECT i.* INTO held FROM public.pickup_intake AS i
   WHERE i.id = (SELECT o.pickup_intake_id FROM public."order" AS o WHERE o.id = p_order) FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'there is no such order in the adjudicator''s hubs' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO ord FROM public."order" AS o WHERE o.id = p_order FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'there is no such order in the adjudicator''s hubs' USING ERRCODE = '42501';
  END IF;
  IF ord.version <> p_version THEN
    RAISE EXCEPTION 'the order has changed since it was read' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT', HINT = 'rule=stale';
  END IF;
  IF ord.commercial_state = 'REVERSED' THEN
    RAISE EXCEPTION 'the order is already reversed' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT', HINT = 'rule=already_reversed';
  END IF;
  IF ord.locked_at IS NULL THEN
    RAISE EXCEPTION 'an order that is not confirmed is amended, and has no arrival to reverse' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT', HINT = 'rule=order_not_confirmed';
  END IF;
  IF ord.commercial_state NOT IN ('PRICED', 'NO_VENDOR_CHARGE', 'PAYMENT_REQUIRED') THEN
    RAISE EXCEPTION 'an order that has been paid for or reserved is not reversed here' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT', HINT = 'rule=order_progressed';
  END IF;
  IF ord.fulfilment_state <> 'AWAITING_RECIPIENT_CONFIRMATION' OR ord.delivery_attempt_count > 0 THEN
    RAISE EXCEPTION 'an order that has been dispatched is not reversed here' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT', HINT = 'rule=order_dispatched';
  END IF;
  IF EXISTS (SELECT 1 FROM public.payer_correction AS c WHERE c.order_id = p_order AND c.state = 'REQUESTED') THEN
    RAISE EXCEPTION 'an order with a payer correction waiting for a decision is not reversed' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT', HINT = 'rule=correction_open';
  END IF;
  IF held.state = 'CLOSED' THEN
    RAISE EXCEPTION 'an order of a closed intake is not reversed' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT', HINT = 'rule=intake_closed';
  END IF;
  IF held.state NOT IN ('READY_FOR_ITEMIZATION', 'ITEMIZING', 'RECONCILIATION_REQUIRED') THEN
    RAISE EXCEPTION 'the intake is not in a state in which an order stands' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT', HINT = 'rule=intake_not_ready';
  END IF;
  IF ord.intake_parcel_id IS NULL THEN
    RAISE EXCEPTION 'an intake that is counted blind has no parcel whose arrival is reversed' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT', HINT = 'rule=blind_count_intake';
  END IF;
  SELECT * INTO parcel FROM public.intake_parcel AS p WHERE p.id = ord.intake_parcel_id FOR UPDATE;
  IF NOT FOUND OR parcel.state <> 'ARRIVED' THEN
    RAISE EXCEPTION 'the arrival that is reversed is the arrival of a parcel that is there' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT', HINT = 'rule=parcel_not_arrived';
  END IF;
  target := CASE parcel.origin WHEN 'DOOR_PHOTO' THEN 'MISSING' ELSE 'VOID' END;
  INSERT INTO public.order_reversal (id, order_id, intake_parcel_id, pickup_intake_id, responsible_hub_id, reversed_by, order_version, previous_commercial_state, previous_parcel_state, resulting_parcel_state, note)
  VALUES (p_reversal, p_order, parcel.id, held.id, ord.responsible_hub_id, melarc.current_principal_id(), p_version, ord.commercial_state, parcel.state, target, pg_catalog.btrim(p_note));
  UPDATE public."order" SET commercial_state = 'REVERSED' WHERE id = p_order;
  UPDATE public.intake_parcel SET state = target WHERE id = parcel.id;
  SELECT * INTO facts FROM melarc.intake_parcel_facts(held.id);
  new_count := facts.arrived;
  difference := new_count - facts.expected;
  compared := CASE WHEN difference = 0 THEN 'MATCH' WHEN difference < 0 THEN 'SHORT' ELSE 'OVER' END;
  UPDATE public.pickup_intake SET physical_count = new_count, count_difference = difference, count_variance = compared, state = 'RECONCILIATION_REQUIRED' WHERE id = held.id;
  RETURN QUERY SELECT held.id, held.state, 'RECONCILIATION_REQUIRED'::text, parcel.id, target, held.physical_count, new_count, ord.commercial_state;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.reverse_order_arrival(uuid, integer, uuid, text) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.reverse_order_arrival(uuid, integer, uuid, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.reverse_order_arrival(uuid, integer, uuid, text) TO melarc_api_runtime;
--> statement-breakpoint
-- THE PAYER ARRANGEMENT AS IT STANDS, resolved into portions of a total (the preview an officer reads before confirming): the order's own override when it is given, else the request's, by the arithmetic of the
-- freeze, and the state the commercial gate would take the order to (zero is tested first). Nothing is written.
CREATE FUNCTION melarc.payer_preview(p_intake uuid, p_total integer, p_override jsonb)
RETURNS TABLE (source text, payer_intent text, sender_minor integer, recipient_minor integer, commercial_state text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  req public.pickup_request%ROWTYPE;
  proposed jsonb;
  sender integer;
BEGIN
  IF melarc.principal_type() IS DISTINCT FROM 'STAFF'
     OR coalesce(pg_catalog.current_setting('melarc.authorization_key', true), '') <> 'hub.intake.itemize' THEN
    RAISE EXCEPTION 'the payer arrangement is previewed by an officer of the hub holding the key to itemize, and by nobody else' USING ERRCODE = '42501';
  END IF;
  IF p_total IS NULL OR p_total < 0 THEN
    RAISE EXCEPTION 'a preview is of a total of pesewas, zero or more' USING ERRCODE = '22023';
  END IF;
  SELECT r.* INTO req FROM public.pickup_request AS r JOIN public.pickup_intake AS i ON i.pickup_request_id = r.id WHERE i.id = p_intake;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF p_override IS NOT NULL AND pg_catalog.jsonb_typeof(p_override) = 'object' THEN
    source := 'ORDER';
    proposed := p_override;
  ELSE
    source := 'REQUEST';
    proposed := pg_catalog.jsonb_build_object('payer_intent', req.default_payer_intent, 'split_basis', req.split_basis,
                                              'split_sender_amount_minor', req.split_sender_amount_minor, 'split_sender_percentage', req.split_sender_percentage);
  END IF;
  sender := melarc.payer_portion(p_total, proposed);
  IF sender IS NULL OR sender < 0 THEN
    RAISE EXCEPTION 'the payer arrangement cannot be resolved into portions of the price' USING ERRCODE = '23514', DETAIL = 'reason=VALIDATION_FAILED', HINT = 'rule=unresolvable';
  END IF;
  payer_intent := proposed ->> 'payer_intent';
  sender_minor := sender;
  recipient_minor := p_total - sender;
  commercial_state := CASE WHEN sender = 0 THEN 'NO_VENDOR_CHARGE' ELSE 'PAYMENT_REQUIRED' END;
  RETURN NEXT;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.payer_preview(uuid, integer, jsonb) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.payer_preview(uuid, integer, jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.payer_preview(uuid, integer, jsonb) TO melarc_api_runtime;

--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.order_amended_here(uuid, integer) TO melarc_api_runtime;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.order_reversed_here(uuid) TO melarc_api_runtime;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.parcel_reversed_here(uuid, text) TO melarc_api_runtime;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.intake_reversed_here(uuid) TO melarc_api_runtime;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.order_editable(public."order") TO melarc_api_runtime;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.order_fixed(public."order") TO melarc_api_runtime;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.order_content_check(public."order", uuid) TO melarc_api_runtime;
