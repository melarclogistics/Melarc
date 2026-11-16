-- Run D, S1.35b (the reads of receiving by run): the queue BY RUN, the run's page and the missing parcels need the run's CODE, its service date and the hub's name, and a vendor's name to find a run by. The run is a pickup manifest,
-- which the key hub.read cannot read (the policies of pickup_manifest name the keys of the pickup domain), and the receiving side must not be given the manifest's other columns. Hand-written throughout (no table or column
-- changes here). This migration is applied as melarc_migration_elevated, a member of melarc_owner (MIGRATION_AND_SEEDING.md section 5.1). Forward of 0106; nothing earlier is edited.
--
--   * ONE POLICY: the owner reads the manifests of the hubs of the grant under the three keys that read intakes (hub.read, hub.intake.count, hub.osd.adjudicate), and only as the owner (`current_user`), so that no
--     statement of the runtime login reaches a manifest by it: the policy exists for the three functions below, which select the code, the service date and nothing else of a manifest.
--   * melarc.receiving_runs(hub, view, q, after, limit, run): THE ONE CRITERIA of the queue by run. A row for each run whose hub handover opened intakes in the hubs of the grant: its code, its hub, its date, the rider who
--     handed it over (the first intake's), the earliest handover, and the counts of its vendors (waiting, needing a decision, blind-count), the parcels its door photos expect and the parcels of its open cases that are
--     missing. `view` is the list's filter (waiting = a vendor still waits to be checked in, needs_decision = a vendor is in reconciliation, all); `q` finds a run by its code and an intake by its code, its run's code or its
--     vendor's name (the stop's dispatch snapshot), without regard to case; `hub` narrows and never widens; `run` asks for one run. The list and the count of the queue (`getQueueSummary`) call this one function, so that a
--     count is what the list returns and the two cannot drift. It names no declared count: a blind-count vendor is counted, never given a number (D-D3).
--   * melarc.missing_parcels(hub, view, after, limit): THE ONE CRITERIA of the list *Missing - being searched for* and of its count. `searching` is the parcels in state MISSING of an intake in RECONCILIATION_REQUIRED (the case
--     is open); `vendor_to_tell` is the parcels of an intake that has a WRITTEN_OFF finding and no VENDOR_NOTIFIED one (the provisional second view of hub-intake.md section 5.7). Each answers the door photo's evidence id (no
--     address, no key), the vendor (the stop's snapshot), the run and how long the parcel has been missing.
--   * melarc.receiving_run_codes(manifest ids): the codes of the runs of the intakes a read is about, for the answers that name a run (`run_code`), asked at most a thousand at a time.
-- Each is for staff that read intakes and for nobody else (42501), judges its arguments (22023) and reads the tables as the owner under the policies of the hub tables, so a hub outside the grant is never shown.

CREATE POLICY "pickup_manifest_receiving_read" ON "pickup_manifest" FOR SELECT USING (
  CASE melarc.principal_type()
    WHEN 'STAFF' THEN current_user = 'melarc_owner' AND coalesce(current_setting('melarc.authorization_key', true), '') IN ('hub.read', 'hub.intake.count', 'hub.osd.adjudicate')
      AND (melarc.hub_scope_mode() = 'ALL' OR "pickup_manifest"."responsible_hub_id" = ANY (melarc.authorized_hub_ids()))
    ELSE false
  END
);
--> statement-breakpoint
CREATE FUNCTION melarc.receiving_runs(p_hub uuid, p_view text, p_q text, p_after_at timestamp with time zone, p_after_run uuid, p_limit integer, p_run uuid DEFAULT NULL)
RETURNS TABLE (run_id uuid, run_code text, hub_id uuid, hub_name text, service_date date, rider_id uuid, handed_over_at timestamp with time zone, vendors_total integer, vendors_waiting integer,
               vendors_needing_decision integer, blind_count_vendors integer, parcels_expected integer, missing_searching integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  needle text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_q, '')));
