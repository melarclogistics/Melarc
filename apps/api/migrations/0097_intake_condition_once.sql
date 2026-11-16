CREATE UNIQUE INDEX "pickup_intake_finding_one_condition_idx" ON "pickup_intake_finding" USING btree ("pickup_intake_id") WHERE "pickup_intake_finding"."kind" = 'CONDITION';
--> statement-breakpoint
-- THE HAND-WRITTEN PART (the audit of 15 November 2026, point 1). Everything above is generated (drizzle-kit, from src/hub/pickup-intake-finding.schema.ts). This migration is applied as melarc_migration_elevated, a
-- member of melarc_owner (MIGRATION_AND_SEEDING.md section 5.1). Forward of 0096; nothing earlier is edited.
--
-- A CONDITION IS RECORDED ONCE FOR AN INTAKE, and it is the history of the findings that says so. 0096 judged "once" by what the intake's condition is now (`condition <> 'OK'`), and a recording of OK leaves it as it
-- was (a finding that changes nothing), so a second recording, with a fresh ETag and a fresh key, was taken as the first; and a condition Senior Ops had put back to OK gave the receiver another turn, although
-- the corrections are Senior Ops's. Two holds follow, and each is for every writer:
--   * THE OPERATION refuses, under the intake's lock it already holds, an intake that has a finding of kind CONDITION, whatever that finding said and whatever was adjudicated since (STATE_CONFLICT; the
--     service gives it the rule `condition_already_recorded`). It still refuses an intake whose condition is not OK although no receiver recorded it (Senior Ops set it): that one stands until it is adjudicated.
--   * THE TABLE holds one CONDITION finding for each intake in a unique index (above), so that no writer, the owner included, and no race can append a second. An adjudication is not a recording of a condition:
--     there may be as many as there are. If an environment already holds two recordings for one intake (they were possible until this migration), the index is not built, the run stops, and the duplicates are for
--     the Product Owner to judge: a finding is never removed (the guard of the table).
-- No column, policy or grant changes: the function is restated and the table gains one index.
CREATE OR REPLACE FUNCTION melarc.record_intake_condition(p_intake uuid, p_finding uuid, p_condition text, p_note text, p_evidence uuid[])
RETURNS TABLE (previous_state text, resulting_state text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  held public.pickup_intake%ROWTYPE;
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
  IF held.state NOT IN ('READY_FOR_ITEMIZATION', 'RECONCILIATION_REQUIRED') THEN
    RAISE EXCEPTION 'a condition is recorded after the count and before itemization starts' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT';
  END IF;
  -- Once: judged by the history under the intake's lock (a second recording waits for the first and then sees its finding), never by what the condition is now, which a recording of OK leaves as it was and
  -- an adjudication may put back.
  IF EXISTS (SELECT 1 FROM public.pickup_intake_finding AS f WHERE f.pickup_intake_id = p_intake AND f.kind = 'CONDITION') THEN
    RAISE EXCEPTION 'a condition is recorded once for an intake: it was recorded already, and what follows is Senior Ops''s' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT';
  END IF;
  IF held.condition <> 'OK' THEN
    RAISE EXCEPTION 'a condition is recorded once: the one that was found stands until it is adjudicated' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT';
  END IF;
  IF p_condition IN ('DAMAGED', 'TAMPERED') AND coalesce(pg_catalog.cardinality(p_evidence), 0) = 0 THEN
    RAISE EXCEPTION 'a condition of damage or tampering carries supporting evidence' USING ERRCODE = '23514', DETAIL = 'reason=REASON_REQUIRED';
  END IF;
  INSERT INTO public.pickup_intake_finding (id, pickup_intake_id, responsible_hub_id, kind, condition, note, evidence_ids, recorded_by)
  VALUES (p_finding, p_intake, held.responsible_hub_id, 'CONDITION', p_condition, nullif(pg_catalog.btrim(p_note), ''), coalesce(p_evidence, ARRAY[]::uuid[]), melarc.current_principal_id());
  next_state := CASE WHEN p_condition <> 'OK' AND held.state = 'READY_FOR_ITEMIZATION' THEN 'RECONCILIATION_REQUIRED' ELSE held.state END;
  IF p_condition <> 'OK' THEN
    UPDATE public.pickup_intake SET condition = p_condition, state = next_state WHERE id = p_intake;
  END IF;
  RETURN QUERY SELECT held.state, next_state;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.record_intake_condition(uuid, uuid, text, text, uuid[]) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.record_intake_condition(uuid, uuid, text, text, uuid[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.record_intake_condition(uuid, uuid, text, text, uuid[]) TO melarc_api_runtime;
