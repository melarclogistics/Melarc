CREATE TABLE "intake_parcel" (
	"id" uuid PRIMARY KEY NOT NULL,
	"pickup_intake_id" uuid NOT NULL,
	"responsible_hub_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"origin" text NOT NULL,
	"door_photo_evidence_id" uuid,
	"hub_photo_evidence_id" uuid,
	"state" text NOT NULL,
	"arrived_by" uuid,
	"arrived_at" timestamp with time zone,
	"missing_marked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "intake_parcel_origin_closed" CHECK ("intake_parcel"."origin" IN ('DOOR_PHOTO', 'HUB_EXTRA')),
	CONSTRAINT "intake_parcel_state_closed" CHECK ("intake_parcel"."state" IN ('EXPECTED', 'ARRIVED', 'MISSING', 'VOID')),
	CONSTRAINT "intake_parcel_ordinal_positive" CHECK ("intake_parcel"."ordinal" >= 1),
	CONSTRAINT "intake_parcel_origin_facts" CHECK (("intake_parcel"."origin" = 'DOOR_PHOTO' AND "intake_parcel"."door_photo_evidence_id" IS NOT NULL AND "intake_parcel"."hub_photo_evidence_id" IS NULL) OR ("intake_parcel"."origin" = 'HUB_EXTRA' AND "intake_parcel"."hub_photo_evidence_id" IS NOT NULL AND "intake_parcel"."door_photo_evidence_id" IS NULL)),
	CONSTRAINT "intake_parcel_state_facts" CHECK (("intake_parcel"."state" = 'EXPECTED' AND "intake_parcel"."arrived_by" IS NULL AND "intake_parcel"."arrived_at" IS NULL AND "intake_parcel"."missing_marked_at" IS NULL) OR ("intake_parcel"."state" = 'ARRIVED' AND "intake_parcel"."arrived_by" IS NOT NULL AND "intake_parcel"."arrived_at" IS NOT NULL) OR ("intake_parcel"."state" = 'MISSING' AND "intake_parcel"."arrived_by" IS NULL AND "intake_parcel"."arrived_at" IS NULL AND "intake_parcel"."missing_marked_at" IS NOT NULL) OR ("intake_parcel"."state" = 'VOID' AND "intake_parcel"."origin" = 'HUB_EXTRA' AND "intake_parcel"."arrived_by" IS NOT NULL AND "intake_parcel"."arrived_at" IS NOT NULL AND "intake_parcel"."missing_marked_at" IS NULL)),
	CONSTRAINT "intake_parcel_extra_states" CHECK ("intake_parcel"."origin" = 'DOOR_PHOTO' OR "intake_parcel"."state" IN ('ARRIVED', 'VOID'))
);
--> statement-breakpoint
ALTER TABLE "pickup_intake" ADD COLUMN "lock_opened_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pickup_intake" ADD COLUMN "receiving_mode" text DEFAULT 'BLIND_COUNT' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "pickup_intake_id_hub_key" ON "pickup_intake" USING btree ("id","responsible_hub_id");--> statement-breakpoint
ALTER TABLE "intake_parcel" ADD CONSTRAINT "intake_parcel_intake_fkey" FOREIGN KEY ("pickup_intake_id","responsible_hub_id") REFERENCES "public"."pickup_intake"("id","responsible_hub_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_parcel" ADD CONSTRAINT "intake_parcel_door_photo_fkey" FOREIGN KEY ("door_photo_evidence_id") REFERENCES "public"."evidence"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_parcel" ADD CONSTRAINT "intake_parcel_hub_photo_fkey" FOREIGN KEY ("hub_photo_evidence_id") REFERENCES "public"."evidence"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "intake_parcel_id_intake_key" ON "intake_parcel" USING btree ("id","pickup_intake_id");--> statement-breakpoint
CREATE UNIQUE INDEX "intake_parcel_ordinal_key" ON "intake_parcel" USING btree ("pickup_intake_id","ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "intake_parcel_door_photo_key" ON "intake_parcel" USING btree ("door_photo_evidence_id");--> statement-breakpoint
CREATE UNIQUE INDEX "intake_parcel_hub_photo_key" ON "intake_parcel" USING btree ("hub_photo_evidence_id");--> statement-breakpoint
CREATE INDEX "intake_parcel_intake_idx" ON "intake_parcel" USING btree ("pickup_intake_id","state");--> statement-breakpoint
CREATE INDEX "intake_parcel_missing_idx" ON "intake_parcel" USING btree ("responsible_hub_id","missing_marked_at") WHERE "intake_parcel"."state" = 'MISSING';--> statement-breakpoint
ALTER TABLE "pickup_intake" ADD CONSTRAINT "pickup_intake_receiving_mode_closed" CHECK ("pickup_intake"."receiving_mode" IN ('PHOTO_CHECK_IN', 'BLIND_COUNT'));
--> statement-breakpoint
-- THE HAND-WRITTEN PART (Run D, S1.35b). Everything above is generated (drizzle-kit, from src/hub/pickup-intake.schema.ts and src/hub/intake-parcel.schema.ts): the parcel table with its keys and its checks, the two
-- columns the intake gains (the receiving mode and the moment a lock was opened) and the key the parcel's composite foreign key names (the statement order is the generator's, moved so that the key exists before the
-- foreign key that names it). This migration is applied as melarc_migration_elevated, a member of melarc_owner (MIGRATION_AND_SEEDING.md section 5.1). Forward of 0102; nothing earlier is edited.
--
-- RUN D (the Product Owner's decisions of 15 and 16 November 2026, D-D1 to D-D8; features/hub/hub-intake.md; contracts/state-machines.md section 7; domain-model.md sections 6.6 and 6.6a). The hub receives a RUN against
-- the rider's door photos: each vendor is an intake, and an intake whose stop has photos is checked in PARCEL BY PARCEL (one row of intake_parcel for each photo) with nothing hidden from the officer; an intake whose
-- stop Ops let through without photos is still COUNTED BLIND (D-D3). What this migration does:
--
--   * THE RECEIVING MODE IS FIXED BY THE HANDOVER. The guard of the intake derives it from the stop's door photos when the intake is opened (a value a writer gives is not kept) and holds it for ever: a stop whose
--     count carries photos opens a PHOTO_CHECK_IN intake, any other a BLIND_COUNT one. Every intake that exists already is BLIND_COUNT (the column's default). The two new columns are read by the application's login.
--   * THE PARCELS ARE WRITTEN BY OPERATIONS OF THE DATABASE, AS THE OWNER. The application's login holds SELECT on intake_parcel and no write; this migration adds the one operation that opens a photo intake's
--     parcels with the hub handover (melarc.open_intake_parcels, the rider's own key), and 0104 adds the acts of the officers. Staff read a parcel under the three keys that read intakes, in the hubs of the grant; the
--     rider who handed over reads its own intakes' parcels under the key of the handover; a probe policy lets a miss on another hub's parcel be told from an id that matches nothing.
--   * THE GUARD OF A PARCEL HOLDS THE MACHINE FOR EVERY WRITER (state-machines.md section 7): EXPECTED <-> ARRIVED and EXPECTED -> MISSING while the vendor's check-in is open; MISSING -> ARRIVED when a parcel is found
--     while the case is open; an extra born ARRIVED and ARRIVED <-> VOID; the senior's moves; nothing once itemizing has started; and who and when are the database's (the officer in whose name the statement runs, the
--     moment of the clock), never the writer's.
--   * THE GUARD OF THE INTAKE IS RESTATED FROM 0096 (the last definition) for the new rules: the mode; the moment a lock was opened; a photo intake's count is the number of its parcels that arrived, compared with the
--     number expected (the door photos), and may change after it is made only while the case is open or the intake is cleared and before itemizing starts, by the key of a found parcel or an extra (hub.intake.count) or
--     of a senior's correction (hub.osd.adjudicate); a blind count is corrected only by the senior; a correction routes the intake again by the System's rule and a found parcel leaves it where it is; a condition of a
--     parcel may be found before its vendor is finished. Nothing else of the function changes. The version trigger leaves the moment a lock was opened out of what moves the ETag, as it leaves the lock out.
--   * TWO DEFERRED CHECKS, FOR EVERY WRITER AND FAILING CLOSED: a photo intake's door parcels are exactly the door photos of its stop, once each and in their order (and a blind-count intake has none), at the end of the
--     transaction that opens them; and a finished photo intake's count is the number of its parcels that arrived, with no parcel left to check in, while an open one has none missing. Each asserts its own context for
--     its own statements as the system (the capability intake_parcel_check), as 0090's check does, so that a writer that changes its context before the commit cannot make it read nothing and pass; every policy that
--     admits the capability names the owner too, and no login is granted EXECUTE.
--   * THE RIDER'S READ OF THE LINKS OF A STOP'S PHOTOS under the key of the handover (the custody holder may not be the rider who counted, and cannot read the links under their own policy): the guard of the intake
--     derives the mode from them, and the one operation of the handover reads them to open the parcels.

-- The door photos of a stop, in the order they were attached to its count (the order `hub_intake_after_count` answers them in): the place of each is the ordinal of its parcel. It runs with the rights of its invoker, so it
-- sees what the invoker's context may see of the stop and its links.
CREATE FUNCTION melarc.intake_door_photos(p_manifest uuid, p_request uuid) RETURNS TABLE (ordinal integer, evidence_id uuid)
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT (pg_catalog.row_number() OVER (ORDER BY p.attached_at, p.evidence_id))::integer, p.evidence_id
    FROM public.pickup_stop AS s
    JOIN public.collection_parcel_photo AS p ON p.pickup_stop_id = s.id
   WHERE s.pickup_manifest_id = p_manifest AND s.pickup_request_id = p_request
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.intake_door_photos(uuid, uuid) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.intake_door_photos(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.intake_door_photos(uuid, uuid) TO melarc_api_runtime;
--> statement-breakpoint
-- What an intake's parcels say, counted once: how many door photos it expects, how many parcels have arrived (the extras that are not void included), how many are missing, how many extras stand and how many are
-- still to be checked in. A plain function (the rights of its invoker): the guards and the acts judge a photo intake by it.
CREATE FUNCTION melarc.intake_parcel_facts(p_intake uuid) RETURNS TABLE (expected integer, arrived integer, missing integer, extras integer, pending integer)
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT (pg_catalog.count(*) FILTER (WHERE p.origin = 'DOOR_PHOTO'))::integer,
         (pg_catalog.count(*) FILTER (WHERE p.state = 'ARRIVED'))::integer,
         (pg_catalog.count(*) FILTER (WHERE p.state = 'MISSING'))::integer,
         (pg_catalog.count(*) FILTER (WHERE p.origin = 'HUB_EXTRA' AND p.state = 'ARRIVED'))::integer,
         (pg_catalog.count(*) FILTER (WHERE p.state = 'EXPECTED'))::integer
    FROM public.intake_parcel AS p
   WHERE p.pickup_intake_id = p_intake
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.intake_parcel_facts(uuid) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.intake_parcel_facts(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.intake_parcel_facts(uuid) TO melarc_api_runtime;
--> statement-breakpoint
-- What the application's login reads of an intake from now on: the receiving mode and the moment a lock was opened, besides the columns of 0092.
GRANT SELECT ("receiving_mode", "lock_opened_at") ON "pickup_intake" TO melarc_api_runtime;
--> statement-breakpoint
GRANT SELECT ON "intake_parcel" TO melarc_api_runtime;
--> statement-breakpoint
ALTER TABLE "intake_parcel" OWNER TO melarc_owner;
--> statement-breakpoint
ALTER TABLE "intake_parcel" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "intake_parcel" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Who reads a parcel: the staff of the hubs of the grant under the three keys that read intakes, and the rider who handed the intake over under the key of the handover, as 0092 gives the intake itself.
CREATE POLICY "intake_parcel_staff_read" ON "intake_parcel" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN coalesce(current_setting('melarc.authorization_key', true), '') IN ('hub.read', 'hub.intake.count', 'hub.osd.adjudicate')
      AND (melarc.hub_scope_mode() = 'ALL' OR "intake_parcel"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "intake_parcel_handover_read" ON "intake_parcel" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'RIDER' THEN coalesce(current_setting('melarc.authorization_key', true), '') = 'hub.handover.submit'
      AND EXISTS (SELECT 1 FROM "pickup_intake" AS i WHERE i.id = "intake_parcel"."pickup_intake_id" AND i.handed_over_by = melarc.current_rider_id())
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "intake_parcel_probe" ON "intake_parcel" FOR SELECT USING (melarc.principal_type() = 'STAFF' AND id = melarc.scope_probe_id());
--> statement-breakpoint
-- The writes, as the owner and nobody else (the runtime login is not the owner and holds no write): the rider's key opens the door parcels of its own handover, the receiver's key adds an extra, and the receiver's and
-- the senior's keys move a parcel. The guard judges the rest, for every writer, before these checks.
CREATE POLICY "intake_parcel_insert" ON "intake_parcel" FOR INSERT WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'RIDER' THEN current_user = 'melarc_owner' AND coalesce(current_setting('melarc.authorization_key', true), '') = 'hub.handover.submit'
      AND "intake_parcel"."origin" = 'DOOR_PHOTO' AND "intake_parcel"."state" = 'EXPECTED'
    WHEN 'STAFF' THEN current_user = 'melarc_owner' AND coalesce(current_setting('melarc.authorization_key', true), '') = 'hub.intake.count'
      AND "intake_parcel"."origin" = 'HUB_EXTRA' AND "intake_parcel"."state" = 'ARRIVED'
      AND (melarc.hub_scope_mode() = 'ALL' OR "intake_parcel"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "intake_parcel_update" ON "intake_parcel" FOR UPDATE USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_user = 'melarc_owner' AND coalesce(current_setting('melarc.authorization_key', true), '') IN ('hub.intake.count', 'hub.osd.adjudicate')
      AND (melarc.hub_scope_mode() = 'ALL' OR "intake_parcel"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
) WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_user = 'melarc_owner' AND coalesce(current_setting('melarc.authorization_key', true), '') IN ('hub.intake.count', 'hub.osd.adjudicate')
      AND (melarc.hub_scope_mode() = 'ALL' OR "intake_parcel"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
);
--> statement-breakpoint
-- The key of the handover reads the links of the photos of the stops of the runs it reads (the custody holder may not be the rider who counted: the rider's own policy shows it only what it attached), so that the mode of
-- an intake and its parcels are derived from the stop's photos as the database sees them.
CREATE POLICY "collection_parcel_photo_handover_read" ON "collection_parcel_photo" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'RIDER' THEN coalesce(current_setting('melarc.authorization_key', true), '') = 'hub.handover.submit'
      AND EXISTS (SELECT 1 FROM "pickup_stop" AS s WHERE s.id = "collection_parcel_photo"."pickup_stop_id")
    ELSE false
  END
);
--> statement-breakpoint
-- What the capability intake_parcel_check may read, and only as the owner (the pattern of 0090): the intake, its parcels, the stop and the links of its photos. No write.
CREATE POLICY "pickup_intake_parcel_check_read" ON "pickup_intake" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'intake_parcel_check' AND current_user = 'melarc_owner'
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "intake_parcel_parcel_check_read" ON "intake_parcel" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'intake_parcel_check' AND current_user = 'melarc_owner'
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "pickup_stop_parcel_check_read" ON "pickup_stop" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'intake_parcel_check' AND current_user = 'melarc_owner'
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "collection_parcel_photo_parcel_check_read" ON "collection_parcel_photo" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'SYSTEM' THEN melarc.task_capability() = 'intake_parcel_check' AND current_user = 'melarc_owner'
    ELSE false
  END
);
--> statement-breakpoint
-- The guard of a parcel: what no writer may change whatever the policy admits, the machine of state-machines.md section 7 by the key of each act, and who and when (the database's).
CREATE FUNCTION melarc.intake_parcel_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
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
      -- A door parcel is opened with its intake, for an intake that is waiting to be checked in, and is one of the photos of the stop's count in its place (the set is judged again at the end of the transaction).
      IF intake_state <> 'AWAITING_COUNT' OR NEW.state <> 'EXPECTED' THEN
        RAISE EXCEPTION 'a door parcel is opened, expected, for an intake that is waiting to be checked in' USING ERRCODE = '23514';
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM melarc.intake_door_photos(intake_manifest, intake_request) AS d WHERE d.evidence_id = NEW.door_photo_evidence_id AND d.ordinal = NEW.ordinal
      ) THEN
        RAISE EXCEPTION 'a door parcel is one of the photos of the stop''s count, in its place' USING ERRCODE = '23514';
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
ALTER FUNCTION melarc.intake_parcel_guard() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.intake_parcel_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "intake_parcel_guard" BEFORE INSERT OR UPDATE OR DELETE ON "intake_parcel"
  FOR EACH ROW EXECUTE FUNCTION melarc.intake_parcel_guard();
--> statement-breakpoint
-- The guard of an intake as 0096 made it (the last definition), with the rules of Run D added; nothing else of the function changes. The new rules, each for every writer:
--   * the receiving mode is derived from the stop's door photos when the intake is opened and never changes; the moment a lock was opened is the database's;
--   * a photo intake's count is the number of its parcels that arrived, compared with the number expected (the door photos), at the database's moment; it may change after it is made only while the case is open or
--     the intake is cleared and before itemizing starts, by the key of a found parcel or an extra (hub.intake.count) or of a senior's correction (hub.osd.adjudicate); a blind count is corrected by the senior alone;
--   * the System's move out of COUNTED and the routing after a correction follow one rule: cleared for itemization only when nothing is missing, no extra stands, the variance is MATCH, no condition other than OK
--     stands and the declaration is above zero; a correction routes the intake again by it, and a found parcel or an extra leaves an intake in reconciliation where it is;
--   * a condition of a parcel may be found while the vendor's check-in is open (a photo intake), never to put the condition back to OK.
CREATE OR REPLACE FUNCTION melarc.pickup_intake_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  run_state text;
  run_completed_at timestamp with time zone;
  idle_minutes integer;
  act_key text := coalesce(pg_catalog.current_setting('melarc.authorization_key', true), '');
  facts record;
  count_moved boolean;
  routed_clean boolean;
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
  IF OLD.physical_count IS NOT NULL
     AND (NEW.counted_at IS DISTINCT FROM OLD.counted_at OR NEW.counted_by IS DISTINCT FROM OLD.counted_by) THEN
    RAISE EXCEPTION 'a count, once made, is kept as it was' USING ERRCODE = '23514';
  END IF;
  IF OLD.physical_count IS NOT NULL AND count_moved THEN
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
    IF act_key = 'hub.osd.adjudicate' THEN
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
-- The version trigger as 0093 made it, with the moment a lock was opened left out of what moves the version as the lock itself is (the ETag of an intake is the version, and the lock does not substitute for the guards).
CREATE OR REPLACE FUNCTION melarc.pickup_intake_version() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF (to_jsonb(NEW) - 'version' - 'active_receiver_id' - 'lock_acquired_at' - 'lock_opened_at') IS DISTINCT FROM (to_jsonb(OLD) - 'version' - 'active_receiver_id' - 'lock_acquired_at' - 'lock_opened_at') THEN
    NEW.version := OLD.version + 1;
  ELSE
    NEW.version := OLD.version;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.pickup_intake_version() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.pickup_intake_version() FROM PUBLIC;
--> statement-breakpoint
-- The first deferred check: a photo intake's door parcels are exactly the door photos of its stop, once each and in their order, and a blind-count intake has no parcel. Fired for the intake that is opened and for each
-- door parcel that is opened, at the end of the transaction. It asserts its own context as the system for its own statements (0090's pattern) and puts the caller's back, and it raises when it cannot find the intake.
CREATE FUNCTION melarc.intake_parcel_set_check() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
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
  SELECT i.receiving_mode, i.pickup_manifest_id, i.pickup_request_id INTO held FROM public.pickup_intake AS i WHERE i.id = target;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the intake whose parcels were checked is not there to be judged' USING ERRCODE = '23514', CONSTRAINT = 'intake_parcel_set';
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
  PERFORM pg_catalog.set_config('melarc.principal_type', previous_type, true);
  PERFORM pg_catalog.set_config('melarc.task_capability', previous_capability, true);
  RETURN NULL;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.intake_parcel_set_check() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.intake_parcel_set_check() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.intake_parcel_set_check() TO melarc_owner;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "pickup_intake_parcels_set" AFTER INSERT ON "pickup_intake"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION melarc.intake_parcel_set_check();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "intake_parcel_set" AFTER INSERT ON "intake_parcel"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.origin = 'DOOR_PHOTO') EXECUTE FUNCTION melarc.intake_parcel_set_check();
--> statement-breakpoint
-- The second deferred check: a finished photo intake's count is the number of its parcels that arrived, compared with the number expected, and no parcel is left to check in; an intake whose vendor is still being
-- checked in has no parcel missing; a blind-count intake has no parcel. Fired when a parcel is made or changes and when an intake's count or state changes, at the end of the transaction.
CREATE FUNCTION melarc.intake_parcel_count_check() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
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
  SELECT i.receiving_mode, i.state, i.physical_count, i.count_difference, i.count_variance INTO held FROM public.pickup_intake AS i WHERE i.id = target;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the intake whose count was checked is not there to be judged' USING ERRCODE = '23514', CONSTRAINT = 'intake_parcel_count';
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
  PERFORM pg_catalog.set_config('melarc.principal_type', previous_type, true);
  PERFORM pg_catalog.set_config('melarc.task_capability', previous_capability, true);
  RETURN NULL;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.intake_parcel_count_check() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.intake_parcel_count_check() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.intake_parcel_count_check() TO melarc_owner;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "intake_parcel_count" AFTER INSERT OR UPDATE ON "intake_parcel"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION melarc.intake_parcel_count_check();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "pickup_intake_count" AFTER UPDATE OF "state", "physical_count", "count_variance", "count_difference" ON "pickup_intake"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION melarc.intake_parcel_count_check();
--> statement-breakpoint
-- melarc.open_intake_parcels: the hub handover opens the parcels of a photo intake, one for each door photo of its stop, in the order they were attached, in the transaction that opened the intake. The custody
-- holder who handed the run over, under the key of the handover, and nobody else; for an intake of its own that this transaction made and that is waiting to be checked in. It answers how many it opened (none for
-- a blind-count intake) and opens them once. The set is judged again at the end of the transaction for every writer.
CREATE FUNCTION melarc.open_intake_parcels(p_intake uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  held record;
  opened integer;
BEGIN
  IF melarc.principal_type() IS DISTINCT FROM 'RIDER' OR coalesce(pg_catalog.current_setting('melarc.authorization_key', true), '') <> 'hub.handover.submit' THEN
    RAISE EXCEPTION 'the parcels of an intake are opened by the rider that hands it over, under the key of the handover, and by nobody else' USING ERRCODE = '42501';
  END IF;
  IF p_intake IS NULL THEN
    RAISE EXCEPTION 'the parcels opened are the parcels of an intake' USING ERRCODE = '22023';
  END IF;
  SELECT i.receiving_mode, i.pickup_manifest_id, i.pickup_request_id, i.responsible_hub_id, i.handed_over_by, i.handed_over_at, i.state INTO held
    FROM public.pickup_intake AS i WHERE i.id = p_intake;
  IF NOT FOUND OR held.handed_over_by IS DISTINCT FROM melarc.current_rider_id() OR held.handed_over_at < pg_catalog.transaction_timestamp() OR held.state <> 'AWAITING_COUNT' THEN
    RAISE EXCEPTION 'the parcels of an intake are opened by the handover that opened it, in the same transaction' USING ERRCODE = '42501';
  END IF;
  IF held.receiving_mode <> 'PHOTO_CHECK_IN' THEN
    RETURN 0;
  END IF;
  IF EXISTS (SELECT 1 FROM public.intake_parcel AS p WHERE p.pickup_intake_id = p_intake) THEN
    RAISE EXCEPTION 'the parcels of an intake are opened once' USING ERRCODE = '23514';
  END IF;
  INSERT INTO public.intake_parcel (id, pickup_intake_id, responsible_hub_id, ordinal, origin, door_photo_evidence_id, state)
    SELECT pg_catalog.uuidv7(), p_intake, held.responsible_hub_id, d.ordinal, 'DOOR_PHOTO', d.evidence_id, 'EXPECTED'
      FROM melarc.intake_door_photos(held.pickup_manifest_id, held.pickup_request_id) AS d
     ORDER BY d.ordinal;
  GET DIAGNOSTICS opened = ROW_COUNT;
  RETURN opened;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.open_intake_parcels(uuid) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.open_intake_parcels(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.open_intake_parcels(uuid) TO melarc_api_runtime;
