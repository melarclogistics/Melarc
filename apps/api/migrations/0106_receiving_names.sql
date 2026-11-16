-- Run D, S1.35b (OB-S1-106): the names the receiving screens say. The receiving side says WHO: the vendor a parcel came from, the rider who brought the run, the officer who checked a parcel in, who holds the check-in and
-- who recorded a finding, each by display name and never by an identifier or a phone number. Hand-written throughout (no table or column changes here). This migration is applied as melarc_migration_elevated, a member of
-- melarc_owner (MIGRATION_AND_SEEDING.md section 5.1). Forward of 0105; nothing earlier is edited.
--
-- ONE READ, AS THE OWNER, FOR THE INTAKES THE CALLER MAY SEE. melarc.receiving_names(p_intake_ids) answers, for staff holding one of the three keys that read intakes (hub.read, hub.intake.count and hub.osd.adjudicate) and for
-- nobody else, the display names of the parties of the intakes it is asked about and ONLY of the parties of intakes the policies of the hub tables show that context (an intake of another hub, or one that does not exist,
-- names nobody, and the answer says nothing of it):
--   * VENDOR: the sender's display name the dispatch of the run snapshotted into the stop (`sender_display_name`: the organisation's name, or the sender's own name when there is no organisation), one for each intake;
--   * RIDER: the full name of the rider who handed the run over, one for each rider (party_id is the rider);
--   * STAFF: the full name of each officer who appears on those intakes (who counted, who holds the check-in, who checked a parcel in, who recorded a finding), one for each officer (party_id is the officer).
-- A phone number, an e-mail address and every other column of an identity are never selected: the function names the one column it reads.
--
-- THE TWO IDENTITY TABLES ARE READ UNDER A CAPABILITY, NOT THROUGH A POLICY THAT NAMES THE INTAKE TABLES. A policy on staff_identity or rider_identity that named the intake tables would make every other login that reads an
-- identity need SELECT on them (0085 found that out for the request), and a hub-scoped policy would hide the rider of another hub's run. So the function finds the ids it may name from the rows the caller sees, and only then
-- asserts the capability receiving_names for the one statement that reads the names, as the system and as the owner (0090's pattern): every policy that admits the capability names the owner, so a statement of any other login
-- that asserts the label reaches no row. The context is put back before the function returns.

-- What the capability receiving_names may read, and only as the owner: an identity's row, for the one column the function selects. No write.
CREATE POLICY "staff_identity_receiving_names_read" ON "staff_identity" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'receiving_names' AND current_user = 'melarc_owner'
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "rider_identity_receiving_names_read" ON "rider_identity" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'receiving_names' AND current_user = 'melarc_owner'
    ELSE false
  END
);
--> statement-breakpoint
CREATE FUNCTION melarc.receiving_names(p_intake_ids uuid[])
RETURNS TABLE (party text, party_id uuid, intake_id uuid, display_name text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  previous_type text := coalesce(pg_catalog.current_setting('melarc.principal_type', true), '');
  previous_capability text := coalesce(pg_catalog.current_setting('melarc.task_capability', true), '');
  rider_ids uuid[];
  staff_ids uuid[];
BEGIN
  IF melarc.principal_type() IS DISTINCT FROM 'STAFF'
     OR coalesce(pg_catalog.current_setting('melarc.authorization_key', true), '') NOT IN ('hub.read', 'hub.intake.count', 'hub.osd.adjudicate') THEN
    RAISE EXCEPTION 'the names of the receiving side are read by staff that read intakes, and by nobody else' USING ERRCODE = '42501';
  END IF;
  IF p_intake_ids IS NULL OR pg_catalog.cardinality(p_intake_ids) > 1000 THEN
    RAISE EXCEPTION 'the names are asked for at most a thousand intakes at a time' USING ERRCODE = '22023';
  END IF;
  -- As the caller: the vendors, from the stops' snapshots, and the ids of the riders and of the officers that appear on the intakes the caller may see.
  RETURN QUERY
    SELECT 'VENDOR'::text, NULL::uuid, i.id, s.pickup_summary ->> 'sender_display_name'
      FROM public.pickup_intake AS i
      JOIN public.pickup_stop AS s ON s.pickup_manifest_id = i.pickup_manifest_id AND s.pickup_request_id = i.pickup_request_id
     WHERE i.id = ANY (p_intake_ids) AND pg_catalog.btrim(coalesce(s.pickup_summary ->> 'sender_display_name', '')) <> ''
     ORDER BY i.id;
  SELECT coalesce(pg_catalog.array_agg(DISTINCT i.handed_over_by), ARRAY[]::uuid[]) INTO rider_ids
    FROM public.pickup_intake AS i WHERE i.id = ANY (p_intake_ids);
  SELECT coalesce(pg_catalog.array_agg(DISTINCT x.actor), ARRAY[]::uuid[]) INTO staff_ids FROM (
    SELECT i.counted_by AS actor FROM public.pickup_intake AS i WHERE i.id = ANY (p_intake_ids)
    UNION
    SELECT i.active_receiver_id FROM public.pickup_intake AS i WHERE i.id = ANY (p_intake_ids)
    UNION
    SELECT p.arrived_by FROM public.intake_parcel AS p WHERE p.pickup_intake_id = ANY (p_intake_ids)
    UNION
    SELECT f.recorded_by FROM public.pickup_intake_finding AS f WHERE f.pickup_intake_id = ANY (p_intake_ids)
  ) AS x WHERE x.actor IS NOT NULL;
  -- As the system, for the one statement of each kind that reads the names of those ids and no other column.
  PERFORM pg_catalog.set_config('melarc.principal_type', 'SYSTEM', true);
  PERFORM pg_catalog.set_config('melarc.task_capability', 'receiving_names', true);
  RETURN QUERY SELECT 'RIDER'::text, r.id, NULL::uuid, r.full_name FROM public.rider_identity AS r WHERE r.id = ANY (rider_ids) ORDER BY r.id;
  RETURN QUERY SELECT 'STAFF'::text, t.id, NULL::uuid, t.full_name FROM public.staff_identity AS t WHERE t.id = ANY (staff_ids) ORDER BY t.id;
  PERFORM pg_catalog.set_config('melarc.principal_type', previous_type, true);
  PERFORM pg_catalog.set_config('melarc.task_capability', previous_capability, true);
  RETURN;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.receiving_names(uuid[]) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.receiving_names(uuid[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.receiving_names(uuid[]) TO melarc_api_runtime;
