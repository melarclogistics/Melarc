CREATE TABLE "intake_parcel_wait" (
	"id" uuid PRIMARY KEY NOT NULL,
	"intake_parcel_id" uuid NOT NULL,
	"pickup_intake_id" uuid NOT NULL,
	"responsible_hub_id" uuid NOT NULL,
	"note" text,
	"marked_by" uuid NOT NULL,
	"marked_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"cleared_at" timestamp with time zone,
	"cleared_by" uuid,
	"cleared_reason" text,
	CONSTRAINT "intake_parcel_wait_note_short_line" CHECK ("intake_parcel_wait"."note" IS NULL OR (btrim("intake_parcel_wait"."note") <> '' AND char_length("intake_parcel_wait"."note") <= 120 AND "intake_parcel_wait"."note" !~ '[[:cntrl:]]')),
	CONSTRAINT "intake_parcel_wait_cleared_together" CHECK (("intake_parcel_wait"."cleared_at" IS NULL AND "intake_parcel_wait"."cleared_by" IS NULL AND "intake_parcel_wait"."cleared_reason" IS NULL) OR ("intake_parcel_wait"."cleared_at" IS NOT NULL AND "intake_parcel_wait"."cleared_by" IS NOT NULL AND "intake_parcel_wait"."cleared_reason" IN ('UNMARKED', 'ORDER_MADE')))
);
--> statement-breakpoint
ALTER TABLE "intake_parcel_wait" ADD CONSTRAINT "intake_parcel_wait_parcel_fkey" FOREIGN KEY ("intake_parcel_id","pickup_intake_id") REFERENCES "public"."intake_parcel"("id","pickup_intake_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "intake_parcel_wait_live_key" ON "intake_parcel_wait" USING btree ("intake_parcel_id") WHERE "intake_parcel_wait"."cleared_at" IS NULL;--> statement-breakpoint
CREATE INDEX "intake_parcel_wait_intake_idx" ON "intake_parcel_wait" USING btree ("pickup_intake_id") WHERE "intake_parcel_wait"."cleared_at" IS NULL;--> statement-breakpoint
CREATE INDEX "intake_parcel_wait_parcel_idx" ON "intake_parcel_wait" USING btree ("intake_parcel_id","marked_at");
--> statement-breakpoint
-- STAGE 7, A PARCEL THE OFFICER IS WAITING ON IS MARKED, ON THE SERVER (Run G1, Part 1, item 2: the Product Owner's decision D-S7-12 of 24 November 2026; contract 5.120.0). The table, its keys and its indexes are Drizzle's,
-- from `intake-parcel-wait.schema.ts`; the rest is hand-written.
--
-- D-S7-11 says a parcel an officer cannot order yet (a label that cannot be read, a missing phone, an address that makes no sense) is the officer's: the officer calls or messages the vendor, gets the details and makes
-- the order. D-S7-12 gives that waiting a mark, **held by the server so that every officer and every tablet sees it**: the parcel is *waiting for the vendor's details*, with an optional short note (what was asked and how).
-- *Make the next order* passes over a marked parcel, the vendor's orders page has a tab of its own for them, and **the mark is cleared when the parcel's order is made** or by an officer. No senior, no money, no new key:
-- the act is `hub.intake.itemize`.
--
--   * intake_parcel_wait: one row for each mark, never deleted; one live mark for a parcel; a mark ends by being cleared (UNMARKED by the officer, ORDER_MADE by the database in the transaction that makes the order).
--     The runtime login holds SELECT alone; the table's own guard holds the rest for every writer.
--   * melarc.intake_parcel_wait_guard: written only under the key to itemize; a mark is made of a parcel of the officer's hubs that still needs an order, in a vendor that is not in reconciliation or past its orders, by
--     the officer and at the moment the database gives; never removed; a cleared mark never changes; only the note of a live mark moves, and the clearing is the one other change.
--   * melarc.set_parcel_vendor_wait(parcel, waiting, note, id): the act (key to itemize): the vendor's intake locked, the states judged, the mark made, its note renewed or ended. It answers the state and whether it changed.
--   * melarc.order_clears_vendor_wait: AFTER an order is inserted for a parcel, the parcel's live mark is cleared (ORDER_MADE), for every writer of an order.
--   * melarc.intake_worklist and melarc.intake_progress, restated from their last definitions (0121 and 0118) with the mark: a parcel row says since when and with what note the parcel is waiting, a view of its own opens the
--     parcels that wait, and the progress counts them. The count is of the parcels that wait AND still need an order; a parcel that needs an order stays counted in `needs_order` (the close counts it as outstanding).

ALTER TABLE "intake_parcel_wait" OWNER TO melarc_owner;
--> statement-breakpoint
ALTER TABLE "intake_parcel_wait" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "intake_parcel_wait" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT ON "intake_parcel_wait" TO melarc_api_runtime;
--> statement-breakpoint
CREATE POLICY "intake_parcel_wait_read" ON "intake_parcel_wait" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN coalesce(current_setting('melarc.authorization_key', true), '') IN ('hub.read', 'hub.intake.itemize')
      AND (melarc.hub_scope_mode() = 'ALL' OR "intake_parcel_wait"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "intake_parcel_wait_insert" ON "intake_parcel_wait" FOR INSERT WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_user = 'melarc_owner' AND coalesce(current_setting('melarc.authorization_key', true), '') = 'hub.intake.itemize'
      AND (melarc.hub_scope_mode() = 'ALL' OR "intake_parcel_wait"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
);
--> statement-breakpoint
CREATE POLICY "intake_parcel_wait_update" ON "intake_parcel_wait" FOR UPDATE USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_user = 'melarc_owner' AND coalesce(current_setting('melarc.authorization_key', true), '') = 'hub.intake.itemize'
      AND (melarc.hub_scope_mode() = 'ALL' OR "intake_parcel_wait"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
) WITH CHECK (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_user = 'melarc_owner' AND coalesce(current_setting('melarc.authorization_key', true), '') = 'hub.intake.itemize'
      AND (melarc.hub_scope_mode() = 'ALL' OR "intake_parcel_wait"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
);
--> statement-breakpoint
CREATE FUNCTION melarc.intake_parcel_wait_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  held public.pickup_intake%ROWTYPE;
  placed public.intake_parcel%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'the mark of a parcel that waits for the vendor''s details is kept as it was and never removed' USING ERRCODE = '23514';
  END IF;
  IF coalesce(pg_catalog.current_setting('melarc.authorization_key', true), '') <> 'hub.intake.itemize' THEN
    RAISE EXCEPTION 'the mark of a parcel that waits for the vendor''s details is written by the act, under the key to itemize' USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.cleared_at IS NOT NULL OR NEW.cleared_by IS NOT NULL OR NEW.cleared_reason IS NOT NULL THEN
      RAISE EXCEPTION 'a mark is made live and ends by a later act' USING ERRCODE = '23514';
    END IF;
    SELECT * INTO placed FROM public.intake_parcel AS p WHERE p.id = NEW.intake_parcel_id AND p.pickup_intake_id = NEW.pickup_intake_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'a mark is of a parcel of the officer''s hubs' USING ERRCODE = '23514';
    END IF;
    SELECT * INTO held FROM public.pickup_intake AS i WHERE i.id = placed.pickup_intake_id;
    IF NOT FOUND OR held.state NOT IN ('AWAITING_COUNT', 'READY_FOR_ITEMIZATION', 'ITEMIZING') THEN
      RAISE EXCEPTION 'a parcel is marked while its vendor is being checked in or ordered for' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT',
        HINT = CASE WHEN held.state = 'RECONCILIATION_REQUIRED' THEN 'rule=reconciliation_open' ELSE 'rule=intake_not_ready' END;
    END IF;
    IF placed.state = 'VOID' THEN
      RAISE EXCEPTION 'a parcel taken back has no order to wait for' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT', HINT = 'rule=parcel_void';
    END IF;
    IF placed.state = 'MISSING' THEN
      RAISE EXCEPTION 'a parcel that is missing is searched for, not waited on' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT', HINT = 'rule=parcel_missing';
    END IF;
    IF EXISTS (SELECT 1 FROM public."order" AS o WHERE o.intake_parcel_id = NEW.intake_parcel_id AND o.commercial_state IS DISTINCT FROM 'REVERSED') THEN
      RAISE EXCEPTION 'a parcel that has its order is not waiting for details' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT', HINT = 'rule=parcel_ordered';
    END IF;
    NEW.responsible_hub_id := placed.responsible_hub_id;
    NEW.marked_by := melarc.current_principal_id();
    NEW.marked_at := pg_catalog.clock_timestamp();
    RETURN NEW;
  END IF;

  -- An update: a mark that has ended is kept as it was; of a live one only the note moves, and the end of the mark is the one other change.
  IF OLD.cleared_at IS NOT NULL THEN
    RAISE EXCEPTION 'a mark that has ended is kept as it was: it was cleared once' USING ERRCODE = '23514';
  END IF;
  IF (pg_catalog.to_jsonb(NEW) - 'note' - 'cleared_at' - 'cleared_by' - 'cleared_reason') IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) - 'note' - 'cleared_at' - 'cleared_by' - 'cleared_reason') THEN
    RAISE EXCEPTION 'the parcel, the hub, the officer and the moment of a mark never change' USING ERRCODE = '23514';
  END IF;
  IF NEW.cleared_at IS NOT NULL THEN
    IF NEW.note IS DISTINCT FROM OLD.note THEN
      RAISE EXCEPTION 'a mark that ends keeps its note' USING ERRCODE = '23514';
    END IF;
    NEW.cleared_at := pg_catalog.clock_timestamp();
    NEW.cleared_by := melarc.current_principal_id();
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.intake_parcel_wait_guard() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.intake_parcel_wait_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "intake_parcel_wait_guard" BEFORE INSERT OR UPDATE OR DELETE ON "intake_parcel_wait"
  FOR EACH ROW EXECUTE FUNCTION melarc.intake_parcel_wait_guard();
--> statement-breakpoint
CREATE FUNCTION melarc.set_parcel_vendor_wait(p_parcel uuid, p_waiting boolean, p_note text, p_id uuid)
RETURNS TABLE (is_waiting boolean, since_at timestamptz, held_note text, did_change boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  said text;
  placed public.intake_parcel%ROWTYPE;
  held public.pickup_intake%ROWTYPE;
  live public.intake_parcel_wait%ROWTYPE;
  has_live boolean;
BEGIN
  IF melarc.principal_type() IS DISTINCT FROM 'STAFF'
     OR coalesce(pg_catalog.current_setting('melarc.authorization_key', true), '') <> 'hub.intake.itemize' THEN
    RAISE EXCEPTION 'a parcel is marked as waiting for the vendor''s details by the officer who holds the key to itemize, and by nobody else' USING ERRCODE = '42501';
  END IF;
  IF p_waiting IS NULL OR p_id IS NULL THEN
    RAISE EXCEPTION 'the mark of a parcel says whether it waits, and has an identifier' USING ERRCODE = '22023';
  END IF;
  said := nullif(pg_catalog.btrim(coalesce(p_note, '')), '');
  IF NOT p_waiting AND said IS NOT NULL THEN
    RAISE EXCEPTION 'a note belongs to a mark, not to the end of one' USING ERRCODE = '22023';
  END IF;
  -- The vendor's intake first (every act of the hub takes it before anything under it), then the parcel as the officer's hubs show it.
  SELECT i.* INTO held FROM public.pickup_intake AS i
   WHERE i.id = (SELECT p.pickup_intake_id FROM public.intake_parcel AS p WHERE p.id = p_parcel) FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'there is no such parcel in the officer''s hubs' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO placed FROM public.intake_parcel AS p WHERE p.id = p_parcel;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'there is no such parcel in the officer''s hubs' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO live FROM public.intake_parcel_wait AS w WHERE w.intake_parcel_id = p_parcel AND w.cleared_at IS NULL;
  has_live := FOUND;

  IF NOT p_waiting THEN
    -- Taking a mark off is idempotent: nothing to take off is nothing to do, whatever the state of the vendor.
    IF NOT has_live THEN
      RETURN QUERY SELECT false, NULL::timestamptz, NULL::text, false;
      RETURN;
    END IF;
    UPDATE public.intake_parcel_wait SET cleared_at = pg_catalog.clock_timestamp(), cleared_by = melarc.current_principal_id(), cleared_reason = 'UNMARKED' WHERE id = live.id;
    RETURN QUERY SELECT false, NULL::timestamptz, NULL::text, true;
    RETURN;
  END IF;

  -- Marking: the states are judged here in the order the other acts of the hub judge them, and the guard of the table repeats every rule for every writer.
  IF held.state NOT IN ('AWAITING_COUNT', 'READY_FOR_ITEMIZATION', 'ITEMIZING') THEN
    RAISE EXCEPTION 'a parcel is marked while its vendor is being checked in or ordered for' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT',
      HINT = CASE WHEN held.state = 'RECONCILIATION_REQUIRED' THEN 'rule=reconciliation_open' ELSE 'rule=intake_not_ready' END;
  END IF;
  IF placed.state = 'VOID' THEN
    RAISE EXCEPTION 'a parcel taken back has no order to wait for' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT', HINT = 'rule=parcel_void';
  END IF;
  IF placed.state = 'MISSING' THEN
    RAISE EXCEPTION 'a parcel that is missing is searched for, not waited on' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT', HINT = 'rule=parcel_missing';
  END IF;
  IF EXISTS (SELECT 1 FROM public."order" AS o WHERE o.intake_parcel_id = p_parcel AND o.commercial_state IS DISTINCT FROM 'REVERSED') THEN
    RAISE EXCEPTION 'a parcel that has its order is not waiting for details' USING ERRCODE = '23514', DETAIL = 'reason=STATE_CONFLICT', HINT = 'rule=parcel_ordered';
  END IF;
  IF has_live THEN
    IF live.note IS NOT DISTINCT FROM said THEN
      RETURN QUERY SELECT true, live.marked_at, live.note, false;
      RETURN;
    END IF;
    UPDATE public.intake_parcel_wait SET note = said WHERE id = live.id;
    RETURN QUERY SELECT true, live.marked_at, said, true;
    RETURN;
  END IF;
  INSERT INTO public.intake_parcel_wait (id, intake_parcel_id, pickup_intake_id, responsible_hub_id, note, marked_by)
  VALUES (p_id, p_parcel, placed.pickup_intake_id, placed.responsible_hub_id, said, melarc.current_principal_id());
  RETURN QUERY SELECT true, w.marked_at, w.note, true FROM public.intake_parcel_wait AS w WHERE w.id = p_id;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.set_parcel_vendor_wait(uuid, boolean, text, uuid) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.set_parcel_vendor_wait(uuid, boolean, text, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.set_parcel_vendor_wait(uuid, boolean, text, uuid) TO melarc_api_runtime;
--> statement-breakpoint
CREATE FUNCTION melarc.order_clears_vendor_wait() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  -- The parcel's order is made: the officer is no longer waiting for details. For every writer of an order, in its own transaction.
  IF NEW.intake_parcel_id IS NOT NULL THEN
    UPDATE public.intake_parcel_wait SET cleared_at = pg_catalog.clock_timestamp(), cleared_by = melarc.current_principal_id(), cleared_reason = 'ORDER_MADE'
     WHERE intake_parcel_id = NEW.intake_parcel_id AND cleared_at IS NULL;
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.order_clears_vendor_wait() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.order_clears_vendor_wait() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "order_clears_vendor_wait" AFTER INSERT ON "order"
  FOR EACH ROW EXECUTE FUNCTION melarc.order_clears_vendor_wait();
--> statement-breakpoint
DROP FUNCTION melarc.intake_worklist(uuid, text, bigint, uuid, integer);
--> statement-breakpoint
CREATE FUNCTION melarc.intake_worklist(p_intake uuid, p_view text, p_after_n bigint, p_after_id uuid, p_limit integer)
RETURNS TABLE (n bigint, row_id uuid, parcel_id uuid, parcel_ordinal integer, parcel_origin text, parcel_state text, door_photo_evidence_id uuid, hub_photo_evidence_id uuid,
               order_id uuid, order_code text, recipient_name text, service_area text, size_class text, commercial_state text, order_confirmed boolean, payment_required boolean, work_state text,
               reversed_order_id uuid, reversed_order_code text, waiting_since timestamptz, waiting_note text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
BEGIN
  IF melarc.principal_type() IS DISTINCT FROM 'STAFF'
     OR coalesce(pg_catalog.current_setting('melarc.authorization_key', true), '') <> 'hub.read' THEN
    RAISE EXCEPTION 'the worklist of an intake is read by staff that read intakes, and by nobody else' USING ERRCODE = '42501';
  END IF;
  IF p_view IS NULL OR p_view NOT IN ('all', 'needs_order', 'awaiting_arrival', 'prepared', 'itemized', 'payment_required', 'missing', 'waiting_for_vendor') OR p_limit IS NULL OR p_limit < 1 THEN
    RAISE EXCEPTION 'the worklist takes a view and a limit of one or more' USING ERRCODE = '22023';
  END IF;
  IF (p_after_n IS NULL) <> (p_after_id IS NULL) THEN
    RAISE EXCEPTION 'a position in the worklist is a place and a row together' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
    SELECT w.n, w.row_id, w.parcel_id, w.parcel_ordinal, w.parcel_origin, w.parcel_state, w.door_photo_evidence_id, w.hub_photo_evidence_id, w.order_id, w.order_code, w.recipient_name,
           w.service_area, w.size_class, w.commercial_state, w.order_confirmed, w.payment_required, w.work_state, w.reversed_order_id, w.reversed_order_code, w.waiting_since, w.waiting_note
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
                   rv.id AS reversed_order_id, rv.code AS reversed_order_code,
                   -- The officer is waiting on the vendor for this parcel: a live mark, while the parcel still needs its order.
                   CASE WHEN o.id IS NULL AND p.state IN ('EXPECTED', 'ARRIVED') THEN wt.marked_at END AS waiting_since,
                   CASE WHEN o.id IS NULL AND p.state IN ('EXPECTED', 'ARRIVED') THEN wt.note END AS waiting_note
              FROM public.intake_parcel AS p
              -- An order that was reversed is history: the parcel's order is the one that stands (a parcel that is found again is ordered afresh).
              LEFT JOIN public."order" AS o ON o.intake_parcel_id = p.id AND o.commercial_state IS DISTINCT FROM 'REVERSED'
              -- The live mark of the parcel, if any: one at most (a partial unique key).
              LEFT JOIN public.intake_parcel_wait AS wt ON wt.intake_parcel_id = p.id AND wt.cleared_at IS NULL
              -- The latest order of the parcel that was taken back, in ONE lookup of the parcel; the intake is named beside the parcel, and the partial index of 0121 (order_reversed_parcel_idx) answers it.
              LEFT JOIN LATERAL (
                SELECT r.id, r.code
                  FROM public."order" AS r
                 WHERE r.intake_parcel_id = p.id AND r.pickup_intake_id = p.pickup_intake_id AND r.commercial_state = 'REVERSED'
                 ORDER BY r.created_at DESC, r.id DESC
                 LIMIT 1
              ) AS rv ON true
             WHERE p.pickup_intake_id = p_intake AND p.state <> 'VOID'
            UNION ALL
            SELECT pg_catalog.row_number() OVER (ORDER BY o.created_at, o.id), o.id, NULL::uuid, NULL::integer, NULL::text, NULL::text, NULL::uuid, NULL::uuid,
                   o.id, o.code, o.recipient ->> 'name',
                   coalesce(o.destination_zone_snapshot ->> 'service_area', o.destination_zone_snapshot ->> 'scope'),
                   o.size_class, o.commercial_state, coalesce(o.locked_at IS NOT NULL, false), coalesce(o.commercial_state = 'PAYMENT_REQUIRED', false), NULL::uuid, NULL::text,
                   NULL::timestamptz, NULL::text
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
            OR (p_view = 'missing' AND w.work_state = 'MISSING')
            OR (p_view = 'waiting_for_vendor' AND w.waiting_since IS NOT NULL))
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
DROP FUNCTION melarc.intake_progress(uuid);
--> statement-breakpoint
CREATE FUNCTION melarc.intake_progress(p_intake uuid)
RETURNS TABLE (state text, receiving_mode text, received integer, awaiting_arrival integer, needs_order integer, prepared integer, itemized integer, payment_required integer, missing integer, orders integer, waiting_for_vendor integer)
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
           (pg_catalog.count(*) FILTER (WHERE o.id IS NOT NULL AND p.state IN ('EXPECTED', 'ARRIVED')))::integer,
           -- The parcels the officer is waiting on the vendor for: a live mark on a parcel that still needs its order (the rows the view of this name opens).
           (pg_catalog.count(*) FILTER (WHERE wt.id IS NOT NULL AND o.id IS NULL AND p.state IN ('EXPECTED', 'ARRIVED')))::integer
      INTO received, awaiting_arrival, needs_order, prepared, itemized, payment_required, missing, orders, waiting_for_vendor
      FROM public.intake_parcel AS p
      LEFT JOIN public."order" AS o ON o.intake_parcel_id = p.id AND o.commercial_state IS DISTINCT FROM 'REVERSED'
      LEFT JOIN public.intake_parcel_wait AS wt ON wt.intake_parcel_id = p.id AND wt.cleared_at IS NULL
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
    -- A vendor counted blind has no parcel to mark.
    waiting_for_vendor := 0;
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
