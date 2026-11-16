-- Run D, S1.35b (the check-in of a vendor's parcels): the acts of the receiver and of the senior on a photo intake's parcels, the blind count made mode-aware, the declaration of a photo intake served from the start,
-- and the evidence policies that let the receiver's photos be made while the vendor's check-in is open. Hand-written throughout (there is nothing for the generator to say: no table or column changes here). This
-- migration is applied as melarc_migration_elevated, a member of melarc_owner (MIGRATION_AND_SEEDING.md section 5.1). Forward of 0103; nothing earlier is edited. features/hub/hub-intake.md sections 5.1 and 5.4 to
-- 5.8; contracts/state-machines.md section 7; errors-and-enums.md section 5.3a; openapi.yaml `recordParcelArrival`, `finishCheckIn`, `addExtraParcel` and `correctIntakeCount`.
--
-- FOUR OPERATIONS OF THE DATABASE, each as the owner, each for staff under the key of its kind and for nobody else, each taking the intake's lock FIRST and then the parcel (the order of every act of this layer),
-- each on the database's clock, each answering what the application writes its events from. Every refusal that a screen words carries its code in the DETAIL (`reason=STATE_CONFLICT`, ...) and its `details.rule` in
-- the HINT (`rule=check_in_finished`, ...): the rules of errors-and-enums.md section 5.3a. The application's login can write no parcel and no count: the policies that admit the writes name the owner, and the
-- guards of 0103 hold the machine for every writer, the deferred checks the numbers.
--
--   * melarc.record_parcel_arrival (hub.intake.count): a tap or an untap while the vendor's check-in is open (state-wise idempotent: the parcel is asked to be in a state), the voiding of an extra by the receiver,
--     and a parcel that is FOUND (MISSING -> ARRIVED) while the case is open, which recomputes the intake's count, difference and variance in the same change and leaves the intake in reconciliation. A tap, an
--     untap and an extra before the finish change no column of the intake, so they never move its version (the ETag).
--   * melarc.finish_check_in (hub.intake.count): "All N here" (every expected parcel arrives; refused when the number confirmed is not the number expected or when an extra stands) or as tapped (every parcel not
--     tapped is missing); writes the count against the number expected, the receiver and the moment, takes the intake to COUNTED and makes the System's move in the same change.
--   * melarc.add_extra_parcel (hub.intake.count): a parcel on the table that has no door photo, with a stored photo of the intake the officer took (purpose OSD), added while the vendor's check-in or the case is open;
--     born ARRIVED and counted at once when the vendor is already finished.
--   * melarc.correct_intake_count (hub.osd.adjudicate, Senior Ops and the Platform Admin; D-D8): a reason in words is required; a photo intake's parcels move between arrived and missing (a door parcel) or arrived
--     and void (an extra), a blind count takes a new number; the count, the difference and the variance are recomputed and the intake is routed again by the rule of the System; only before itemizing starts, and
--     only a correction that changes the number received. The reason and the numbers are the enhanced event's, which the application writes.

-- melarc.record_parcel_arrival: the tap, the untap, the voiding of an extra and the finding of a missing parcel. Answers the parcel's state before and after, the intake and its state.
CREATE FUNCTION melarc.record_parcel_arrival(p_parcel uuid, p_arrived boolean)
RETURNS TABLE (parcel_previous_state text, parcel_resulting_state text, parcel_intake_id uuid, parcel_intake_state text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  target uuid;
  held record;
  parcel public.intake_parcel%ROWTYPE;
  facts record;
BEGIN
  IF melarc.principal_type() IS DISTINCT FROM 'STAFF' OR coalesce(pg_catalog.current_setting('melarc.authorization_key', true), '') <> 'hub.intake.count' THEN
    RAISE EXCEPTION 'a parcel is checked in by a receiver of the hub holding the key of the count, and by nobody else' USING ERRCODE = '42501';
  END IF;
  IF p_parcel IS NULL OR p_arrived IS NULL THEN
    RAISE EXCEPTION 'an arrival names a parcel and says whether it arrived' USING ERRCODE = '22023';
  END IF;
  SELECT p.pickup_intake_id INTO target FROM public.intake_parcel AS p WHERE p.id = p_parcel;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'there is no such parcel in the receiver''s hubs' USING ERRCODE = '42501';
  END IF;
  SELECT i.id, i.state, i.receiving_mode INTO held FROM public.pickup_intake AS i WHERE i.id = target FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'there is no such parcel in the receiver''s hubs' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO parcel FROM public.intake_parcel AS p WHERE p.id = p_parcel FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'there is no such parcel in the receiver''s hubs' USING ERRCODE = '42501';
  END IF;
  IF held.receiving_mode <> 'PHOTO_CHECK_IN' THEN
    RAISE EXCEPTION 'an intake that is counted blind has no parcels to check in' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT', HINT = 'rule=blind_count_intake';
  END IF;
  IF held.state IN ('ITEMIZING', 'CLOSED') THEN
    RAISE EXCEPTION 'a parcel does not move once itemizing has started' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT', HINT = 'rule=itemization_started';
  END IF;

  IF p_arrived THEN
    IF parcel.state = 'ARRIVED' THEN
      RETURN QUERY SELECT parcel.state, parcel.state, held.id, held.state;
      RETURN;
    ELSIF parcel.state = 'EXPECTED' THEN
      IF held.state <> 'AWAITING_COUNT' THEN
        RAISE EXCEPTION 'the vendor is finished: a parcel is no longer checked in by a tap' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT', HINT = 'rule=check_in_finished';
      END IF;
      UPDATE public.intake_parcel SET state = 'ARRIVED' WHERE id = p_parcel;
      RETURN QUERY SELECT 'EXPECTED'::text, 'ARRIVED'::text, held.id, held.state;
      RETURN;
    ELSIF parcel.state = 'MISSING' THEN
      -- A parcel that is found: while the case is open, the count follows and the intake stays in reconciliation (a senior closes the case even when nothing is missing any more).
      IF held.state <> 'RECONCILIATION_REQUIRED' THEN
        RAISE EXCEPTION 'a missing parcel is found while the case is open' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT', HINT = 'rule=check_in_finished';
      END IF;
      UPDATE public.intake_parcel SET state = 'ARRIVED' WHERE id = p_parcel;
      SELECT * INTO facts FROM melarc.intake_parcel_facts(held.id);
      UPDATE public.pickup_intake
         SET physical_count = facts.arrived,
             count_difference = facts.arrived - facts.expected,
             count_variance = CASE WHEN facts.arrived = facts.expected THEN 'MATCH' WHEN facts.arrived < facts.expected THEN 'SHORT' ELSE 'OVER' END
       WHERE id = held.id;
      RETURN QUERY SELECT 'MISSING'::text, 'ARRIVED'::text, held.id, held.state;
      RETURN;
    END IF;
    -- A voided extra is put back by a senior's correction only.
    RAISE EXCEPTION 'an extra that was taken back is put back by a senior''s correction' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT', HINT = 'rule=check_in_finished';
  END IF;

  IF parcel.state = 'ARRIVED' THEN
    IF held.state <> 'AWAITING_COUNT' THEN
      RAISE EXCEPTION 'the vendor is finished: a parcel is no longer taken back by an untap' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT', HINT = 'rule=check_in_finished';
    END IF;
    UPDATE public.intake_parcel SET state = CASE WHEN parcel.origin = 'DOOR_PHOTO' THEN 'EXPECTED' ELSE 'VOID' END WHERE id = p_parcel;
    RETURN QUERY SELECT 'ARRIVED'::text, CASE WHEN parcel.origin = 'DOOR_PHOTO' THEN 'EXPECTED' ELSE 'VOID' END, held.id, held.state;
    RETURN;
  END IF;
  -- Not arrived to begin with (expected, missing or void): it is asked to be where it is.
  RETURN QUERY SELECT parcel.state, parcel.state, held.id, held.state;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.record_parcel_arrival(uuid, boolean) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.record_parcel_arrival(uuid, boolean) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.record_parcel_arrival(uuid, boolean) TO melarc_api_runtime;
--> statement-breakpoint
-- melarc.finish_check_in: "All N here", or as tapped. Answers the intake's state before and after, the number expected and received, how many are missing and how many extras stand, and the variance.
CREATE FUNCTION melarc.finish_check_in(p_intake uuid, p_all_arrived boolean, p_confirmed_count integer)
RETURNS TABLE (previous_state text, resulting_state text, expected_count integer, received_count integer, missing_count integer, extra_count integer, resulting_variance text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  held public.pickup_intake%ROWTYPE;
  facts record;
  after_facts record;
  difference integer;
  compared text;
  unclean boolean;
  next_state text;
BEGIN
  IF melarc.principal_type() IS DISTINCT FROM 'STAFF' OR coalesce(pg_catalog.current_setting('melarc.authorization_key', true), '') <> 'hub.intake.count' THEN
    RAISE EXCEPTION 'a vendor is finished by a receiver of the hub holding the key of the count, and by nobody else' USING ERRCODE = '42501';
  END IF;
  IF p_intake IS NULL OR p_all_arrived IS NULL THEN
    RAISE EXCEPTION 'finishing a vendor names an intake and says whether all its parcels arrived' USING ERRCODE = '22023';
  END IF;
  IF p_all_arrived AND (p_confirmed_count IS NULL OR p_confirmed_count < 1) THEN
    RAISE EXCEPTION '"All N here" says the number the officer counted, one or more' USING ERRCODE = '22023';
  END IF;
  IF NOT p_all_arrived AND p_confirmed_count IS NOT NULL THEN
    RAISE EXCEPTION 'a vendor finished as tapped says no number counted' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO held FROM public.pickup_intake AS i WHERE i.id = p_intake FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'there is no such intake in the receiver''s hubs' USING ERRCODE = '42501';
  END IF;
  IF held.receiving_mode <> 'PHOTO_CHECK_IN' THEN
    RAISE EXCEPTION 'an intake that is counted blind is counted, not checked in' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT', HINT = 'rule=blind_count_intake';
  END IF;
  IF held.state IN ('ITEMIZING', 'CLOSED') THEN
    RAISE EXCEPTION 'a vendor is not finished once itemizing has started' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT', HINT = 'rule=itemization_started';
  END IF;
  IF held.state <> 'AWAITING_COUNT' THEN
    RAISE EXCEPTION 'the vendor is finished already: a vendor is finished once' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT', HINT = 'rule=check_in_finished';
  END IF;
  SELECT * INTO facts FROM melarc.intake_parcel_facts(p_intake);
  IF p_all_arrived THEN
    IF p_confirmed_count <> facts.expected THEN
      RAISE EXCEPTION 'the number counted is not the number of parcels the vendor is expected to have brought' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT', HINT = 'rule=count_changed';
    END IF;
    IF facts.extras > 0 THEN
      RAISE EXCEPTION 'a pile with an extra is not "all here": the vendor is finished as tapped' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT', HINT = 'rule=has_extra_parcels';
    END IF;
    UPDATE public.intake_parcel SET state = 'ARRIVED' WHERE pickup_intake_id = p_intake AND state = 'EXPECTED';
  ELSE
    UPDATE public.intake_parcel SET state = 'MISSING' WHERE pickup_intake_id = p_intake AND state = 'EXPECTED';
  END IF;
  SELECT * INTO after_facts FROM melarc.intake_parcel_facts(p_intake);
  difference := after_facts.arrived - after_facts.expected;
  compared := CASE WHEN difference = 0 THEN 'MATCH' WHEN difference < 0 THEN 'SHORT' ELSE 'OVER' END;
  UPDATE public.pickup_intake
     SET state = 'COUNTED', physical_count = after_facts.arrived, counted_at = pg_catalog.clock_timestamp(), counted_by = melarc.current_principal_id(),
         count_variance = compared, count_difference = difference
   WHERE id = p_intake;
  -- The System's move, in the same change: cleared for itemization only when nothing is missing, no extra stands, the count matches, no condition other than OK stands and the declaration is above zero.
  unclean := compared <> 'MATCH' OR after_facts.missing > 0 OR after_facts.extras > 0 OR held.rider_declared_count = 0 OR held.condition <> 'OK';
  next_state := CASE WHEN unclean THEN 'RECONCILIATION_REQUIRED' ELSE 'READY_FOR_ITEMIZATION' END;
  UPDATE public.pickup_intake SET state = next_state WHERE id = p_intake;
  RETURN QUERY SELECT 'AWAITING_COUNT'::text, next_state, after_facts.expected, after_facts.arrived, after_facts.missing, after_facts.extras, compared;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.finish_check_in(uuid, boolean, integer) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.finish_check_in(uuid, boolean, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.finish_check_in(uuid, boolean, integer) TO melarc_api_runtime;
--> statement-breakpoint
-- melarc.add_extra_parcel: a parcel on the table with no door photo. The identifier of the parcel is the caller's (time-ordered, as a finding's is). The photo is a stored record of the intake of the purpose OSD,
-- used by no other parcel; a photo that cannot be used is one answer, as a counted photo is. The place, the officer and the moment are the guard's. Answers the parcel's place, the intake's state and whether the
-- extra was counted at once.
CREATE FUNCTION melarc.add_extra_parcel(p_intake uuid, p_parcel uuid, p_evidence uuid)
RETURNS TABLE (extra_parcel_id uuid, extra_parcel_ordinal integer, extra_intake_state text, extra_counted boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  held public.pickup_intake%ROWTYPE;
  usable integer;
  facts record;
  placed integer;
BEGIN
  IF melarc.principal_type() IS DISTINCT FROM 'STAFF' OR coalesce(pg_catalog.current_setting('melarc.authorization_key', true), '') <> 'hub.intake.count' THEN
    RAISE EXCEPTION 'an extra is added by a receiver of the hub holding the key of the count, and by nobody else' USING ERRCODE = '42501';
  END IF;
  IF p_intake IS NULL OR p_parcel IS NULL OR p_evidence IS NULL THEN
    RAISE EXCEPTION 'an extra names an intake, its own identifier and its photo' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO held FROM public.pickup_intake AS i WHERE i.id = p_intake FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'there is no such intake in the receiver''s hubs' USING ERRCODE = '42501';
  END IF;
  IF held.receiving_mode <> 'PHOTO_CHECK_IN' THEN
    RAISE EXCEPTION 'an intake that is counted blind has no parcels' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT', HINT = 'rule=blind_count_intake';
  END IF;
  IF held.state IN ('ITEMIZING', 'CLOSED') THEN
    RAISE EXCEPTION 'an extra is not added once itemizing has started' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT', HINT = 'rule=itemization_started';
  END IF;
  IF held.state NOT IN ('AWAITING_COUNT', 'RECONCILIATION_REQUIRED') THEN
    RAISE EXCEPTION 'an extra is not added to a case that was resolved' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT', HINT = 'rule=check_in_finished';
  END IF;
  SELECT pg_catalog.count(*) INTO usable FROM public.evidence AS v
   WHERE v.id = p_evidence AND v.state = 'STORED' AND v.owner_type = 'PICKUP_INTAKE' AND v.owner_id = p_intake AND v.responsible_hub_id = held.responsible_hub_id AND v.purpose = 'OSD'
     AND NOT EXISTS (SELECT 1 FROM public.intake_parcel AS p WHERE p.hub_photo_evidence_id = v.id);
  IF usable <> 1 THEN
    RAISE EXCEPTION 'an extra has a stored photo of this intake that no other parcel uses' USING ERRCODE = '23514', DETAIL = 'reason=EVIDENCE_NOT_STORED';
  END IF;
  -- The ordinal given here is a placeholder (the table holds one or more): the guard places the extra after the last parcel, and gives the officer and the moment.
  INSERT INTO public.intake_parcel (id, pickup_intake_id, responsible_hub_id, ordinal, origin, hub_photo_evidence_id, state)
  VALUES (p_parcel, p_intake, held.responsible_hub_id, 1, 'HUB_EXTRA', p_evidence, 'ARRIVED');
  IF held.state = 'RECONCILIATION_REQUIRED' THEN
    -- The vendor was finished: the extra is counted at once, and the case stays open.
    SELECT * INTO facts FROM melarc.intake_parcel_facts(p_intake);
    UPDATE public.pickup_intake
       SET physical_count = facts.arrived,
           count_difference = facts.arrived - facts.expected,
           count_variance = CASE WHEN facts.arrived = facts.expected THEN 'MATCH' WHEN facts.arrived < facts.expected THEN 'SHORT' ELSE 'OVER' END
     WHERE id = p_intake;
  END IF;
  SELECT p.ordinal INTO placed FROM public.intake_parcel AS p WHERE p.id = p_parcel;
  RETURN QUERY SELECT p_parcel, placed, held.state, held.state = 'RECONCILIATION_REQUIRED';
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.add_extra_parcel(uuid, uuid, uuid) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.add_extra_parcel(uuid, uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.add_extra_parcel(uuid, uuid, uuid) TO melarc_api_runtime;
--> statement-breakpoint
-- melarc.correct_intake_count: a senior officer's correction of a hub count or a check-in (D-D8, approved 16 November 2026). A reason in words is required (REASON_REQUIRED); the intake is past its count and itemizing
-- has not started; the body names the member of the intake's mode (a photo intake's parcel changes, a blind count's new number: VALIDATION_FAILED, rule mode_mismatch, otherwise) and changes the number received. The
-- count, the difference and the variance are recomputed and the intake is routed again by the rule of the System in the same change. Answers the states before and after, the numbers received and the variances before
-- and after, and the parcels changed with the state each was in and is in, for the enhanced event that records them.
CREATE FUNCTION melarc.correct_intake_count(p_intake uuid, p_reason text, p_parcel_changes jsonb, p_physical_count integer)
RETURNS TABLE (previous_state text, resulting_state text, old_received integer, new_received integer, old_variance text, new_variance text, changed jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  held public.pickup_intake%ROWTYPE;
  facts record;
  one jsonb;
  parcel public.intake_parcel%ROWTYPE;
  wanted text;
  moved jsonb := '[]'::jsonb;
  new_count integer;
  expected_number integer;
  difference integer;
  compared text;
  routed_clean boolean;
  next_state text;
BEGIN
  IF melarc.principal_type() IS DISTINCT FROM 'STAFF' OR coalesce(pg_catalog.current_setting('melarc.authorization_key', true), '') <> 'hub.osd.adjudicate' THEN
    RAISE EXCEPTION 'a count or a check-in is corrected by Senior Ops holding the key of the adjudication, and by nobody else' USING ERRCODE = '42501';
  END IF;
  IF p_intake IS NULL THEN
    RAISE EXCEPTION 'a correction names an intake' USING ERRCODE = '22023';
  END IF;
  IF p_reason IS NULL OR pg_catalog.btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'a correction says why' USING ERRCODE = '23514', DETAIL = 'reason=REASON_REQUIRED';
  END IF;
  SELECT * INTO held FROM public.pickup_intake AS i WHERE i.id = p_intake FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'there is no such intake in the adjudicator''s hubs' USING ERRCODE = '42501';
  END IF;
  IF held.state IN ('ITEMIZING', 'CLOSED') THEN
    RAISE EXCEPTION 'a count is not corrected once itemizing has started' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT', HINT = 'rule=itemization_started';
  END IF;
  IF held.state NOT IN ('RECONCILIATION_REQUIRED', 'READY_FOR_ITEMIZATION') THEN
    RAISE EXCEPTION 'only a count that has been made is corrected' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT', HINT = 'rule=intake_not_counted';
  END IF;
  IF held.receiving_mode = 'PHOTO_CHECK_IN' THEN
    IF p_physical_count IS NOT NULL OR p_parcel_changes IS NULL OR pg_catalog.jsonb_typeof(p_parcel_changes) <> 'array' OR pg_catalog.jsonb_array_length(p_parcel_changes) = 0 THEN
      RAISE EXCEPTION 'a photo intake is corrected by the changes of its parcels, and by nothing else' USING ERRCODE = '23514', DETAIL = 'reason=VALIDATION_FAILED', HINT = 'rule=mode_mismatch';
    END IF;
  ELSIF p_parcel_changes IS NOT NULL OR p_physical_count IS NULL THEN
    RAISE EXCEPTION 'a blind count is corrected by a new number, and by nothing else' USING ERRCODE = '23514', DETAIL = 'reason=VALIDATION_FAILED', HINT = 'rule=mode_mismatch';
  ELSIF p_physical_count < 0 THEN
    RAISE EXCEPTION 'a count is a number of parcels, zero or more' USING ERRCODE = '22023';
  END IF;

  IF held.receiving_mode = 'PHOTO_CHECK_IN' THEN
    IF (SELECT pg_catalog.count(DISTINCT pg_catalog.lower(e.value ->> 'parcel_id')) FROM pg_catalog.jsonb_array_elements(p_parcel_changes) AS e) <> pg_catalog.jsonb_array_length(p_parcel_changes) THEN
      RAISE EXCEPTION 'a correction names each parcel once' USING ERRCODE = '22023';
    END IF;
    FOR one IN SELECT e.value FROM pg_catalog.jsonb_array_elements(p_parcel_changes) AS e LOOP
      IF pg_catalog.jsonb_typeof(one) <> 'object'
         OR pg_catalog.jsonb_typeof(one -> 'parcel_id') IS DISTINCT FROM 'string'
         OR (one ->> 'parcel_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         OR (one ->> 'state') IS NULL OR (one ->> 'state') NOT IN ('ARRIVED', 'MISSING', 'VOID') THEN
        RAISE EXCEPTION 'a change of a parcel names the parcel and the state it is to be in: ARRIVED, MISSING or VOID' USING ERRCODE = '22023';
      END IF;
      wanted := one ->> 'state';
      SELECT * INTO parcel FROM public.intake_parcel AS p WHERE p.id = (one ->> 'parcel_id')::uuid AND p.pickup_intake_id = p_intake FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'a correction changes the parcels of the intake it names' USING ERRCODE = '22023';
      END IF;
      IF parcel.state = wanted THEN
        CONTINUE;
      END IF;
      IF NOT (
        (parcel.origin = 'DOOR_PHOTO' AND parcel.state IN ('ARRIVED', 'MISSING') AND wanted IN ('ARRIVED', 'MISSING'))
        OR (parcel.origin = 'HUB_EXTRA' AND parcel.state IN ('ARRIVED', 'VOID') AND wanted IN ('ARRIVED', 'VOID'))
      ) THEN
        RAISE EXCEPTION 'a correction moves a door parcel between arrived and missing, and an extra between arrived and void' USING ERRCODE = '22023';
      END IF;
      UPDATE public.intake_parcel SET state = wanted WHERE id = parcel.id;
      moved := moved || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('parcel_id', parcel.id, 'from', parcel.state, 'to', wanted));
    END LOOP;
    SELECT * INTO facts FROM melarc.intake_parcel_facts(p_intake);
    new_count := facts.arrived;
    expected_number := facts.expected;
  ELSE
    new_count := p_physical_count;
    expected_number := held.rider_declared_count;
  END IF;
  IF new_count = held.physical_count THEN
    RAISE EXCEPTION 'a correction changes the number received' USING ERRCODE = '22023';
  END IF;
  difference := new_count - expected_number;
  compared := CASE WHEN difference = 0 THEN 'MATCH' WHEN difference < 0 THEN 'SHORT' ELSE 'OVER' END;
  routed_clean := compared = 'MATCH' AND held.rider_declared_count > 0 AND held.condition = 'OK';
  IF held.receiving_mode = 'PHOTO_CHECK_IN' THEN
    routed_clean := routed_clean AND facts.missing = 0 AND facts.extras = 0;
  END IF;
  next_state := CASE WHEN routed_clean THEN 'READY_FOR_ITEMIZATION' ELSE 'RECONCILIATION_REQUIRED' END;
  UPDATE public.pickup_intake SET physical_count = new_count, count_difference = difference, count_variance = compared, state = next_state WHERE id = p_intake;
  RETURN QUERY SELECT held.state, next_state, held.physical_count, new_count, held.count_variance, compared, moved;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.correct_intake_count(uuid, text, jsonb, integer) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.correct_intake_count(uuid, text, jsonb, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.correct_intake_count(uuid, text, jsonb, integer) TO melarc_api_runtime;
--> statement-breakpoint
-- melarc.commit_blind_count as 0094 made it (the last definition), with one refusal added: an intake that is checked in against door photos is never counted blind (D-D1, D-D3). Nothing else of the function changes.
CREATE OR REPLACE FUNCTION melarc.commit_blind_count(p_intake uuid, p_physical_count integer) RETURNS TABLE (intake_id uuid, rider_declared_count integer, parcel_photo_ids uuid[])
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  held public.pickup_intake%ROWTYPE;
  difference integer;
  compared text;
BEGIN
  IF melarc.principal_type() IS DISTINCT FROM 'STAFF' OR coalesce(pg_catalog.current_setting('melarc.authorization_key', true), '') <> 'hub.intake.count' THEN
    RAISE EXCEPTION 'a physical count is committed by a receiver of the hub holding the key of the count, and by nobody else' USING ERRCODE = '42501';
  END IF;
  IF p_intake IS NULL OR p_physical_count IS NULL OR p_physical_count < 0 THEN
    RAISE EXCEPTION 'a count names an intake and is a number of parcels, zero or more' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO held FROM public.pickup_intake AS i WHERE i.id = p_intake FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'there is no such intake in the receiver''s hubs' USING ERRCODE = '42501';
  END IF;
  IF held.receiving_mode <> 'BLIND_COUNT' THEN
    RAISE EXCEPTION 'an intake that is checked in against door photos is never counted blind' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT', HINT = 'rule=photo_check_in';
  END IF;
  IF held.state <> 'AWAITING_COUNT' THEN
    RAISE EXCEPTION 'an intake is counted once' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT';
  END IF;
  difference := p_physical_count - held.rider_declared_count;
  compared := CASE WHEN difference = 0 THEN 'MATCH' WHEN difference < 0 THEN 'SHORT' ELSE 'OVER' END;
  UPDATE public.pickup_intake
     SET state = 'COUNTED', physical_count = p_physical_count, counted_at = pg_catalog.clock_timestamp(), counted_by = melarc.current_principal_id(),
         count_variance = compared, count_difference = difference
   WHERE id = p_intake;
  UPDATE public.pickup_intake
     SET state = CASE WHEN compared <> 'MATCH' OR held.rider_declared_count = 0 THEN 'RECONCILIATION_REQUIRED' ELSE 'READY_FOR_ITEMIZATION' END
   WHERE id = p_intake;
  RETURN QUERY SELECT a.intake_id, a.rider_declared_count, a.parcel_photo_ids FROM melarc.hub_intake_after_count(ARRAY[p_intake]) AS a;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.commit_blind_count(uuid, integer) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.commit_blind_count(uuid, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.commit_blind_count(uuid, integer) TO melarc_api_runtime;
--> statement-breakpoint
-- melarc.hub_intake_after_count as 0096 made it (the last definition), with the one change Run D needs: a photo intake hides nothing, so its declaration and its photos are answered from the start and not only
-- once it is counted (D-D1). A blind-count intake is answered only past AWAITING_COUNT, as before. Nothing else of the function changes.
CREATE OR REPLACE FUNCTION melarc.hub_intake_after_count(p_intake_ids uuid[]) RETURNS TABLE (intake_id uuid, rider_declared_count integer, parcel_photo_ids uuid[])
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF melarc.principal_type() IS DISTINCT FROM 'STAFF'
     OR coalesce(pg_catalog.current_setting('melarc.authorization_key', true), '') NOT IN ('hub.read', 'hub.intake.count', 'hub.osd.adjudicate') THEN
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
-- The photos an officer takes at the hub while a photo intake's vendor is still being checked in: a damaged parcel's (purpose CONDITION) and an extra's (purpose OSD), declared and completed by the receiver under the
-- key of the count. 0095's two policies, restated: for a photo intake the receiver declares a condition photo while the vendor's check-in is open (a blind-count intake's stays after the count), and an extra's
-- photo (OSD) while the check-in or the case is open; the senior still declares only the photos of an adjudication (OSD) for an intake that has been counted. Nothing else of them changes.
DROP POLICY "evidence_declare_intake" ON "evidence";
--> statement-breakpoint
CREATE POLICY "evidence_declare_intake" ON "evidence" FOR INSERT WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN (
        (coalesce(current_setting('melarc.authorization_key', true), '') = 'hub.intake.count' AND "evidence"."purpose" IN ('CONDITION', 'OSD'))
        OR (coalesce(current_setting('melarc.authorization_key', true), '') = 'hub.osd.adjudicate' AND "evidence"."purpose" = 'OSD')
      )
      AND "evidence"."owner_type" = 'PICKUP_INTAKE'
      AND "evidence"."captured_by_principal_type" = 'STAFF' AND "evidence"."captured_by_actor" = melarc.current_principal_id()
      AND "evidence"."state" = 'PENDING_UPLOAD' AND "evidence"."access_rule" = 'SUBJECT_READERS' AND "evidence"."retention_policy" = 'PICKUP_INTAKE_EVIDENCE'
      AND "evidence"."responsible_hub_id" IS NOT NULL AND "evidence"."vendor_organization_id" IS NULL
      AND (melarc.hub_scope_mode() = 'ALL' OR "evidence"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
      AND EXISTS (
        SELECT 1 FROM "pickup_intake" AS i
         WHERE i.id = "evidence"."owner_id" AND i.responsible_hub_id = "evidence"."responsible_hub_id"
           AND CASE
                 WHEN coalesce(current_setting('melarc.authorization_key', true), '') = 'hub.intake.count' AND "evidence"."purpose" = 'CONDITION' THEN i.state <> 'AWAITING_COUNT' OR i.receiving_mode = 'PHOTO_CHECK_IN'
                 WHEN coalesce(current_setting('melarc.authorization_key', true), '') = 'hub.intake.count' THEN i.receiving_mode = 'PHOTO_CHECK_IN' AND i.state IN ('AWAITING_COUNT', 'RECONCILIATION_REQUIRED')
                 ELSE i.state <> 'AWAITING_COUNT'
               END
      )
    ELSE false
  END
);
--> statement-breakpoint
DROP POLICY "evidence_store_intake" ON "evidence";
--> statement-breakpoint
CREATE POLICY "evidence_store_intake" ON "evidence" FOR UPDATE USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN (
        (coalesce(current_setting('melarc.authorization_key', true), '') = 'hub.intake.count' AND "evidence"."purpose" IN ('CONDITION', 'OSD'))
        OR (coalesce(current_setting('melarc.authorization_key', true), '') = 'hub.osd.adjudicate' AND "evidence"."purpose" = 'OSD')
      )
      AND "evidence"."owner_type" = 'PICKUP_INTAKE'
      AND "evidence"."captured_by_principal_type" = 'STAFF' AND "evidence"."captured_by_actor" = melarc.current_principal_id()
      AND "evidence"."state" = 'PENDING_UPLOAD'
      AND (melarc.hub_scope_mode() = 'ALL' OR "evidence"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
) WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN "evidence"."state" = 'STORED'
    ELSE false
  END
);
