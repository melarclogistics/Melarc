-- WHAT THE EXTERNAL REVIEW OF 20 NOVEMBER 2026 FOUND, AS THE DATABASE HOLDS IT (findings 2, 4, 5 and 6; the owner's decisions OB-S1-152 and -154).
--
--   * FINDING 4, THE OFFICER'S FLAG AND THE DECLARATION'S, APART. An order is high-value because an officer says so or because the declared value is above the first band; the order kept one flag for both, so a
--     declaration that was corrected below the band left the order high-value, with its evidence still required. The officer's own flag is now a member of what was transcribed (`is_high_value_manual`), the
--     other is recomputed by the service whenever the declaration changes, and `is_high_value` stays what the two say together. The guards treat the new member as they treat the rest of what was
--     transcribed: it changes only beside the record of an amendment, and never after the freeze. An order made before this migration has the flag null (it is not known whether the
--     officer's was ever the reason): the service reads one of those that is high-value for no reason its declared value gives as the officer's own, and keeps it; an order made since has it true or false.
--   * FINDING 2, A PAYER EDIT AND THE FIRST FREEZE. The freeze read the request's payer arrangement with a plain read, and the edit locked only the request, so the two could each read the earlier state: the
--     arrangement changed beside an order frozen to the one before. The freeze now takes the row of the request for share (`freeze_order_row`), the edit already takes it for update, and a lock is an UPDATE for a
--     row-level policy, so a policy admits the lock to the keys that freeze and refuses every write by them. `melarc.hold_request_payer` takes the same lock for the service, which calculates what an officer is shown
--     of the payer after it holds the request and before it freezes.
--   * FINDING 3, THE EVIDENCE OF A PREVIEW. `melarc.evidence_citable` is the condition the guard of the order applies to the evidence an order cites, asked before the order is made, so that a preview refuses what
--     the save would refuse.
--   * FINDING 5, THE WORKLIST TELLS ONE STORY. The view of the parcels that are awaited opens every parcel still expected, with an order made early or without; the view of the orders that await payment leaves out
--     a parcel that is missing, as its count does. A blind count that is not committed has received nothing that is known: the counts say so (null) and not zero. The assessment of a close names, with the
--     first hundred outstanding parcels, a digest of every one of them, which the close compares.
--   * OB-S1-152, WHAT A VENDOR READS OF AN ORDER. An order whose arrival was reversed is history of the hub's own: the vendor's read of it is one that does not exist (the staff's is unchanged).
--   * OB-S1-152 (the Platform Admin who decides his own correction). The database asks the decider's own bundle for the tier (as 0032 does for a staff identity) and no longer believes a setting the service writes.
--   * OB-S1-151, THE INTAKES CLOSED WITH THE APPROVED EXCEPTION THAT STILL HAVE WORK LEFT, found by the senior who may close with it (`melarc.closed_intake_exceptions`): a closed intake had no way to be found again.
ALTER TABLE "order" ADD COLUMN "is_high_value_manual" boolean;
--> statement-breakpoint
ALTER TABLE "order" ADD CONSTRAINT "order_manual_flag_is_high_value" CHECK ("order"."is_high_value_manual" IS NOT TRUE OR "order"."is_high_value");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION melarc.order_editable(ord public."order") RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT coalesce(pg_catalog.jsonb_object_agg(e.key, e.value), '{}'::jsonb)
    FROM pg_catalog.jsonb_each(pg_catalog.to_jsonb(ord)) AS e
   WHERE e.key = ANY (ARRAY['recipient', 'destination_zone_snapshot', 'destination_zone_resolution', 'declared_value_minor', 'is_serialized_goods', 'serial_imei', 'requested_delivery_date',
                            'derived_delivery_date', 'size_class', 'size_class_selected_by', 'carrier_cost_minor', 'carrier_waybill_evidence_id', 'is_high_value', 'is_high_value_manual', 'high_value_evidence_ids', 'lane',
                            'commercial_mode', 'payer_override', 'payer_override_applied', 'price_components_snapshot'])
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.order_editable(public."order") OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.order_editable(public."order") FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION melarc.order_fixed(ord public."order") RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT coalesce(pg_catalog.jsonb_object_agg(e.key, e.value), '{}'::jsonb)
    FROM pg_catalog.jsonb_each(pg_catalog.to_jsonb(ord)) AS e
   WHERE e.key <> 'version' AND NOT (e.key = ANY (ARRAY['recipient', 'destination_zone_snapshot', 'destination_zone_resolution', 'declared_value_minor', 'is_serialized_goods', 'serial_imei',
                            'requested_delivery_date', 'derived_delivery_date', 'size_class', 'size_class_selected_by', 'carrier_cost_minor', 'carrier_waybill_evidence_id', 'is_high_value', 'is_high_value_manual',
                            'high_value_evidence_ids', 'lane', 'commercial_mode', 'payer_override', 'payer_override_applied', 'price_components_snapshot']))
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.order_fixed(public."order") OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.order_fixed(public."order") FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION melarc.itemize_order(p_intake uuid, p_facts jsonb)
RETURNS TABLE (order_id uuid, previous_state text, resulting_state text, frozen boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  held public.pickup_intake%ROWTYPE;
  new_order uuid;
  new_commitment uuid;
  parcel_id uuid;
  parcel_state text;
  confirmable boolean;
  commitment jsonb;
BEGIN
  IF melarc.principal_type() IS DISTINCT FROM 'STAFF'
     OR coalesce(pg_catalog.current_setting('melarc.authorization_key', true), '') <> 'hub.intake.itemize' THEN
    RAISE EXCEPTION 'an order is made by an officer of the hub holding the key to itemize, and by nobody else' USING ERRCODE = '42501';
  END IF;
  IF p_intake IS NULL OR p_facts IS NULL OR pg_catalog.jsonb_typeof(p_facts) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'an order is made for an intake from the facts of its parcel' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO held FROM public.pickup_intake AS i WHERE i.id = p_intake FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'there is no such intake in the officer''s hubs' USING ERRCODE = '42501';
  END IF;
  new_order := (p_facts ->> 'order_id')::uuid;
  new_commitment := (p_facts ->> 'initial_commitment_id')::uuid;
  parcel_id := (p_facts ->> 'parcel_id')::uuid;
  commitment := p_facts -> 'commitment';

  INSERT INTO public."order" (
    id, code, pickup_intake_id, responsible_hub_id, intake_parcel_id, vendor_organization_id, ad_hoc_sender_id,
    recipient, origin_zone_snapshot, destination_zone_snapshot, destination_zone_resolution,
    declared_value_minor, is_serialized_goods, serial_imei, service_level, requested_delivery_date, derived_delivery_date,
    size_class, size_class_selected_by, carrier_cost_minor, carrier_waybill_evidence_id, is_high_value, is_high_value_manual, high_value_evidence_ids,
    lane, commercial_mode, payer_override, payer_override_applied, price_components_snapshot, initial_commitment_id, created_by
  ) VALUES (
    new_order, p_facts ->> 'code', p_intake, held.responsible_hub_id, parcel_id, NULL, NULL,
    p_facts -> 'recipient', p_facts -> 'origin_zone_snapshot', p_facts -> 'destination_zone_snapshot', p_facts ->> 'destination_zone_resolution',
    (p_facts ->> 'declared_value_minor')::integer, coalesce((p_facts ->> 'is_serialized_goods')::boolean, false), p_facts ->> 'serial_imei', 'STANDARD',
    (p_facts ->> 'requested_delivery_date')::date, (p_facts ->> 'derived_delivery_date')::date,
    p_facts ->> 'size_class', melarc.current_principal_id(), (p_facts ->> 'carrier_cost_minor')::integer, (p_facts ->> 'carrier_waybill_evidence_id')::uuid,
    coalesce((p_facts ->> 'is_high_value')::boolean, false), coalesce((p_facts ->> 'is_high_value_manual')::boolean, false), ARRAY(SELECT pg_catalog.jsonb_array_elements_text(p_facts -> 'high_value_evidence_ids'))::uuid[],
    p_facts ->> 'lane', p_facts ->> 'commercial_mode', NULLIF(p_facts -> 'payer_override', 'null'::jsonb), (NULLIF(p_facts -> 'payer_override', 'null'::jsonb) IS NOT NULL),
    p_facts -> 'price_components_snapshot', new_commitment, melarc.current_principal_id()
  );
  INSERT INTO public.delivery_commitment (
    id, order_id, responsible_hub_id, sequence, default_date, requested_date, committed_date, committed_window_start, committed_window_end, sla_start_at
  ) VALUES (
    new_commitment, new_order, held.responsible_hub_id, 1, (commitment ->> 'default_date')::date, (commitment ->> 'requested_date')::date, (commitment ->> 'committed_date')::date,
    (commitment ->> 'window_start')::time, (commitment ->> 'window_end')::time, pg_catalog.clock_timestamp()
  );

  IF parcel_id IS NOT NULL THEN
    SELECT p.state INTO parcel_state FROM public.intake_parcel AS p WHERE p.id = parcel_id;
  END IF;
  confirmable := parcel_id IS NULL OR parcel_state = 'ARRIVED';
  IF confirmable THEN
    IF held.state = 'READY_FOR_ITEMIZATION' THEN
      UPDATE public.pickup_intake SET state = 'ITEMIZING' WHERE id = p_intake;
    END IF;
    PERFORM melarc.freeze_order_row(new_order);
  END IF;
  RETURN QUERY SELECT new_order, held.state, (SELECT i.state FROM public.pickup_intake AS i WHERE i.id = p_intake), confirmable;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.itemize_order(uuid, jsonb) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.itemize_order(uuid, jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.itemize_order(uuid, jsonb) TO melarc_api_runtime;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION melarc.amend_order(p_order uuid, p_version integer, p_amendment uuid, p_note text, p_facts jsonb)
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
    is_high_value_manual = coalesce((p_facts ->> 'is_high_value_manual')::boolean, false),
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
  -- The request's payer arrangement is read under a lock that an edit of it takes for update (migration 0115): an edit in flight is waited for and its arrangement is the one read here, and an edit that comes
  -- after finds this freeze and is refused (the review of 20 November 2026, finding 2).
  SELECT r.* INTO req FROM public.pickup_request AS r JOIN public.pickup_intake AS i ON i.pickup_request_id = r.id WHERE i.id = ord.pickup_intake_id FOR SHARE OF r;
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
-- A lock is an UPDATE for a row-level policy (as 0113 says of the order): the keys that freeze may lock the request, in the hubs of their grant, and write nothing of it.
CREATE POLICY "pickup_request_freeze_lock" ON "pickup_request" FOR UPDATE USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_user = 'melarc_owner' AND coalesce(current_setting('melarc.authorization_key', true), '') IN ('hub.intake.itemize', 'hub.intake.count', 'hub.osd.adjudicate')
      AND (melarc.hub_scope_mode() = 'ALL' OR "pickup_request"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
) WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN false
    ELSE false
  END
);
--> statement-breakpoint
-- THE REQUEST'S PAYER, HELD FOR WHAT THE OFFICER IS ABOUT TO CONFIRM: the service calls it after the intake's lock and before it calculates who pays each amount, so that what the officer is shown and
-- what the freeze reads are one arrangement. The lock is the one the freeze takes; it is held to the end of the transaction.
CREATE FUNCTION melarc.hold_request_payer(p_intake uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  held uuid;
BEGIN
  IF melarc.principal_type() IS DISTINCT FROM 'STAFF'
     OR coalesce(pg_catalog.current_setting('melarc.authorization_key', true), '') <> 'hub.intake.itemize' THEN
    RAISE EXCEPTION 'the payer of a request is held by an officer of the hub holding the key to itemize, and by nobody else' USING ERRCODE = '42501';
  END IF;
  SELECT r.id INTO held FROM public.pickup_request AS r JOIN public.pickup_intake AS i ON i.pickup_request_id = r.id WHERE i.id = p_intake FOR SHARE OF r;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'there is no such intake in the officer''s hubs' USING ERRCODE = '42501';
  END IF;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.hold_request_payer(uuid) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.hold_request_payer(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.hold_request_payer(uuid) TO melarc_api_runtime;
--> statement-breakpoint
-- THE EVIDENCE AN ORDER MAY CITE, ASKED BEFORE THE ORDER IS MADE: the condition of `melarc.order_content_check` (0115), word for word, for a preview. Each piece is cited once, is stored, is the intake's own, is of the
-- purpose of an itemization and is in the intake's hub. Keep the two together.
CREATE FUNCTION melarc.evidence_citable(p_intake uuid, p_cited uuid[]) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  hub uuid;
  stored integer;
BEGIN
  IF melarc.principal_type() IS DISTINCT FROM 'STAFF'
     OR coalesce(pg_catalog.current_setting('melarc.authorization_key', true), '') <> 'hub.intake.itemize' THEN
    RAISE EXCEPTION 'the evidence of an order is judged for an officer of the hub holding the key to itemize, and for nobody else' USING ERRCODE = '42501';
  END IF;
  SELECT i.responsible_hub_id INTO hub FROM public.pickup_intake AS i WHERE i.id = p_intake;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'there is no such intake in the officer''s hubs' USING ERRCODE = '42501';
  END IF;
  IF p_cited IS NULL OR pg_catalog.cardinality(p_cited) = 0 THEN
    RETURN;
  END IF;
  IF (SELECT pg_catalog.count(DISTINCT e) FROM pg_catalog.unnest(p_cited) AS e) <> pg_catalog.cardinality(p_cited) THEN
    RAISE EXCEPTION 'an order cites each piece of evidence once' USING ERRCODE = '23514', DETAIL = 'reason=VALIDATION_FAILED', HINT = 'rule=evidence_once';
  END IF;
  SELECT pg_catalog.count(*) INTO stored FROM public.evidence AS v
   WHERE v.id = ANY (p_cited) AND v.state = 'STORED' AND v.owner_type = 'PICKUP_INTAKE' AND v.owner_id = p_intake
     AND v.responsible_hub_id = hub AND v.purpose = 'ITEMIZATION';
  IF stored <> pg_catalog.cardinality(p_cited) THEN
    RAISE EXCEPTION 'an order cites evidence that is stored and is the intake''s own' USING ERRCODE = '23514', DETAIL = 'reason=EVIDENCE_NOT_STORED';
  END IF;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.evidence_citable(uuid, uuid[]) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.evidence_citable(uuid, uuid[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.evidence_citable(uuid, uuid[]) TO melarc_api_runtime;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION melarc.intake_worklist(p_intake uuid, p_view text, p_after_n bigint, p_after_id uuid, p_limit integer)
RETURNS TABLE (n bigint, row_id uuid, parcel_id uuid, parcel_ordinal integer, parcel_origin text, parcel_state text, door_photo_evidence_id uuid, hub_photo_evidence_id uuid,
               order_id uuid, order_code text, recipient_name text, service_area text, size_class text, commercial_state text, order_confirmed boolean, payment_required boolean, work_state text,
               reversed_order_id uuid, reversed_order_code text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
BEGIN
  IF melarc.principal_type() IS DISTINCT FROM 'STAFF'
     OR coalesce(pg_catalog.current_setting('melarc.authorization_key', true), '') <> 'hub.read' THEN
    RAISE EXCEPTION 'the worklist of an intake is read by staff that read intakes, and by nobody else' USING ERRCODE = '42501';
  END IF;
  IF p_view IS NULL OR p_view NOT IN ('all', 'needs_order', 'awaiting_arrival', 'prepared', 'itemized', 'payment_required', 'missing') OR p_limit IS NULL OR p_limit < 1 THEN
    RAISE EXCEPTION 'the worklist takes a view and a limit of one or more' USING ERRCODE = '22023';
  END IF;
  IF (p_after_n IS NULL) <> (p_after_id IS NULL) THEN
    RAISE EXCEPTION 'a position in the worklist is a place and a row together' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
    SELECT w.n, w.row_id, w.parcel_id, w.parcel_ordinal, w.parcel_origin, w.parcel_state, w.door_photo_evidence_id, w.hub_photo_evidence_id, w.order_id, w.order_code, w.recipient_name,
           w.service_area, w.size_class, w.commercial_state, w.order_confirmed, w.payment_required, w.work_state, w.reversed_order_id, w.reversed_order_code
      FROM (
        SELECT x.*,
               CASE WHEN x.parcel_state = 'MISSING' THEN 'MISSING'
                    WHEN x.order_id IS NULL THEN CASE x.parcel_state WHEN 'EXPECTED' THEN 'AWAITING_ARRIVAL' ELSE 'NEEDS_ORDER' END
                    WHEN NOT x.order_confirmed THEN 'PREPARED'
                    ELSE 'ITEMIZED' END AS work_state
          FROM (
            SELECT p.ordinal::bigint AS n, p.id AS row_id, p.id AS parcel_id, p.ordinal AS parcel_ordinal, p.origin AS parcel_origin, p.state AS parcel_state,
                   p.door_photo_evidence_id, p.hub_photo_evidence_id,
                   o.id AS order_id, o.code AS order_code, o.recipient ->> 'name' AS recipient_name,
                   coalesce(o.destination_zone_snapshot ->> 'service_area', o.destination_zone_snapshot ->> 'scope') AS service_area,
                   o.size_class, o.commercial_state, coalesce(o.locked_at IS NOT NULL, false) AS order_confirmed, coalesce(o.commercial_state = 'PAYMENT_REQUIRED', false) AS payment_required,
                   (SELECT r.id FROM public."order" AS r WHERE r.intake_parcel_id = p.id AND r.commercial_state = 'REVERSED' ORDER BY r.created_at DESC, r.id DESC LIMIT 1) AS reversed_order_id,
                   (SELECT r.code FROM public."order" AS r WHERE r.intake_parcel_id = p.id AND r.commercial_state = 'REVERSED' ORDER BY r.created_at DESC, r.id DESC LIMIT 1) AS reversed_order_code
              FROM public.intake_parcel AS p
              -- An order that was reversed is history: the parcel's order is the one that stands (a parcel that is found again is ordered afresh).
              LEFT JOIN public."order" AS o ON o.intake_parcel_id = p.id AND o.commercial_state IS DISTINCT FROM 'REVERSED'
             WHERE p.pickup_intake_id = p_intake AND p.state <> 'VOID'
            UNION ALL
            SELECT pg_catalog.row_number() OVER (ORDER BY o.created_at, o.id), o.id, NULL::uuid, NULL::integer, NULL::text, NULL::text, NULL::uuid, NULL::uuid,
                   o.id, o.code, o.recipient ->> 'name',
                   coalesce(o.destination_zone_snapshot ->> 'service_area', o.destination_zone_snapshot ->> 'scope'),
                   o.size_class, o.commercial_state, coalesce(o.locked_at IS NOT NULL, false), coalesce(o.commercial_state = 'PAYMENT_REQUIRED', false), NULL::uuid, NULL::text
              FROM public."order" AS o
             WHERE o.pickup_intake_id = p_intake AND o.intake_parcel_id IS NULL
          ) AS x
      ) AS w
     WHERE (p_view = 'all'
            OR (p_view = 'needs_order' AND w.work_state = 'NEEDS_ORDER')
            OR (p_view = 'awaiting_arrival' AND w.parcel_state = 'EXPECTED')
            OR (p_view = 'prepared' AND w.work_state = 'PREPARED')
            OR (p_view = 'itemized' AND w.work_state = 'ITEMIZED')
            OR (p_view = 'payment_required' AND w.payment_required AND w.work_state <> 'MISSING')
            OR (p_view = 'missing' AND w.work_state = 'MISSING'))
       AND (p_after_n IS NULL OR (w.n, w.row_id) > (p_after_n, p_after_id))
     ORDER BY w.n, w.row_id
     LIMIT p_limit;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.intake_worklist(uuid, text, bigint, uuid, integer) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.intake_worklist(uuid, text, bigint, uuid, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.intake_worklist(uuid, text, bigint, uuid, integer) TO melarc_api_runtime;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION melarc.intake_progress(p_intake uuid)
RETURNS TABLE (state text, receiving_mode text, received integer, awaiting_arrival integer, needs_order integer, prepared integer, itemized integer, payment_required integer, missing integer, orders integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  held public.pickup_intake%ROWTYPE;
BEGIN
  IF melarc.principal_type() IS DISTINCT FROM 'STAFF'
     OR coalesce(pg_catalog.current_setting('melarc.authorization_key', true), '') <> 'hub.read' THEN
    RAISE EXCEPTION 'the progress of an intake is read by staff that read intakes, and by nobody else' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO held FROM public.pickup_intake AS i WHERE i.id = p_intake;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  state := held.state;
  receiving_mode := held.receiving_mode;
  IF held.receiving_mode = 'PHOTO_CHECK_IN' THEN
    SELECT (pg_catalog.count(*) FILTER (WHERE p.state = 'ARRIVED'))::integer,
           (pg_catalog.count(*) FILTER (WHERE p.state = 'EXPECTED'))::integer,
           (pg_catalog.count(*) FILTER (WHERE p.state = 'ARRIVED' AND o.id IS NULL))::integer,
           (pg_catalog.count(*) FILTER (WHERE o.id IS NOT NULL AND o.locked_at IS NULL AND p.state IN ('EXPECTED', 'ARRIVED')))::integer,
           (pg_catalog.count(*) FILTER (WHERE o.locked_at IS NOT NULL AND p.state = 'ARRIVED'))::integer,
           (pg_catalog.count(*) FILTER (WHERE o.commercial_state = 'PAYMENT_REQUIRED' AND p.state = 'ARRIVED'))::integer,
           (pg_catalog.count(*) FILTER (WHERE p.state = 'MISSING'))::integer,
           (pg_catalog.count(*) FILTER (WHERE o.id IS NOT NULL AND p.state IN ('EXPECTED', 'ARRIVED')))::integer
      INTO received, awaiting_arrival, needs_order, prepared, itemized, payment_required, missing, orders
      FROM public.intake_parcel AS p
      LEFT JOIN public."order" AS o ON o.intake_parcel_id = p.id AND o.commercial_state IS DISTINCT FROM 'REVERSED'
     WHERE p.pickup_intake_id = p_intake;
  ELSE
    SELECT (pg_catalog.count(*) FILTER (WHERE o.locked_at IS NULL))::integer,
           (pg_catalog.count(*) FILTER (WHERE o.locked_at IS NOT NULL))::integer,
           (pg_catalog.count(*) FILTER (WHERE o.commercial_state = 'PAYMENT_REQUIRED'))::integer,
           pg_catalog.count(*)::integer
      INTO prepared, itemized, payment_required, orders
      FROM public."order" AS o
     WHERE o.pickup_intake_id = p_intake;
    -- A blind count that has not been committed has received nothing that is known: null, which is not zero.
    received := held.physical_count;
    awaiting_arrival := 0;
    needs_order := CASE WHEN held.physical_count IS NULL THEN NULL ELSE GREATEST(held.physical_count - orders, 0) END;
    missing := 0;
  END IF;
  RETURN NEXT;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.intake_progress(uuid) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.intake_progress(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.intake_progress(uuid) TO melarc_api_runtime;
--> statement-breakpoint
DROP FUNCTION melarc.intake_closure_assessment(uuid);
--> statement-breakpoint
CREATE FUNCTION melarc.intake_closure_assessment(p_intake uuid)
RETURNS TABLE (state text, receiving_mode text, received integer, ordered integer, unpriced integer, payment_required integer, missing integer, outstanding_count integer, outstanding_parcels jsonb, outstanding_digest text,
               closed_at timestamp with time zone, parity_exception_note text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  held public.pickup_intake%ROWTYPE;
BEGIN
  IF melarc.principal_type() IS DISTINCT FROM 'STAFF'
     OR coalesce(pg_catalog.current_setting('melarc.authorization_key', true), '') NOT IN ('hub.intake.close', 'hub.intake.close_exception') THEN
    RAISE EXCEPTION 'what a close would find is read by the officer who closes' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO held FROM public.pickup_intake AS i WHERE i.id = p_intake;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  state := held.state;
  receiving_mode := held.receiving_mode;
  -- A blind count that has not been committed has received nothing that is known: null, which is not zero (a photo intake's count is the parcels that arrived).
  received := CASE WHEN held.receiving_mode = 'BLIND_COUNT' THEN held.physical_count ELSE coalesce(held.physical_count, 0) END;
  closed_at := held.closed_at;
  parity_exception_note := held.parity_exception_note;
  -- The orders that stand for the parcels that arrived (and every order of a blind-count intake): the number the close compares with what the hub received.
  SELECT pg_catalog.count(*)::integer, (pg_catalog.count(*) FILTER (WHERE o.locked_at IS NULL))::integer, (pg_catalog.count(*) FILTER (WHERE o.commercial_state = 'PAYMENT_REQUIRED'))::integer
    INTO ordered, unpriced, payment_required
    FROM public."order" AS o
   WHERE o.pickup_intake_id = p_intake AND o.commercial_state IS DISTINCT FROM 'REVERSED'
     AND (o.intake_parcel_id IS NULL OR EXISTS (SELECT 1 FROM public.intake_parcel AS p WHERE p.id = o.intake_parcel_id AND p.state = 'ARRIVED'));
  SELECT pg_catalog.count(*)::integer INTO missing FROM public.intake_parcel AS p WHERE p.pickup_intake_id = p_intake AND p.state = 'MISSING';
  IF held.receiving_mode = 'PHOTO_CHECK_IN' THEN
    SELECT pg_catalog.count(*)::integer,
           coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('parcel_id', q.id, 'ordinal', q.ordinal, 'origin', q.origin,
                                                                       'door_photo_evidence_id', q.door_photo_evidence_id, 'hub_photo_evidence_id', q.hub_photo_evidence_id) ORDER BY q.ordinal)
                    FILTER (WHERE q.rank <= 100), '[]'::jsonb),
           -- Of every outstanding parcel and not of the first hundred: what a senior's reason is bound to when the close is made.
           pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(coalesce(pg_catalog.string_agg(q.id::text, ',' ORDER BY q.ordinal), ''), 'UTF8')), 'hex')
      INTO outstanding_count, outstanding_parcels, outstanding_digest
      FROM (
        SELECT p.id, p.ordinal, p.origin, p.door_photo_evidence_id, p.hub_photo_evidence_id, pg_catalog.row_number() OVER (ORDER BY p.ordinal) AS rank
          FROM public.intake_parcel AS p
         WHERE p.pickup_intake_id = p_intake AND p.state = 'ARRIVED' AND NOT EXISTS (SELECT 1 FROM public."order" AS o WHERE o.intake_parcel_id = p.id AND o.commercial_state IS DISTINCT FROM 'REVERSED')
      ) AS q;
  ELSE
    outstanding_count := CASE WHEN received IS NULL THEN NULL ELSE GREATEST(received - ordered, 0) END;
    outstanding_parcels := '[]'::jsonb;
    outstanding_digest := NULL;
  END IF;
  RETURN NEXT;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.intake_closure_assessment(uuid) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.intake_closure_assessment(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.intake_closure_assessment(uuid) TO melarc_api_runtime;
--> statement-breakpoint
-- THE QUEUE OF THE INTAKES CLOSED WITH THE APPROVED EXCEPTION THAT STILL HAVE RECEIVED PARCELS WITHOUT AN ORDER (OB-S1-151; the review of 20 November 2026): newest first, in the hubs of the grant, for the senior who
-- may close with the exception. What is left is counted now (the parcels the hub received less the orders that stand for the ones that arrived), so a row that has nothing left is not in the queue. The
-- position is the moment of the close at the precision the database keeps it, with the intake, and nothing the caller made up.
CREATE FUNCTION melarc.closed_intake_exceptions(p_after_closed_at timestamp with time zone, p_after_id uuid, p_limit integer)
RETURNS TABLE (intake_id uuid, intake_code text, pickup_request_id uuid, responsible_hub_id uuid, receiving_mode text, closed_at timestamp with time zone, closed_at_cursor text, closed_by uuid,
               exception_note text, received integer, ordered integer, outstanding_count integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
BEGIN
  IF melarc.principal_type() IS DISTINCT FROM 'STAFF'
     OR coalesce(pg_catalog.current_setting('melarc.authorization_key', true), '') <> 'hub.intake.close_exception' THEN
    RAISE EXCEPTION 'the closes that left work are read by the senior who may close with the exception, and by nobody else' USING ERRCODE = '42501';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 THEN
    RAISE EXCEPTION 'the closes that left work are read a page of one or more at a time' USING ERRCODE = '22023';
  END IF;
  IF (p_after_closed_at IS NULL) <> (p_after_id IS NULL) THEN
    RAISE EXCEPTION 'a position in the queue is a moment and an intake together' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
    SELECT x.id, x.code, x.pickup_request_id, x.responsible_hub_id, x.receiving_mode, x.closed_at,
           pg_catalog.to_char(x.closed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), x.closed_by, x.parity_exception_note, x.received, x.ordered, x.received - x.ordered
      FROM (
        SELECT i.id, i.code, i.pickup_request_id, i.responsible_hub_id, i.receiving_mode, i.closed_at, i.closed_by, i.parity_exception_note,
               coalesce(i.physical_count, 0) AS received,
               (SELECT pg_catalog.count(*)::integer FROM public."order" AS o
                 WHERE o.pickup_intake_id = i.id AND o.commercial_state IS DISTINCT FROM 'REVERSED'
                   AND (o.intake_parcel_id IS NULL OR EXISTS (SELECT 1 FROM public.intake_parcel AS p WHERE p.id = o.intake_parcel_id AND p.state = 'ARRIVED'))) AS ordered
          FROM public.pickup_intake AS i
         WHERE i.state = 'CLOSED' AND i.parity_exception_id IS NOT NULL
           AND (p_after_closed_at IS NULL OR (i.closed_at, i.id) < (p_after_closed_at, p_after_id))
      ) AS x
     WHERE x.received > x.ordered
     ORDER BY x.closed_at DESC, x.id DESC
     LIMIT p_limit;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.closed_intake_exceptions(timestamp with time zone, uuid, integer) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.closed_intake_exceptions(timestamp with time zone, uuid, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.closed_intake_exceptions(timestamp with time zone, uuid, integer) TO melarc_api_runtime;
--> statement-breakpoint
-- An order whose arrival was reversed is the hub's history of its own mistake: the vendor's read of it is one that does not exist, as the vendor's summary of the closed intake already leaves it out.
ALTER POLICY "order_pricing_read" ON "order" USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN coalesce(current_setting('melarc.authorization_key', true), '') = 'pricing.read'
      AND (melarc.hub_scope_mode() = 'ALL' OR "order"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    WHEN 'VENDOR' THEN coalesce(current_setting('melarc.authorization_key', true), '') = 'pricing.read'
      AND "order"."vendor_organization_id" = melarc.current_vendor_organization_id()
      AND "order"."commercial_state" IS DISTINCT FROM 'REVERSED'
    ELSE false
  END
);
--> statement-breakpoint
-- The tier of a grant is a fact of the bundle, asked of the database (as 0032 asks it for a staff identity): the Platform Admin who decides a correction he asked for holds the key of the checker at tier P.
CREATE FUNCTION melarc.staff_holds_at_tier_p(p_staff uuid, p_key text) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.staff_identity AS s JOIN public.role_bundle_grant AS g ON g.bundle_id = s.role_bundle_id
     WHERE s.id = p_staff AND g.permission_key = p_key AND g.tier = 'P')
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.staff_holds_at_tier_p(uuid, text) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.staff_holds_at_tier_p(uuid, text) FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION melarc.payer_correction_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  act_key text := coalesce(pg_catalog.current_setting('melarc.authorization_key', true), '');
  ord public."order"%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a payer correction is never removed' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF act_key <> 'pricing.correction.create' THEN
      RAISE EXCEPTION 'a payer correction is requested by the officer who holds the key of the maker' USING ERRCODE = '23514';
    END IF;
    SELECT * INTO ord FROM public."order" AS o WHERE o.id = NEW.order_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'a payer correction is for an order of the officer''s hubs' USING ERRCODE = '23514';
    END IF;
    IF ord.locked_at IS NULL THEN
      RAISE EXCEPTION 'a payer correction is for an order whose price is frozen: before it, the arrangement of the request is edited' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT', HINT = 'rule=order_not_frozen';
    END IF;
    IF ord.commercial_state NOT IN ('NO_VENDOR_CHARGE', 'PAYMENT_REQUIRED') THEN
      RAISE EXCEPTION 'a payer correction is for an order that has not been paid for or reserved' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT', HINT = 'rule=order_not_correctable';
    END IF;
    IF NEW.state <> 'REQUESTED' OR NEW.decided_by IS NOT NULL OR NEW.decided_at IS NOT NULL THEN
      RAISE EXCEPTION 'a payer correction begins as a request' USING ERRCODE = '23514';
    END IF;
    IF NEW.requested_by IS DISTINCT FROM melarc.current_principal_id() THEN
      RAISE EXCEPTION 'a payer correction is requested in the name of the officer who asks' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (SELECT 1 FROM public.payer_correction AS c WHERE c.order_id = NEW.order_id AND c.state = 'REQUESTED') THEN
      RAISE EXCEPTION 'an order has one open payer correction at a time' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT', HINT = 'rule=correction_open';
    END IF;
    NEW.responsible_hub_id := ord.responsible_hub_id;
    NEW.previous_allocation := ord.payer_allocation;
    NEW.created_at := pg_catalog.clock_timestamp();
    NEW.version := 1;
    RETURN NEW;
  END IF;
  -- A decision: from REQUESTED to APPROVED or REJECTED, by the checker, once; nothing else of the row moves.
  IF OLD.state <> 'REQUESTED' THEN
    RAISE EXCEPTION 'a decided payer correction is kept as it was' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT', HINT = 'rule=already_decided';
  END IF;
  IF NEW.state NOT IN ('APPROVED', 'REJECTED') OR act_key <> 'pricing.correction.approve' THEN
    RAISE EXCEPTION 'a payer correction is decided by the officer who holds the key of the checker' USING ERRCODE = '23514';
  END IF;
  IF (pg_catalog.to_jsonb(NEW) - 'state' - 'decided_by' - 'decided_at' - 'resulting_allocation' - 'resulting_commercial_state' - 'version')
     IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) - 'state' - 'decided_by' - 'decided_at' - 'resulting_allocation' - 'resulting_commercial_state' - 'version') THEN
    RAISE EXCEPTION 'a decision changes the state, the decider, the moment and what it wrote, and nothing else' USING ERRCODE = '23514';
  END IF;
  IF NEW.decided_by IS DISTINCT FROM melarc.current_principal_id() THEN
    RAISE EXCEPTION 'a payer correction is decided in the name of the officer who decides' USING ERRCODE = '23514';
  END IF;
  IF NEW.decided_by = OLD.requested_by AND NOT melarc.staff_holds_at_tier_p(NEW.decided_by, 'pricing.correction.approve') THEN
    RAISE EXCEPTION 'the approver of a payer correction is not its requester, unless a Platform Admin' USING ERRCODE = '23514', DETAIL = 'reason=SELF_APPROVAL_FORBIDDEN', HINT = 'rule=self_approval';
  END IF;
  NEW.decided_at := pg_catalog.transaction_timestamp();
  RETURN NEW;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.payer_correction_guard() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.payer_correction_guard() FROM PUBLIC;
