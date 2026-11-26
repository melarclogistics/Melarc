-- STAGE 7, THE WORKLIST READS ITS REVERSED ORDERS BY AN INDEX (Run F, Part 1, item 2 of the review of 23 November 2026; contract 5.119.0). Hand-written but for the index, which Drizzle generated from `order.schema.ts`.
--
-- `melarc.intake_worklist` (0114, restated by 0118) found the latest reversed order of each parcel by two scalar subqueries, `r.intake_parcel_id = p.id AND r.commercial_state = 'REVERSED'`, one for its id and one for its code.
-- The partial unique index of 0115 (`order_parcel_key`) holds the orders that STAND (`commercial_state IS DISTINCT FROM 'REVERSED'`), and `order_intake_idx` starts with the intake, which the condition did not name:
-- no index could serve either subquery, so each parcel row scanned the whole order table twice, for every page of the worklist.
--
-- The condition now names the intake beside the parcel, the two lookups are ONE lateral lookup, and a partial index of the reversed orders (`order_reversed_parcel_idx`, by parcel and newest first, the order the lookup
-- asks for) answers it by one probe of the parcel. The function is restated from 0118's text with that one change: the columns, their order, the views, the paging and the refusals are the same.
--
-- NO PERMISSION CHANGES. The function keeps its owner and its grants (stated again below, as every restatement of a definer function here does) and the index is the table's own.

CREATE INDEX "order_reversed_parcel_idx" ON "order" USING btree ("intake_parcel_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "order"."commercial_state" = 'REVERSED';
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
                   rv.id AS reversed_order_id, rv.code AS reversed_order_code
              FROM public.intake_parcel AS p
              -- An order that was reversed is history: the parcel's order is the one that stands (a parcel that is found again is ordered afresh).
              LEFT JOIN public."order" AS o ON o.intake_parcel_id = p.id AND o.commercial_state IS DISTINCT FROM 'REVERSED'
              -- The latest order of the parcel that was taken back, in ONE lookup of the parcel (two scalar lookups scanned the table once each for every parcel row). The intake is named beside the parcel, and
              -- the partial index of this migration (order_reversed_parcel_idx) answers it in the order asked for, newest first.
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