BEGIN
  IF melarc.principal_type() IS DISTINCT FROM 'STAFF'
     OR coalesce(pg_catalog.current_setting('melarc.authorization_key', true), '') NOT IN ('hub.read', 'hub.intake.count', 'hub.osd.adjudicate') THEN
    RAISE EXCEPTION 'the queue of runs is read by staff that read intakes, and by nobody else' USING ERRCODE = '42501';
  END IF;
  IF p_view IS NULL OR p_view NOT IN ('waiting', 'needs_decision', 'all') OR p_limit IS NULL OR p_limit < 1 THEN
    RAISE EXCEPTION 'the queue of runs takes a view (waiting, needs_decision or all) and a limit of one or more' USING ERRCODE = '22023';
  END IF;
  IF (p_after_at IS NULL) <> (p_after_run IS NULL) THEN
    RAISE EXCEPTION 'a position in the queue is a moment and a run together' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
    SELECT g.rid, m.code, g.hub, h.name, m.service_date, g.rider, g.first_at, g.total, g.waiting, g.deciding, g.blind, g.expected, g.missing
      FROM (
        SELECT i.pickup_manifest_id AS rid, i.responsible_hub_id AS hub,
               (pg_catalog.array_agg(i.handed_over_by ORDER BY i.handed_over_at, i.id))[1] AS rider,
               pg_catalog.min(i.handed_over_at) AS first_at,
               pg_catalog.count(*)::integer AS total,
               (pg_catalog.count(*) FILTER (WHERE i.state = 'AWAITING_COUNT'))::integer AS waiting,
               (pg_catalog.count(*) FILTER (WHERE i.state = 'RECONCILIATION_REQUIRED'))::integer AS deciding,
               (pg_catalog.count(*) FILTER (WHERE i.receiving_mode = 'BLIND_COUNT'))::integer AS blind,
               coalesce(pg_catalog.sum(x.door) FILTER (WHERE i.receiving_mode = 'PHOTO_CHECK_IN'), 0)::integer AS expected,
               coalesce(pg_catalog.sum(x.missing) FILTER (WHERE i.state = 'RECONCILIATION_REQUIRED'), 0)::integer AS missing,
               pg_catalog.bool_or(needle = '' OR pg_catalog.strpos(pg_catalog.lower(i.code), needle) > 0
                                  OR pg_catalog.strpos(pg_catalog.lower(coalesce(s.pickup_summary ->> 'sender_display_name', '')), needle) > 0) AS intake_matches
          FROM public.pickup_intake AS i
          LEFT JOIN public.pickup_stop AS s ON s.pickup_manifest_id = i.pickup_manifest_id AND s.pickup_request_id = i.pickup_request_id
          CROSS JOIN LATERAL (
            SELECT pg_catalog.count(*) FILTER (WHERE p.origin = 'DOOR_PHOTO') AS door, pg_catalog.count(*) FILTER (WHERE p.state = 'MISSING') AS missing
              FROM public.intake_parcel AS p WHERE p.pickup_intake_id = i.id
          ) AS x
         WHERE (p_hub IS NULL OR i.responsible_hub_id = p_hub) AND (p_run IS NULL OR i.pickup_manifest_id = p_run)
         GROUP BY i.pickup_manifest_id, i.responsible_hub_id
      ) AS g
      JOIN public.pickup_manifest AS m ON m.id = g.rid
      JOIN public.hub AS h ON h.id = g.hub
     WHERE (p_view = 'all' OR (p_view = 'waiting' AND g.waiting > 0) OR (p_view = 'needs_decision' AND g.deciding > 0))
       AND (needle = '' OR g.intake_matches OR pg_catalog.strpos(pg_catalog.lower(m.code), needle) > 0)
       AND (p_after_at IS NULL OR (g.first_at, g.rid) > (p_after_at, p_after_run))
     ORDER BY g.first_at, g.rid
     LIMIT p_limit;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.receiving_runs(uuid, text, text, timestamp with time zone, uuid, integer, uuid) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.receiving_runs(uuid, text, text, timestamp with time zone, uuid, integer, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.receiving_runs(uuid, text, text, timestamp with time zone, uuid, integer, uuid) TO melarc_api_runtime;
--> statement-breakpoint
CREATE FUNCTION melarc.missing_parcels(p_hub uuid, p_view text, p_after_at timestamp with time zone, p_after_id uuid, p_limit integer)
RETURNS TABLE (parcel_id uuid, photo_evidence_id uuid, intake_id uuid, intake_code text, run_id uuid, run_code text, hub_id uuid, vendor_name text, missing_since timestamp with time zone,
               written_off_at timestamp with time zone)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF melarc.principal_type() IS DISTINCT FROM 'STAFF'
     OR coalesce(pg_catalog.current_setting('melarc.authorization_key', true), '') NOT IN ('hub.read', 'hub.intake.count', 'hub.osd.adjudicate') THEN
    RAISE EXCEPTION 'the missing parcels are read by staff that read intakes, and by nobody else' USING ERRCODE = '42501';
  END IF;
  IF p_view IS NULL OR p_view NOT IN ('searching', 'vendor_to_tell') OR p_limit IS NULL OR p_limit < 1 THEN
    RAISE EXCEPTION 'the missing parcels take a view (searching or vendor_to_tell) and a limit of one or more' USING ERRCODE = '22023';
  END IF;
  IF (p_after_at IS NULL) <> (p_after_id IS NULL) THEN
    RAISE EXCEPTION 'a position in the list is a moment and a parcel together' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
    SELECT p.id, p.door_photo_evidence_id, i.id, i.code, i.pickup_manifest_id, m.code, i.responsible_hub_id, s.pickup_summary ->> 'sender_display_name', p.missing_marked_at,
           (SELECT pg_catalog.min(f.recorded_at) FROM public.pickup_intake_finding AS f WHERE f.pickup_intake_id = i.id AND f.kind = 'ADJUDICATION' AND f.outcome = 'WRITTEN_OFF')
      FROM public.intake_parcel AS p
      JOIN public.pickup_intake AS i ON i.id = p.pickup_intake_id
      JOIN public.pickup_manifest AS m ON m.id = i.pickup_manifest_id
      LEFT JOIN public.pickup_stop AS s ON s.pickup_manifest_id = i.pickup_manifest_id AND s.pickup_request_id = i.pickup_request_id
     WHERE p.state = 'MISSING' AND p.origin = 'DOOR_PHOTO' AND (p_hub IS NULL OR i.responsible_hub_id = p_hub)
       AND CASE p_view
             WHEN 'searching' THEN i.state = 'RECONCILIATION_REQUIRED'
             ELSE EXISTS (SELECT 1 FROM public.pickup_intake_finding AS w WHERE w.pickup_intake_id = i.id AND w.kind = 'ADJUDICATION' AND w.outcome = 'WRITTEN_OFF')
                  AND NOT EXISTS (SELECT 1 FROM public.pickup_intake_finding AS t WHERE t.pickup_intake_id = i.id AND t.kind = 'ADJUDICATION' AND t.outcome = 'VENDOR_NOTIFIED')
           END
       AND (p_after_at IS NULL OR (p.missing_marked_at, p.id) > (p_after_at, p_after_id))
     ORDER BY p.missing_marked_at, p.id
     LIMIT p_limit;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.missing_parcels(uuid, text, timestamp with time zone, uuid, integer) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.missing_parcels(uuid, text, timestamp with time zone, uuid, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.missing_parcels(uuid, text, timestamp with time zone, uuid, integer) TO melarc_api_runtime;
--> statement-breakpoint
CREATE FUNCTION melarc.receiving_run_codes(p_manifest_ids uuid[])
RETURNS TABLE (manifest_id uuid, run_code text, service_date date)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF melarc.principal_type() IS DISTINCT FROM 'STAFF'
     OR coalesce(pg_catalog.current_setting('melarc.authorization_key', true), '') NOT IN ('hub.read', 'hub.intake.count', 'hub.osd.adjudicate') THEN
    RAISE EXCEPTION 'the codes of runs are read by staff that read intakes, and by nobody else' USING ERRCODE = '42501';
  END IF;
  IF p_manifest_ids IS NULL OR pg_catalog.cardinality(p_manifest_ids) > 1000 THEN
    RAISE EXCEPTION 'the codes are asked for at most a thousand runs at a time' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY SELECT m.id, m.code, m.service_date FROM public.pickup_manifest AS m WHERE m.id = ANY (p_manifest_ids) ORDER BY m.id;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.receiving_run_codes(uuid[]) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.receiving_run_codes(uuid[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.receiving_run_codes(uuid[]) TO melarc_api_runtime;
