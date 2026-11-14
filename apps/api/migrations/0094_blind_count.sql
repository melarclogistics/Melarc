-- S1.33 (SLICE-001): the blind count (submitBlindCount; delivery/planning/SLICE-001-IMPLEMENTATION-PLAN.md S1.33; features/hub/hub-intake.md section 5.1 steps 4 and 5; contracts/state-machines.md section 7;
-- AC-SLICE-001-38, -40, -43 and -76; OB-S1-81; OB-S1-92). Forward of 0093; nothing earlier is edited. This migration is applied as melarc_migration_elevated, a member of melarc_owner
-- (MIGRATION_AND_SEEDING.md section 5.1). No table changes. What it adds:
--
--   * THE COUNT IS COMMITTED BY ONE FUNCTION OF THE DATABASE (melarc.commit_blind_count), because the application's login cannot read the declaration (0092): the function, which runs as the owner for
--     staff under hub.intake.count and for nobody else, locks the intake, requires it to be waiting for its count, reads the declaration, makes the comparison (the difference is the physical count
--     minus the declaration, the variance MATCH, SHORT or OVER), writes the count and takes the intake to COUNTED, and then makes the System's move (state-machines.md section 7): READY_FOR_ITEMIZATION
--     for a count that matches a declaration above zero, RECONCILIATION_REQUIRED for a variance or for a zero declaration whatever the variance. It answers the declaration, which is its first legal
--     appearance, and the photos of the parcels counted at the door (below). The runtime login has no UPDATE on any column of the count, so no statement of it can write a count.
--   * THE COMPARISON IS THE DATABASE'S FOR EVERY WRITER (the guard below, restated from 0093). A count's difference and variance are the comparison of its number with the declaration, its moment is the
--     database's, and the System's two moves are made only for the counts they are for: a count with a variance, a zero declaration or a finding is not cleared for itemization, and a clean one is not
--     sent to reconciliation.
--   * THE PHOTOS FOLLOW THE DECLARATION (D-A10, OB-S1-81): they are read by the same function that serves the declaration of an intake that has been counted, which is now melarc.hub_intake_after_count
--     (it replaces melarc.hub_intake_declarations of 0093), for an intake past AWAITING_COUNT and for no other: the stop's stored parcel photos, in the order they were attached, by the intake's run and
--     request. Before the count no read carries them or their number. The owner reads the stop and the photo links only for these two keys and only in the hubs of the grant.

