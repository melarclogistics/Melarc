-- STAGE 7, THE READS A SCREEN CANNOT DO WITHOUT (the external review of 19 November 2026, findings A and OB-S1-147; itemization.md sections 5.1 to 5.3).
--
--   * melarc.intake_worklist(intake, view, after, limit): THE PARCEL WORKLIST OF AN INTAKE. One row for each parcel that is not void (a photo intake) or each order (a blind-count intake): what the parcel is, what its order
--     is and which of five states the pair is in (NEEDS_ORDER, AWAITING_ARRIVAL, PREPARED, ITEMIZED, MISSING). It carries **no price, no portion and no recipient phone**: the money is `getOrder`'s, under pricing.read,
--     and `hub.read` does not open it. The order table is read through this function and no other way under that key (the policy names the owner, so the runtime login cannot select a row of it under hub.read).
--   * melarc.intake_progress(intake): THE COUNTS OF THE WHOLE INTAKE, never of a page: received, still expected, needing an order, prepared (an order whose price is not frozen), itemized, payment required, missing.
--   * melarc.intake_closure_assessment(intake): WHAT A CLOSE WOULD FIND, for the officer to read before the irreversible act: received, ordered, not priced, payment required, missing, and the received parcels that
--     still have no order, named. The database repeats every rule when it closes (0112).
--   * melarc.correction_names(correction ids): the display names of the maker and of the checker of the corrections a reader may see (the capability of 0106, for the one statement that reads the names).
-- Each is for the staff of the hubs of the grant under its own keys and for nobody else (42501), judges its arguments (22023) and reads as the owner under the policies of the tables.

CREATE POLICY "order_worklist_read" ON "order" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_user = 'melarc_owner' AND coalesce(current_setting('melarc.authorization_key', true), '') = 'hub.read'
      AND (melarc.hub_scope_mode() = 'ALL' OR "order"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
);
--> statement-breakpoint
CREATE FUNCTION melarc.intake_worklist(p_intake uuid, p_view text, p_after_n bigint, p_after_id uuid, p_limit integer)
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
            OR (p_view = 'awaiting_arrival' AND w.work_state = 'AWAITING_ARRIVAL')
            OR (p_view = 'prepared' AND w.work_state = 'PREPARED')
            OR (p_view = 'itemized' AND w.work_state = 'ITEMIZED')
            OR (p_view = 'payment_required' AND w.payment_required)
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
CREATE FUNCTION melarc.intake_progress(p_intake uuid)
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
    received := coalesce(held.physical_count, 0);
    awaiting_arrival := 0;
    needs_order := GREATEST(coalesce(held.physical_count, 0) - orders, 0);
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
CREATE FUNCTION melarc.intake_closure_assessment(p_intake uuid)
RETURNS TABLE (state text, receiving_mode text, received integer, ordered integer, unpriced integer, payment_required integer, missing integer, outstanding_count integer, outstanding_parcels jsonb,
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
  received := coalesce(held.physical_count, 0);
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
                    FILTER (WHERE q.rank <= 100), '[]'::jsonb)
      INTO outstanding_count, outstanding_parcels
      FROM (
        SELECT p.id, p.ordinal, p.origin, p.door_photo_evidence_id, p.hub_photo_evidence_id, pg_catalog.row_number() OVER (ORDER BY p.ordinal) AS rank
          FROM public.intake_parcel AS p
         WHERE p.pickup_intake_id = p_intake AND p.state = 'ARRIVED' AND NOT EXISTS (SELECT 1 FROM public."order" AS o WHERE o.intake_parcel_id = p.id AND o.commercial_state IS DISTINCT FROM 'REVERSED')
      ) AS q;
  ELSE
    outstanding_count := GREATEST(received - ordered, 0);
    outstanding_parcels := '[]'::jsonb;
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
CREATE FUNCTION melarc.correction_names(p_correction_ids uuid[])
RETURNS TABLE (staff_id uuid, display_name text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  previous_type text := coalesce(pg_catalog.current_setting('melarc.principal_type', true), '');
  previous_capability text := coalesce(pg_catalog.current_setting('melarc.task_capability', true), '');
  staff_ids uuid[];
BEGIN
  IF melarc.principal_type() IS DISTINCT FROM 'STAFF'
     OR coalesce(pg_catalog.current_setting('melarc.authorization_key', true), '') NOT IN ('pricing.correction.create', 'pricing.correction.approve') THEN
    RAISE EXCEPTION 'the names of a correction are read by the officers who make and decide corrections, and by nobody else' USING ERRCODE = '42501';
  END IF;
  IF p_correction_ids IS NULL OR pg_catalog.cardinality(p_correction_ids) > 1000 THEN
    RAISE EXCEPTION 'the names are asked for at most a thousand corrections at a time' USING ERRCODE = '22023';
  END IF;
  -- As the caller: the officers named on the corrections the caller may see.
  SELECT coalesce(pg_catalog.array_agg(DISTINCT x.actor), ARRAY[]::uuid[]) INTO staff_ids FROM (
    SELECT c.requested_by AS actor FROM public.payer_correction AS c WHERE c.id = ANY (p_correction_ids)
    UNION
    SELECT c.decided_by FROM public.payer_correction AS c WHERE c.id = ANY (p_correction_ids)
  ) AS x WHERE x.actor IS NOT NULL;
  -- As the system, for the one statement that reads the names of those ids and no other column (the capability of 0106).
  PERFORM pg_catalog.set_config('melarc.principal_type', 'SYSTEM', true);
  PERFORM pg_catalog.set_config('melarc.task_capability', 'receiving_names', true);
  RETURN QUERY SELECT t.id, t.full_name FROM public.staff_identity AS t WHERE t.id = ANY (staff_ids) ORDER BY t.id;
  PERFORM pg_catalog.set_config('melarc.principal_type', previous_type, true);
  PERFORM pg_catalog.set_config('melarc.task_capability', previous_capability, true);
  RETURN;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.correction_names(uuid[]) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.correction_names(uuid[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.correction_names(uuid[]) TO melarc_api_runtime;
