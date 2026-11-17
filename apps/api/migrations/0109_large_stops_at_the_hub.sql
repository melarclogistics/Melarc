-- Run E, 17 November 2026 (OB-S1-132, the Product Owner's decision to implement option A): a vendor's stop of thousands of parcels reaches the hub. Forward of 0103; nothing earlier is edited. Applied as
-- melarc_migration_elevated, a member of melarc_owner (MIGRATION_AND_SEEDING.md section 5.1). No table, column, policy or grant changes.
--
-- WHAT WAS MEASURED (17 November 2026, through the real routes): `submitHubHandover` of one stop took 5.3 s for 500 parcels, was refused (503, the 5 s statement deadline) for 700, and took 17.6 s for
-- 1,000, 61.7 s for 2,000, 129 s for 3,000 and 296 s for 5,000 (the deadlines lifted for the figures): the square of the number of parcels. `finishCheckIn` took 27 to 31 s for 5,000. Each parcel's own
-- work is the cause, and in three places the work of one parcel was the work of all of them:
--   1. melarc.intake_parcel_guard asked, for each door parcel it opened, whether (photo, place) was among the stop's photos, by numbering ALL the photos of the stop (a window over N rows) and picking
--      one: N parcels, N numberings of N photos.
--   2. melarc.intake_parcel_set_check (deferred, for the intake and for each door parcel) judged the whole set again for each parcel: three passes over the stop's photos and its parcels each time.
--   3. melarc.intake_parcel_count_check (deferred, for each parcel that is made or changes) counted all of the intake's parcels each time.
--
-- WHAT THIS DOES, in the discipline of 0108 (the photo check of a count): the guard keeps a per-parcel check that costs a lookup (the photo is one of the stop's photos) and leaves the place to the set
-- check, which already judges it exactly at the end of the transaction for every writer (the guard's own comment said so); each deferred check judges an intake ONCE for a transaction, and a later event
-- for another parcel of the same intake returns at once. Nothing is relaxed, because the shortcut is taken only when the database itself shows that the intake's own deferred event judges the same
-- state at the commit:
--   * the set check: when the intake was OPENED BY THIS TRANSACTION (handed_over_at is the database's moment and no earlier than the transaction's: the test open_intake_parcels already uses), the
--     intake's own insert event judges every door parcel at the end of the transaction, and the setting names the intake as judged since the last statement that changed parcels;
--   * the count check: when the intake's row was WRITTEN BY THIS TRANSACTION (its xmin is the transaction's), the intake's own event (now fired for every insert and update of the row, not only for
--     those of four columns) judges the count at the end, and the setting names the intake as judged since the last statement that changed parcels.
-- A setting alone is never believed (any statement of the runtime login can set one): a parcel of an intake an EARLIER transaction made or wrote is always judged in full. A statement trigger puts the
-- settings back to empty before every statement that changes parcels, so a transaction that asked for its checks early (SET CONSTRAINTS ... IMMEDIATE) and then changes a parcel is judged again.

-- 1. The settings are put back to empty before every statement that changes the parcels.
CREATE FUNCTION melarc.intake_parcels_unchecked() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM pg_catalog.set_config('melarc.parcel_set_checked', '', true);
  PERFORM pg_catalog.set_config('melarc.parcel_count_checked', '', true);
  RETURN NULL;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.intake_parcels_unchecked() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.intake_parcels_unchecked() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "intake_parcel_unchecked" BEFORE INSERT OR UPDATE OR DELETE ON "intake_parcel"
  FOR EACH STATEMENT EXECUTE FUNCTION melarc.intake_parcels_unchecked();
--> statement-breakpoint
-- 2. The guard of a parcel as 0103 made it (the last definition), with one change: a door parcel's photo is checked to be one of the photos of the stop's count by a lookup, and its place is left to the
-- set check of the end of the transaction (below), which judges it for every writer. Nothing else of the function changes.
CREATE OR REPLACE FUNCTION melarc.intake_parcel_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  act_key text := coalesce(pg_catalog.current_setting('melarc.authorization_key', true), '');
  intake_hub uuid;
  intake_state text;
  intake_mode text;
  intake_manifest uuid;
  intake_request uuid;
  evidence_found integer;
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
  IF intake_state IN ('ITEMIZING', 'CLOSED') THEN
    RAISE EXCEPTION 'a parcel does not move once itemizing has started' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT', HINT = 'rule=itemization_started';
  END IF;
  IF NOT (
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
-- 3. The first deferred check as 0103 made it, judged ONCE for an intake that this transaction opened: a door parcel's event returns at once when the setting names the intake as judged since the last
-- statement that changed parcels and the intake was opened by this transaction (its own insert event judges the set at the end of the transaction and is never skipped). Nothing else changes.
CREATE OR REPLACE FUNCTION melarc.intake_parcel_set_check() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  previous_type text := coalesce(pg_catalog.current_setting('melarc.principal_type', true), '');
  previous_capability text := coalesce(pg_catalog.current_setting('melarc.task_capability', true), '');
  target uuid;
  held record;
  expected_count bigint;
  opened_count bigint;
  matched_count bigint;
BEGIN
  PERFORM pg_catalog.set_config('melarc.principal_type', 'SYSTEM', true);
  PERFORM pg_catalog.set_config('melarc.task_capability', 'intake_parcel_check', true);
  IF TG_TABLE_NAME = 'pickup_intake' THEN
    target := NEW.id;
  ELSE
    target := NEW.pickup_intake_id;
  END IF;
  SELECT i.receiving_mode, i.pickup_manifest_id, i.pickup_request_id, i.handed_over_at INTO held FROM public.pickup_intake AS i WHERE i.id = target;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the intake whose parcels were checked is not there to be judged' USING ERRCODE = '23514', CONSTRAINT = 'intake_parcel_set';
  END IF;
  -- 0109: the intake was opened by this transaction, and its set was judged since the last statement that changed parcels: not judged again for each of its parcels.
  IF TG_TABLE_NAME = 'intake_parcel' AND held.handed_over_at >= pg_catalog.transaction_timestamp()
     AND coalesce(pg_catalog.current_setting('melarc.parcel_set_checked', true), '') = target::text THEN
    PERFORM pg_catalog.set_config('melarc.principal_type', previous_type, true);
    PERFORM pg_catalog.set_config('melarc.task_capability', previous_capability, true);
    RETURN NULL;
  END IF;
  IF held.receiving_mode = 'PHOTO_CHECK_IN' THEN
    SELECT pg_catalog.count(*) INTO expected_count FROM melarc.intake_door_photos(held.pickup_manifest_id, held.pickup_request_id);
    SELECT pg_catalog.count(*) INTO opened_count FROM public.intake_parcel AS p WHERE p.pickup_intake_id = target AND p.origin = 'DOOR_PHOTO';
    SELECT pg_catalog.count(*) INTO matched_count
      FROM public.intake_parcel AS p
      JOIN melarc.intake_door_photos(held.pickup_manifest_id, held.pickup_request_id) AS d ON d.evidence_id = p.door_photo_evidence_id AND d.ordinal = p.ordinal
     WHERE p.pickup_intake_id = target AND p.origin = 'DOOR_PHOTO';
    IF expected_count < 1 OR opened_count <> expected_count OR matched_count <> expected_count THEN
      RAISE EXCEPTION 'the door parcels of a photo intake are exactly the door photos of its stop, once each and in their order' USING ERRCODE = '23514', CONSTRAINT = 'intake_parcel_set';
    END IF;
  ELSIF EXISTS (SELECT 1 FROM public.intake_parcel AS p WHERE p.pickup_intake_id = target) THEN
    RAISE EXCEPTION 'an intake that is counted blind has no parcel' USING ERRCODE = '23514', CONSTRAINT = 'intake_parcel_set';
  END IF;
  -- 0109: this intake's set is judged as it stands.
  PERFORM pg_catalog.set_config('melarc.parcel_set_checked', target::text, true);
  PERFORM pg_catalog.set_config('melarc.principal_type', previous_type, true);
  PERFORM pg_catalog.set_config('melarc.task_capability', previous_capability, true);
  RETURN NULL;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.intake_parcel_set_check() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.intake_parcel_set_check() TO melarc_owner;
--> statement-breakpoint
-- 4. The second deferred check as 0103 made it, judged ONCE for an intake whose row this transaction wrote: a parcel's event returns at once when the setting names the intake as judged since the last
-- statement that changed parcels and the intake's row was written by this transaction (its own event, now fired for every insert and update of the row, judges the count at the end and is never skipped).
CREATE OR REPLACE FUNCTION melarc.intake_parcel_count_check() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  previous_type text := coalesce(pg_catalog.current_setting('melarc.principal_type', true), '');
  previous_capability text := coalesce(pg_catalog.current_setting('melarc.task_capability', true), '');
  target uuid;
  held record;
  facts record;
BEGIN
  PERFORM pg_catalog.set_config('melarc.principal_type', 'SYSTEM', true);
  PERFORM pg_catalog.set_config('melarc.task_capability', 'intake_parcel_check', true);
  IF TG_TABLE_NAME = 'pickup_intake' THEN
    target := NEW.id;
  ELSE
    target := NEW.pickup_intake_id;
  END IF;
  SELECT i.receiving_mode, i.state, i.physical_count, i.count_difference, i.count_variance,
         i.xmin::text = (pg_catalog.pg_current_xact_id()::text::bigint % 4294967296)::text AS written_here
    INTO held FROM public.pickup_intake AS i WHERE i.id = target;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the intake whose count was checked is not there to be judged' USING ERRCODE = '23514', CONSTRAINT = 'intake_parcel_count';
  END IF;
  -- 0109: the intake's row was written by this transaction, and its count was judged since the last statement that changed parcels: not judged again for each parcel.
  IF TG_TABLE_NAME = 'intake_parcel' AND held.written_here
     AND coalesce(pg_catalog.current_setting('melarc.parcel_count_checked', true), '') = target::text THEN
    PERFORM pg_catalog.set_config('melarc.principal_type', previous_type, true);
    PERFORM pg_catalog.set_config('melarc.task_capability', previous_capability, true);
    RETURN NULL;
  END IF;
  SELECT * INTO facts FROM melarc.intake_parcel_facts(target);
  IF held.receiving_mode = 'PHOTO_CHECK_IN' THEN
    IF held.state = 'AWAITING_COUNT' THEN
      IF facts.missing <> 0 THEN
        RAISE EXCEPTION 'a vendor that is still being checked in has no parcel missing' USING ERRCODE = '23514', CONSTRAINT = 'intake_parcel_count';
      END IF;
    ELSE
      IF facts.pending <> 0 THEN
        RAISE EXCEPTION 'a vendor that was finished has no parcel left to check in' USING ERRCODE = '23514', CONSTRAINT = 'intake_parcel_count';
      END IF;
      IF held.physical_count IS DISTINCT FROM facts.arrived
         OR held.count_difference IS DISTINCT FROM facts.arrived - facts.expected
         OR held.count_variance IS DISTINCT FROM (
           CASE WHEN facts.arrived = facts.expected THEN 'MATCH'
                WHEN facts.arrived < facts.expected THEN 'SHORT'
                ELSE 'OVER' END) THEN
        RAISE EXCEPTION 'the count of a finished photo intake is the number of its parcels that arrived, against the number expected' USING ERRCODE = '23514', CONSTRAINT = 'intake_parcel_count';
      END IF;
    END IF;
  ELSIF facts.expected <> 0 OR facts.arrived <> 0 OR facts.missing <> 0 OR facts.pending <> 0 OR EXISTS (SELECT 1 FROM public.intake_parcel AS p WHERE p.pickup_intake_id = target) THEN
    RAISE EXCEPTION 'an intake that is counted blind has no parcel' USING ERRCODE = '23514', CONSTRAINT = 'intake_parcel_count';
  END IF;
  -- 0109: this intake's count is judged as it stands.
  PERFORM pg_catalog.set_config('melarc.parcel_count_checked', target::text, true);
  PERFORM pg_catalog.set_config('melarc.principal_type', previous_type, true);
  PERFORM pg_catalog.set_config('melarc.task_capability', previous_capability, true);
  RETURN NULL;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.intake_parcel_count_check() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.intake_parcel_count_check() TO melarc_owner;
--> statement-breakpoint
-- The intake's own count event is the one that is never skipped, so it must fire whenever the intake's row is written by a transaction: an insert, and an update of any column (0103 fired it for four
-- columns only, which was enough while every parcel's event judged for itself).
DROP TRIGGER "pickup_intake_count" ON "pickup_intake";
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "pickup_intake_count" AFTER INSERT OR UPDATE ON "pickup_intake"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION melarc.intake_parcel_count_check();