-- The declaration and the photos of the intakes that have been counted (the function of 0093 with the photos added, under its new name). It answers only an intake past AWAITING_COUNT (a count
-- exists), only to staff under a key that reads intakes, and only the intakes the policies of the tables show that context.
CREATE FUNCTION melarc.hub_intake_after_count(p_intake_ids uuid[]) RETURNS TABLE (intake_id uuid, rider_declared_count integer, parcel_photo_ids uuid[])
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF melarc.principal_type() IS DISTINCT FROM 'STAFF'
     OR coalesce(pg_catalog.current_setting('melarc.authorization_key', true), '') NOT IN ('hub.read', 'hub.intake.count') THEN
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
     WHERE i.id = ANY (p_intake_ids) AND i.state <> 'AWAITING_COUNT' AND i.physical_count IS NOT NULL
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
DROP FUNCTION melarc.hub_intake_declarations(uuid[]);
--> statement-breakpoint
-- The reads of the function, as the owner: the stop that carries the intake's request on its run and the links of that stop's photos, for the keys that read intakes and in the hubs of the grant.
CREATE POLICY "pickup_stop_intake_read" ON "pickup_stop" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_user = 'melarc_owner' AND coalesce(current_setting('melarc.authorization_key', true), '') IN ('hub.read', 'hub.intake.count')
      AND (melarc.hub_scope_mode() = 'ALL' OR "pickup_stop"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "collection_parcel_photo_intake_read" ON "collection_parcel_photo" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_user = 'melarc_owner' AND coalesce(current_setting('melarc.authorization_key', true), '') IN ('hub.read', 'hub.intake.count')
      AND (melarc.hub_scope_mode() = 'ALL' OR "collection_parcel_photo"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
);
--> statement-breakpoint
-- The write of the count, as the owner and nobody else: the function below updates the intake of the hubs of the grant under the key of the count. The runtime login is not the owner, and holds
-- no UPDATE on any column of the count either way.
CREATE POLICY "pickup_intake_count_commit" ON "pickup_intake" FOR UPDATE USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_user = 'melarc_owner' AND coalesce(current_setting('melarc.authorization_key', true), '') = 'hub.intake.count'
      AND (melarc.hub_scope_mode() = 'ALL' OR "pickup_intake"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
) WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_user = 'melarc_owner' AND coalesce(current_setting('melarc.authorization_key', true), '') = 'hub.intake.count'
      AND (melarc.hub_scope_mode() = 'ALL' OR "pickup_intake"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
);
--> statement-breakpoint
-- The guard of an intake as 0093 made it (the last definition), with two branches added: the comparison of a count (a count is the comparison of its number with the declaration, at the database's
-- moment) and the System's move out of COUNTED (the count that is cleared for itemization is clean, and the one sent to reconciliation is not). Nothing else of the function changes.
CREATE OR REPLACE FUNCTION melarc.pickup_intake_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  run_state text;
  run_completed_at timestamp with time zone;
  idle_minutes integer;
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
     OR NEW.prefilled_count IS DISTINCT FROM OLD.prefilled_count THEN
    RAISE EXCEPTION 'an intake keeps its identity, its run, its request, its hub, its handover and its declaration' USING ERRCODE = '23514';
  END IF;
  IF OLD.physical_count IS NOT NULL
     AND (NEW.physical_count IS DISTINCT FROM OLD.physical_count
          OR NEW.counted_at IS DISTINCT FROM OLD.counted_at
          OR NEW.counted_by IS DISTINCT FROM OLD.counted_by
          OR NEW.count_variance IS DISTINCT FROM OLD.count_variance
          OR NEW.count_difference IS DISTINCT FROM OLD.count_difference) THEN
    RAISE EXCEPTION 'a count, once made, is kept as it was' USING ERRCODE = '23514';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state
     AND NOT (
       (OLD.state = 'AWAITING_COUNT' AND NEW.state = 'COUNTED')
       OR (OLD.state = 'COUNTED' AND NEW.state IN ('READY_FOR_ITEMIZATION', 'RECONCILIATION_REQUIRED'))
       OR (OLD.state = 'RECONCILIATION_REQUIRED' AND NEW.state = 'READY_FOR_ITEMIZATION')
       OR (OLD.state = 'READY_FOR_ITEMIZATION' AND NEW.state = 'ITEMIZING')
       OR (OLD.state = 'ITEMIZING' AND NEW.state = 'CLOSED')
       OR (OLD.state = 'CLOSED' AND NEW.state = 'ITEMIZING')
     ) THEN
    RAISE EXCEPTION 'an intake moves from AWAITING_COUNT to COUNTED, from COUNTED to READY_FOR_ITEMIZATION or RECONCILIATION_REQUIRED, from RECONCILIATION_REQUIRED to READY_FOR_ITEMIZATION, then to ITEMIZING and CLOSED, and a closed one is reopened to ITEMIZING, and no other way' USING ERRCODE = '23514';
  END IF;

  -- The count (S1.33; state-machines.md section 7). The comparison is the database's, for every writer: the difference is the physical count minus the declaration, the variance says which side
  -- of it the count is on, and the moment is the database's, whatever the writer gave. A count that has no comparison, or one that is not this one, is refused.
  IF OLD.physical_count IS NULL AND NEW.physical_count IS NOT NULL THEN
    IF NEW.count_difference IS DISTINCT FROM NEW.physical_count - OLD.rider_declared_count
       OR NEW.count_variance IS DISTINCT FROM (
         CASE WHEN NEW.physical_count = OLD.rider_declared_count THEN 'MATCH'
              WHEN NEW.physical_count < OLD.rider_declared_count THEN 'SHORT'
              ELSE 'OVER' END) THEN
      RAISE EXCEPTION 'a count is compared with the declaration by the database: its difference and its variance are that comparison' USING ERRCODE = '23514';
    END IF;
    NEW.counted_at := pg_catalog.clock_timestamp();
  END IF;
  -- The System's move out of COUNTED: a count with a variance, a zero declaration or a finding of condition goes to reconciliation and is not cleared for itemization; a clean one is cleared and is
  -- not sent to reconciliation.
  IF OLD.state = 'COUNTED' AND NEW.state IS DISTINCT FROM OLD.state THEN
    IF OLD.count_variance IS DISTINCT FROM 'MATCH' OR OLD.rider_declared_count = 0 OR OLD.condition <> 'OK' THEN
      IF NEW.state = 'READY_FOR_ITEMIZATION' THEN
        RAISE EXCEPTION 'a count with a variance, a zero declaration or a finding is not cleared for itemization' USING ERRCODE = '23514';
      END IF;
    ELSIF NEW.state = 'RECONCILIATION_REQUIRED' THEN
      RAISE EXCEPTION 'a clean count is not sent to reconciliation' USING ERRCODE = '23514';
    END IF;
  END IF;

  -- The receive lock (S1.32; state-machines.md section 7, "acquire receive lock"). A lock that is taken, kept or refreshed is for an intake that is waiting for its count, before and after the write.
  -- Another receiver takes a held lock over only after the idle time of the hub on the database's clock, and a hub that has none (or none that is usable) offers no takeover. The moment is the
  -- database's, whatever the writer gave. Clearing the lock (both columns null, which the check of the table keeps together) is not judged here: the count that follows, or an operator, may release it.
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
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.pickup_intake_guard() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.pickup_intake_guard() FROM PUBLIC;
--> statement-breakpoint
-- melarc.commit_blind_count: `submitBlindCount`. A receiver of the intake's hub, under the key of the count, commits the physical count of an intake that is waiting for it. The intake is locked first
-- and judged under its lock (it exists in the receiver's hubs, and is waiting for its count), the comparison is made with the declaration the function alone can read, the count is written and the intake
-- goes to COUNTED, and the System's move follows in the same change. It answers what the count's response needs of what the login cannot read: the declaration and the photos, once.
CREATE FUNCTION melarc.commit_blind_count(p_intake uuid, p_physical_count integer) RETURNS TABLE (intake_id uuid, rider_declared_count integer, parcel_photo_ids uuid[])
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
