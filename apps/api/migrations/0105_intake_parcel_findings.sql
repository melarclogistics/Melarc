DROP INDEX "pickup_intake_finding_one_condition_idx";--> statement-breakpoint
ALTER TABLE "pickup_intake_finding" ADD COLUMN "intake_parcel_id" uuid;--> statement-breakpoint
ALTER TABLE "pickup_intake_finding" ADD CONSTRAINT "pickup_intake_finding_parcel_fkey" FOREIGN KEY ("intake_parcel_id","pickup_intake_id") REFERENCES "public"."intake_parcel"("id","pickup_intake_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pickup_intake_finding_one_intake_condition_idx" ON "pickup_intake_finding" USING btree ("pickup_intake_id") WHERE "pickup_intake_finding"."kind" = 'CONDITION' AND "pickup_intake_finding"."intake_parcel_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "pickup_intake_finding_one_parcel_condition_idx" ON "pickup_intake_finding" USING btree ("intake_parcel_id") WHERE "pickup_intake_finding"."kind" = 'CONDITION' AND "pickup_intake_finding"."intake_parcel_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "pickup_intake_finding_one_vendor_told_idx" ON "pickup_intake_finding" USING btree ("pickup_intake_id") WHERE "pickup_intake_finding"."kind" = 'ADJUDICATION' AND "pickup_intake_finding"."outcome" = 'VENDOR_NOTIFIED';--> statement-breakpoint
ALTER TABLE "pickup_intake_finding" ADD CONSTRAINT "pickup_intake_finding_parcel_condition_only" CHECK ("pickup_intake_finding"."intake_parcel_id" IS NULL OR "pickup_intake_finding"."kind" = 'CONDITION');
--> statement-breakpoint
-- THE HAND-WRITTEN PART (Run D, S1.35b). Everything above is generated (drizzle-kit, from src/hub/pickup-intake-finding.schema.ts): the parcel a finding may be about, with its composite key into the parcel table
-- (the finding names a parcel of the intake it names and no other); the one condition of an intake becomes two partial unique indexes (one for an intake that has no parcels, one for each parcel); "Vendor told" is
-- held once for an intake; and only a recording of a condition is about a parcel. This migration is applied as melarc_migration_elevated, a member of melarc_owner (MIGRATION_AND_SEEDING.md section 5.1). Forward of
-- 0104; nothing earlier is edited. If an environment already holds two findings of the kind that a new index refuses, the index is not built and the run stops: a finding is never removed (the guard of the table).
--
-- features/hub/hub-intake.md sections 5.6 and 5.7; contracts/state-machines.md section 7; errors-and-enums.md section 5.3a; openapi.yaml `recordIntakeCondition` and `adjudicateDiscrepancy`. What this part does:
--
--   * THE GUARD OF A FINDING IS RESTATED from 0096 (the last definition) with the rules of Run D, each for every writer: a condition of a photo intake is a parcel's (`parcel_required`) and a parcel is only
--     a photo intake's; a condition of a parcel may be found while the vendor is still being checked in (the one finding that precedes the count) and before itemizing starts, only on a parcel that has arrived
--     (`parcel_not_arrived`); and "Vendor told" is a record that follows a write-off of the intake and is made once (`not_written_off`, `vendor_already_told`). Nothing else of the function changes.
--   * melarc.record_intake_condition TAKES THE PARCEL (an optional sixth argument; a call with five is the blind-count intake's, as before). In photo mode the parcel is required, must have arrived and takes one
--     condition (`condition_already_recorded`); the intake's own condition is the FIRST one found (a later parcel's finding does not overwrite it) and sends an intake that was cleared for itemization back to
--     reconciliation, as it did. An intake that is waiting for its vendor to be finished keeps its state: the finish routes it by the rule of the System, which a non-OK condition stands in.
--   * melarc.adjudicate_discrepancy RECORDS "VENDOR TOLD" AND MOVES NOTHING (D-D4): only after an earlier WRITTEN_OFF of the intake and once, in any state past the count, with no condition; every other outcome
--     is judged as before, with the rule of its refusal named. Nothing is sent to the vendor.

-- The guard of a finding.
CREATE OR REPLACE FUNCTION melarc.pickup_intake_finding_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  intake_hub uuid;
  intake_state text;
  intake_mode text;
  parcel_state text;
  cited integer;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'a finding is kept as it was and is never removed' USING ERRCODE = '23514';
  END IF;
  SELECT i.responsible_hub_id, i.state, i.receiving_mode INTO intake_hub, intake_state, intake_mode FROM public.pickup_intake AS i WHERE i.id = NEW.pickup_intake_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'a finding is about an intake' USING ERRCODE = '23514';
  END IF;
  -- A parcel is a photo intake's, and the condition of a photo intake is a parcel's.
  IF NEW.intake_parcel_id IS NOT NULL THEN
    IF intake_mode <> 'PHOTO_CHECK_IN' THEN
      RAISE EXCEPTION 'only an intake that is checked in against door photos has parcels' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT', HINT = 'rule=blind_count_intake';
    END IF;
  ELSIF intake_mode = 'PHOTO_CHECK_IN' AND NEW.kind = 'CONDITION' THEN
    RAISE EXCEPTION 'the condition of a photo intake is found on a parcel' USING ERRCODE = '23514', DETAIL = 'reason=VALIDATION_FAILED', HINT = 'rule=parcel_required';
  END IF;
  -- A finding is made after the count has committed; the one that precedes it is the condition of a parcel of a photo intake, found while the vendor is still being checked in.
  IF intake_state = 'AWAITING_COUNT' AND NEW.intake_parcel_id IS NULL THEN
    RAISE EXCEPTION 'a finding is made after the blind count has committed' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT';
  END IF;
  IF NEW.intake_parcel_id IS NOT NULL THEN
    IF intake_state IN ('ITEMIZING', 'CLOSED') THEN
      RAISE EXCEPTION 'a condition is found before itemizing starts' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT', HINT = 'rule=itemization_started';
    END IF;
    SELECT p.state INTO parcel_state FROM public.intake_parcel AS p WHERE p.id = NEW.intake_parcel_id AND p.pickup_intake_id = NEW.pickup_intake_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'a finding is about a parcel of its own intake' USING ERRCODE = '23514';
    END IF;
    IF parcel_state <> 'ARRIVED' THEN
      RAISE EXCEPTION 'a condition is found on a parcel that has arrived' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT', HINT = 'rule=parcel_not_arrived';
    END IF;
  END IF;
  -- "Vendor told" is a record that follows a write-off, made once.
  IF NEW.kind = 'ADJUDICATION' AND NEW.outcome = 'VENDOR_NOTIFIED' THEN
    IF NOT EXISTS (SELECT 1 FROM public.pickup_intake_finding AS f WHERE f.pickup_intake_id = NEW.pickup_intake_id AND f.kind = 'ADJUDICATION' AND f.outcome = 'WRITTEN_OFF') THEN
      RAISE EXCEPTION '"Vendor told" follows a write-off of the intake' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT', HINT = 'rule=not_written_off';
    END IF;
    IF EXISTS (SELECT 1 FROM public.pickup_intake_finding AS f WHERE f.pickup_intake_id = NEW.pickup_intake_id AND f.kind = 'ADJUDICATION' AND f.outcome = 'VENDOR_NOTIFIED') THEN
      RAISE EXCEPTION '"Vendor told" is recorded once for an intake' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT', HINT = 'rule=vendor_already_told';
    END IF;
  END IF;
  -- The evidence is the intake's own and is stored, each once, of the purpose the finding's act has: the receiver's photos of a condition, and for an adjudication either kind (it judges the receiver's too).
  IF (SELECT pg_catalog.count(DISTINCT e) FROM pg_catalog.unnest(NEW.evidence_ids) AS e) <> pg_catalog.cardinality(NEW.evidence_ids) THEN
    RAISE EXCEPTION 'a finding cites each piece of evidence once' USING ERRCODE = '23514', DETAIL = 'reason=VALIDATION_FAILED';
  END IF;
  SELECT pg_catalog.count(*) INTO cited FROM public.evidence AS v
   WHERE v.id = ANY (NEW.evidence_ids) AND v.state = 'STORED' AND v.owner_type = 'PICKUP_INTAKE' AND v.owner_id = NEW.pickup_intake_id
     AND v.responsible_hub_id = intake_hub
     AND v.purpose = ANY (CASE WHEN NEW.kind = 'CONDITION' THEN ARRAY['CONDITION'] ELSE ARRAY['CONDITION', 'OSD'] END);
  IF cited <> pg_catalog.cardinality(NEW.evidence_ids) THEN
    RAISE EXCEPTION 'a finding cites evidence that is stored and is the intake''s own' USING ERRCODE = '23514', DETAIL = 'reason=EVIDENCE_NOT_STORED';
  END IF;
  -- The hub is the intake's and the moment is the database's, whatever the writer gave.
  NEW.responsible_hub_id := intake_hub;
  NEW.recorded_at := pg_catalog.clock_timestamp();
  RETURN NEW;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.pickup_intake_finding_guard() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.pickup_intake_finding_guard() FROM PUBLIC;
--> statement-breakpoint
-- melarc.record_intake_condition: `recordIntakeCondition` as 0097 made it (the last definition), taking the parcel the condition is a finding of. The function of five arguments goes (a call that gives five arguments
-- reaches this one with no parcel, the blind-count intake's); the rest follows 0097 and names the rule of each refusal.
DROP FUNCTION melarc.record_intake_condition(uuid, uuid, text, text, uuid[]);
--> statement-breakpoint
CREATE FUNCTION melarc.record_intake_condition(p_intake uuid, p_finding uuid, p_condition text, p_note text, p_evidence uuid[], p_parcel uuid DEFAULT NULL)
RETURNS TABLE (previous_state text, resulting_state text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  held public.pickup_intake%ROWTYPE;
  parcel_state text;
  next_state text;
BEGIN
  IF melarc.principal_type() IS DISTINCT FROM 'STAFF' OR coalesce(pg_catalog.current_setting('melarc.authorization_key', true), '') <> 'hub.intake.count' THEN
    RAISE EXCEPTION 'a condition is recorded by a receiver of the hub holding the key of the count, and by nobody else' USING ERRCODE = '42501';
  END IF;
  IF p_intake IS NULL OR p_finding IS NULL OR p_condition IS NULL OR p_condition NOT IN ('OK', 'DAMAGED', 'TAMPERED', 'OTHER') THEN
    RAISE EXCEPTION 'a condition names an intake and is one of OK, DAMAGED, TAMPERED and OTHER' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO held FROM public.pickup_intake AS i WHERE i.id = p_intake FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'there is no such intake in the receiver''s hubs' USING ERRCODE = '42501';
  END IF;
  IF held.state IN ('ITEMIZING', 'CLOSED') THEN
    RAISE EXCEPTION 'a condition is recorded after the count and before itemization starts' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT', HINT = 'rule=itemization_started';
  END IF;
  IF held.receiving_mode = 'PHOTO_CHECK_IN' THEN
    -- The condition of a photo intake is a parcel's, found on a parcel that has arrived, once for each parcel, whether or not the vendor is finished.
    IF p_parcel IS NULL THEN
      RAISE EXCEPTION 'the condition of a photo intake is found on a parcel' USING ERRCODE = '23514', DETAIL = 'reason=VALIDATION_FAILED', HINT = 'rule=parcel_required';
    END IF;
    SELECT p.state INTO parcel_state FROM public.intake_parcel AS p WHERE p.id = p_parcel AND p.pickup_intake_id = p_intake;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'a condition is found on a parcel of this intake' USING ERRCODE = '22023';
    END IF;
    IF parcel_state <> 'ARRIVED' THEN
      RAISE EXCEPTION 'a condition is found on a parcel that has arrived' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT', HINT = 'rule=parcel_not_arrived';
    END IF;
    IF EXISTS (SELECT 1 FROM public.pickup_intake_finding AS f WHERE f.intake_parcel_id = p_parcel AND f.kind = 'CONDITION') THEN
      RAISE EXCEPTION 'a condition is recorded once for a parcel: it was recorded already, and what follows is Senior Ops''s' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT', HINT = 'rule=condition_already_recorded';
    END IF;
  ELSE
    IF p_parcel IS NOT NULL THEN
      RAISE EXCEPTION 'an intake that is counted blind has no parcels' USING ERRCODE = '22023';
    END IF;
    IF held.state NOT IN ('READY_FOR_ITEMIZATION', 'RECONCILIATION_REQUIRED') THEN
      RAISE EXCEPTION 'a condition is recorded after the count and before itemization starts' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT', HINT = 'rule=intake_not_counted';
    END IF;
    -- Once: judged by the history under the intake's lock (a second recording waits for the first and then sees its finding), never by what the condition is now, which a recording of OK leaves as it was and
    -- an adjudication may put back.
    IF EXISTS (SELECT 1 FROM public.pickup_intake_finding AS f WHERE f.pickup_intake_id = p_intake AND f.kind = 'CONDITION') THEN
      RAISE EXCEPTION 'a condition is recorded once for an intake: it was recorded already, and what follows is Senior Ops''s' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT', HINT = 'rule=condition_already_recorded';
    END IF;
    IF held.condition <> 'OK' THEN
      RAISE EXCEPTION 'a condition is recorded once: the one that was found stands until it is adjudicated' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT', HINT = 'rule=condition_already_recorded';
    END IF;
  END IF;
  IF p_condition IN ('DAMAGED', 'TAMPERED') AND coalesce(pg_catalog.cardinality(p_evidence), 0) = 0 THEN
    RAISE EXCEPTION 'a condition of damage or tampering carries supporting evidence' USING ERRCODE = '23514', DETAIL = 'reason=REASON_REQUIRED';
  END IF;
  INSERT INTO public.pickup_intake_finding (id, pickup_intake_id, intake_parcel_id, responsible_hub_id, kind, condition, note, evidence_ids, recorded_by)
  VALUES (p_finding, p_intake, p_parcel, held.responsible_hub_id, 'CONDITION', p_condition, nullif(pg_catalog.btrim(p_note), ''), coalesce(p_evidence, ARRAY[]::uuid[]), melarc.current_principal_id());
  next_state := CASE WHEN p_condition <> 'OK' AND held.state = 'READY_FOR_ITEMIZATION' THEN 'RECONCILIATION_REQUIRED' ELSE held.state END;
  IF p_condition <> 'OK' THEN
    IF held.condition = 'OK' THEN
      -- The first condition found is the intake's own.
      UPDATE public.pickup_intake SET condition = p_condition, state = next_state WHERE id = p_intake;
    ELSIF next_state <> held.state THEN
      UPDATE public.pickup_intake SET state = next_state WHERE id = p_intake;
    END IF;
  END IF;
  RETURN QUERY SELECT held.state, next_state;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.record_intake_condition(uuid, uuid, text, text, uuid[], uuid) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.record_intake_condition(uuid, uuid, text, text, uuid[], uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.record_intake_condition(uuid, uuid, text, text, uuid[], uuid) TO melarc_api_runtime;
--> statement-breakpoint
-- melarc.adjudicate_discrepancy as 0096 made it (the last definition), with "Vendor told" a record and nothing else (D-D4): `VENDOR_NOTIFIED` is accepted only after an earlier WRITTEN_OFF of the intake and once, in
-- any state past the count (the intake is past reconciliation by then), sets no condition and moves no state; every other outcome is judged as before, in an intake that is in reconciliation, and each refusal names
-- its rule. It changes no count. Nothing is sent to the vendor.
CREATE OR REPLACE FUNCTION melarc.adjudicate_discrepancy(p_intake uuid, p_finding uuid, p_outcome text, p_condition text, p_note text, p_evidence uuid[])
RETURNS TABLE (previous_state text, resulting_state text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  held public.pickup_intake%ROWTYPE;
  next_state text;
BEGIN
  IF melarc.principal_type() IS DISTINCT FROM 'STAFF' OR coalesce(pg_catalog.current_setting('melarc.authorization_key', true), '') <> 'hub.osd.adjudicate' THEN
    RAISE EXCEPTION 'a discrepancy is adjudicated by Senior Ops holding the key of the adjudication, and by nobody else' USING ERRCODE = '42501';
  END IF;
  IF p_intake IS NULL OR p_finding IS NULL OR p_outcome IS NULL OR p_outcome NOT IN ('ACCEPTED', 'ESCALATED', 'WRITTEN_OFF', 'VENDOR_NOTIFIED')
     OR (p_condition IS NOT NULL AND p_condition NOT IN ('OK', 'DAMAGED', 'TAMPERED', 'OTHER')) THEN
    RAISE EXCEPTION 'an adjudication names an intake and an outcome, and a condition that is one of OK, DAMAGED, TAMPERED and OTHER' USING ERRCODE = '22023';
  END IF;
  IF p_note IS NULL OR pg_catalog.btrim(p_note) = '' THEN
    RAISE EXCEPTION 'an adjudication says why' USING ERRCODE = '23514', DETAIL = 'reason=REASON_REQUIRED';
  END IF;
  SELECT * INTO held FROM public.pickup_intake AS i WHERE i.id = p_intake FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'there is no such intake in the adjudicator''s hubs' USING ERRCODE = '42501';
  END IF;
  IF p_outcome = 'VENDOR_NOTIFIED' THEN
    IF p_condition IS NOT NULL THEN
      RAISE EXCEPTION '"Vendor told" records what was said to the vendor: it sets no condition' USING ERRCODE = '22023';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.pickup_intake_finding AS f WHERE f.pickup_intake_id = p_intake AND f.kind = 'ADJUDICATION' AND f.outcome = 'WRITTEN_OFF') THEN
      RAISE EXCEPTION '"Vendor told" follows a write-off of the intake' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT', HINT = 'rule=not_written_off';
    END IF;
    IF EXISTS (SELECT 1 FROM public.pickup_intake_finding AS f WHERE f.pickup_intake_id = p_intake AND f.kind = 'ADJUDICATION' AND f.outcome = 'VENDOR_NOTIFIED') THEN
      RAISE EXCEPTION '"Vendor told" is recorded once for an intake' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT', HINT = 'rule=vendor_already_told';
    END IF;
  ELSIF held.state <> 'RECONCILIATION_REQUIRED' THEN
    RAISE EXCEPTION 'only an intake in reconciliation is adjudicated' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT', HINT = 'rule=not_awaiting_resolution';
  END IF;
  IF p_condition IN ('DAMAGED', 'TAMPERED') AND coalesce(pg_catalog.cardinality(p_evidence), 0) = 0 THEN
    RAISE EXCEPTION 'a condition of damage or tampering carries supporting evidence' USING ERRCODE = '23514', DETAIL = 'reason=REASON_REQUIRED';
  END IF;
  INSERT INTO public.pickup_intake_finding (id, pickup_intake_id, responsible_hub_id, kind, condition, outcome, note, evidence_ids, recorded_by)
  VALUES (p_finding, p_intake, held.responsible_hub_id, 'ADJUDICATION', p_condition, p_outcome, pg_catalog.btrim(p_note), coalesce(p_evidence, ARRAY[]::uuid[]), melarc.current_principal_id());
  next_state := CASE WHEN p_outcome IN ('ESCALATED', 'VENDOR_NOTIFIED') THEN held.state ELSE 'READY_FOR_ITEMIZATION' END;
  IF p_condition IS NOT NULL OR next_state <> held.state THEN
    UPDATE public.pickup_intake SET condition = coalesce(p_condition, condition), state = next_state WHERE id = p_intake;
  END IF;
  RETURN QUERY SELECT held.state, next_state;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.adjudicate_discrepancy(uuid, uuid, text, text, text, uuid[]) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.adjudicate_discrepancy(uuid, uuid, text, text, text, uuid[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.adjudicate_discrepancy(uuid, uuid, text, text, text, uuid[]) TO melarc_api_runtime;
